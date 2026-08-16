// The AAL branch and the challenge screen, together, because they are one
// ceremony: sign-in decides (through decideAfterSignIn) whether the aal1
// session is finished, and the challenge screen is where an unfinished one
// goes. The identity provider is substituted at the client seam, so the REAL
// screens, the REAL machine transitions and the REAL routing run.
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { installMockServer, mockApiClient, uninstallMockServer } from '../src/testing/mock-server'
import {
  installMockSupabase,
  mockSupabaseCalls,
  mockSupabaseClient,
} from '../src/testing/mock-supabase'

jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../src/lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

const EMAIL = 'person@example.com'
const PASSWORD = 'correct horse battery staple'

const HOME_API = {
  systemHealth: () => ({ ok: true as const, version: '0.0.0' }),
  notesList: () => ({ ok: true as const, data: { items: [], nextCursor: null } }),
}

afterEach(() => {
  uninstallMockServer()
})

async function signIn(): Promise<void> {
  renderRouter('./app', { initialUrl: '/sign-in' })
  fireEvent.changeText(await screen.findByTestId('sign-in-email'), EMAIL)
  fireEvent.changeText(screen.getByTestId('sign-in-password'), PASSWORD)
  fireEvent.press(screen.getByTestId('sign-in-submit'))
}

describe('the AAL branch after sign-in', () => {
  it('an enrolled user at aal1 is routed to the challenge, not home', async () => {
    installMockSupabase({
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      factors: [{ id: 'factor-1' }],
    })
    installMockServer(HOME_API)

    await signIn()

    expect(await screen.findByTestId('mfa-challenge-screen')).toBeTruthy()
  })

  it('an un-enrolled user (aal1/aal1) proceeds straight home — enrolment is offered, never owed', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    await signIn()

    expect(await screen.findByTestId('home-empty')).toBeTruthy()
    expect(screen.queryByTestId('mfa-challenge-screen')).toBeNull()
  })
})

describe('the challenge screen', () => {
  it('verifies a code against a FRESH challenge and lands home', async () => {
    installMockSupabase({
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      factors: [{ id: 'factor-1' }],
    })
    installMockServer(HOME_API)

    await signIn()
    fireEvent.changeText(await screen.findByTestId('mfa-challenge-code'), '123456')
    fireEvent.press(screen.getByTestId('mfa-challenge-verify'))

    expect(await screen.findByTestId('home-empty')).toBeTruthy()
    expect(mockSupabaseCalls.challenges).toEqual(['factor-1'])
    expect(mockSupabaseCalls.verifies).toEqual([
      { factorId: 'factor-1', challengeId: 'challenge-mock', code: '123456' },
    ])
  })

  it('a rejected code shows the catalog sentence and stays on the challenge', async () => {
    installMockSupabase({
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      factors: [{ id: 'factor-1' }],
      verifyFailure: 'Invalid TOTP code',
    })
    installMockServer(HOME_API)

    await signIn()
    fireEvent.changeText(await screen.findByTestId('mfa-challenge-code'), '000000')
    fireEvent.press(screen.getByTestId('mfa-challenge-verify'))

    const failed = await screen.findByTestId('mfa-challenge-failed')
    expect(failed).toHaveTextContent(en['mfa.code.failed'])
    // The provider's own message never reaches the screen.
    expect(screen.queryByText('Invalid TOTP code')).toBeNull()
    expect(screen.getByTestId('mfa-challenge-screen')).toBeTruthy()
  })

  it('a wrong-shape code is refused inline and costs NO round trip', async () => {
    installMockSupabase({
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      factors: [{ id: 'factor-1' }],
    })
    installMockServer(HOME_API)

    await signIn()
    fireEvent.changeText(await screen.findByTestId('mfa-challenge-code'), 'abc')
    fireEvent.press(screen.getByTestId('mfa-challenge-verify'))

    expect(await screen.findByText(en['mfa.code.invalid'])).toBeTruthy()
    expect(mockSupabaseCalls.challenges).toHaveLength(0)
  })

  it('with no factor to answer with, it is an honest dead end with a way back', async () => {
    installMockSupabase({ listFactorsFailure: 'network down' })
    installMockServer(HOME_API)

    renderRouter('./app', { initialUrl: '/mfa-challenge' })

    expect(await screen.findByTestId('mfa-challenge-unavailable')).toBeTruthy()
    fireEvent.press(screen.getByTestId('mfa-challenge-back'))
    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy()
  })
})
