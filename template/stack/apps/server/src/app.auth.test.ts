// The bearer guard is the only thing between the wire and an RLS identity: every /api/*
// handler reads `c.get('userId')` and hands it to the DAL, which binds it to the
// app.user_id GUC. A hole here is not a 401 bug, it is row access. Coverage said this
// middleware was "tested" (one missing-token request walks every line); nothing asserted
// the PARSE. So these pin, separately:
//
//   - the scheme match is `Bearer ` — exact case, and the trailing space is part of it
//     (`bearer x`, `Basic x`, `Bearerx` are all NOT credentials);
//   - the slice offset — the verifier must receive the token VERBATIM, neither truncated
//     nor carrying the scheme's trailing space;
//   - the two rejection messages, distinct on purpose: `missing bearer token` means the
//     request never presented one, `invalid bearer token` means the verifier refused it —
//     and a token the verifier refuses must never reach a handler;
//   - the identity a valid token buys: the handler's userId is what the VERIFIER returned,
//     never anything the wire chose.
import { ApiError } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from './app.js'
import type { NotesDal } from './types.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const VALID_TOKEN = 'valid.jwt.token'

interface Harness {
  readonly options: AppOptions
  /** Every token string handed to the verifier, in order. */
  readonly verified: string[]
  /** Every userId the route handed the DAL — the identity the token actually bought. */
  readonly identities: string[]
}

/**
 * A verifier that accepts exactly ONE token and records what it was handed, plus a DAL
 * that records the identity it was called with. A guard that slices at the wrong offset
 * (or drops the slice) reaches the verifier with a different string than the client sent.
 */
function harness(): Harness {
  const verified: string[] = []
  const identities: string[] = []
  const notesDal: NotesDal = {
    list: (userId) => {
      identities.push(userId)
      return Promise.resolve({ items: [], nextCursor: null })
    },
    create: () => Promise.reject(new Error('not under test')),
    get: () => Promise.resolve(null),
    remove: () => Promise.resolve(false),
  }
  const verifyToken = (token: string): Promise<{ userId: string }> => {
    verified.push(token)
    return token === VALID_TOKEN
      ? Promise.resolve({ userId: USER_ID })
      : Promise.reject(new Error('signature check failed'))
  }
  return { options: { version: '1.2.3', verifyToken, notesDal }, verified, identities }
}

async function expectUnauthorized(res: Response, message: string): Promise<void> {
  expect(res.status).toBe(401)
  const body = ApiError.parse(await res.json())
  expect(body.error.code).toBe('unauthorized')
  expect(body.error.message).toBe(message)
}

// Requests that presented NO credential. Every one must be refused with
// `missing bearer token` AND must never reach the verifier — a guard that fed the raw
// header to the verifier would report a parse failure as a verification failure.
const noCredential: { readonly name: string; readonly headers: Record<string, string> }[] = [
  { name: 'no Authorization header at all', headers: {} },
  { name: 'a non-bearer scheme', headers: { authorization: 'Basic dXNlcjpwYXNz' } },
  { name: 'a lowercase scheme', headers: { authorization: `bearer ${VALID_TOKEN}` } },
  { name: 'no space after the scheme', headers: { authorization: `Bearer${VALID_TOKEN}` } },
  { name: 'the bare word Bearer', headers: { authorization: 'Bearer' } },
  { name: 'Bearer with an EMPTY token', headers: { authorization: 'Bearer ' } },
]

describe('bearer guard: what counts as presenting a token', () => {
  it.each(noCredential)('$name → 401 missing bearer token, verifier never called', async (row) => {
    const { options, verified, identities } = harness()

    const res = await createApp(options).request('/api/notes', { headers: row.headers })

    await expectUnauthorized(res, 'missing bearer token')
    expect(verified).toEqual([]) // the parse refused it — nothing was ever verified
    expect(identities).toEqual([]) // …and no handler ran
  })
})

describe('bearer guard: verification', () => {
  it('hands the verifier the token VERBATIM — right offset, no truncation, no scheme', async () => {
    const { options, verified, identities } = harness()

    const res = await createApp(options).request('/api/notes', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })

    expect(res.status).toBe(200)
    // Exact equality, not a substring: slicing at 0 hands over `Bearer valid.jwt.token`,
    // slicing at 8 hands over `alid.jwt.token`. Both are a silently different credential.
    expect(verified).toEqual([VALID_TOKEN])
    // The handler's identity is the VERIFIED subject — the DAL binds this to app.user_id.
    expect(identities).toEqual([USER_ID])
  })

  it('does NOT repair a space-padded credential — the token is whatever follows `Bearer `', async () => {
    const { options, verified } = harness()

    const res = await createApp(options).request('/api/notes', {
      headers: { authorization: `Bearer  ${VALID_TOKEN}` }, // two spaces
    })

    // The slice starts exactly after `Bearer `, so the second space belongs to the token —
    // and a token that is not byte-identical to a minted one does not verify.
    expect(verified).toEqual([` ${VALID_TOKEN}`])
    await expectUnauthorized(res, 'invalid bearer token')
  })

  it('a token the verifier REJECTS → 401 invalid bearer token, and no handler runs', async () => {
    const { options, verified, identities } = harness()

    const res = await createApp(options).request('/api/notes', {
      headers: { authorization: 'Bearer forged.jwt.token' },
    })

    await expectUnauthorized(res, 'invalid bearer token')
    expect(verified).toEqual(['forged.jwt.token']) // it really reached the verifier
    expect(identities).toEqual([]) // …and stopped there
  })

  it('a rejection never leaks WHY the credential was refused', async () => {
    const base = harness()
    const options: AppOptions = {
      ...base.options,
      verifyToken: () => Promise.reject(new Error('JWKS kid ABC unknown for tenant leak-canary')),
    }

    const res = await createApp(options).request('/api/notes', {
      headers: { authorization: 'Bearer expired.jwt.token' },
    })

    expect(res.status).toBe(401)
    const raw = await res.text()
    expect(raw).not.toContain('leak-canary') // the verifier's own message never reaches the wire
    const body = ApiError.parse(JSON.parse(raw))
    expect(body.error.code).toBe('unauthorized')
    expect(body.error.message).toBe('invalid bearer token')
    expect(base.identities).toEqual([])
  })

  it('guards /api/* only — /healthz stays reachable without a credential', async () => {
    const { options, verified } = harness()

    const res = await createApp(options).request('/healthz')

    expect(res.status).toBe(200)
    expect(verified).toEqual([])
  })
})
