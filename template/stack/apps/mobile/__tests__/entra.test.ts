// Entra provider seams — the PURE halves only. Deliberately NOT here: a faked
// end-to-end PKCE round trip (promptAsync needs a real browser and a real
// identity provider; mocking both would test the mocks). What IS pinned:
// endpoint derivation, scope construction, redirect-uri derivation from the
// app scheme, config gating, and the token-store round trip through the mocked
// host seam — the parts a typo would silently break in production.
import {
  createEntraProvider,
  entraConfig,
  entraConfigured,
  entraDiscovery,
  entraRedirectUri,
  entraScopes,
} from '../src/auth/providers/entra'
import {
  secureGetRefreshToken,
  secureGetToken,
  secureSetRefreshToken,
  secureSetToken,
} from '../src/host'

jest.mock('../src/host', () => {
  let token: string | null = null
  let refresh: string | null = null
  return {
    secureGetToken: jest.fn(() => Promise.resolve(token)),
    secureSetToken: jest.fn((next: string) => {
      token = next
      return Promise.resolve()
    }),
    secureDeleteToken: jest.fn(() => {
      token = null
      return Promise.resolve()
    }),
    secureGetRefreshToken: jest.fn(() => Promise.resolve(refresh)),
    secureSetRefreshToken: jest.fn((next: string) => {
      refresh = next
      return Promise.resolve()
    }),
    secureDeleteRefreshToken: jest.fn(() => {
      refresh = null
      return Promise.resolve()
    }),
  }
})

// The app scheme the redirect URI derives from — a fixed expoConfig, so the
// assertion pins DERIVATION, not whatever jest-expo's manifest mock carries.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { scheme: 'acmeapp' } },
}))

// Mock the LIBRARY boundary: what is under test is OUR derivation (scheme from
// expoConfig → makeRedirectUri options), not expo-auth-session's internals —
// its real makeRedirectUri needs the full native linking environment jest does
// not have. The mock echoes the scheme back, so a broken pass-through fails.
jest.mock('expo-auth-session', () => ({
  AuthRequest: jest.fn(),
  exchangeCodeAsync: jest.fn(),
  refreshAsync: jest.fn(),
  makeRedirectUri: jest.fn(
    (options?: { readonly scheme?: string }) => `${options?.scheme ?? 'exp'}://auth`,
  ),
}))

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT = '66666666-7777-8888-9999-aaaaaaaaaaaa'

function withEntraEnv(): void {
  process.env['EXPO_PUBLIC_ENTRA_TENANT_ID'] = TENANT
  process.env['EXPO_PUBLIC_ENTRA_CLIENT_ID'] = CLIENT
}

afterEach(() => {
  delete process.env['EXPO_PUBLIC_ENTRA_TENANT_ID']
  delete process.env['EXPO_PUBLIC_ENTRA_CLIENT_ID']
})

describe('entra config gating', () => {
  it('reads both IDs from env, treating empty as unset (the || discipline)', () => {
    expect(entraConfig()).toBeNull()
    process.env['EXPO_PUBLIC_ENTRA_TENANT_ID'] = TENANT
    process.env['EXPO_PUBLIC_ENTRA_CLIENT_ID'] = ''
    expect(entraConfig()).toBeNull()
    expect(entraConfigured()).toBe(false)
    withEntraEnv()
    expect(entraConfig()).toEqual({ tenantId: TENANT, clientId: CLIENT })
    expect(entraConfigured()).toBe(true)
  })

  it('createEntraProvider fails LOUDLY without the IDs — never a provider that cannot sign in', () => {
    expect(() => createEntraProvider()).toThrow(/EXPO_PUBLIC_ENTRA_TENANT_ID/)
  })
})

describe('entra endpoint + scope derivation', () => {
  it('pins the v2.0 authorize/token endpoints under the tenant', () => {
    expect(entraDiscovery(TENANT)).toEqual({
      authorizationEndpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      tokenEndpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    })
  })

  it('requests the OIDC trio + the registration-scoped API default', () => {
    expect(entraScopes(CLIENT)).toEqual([
      'openid',
      'profile',
      // offline_access is what makes Entra return a refresh_token at all.
      'offline_access',
      `api://${CLIENT}/.default`,
    ])
  })

  it('derives the redirect URI from the app scheme (never a hand-typed copy)', () => {
    expect(entraRedirectUri().startsWith('acmeapp://')).toBe(true)
  })
})

describe('entra provider token store round trip', () => {
  it('getAccessToken reads exactly what the host seam holds', async () => {
    withEntraEnv()
    const provider = createEntraProvider()
    await expect(provider.getAccessToken()).resolves.toBeNull()
    await secureSetToken('live-access-token')
    await expect(provider.getAccessToken()).resolves.toBe('live-access-token')
  })

  it('signOut drops BOTH stored credentials', async () => {
    withEntraEnv()
    const provider = createEntraProvider()
    await secureSetToken('live-access-token')
    await secureSetRefreshToken('live-refresh-token')
    await provider.signOut()
    await expect(secureGetToken()).resolves.toBeNull()
    await expect(secureGetRefreshToken()).resolves.toBeNull()
  })

  it('refresh answers false when no refresh token is stored — the 401 stands, no network attempted', async () => {
    withEntraEnv()
    const provider = createEntraProvider()
    await expect(provider.refresh?.()).resolves.toBe(false)
  })
})
