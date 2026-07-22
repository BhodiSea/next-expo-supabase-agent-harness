// SSE parser suite (vitest). The parser is pure functions over string chunks;
// the cases pin the WHATWG event-stream grammar: field parsing,
// dispatch-on-blank-line, CR/CRLF/LF and their chunk-boundary splits, BOM,
// comments, id/retry semantics. The streaming consumer (streamApiSse) is
// driven HERE against a mock ReadableStream transport — the mutation lane
// showed the pump was NoCoverage under every unit runner (jest renders the
// screens that consume it; only the live proof read real bytes), so the pump
// corpus below exists to make its mutants killable. The parser-edge corpus at
// the bottom exists for the same reason: each case is a named kill for a
// mutant the event-level cases could not distinguish.
import { describe, expect, it, vi } from 'vitest'

// sse.ts's closure reaches expo-constants through the api-client one-door;
// mock it at the module boundary (the kv.test.ts convention) so the PURE
// parser under test loads in plain node. The consumer path is not exercised
// here — jest drives it against the mock network, the live proof against a
// real server.
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }))

import { type FetchImplementation, setAccessTokenProvider } from './api-client'
import {
  endSse,
  feedSse,
  SSE_INITIAL_STATE,
  type SseEvent,
  type SseParserState,
  streamApiSse,
} from './sse'

/** Feed chunks in sequence; collect every dispatched event. */
function collect(chunks: readonly string[]): {
  readonly events: readonly SseEvent[]
  readonly state: SseParserState
} {
  let state = SSE_INITIAL_STATE
  const events: SseEvent[] = []
  for (const chunk of chunks) {
    const fed = feedSse(state, chunk)
    state = fed.state
    events.push(...fed.events)
  }
  const ended = endSse(state)
  events.push(...ended.events)
  return { events, state: ended.state }
}

describe('feedSse — dispatch model', () => {
  it('dispatches a single data event on the blank line, defaulting the type to message', () => {
    const { events } = collect(['data: hello\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'hello', id: null }])
  })

  it('does NOT dispatch until the blank line arrives', () => {
    let state = SSE_INITIAL_STATE
    const first = feedSse(state, 'data: pending\n')
    expect(first.events).toEqual([])
    state = first.state
    const second = feedSse(state, '\n')
    expect(second.events).toEqual([{ event: 'message', data: 'pending', id: null }])
  })

  it('joins multiple data lines with LF (the multi-line payload form)', () => {
    const { events } = collect(['data: one\ndata: two\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'one\ntwo', id: null }])
  })

  it('a blank line with no data dispatches NOTHING and resets a pending event type', () => {
    const { events } = collect(['event: tick\n\n', 'data: after\n\n'])
    // The tick type must not leak into the next event.
    expect(events).toEqual([{ event: 'message', data: 'after', id: null }])
  })

  it('carries event type and id (the server demo shape: event/data/id per tick)', () => {
    const { events } = collect(['event: tick\ndata: 1\nid: 1\n\n'])
    expect(events).toEqual([{ event: 'tick', data: '1', id: '1' }])
  })

  it('last-event-id is STICKY across events until overwritten', () => {
    const { events } = collect(['id: 7\ndata: a\n\n', 'data: b\n\n', 'id: 8\ndata: c\n\n'])
    expect(events.map((event) => event.id)).toEqual(['7', '7', '8'])
  })

  it('an empty data field still dispatches (empty string payload)', () => {
    const { events } = collect(['data:\n\n'])
    expect(events).toEqual([{ event: 'message', data: '', id: null }])
  })
})

describe('feedSse — field grammar', () => {
  it('strips exactly ONE leading space from a value ("data:  x" keeps the second space)', () => {
    const { events } = collect(['data:  two spaces\n\n'])
    expect(events[0]?.data).toBe(' two spaces')
  })

  it('a colon-less line is a field with an empty value', () => {
    // "data" alone appends '' — two of them dispatch as '\n'-joined empties.
    const { events } = collect(['data\ndata\n\n'])
    expect(events).toEqual([{ event: 'message', data: '\n', id: null }])
  })

  it('keeps every colon after the first inside the value', () => {
    const { events } = collect(['data: a:b:c\n\n'])
    expect(events[0]?.data).toBe('a:b:c')
  })

  it('ignores comment lines (the keep-alive ping form)', () => {
    const { events } = collect([': ping\ndata: real\n: another\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'real', id: null }])
  })

  it('ignores unknown fields', () => {
    const { events } = collect(['unknown: x\ndata: kept\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'kept', id: null }])
  })

  it('ignores an id containing NUL (must not poison the sticky id)', () => {
    const { events } = collect(['id: ok\ndata: a\n\n', 'id: bad\0id\ndata: b\n\n'])
    expect(events.map((event) => event.id)).toEqual(['ok', 'ok'])
  })

  it('accepts a digits-only retry and ignores everything else', () => {
    const { state } = collect(['retry: 2500\n\n'])
    expect(state.retryMs).toBe(2500)
    const ignored = collect(['retry: 2500\n', 'retry: soon\n\n'])
    expect(ignored.state.retryMs).toBe(2500)
  })
})

describe('feedSse — line endings and chunk boundaries', () => {
  const CANONICAL: SseEvent = { event: 'message', data: 'x', id: null }

  it.each([
    ['LF', 'data: x\n\n'],
    ['CRLF', 'data: x\r\n\r\n'],
    ['CR', 'data: x\r\r'],
    ['mixed', 'data: x\r\n\n'],
  ])('%s terminators parse identically', (_name, stream) => {
    expect(collect([stream]).events).toEqual([CANONICAL])
  })

  it('handles a chunk boundary mid-line', () => {
    expect(collect(['data: he', 'llo\n\n']).events).toEqual([
      { event: 'message', data: 'hello', id: null },
    ])
  })

  it('handles a chunk boundary mid-field-name', () => {
    expect(collect(['da', 'ta: split\n\n']).events).toEqual([
      { event: 'message', data: 'split', id: null },
    ])
  })

  it('handles a CRLF split ACROSS chunks as one terminator, not two', () => {
    // 'data: x\r' + '\n\r\n' — the deferred CR must pair with the next chunk's
    // LF; double-counting would dispatch an empty extra event.
    expect(collect(['data: x\r', '\n\r\n']).events).toEqual([CANONICAL])
  })

  it('a lone CR at a chunk end still terminates its line once more input arrives', () => {
    expect(collect(['data: x\r', 'data: y\n\n']).events).toEqual([
      { event: 'message', data: 'x\ny', id: null },
    ])
  })

  it('one character per chunk parses identically to one big chunk', () => {
    const stream = 'event: tick\r\ndata: 1\r\nid: 1\r\n\r\nevent: tick\r\ndata: 2\r\nid: 2\r\n\r\n'
    const whole = collect([stream]).events
    // Array.from (not spread): same code-point split, without tripping the
    // no-misused-spread emoji hazard — this fixture is pure ASCII either way.
    const trickled = collect(Array.from(stream)).events
    expect(trickled).toEqual(whole)
    expect(whole).toEqual([
      { event: 'tick', data: '1', id: '1' },
      { event: 'tick', data: '2', id: '2' },
    ])
  })
})

describe('feedSse — BOM handling', () => {
  it('strips a leading BOM from the stream', () => {
    expect(collect(['\uFEFFdata: x\n\n']).events).toEqual([
      { event: 'message', data: 'x', id: null },
    ])
  })

  it('strips the BOM even when it arrives as its own chunk', () => {
    expect(collect(['\uFEFF', 'data: x\n\n']).events).toEqual([
      { event: 'message', data: 'x', id: null },
    ])
  })

  it('does NOT strip a BOM later in the stream (only the first character)', () => {
    const { events } = collect(['data: a\n\n', '\uFEFFdata: b\n\n'])
    // The second BOM lands inside a field NAME, making it unknown — ignored.
    expect(events).toEqual([{ event: 'message', data: 'a', id: null }])
  })
})

describe('endSse — end of stream', () => {
  it('discards an incomplete trailing event (no fabricated half-events)', () => {
    const { events } = collect(['data: complete\n\ndata: cut off mid'])
    expect(events).toEqual([{ event: 'message', data: 'complete', id: null }])
  })

  it('flushes a deferred CR-terminated final line', () => {
    // The stream ends '…\r\r' with the last CR deferred — close must count it
    // as the dispatching blank line.
    let state = SSE_INITIAL_STATE
    const fed = feedSse(state, 'data: x\r\r')
    state = fed.state
    expect(fed.events).toEqual([])
    const ended = endSse(state)
    expect(ended.events).toEqual([{ event: 'message', data: 'x', id: null }])
  })

  it('is a no-op on a cleanly terminated stream', () => {
    const fed = feedSse(SSE_INITIAL_STATE, 'data: x\n\n')
    expect(endSse(fed.state).events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Parser-edge kill corpus. Every case here exists because a NAMED mutant
// survived the event-level cases above (tools/mutation-baseline.json records
// which): these pin the exact state transitions the mutants alter, so removing
// one re-opens a known hole in the mutation lane, not a stylistic preference.
// ---------------------------------------------------------------------------
describe('feedSse — parser-edge kill corpus', () => {
  it('an empty chunk leaves BOM stripping UNDECIDED (kills the eager-decide mutants)', () => {
    // '' must not settle the BOM question: the first real character does. An
    // eagerly-set flag would leave the next chunk's BOM embedded in the field
    // name, silently eating the first event.
    const { events } = collect(['', '\uFEFFdata: x\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'x', id: null }])
  })

  it('strips ONE stream BOM only — a second leading BOM is data, even chunk-split', () => {
    // A flag that never latches would strip the second BOM too, resurrecting
    // an event the spec says is malformed (BOM inside a field name).
    const { events } = collect(['\uFEFF', '\uFEFFdata: x\n\n', 'data: y\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'y', id: null }])
  })

  it('dispatch resets the event type to the DEFAULT, not to a sentinel', () => {
    // The reset written by the dispatch return: the next untyped event must
    // come back as 'message', proving the type field was reset to ''.
    const { events } = collect(['event: tick\ndata: a\n\n', 'data: b\n\n'])
    expect(events).toEqual([
      { event: 'tick', data: 'a', id: null },
      { event: 'message', data: 'b', id: null },
    ])
  })

  it('no space after the colon: the value keeps its first character', () => {
    // Exactly ONE leading space is stripped, and only when present — a strip
    // that always drops the first character would corrupt every unpadded value.
    const { events } = collect(['data:x\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'x', id: null }])
  })

  it('retry must be digits ONLY — digit-prefixed or digit-suffixed values are ignored', () => {
    // Both anchors are load-bearing: '12abc' passes /^\d+/ and 'abc12' passes
    // /\d+$/; the spec accepts neither.
    expect(collect(['retry: 12abc\n\n']).state.retryMs).toBeNull()
    expect(collect(['retry: abc12\n\n']).state.retryMs).toBeNull()
    expect(collect(['retry: 500\n\n']).state.retryMs).toBe(500)
  })
})

describe('endSse — buffered-tail state (kill corpus)', () => {
  it('keeps an incomplete tail in the buffer UNTOUCHED (no phantom flush)', () => {
    // A close on a mid-line tail must not push a truncated line through the
    // machine: the buffer survives as-is and no data accumulates.
    const { state, events } = collect(['data: partial'])
    expect(events).toEqual([])
    expect(state.buffer).toBe('data: partial')
    expect(state.dataLines).toEqual([])
  })

  it('flushes a CR-terminated tail into the machine state, losing no bytes', () => {
    // 'data: tail\r' at close IS a complete line: the flush must apply the
    // whole line (not a truncated or skipped one) even though nothing
    // dispatches without a blank line.
    const { state, events } = collect(['data: tail\r'])
    expect(events).toEqual([])
    expect(state.buffer).toBe('')
    expect(state.dataLines).toEqual(['tail'])
  })
})

// ---------------------------------------------------------------------------
// The pump: streamApiSse against a mock ReadableStream transport. This is the
// half the mutation lane reported as NoCoverage everywhere — the reader loop,
// the streaming decode, the tail flush, the accept header, the lock release.
// The transport is injected (fetchImpl — the same seam jest and the live proof
// use), so these cases run under plain node with zero network.
// ---------------------------------------------------------------------------
describe('streamApiSse — the pump against a mock ReadableStream', () => {
  const encoder = new TextEncoder()

  interface CapturedRequest {
    url: string
    init: RequestInit
  }

  /** A transport serving the given byte chunks, capturing the request it got. */
  function mockTransport(chunks: readonly Uint8Array[]): {
    fetchImpl: FetchImplementation
    stream: ReadableStream<Uint8Array>
    captured: CapturedRequest[]
  } {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const captured: CapturedRequest[] = []
    const fetchImpl: FetchImplementation = (url, init) => {
      captured.push({ url, init })
      return Promise.resolve(new Response(stream, { status: 200 }))
    }
    return { fetchImpl, stream, captured }
  }

  it('delivers every event across chunk boundaries, requests text/event-stream, and releases the lock', async () => {
    setAccessTokenProvider(() => Promise.resolve('sse-test-token'))
    const { fetchImpl, stream, captured } = mockTransport([
      encoder.encode('event: tick\ndata: 1\n\nda'),
      encoder.encode('ta: 2\n\n'),
    ])
    const events: SseEvent[] = []
    await streamApiSse(
      '/api/demo/stream',
      (event) => {
        events.push(event)
      },
      { fetchImpl },
    )
    expect(events).toEqual([
      { event: 'tick', data: '1', id: null },
      { event: 'message', data: '2', id: null },
    ])
    // The request went through the one door: bearer + accept + explicit
    // no-signal, all visible to the injected transport.
    const request = captured[0]
    expect(request?.url.endsWith('/api/demo/stream')).toBe(true)
    expect(new Headers(request?.init.headers).get('accept')).toBe('text/event-stream')
    expect(new Headers(request?.init.headers).get('authorization')).toBe('Bearer sse-test-token')
    expect(request?.init.signal).toBeNull()
    // releaseLock ran: the source stream is free again after the pump resolves.
    expect(stream.locked).toBe(false)
  })

  it('flushes a deferred CR line at close (the endSse path runs inside the pump)', async () => {
    setAccessTokenProvider(() => Promise.resolve('sse-test-token'))
    // The stream's LAST byte is the deferred CR: only the close-time flush can
    // dispatch this event.
    const { fetchImpl } = mockTransport([encoder.encode('data: a\n\r')])
    const events: SseEvent[] = []
    await streamApiSse(
      '/api/demo/stream',
      (event) => {
        events.push(event)
      },
      { fetchImpl },
    )
    expect(events).toEqual([{ event: 'message', data: 'a', id: null }])
  })

  it('holds a multi-byte character split across chunks (streaming decode, not per-chunk)', async () => {
    setAccessTokenProvider(() => Promise.resolve('sse-test-token'))
    // 'data: café\n\n' is 13 bytes with é as 0xC3 0xA9 at bytes 9–10: cutting
    // at length-3 lands BETWEEN the é's two bytes. A non-streaming decode
    // would flush a U+FFFD replacement character per half instead.
    const bytes = encoder.encode('data: café\n\n')
    const splitAt = bytes.length - 3 // between 0xC3 and 0xA9
    const { fetchImpl } = mockTransport([bytes.slice(0, splitAt), bytes.slice(splitAt)])
    const events: SseEvent[] = []
    await streamApiSse(
      '/api/demo/stream',
      (event) => {
        events.push(event)
      },
      { fetchImpl },
    )
    expect(events).toEqual([{ event: 'message', data: 'café', id: null }])
  })

  it('rejects with the exact no-body-stream message when the response has no body', async () => {
    setAccessTokenProvider(() => Promise.resolve('sse-test-token'))
    const fetchImpl: FetchImplementation = () =>
      Promise.resolve(new Response(null, { status: 200 }))
    await expect(streamApiSse('/api/demo/stream', () => undefined, { fetchImpl })).rejects.toThrow(
      'SSE response carried no body stream',
    )
  })

  it("threads the caller's AbortSignal through to the transport", async () => {
    setAccessTokenProvider(() => Promise.resolve('sse-test-token'))
    const { fetchImpl, captured } = mockTransport([encoder.encode('data: x\n\n')])
    const controller = new AbortController()
    await streamApiSse('/api/demo/stream', () => undefined, {
      fetchImpl,
      signal: controller.signal,
    })
    expect(captured[0]?.init.signal).toBe(controller.signal)
  })
})
