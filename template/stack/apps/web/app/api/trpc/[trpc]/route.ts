import type { Session } from '@app/api'
import {
  appRouter,
  CSRF_REJECTED_CODE,
  createContext,
  hasAmbientSessionCookie,
  isCrossSiteRequest,
} from '@app/api'
import type { NotesDatabase } from '@app/notes'
import type { SupabaseServerClient, VerifiedUser } from '@app/supabase'
import { getVerifiedUser } from '@app/supabase'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
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

/**
 * A verified user → the router's Session, or null. ONE builder, shared by both credential
 * shapes, so a cookie caller and a bearer caller resolve to the SAME actor shape — the "two
 * callers, one operation" rule reaching all the way down to identity.
 *
 * The seed ships no workspace/membership vertical, so there is no membership TABLE to resolve a
 * seat from. Every verified user is instead the `owner` of their own PERSONAL workspace, keyed
 * by their user id — the single-tenant default that lets the seeded notes vertical (whose writes
 * ride `memberProcedure`) work end to end without inventing a workspaces table the scaffold does
 * not have. This is a real resolution, NOT a bypass: the member gate still runs, an anonymous
 * caller still gets no session at all (null in → null out), and a consumer that adds a real
 * membership vertical replaces this one expression with a lookup that CAN return null — the
 * seatless state the `Membership | null` type, `memberGate` and context.test.ts all still model.
 * workspaceId is the user id because a personal workspace has exactly one member and no separate
 * identity of its own. displayName falls back to the verified email then the id; Actor.displayName
 * only needs a non-empty string and both are.
 */
function sessionForVerifiedUser(user: VerifiedUser | null): Session | null {
  if (user === null) return null
  return {
    actor: { displayName: user.email ?? user.userId, email: user.email, userId: user.userId },
    membership: { role: 'owner', workspaceId: user.userId },
  }
}

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
    session = ambient ? sessionForVerifiedUser(await getVerifiedUser(db)) : null
  } else {
    // BEARER (apps/mobile) path. ONE client, minted from the token so RLS sees the caller, and
    // the same client verifies the token (passed explicitly — a bearer client persists no
    // session for a no-arg getUser to read).
    db = createBearerScopedClient(token)
    session = sessionForVerifiedUser(await getVerifiedUser(db, token))
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
