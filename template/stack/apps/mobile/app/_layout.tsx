// The root shell. ORDER MATTERS at the top of this file:
// polyfills come FIRST — nothing may construct an Intl formatter (directly or
// through t()) before the Hermes gaps are filled, and an import graph is
// evaluated in import order, so this line being line one is load-bearing.
import '../src/i18n/polyfills'

import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { createEntraProvider, entraConfigured } from '../src/auth/providers/entra'
import { createStubProvider } from '../src/auth/providers/stub'
import { installSessionProvider } from '../src/auth/session'
import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { ToastProvider } from '../src/components/Toast'
import { initI18n } from '../src/i18n/platform'
import { initTheme, useTheme } from '../src/theme/theme'

// Hold the native splash until the tree is mounted: the boot work below is
// synchronous (kv-store is sync by design), so by first render the theme and
// locale are already right — the splash bridges only the JS-load gap. The
// splash background is the dark canvas token (app.config.ts lockstep), so the
// frame it hands off to is the same pixel it painted. Fail-silent: under jest
// or fast refresh the native module may be absent.
SplashScreen.preventAutoHideAsync().catch(() => undefined)

// Module-scope boot, deliberately BEFORE the first render (the no-flash
// discipline): resolve the persisted theme, install the i18n platform adapter
// (allowRTL + locale negotiation), and wire the session seam.
initTheme()
initI18n()
// The provider seam is chosen ONCE, at boot, by CONFIGURATION, not build type:
// when the Entra IDs are present (EXPO_PUBLIC_ENTRA_*) the real Entra provider
// runs — in dev too, so the production flow is testable before release. Without
// them, dev falls back to the stub authority (POST /auth/dev-token), and a
// RELEASE build fails loudly at boot (createStubProvider throws outside
// __DEV__) instead of shipping unauthenticated.
installSessionProvider(entraConfigured() ? createEntraProvider() : createStubProvider())

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
      {/* ToastProvider INSIDE the boundary (a toast bug must trip the fallback,
          not unmount the root) and AROUND the navigator, so every screen and
          modal shares one queue and one announcement channel. */}
      <ToastProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="actions" options={{ presentation: 'modal' }} />
        </Stack>
      </ToastProvider>
    </ErrorBoundary>
  )
}
