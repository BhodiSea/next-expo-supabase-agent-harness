// Sign-in over the REAL screen and the REAL Supabase call shape, with the
// identity provider substituted at its boundary — the client, not the keychain
// underneath it. Asserting AT the seam (credentials in, `{ data, error }` out)
// is what keeps this suite about the SCREEN's contract: inline validation
// before any request, one non-enumerating failure sentence, and a redirect only
// on success.
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
// Not a real credential and not credential-SHAPED: a literal that looks like a
// token is a literal a secret scanner has to reason about, and one that a
// future reader has to prove is fake.
const PASSWORD = 'correct horse battery staple'

// The screen behind a successful sign-in fetches (Home: notes + liveness) — the
// double throws on any unstubbed procedure, so the redirect target's API
// surface has to be declared too.
const HOME_API = {
  systemHealth: () => ({ ok: true as const, version: '0.0.0' }),
  notesList: () => ({ ok: true as const, data: { items: [], nextCursor: null } }),
}

afterEach(() => {
  uninstallMockServer()
})

async function fillCredentials(email: string, password: string): Promise<void> {
  fireEvent.changeText(await screen.findByTestId('sign-in-email'), email)
  fireEvent.changeText(screen.getByTestId('sign-in-password'), password)
}

describe('sign-in', () => {
  it('sends the trimmed credentials to Supabase and returns home', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    renderRouter('./app', { initialUrl: '/sign-in' })
    await fillCredentials(`  ${EMAIL}  `, PASSWORD)
    fireEvent.press(screen.getByTestId('sign-in-submit'))

    expect(await screen.findByTestId('home-empty')).toBeTruthy()
    // Trimmed: a leading space from an autofill or a paste must not turn a
    // valid address into a failed sign-in the user cannot see.
    expect(mockSupabaseCalls.signIn).toEqual([{ email: EMAIL, password: PASSWORD }])
  })

  it('an invalid email shows the inline field error and sends NOTHING', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    renderRouter('./app', { initialUrl: '/sign-in' })
    await fillCredentials('not-an-email', PASSWORD)
    fireEvent.press(screen.getByTestId('sign-in-submit'))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(mockSupabaseCalls.signIn).toHaveLength(0)
  })

  it('a missing password is caught in the SAME pass as the email, not one round trip later', async () => {
    installMockSupabase()
    installMockServer(HOME_API)

    renderRouter('./app', { initialUrl: '/sign-in' })
    await fillCredentials('also-not-an-email', '')
    fireEvent.press(screen.getByTestId('sign-in-submit'))

    // BOTH messages, from one press — validating one field at a time makes a
    // user with two typos submit twice to learn about the second.
    expect(await screen.findByText(en['signin.email.invalid'])).toBeTruthy()
    expect(screen.getByText(en['signin.password.invalid'])).toBeTruthy()
    expect(mockSupabaseCalls.signIn).toHaveLength(0)
  })

  it('a rejected credential shows ONE non-enumerating sentence, never the provider message', async () => {
    installMockSupabase({ signInFailure: 'Invalid login credentials' })
    installMockServer(HOME_API)

    renderRouter('./app', { initialUrl: '/sign-in' })
    await fillCredentials(EMAIL, PASSWORD)
    fireEvent.press(screen.getByTestId('sign-in-submit'))

    const failure = await screen.findByTestId('sign-in-failure')
    expect(failure).toHaveTextContent(en['signin.failed'])
    // The provider's own wording distinguishes "no such account" from "wrong
    // password"; rendering it would tell an attacker which addresses have
    // accounts. It must not reach the screen at all.
    expect(screen.queryByText('Invalid login credentials')).toBeNull()
    // …and the user stays on sign-in.
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy()
  })
})
