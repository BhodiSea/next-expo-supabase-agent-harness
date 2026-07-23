// The root shell. ORDER MATTERS at the top of this file:
// polyfills come FIRST — nothing may construct an Intl formatter (directly or
// through t()) before the Hermes gaps are filled, and an import graph is
// evaluated in import order, so this line being line one is load-bearing.
import '../src/i18n/polyfills'

import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { ToastProvider } from '../src/components/Toast'
import { initI18n } from '../src/i18n/platform'
import { SupabaseProvider } from '../src/lib/supabase/provider'
import { initTheme, useTheme } from '../src/theme/theme'

// Hold the native splash until the tree is mounted: the boot work below is
// synchronous (kv-store is sync by design), so by first render the theme and
// locale are already right — the splash bridges only the JS-load gap. The
// splash background is the dark canvas token (app.config.ts lockstep), so the
// frame it hands off to is the same pixel it painted. Fail-silent: under jest
// or fast refresh the native module may be absent.
SplashScreen.preventAutoHideAsync().catch(() => undefined)

// Module-scope boot, deliberately BEFORE the first render (the no-flash
// discipline): resolve the persisted theme and install the i18n platform
// adapter (allowRTL + locale negotiation). Both are synchronous and both decide
// what the FIRST frame looks like, so a hook would be too late.
//
// THE SESSION IS NOT BOOTED HERE, and that is the change Supabase Auth brought.
// The inherited shell picked an auth provider at module scope by reading
// configuration, then installed a token resolver into the fetch layer — a
// module-scope credential store, which is exactly the shape that leaves two
// clients racing one keychain entry under fast refresh. The Supabase client
// owns the session now, it is built inside <SupabaseProvider> (component scope,
// once per mount), and the transport pulls a fresh bearer token per request
// from it. There is nothing left for a boot line to install.
// SOURCE: src/lib/supabase/provider.tsx (component scope, never module scope) ·
// design/W1-STACK-SPEC.md §3
initTheme()
initI18n()

export default function RootLayout() {
  const { resolved } = useTheme()
  useEffect(() => {
    // Everything the first frame needs happened at module scope; drop the
    // splash as soon as the tree is actually mounted.
    SplashScreen.hideAsync().catch(() => undefined)
  }, [])
  return (
    <ErrorBoundary>
      {/* The status bar counter-colors the canvas (light glyphs on the dark
          theme) and tracks the store live. */}
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      {/* SupabaseProvider INSIDE the boundary and OUTSIDE everything else.
          Inside, because credentials() throws when the project is unconfigured
          and that must render the fallback screen rather than a white bundle
          crash with no message. Outside the navigator, because the client is
          the identity every screen's queries carry: one client, one session,
          one auto-refresh timer for the whole app — a per-screen provider would
          mean two clients rotating the same refresh token against each other. */}
      <SupabaseProvider>
        {/* ToastProvider INSIDE the boundary (a toast bug must trip the fallback,
            not unmount the root) and AROUND the navigator, so every screen and
            modal shares one queue and one announcement channel. */}
        <ToastProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="actions" options={{ presentation: 'modal' }} />
          </Stack>
        </ToastProvider>
      </SupabaseProvider>
    </ErrorBoundary>
  )
}
