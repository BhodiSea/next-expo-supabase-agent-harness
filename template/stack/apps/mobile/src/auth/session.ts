// The session seam: ONE provider interface every auth strategy implements, and
// a module-level active provider the router shell installs at boot. Features
// never see a provider — they call the api-client one-door, which pulls the
// token through the resolver installed here.
import { setAccessTokenProvider, setUnauthorizedRetry } from '../lib/api-client'

export interface AccessTokenProvider {
  /** Resolve the current bearer token, or null when signed out. */
  readonly getAccessToken: () => Promise<string | null>
  /**
   * Interactive sign-in; resolves once a token is stored host-side. `hint` is
   * provider-interpreted: the dev stub takes an optional subject uuid (pin the
   * same user across reinstalls); Entra forwards it as login_hint.
   */
  readonly signIn: (hint?: string) => Promise<void>
  /** Drop the stored credential. */
  readonly signOut: () => Promise<void>
  /**
   * Renew the stored access token WITHOUT user interaction (Entra: the stored
   * refresh_token), answering whether it succeeded. OPTIONAL on purpose — the
   * dev stub has nothing to refresh, and an absent member reads as "a 401 is
   * final", which is the honest semantics for it. Consumed by the api-client's
   * 401-retry-once seam; never called directly by features.
   */
  readonly refresh?: () => Promise<boolean>
}

let active: AccessTokenProvider | null = null

/**
 * Install the active provider and wire it into the api-client. Called once from
 * app/_layout.tsx at boot (and by tests with their own fakes) — the shape
 * mirrors setAccessTokenProvider so a forgotten wire still fails loudly on the
 * first request rather than sending a bare one.
 */
export function installSessionProvider(provider: AccessTokenProvider): void {
  active = provider
  setAccessTokenProvider(() => provider.getAccessToken())
  // The 401-retry hook rides the same install: present exactly when the
  // provider can refresh, cleared otherwise (a stale hook from a previous
  // provider would retry with the wrong credential store).
  const refresh = provider.refresh
  setUnauthorizedRetry(refresh === undefined ? null : () => refresh())
}

/** The active provider; throws when boot wiring was skipped (a real bug). */
export function sessionProvider(): AccessTokenProvider {
  if (active === null) {
    throw new Error('no session provider installed — app/_layout.tsx wires one at boot')
  }
  return active
}
