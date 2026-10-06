import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestPorts } from '../lib/request-ports'

// The web host's one event sink and one clock. Both write transports read them from here (the
// tRPC route and every Server Action), so what this suite pins is what both of them get.
// SOURCE: apps/web/lib/request-ports.ts

describe('requestPorts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mints the instant from the clock, as ISO-8601 UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))
    expect(requestPorts().now).toBe('2026-06-01T12:00:00.000Z')
  })

  it('mints a new instant per call, so each request gets its own', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))
    const first = requestPorts()
    vi.setSystemTime(new Date('2026-06-01T12:00:05.000Z'))
    expect(requestPorts().now).not.toBe(first.now)
  })

  it('hands every request the same sink, which drops an event without throwing', () => {
    // ONE sink for the host: a sink wired later is wired once, for both transports.
    const { emit } = requestPorts()
    expect(requestPorts().emit).toBe(emit)
    expect(() => {
      emit({ name: 'notes.created', payload: {} })
    }).not.toThrow()
  })
})
