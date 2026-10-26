import { type Client, createNativeClient } from '@app/supabase/client'
import Constants from 'expo-constants'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { LargeSecureStore } from '../../host/large-secure-store'

// THE Supabase client for this app, and the one place it is constructed.
//
// COMPONENT SCOPE, NEVER MODULE SCOPE. On the server half of this stack a
// module-scope client is a session-leak bug (a warm serverless instance carries
// one request's session into the next); on the client it is a different failure
// with the same shape — a module-scope client is built while the JS bundle
// evaluates, before the storage adapter's native modules are guaranteed ready,
// and fast refresh then leaves TWO clients racing the same refresh timer against
// one keychain entry. `useState(factory)` builds it exactly once per mount of
// this provider and never again.
// SOURCE: @supabase/supabase-js client construction + the Expo session recipe
// https://supabase.com/docs/guides/auth/quickstarts/react-native
//
// `@app/supabase/client`, NEVER `@app/supabase`. The `.` barrel carries the
// service-role factory (which bypasses row-level security) and the cookie-bound
// server factories (which import a host cookie jar and do not resolve under
// Metro at all). Metro does not tree-shake, so importing the `.` barrel here
// would put a service-role factory into a binary users can unzip — the census
// calls this the single most load-bearing entry it holds.
// SOURCE: tools/exports-walls.json (@app/supabase's census entry) ·
// design/W1-STACK-SPEC.md §2 (apps/mobile may not import a package's `.` barrel)

// Metro inlines EXPO_PUBLIC_ vars by rewriting the literal member expression at
// bundle time — a bracket read would stay a runtime lookup of an object the
// shipped bundle does not carry, so DOT access is load-bearing. The local
// declaration types exactly these two properties (RN's globals leave process.env
// untyped for our purposes).
//
// The NAME matters as much as the value: `EXPO_PUBLIC_SUPABASE_PUBLISHABLE`
// carries no KEY/SECRET/TOKEN substring on purpose — the expo-policy gate reds
// any secret-shaped EXPO_PUBLIC_ name anywhere in mobile source, because those
// names are inlined into the shipped bundle and a secret-shaped one there IS a
// shipped secret. The publishable key is not a secret (RLS is the access
// boundary, and the key only authenticates the request to the gateway), so it
// belongs in this channel — but the gate cannot tell one key from another by
// value, only by name, and a name-shape rule with an exception is not a rule.
declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_SUPABASE_URL?: string
    readonly EXPO_PUBLIC_SUPABASE_PUBLISHABLE?: string
  }
}

/** The committed project URL from app.config.ts `extra.supabaseUrl`, or ''. */
function configuredUrl(): string {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined
  const url = extra?.['supabaseUrl']
  return typeof url === 'string' ? url : ''
}

/**
 * Resolve the project credentials. `||`, NOT `??`, on the env reads: a
 * SET-BUT-EMPTY var must fall back too. `??` only catches null/undefined, so a
 * bare `EXPO_PUBLIC_SUPABASE_URL=` line (env.example ships exactly that shape)
 * would yield '' and every request would go to a relative path and read as a
 * server fault. Empty means unset.
 *
 * The URL has a committed default (the project ref is baked into app.config.ts,
 * and it is public by design); the publishable key does NOT — it is per-project
 * and per-environment, so an absent one is a CONFIGURATION error that must be
 * loud at boot rather than a client that 401s every call.
 */
function credentials(): { readonly url: string; readonly publishableKey: string } {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- here `??` IS the bug: it passes '' through as the project URL. The rule is right in general and wrong here.
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL || configuredUrl()
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE ?? ''
  if (url === '' || publishableKey === '') {
    throw new Error(
      'Supabase is not configured — set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE (see env.example)',
    )
  }
  return { url, publishableKey }
}

const SupabaseContext = createContext<Client | null>(null)

/**
 * Owns the client and the foreground auto-refresh loop.
 *
 * The refresh timer is bound to AppState because a background timer is a timer
 * the OS suspends and then fires late in a batch: iOS freezes JS timers on
 * background, so a session that expired while backgrounded refreshes on RESUME,
 * not on schedule. Starting the loop only while `active` makes that explicit —
 * and stopping it on background is what keeps a suspended app from waking to a
 * queue of stale refresh attempts against a rotated token.
 * SOURCE: the Supabase Expo recipe's AppState auto-refresh binding
 * https://supabase.com/docs/guides/auth/quickstarts/react-native
 */
export function SupabaseProvider({ children }: { readonly children: ReactNode }) {
  const [client] = useState(() => createNativeClient(credentials(), new LargeSecureStore()))

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void client.auth.startAutoRefresh()
      else void client.auth.stopAutoRefresh()
    })
    // The provider mounts while the app is already foregrounded, and AppState
    // emits on CHANGE only — without this the first session would never refresh.
    void client.auth.startAutoRefresh()
    return () => {
      subscription.remove()
      void client.auth.stopAutoRefresh()
    }
  }, [client])

  return <SupabaseContext.Provider value={client}>{children}</SupabaseContext.Provider>
}

/** The app's Supabase client. Throws when the provider wiring was skipped (a real bug). */
export function useSupabase(): Client {
  const client = useContext(SupabaseContext)
  if (client === null) {
    throw new Error(
      'useSupabase requires <SupabaseProvider> — app/_layout.tsx mounts one at the root',
    )
  }
  return client
}
