import { AuthRequest, exchangeCodeAsync, makeRedirectUri, refreshAsync } from 'expo-auth-session'
import Constants from 'expo-constants'
import {
  secureDeleteRefreshToken,
  secureDeleteToken,
  secureGetRefreshToken,
  secureGetToken,
  secureSetRefreshToken,
  secureSetToken,
} from '../../host'
import type { AccessTokenProvider } from '../session'

// The production AccessTokenProvider — Microsoft Entra ID via expo-auth-session.
//
// FLOW: authorization-code + PKCE against the tenant's v2.0 endpoints, driven
// through the IMPERATIVE AuthRequest/exchangeCodeAsync API (not the useAuthRequest
// hook): the provider seam is a plain object installed at boot, outside any
// component tree, and a hook here would force the session machinery into React.
// SOURCE: Entra ID mobile apps use the auth-code flow with PKCE; the implicit
// flow is legacy and never issues refresh tokens
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
// SOURCE: v2.0 endpoints live under /{tenant}/oauth2/v2.0/ and the issuer under
// /{tenant}/v2.0 — the SAME authority string apps/server/src/auth/verify.ts pins
// as its issuer, which is what makes client and server verify the same tenant
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols
//
// CONFIG: tenant + client IDs ride EXPO_PUBLIC_ env vars. That is deliberate and
// safe: both are PUBLIC identifiers (they appear verbatim in every authorize
// redirect a browser can observe) — the secret-shaped thing in this flow is the
// PKCE verifier, which expo-auth-session generates per attempt and never stores.
// A client secret does not exist: mobile apps are public clients by definition.
// Metro inlines EXPO_PUBLIC_ vars by rewriting the literal DOT member access, so
// the reads below stay dot-form (same rule as src/lib/api-client.ts).
declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_ENTRA_TENANT_ID?: string
    readonly EXPO_PUBLIC_ENTRA_CLIENT_ID?: string
  }
}

/** @public — seam API: the shape entraConfig() answers with (test-asserted). */
export interface EntraConfig {
  readonly tenantId: string
  readonly clientId: string
}

/**
 * The configured IDs, or null when either is absent. Empty means unset (the
 * `||` discipline from api-client: a bare `EXPO_PUBLIC_ENTRA_TENANT_ID=` line
 * in .env must read as "not configured", never as an empty tenant).
 * @public — test-facing seam API: the PKCE unit suite drives these pure helpers offline.
 */
export function entraConfig(): EntraConfig | null {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- '' must fall through to unset, same as api-client's origin read
  const tenantId = process.env.EXPO_PUBLIC_ENTRA_TENANT_ID || ''
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- '' must fall through to unset, same as api-client's origin read
  const clientId = process.env.EXPO_PUBLIC_ENTRA_CLIENT_ID || ''
  if (tenantId === '' || clientId === '') return null
  return { tenantId, clientId }
}

/** True when the Entra IDs are present — the boot wiring and sign-in screen branch on this. */
export function entraConfigured(): boolean {
  return entraConfig() !== null
}

/**
 * The v2.0 endpoints for a tenant. Manual rather than discovered: the shapes
 * are a published contract (SOURCE above), discovery would add a network
 * round-trip before every sign-in, and a pure function is testable offline.
 * @public — test-facing seam API (see entraConfig).
 */
export function entraDiscovery(tenantId: string): {
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
} {
  // The oauth2 segment sits between the tenant and the version for the two
  // protocol endpoints (authorize/token); the ISSUER string the server pins
  // (`https://login.microsoftonline.com/{tenant}/v2.0`) omits it.
  return {
    authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
  }
}

/**
 * Scopes: the OIDC trio + the API's own scope. `api://{clientId}/.default`
 * matches the template's single-registration layout, where the API is exposed
 * on the SAME app registration and apps/server defaults its audience to
 * ENTRA_CLIENT_ID (verify.ts: API_AUDIENCE ?? ENTRA_CLIENT_ID). offline_access
 * is what makes Entra return a refresh_token at all.
 * SOURCE: /.default requests the registration's configured permission set
 * https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc
 * @public — test-facing seam API (see entraConfig).
 */
export function entraScopes(clientId: string): readonly string[] {
  return ['openid', 'profile', 'offline_access', `api://${clientId}/.default`]
}

/**
 * The redirect URI the authorize response returns to — the app's own scheme
 * (app.config.ts `scheme`, locked by the expo-policy gate), which the OS routes
 * back into this app. Reading it from expoConfig keeps the URI derived, never a
 * second hand-typed copy that can drift from the registered one.
 * @public — test-facing seam API (see entraConfig).
 */
export function entraRedirectUri(): string {
  const raw = Constants.expoConfig?.scheme
  const scheme = Array.isArray(raw) ? raw[0] : raw
  // No scheme (a dev host without expoConfig): let expo-linking resolve its
  // default — passing `scheme: undefined` explicitly would fight
  // exactOptionalPropertyTypes for the same behavior.
  return makeRedirectUri(scheme === undefined || scheme === '' ? {} : { scheme })
}

/** Persist a successful token response — tokens land ONLY behind src/host. */
async function storeTokenResponse(response: {
  readonly accessToken: string
  readonly refreshToken?: string
}): Promise<void> {
  await secureSetToken(response.accessToken)
  // Entra ROTATES refresh tokens: each refresh may mint a successor. Store it
  // when present; keep the current one when the response omits it.
  if (response.refreshToken !== undefined && response.refreshToken !== '') {
    await secureSetRefreshToken(response.refreshToken)
  }
}

export function createEntraProvider(): AccessTokenProvider {
  const config = entraConfig()
  if (config === null) {
    // Fail at CREATION, loudly — the W3 stub threw here so a release build
    // could never boot into a fake session; a configured-less Entra provider
    // would be the same lie with a longer fuse.
    throw new Error(
      'Entra auth requires EXPO_PUBLIC_ENTRA_TENANT_ID and EXPO_PUBLIC_ENTRA_CLIENT_ID (public identifiers, set them in .env / EAS env)',
    )
  }
  const { tenantId, clientId } = config
  const discovery = entraDiscovery(tenantId)
  const scopes = [...entraScopes(clientId)]

  return {
    getAccessToken: () => secureGetToken(),

    signIn: async (hint?: string): Promise<void> => {
      const redirectUri = entraRedirectUri()
      const request = new AuthRequest({
        clientId,
        redirectUri,
        scopes,
        // PKCE (S256) is expo-auth-session's default for the code response
        // type; login_hint pre-fills the account picker when the caller has one.
        ...(hint === undefined ? {} : { extraParams: { login_hint: hint } }),
      })
      const result = await request.promptAsync(discovery)
      if (result.type !== 'success') {
        // Cancel/dismiss/error all land here: sign-in did NOT happen, and the
        // screen's error surface says so — never a silently absent session.
        throw new Error(`Entra sign-in did not complete (${result.type})`)
      }
      const code = result.params['code']
      if (code === undefined || code === '') {
        throw new Error('Entra authorize response carried no code')
      }
      const tokens = await exchangeCodeAsync(
        {
          clientId,
          code,
          redirectUri,
          // The verifier half of PKCE — pairs the exchange to OUR authorize
          // request; without it a stolen code is exchangeable by anyone.
          extraParams: { code_verifier: request.codeVerifier ?? '' },
        },
        discovery,
      )
      await storeTokenResponse(tokens)
    },

    signOut: async (): Promise<void> => {
      await secureDeleteToken()
      await secureDeleteRefreshToken()
    },

    // The api-client's 401-retry-once seam (session.ts wires it): renew from
    // the stored refresh_token, silently. False — not a throw — on any failure:
    // the caller's 401 then stands, and the app reads as signed out, which is
    // the truth.
    refresh: async (): Promise<boolean> => {
      const refreshToken = await secureGetRefreshToken()
      if (refreshToken === null || refreshToken === '') return false
      try {
        const tokens = await refreshAsync({ clientId, refreshToken, scopes }, discovery)
        await storeTokenResponse(tokens)
        return true
      } catch {
        return false
      }
    },
  }
}
