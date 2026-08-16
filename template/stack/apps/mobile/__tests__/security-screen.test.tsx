// The security route's canonical states and its two actions, over the REAL
// screen with the identity provider substituted at the client seam. The route
// registered AFTER the states-sweep suite pinned its indices, so its states
// are swept here, in its own suite, to the same contract: loading is an
// announced progressbar, empty carries the primary action, error CONTAINS a
// retry that recovers.
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { ROUTES } from '../src/routes'
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

const SECURITY = ROUTES[3]

// The security screen itself queries nothing over tRPC, but the app shell
// around it (connection status) does.
const SHELL_API = {
  systemHealth: () => ({ ok: true as const, version: '0.0.0' }),
  notesList: () => ({ ok: true as const, data: { items: [], nextCursor: null } }),
}

afterEach(() => {
  uninstallMockServer()
})

describe('security route canonical states', () => {
  it(`a held factor read renders ${SECURITY.states.loading} as a progressbar skeleton, never prose`, async () => {
    installMockSupabase({ holdListFactors: true })
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    const loading = await screen.findByTestId(SECURITY.states.loading)
    expect(loading.props['accessibilityRole'] as string).toBe('progressbar')
    expect(loading.props['accessibilityLabel'] as string).toBe(en['common.loading'])
  })

  it(`zero factors render ${SECURITY.states.empty} with the enrol action as its CTA`, async () => {
    installMockSupabase()
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    expect(await screen.findByTestId(SECURITY.states.empty)).toBeTruthy()
    expect(screen.getByText(en['security.enrol'])).toBeTruthy()
  })

  it(`a failed read renders ${SECURITY.states.error} CONTAINING a retry that recovers`, async () => {
    installMockSupabase({ listFactorsFailure: 'network down' })
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    expect(await screen.findByTestId(SECURITY.states.error)).toBeTruthy()
    // Swap the double to healthy first, so recovery is observable — the same
    // choreography the states sweep uses on the network routes.
    installMockSupabase()
    fireEvent.press(screen.getByRole('button', { name: en['common.retry'] }))
    expect(await screen.findByTestId(SECURITY.states.empty)).toBeTruthy()
  })
})

describe('security actions', () => {
  it('lists enrolled factors by name and removes one on unenroll', async () => {
    installMockSupabase({ factors: [{ id: 'factor-1', friendly_name: 'Work phone' }] })
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    expect(await screen.findByText('Work phone')).toBeTruthy()
    fireEvent.press(screen.getByTestId('security-unenroll-factor-1'))

    // The double's factor list is stateful: the re-read after unenroll comes
    // back empty, so the EMPTY state appearing proves the screen re-read the
    // server rather than patching its local list.
    expect(await screen.findByTestId(SECURITY.states.empty)).toBeTruthy()
    expect(mockSupabaseCalls.unenrolls).toEqual(['factor-1'])
  })

  it('a failed unenroll keeps the row and says so in the error toast', async () => {
    installMockSupabase({
      factors: [{ id: 'factor-1', friendly_name: 'Work phone' }],
      unenrollFailure: 'factor not found',
    })
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    fireEvent.press(await screen.findByTestId('security-unenroll-factor-1'))

    expect(await screen.findByTestId('toast-error')).toHaveTextContent(
      en['security.unenroll.failed'],
    )
    expect(screen.getByText('Work phone')).toBeTruthy()
  })

  it('the enrol CTA walks the full ceremony and the verified factor appears in the list', async () => {
    installMockSupabase()
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    // Empty → open the ceremony.
    fireEvent.press(await screen.findByText(en['security.enrol']))
    const secret = await screen.findByTestId('mfa-enrol-secret')
    expect(secret).toHaveTextContent(MOCK_ENROLMENT.secret)

    // Verify the code; the double marks the factor verified, and the screen's
    // re-read — not a local append — is what puts the row on screen.
    fireEvent.changeText(screen.getByTestId('mfa-enrol-code'), '123456')
    fireEvent.press(screen.getByTestId('mfa-enrol-verify'))

    expect(await screen.findByText(en['security.factor.unnamed'])).toBeTruthy()
    expect(mockSupabaseCalls.verifies).toEqual([
      { factorId: MOCK_ENROLMENT.id, challengeId: 'challenge-mock', code: '123456' },
    ])
  })

  it('cancel closes the ceremony without enrolling anything', async () => {
    installMockSupabase()
    installMockServer(SHELL_API)

    renderRouter('./app', { initialUrl: SECURITY.path })

    fireEvent.press(await screen.findByText(en['security.enrol']))
    fireEvent.press(await screen.findByTestId('mfa-enrol-secondary'))

    expect(await screen.findByTestId(SECURITY.states.empty)).toBeTruthy()
    expect(mockSupabaseCalls.verifies).toHaveLength(0)
  })
})
