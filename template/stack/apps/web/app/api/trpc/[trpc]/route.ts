import type { Session } from '@app/api'
import {
  appRouter,
  CSRF_REJECTED_CODE,
  createContext,
  hasAmbientSessionCookie,
  isCrossSiteRequest,
} from '@app/api'
import type { NotesDatabase } from '@app/notes'
import type { SupabaseServerClient } from '@app/supabase'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { resolveHostSession } from '../../../../lib/auth/session'
import { bucketForProcedure } from '../../../../lib/rate-limit'
import { clientKeyFromHeaders, spendRateLimit } from '../../../../lib/rate-limit-runtime'
import {
  createBearerScopedClient,
  createRequestScopedClient,
} from '../../../../lib/supabase/server'
import pkg from '../../../../package.json'

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

// The deployment version the skew guard compares client majors against. In order:
//   1. a deploy-set `APP_VERSION` — the override, so a canary or hotfix build can pin it;
//   2. else apps/web's OWN package.json version — this surface's single source of truth,
//      exactly as apps/mobile derives its version from ITS package.json (app.config.ts).
// There is NO hardcoded literal: a magic '0.1.0' here would silently diverge from the package
// the moment it bumped, leaving the skew gate either inert (never rejecting) or over-eager
// (rejecting current clients) — the precise failure the version-skew doctrine exists to
// prevent (@app/api parses this ONCE and rejects an unparseable value loudly). Bracket access,
// not dot: noPropertyAccessFromIndexSignature forbids dot access on process.env's index
// signature, and this server-only read needs no build-time inlining.
const SERVER_VERSION: string = process.env['APP_VERSION'] ?? pkg.version

// The minimum-supported-client floor, or null when unset. OPTIONAL policy the deploy sets
// only to force out a specific old build within the current major (a shipped client bug, a
// security fix) — the major-skew check needs no floor at all. Off by default: an unset or
// unparseable value leaves the floor inert (see @app/api's isBelowMinimum), never rejecting.
// Bracket access for the same index-signature reason as APP_VERSION above.
const MIN_SUPPORTED_CLIENT: string | null = process.env['MIN_SUPPORTED_CLIENT'] ?? null

// WHERE THE SESSION IS BUILT, and why it is not here any more. This file used to hold a
// `sessionForVerifiedUser` that minted `{ role: 'owner', workspaceId: user.userId }` — a
// hardcode standing in for a membership table the seed did not have. There is one now, so
// the seats are READ, and the read lives in lib/auth/session.ts because this host has two
// callers of it: this route and every Server Action. Two copies of "which orgs is this
// person in" is two answers, and the one that disagrees is the one that writes.
//
// resolveHostSession reads public.memberships THROUGH the caller's own policies, so what it
// returns is by construction a subset of what the database would let them touch. The acting
// org is then chosen from that set by @app/api's createContext, from the `x-org-id` header.

/**
 * One endpoint, two credential shapes.
 *
 * apps/mobile authenticates with `Authorization: Bearer <access token>` from the platform
 * keychain: no cookie jar exists on that host, and a Set-Cookie aimed at it is ignored or, in
 * a shared jar, actively harmful. apps/web's browser authenticates with the httpOnly Supabase
 * session cookie. Choosing per request keeps ONE endpoint serving both surfaces rather than
 * forking the API by client — and it is why proxy.ts's matcher EXCLUDES this path: the cookie
 * refresh must happen in exactly one place per request, and for /api/trpc that place is the
 * cookie client built here. Two independent refreshes of the same rotating token, and the
 * loser's is revoked ("randomly signed out mid-session").
 *
 * The host resolves BOTH shapes to a verified `Session` and INJECTS it — so identity is
 * decided in one place and @app/api's `resolveSession` port is not even wired here (the router
 * cannot read a cookie jar, and the bearer client already in hand verifies the token without a
 * second client). Either credential is VERIFIED before it becomes an identity: a cookie via
 * getUser() against the auth server (never getSession()), a bearer token the same way, with the
 * token passed because a bearer client persists no session for a no-arg getUser to read. RLS is
 * the enforcement beneath that — a forged credential produces zero rows, not an error page.
 *
 * The cookie path is additionally CSRF-guarded, because a cookie is an AMBIENT credential the
 * browser attaches to cross-site requests and a bearer token is not. The guard runs on the raw
 * request BEFORE the cookie client is built, so a cross-site request can never reach the
 * getUser() refresh it would otherwise use to rotate — then withhold — a victim's token.
 * SOURCE: apps/web/proxy.ts (the matcher excludes /api/trpc for exactly this reason) ·
 * packages/api/src/csrf.ts · docs/security/sandbox-and-supply-chain.md
 */
const handler = async (request: Request): Promise<Response> => {
  const token = bearerToken(request)

  // Resolve the credential shape into a client and a verified session, THEN hand off — one
  // fetchRequestHandler serves both surfaces.
  let db: SupabaseServerClient
  let session: Session | null

  if (token === null) {
    // COOKIE (browser) path — the ambient-credential surface.
    const ambient = hasAmbientSessionCookie(request.headers)
    if (ambient && isCrossSiteRequest(request.headers, new URL(request.url).origin)) {
      // Refused by the host, before the router: a plain 403 with a stable body code, never a
      // tRPC error (this never reaches the error formatter — see packages/api/src/csrf.ts).
      return new Response(JSON.stringify({ error: CSRF_REJECTED_CODE }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
    // The request-scoped cookie client. On this writable host getUser() BOTH verifies the jar
    // and performs the session refresh proxy.ts deliberately leaves to this route.
    db = await createRequestScopedClient()
    // Resolve identity ONLY when a session cookie is actually present. An anonymous request (a
    // curl health check, a signed-out browser) makes no auth round trip — mirroring
    // createContext's own skip for a tokenless caller, and keeping the public health procedure
    // as cheap as the skew doctrine requires.
    session = ambient ? await resolveHostSession(db) : null
  } else {
    // BEARER (apps/mobile) path. ONE client, minted from the token so RLS sees the caller, and
    // the same client verifies the token (passed explicitly — a bearer client persists no
    // session for a no-arg getUser to read).
    db = createBearerScopedClient(token)
    session = await resolveHostSession(db, token)
  }

  // Narrowed to the DAL's structural port. `as unknown as`: checking a full SupabaseServerClient
  // against NotesDatabase instantiates supabase-js's vast `.from()` overload set (TS2589,
  // "excessively deep"). The assertion is SOUND — NotesDatabase is a hand-authored subset of
  // exactly the supabase surface the DAL calls, and `db` is a real supabase client. The cast
  // rides a `const` (never the createClient return position) for the same reason the sibling
  // does: an assertion in a contextually-typed slot reads as redundant to no-unnecessary-type-
  // assertion, which does not see the deep check that makes it load-bearing.
  // SOURCE: apps/web/app/actions/notes.ts (the same NotesDatabase-subset cast, full rationale)
  const notesDb = db as unknown as NotesDatabase

  // The rate-limit port, closed over what only the HOST knows: which budget a procedure
  // spends from (lib/rate-limit.ts, the reviewed policy) and how to identify an anonymous
  // caller (the proxy's forwarded-for). The router asks; it does not decide.
  //
  // `clientKey` is read ONCE per request rather than per procedure: a batched tRPC call
  // is several procedures inside one HTTP request, and re-parsing the same header for
  // each of them would be the same answer computed N times.
  const clientKey = clientKeyFromHeaders(request.headers)

  return fetchRequestHandler({
    // Must match this route's own path. tRPC strips it to recover the procedure name, so a
    // mismatch turns every call into a "no procedure found" 404 that reads like a router bug.
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: () =>
      createContext({
        createClient: () => notesDb,
        headers: request.headers,
        minSupportedClient: MIN_SUPPORTED_CLIENT,
        // SOURCE: docs/adr/20260204-rate-limiting.md (both seams, and what neither bounds)
        rateLimit: async ({ orgId, path, userId }) => {
          const decision = await spendRateLimit(bucketForProcedure(path), {
            clientKey,
            orgId,
            userId,
          })
          // `null` — a deliberately unlimited procedure — is passed through as null
          // rather than flattened to `{ allowed: true }`: the router treats the two
          // differently on purpose, and collapsing them here would make an exemption
          // indistinguishable from a healthy hit in everything downstream.
          return decision === null
            ? null
            : { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds }
        },
        // Identity is injected, already verified — no resolveSession port, because the router
        // cannot read a cookie jar and the bearer path already verified with the client above.
        session,
        serverVersion: SERVER_VERSION,
      }),
  })
}

// GET carries queries (cacheable-looking URLs, batching); POST carries mutations. No other
// verb is mounted — an unhandled method returns 405 from Next rather than reaching the
// router.
export { handler as GET, handler as POST }
