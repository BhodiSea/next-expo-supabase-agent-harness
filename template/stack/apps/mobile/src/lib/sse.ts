// NOTE for the vitest lane: this import drags expo-constants (through the one
// door) into the module closure — the sse vitest suite mocks that module at
// its boundary (the same convention as src/lib/kv.test.ts), which keeps the
// parser testable under plain node without weakening the one-door wiring here.
import { apiFetch, type FetchImplementation } from './api-client'

// Server-Sent Events, hand-rolled — a PURE incremental parser over string
// chunks, plus one small consumer that drives it from a streaming fetch.
//
// Why hand-rolled (design record: PORT-SPEC "considered and rejected"): the
// XHR-based SSE packages bypass the api-client one-door — their own transport
// means their own (absent) bearer discipline and their own (absent) envelope
// decoding. The protocol itself is a page of state machine; owning it costs
// less than owning a dependency's transport.
//
// ONE-DOOR / PURITY RULE: this module is the ONLY place in the app that touches
// `expo/fetch`. RN's global fetch cannot stream response bodies; expo/fetch is
// the WinterCG-flavored fetch that can — and if every feature imported it
// directly there would be two fetch doors with two disciplines. So: features
// call streamApiSse(path, …); the transport stays injectable (fetchImpl), which
// is BOTH how jest drives it against the mock network and how the node-side
// live proof drives it against a real server (expo/fetch does not exist under
// node); and the request still flows THROUGH apiFetch, so the bearer token and
// the error-envelope decoding are inherited, not re-implemented.
//
// SOURCE: WHATWG HTML §9.2 Server-sent events — the event-stream parsing model
// this file implements (field grammar, BOM, CR/CRLF/LF line endings, comment
// lines, dispatch-on-blank-line, last-event-id persistence, digits-only retry)
// https://html.spec.whatwg.org/multipage/server-sent-events.html [corpus: whatwg/sse]

/** One dispatched event. `event` defaults to 'message' per spec. */
export interface SseEvent {
  readonly event: string
  readonly data: string
  /** The last-event-id in force at dispatch, or null when none was ever set. */
  readonly id: string | null
}

/**
 * Parser state — immutable; feedSse returns the successor state. Pure data, so
 * the vitest suite can drive every chunk boundary without a transport.
 */
export interface SseParserState {
  /** Unterminated tail — bytes(-as-text) after the last complete line. */
  readonly buffer: string
  /** A leading U+FEFF is stripped from the STREAM (once), not from every chunk. */
  readonly bomStripped: boolean
  /** `data:` lines accumulated for the event under construction. */
  readonly dataLines: readonly string[]
  /** `event:` type for the event under construction ('' = default 'message'). */
  readonly eventType: string
  /** Sticky last-event-id — persists ACROSS events until overwritten. */
  readonly lastEventId: string
  /** Last valid `retry:` value (digits only), or null when never sent. */
  readonly retryMs: number | null
}

export const SSE_INITIAL_STATE: SseParserState = {
  buffer: '',
  bomStripped: false,
  dataLines: [],
  eventType: '',
  lastEventId: '',
  retryMs: null,
}

interface LineEffect {
  readonly state: SseParserState
  readonly event: SseEvent | null
}

/** Apply one COMPLETE line (terminator already removed) to the machine. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- 16/15: mirrors the WHATWG event-stream field dispatch step-for-step; splitting it would detach the code from the spec text it cites
function applyLine(state: SseParserState, line: string): LineEffect {
  if (line === '') {
    // Blank line: dispatch. An empty data buffer dispatches NOTHING — but still
    // resets the event type (spec step order), so `event: x` with no data does
    // not leak into the next event.
    if (state.dataLines.length === 0) {
      return { state: { ...state, eventType: '' }, event: null }
    }
    return {
      state: { ...state, dataLines: [], eventType: '' },
      event: {
        event: state.eventType === '' ? 'message' : state.eventType,
        // Joined with LF; the spec's trailing-newline removal falls out of
        // join() because each data line lands WITHOUT its terminator.
        data: state.dataLines.join('\n'),
        id: state.lastEventId === '' ? null : state.lastEventId,
      },
    }
  }
  // Comment line — the colon-first form servers use as keep-alive pings.
  if (line.startsWith(':')) return { state, event: null }

  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  // Value: everything after the colon, minus ONE leading space (exactly one —
  // "data:  two spaces" keeps its second space per spec).
  const rawValue = colon === -1 ? '' : line.slice(colon + 1)
  const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

  switch (field) {
    case 'data':
      return { state: { ...state, dataLines: [...state.dataLines, value] }, event: null }
    case 'event':
      return { state: { ...state, eventType: value }, event: null }
    case 'id':
      // An id containing NUL is IGNORED (spec) — a poisoned id must not
      // overwrite the sticky last-event-id.
      if (value.includes('\0')) return { state, event: null }
      return { state: { ...state, lastEventId: value }, event: null }
    case 'retry': {
      if (!/^\d+$/.test(value)) return { state, event: null }
      return { state: { ...state, retryMs: Number.parseInt(value, 10) }, event: null }
    }
    default:
      // Unknown field: ignored, per spec.
      return { state, event: null }
  }
}

/**
 * Feed one chunk of decoded text; get the successor state and every event the
 * chunk COMPLETED. Chunk boundaries are arbitrary — mid-line, mid-CRLF, even
 * mid-BOM handling — which is exactly what the unit suite exercises.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- 16/15: the chunk-boundary walk (buffer + CR/LF/CRLF + BOM) is one spec-shaped loop; the unit suite pins every branch
export function feedSse(
  state: SseParserState,
  chunk: string,
): { readonly state: SseParserState; readonly events: readonly SseEvent[] } {
  let text = state.buffer + chunk
  let bomStripped = state.bomStripped
  if (!bomStripped) {
    // Strip a leading BOM only once we can DECIDE: an empty accumulation stays
    // undecided; any first character settles it.
    if (text.startsWith('\uFEFF')) {
      text = text.slice(1)
      bomStripped = true
    } else if (text !== '') {
      bomStripped = true
    }
  }

  const events: SseEvent[] = []
  let machine: SseParserState = { ...state, bomStripped, buffer: '' }
  let start = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (ch !== '\n' && ch !== '\r') continue
    // A CR as the LAST character is ambiguous — its LF half may be in the next
    // chunk. Defer the line: it stays in the buffer, complete, until the next
    // chunk (or close) disambiguates. Processing it now would double-count the
    // terminator when the LF arrives.
    if (ch === '\r' && i === text.length - 1) break
    const line = text.slice(start, i)
    const applied = applyLine(machine, line)
    machine = applied.state
    if (applied.event !== null) events.push(applied.event)
    // CRLF counts as ONE terminator.
    if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1
    start = i + 1
  }
  return { state: { ...machine, buffer: text.slice(start) }, events }
}

/**
 * End of stream: flush a buffered CR-terminated line (the one case feedSse must
 * defer). An INCOMPLETE trailing line is discarded — per spec, an event is only
 * dispatched by a blank line, so a stream that dies mid-event drops that event
 * rather than fabricating half of one.
 */
export function endSse(state: SseParserState): {
  readonly state: SseParserState
  readonly events: readonly SseEvent[]
} {
  if (!state.buffer.endsWith('\r')) return { state, events: [] }
  // The buffered text ends in a bare CR — a complete terminator now that no LF
  // can follow. Reuse the chunk machinery by completing it with LF (CRLF ≡ CR).
  return feedSse({ ...state, buffer: state.buffer.slice(0, -1) }, '\n')
}

// ---------------------------------------------------------------------------
// Consumer — the ONLY impure corner of this module.
// ---------------------------------------------------------------------------

export interface StreamSseOptions {
  /**
   * Transport override. Default: `expo/fetch` (loaded lazily so importing this
   * module never drags native code into a node process — vitest imports the
   * parser above, jest and the live proof inject their own fetch here).
   */
  readonly fetchImpl?: FetchImplementation
  readonly signal?: AbortSignal
}

/** Resolve the default streaming transport — expo/fetch, on the device. */
async function expoStreamingFetch(): Promise<FetchImplementation> {
  // Dynamic on purpose; see StreamSseOptions.fetchImpl.
  const mod = await import('expo/fetch')
  return mod.fetch
}

/**
 * Open an SSE stream against the API (bearer + envelope via apiFetch — the one
 * door) and deliver each parsed event to `onEvent`. Resolves when the server
 * closes the stream; rejects on transport/envelope errors. Cancellation: abort
 * the signal — the reader is released and the promise rejects with AbortError,
 * which stops the server-side producer (its onAbort contract).
 */
export async function streamApiSse(
  path: string,
  onEvent: (event: SseEvent) => void,
  options: StreamSseOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? (await expoStreamingFetch())
  const response = await apiFetch(path, {
    fetchImpl,
    signal: options.signal ?? null,
    headers: { accept: 'text/event-stream' },
  })
  const body: ReadableStream<Uint8Array> | null = response.body
  if (body === null) throw new Error('SSE response carried no body stream')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let state = SSE_INITIAL_STATE
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const fed = feedSse(state, decoder.decode(value, { stream: true }))
      state = fed.state
      for (const event of fed.events) onEvent(event)
    }
    // Flush the decoder's own tail plus a deferred CR line.
    const tail = feedSse(state, decoder.decode())
    state = tail.state
    for (const event of tail.events) onEvent(event)
    const ended = endSse(state)
    for (const event of ended.events) onEvent(event)
  } finally {
    reader.releaseLock()
  }
}
