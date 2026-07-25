import { createClient } from '@supabase/supabase-js'
import { requireCredentials, type SupabaseCredentials } from './credentials.js'
import type { SessionStorageAdapter } from './session-storage.js'
import type { SupabaseNativeClient } from './types.js'

/**
 * ── FACTORY 2 of 5 · NATIVE (React Native / Expo) ───────────────────────────
 *
 * WHEN TO USE IT: once, at the root of the mobile app, inside a component so
 * the client's lifetime is the provider's. `apps/mobile/src/lib/supabase/
 * provider.tsx` is the seeded caller and the only one.
 *
 * WHY CREDENTIALS ARE A PARAMETER HERE AND ENV ON THE WEB: Metro inlines
 * `EXPO_PUBLIC_*` by rewriting the literal member expression at bundle time.
 * There is no runtime environment left in a shipped binary to read, so a
 * factory that called `process.env` here would read `undefined` on a device and
 * work perfectly in every Node test. Passing the values in keeps the read at
 * the one place the bundler can see it.
 *
 * FAILURE MODES OF MISUSE:
 *
 *   1. CONSTRUCTED AT MODULE SCOPE. The client is then built while the JS
 *      bundle evaluates — before the storage adapter's native modules are
 *      guaranteed ready — and fast refresh leaves TWO clients racing the same
 *      refresh timer against one keychain entry. `useState(factory)` in the
 *      provider builds it once per mount and never again.
 *   2. STORAGE OMITTED (or a plain AsyncStorage passed). The refresh token then
 *      sits in unencrypted app storage, readable by anything in the JS sandbox
 *      and by anyone with the device's file system. The parameter is required,
 *      not optional, so that decision cannot be made by forgetting.
 *   3. `detectSessionInUrl` LEFT ON. There is no URL bar on this host. The
 *      client would parse a location that does not exist; deep-link auth
 *      returns are handled explicitly by the app instead.
 *
 * The auto-refresh TIMER is started by this client but must be gated by the app
 * on `AppState`: iOS freezes JS timers in the background, so a session that
 * expires while backgrounded refreshes on RESUME, not on schedule, and a
 * suspended app otherwise wakes to a queue of stale refresh attempts against an
 * already-rotated token.
 * SOURCE: the Supabase Expo recipe — AsyncStorage-shaped storage,
 * detectSessionInUrl false, and the AppState start/stopAutoRefresh binding
 * https://supabase.com/docs/guides/auth/quickstarts/react-native
 */
export function createNativeClient(
  credentials: SupabaseCredentials,
  storage: SessionStorageAdapter,
): SupabaseNativeClient {
  const { publishableKey, url } = requireCredentials(credentials, 'the mobile host')

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- @supabase/supabase-js's createClient is untyped by deliberate doctrine (types.ts: no Database generic; rows are re-parsed at the DAL exit). This return is the intentional untyped-client boundary.
  return createClient(url, publishableKey, {
    auth: {
      // True, and then gated by the provider's AppState listener. False would
      // mean `startAutoRefresh()` is the only thing keeping the session alive,
      // so a provider that forgot the initial call would sign users out an hour
      // after launch with nothing in any log.
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // PKCE is not optional on a native host: there is no confidential client
      // here — the binary is on the user's device and every secret in it is
      // extractable — so the code verifier is what binds the returned code to
      // this app instance.
      // SOURCE: https://www.rfc-editor.org/rfc/rfc8252 (OAuth 2.0 for native
      // apps: public clients must use PKCE)
      flowType: 'pkce',
      persistSession: true,
      // The keychain-backed split store. See SessionStorageAdapter for why the
      // ciphertext and the key live in two different places.
      storage,
    },
  })
}
