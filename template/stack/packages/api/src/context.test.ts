import type { NotesDatabase } from '@app/notes'
import { describe, expect, it } from 'vitest'
import { createContext, readHeader, type Session } from './context.js'

const SERVER_VERSION = '3.1.4'

// A DB that FAILS if it is ever touched: building a context must not query, and the tests
// below assert on identity, not data. The createClient port hands this back unconditionally.
const db: NotesDatabase = {
  from: () => {
    throw new Error('the database must not be touched while building a context')
  },
}

const SESSION: Session = {
  actor: {
    displayName: 'Rae',
    email: 'rae@example.test',
    userId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
  membership: null,
}

// The resolveSession port as a TRIP-WIRE: every test that expects the token path to be skipped
// wires this in, so "resolveSession did not run" is proven by the absence of a throw, not
// assumed. It is the createContext equivalent of the skew suite's forbiddenDb.
const resolveMustNotRun = (): Promise<Session | null> => {
  throw new Error('resolveSession must not run when a session is injected or no token is present')
}

describe('createContext — identity resolution priority', () => {
  it('an injected session wins over the token path, and resolveSession never runs', async () => {
    const ctx = await createContext({
      // A token is present, so WITHOUT the injection this would resolve via the port (which
      // throws). The injection short-circuits it — the cookie path's whole reason to exist.
      accessToken: 'a-token-the-port-would-otherwise-resolve',
      createClient: () => db,
      headers: {},
      resolveSession: resolveMustNotRun,
      session: SESSION,
      serverVersion: SERVER_VERSION,
    })
    expect(ctx.actor).toEqual(SESSION.actor)
    expect(ctx.membership).toBeNull()
  })

  it('an injected null session is anonymous — and still skips resolveSession', async () => {
    // `null` is a first-class injected value ("the host looked and found no verified caller"),
    // distinct from omitting the field. It must NOT fall through to the token path.
    const ctx = await createContext({
      accessToken: 'a-token',
      createClient: () => db,
      headers: {},
      resolveSession: resolveMustNotRun,
      session: null,
      serverVersion: SERVER_VERSION,
    })
    expect(ctx.actor).toBeNull()
    expect(ctx.membership).toBeNull()
  })

  it('with NO session field and a token, the resolveSession port IS used', async () => {
    const ctx = await createContext({
      accessToken: 'a-token',
      createClient: () => db,
      headers: {},
      resolveSession: () => Promise.resolve(SESSION),
      serverVersion: SERVER_VERSION,
    })
    expect(ctx.actor).toEqual(SESSION.actor)
    expect(ctx.membership).toBeNull()
  })

  it('with no session field and no token, no resolveSession round trip happens', async () => {
    const ctx = await createContext({
      createClient: () => db,
      headers: {},
      resolveSession: resolveMustNotRun,
      serverVersion: SERVER_VERSION,
    })
    expect(ctx.actor).toBeNull()
  })
})

describe('readHeader — the case-insensitive reader the CSRF guard reuses', () => {
  it('reads a Headers instance case-insensitively', () => {
    expect(readHeader(new Headers({ 'X-Test': 'v' }), 'x-test')).toBe('v')
  })

  it('reads a plain lowercased record case-insensitively', () => {
    expect(readHeader({ 'X-Test': 'v' }, 'x-test')).toBe('v')
  })

  it('returns only the first value of a repeated header', () => {
    // A joined string is a shape no downstream parser expects; one value is chosen deliberately.
    expect(readHeader({ 'x-test': ['a', 'b'] }, 'x-test')).toBe('a')
  })

  it('returns null for an absent header, from either source shape', () => {
    expect(readHeader({}, 'x-missing')).toBeNull()
    expect(readHeader(new Headers(), 'x-missing')).toBeNull()
  })
})
