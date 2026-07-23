// ---------------------------------------------------------------------------
// @app/supabase — THE SERVER BARREL.
//
// This is the most consequential leaf in the platform layer, because it is how
// BOTH client surfaces reach the database — and the database is the
// authorization boundary. Every read and every write in this system passes
// through a client one of five factories built, and which factory built it
// decides whether row-level security applies at all.
//
// ─── THE FIVE FACTORIES ─────────────────────────────────────────────────────
//   1. browser          `./client` · publishable key · one per tab
//   2. native           `./client` · publishable key · injected keychain store
//   3. access-token     `./client` · publishable key · per request, bearer header
//   4. cookie-server    HERE       · publishable key · per request, host cookie jar
//   5. service-role     HERE       · SECRET key      · **BYPASSES RLS**
//
// The first four are all the SAME privilege: whatever the verified identity
// they carry is granted, and nothing more. The fifth is categorically different
// and is deliberately unpleasant to reach — see `service-role.ts`.
//
// ─── WHAT THIS BARREL ADDS OVER `./client` ──────────────────────────────────
// The cookie machinery (which needs a host's cookie jar and is dead weight in a
// native bundle), the elevated factory (which must never be one import away
// from a shipped binary), and the server-side verification helpers. Everything
// else is re-exported from `./client` unchanged, so a server caller reaching
// for `mapPostgresError` gets the same declaration a screen does.
//
// ─── WHAT THIS PACKAGE DOES NOT IMPORT, AT ANY DEPTH ────────────────────────
// `next/*`. Not here, not in `cookies.ts`, not transitively. That is the
// reversibility wall seen from underneath: the day the API moves to a
// standalone deployment, this package moves with it unchanged, and the host
// supplies a different cookie adapter. A framework import here would make that
// a rewrite. `@supabase/ssr` is likewise absent — it is apps/web's wiring, and
// a dependency on it would be a dependency on one host's idea of a cookie jar.
// SOURCE: design/W1-STACK-SPEC.md §2 (packages must not import next/*) and §4
// (the dual-barrel exports contract) · tools/exports-walls.json
// ---------------------------------------------------------------------------

// The Metro-safe surface, in full. `export *` rather than a hand-written list
// so the two barrels cannot drift: a name added to `./client` is available from
// `.` on the same commit, and nobody has to remember to mirror it.
export * from './client.js'
// ── Factory 4: the per-request client for a cookie-bearing browser caller.
export { createServerSupabaseClient, type ServerClientOptions } from './cookie-server.js'
// ── The cookie adapter: the framework-agnostic indirection that keeps this
// package usable from a non-Next host. apps/web satisfies it over next/headers
// and over NextRequest/NextResponse; a test satisfies it with a Map.
export {
  chunkCookieValue,
  cookieDeletions,
  cookieSessionStorage,
  cookieWrites,
  readChunkedCookie,
  type SupabaseCookie,
  type SupabaseCookieAdapter,
  type SupabaseCookieOptions,
  type SupabaseCookieToSet,
} from './cookies.js'

// ── Factory 5. The name is the warning. It bypasses row-level security, it
// requires a merged ADR and a written reason, and its only sanctioned home is a
// Supabase Edge Function.
export {
  createServiceRoleClient_BYPASSES_RLS,
  type ServiceRoleWarrant,
} from './service-role.js'
// ── The elevated client's type, exported HERE and not from `./client`: a name
// autocomplete can offer is a name someone will ask to construct.
export type { SupabaseServiceRoleClient } from './types.js'
// ── The auth doctrine: getClaims()/getUser(), NEVER getSession().
export {
  CLIENT_SATISFIES_VERIFICATION_PORT,
  getVerifiedUser,
  getVerifiedUserId,
  type VerifiedIdentitySource,
  type VerifiedUser,
} from './verify.js'
