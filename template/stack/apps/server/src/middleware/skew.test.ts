import { ApiError } from '@app/contracts'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from '../app.js'
import { requestId } from '../errors.js'
import type { AppEnv, NotesDal } from '../types.js'
import { createSkewMiddleware, isSkewMiddleware } from './skew.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'

const emptyDal: NotesDal = {
  list: () => Promise.resolve({ items: [], nextCursor: null }),
  create: () => Promise.reject(new Error('not under test')),
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve(false),
}

const options: AppOptions = {
  version: '1.2.3',
  verifyToken: () => Promise.resolve({ userId: USER_ID }),
  notesDal: emptyDal,
}

const authed = { authorization: 'Bearer test-token' }

const SERVER_VERSION = '1.2.3'

/**
 * The gate in isolation: only `requestId` (the error envelope reads it) sits in
 * front of the skew middleware, so a probe measures THIS middleware and nothing
 * else — no auth, no CORS, no body limit.
 *
 * Everything is built inside the probe, i.e. inside the `it` body that calls it.
 * A construction-time throw must FAIL a test; a throw from `beforeAll` would only
 * ever be reported as SKIPPED, which a mutation run reads as "mutant survived".
 */
async function probe(serverVersion: string, clientVersion?: string) {
  const runs = { handler: 0 }
  const app = new Hono<AppEnv>()
  app.use(requestId)
  app.use('*', createSkewMiddleware(serverVersion))
  app.get('/', (c) => {
    runs.handler += 1
    return c.json({ ok: true }, 200)
  })
  const headers = clientVersion === undefined ? {} : { 'x-client-version': clientVersion }
  const res = await app.request('/', { headers })
  return { res, runs }
}

// Each row pins one alternation/anchor of the version regex `/^\s*v?(\d+)(?:\.|$)/`
// against a server on major 1: a 200 proves the string parsed to exactly 1, a 409
// proves it either failed to parse or parsed to something else.
const clientVersionCases = [
  { clientVersion: '1.2.3', status: 200, pins: 'a plain matching semver passes' },
  { clientVersion: 'v1.2.3', status: 200, pins: 'the optional v prefix parses (v?)' },
  { clientVersion: '1', status: 200, pins: 'a bare major with no dot parses (the $ branch)' },
  { clientVersion: '1.0.0-rc.1', status: 200, pins: 'a prerelease keeps its major' },
  { clientVersion: 'x1.2.3', status: 409, pins: 'the digits must be anchored at the start (^)' },
  { clientVersion: 'v 1.2.3', status: 409, pins: 'v must abut the digits' },
  { clientVersion: 'abc', status: 409, pins: 'a non-numeric version does not parse' },
  { clientVersion: '.1.2', status: 409, pins: 'a leading dot does not parse' },
  { clientVersion: '2.0.0', status: 409, pins: 'a different major is skew' },
  { clientVersion: '10.0.0', status: 409, pins: 'a multi-digit different major is skew' },
] as const

// Server versions that MUST parse. `same` shares the server's major (must pass),
// `other` does not (must 409) — together they prove the parsed number, not merely
// that a match occurred.
const serverVersionCases = [
  { serverVersion: '1.2.3', same: '1.9.9', other: '2.0.0', pins: 'plain semver' },
  { serverVersion: '  1.2.3', same: '1.0.0', other: '2.0.0', pins: 'leading whitespace (\\s*)' },
  { serverVersion: 'v1.2.3', same: '1.0.0', other: '2.0.0', pins: 'the v prefix (v?)' },
  { serverVersion: '1', same: '1.4.0', other: '2.0.0', pins: 'a bare major (the $ branch)' },
  { serverVersion: '12.4.0', same: '12.0.1', other: '1.0.0', pins: 'a multi-digit major (\\d+)' },
  { serverVersion: '10', same: '10.2.0', other: '1.0.0', pins: 'a bare multi-digit major' },
] as const

// Server versions that MUST be rejected at construction: a server whose own
// version cannot be parsed has no major to compare against, so the gate would be
// silently inert. It must fail loudly at wiring time instead.
const unparseableVersions = ['not-a-version', 'abc', 'x1.2.3', '', 'v', '.1', 'v.1.0'] as const

describe('version-skew middleware', () => {
  it('passes a client on the same major', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { ...authed, 'x-client-version': '1.0.0' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ items: [], nextCursor: null })
  })

  it('rejects a major mismatch with a 409 version_skew envelope', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { ...authed, 'x-client-version': '2.0.0' },
    })
    expect(res.status).toBe(409)
    const body = ApiError.parse(await res.json())
    expect(body.error.code).toBe('version_skew')
  })

  it('rejects an unparsable client version', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { ...authed, 'x-client-version': 'not-a-version' },
    })
    expect(res.status).toBe(409)
  })

  it('passes requests without the header (curl/tooling; the mobile client always sends it)', async () => {
    const res = await createApp(options).request('/api/notes', { headers: authed })
    expect(res.status).toBe(200)
  })

  it('requires auth on /api/* even when the version matches', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { 'x-client-version': '1.0.0' },
    })
    expect(res.status).toBe(401)
    const body = ApiError.parse(await res.json())
    expect(body.error.code).toBe('unauthorized')
  })

  it('exempts /healthz from both the skew gate and auth', async () => {
    const res = await createApp(options).request('/healthz', {
      headers: { 'x-client-version': '9.9.9' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, version: '1.2.3' })
  })
})

describe('client version parsing (each row pins one branch of the version regex)', () => {
  it.each(clientVersionCases)('a client on $clientVersion gets $status — $pins', async ({
    clientVersion,
    status,
  }) => {
    const { res, runs } = await probe(SERVER_VERSION, clientVersion)
    expect(res.status).toBe(status)
    // A 409 must SHORT-CIRCUIT: the downstream handler never runs.
    expect(runs.handler).toBe(status === 200 ? 1 : 0)
  })

  it('rejects an empty client version header', async () => {
    const { res, runs } = await probe(SERVER_VERSION, '')
    expect(res.status).toBe(409)
    expect(runs.handler).toBe(0)
  })

  it('passes a request with NO x-client-version header and reaches the handler', async () => {
    const { res, runs } = await probe(SERVER_VERSION)
    expect(res.status).toBe(200)
    expect(runs.handler).toBe(1)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })
})

describe('the 409 envelope', () => {
  it('carries the stable machine-readable code version_skew on a major mismatch', async () => {
    const { res, runs } = await probe(SERVER_VERSION, '2.0.0')
    expect(res.status).toBe(409)
    const body = ApiError.parse(await res.json())
    expect(body.error.code).toBe('version_skew')
    expect(body.error.message).toBe('client major version does not match the server')
    expect(runs.handler).toBe(0)
  })

  it('carries the same code when the client version cannot be parsed at all', async () => {
    const { res, runs } = await probe(SERVER_VERSION, 'not-a-version')
    expect(res.status).toBe(409)
    const body = ApiError.parse(await res.json())
    expect(body.error.code).toBe('version_skew')
    expect(runs.handler).toBe(0)
  })
})

describe('server version parsing (construction)', () => {
  it.each(serverVersionCases)('accepts the server version $serverVersion — $pins', async ({
    serverVersion,
    same,
    other,
  }) => {
    expect(() => createSkewMiddleware(serverVersion)).not.toThrow()

    const matched = await probe(serverVersion, same)
    expect(matched.res.status).toBe(200)
    expect(matched.runs.handler).toBe(1)

    const skewed = await probe(serverVersion, other)
    expect(skewed.res.status).toBe(409)
    expect(skewed.runs.handler).toBe(0)
  })

  it.each(
    unparseableVersions,
  )('throws at construction on the unparseable server version %j', (serverVersion) => {
    expect(() => createSkewMiddleware(serverVersion)).toThrow(
      `cannot parse server version for skew detection: ${serverVersion}`,
    )
  })

  it('names the offending version in the construction error', () => {
    expect(() => createSkewMiddleware('nope')).toThrow(Error)
    expect(() => createSkewMiddleware('nope')).toThrow(/cannot parse server version/)
    expect(() => createSkewMiddleware('nope')).toThrow(/nope/)
  })
})

describe('isSkewMiddleware', () => {
  it('is true for every middleware minted by createSkewMiddleware', () => {
    expect(isSkewMiddleware(createSkewMiddleware('1.2.3'))).toBe(true)
    expect(isSkewMiddleware(createSkewMiddleware('12.0.0'))).toBe(true)
  })

  it('is false for an arbitrary function', () => {
    const impostor = (): string => 'not the skew guard'
    expect(isSkewMiddleware(impostor)).toBe(false)
    expect(isSkewMiddleware(createSkewMiddleware)).toBe(false)
    expect(isSkewMiddleware(isSkewMiddleware)).toBe(false)
  })

  it.each([
    undefined,
    null,
    'skewGuard',
    0,
    1,
    {},
    [],
    Symbol('skew'),
  ])('is false for the non-function value %j', (value: unknown) => {
    expect(isSkewMiddleware(value)).toBe(false)
  })
})

describe('route coverage (walks the real route table — new /api routes cannot dodge the gate)', () => {
  it('covers every registered /api/* route with the skew middleware', () => {
    const app = createApp(options)
    const skewPrefixes = app.routes
      .filter((route) => isSkewMiddleware(route.handler))
      .map((route) => route.path)
    expect(skewPrefixes.length).toBeGreaterThan(0)

    const apiRoutes = app.routes.filter(
      (route) => route.method !== 'ALL' && route.path.startsWith('/api/'),
    )
    // Non-vacuous: notes CRUD (4) + SSE demo (1) must all be present.
    const distinct = new Set(apiRoutes.map((route) => `${route.method} ${route.path}`))
    expect(distinct.size).toBeGreaterThanOrEqual(5)

    for (const route of apiRoutes) {
      const covered = skewPrefixes.some(
        (prefix) => prefix.endsWith('/*') && route.path.startsWith(prefix.slice(0, -1)),
      )
      expect(covered, `${route.method} ${route.path} must sit behind the skew middleware`).toBe(
        true,
      )
    }
  })

  it('leaves /healthz outside the skew middleware', () => {
    const app = createApp(options)
    const skewPrefixes = app.routes
      .filter((route) => isSkewMiddleware(route.handler))
      .map((route) => route.path)
    const healthCovered = skewPrefixes.some(
      (prefix) => prefix.endsWith('/*') && '/healthz'.startsWith(prefix.slice(0, -1)),
    )
    expect(healthCovered).toBe(false)
  })
})
