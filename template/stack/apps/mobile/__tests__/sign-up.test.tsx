// Sign-up over the REAL screen and the REAL Supabase call shapes, with the
// identity provider substituted at its boundary — the same seam discipline as
// the sign-in suite. What this suite pins is the OFFERED enrol step: account
// creation flows INTO the ceremony, Skip is a first-class exit, a verified
// code lands home, and a wrong code keeps the SAME factor for retry.
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { installMockServer, mockApiClient, uninstallMockServer } from '../src/testing/mock-server'
import {
  installMockSupabase,
  MOCK_ENROLMENT,
  mockSupabaseCalls,
  mockSupabaseClient,
} from '../src/testing/mock-supabase'

jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../src/lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

const EMAIL = 'person@example.com'
// Not a real credential and not credential-SHAPED (the sign-in suite's rule).
const PASSWORD = 'correct horse battery staple'

// The screen behind a completed sign-up fetches Home's surface.
const HOME_API = {
  systemHealth: () => ({ ok: true as const, version: '0.0.0' }),
  notesList: () => ({ ok: true as const, data: { items: [], nextCursor: null } }),
}

afterEach(() => {
  uninstallMockServer()
})

async function createAccount(): Promise<void> {
  renderRouter('./app', { initialUrl: '/sign-up' })
  fireEvent.changeText(await screen.findByTestId('sign-up-email'), `  ${EMAIL}  `)
  fireEvent.changeText(screen.getByTestId('sign-up-password'), PASSWORD)
  fireEvent.press(screen.getByTestId('sign-up-submit'))
}

describe('sign-up', () => {
  it('creates the account with trimmed credentials and OFFERS the enrol step', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    await createAccount()

    // The ceremony opened, showing the setup key the double issued — enrolment
    // was OFFERED, not silently skipped and not silently forced.
    const secret = await screen.findByTestId('mfa-enrol-secret')
    expect(secret).toHaveTextContent(MOCK_ENROLMENT.secret)
    expect(mockSupabaseCalls.signUp).toEqual([{ email: EMAIL, password: PASSWORD }])
    expect(mockSupabaseCalls.enrolls).toBe(1)
  })

  it('Skip is a first-class exit: straight home, no verify ever sent', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    await createAccount()
    fireEvent.press(await screen.findByTestId('mfa-enrol-secondary'))

    expect(await screen.findByTestId('home-empty')).toBeTruthy()
    expect(mockSupabaseCalls.verifies).toHaveLength(0)
  })

  it('a verified code completes the ceremony against a fresh challenge and lands home', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    await createAccount()
    fireEvent.changeText(await screen.findByTestId('mfa-enrol-code'), '123456')
    fireEvent.press(screen.getByTestId('mfa-enrol-verify'))

    expect(await screen.findByTestId('home-empty')).toBeTruthy()
    // The ceremony bracketed challenge + verify around the machine's arcs.
    expect(mockSupabaseCalls.challenges).toEqual([MOCK_ENROLMENT.id])
    expect(mockSupabaseCalls.verifies).toEqual([
      { factorId: MOCK_ENROLMENT.id, challengeId: 'challenge-mock', code: '123456' },
    ])
  })

  it('a wrong-shape code is refused inline and costs NO round trip', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    await createAccount()
    fireEvent.changeText(await screen.findByTestId('mfa-enrol-code'), '12')
    fireEvent.press(screen.getByTestId('mfa-enrol-verify'))

    expect(await screen.findByText(en['mfa.code.invalid'])).toBeTruthy()
    expect(mockSupabaseCalls.challenges).toHaveLength(0)
  })

  it('a rejected code shows the catalog sentence, keeps the SAME factor, and retries', async () => {
    installMockSupabase({ verifyFailure: 'Invalid TOTP code' })
    installMockServer(HOME_API)

    await createAccount()
    fireEvent.changeText(await screen.findByTestId('mfa-enrol-code'), '000000')
    fireEvent.press(screen.getByTestId('mfa-enrol-verify'))

    const failed = await screen.findByTestId('mfa-enrol-failed')
    expect(failed).toHaveTextContent(en['mfa.code.failed'])
    // The provider's own message never reaches the screen.
    expect(screen.queryByText('Invalid TOTP code')).toBeNull()
    // The retry arc re-renders the SAME secret — no second factor enrolled.
    expect(screen.getByTestId('mfa-enrol-secret')).toHaveTextContent(MOCK_ENROLMENT.secret)
    expect(mockSupabaseCalls.enrolls).toBe(1)
  })

  it('a rejected sign-up shows ONE non-enumerating sentence and never opens the ceremony', async () => {
    installMockSupabase({ signUpFailure: 'User already registered' })
    installMockServer(HOME_API)

    await createAccount()

    const failure = await screen.findByTestId('sign-up-failure')
    expect(failure).toHaveTextContent(en['signup.failed'])
    // "already registered" is an account-existence oracle — it must not render.
    expect(screen.queryByText('User already registered')).toBeNull()
    expect(mockSupabaseCalls.enrolls).toBe(0)
  })

  it('a session-less sign-up (confirm-email deployments) shows the confirm note, not the ceremony', async () => {
    installMockSupabase({ signUpWithoutSession: true })
    installMockServer(HOME_API)

    await createAccount()

    expect(await screen.findByTestId('sign-up-confirm-sent')).toBeTruthy()
    // No session, nothing to enrol against — the offer moves to Security.
    expect(mockSupabaseCalls.enrolls).toBe(0)
  })
})
