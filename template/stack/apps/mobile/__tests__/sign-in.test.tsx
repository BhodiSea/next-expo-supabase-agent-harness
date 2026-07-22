// Sign-in flow over the real screen + the real stub provider, with BOTH seams
// substituted at their boundaries: the host keychain is mocked in-memory (the
// test asserts AT the seam — token in, token out — not against SecureStore
// internals), and the network runs through the mock server, so the shipped
// api-client code (origin, auth:false mint, envelope decoding) still executes.
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import { secureGetToken } from '../src/host'
import { t } from '../src/i18n'
import { installMockServer, uninstallMockServer } from '../src/testing/mock-server'

jest.mock('../src/host', () => {
  let token: string | null = null
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
    secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
    secureSetRefreshToken: jest.fn(() => Promise.resolve()),
    secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
  }
})

const DEV_TOKEN = 'header.payload.signature-dev'
const DEV_USER = '3f2c8f2a-0000-4000-8000-000000000001'

// The screens behind a successful sign-in fetch (Home: notes + healthz) — the
// mock server throws on any unhandled request, so the redirect target's
// network must be declared too.
const HOME_NETWORK = {
  'GET /healthz': () => ({ status: 200, body: { ok: true, version: '0.0.0' } }),
  'GET /api/notes': () => ({ status: 200, body: { items: [], nextCursor: null } }),
}

afterEach(() => {
  uninstallMockServer()
})

describe('dev sign-in', () => {
  it('mints a token from the stub authority, stores it host-side, and returns home', async () => {
    const mint = jest.fn(() => ({ status: 201, body: { token: DEV_TOKEN, userId: DEV_USER } }))
    installMockServer({ ...HOME_NETWORK, 'POST /auth/dev-token': mint })

    renderRouter('./app', { initialUrl: '/sign-in' })
    fireEvent.press(await screen.findByTestId('sign-in-submit'))

    expect(await screen.findByTestId('home-empty')).toBeTruthy()
    expect(mint).toHaveBeenCalledTimes(1)
    await expect(secureGetToken()).resolves.toBe(DEV_TOKEN)
  })

  it('an invalid dev subject shows the inline field error and sends NOTHING', async () => {
    const mint = jest.fn(() => ({ status: 201, body: { token: DEV_TOKEN, userId: DEV_USER } }))
    installMockServer({ ...HOME_NETWORK, 'POST /auth/dev-token': mint })

    renderRouter('./app', { initialUrl: '/sign-in' })
    fireEvent.changeText(await screen.findByLabelText(t('signin.subject.label')), 'not-a-uuid')
    fireEvent.press(screen.getByTestId('sign-in-submit'))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(mint).not.toHaveBeenCalled()
  })

  it('a failed mint surfaces TRANSLATED copy from the envelope code, as role=alert', async () => {
    installMockServer({
      ...HOME_NETWORK,
      'POST /auth/dev-token': () => ({
        status: 500,
        body: { error: { code: 'internal', message: 'boom' } },
      }),
    })

    renderRouter('./app', { initialUrl: '/sign-in' })
    fireEvent.press(await screen.findByTestId('sign-in-submit'))

    const failure = await screen.findByTestId('sign-in-failure')
    // The catalog copy for the stable code — never the server's raw "boom".
    expect(failure).toHaveTextContent(t('error.api.internal'))
  })
})

describe('entra-mode sign-in render', () => {
  // The MODE probe (entraConfigured) reads the EXPO_PUBLIC_ IDs per call, so
  // setting them here flips the SCREEN into entra mode. Render-only on
  // purpose: the PKCE prompt needs a browser + an identity provider — faking
  // those would test the fake (the provider's pure seams are covered in
  // entra.test.ts; the interactive flow belongs to a credentialed e2e lane).
  beforeEach(() => {
    process.env['EXPO_PUBLIC_ENTRA_TENANT_ID'] = '11111111-2222-3333-4444-555555555555'
    process.env['EXPO_PUBLIC_ENTRA_CLIENT_ID'] = '66666666-7777-8888-9999-aaaaaaaaaaaa'
  })

  afterEach(() => {
    delete process.env['EXPO_PUBLIC_ENTRA_TENANT_ID']
    delete process.env['EXPO_PUBLIC_ENTRA_CLIENT_ID']
  })

  it('renders the Microsoft sign-in affordance instead of the dev subject form', async () => {
    installMockServer({ ...HOME_NETWORK })
    renderRouter('./app', { initialUrl: '/sign-in' })

    expect(await screen.findByTestId('sign-in-entra')).toBeTruthy()
    expect(screen.getByText(t('signin.entra.body'))).toBeTruthy()
    // The dev-only subject field must NOT ship on the entra surface.
    expect(screen.queryByTestId('sign-in-subject')).toBeNull()
    expect(screen.queryByTestId('sign-in-submit')).toBeNull()
  })
})
