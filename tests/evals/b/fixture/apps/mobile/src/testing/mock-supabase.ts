import type { Client } from '@app/supabase/client'

// The AUTH seam for component and screen tests, and the counterpart to
// mock-server.ts: that one fakes what the API answers, this one fakes who is
// asking.
//
// It substitutes the CLIENT, not the keychain underneath it. The distinction is
// the same one the old host-token mock got wrong: mocking `expo-secure-store`
// meant the test asserted against a storage implementation nobody reads, while
// the thing screens actually depend on — "does auth say yes" — stayed
// unexercised. Here the double sits exactly where `useSupabase()` does, so a
// screen's real code path runs and only the identity provider is imaginary.
//
// A REAL client would be worse than useless here: it constructs an AES-backed
// keychain store over native modules jest only stubs, starts a refresh timer,
// and answers sign-in over the network. None of that is what a notes-flow test
// is about, and all of it is a source of flake.

/** A verified TOTP factor as `mfa.listFactors` reports it — the three fields
 *  the screens actually read. */
export interface MockFactor {
  readonly id: string
  readonly friendly_name?: string
}

/** The AAL pair `mfa.getAuthenticatorAssuranceLevel` answers with. */
interface MockAalSnapshot {
  readonly currentLevel: 'aal1' | 'aal2' | null
  readonly nextLevel: 'aal1' | 'aal2' | null
}

/** What the double should answer. Absent entries take the benign default. */
export interface MockSupabaseBehavior {
  /** `auth.signInWithPassword` — return a message to fail, or omit to succeed. */
  readonly signInFailure?: string
  /** `auth.signUp` — return a message to fail, or omit to succeed. */
  readonly signUpFailure?: string
  /** `auth.signUp` — answer WITHOUT a session (the confirm-email deployment shape). */
  readonly signUpWithoutSession?: boolean
  /** `functions.invoke('delete-account')` — return a message to fail, or omit to succeed. */
  readonly deleteAccountFailure?: string
  /** The AAL pair after sign-in. Default aal1/aal1 — the un-enrolled steady state. */
  readonly aal?: MockAalSnapshot
  /** `mfa.listFactors` — the verified TOTP factors. Default none. */
  readonly factors?: readonly MockFactor[]
  /** `mfa.listFactors` — return a message to fail the read instead. */
  readonly listFactorsFailure?: string
  /** `mfa.listFactors` — never resolve, so a test can hold the loading state. */
  readonly holdListFactors?: boolean
  /** `mfa.enroll` — return a message to fail, or omit to hand back the fixture factor. */
  readonly enrollFailure?: string
  /** `mfa.challenge` — return a message to fail, or omit to mint a challenge id. */
  readonly challengeFailure?: string
  /** `mfa.verify` — return a message to fail, or omit to succeed. */
  readonly verifyFailure?: string
  /** `mfa.unenroll` — return a message to fail, or omit to succeed. */
  readonly unenrollFailure?: string
}

interface AuthCall {
  readonly email: string
  readonly password: string
}

interface VerifyCall {
  readonly factorId: string
  readonly challengeId: string
  readonly code: string
}

/** The factor `mfa.enroll` mints — stable so tests can assert the secret the
 *  ceremony rendered is the one the double issued. */
export const MOCK_ENROLMENT = {
  id: 'factor-mock',
  secret: 'MOCKSECRETBASE32',
  uri: 'otpauth://totp/mock',
  qrCode: 'data:image/svg+xml;utf-8,<svg/>',
} as const

let behavior: MockSupabaseBehavior = {}

// The factor list is STATEFUL, seeded from `behavior.factors` at install: a
// successful enrolment verify adds the mock factor and a successful unenroll
// removes one, so a screen that re-reads the list after an action sees the
// consequence — without the test swapping doubles mid-flight, which would be
// the test scripting the very consistency it claims to observe.
let factorsState: MockFactor[] = []

/** Observable side effects, so a test can assert what the screen actually did. */
export const mockSupabaseCalls: {
  signIn: AuthCall[]
  signUp: AuthCall[]
  signOut: number
  invoked: string[]
  enrolls: number
  listFactors: number
  challenges: string[]
  verifies: VerifyCall[]
  unenrolls: string[]
} = {
  signIn: [],
  signUp: [],
  signOut: 0,
  invoked: [],
  enrolls: 0,
  listFactors: 0,
  challenges: [],
  verifies: [],
  unenrolls: [],
}

/**
 * Identity-stable for the same reason mockApiClient is: `useApi()` caches the
 * tRPC client KEYED ON the Supabase client, so a double that minted a new
 * object per render would mint a new API client per render too, and every hook
 * depending on `api` would re-fire forever.
 */
let client: Client | null = null

export function mockSupabaseClient(): Client {
  client ??= {
    auth: {
      signInWithPassword: (credentials: AuthCall) => {
        mockSupabaseCalls.signIn.push(credentials)
        // `{ data, error }`, never a rejection — the real client's contract, and
        // the reason the sign-in screen has no try/catch to mirror.
        return Promise.resolve(
          behavior.signInFailure === undefined
            ? { data: {}, error: null }
            : { data: {}, error: { message: behavior.signInFailure } },
        )
      },
      signUp: (credentials: AuthCall) => {
        mockSupabaseCalls.signUp.push(credentials)
        if (behavior.signUpFailure !== undefined) {
          return Promise.resolve({
            data: { user: null, session: null },
            error: { message: behavior.signUpFailure },
          })
        }
        // The confirm-email deployment answers with a user and NO session —
        // the branch the sign-up screens must render honestly.
        const session = behavior.signUpWithoutSession === true ? null : {}
        return Promise.resolve({ data: { user: {}, session }, error: null })
      },
      signOut: () => {
        mockSupabaseCalls.signOut += 1
        return Promise.resolve({ error: null })
      },
      // The transport reads the bearer token per request; the double answers
      // "no session" because the API double does not check one — an invented
      // token would be a fact no assertion depends on.
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      startAutoRefresh: () => Promise.resolve(),
      stopAutoRefresh: () => Promise.resolve(),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({
            data: behavior.aal ?? { currentLevel: 'aal1', nextLevel: 'aal1' },
            error: null,
          }),
        listFactors: () => {
          mockSupabaseCalls.listFactors += 1
          if (behavior.holdListFactors === true) return new Promise<never>(() => undefined)
          if (behavior.listFactorsFailure !== undefined) {
            return Promise.resolve({
              data: null,
              error: { message: behavior.listFactorsFailure },
            })
          }
          const totp = [...factorsState]
          return Promise.resolve({ data: { all: totp, totp }, error: null })
        },
        enroll: () => {
          mockSupabaseCalls.enrolls += 1
          if (behavior.enrollFailure !== undefined) {
            return Promise.resolve({ data: null, error: { message: behavior.enrollFailure } })
          }
          return Promise.resolve({
            data: {
              id: MOCK_ENROLMENT.id,
              totp: {
                qr_code: MOCK_ENROLMENT.qrCode,
                secret: MOCK_ENROLMENT.secret,
                uri: MOCK_ENROLMENT.uri,
              },
            },
            error: null,
          })
        },
        challenge: ({ factorId }: { readonly factorId: string }) => {
          mockSupabaseCalls.challenges.push(factorId)
          if (behavior.challengeFailure !== undefined) {
            return Promise.resolve({ data: null, error: { message: behavior.challengeFailure } })
          }
          return Promise.resolve({ data: { id: 'challenge-mock' }, error: null })
        },
        verify: (params: VerifyCall) => {
          mockSupabaseCalls.verifies.push(params)
          if (behavior.verifyFailure !== undefined) {
            return Promise.resolve({ data: null, error: { message: behavior.verifyFailure } })
          }
          // A verified ENROLMENT challenge turns the pending factor into a
          // listed one — the consequence the security screen re-reads.
          if (
            params.factorId === MOCK_ENROLMENT.id &&
            !factorsState.some((factor) => factor.id === params.factorId)
          ) {
            factorsState.push({ id: MOCK_ENROLMENT.id })
          }
          return Promise.resolve({ data: {}, error: null })
        },
        unenroll: ({ factorId }: { readonly factorId: string }) => {
          mockSupabaseCalls.unenrolls.push(factorId)
          if (behavior.unenrollFailure !== undefined) {
            return Promise.resolve({ data: null, error: { message: behavior.unenrollFailure } })
          }
          factorsState = factorsState.filter((factor) => factor.id !== factorId)
          return Promise.resolve({ data: { id: factorId }, error: null })
        },
      },
    },
    functions: {
      invoke: (name: string) => {
        mockSupabaseCalls.invoked.push(name)
        return Promise.resolve(
          behavior.deleteAccountFailure === undefined
            ? { data: null, error: null }
            : { data: null, error: { message: behavior.deleteAccountFailure } },
        )
      },
    },
    // The cast covers the rest of the SupabaseClient surface (postgrest, realtime,
    // storage) that no mobile screen touches. Adding a screen that DOES touch one
    // means adding it here deliberately, which is the review this shape forces.
  } as unknown as Client
  return client
}

/**
 * Set the behaviour and clear the recorded calls for one test.
 *
 * There is deliberately NO `uninstall` counterpart, unlike the procedure double.
 * That one has to be uninstalled because an unstubbed procedure must throw —
 * leaving a previous test's handlers live would let a test pass on another
 * test's fixtures. This double has no such hazard: every method answers, the
 * defaults are benign, and install RESETS. A teardown hook that exists only for
 * symmetry is a hook someone will eventually forget, for no benefit.
 */
export function installMockSupabase(next: MockSupabaseBehavior = {}): void {
  behavior = next
  factorsState = [...(next.factors ?? [])]
  mockSupabaseCalls.signIn = []
  mockSupabaseCalls.signUp = []
  mockSupabaseCalls.signOut = 0
  mockSupabaseCalls.invoked = []
  mockSupabaseCalls.enrolls = 0
  mockSupabaseCalls.listFactors = 0
  mockSupabaseCalls.challenges = []
  mockSupabaseCalls.verifies = []
  mockSupabaseCalls.unenrolls = []
}
