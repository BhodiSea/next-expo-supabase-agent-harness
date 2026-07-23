import { appRouter, createContext } from '@app/api'
import type { Session } from '@app/api'
import type { NotesDatabase } from '@app/notes'
import { getVerifiedUser as verifyBearerToken } from '@app/supabase'
import type { SupabaseServerClient } from '@app/supabase'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import {
  createBearerScopedClient,
  createRequestScopedClient,
} from '../../../../lib/supabase/server'

// The API. apps/web is the host, but it is only the host: the router itself is @app/api,
// which imports nothing from next/* on purpose. That prohibition is the reversibility wall —
// the day this API needs its own deployment, its own scaling profile or its own region, it
// moves to a standalone apps/api and THIS FILE is the only thing that has to change. A single
// `next/headers` import inside a procedure would turn that move from a routing change into a
// rewrite, which is why the wall is enforced by dependency-cruiser rather than by memory.
//
// Everything below is the adapter: turn a web Request into a tRPC context, hand it the
// router, hand back a Response.

// Node, not Edge. Declared rather than defaulted: procedures reach Postgres through
// @supabase/supabase-js and the platform packages assume Node APIs. Flipping this to 'edge'
// compiles and then fails at runtime in ways that look like network flakiness.
export const runtime = 'nodejs'

// Never prerendered, never cached. Every response here is scoped to a verified identity;
// a cached one is the same cross-tenant leak that lib/app-data/notes.ts refuses caching for.
export const dynamic = 'force-dynamic'

// `Bearer <token>`, case-insensitively — RFC 7235 makes the scheme name case-insensitive and
// real clients do send `bearer`. Anchored and single-capture so a header carrying extra
// parameters cannot smuggle a second credential past the parse.
const BEARER_SCHEME = /^bearer\s+(\S+)$/i

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header === null) return null
  return BEARER_SCHEME.exec(header)?.[1] ?? null
}

// The deployment version the skew guard compares client majors against. @app/api parses this
// ONCE at context-build time and rejects an unparseable one loudly (an inert skew gate is worse
// than a loud one). The web host has no resolved manifest to read it from the way mobile reads
// `Constants.expoConfig.version`, and @app/env declares no version variable — so it comes from
// an optional deploy-set env var, falling back to the package version. Bracket access, not dot:
// noPropertyAccessFromIndexSignature forbids dot access on process.env's index signature, and a
// server-only route needs no build-time inlining of the read.
const SERVER_VERSION: string = process.env['APP_VERSION'] ?? '0.1.0'

/**
 * Turn a verified BEARER access token into the router's Session, or null.
 *
 * This is @app/api's `resolveSession` port, satisfied inside the host: the router package is
 * framework-neutral and takes identity resolution as an injected function precisely so this
 * wiring lives here and not in the reversibility-walled package. The token is VERIFIED against
 * the auth server (verifyBearerToken → getUser under the hood, with the token passed because a
 * bearer client persists no session for a no-arg getUser to read), never decoded locally.
 *
 * membership is null: the seed ships no workspace/membership vertical, so every caller is
 * seatless — a reachable state the context models as null, exactly as the `me` procedure does.
 * displayName has no profiles read wired yet, so it falls back to the verified email then the
 * id; Actor.displayName only needs a non-empty string and both are.
 */
async function resolveSession(accessToken: string): Promise<Session | null> {
  const user = await verifyBearerToken(createBearerScopedClient(accessToken), accessToken)
  if (user === null) return null
  return {
    actor: { displayName: user.email ?? user.userId, email: user.email, userId: user.userId },
    membership: null,
  }
}

/**
 * One endpoint, two credential shapes — and the reason proxy.ts's matcher must exclude this
 * path.
 *
 * apps/mobile authenticates with `Authorization: Bearer <access token>` out of the platform
 * keychain: no cookie jar exists on that host, and a Set-Cookie header aimed at it is either
 * ignored or, in a shared jar, actively harmful. apps/web's own client components
 * authenticate with the httpOnly session cookie. Choosing per request keeps ONE endpoint
 * serving both surfaces rather than forking the API by client — and it is why the
 * cookie-refresh proxy must not also run here: two independent refreshes of the same
 * rotating token, and the loser's is revoked.
 *
 * Either way the credential is verified downstream and RLS is what enforces access. A forged
 * bearer token does not produce an error page; it produces zero rows.
 * SOURCE: apps/web/proxy.ts (the matcher excludes /api/trpc for exactly this reason)
 * docs/security/sandbox-and-supply-chain.md
 */
const handler = async (request: Request): Promise<Response> => {
  const token = bearerToken(request)
  // Mint the request's RLS-scoped client ONCE, here, keyed on the credential shape: a bearer
  // caller gets a token-scoped client; a cookie caller gets the request-scoped cookie client
  // (built here because it must await next/headers' cookies(), and createContext's injected
  // `createClient` port is synchronous). The context carries the caller's identity, so this is
  // per request and never hoisted — a shared client would serve the first caller's session to
  // everyone the warm process handles concurrently.
  const db: SupabaseServerClient =
    token === null ? await createRequestScopedClient() : createBearerScopedClient(token)

  return fetchRequestHandler({
    // Must match this route's own path. tRPC strips it to recover the procedure name, so a
    // mismatch turns every call into a "no procedure found" 404 that reads like a router bug.
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    // The real createContext takes INJECTED PORTS, not a client: it derives the token from the
    // headers (or the explicit accessToken), verifies it through resolveSession, and mints the
    // db through createClient. `accessToken` is passed so a bearer token WINS over header
    // parsing, and `createClient` returns the already-built `db` for either token value it is
    // handed (the client for this request's credential shape is already decided above).
    // NOTE — a COOKIE caller is anonymous to the router today: its identity lives in the cookie
    // jar, not in a bearer token this port can verify, so createContext resolves no actor for it
    // (reads still run RLS-scoped by the cookie). apps/web's browser reads/writes go through RSC
    // + Server Actions, not this HTTP endpoint; the exercised HTTP caller is apps/mobile (bearer).
    createContext: () =>
      createContext({
        accessToken: token,
        // `as unknown as NotesDatabase`: the createClient port returns the DAL's structural
        // port, and checking a full SupabaseServerClient against it instantiates supabase-js's
        // vast `.from()` overload set — TS2589 ("excessively deep"). The assertion is SOUND:
        // NotesDatabase is a deliberate hand-authored subset of exactly the supabase surface
        // the DAL calls, and `db` is a real supabase client. Same escape the Server Action
        // uses (apps/web/app/actions/notes.ts). SOURCE: design/W1-STACK-SPEC.md §3
        createClient: () => db as unknown as NotesDatabase,
        headers: request.headers,
        resolveSession,
        serverVersion: SERVER_VERSION,
      }),
  })
}

// GET carries queries (cacheable-looking URLs, batching); POST carries mutations. No other
// verb is mounted — an unhandled method returns 405 from Next rather than reaching the
// router.
export { handler as GET, handler as POST }
