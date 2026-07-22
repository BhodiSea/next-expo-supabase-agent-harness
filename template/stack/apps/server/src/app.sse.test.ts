import { once } from 'node:events'
import { createAdaptorServer } from '@hono/node-server'
import { describe, expect, it, vi } from 'vitest'
import { type AppOptions, createApp } from './app.js'

const baseOptions: AppOptions = {
  version: '0.1.0',
  verifyToken: () => Promise.resolve({ userId: '11111111-1111-4111-8111-111111111111' }),
}

const authed = { authorization: 'Bearer test-token' }

describe('GET /api/events/demo (SSE)', () => {
  it('streams exactly 3 ticks then closes', async () => {
    const app = createApp({ ...baseOptions, sseTickMs: 1 })
    const res = await app.request('/api/events/demo', { headers: authed })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()
    expect(body.match(/event: tick/g)).toHaveLength(3)
    expect(body).toContain('data: 3')
  })

  it('ticks every 250 ms by DEFAULT when no cadence is configured', async () => {
    // The default is the only cadence production ever runs at (nothing passes sseTickMs),
    // and every other test in this file overrides it — so a default that collapsed to 0 ms
    // would turn the demo stream into a burst that hammers every connected client, and
    // nothing here would notice. Wall-clock, because the pause IS the behaviour.
    const app = createApp(baseOptions)

    const started = performance.now()
    const res = await app.request('/api/events/demo', { headers: authed })
    const body = await res.text()
    const elapsed = performance.now() - started

    expect(body.match(/event: tick/g)).toHaveLength(3)
    // Three sleeps at 250 ms is 750 ms; a lower bound well under it stays honest on a
    // loaded runner while still being unreachable for a stream that never paused.
    expect(elapsed).toBeGreaterThanOrEqual(500)
  })

  it('a client that hangs up with NO abort hook installed is a no-op, not a throw', async () => {
    // onSseAbort is a TEST hook — production passes nothing. So the undefined case is the
    // one that actually ships: calling it unconditionally would throw inside the stream's
    // abort path on every dropped client, which is exactly when nobody is watching.
    const app = createApp({ ...baseOptions, sseTickMs: 50 })
    const res = await app.request('/api/events/demo', { headers: authed })
    if (res.body === null) {
      throw new Error('expected a streaming body')
    }

    const reader = res.body.getReader()
    await reader.read() // first tick arrived — the stream is live and the abort path is armed
    // Cancelling the body runs the stream's abort subscribers; if one of them throws, the
    // cancel REJECTS. Hanging up must be silent.
    await expect(reader.cancel()).resolves.toBeUndefined()
  })

  it('propagates a client abort into the server-side generator', async () => {
    const onSseAbort = vi.fn()
    const app = createApp({ ...baseOptions, sseTickMs: 200, onSseAbort })
    // Real sockets on an ephemeral port: abort propagation only exists over a
    // live connection, so app.request() cannot exercise it.
    const server = createAdaptorServer({ fetch: app.fetch })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected a TCP address')
      }
      const controller = new AbortController()
      const res = await fetch(`http://127.0.0.1:${String(address.port)}/api/events/demo`, {
        headers: authed,
        signal: controller.signal,
      })
      expect(res.status).toBe(200)
      if (res.body === null) {
        throw new Error('expected a streaming body')
      }
      const reader = res.body.getReader()
      await reader.read() // first tick arrived — the stream is live
      expect(onSseAbort).not.toHaveBeenCalled()
      controller.abort()
      await vi.waitFor(
        () => {
          expect(onSseAbort).toHaveBeenCalledTimes(1)
        },
        { timeout: 2000 },
      )
    } finally {
      server.close()
    }
  })
})
