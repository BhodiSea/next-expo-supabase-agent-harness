import { parseWebPublicEnv } from '@app/env/client'
import { requireCredentials, type SupabaseCredentials } from './credentials.js'

// ---------------------------------------------------------------------------
// The PUBLIC half of the environment, in one place.
//
// This module is the single seam between @app/supabase and @app/env. Everything
// else in the package takes credentials as a parameter, so if @app/env renames
// a field the diff is this file and nothing else — rather than five factories
// each reaching into the environment on their own.
//
// It imports `@app/env/client`, NOT `@app/env`. The `.` barrel parses the full
// server environment — service key, database URL, provider secrets — and its
// schema NAMES every one of them. This module is reachable from `./client`, and
// `./client` is bundled by Metro into the native binary. Importing the server
// barrel here would put that schema in the bundle and, if it parses eagerly,
// turn a missing server variable into a crash on a device that was never
// supposed to hold it.
// SOURCE: tools/exports-walls.json (@app/env's census entry: `./client` exports
// the public subset and nothing else) · design/W1-STACK-SPEC.md §4
//
// The values are public BY CONSTRUCTION — they are inlined into the web bundle
// and the native binary at build time. Row-level security is the boundary; the
// keys are not hiding anything. What they must not be is the SECRET key, which
// `requireCredentials` refuses.
// ---------------------------------------------------------------------------

/**
 * The project credentials the WEB surfaces default to.
 *
 * Called lazily, inside a factory, never at module scope. Module-scope
 * evaluation would run during import — before a test has arranged its
 * environment, and on a native host where these variables do not exist at all —
 * and a throw during module evaluation cannot be caught by the code that caused
 * it. The native factory never calls this: `apps/mobile` passes credentials
 * explicitly, because Metro inlines `EXPO_PUBLIC_*` by rewriting the literal
 * member expression at bundle time and there is no runtime environment left to
 * read on that host.
 */
export function publicCredentials(): SupabaseCredentials {
  // parseWebPublicEnv() — the WEB parser specifically, not a merged "client"
  // one. @app/env keeps NEXT_PUBLIC_* and EXPO_PUBLIC_* in separate schemas
  // because each bundler inlines only its own prefix: a merged schema would
  // demand four variables in a bundle that can only ever carry two, and fail
  // closed on the surface that is behaving correctly.
  const env = parseWebPublicEnv()
  return requireCredentials(
    {
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE,
      url: env.NEXT_PUBLIC_SUPABASE_URL,
    },
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
  )
}
