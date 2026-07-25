import { createClient } from '@supabase/supabase-js'
import { requireCredentials, type SupabaseCredentials } from './credentials.js'
import { publicCredentials } from './public-env.js'
import type { SessionStorageAdapter } from './session-storage.js'
import type { SupabaseBrowserClient } from './types.js'

/** Options for the browser factory. Every field has a working default. */
export interface BrowserClientOptions {
  /** Override the `NEXT_PUBLIC_*` credentials — for tests and for a host that
   * resolves its own configuration at runtime. */
  readonly credentials?: SupabaseCredentials
  /**
   * Where the session is persisted. Omit for the library's own default
   * (`localStorage`), which is correct when the browser is the only reader.
   *
   * SUPPLY A COOKIE-BACKED STORE WHEN THE SERVER MUST SEE THE SAME SESSION.
   * `localStorage` is not sent with a request, so a session written there is
   * invisible to Server Components, Server Actions and the tRPC route — they
   * would render signed-out for a user the browser considers signed in. apps/web
   * is exactly that case and supplies a cookie store; a pure SPA that never
   * server-renders an identity does not need one.
   */
  readonly storage?: SessionStorageAdapter
}

/**
 * ── FACTORY 1 of 5 · BROWSER ────────────────────────────────────────────────
 *
 * WHEN TO USE IT: from a `'use client'` module in the web app, and only there.
 * It carries the publishable key and the caller's own session; RLS is what
 * decides what it can read.
 *
 * FAILURE MODE OF MISUSE, and there are two distinct ones:
 *
 *   1. CALLED FROM A SERVER COMPONENT. The client's persistence layer reaches
 *      for browser storage in a context that has none. What you get is not a
 *      clean error — it is a render that succeeds with no session, then a
 *      hydration mismatch when the browser disagrees. The import mistake is
 *      three layers away from the symptom.
 *
 *   2. CALLED MORE THAN ONCE PER TAB. This is the expensive one. Each client
 *      owns a refresh timer and an `onAuthStateChange` subscription. Two
 *      clients means two timers racing to rotate the SAME refresh token, and
 *      Supabase's rotation invalidates whichever loses — the "signed out for no
 *      reason" report that never reproduces locally, because locally you only
 *      ever open one tab and never leave it long enough to refresh.
 *      This factory does NOT memoise: a module-level singleton here would be
 *      shared by every request in a server process during SSR, which is the
 *      opposite and worse bug. The caller owns the lifetime — apps/web keeps a
 *      lazy per-tab singleton in `lib/supabase/client.ts`.
 *
 * The service-role key is not merely inappropriate here, it is unusable:
 * anything bundled for a browser is published, and `requireCredentials` refuses
 * a secret key rather than letting one be shipped.
 */
export function createBrowserSupabaseClient(
  options: BrowserClientOptions = {},
): SupabaseBrowserClient {
  const { publishableKey, url } = options.credentials
    ? requireCredentials(options.credentials, 'the caller')
    : publicCredentials()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- @supabase/supabase-js's createClient is untyped by deliberate doctrine (types.ts: no Database generic; rows are re-parsed at the DAL exit). This return is the intentional untyped-client boundary.
  return createClient(url, publishableKey, {
    auth: {
      // The browser is the one host where an unattended refresh timer is right:
      // the tab is alive, the user is present, and a session that lapses mid-use
      // is a form that loses its contents on submit.
      autoRefreshToken: true,
      // Magic-link and OAuth returns land back on the app with the credential in
      // the URL. False here means the client ignores it and the user bounces
      // back to sign-in holding a token nobody read.
      detectSessionInUrl: true,
      // PKCE, not implicit. The implicit flow puts the token in the URL
      // FRAGMENT, where it lands in browser history, in `Referer` on the next
      // navigation, and in any analytics script that reports `location.href`.
      // PKCE returns a single-use code bound to a verifier this client holds.
      // SOURCE: https://www.rfc-editor.org/rfc/rfc9700 (OAuth 2.0 security best
      // current practice: the implicit grant SHOULD NOT be used)
      flowType: 'pkce',
      persistSession: true,
      ...(options.storage === undefined ? {} : { storage: options.storage }),
    },
  })
}
