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

/** What the double should answer. Absent entries take the benign default. */
export interface MockSupabaseBehavior {
  /** `auth.signInWithPassword` — return a message to fail, or omit to succeed. */
  readonly signInFailure?: string
  /** `functions.invoke('delete-account')` — return a message to fail, or omit to succeed. */
  readonly deleteAccountFailure?: string
}

interface AuthCall {
  readonly email: string
  readonly password: string
}

let behavior: MockSupabaseBehavior = {}

/** Observable side effects, so a test can assert what the screen actually did. */
export const mockSupabaseCalls: {
  signIn: AuthCall[]
  signOut: number
  invoked: string[]
} = { signIn: [], signOut: 0, invoked: [] }

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
  mockSupabaseCalls.signIn = []
  mockSupabaseCalls.signOut = 0
  mockSupabaseCalls.invoked = []
}
