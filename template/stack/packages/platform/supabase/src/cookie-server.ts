import { createClient } from '@supabase/supabase-js'
import {
  cookieSessionStorage,
  type SupabaseCookieAdapter,
  type SupabaseCookieOptions,
} from './cookies.js'
import { requireCredentials, type SupabaseCredentials } from './credentials.js'
import { serverPublicCredentials } from './server-env.js'
import type { SupabaseServerClient } from './types.js'

/** Options for the cookie-server factory. */
export interface ServerClientOptions {
  /** Attributes for cookies this client writes. The host supplies `secure` and
   * `httpOnly`, because only the host knows its scheme and its readers. */
  readonly cookieOptions?: SupabaseCookieOptions
  /** Override the environment-resolved credentials — tests, and hosts that
   * resolve configuration at runtime. */
  readonly credentials?: SupabaseCredentials
}

/**
 * ── FACTORY 4 of 5 · COOKIE-SERVER ──────────────────────────────────────────
 *
 * WHEN TO USE IT: on a server, for a browser caller whose credential is in the
 * cookie jar — Server Components, Server Actions, Route Handlers, and the
 * session-refresh proxy. It carries the PUBLISHABLE key; the caller's identity
 * comes from the cookie, is verified downstream, and RLS is what enforces
 * access.
 *
 * The `cookies` parameter is the whole of the host's obligation. This package
 * imports nothing from any web framework (see `cookies.ts` for why that
 * indirection exists and what it buys), so it cannot know where the jar lives.
 * apps/web supplies one over `next/headers` and another over
 * `NextRequest`/`NextResponse`.
 *
 * FAILURE MODES OF MISUSE:
 *
 *   1. HOISTED TO MODULE SCOPE. The single worst mistake available in this
 *      package. A client built once and shared is bound to ONE request's cookie
 *      jar, so every concurrent request the process serves reads and writes that
 *      user's auth state — the server-rendering equivalent of a pooled
 *      connection leaking a transaction-local identity. It does not fail; it
 *      serves the wrong person's data, under load, in production.
 *   2. THE ADAPTER'S `setAll` SILENTLY DROPPED. Next throws when a Server
 *      Component tries to write a cookie (headers are already committed), and
 *      swallowing that is CORRECT there and a bug in a Server Action. apps/web's
 *      adapter swallows it only on the read path and documents why.
 *   3. TREATING `getSession()` AS AUTHENTICATION. See `verify.ts`. This client
 *      hands back whatever is in the jar; the jar is attacker-controlled input.
 *
 * `autoRefreshToken` is OFF here on purpose: there is no long-lived tab to run
 * a timer in, and the refresh that matters happens inside `getClaims()` /
 * `getUser()` as a side effect of verification. A background timer on a server
 * would rotate a token for a request that has already returned.
 */
export function createServerSupabaseClient(
  cookies: SupabaseCookieAdapter,
  options: ServerClientOptions = {},
): SupabaseServerClient {
  const { publishableKey, url } = options.credentials
    ? requireCredentials(options.credentials, 'the caller')
    : serverPublicCredentials()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- @supabase/supabase-js's createClient is untyped by deliberate doctrine (types.ts: no Database generic; rows are re-parsed at the DAL exit). This return is the intentional untyped-client boundary.
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      // No URL to read a session out of on this host, and a server that tried
      // would be parsing a request path as an auth callback.
      detectSessionInUrl: false,
      flowType: 'pkce',
      // True — and "persist" here means "into the caller's own cookie jar",
      // which is request-scoped by construction. This is what lets a rotated
      // token reach the browser on the way out.
      persistSession: true,
      storage: cookieSessionStorage(cookies, options.cookieOptions),
    },
  })
}
