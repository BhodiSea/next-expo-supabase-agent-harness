// POST /auth/dev-token — the stub-mode mint route. What must hold, per mode:
//
//   stub  — a minted token passes the REAL verifier end-to-end: the route writes
//           the public key into the stub JWKS, requireAuth verifies against that
//           same file, and the /api handler receives the minted identity.
//   entra — the route DOES NOT EXIST (404 envelope), so no deployment fact can
//           expose a credential mint next to a real IdP. (Production exposure is
//           already impossible one layer deeper: assertAuthBootSafety makes
//           NODE_ENV=production + stub a boot fatal — see src/auth/verify.ts.)
//
// The route is wired through AppOptions.authMode/devJwksPath so both modes run
// here without touching process.env or the repo working tree.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from './app.js'
import { createTokenVerifier } from './auth/verify.js'
import type { NotesDal } from './types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Harness {
  readonly options: AppOptions
  /** Every userId the list route handed the DAL — the identity a token bought. */
  readonly identities: string[]
}

/** An app in the given auth mode whose verifier reads THIS test's JWKS file. */
async function harness(authMode: 'stub' | 'entra'): Promise<Harness> {
  const jwksPath = join(await mkdtemp(join(tmpdir(), 'dev-token-test-')), 'jwks.json')
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
  return {
    options: {
      version: '1.2.3',
      notesDal,
      authMode,
      devJwksPath: jwksPath,
      // The REAL stub verifier, pointed at the same JWKS the route writes —
      // this is the end-to-end seam, not a fake.
      verifyToken: createTokenVerifier({ AUTH_MODE: 'stub', DEV_JWKS_PATH: jwksPath }),
    },
    identities,
  }
}

const mintRequest = (body?: string): RequestInit =>
  body === undefined
    ? { method: 'POST' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body }

describe('stub mode: minting', () => {
  it('mints 201 {token, userId} with a FRESH uuid when no sub is given', async () => {
    const { options } = await harness('stub')

    const res = await createApp(options).request('/auth/dev-token', mintRequest())

    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; userId: string }
    expect(body.token.split('.')).toHaveLength(3) // a compact JWS, not an opaque blob
    expect(body.userId).toMatch(UUID_RE)
  })

  it('honors a caller-chosen sub', async () => {
    const { options } = await harness('stub')
    const sub = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'

    const res = await createApp(options).request(
      '/auth/dev-token',
      mintRequest(JSON.stringify({ sub })),
    )

    expect(res.status).toBe(201)
    expect(((await res.json()) as { userId: string }).userId).toBe(sub)
  })

  it('a minted token passes requireAuth END-TO-END and buys exactly the minted identity', async () => {
    const { options, identities } = await harness('stub')
    const app = createApp(options)

    const mint = await app.request('/auth/dev-token', mintRequest())
    expect(mint.status).toBe(201)
    const { token, userId } = (await mint.json()) as { token: string; userId: string }

    const res = await app.request('/api/notes', {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    // The identity the handler saw is what the VERIFIER extracted from the
    // minted token — the whole mint→verify→RLS-identity chain, no fakes.
    expect(identities).toEqual([userId])
  })

  it('sits OUTSIDE the skew guard — a skewed client can still fetch a dev token', async () => {
    const { options } = await harness('stub')

    const res = await createApp(options).request('/auth/dev-token', {
      method: 'POST',
      headers: { 'x-client-version': '9.9.9' }, // would 409 on any /api/* route
    })

    expect(res.status).toBe(201)
  })
})

describe('stub mode: input validation', () => {
  it('rejects a non-uuid sub with a 400 envelope', async () => {
    const { options } = await harness('stub')

    const res = await createApp(options).request(
      '/auth/dev-token',
      mintRequest(JSON.stringify({ sub: 'admin' })),
    )

    expect(res.status).toBe(400)
    expect(ApiError.parse(await res.json()).error.code).toBe('bad_request')
  })

  it('rejects a body that is not JSON with a 400 envelope', async () => {
    const { options } = await harness('stub')

    const res = await createApp(options).request('/auth/dev-token', mintRequest('not json {'))

    expect(res.status).toBe(400)
    expect(ApiError.parse(await res.json()).error.code).toBe('bad_request')
  })
})

describe('entra mode: the route must not exist', () => {
  it('404s with the envelope — a real-IdP deployment has no credential mint', async () => {
    const { options } = await harness('entra')

    const res = await createApp(options).request('/auth/dev-token', mintRequest())

    expect(res.status).toBe(404)
    expect(ApiError.parse(await res.json()).error.code).toBe('not_found')
  })
})
