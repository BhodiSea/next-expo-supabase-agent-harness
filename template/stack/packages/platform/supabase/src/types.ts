import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// One runtime type, five names.
//
// Every factory in this package returns the same `SupabaseClient` object. The
// aliases below are NOT nominal types and cannot be — TypeScript has no
// nominal typing, and branding them would force a cast at every seam that
// hands a client to the DAL (which is typed against a structural port on
// purpose; see @app/notes src/data/port.ts). What they buy instead is that a
// call site READS its privilege level: a function signature saying
// `SupabaseServiceRoleClient` is self-describing in review in a way that a
// bare `SupabaseClient` is not.
//
// The enforcement is therefore NOT the type. It is:
//   1. which barrel a factory is exported from (`./client` vs `.`),
//   2. tools/exports-walls.json, which forbids apps/mobile the `.` barrel,
//   3. the database — RLS is the authorization boundary, and it holds for the
//      browser, native and cookie clients whatever the type annotation says.
// Naming the privilege is documentation with a compiler-checked spelling; it
// is not a wall, and this comment exists so nobody mistakes it for one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NO GENERATED `Database` GENERIC — deliberately, and the reasoning is the
// DAL law's, not laziness.
//
// `supabase gen types` output would make `client.from('notes').select('*')`
// hand back rows that LOOK trustworthy at the DAL's entrance. They are not:
// the row shape is decided by whatever migration is actually deployed, not by
// a checked-in .d.ts, and the two drift the moment a migration ships ahead of
// a regen. @app/notes therefore re-parses every row against its zod contract
// at the DAL's EXIT and types the port's `data` as `unknown` precisely so the
// compiler cannot be used to short-circuit that parse.
//
// Threading a generated generic through here would put the illusion back one
// layer up. The generated types still earn their keep — the W3 `types-drift`
// gate diffs them against the deployed schema, which is a CI assertion rather
// than a compile-time licence to skip validation.
// SOURCE: packages/verticals/notes/src/data/port.ts (rows are `unknown` at the
// entrance and re-parsed at the exit) · design/W1-STACK-SPEC.md §9 (types-drift
// lands in W3)
// ---------------------------------------------------------------------------

/**
 * The Supabase client, unqualified. `apps/mobile` imports this name because on
 * that host there is only one privilege level and naming it twice would be
 * noise.
 */
export type Client = SupabaseClient

/**
 * Browser-tab client, publishable key, session persisted by the host.
 * ONE per tab — see `createBrowserSupabaseClient` for why a second one revokes
 * the first one's refresh token.
 */
export type SupabaseBrowserClient = Client

/**
 * React Native client, publishable key, session in an injected
 * `SessionStorageAdapter` (the platform keychain on a real device).
 */
export type SupabaseNativeClient = Client

/**
 * Per-request server client, publishable key, identity supplied by a verified
 * cookie or bearer token. RLS is doing the enforcing; this client has no more
 * authority than the caller it carries.
 */
export type SupabaseServerClient = Client

/**
 * The elevated client. BYPASSES ROW-LEVEL SECURITY — no policy in this
 * repository constrains it, and `supabase/tests/**` cannot cover it because
 * there is nothing to cover. Reachable only through
 * `createServiceRoleClient_BYPASSES_RLS`, only from the `.` barrel, and only
 * from an ADR-governed Edge Function.
 * SOURCE: supabase/functions/README.md (Edge Functions are the one sanctioned
 * home for service-role code)
 */
export type SupabaseServiceRoleClient = Client
