import { ORG_ID_HEADER } from '@app/contracts'
import type { NotesDatabase } from '@app/notes'
import { describe, expect, it, vi } from 'vitest'
import { createContext, type Session } from './context.js'
import { appRouter } from './index.js'
import { isRateLimitedError, RATE_LIMITED_CODE, RateLimitedError } from './ratelimit.js'
import { createCallerFactory } from './trpc.js'

const SERVER_VERSION = '1.2.3'
const ORG_ID = '2f1c1d3a-0000-4000-8000-000000000001'

const SESSION: Session = {
  actor: {
    displayName: 'Sam',
    email: 'sam@example.test',
    userId: '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e',
  },
  orgs: [{ id: ORG_ID, name: 'Acme', role: 'owner', slug: 'acme' }],
}

/**
 * A database that FAILS if it is ever touched.
 *
 * This is the whole assertion of the file, not a fixture detail. A rate limit that lets
 * the handler run and then reports the refusal has bought nothing — the transaction, the
 * audit row and the quota check are already paid for. "The handler did not run" has to be
 * provable, and this is what proves it.
 */
const forbiddenDb: NotesDatabase = {
  from: () => {
    throw new Error('a rate-limited request must be rejected before any handler runs')
  },
}

function callerWith(rateLimit: Parameters<typeof createContext>[0]['rateLimit']) {
  return createContext({
    createClient: () => forbiddenDb,
    headers: { authorization: 'Bearer test-token', [ORG_ID_HEADER]: ORG_ID },
    now: () => '2026-06-01T12:00:00.000Z',
    ...(rateLimit === undefined ? {} : { rateLimit }),
    resolveSession: () => Promise.resolve(SESSION),
    serverVersion: SERVER_VERSION,
  }).then((ctx) => createCallerFactory(appRouter)(ctx))
}

describe('the rate-limit guard', () => {
  it('refuses BEFORE the handler runs, with a 429 the clients already understand', async () => {
    const caller = await callerWith(() =>
      Promise.resolve({ allowed: false, retryAfterSeconds: 42 }),
    )
    // The MESSAGE as well as the code: the mutation lane found the message string alive,
    // and it is what a human reads in a trace when the machine-readable code has already
    // been swallowed by a logging layer.
    await expect(caller.system.health()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'rate limit exceeded',
    })
  })

  it('carries the wait on the CAUSE, so the error formatter can put it on the wire', async () => {
    const caller = await callerWith(() =>
      Promise.resolve({ allowed: false, retryAfterSeconds: 42 }),
    )
    // A bag with a `retryAfterSeconds` field would satisfy a duck-typed read; the cause is
    // a class so the formatter's check cannot be satisfied by an unrelated error that
    // happens to carry the same field name.
    // `expect.any()` is typed `any`, and an `any` inside a matcher object is exactly the
    // unsafe assignment the strict lint set refuses. The `instanceof` assertion below is
    // stronger anyway — it names the class rather than describing it — so the matcher
    // arm is not worth an escape hatch.
    try {
      await caller.system.health()
      expect.unreachable('the guard must throw')
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause
      expect(isRateLimitedError(cause)).toBe(true)
      expect((cause as RateLimitedError).retryAfterSeconds).toBe(42)
    }
  })

  it('an ALLOWED verdict lets the request through', async () => {
    const caller = await callerWith(() => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }))
    await expect(caller.system.health()).resolves.toEqual({ ok: true, version: SERVER_VERSION })
  })

  it('a NULL verdict — a deliberately unlimited procedure — lets the request through', async () => {
    // Distinct from `{ allowed: true }` on purpose: an exemption and a healthy hit must
    // stay distinguishable in everything downstream, so the router accepts both.
    const caller = await callerWith(() => Promise.resolve(null))
    await expect(caller.system.health()).resolves.toEqual({ ok: true, version: SERVER_VERSION })
  })

  it('NO port at all means an unlimited router — a worker and a test wire none', async () => {
    const caller = await callerWith(undefined)
    await expect(caller.system.health()).resolves.toEqual({ ok: true, version: SERVER_VERSION })
  })

  it('asks with the procedure PATH and the resolved identity, never a header-supplied org', async () => {
    const port = vi.fn(() => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }))
    const caller = await callerWith(port)
    await caller.system.health()
    expect(port).toHaveBeenCalledWith({
      // The ACTIVE org, resolved from the caller's real seats. If this were read from the
      // x-org-id header, a stranger could spend a tenant's budget by naming it.
      orgId: ORG_ID,
      path: 'system.health',
      userId: SESSION.actor.userId,
    })
  })

  it('reports a null identity for an anonymous caller rather than inventing one', async () => {
    const port = vi.fn(() => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }))
    const ctx = await createContext({
      createClient: () => forbiddenDb,
      headers: {},
      now: () => '2026-06-01T12:00:00.000Z',
      rateLimit: port,
      serverVersion: SERVER_VERSION,
    })
    await createCallerFactory(appRouter)(ctx).system.health()
    expect(port).toHaveBeenCalledWith({ orgId: null, path: 'system.health', userId: null })
  })

  it('runs on EVERY rung — the guard is on the base of the ladder, not on one procedure', async () => {
    // The structural property: there is no route table to walk and therefore no procedure
    // that can be added without the guard. `notes.list` is three rungs above the base.
    const port = vi.fn(() => Promise.resolve({ allowed: false, retryAfterSeconds: 7 }))
    const caller = await callerWith(port)
    await expect(caller.notes.list({ limit: 10 })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
    expect(port).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes.list' }))
  })
})

describe('the transport code', () => {
  it('is the contract constant, spelled once', () => {
    expect(RATE_LIMITED_CODE).toBe('rate_limited')
  })

  it('isRateLimitedError refuses a look-alike', () => {
    expect(isRateLimitedError(new RateLimitedError(1))).toBe(true)
    expect(isRateLimitedError({ retryAfterSeconds: 1 })).toBe(false)
    expect(isRateLimitedError(new Error('rate limit exceeded'))).toBe(false)
    expect(isRateLimitedError(null)).toBe(false)
  })
})

// --- the error class's own identity -----------------------------------------
//
// The mutation lane found both of these alive: the message template and the `name`
// assignment. They are not cosmetic. `name` is what a log aggregator groups on, and the
// message is the only place the wait appears for a human reading a trace — the machine-
// readable copy travels as `retryAfterSeconds` in the transport data, which the
// integration lane asserts over the wire.
describe('RateLimitedError carries its own identity', () => {
  it('names itself and states the wait in the message', () => {
    const err = new RateLimitedError(42)
    expect(err.name).toBe('RateLimitedError')
    expect(err.message).toContain('42')
    expect(err.message).not.toBe('')
    expect(err.retryAfterSeconds).toBe(42)
  })
})
