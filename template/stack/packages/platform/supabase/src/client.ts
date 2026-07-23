// ---------------------------------------------------------------------------
// @app/supabase/client — THE METRO-SAFE BARREL.
//
// Everything reachable from this file is bundled into the native binary. That
// is the single fact to hold while editing it, because Metro DOES NOT
// TREE-SHAKE: an import added here rides into the app whether or not any screen
// calls it, and a shipped binary is something users can unzip.
//
// What lives here: the four things a client surface legitimately needs — the
// factories that carry a PUBLIC key (browser, native, bearer), the interface
// the host implements to store a session, the SQLSTATE→AppError map, and the
// types. All of it is `@supabase/supabase-js` plus @app/errors plus the public
// half of @app/env, and nothing else.
//
// What must never be added here, and why each one specifically:
//   · The SERVICE-ROLE factory. It bypasses row-level security. In this bundle
//     it would be a key users can extract from an app already on their phones,
//     and every policy in the repository would stop constraining whoever
//     extracted it. This is the entry tools/exports-walls.json calls "the single
//     most load-bearing in the census".
//   · The COOKIE-SERVER factory. There is no cookie jar on this host, and the
//     chunking machinery behind it is dead weight in a bundle measured in
//     kilobytes of parse time on a cold start.
//   · ANYTHING from `next/*`, `node:*` or a native SDK. The first two do not
//     resolve under Metro; the third does not resolve under Node, which is where
//     the other half of this package runs.
//
// The `.` barrel re-exports this file in full, so a server caller reaching for
// `mapPostgresError` or `SessionStorageAdapter` gets them from `@app/supabase`
// without either barrel duplicating a declaration.
// SOURCE: design/W1-STACK-SPEC.md §4 (the dual-barrel exports contract) ·
// tools/exports-walls.json (@app/supabase's census entry)
// ---------------------------------------------------------------------------

export { createBearerSupabaseClient } from './access-token.js'
export { type BrowserClientOptions, createBrowserSupabaseClient } from './browser.js'
export { isSecretKey, requireCredentials, type SupabaseCredentials } from './credentials.js'
export {
  isRlsDenied,
  mapPostgresError,
  type PostgresErrorContext,
  type PostgresFailure,
  readMiss,
} from './errors.js'
export { createNativeClient } from './native.js'
export type { SessionStorageAdapter } from './session-storage.js'
// `SupabaseServiceRoleClient` is deliberately NOT re-exported here even though
// a type is erased at build time and would cost the bundle nothing. A name
// available on this barrel is a name autocomplete offers to a screen author,
// and the next question after "why can I name it?" is "why can I not build
// one?". It lives on the `.` barrel, next to the only factory that returns it.
export type {
  Client,
  SupabaseBrowserClient,
  SupabaseNativeClient,
  SupabaseServerClient,
} from './types.js'
