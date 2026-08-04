import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryRateLimiter,
  createRateLimiter,
  createUpstashRateLimiter,
  type RateLimitBucket,
  rateLimitKey,
  withFailOpen,
} from './index.js'

const BUCKET: RateLimitBucket = { limit: 3, name: 'write', windowSeconds: 60 }

/** A clock the test drives, so a sliding window can be exercised without sleeping. */
function fakeClock(start = 1_000_000) {
  let t = start
  return { advance: (ms: number) => (t += ms), now: () => t }
}

describe('rateLimitKey', () => {
  it('prefers a verified identity over a host-supplied one', () => {
    // The property that matters: the rungs are not interchangeable. A caller who can
    // choose their clientKey must not be able to land on someone else's userId bucket.
    expect(rateLimitKey({ bucket: 'write', clientKey: '1.2.3.4', userId: 'user-1' })).toBe(
      'rl:write:u:user-1:o:-',
    )
    expect(rateLimitKey({ bucket: 'write', clientKey: '1.2.3.4' })).toBe('rl:write:c:1.2.3.4:o:-')
    expect(rateLimitKey({ bucket: 'write' })).toBe('rl:write:anon:o:-')
  })

  it('treats the org as a SECOND dimension, never a fallback identity', () => {
    // A stranger who guesses an org id must not be able to spend that org's budget: with
    // no identity the key still falls back to `anon`, and the org only narrows it.
    expect(rateLimitKey({ bucket: 'write', orgId: 'org-1', userId: 'user-1' })).toBe(
      'rl:write:u:user-1:o:org-1',
    )
    expect(rateLimitKey({ bucket: 'write', orgId: 'org-1' })).toBe('rl:write:anon:o:org-1')
  })

  it('treats empty strings as absent', () => {
    // `??` alone would accept '' as an identity and give every caller with a blank
    // header the same private bucket — a shared bucket that reads like a private one.
    expect(rateLimitKey({ bucket: 'read', clientKey: '', orgId: '', userId: '' })).toBe(
      'rl:read:anon:o:-',
    )
  })
})

describe('the in-process limiter', () => {
  it('allows up to the limit and denies past it', async () => {
    const limiter = createMemoryRateLimiter({ now: fakeClock().now })
    for (let i = 0; i < 3; i += 1) {
      const d = await limiter.limit('k', BUCKET)
      expect(d.allowed, `hit ${String(i + 1)} is within the budget`).toBe(true)
      expect(d.remaining).toBe(2 - i)
    }
    const denied = await limiter.limit('k', BUCKET)
    expect(denied.allowed).toBe(false)
    expect(denied.remaining).toBe(0)
    expect(denied.degraded).toBe(false)
  })

  it('the window SLIDES — it is not a fixed bucket that resets on a boundary', async () => {
    const clock = fakeClock()
    const limiter = createMemoryRateLimiter({ now: clock.now })
    for (let i = 0; i < 3; i += 1) await limiter.limit('k', BUCKET)
    expect((await limiter.limit('k', BUCKET)).allowed).toBe(false)

    // Just short of the first hit expiring: still denied. A fixed-window implementation
    // would already have reset here, which is the bug this case exists to catch.
    clock.advance(59_000)
    expect((await limiter.limit('k', BUCKET)).allowed).toBe(false)

    clock.advance(61_000)
    expect((await limiter.limit('k', BUCKET)).allowed).toBe(true)
  })

  it('reports whole seconds until a slot frees, never 0 while denied', async () => {
    const clock = fakeClock()
    const limiter = createMemoryRateLimiter({ now: clock.now })
    for (let i = 0; i < 3; i += 1) await limiter.limit('k', BUCKET)
    clock.advance(30_000)
    const denied = await limiter.limit('k', BUCKET)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBe(30)
    // A `retryAfterSeconds: 0` on a denial tells a client to retry immediately, which is
    // how a limiter turns one abusive caller into a hot loop.
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('keys are independent', async () => {
    const limiter = createMemoryRateLimiter({ now: fakeClock().now })
    for (let i = 0; i < 3; i += 1) await limiter.limit('a', BUCKET)
    expect((await limiter.limit('a', BUCKET)).allowed).toBe(false)
    expect((await limiter.limit('b', BUCKET)).allowed).toBe(true)
  })

  it('bounds its own memory — distinct keys are attacker-influenced', async () => {
    // Without the cap this Map is a slow OOM wearing a security control's name: one key
    // per anonymous client, retained for a window nobody bounds.
    const limiter = createMemoryRateLimiter({ maxKeys: 2, now: fakeClock().now })
    await limiter.limit('a', BUCKET)
    await limiter.limit('b', BUCKET)
    await limiter.limit('c', BUCKET)
    // 'a' was evicted, so it starts from zero — the fail-open the eviction implies.
    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.limit('a', BUCKET)).allowed).toBe(true)
    }
  })
})

describe('fail-open', () => {
  it('an unavailable backend ALLOWS the request and marks the decision degraded', async () => {
    const onUnavailable = vi.fn()
    const limiter = withFailOpen(
      {
        limit: () => Promise.reject(new Error('ECONNREFUSED')),
      },
      onUnavailable,
    )
    const d = await limiter.limit('k', BUCKET)
    expect(d.allowed).toBe(true)
    // The whole point of the flag: "allowed because within budget" and "allowed because
    // nothing was counting" are indistinguishable without it.
    expect(d.degraded).toBe(true)
    expect(onUnavailable).toHaveBeenCalledOnce()
  })

  it('a synchronous throw inside the adapter is caught too', async () => {
    const onUnavailable = vi.fn()
    const limiter = withFailOpen(
      {
        limit: () => {
          throw new Error('boom')
        },
      },
      onUnavailable,
    )
    expect((await limiter.limit('k', BUCKET)).degraded).toBe(true)
    expect(onUnavailable).toHaveBeenCalledOnce()
  })

  it('a healthy decision passes through untouched', async () => {
    const limiter = withFailOpen(createMemoryRateLimiter({ now: fakeClock().now }), vi.fn())
    expect(await limiter.limit('k', BUCKET)).toMatchObject({ allowed: true, degraded: false })
  })
})

/** A fetch stub shaped like the Upstash pipeline reply. */
function upstashFetch(replies: unknown[], { ok = true, status = 200 } = {}) {
  const calls: { body: unknown; url: string }[] = []
  const stub = vi.fn((url: string, init?: { body?: string }) => {
    calls.push({ body: JSON.parse(init?.body ?? '[]'), url })
    return Promise.resolve({
      json: () => Promise.resolve(replies),
      ok,
      status,
    })
  })
  vi.stubGlobal('fetch', stub)
  vi.stubGlobal('AbortSignal', { timeout: () => 'signal' })
  return calls
}

describe('the Upstash adapter', () => {
  it('sends the five sliding-window commands in the order that IS the algorithm', async () => {
    const calls = upstashFetch([
      { result: 0 },
      { result: 1 },
      { result: 2 },
      { result: [] },
      { result: 1 },
    ])
    const limiter = createUpstashRateLimiter({ token: 't', url: 'https://redis.test/' })
    await limiter.limit('rl:write:u:1:o:-', BUCKET)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('unreachable: asserted above')
    // The trailing slash on the configured url must not become a double slash: Upstash
    // answers 404 for `//pipeline`, which fail-open would then hide as a degraded allow.
    expect(call.url).toBe('https://redis.test/pipeline')
    const commands = call.body as string[][]
    expect(commands.map((c) => c[0])).toEqual([
      'ZREMRANGEBYSCORE',
      'ZADD',
      'ZCARD',
      'ZRANGE',
      'PEXPIRE',
    ])
    // PEXPIRE is what stops an idle key leaking a Redis slot forever.
    expect(commands[4]?.[2]).toBe('60000')
  })

  it('denies when the window count exceeds the budget, and derives retry-after from the oldest score', async () => {
    const at = Date.now()
    upstashFetch([
      { result: 0 },
      { result: 1 },
      { result: 4 },
      { result: ['m', String(at - 30_000)] },
      { result: 1 },
    ])
    const limiter = createUpstashRateLimiter({ token: 't', url: 'https://redis.test' })
    const d = await limiter.limit('k', BUCKET)
    expect(d.allowed).toBe(false)
    expect(d.remaining).toBe(0)
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(29)
    expect(d.retryAfterSeconds).toBeLessThanOrEqual(31)
  })

  it('falls back to the whole window rather than emitting NaN seconds', async () => {
    // A missing oldest score is a real reply shape (the key expired between commands).
    // `NaN` on the wire becomes a `Retry-After: NaN` header and a client that never
    // retries, so the safe over-estimate is the only honest answer.
    upstashFetch([{ result: 0 }, { result: 1 }, { result: 9 }, { result: null }, { result: 1 }])
    const limiter = createUpstashRateLimiter({ token: 't', url: 'https://redis.test' })
    const d = await limiter.limit('k', BUCKET)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterSeconds).toBe(60)
  })

  it('THROWS on a non-2xx or unparseable reply — it does not silently allow', async () => {
    // The adapter must not swallow its own failures: fail-open is one reviewable seam
    // (withFailOpen), and an adapter that returned `allowed: true` here would make the
    // outage invisible to the very flag that exists to report it.
    upstashFetch([], { ok: false, status: 500 })
    const limiter = createUpstashRateLimiter({ token: 't', url: 'https://redis.test' })
    await expect(limiter.limit('k', BUCKET)).rejects.toThrow('responded 500')

    upstashFetch([{ result: 0 }, { result: 1 }, { result: 'not-a-number' }])
    await expect(limiter.limit('k', BUCKET)).rejects.toThrow('non-numeric ZCARD')

    vi.stubGlobal('fetch', () =>
      Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 }),
    )
    await expect(limiter.limit('k', BUCKET)).rejects.toThrow('non-array body')
  })
})

describe('createRateLimiter', () => {
  it('uses Upstash when both credentials are present', async () => {
    const calls = upstashFetch([
      { result: 0 },
      { result: 1 },
      { result: 1 },
      { result: [] },
      { result: 1 },
    ])
    const onMemoryFallback = vi.fn()
    const limiter = createRateLimiter({
      onMemoryFallback,
      onUnavailable: vi.fn(),
      upstashToken: 't',
      upstashUrl: 'https://redis.test',
    })
    await limiter.limit('k', BUCKET)
    expect(calls).toHaveLength(1)
    expect(onMemoryFallback).not.toHaveBeenCalled()
  })

  it('falls back to the in-process limiter LOUDLY when either credential is missing', () => {
    // Silent is the failure mode that matters: a production deploy that lost its Redis
    // env var keeps serving, counts one instance out of twelve, and looks identical to a
    // healthy one on every dashboard.
    for (const creds of [
      { upstashToken: 't', upstashUrl: undefined },
      { upstashToken: undefined, upstashUrl: 'https://redis.test' },
      { upstashToken: '', upstashUrl: '' },
    ]) {
      const onMemoryFallback = vi.fn()
      createRateLimiter({ onMemoryFallback, onUnavailable: vi.fn(), ...creds })
      expect(onMemoryFallback).toHaveBeenCalledOnce()
    }
  })

  it('is fail-open whichever adapter it chose — a host cannot opt into failing closed', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    vi.stubGlobal('AbortSignal', { timeout: () => 'signal' })
    const onUnavailable = vi.fn()
    const limiter = createRateLimiter({
      onUnavailable,
      upstashToken: 't',
      upstashUrl: 'https://redis.test',
    })
    expect(await limiter.limit('k', BUCKET)).toMatchObject({ allowed: true, degraded: true })
    expect(onUnavailable).toHaveBeenCalledOnce()
  })
})
