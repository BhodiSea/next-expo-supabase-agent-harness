// The doctrine under test: server-side identity comes from a VERIFIED call.
// The port these fakes implement has no `getSession` member at all, so a test
// cannot accidentally exercise the forbidden path — which is the point of
// declaring the port narrowly rather than typing against the whole client.
import { describe, expect, it, vi } from 'vitest'
import { getVerifiedUser, getVerifiedUserId, type VerifiedIdentitySource } from './verify.js'

type UserResult = Awaited<ReturnType<VerifiedIdentitySource['auth']['getUser']>>

function fakeClient(result: UserResult): VerifiedIdentitySource & {
  readonly calls: readonly (string | undefined)[]
} {
  const calls: (string | undefined)[] = []
  return {
    auth: {
      getUser: (jwt?: string) => {
        calls.push(jwt)
        return Promise.resolve(result)
      },
    },
    calls,
  }
}

const SIGNED_IN: UserResult = {
  data: { user: { email: 'person@example.test', id: 'user-1' } },
  error: null,
}

describe('getVerifiedUser', () => {
  it('returns the verified identity', async () => {
    expect(await getVerifiedUser(fakeClient(SIGNED_IN))).toEqual({
      email: 'person@example.test',
      userId: 'user-1',
    })
  })

  it('normalises an absent email to null rather than leaving it undefined', async () => {
    const anonymousSignIn: UserResult = { data: { user: { id: 'user-2' } }, error: null }
    expect(await getVerifiedUser(fakeClient(anonymousSignIn))).toEqual({
      email: null,
      userId: 'user-2',
    })
  })

  it('returns null for an anonymous caller instead of throwing', async () => {
    // "Not signed in" arrives on every anonymous request. Throwing would make
    // the common path an exception path and invite a catch that swallows a real
    // failure alongside it.
    const anonymous: UserResult = { data: { user: null }, error: null }
    expect(await getVerifiedUser(fakeClient(anonymous))).toBeNull()
  })

  it('returns null when verification FAILED — never a partial identity', async () => {
    // A forged or expired token must produce no identity at all. Falling back
    // to whatever `data` happens to hold is how an unverified `sub` reaches a
    // query and every policy downstream becomes decorative.
    const rejected: UserResult = {
      data: { user: { id: 'attacker-supplied' } },
      error: { message: 'invalid claim: missing sub' },
    }
    expect(await getVerifiedUser(fakeClient(rejected))).toBeNull()
  })

  it('forwards an explicit token — the bearer client has no stored session', async () => {
    // createBearerSupabaseClient sets persistSession: false, so a no-argument
    // getUser() has nothing to read and would answer null for a valid caller.
    const client = fakeClient(SIGNED_IN)
    await getVerifiedUser(client, 'access-token-value')
    expect(client.calls).toEqual(['access-token-value'])
  })

  it('passes nothing when no token is supplied — the cookie client reads its jar', async () => {
    const client = fakeClient(SIGNED_IN)
    await getVerifiedUser(client)
    expect(client.calls).toEqual([undefined])
  })
})

describe('getVerifiedUserId', () => {
  it('narrows to the one field a query needs to scope itself', async () => {
    expect(await getVerifiedUserId(fakeClient(SIGNED_IN))).toBe('user-1')
  })

  it('is null wherever getVerifiedUser is null', async () => {
    const anonymous: UserResult = { data: { user: null }, error: null }
    expect(await getVerifiedUserId(fakeClient(anonymous))).toBeNull()
  })
})

describe('the port shape', () => {
  it('describes getUser and nothing else — getSession is not reachable from it', () => {
    // Structural, not behavioural: an implementation of this port is a fake
    // that CANNOT answer a getSession call, so a future refactor that reached
    // for one would fail to compile against every existing test double.
    const spy = vi.fn<(jwt?: string) => Promise<UserResult>>(() => Promise.resolve(SIGNED_IN))
    const client: VerifiedIdentitySource = { auth: { getUser: spy } }
    expect(Object.keys(client.auth)).toEqual(['getUser'])
  })
})
