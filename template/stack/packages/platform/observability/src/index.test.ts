// The seam's two invariants, both silent when broken:
//   1. REDACTION — no sensitive field ever reaches a sink, at any nesting depth,
//      under any spelling of the key. A sink is where a vendor transport
//      attaches, so anything a sink can see is anything a third party can see.
//   2. TIMING — a span measures the work it wraps, once, and never reports a
//      number that would corrupt an aggregate built on top of it.
// Both are tested against a COLLECTING sink and an injected clock: this package
// exists so that neither logging nor timing needs a real host to be verified.
import { describe, expect, it } from 'vitest'
import type { LogRecord } from './index.js'
import {
  createLogger,
  isSensitiveKey,
  LOG_LEVELS,
  REDACTED,
  redactFields,
  startSpan,
  withSpan,
  withSpanAsync,
} from './index.js'

/** A value that must never appear in anything a sink receives. */
const SENTINEL = 'must-not-appear'

/** A logger writing into an array, plus a clock the test moves by hand. */
function harness(minLevel: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const records: LogRecord[] = []
  const clock = { ms: 1_000 }
  const logger = createLogger({
    minLevel,
    now: () => clock.ms,
    sink: (record) => {
      records.push(record)
    },
  })
  return { clock, logger, records }
}

describe('sensitive-key detection', () => {
  it('matches the fragment whatever the author called the field', () => {
    // One rule, not four: casing and separators are style, not meaning.
    for (const key of ['token', 'accessToken', 'refresh_token', 'X-Auth-TOKEN']) {
      expect(isSensitiveKey(key)).toBe(true)
    }
    for (const key of ['apiKey', 'API_KEY', 'x-api-key', 'apikey']) {
      expect(isSensitiveKey(key)).toBe(true)
    }
    for (const key of ['password', 'userPassword', 'authorization', 'Set-Cookie', 'clientSecret']) {
      expect(isSensitiveKey(key)).toBe(true)
    }
  })

  it('leaves ordinary field names alone', () => {
    for (const key of ['userId', 'route', 'durationMs', 'count', 'noteTitle']) {
      expect(isSensitiveKey(key)).toBe(false)
    }
  })
})

describe('redaction', () => {
  it('replaces the value, keeps the key', () => {
    // The key stays so a reader can still see WHICH field was present — the
    // usual diagnostic question is "was a token sent at all", not "which one".
    expect(redactFields({ authorization: SENTINEL, route: '/notes' })).toEqual({
      authorization: REDACTED,
      route: '/notes',
    })
  })

  it('reaches sensitive keys at every depth, including inside arrays', () => {
    const redacted = redactFields({
      request: { headers: { cookie: SENTINEL }, path: '/api' },
      attempts: [{ apiKey: SENTINEL }, { attempt: 2 }],
    })
    expect(JSON.stringify(redacted)).not.toContain(SENTINEL)
    expect(redacted).toEqual({
      request: { headers: { cookie: REDACTED }, path: '/api' },
      attempts: [{ apiKey: REDACTED }, { attempt: 2 }],
    })
  })

  it('makes the record JSON-safe by construction', () => {
    // The promise every sink relies on: no try/catch around JSON.stringify.
    // JSON.stringify THROWS on a bigint and silently drops functions and
    // symbols, so each becomes a tag that keeps the field's existence visible.
    const redacted = redactFields({
      big: 10n,
      run: () => 0,
      marker: Symbol('marker'),
      when: new Date('2026-01-01T00:00:00.000Z'),
      seen: new Set([1, 2, 3]),
      byId: new Map([['a', 1]]),
    })
    expect(() => JSON.stringify(redacted)).not.toThrow()
    expect(redacted).toEqual({
      big: '[bigint]',
      run: '[function]',
      marker: '[symbol]',
      when: '2026-01-01T00:00:00.000Z',
      seen: '[Set(3)]',
      byId: '[Map(1)]',
    })
  })

  it('summarizes an Error without its stack', () => {
    // This is what the kernel's `toOutcome(run, onThrow)` hands over. A stack is
    // non-enumerable (JSON.stringify drops it) and carries build-machine paths.
    const redacted = redactFields({ cause: new TypeError('bad input') })
    expect(redacted).toEqual({ cause: { name: 'TypeError', message: 'bad input' } })
    expect(JSON.stringify(redacted)).not.toContain('index.test')
  })

  it('survives a cycle and bounds the walk', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic['self'] = cyclic
    expect(redactFields({ cyclic })).toEqual({ cyclic: { name: 'root', self: '[circular]' } })

    // A field's own value is depth 0, so four more object levels are walked and
    // the fifth is tagged. Primitives are never truncated — the cap bounds the
    // walk, not the values it finds.
    const deep = { a: { b: { c: { d: { e: { f: 'too far' } } } } } }
    expect(redactFields(deep)).toEqual({ a: { b: { c: { d: { e: '[truncated]' } } } } })
  })

  it('drops an undefined field rather than carrying it', () => {
    // Absent in, absent out — the same rule the error kernel keeps, and for the
    // same reason: JSON.stringify omits undefined-valued keys, so a record
    // carrying one stops deep-equalling itself after a round trip.
    const redacted = redactFields({ present: 1, missing: undefined })
    expect(Object.hasOwn(redacted, 'missing')).toBe(false)
    expect(redacted).toEqual({ present: 1 })
  })

  it('expands a repeated reference and flags only a true cycle', () => {
    // The guard tracks the PATH being walked, not every object ever seen. The
    // same row appearing in two lists is data, not a cycle, and reporting it as
    // '[circular]' would be a lie about the record — the worst kind of log bug
    // to chase, because it only appears on the second occurrence.
    const shared = { id: 'note-1' }
    expect(redactFields({ a: shared, b: shared })).toEqual({
      a: { id: 'note-1' },
      b: { id: 'note-1' },
    })
    expect(redactFields({ a: shared })).toEqual({ a: { id: 'note-1' } })
  })
})

describe('the logger', () => {
  it('redacts BEFORE the sink sees anything', () => {
    // The structural claim of the whole package: a vendor transport attaches at
    // the sink, so it must be impossible for one to observe a raw value.
    const { logger, records } = harness()
    logger.info('sign-in', { authorization: SENTINEL, nested: { apiKey: SENTINEL } })
    expect(JSON.stringify(records)).not.toContain(SENTINEL)
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe('info')
    expect(records[0]?.message).toBe('sign-in')
    expect(records[0]?.fields).toEqual({ authorization: REDACTED, nested: { apiKey: REDACTED } })
  })

  it('drops everything below the threshold', () => {
    const { logger, records } = harness('warn')
    logger.debug('noise')
    logger.info('also noise')
    logger.warn('worth a look')
    logger.error('worth a page')
    expect(records.map((record) => record.level)).toEqual(['warn', 'error'])
    // Ordered least to most urgent, which is what makes a threshold expressible.
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('merges base fields, and a child adds without mutating its parent', () => {
    const { logger, records } = harness()
    const scoped = logger.child({ requestId: 'req-1', token: SENTINEL })
    scoped.info('handled', { route: '/notes' })
    logger.info('unscoped')
    expect(records[0]?.fields).toEqual({ requestId: 'req-1', token: REDACTED, route: '/notes' })
    // Base fields go through the same pass — a secret does not become safe by
    // being configured once instead of passed every time.
    expect(records[1]?.fields).toEqual({})
  })

  it('lets a per-call field override a base field, but never the envelope', () => {
    const { logger, records } = harness()
    logger.child({ surface: 'web' }).warn('slow', { surface: 'mobile' })
    expect(records[0]?.fields).toEqual({ surface: 'mobile' })
    expect(records[0]?.level).toBe('warn')
  })

  it('emits nothing on the default path when the level is below the default', () => {
    // createLogger() with no options writes to the host console; a debug call
    // must therefore be silent by default, which is also what makes this test
    // safe to run without capturing output.
    expect(() => {
      createLogger().debug('never emitted', { token: SENTINEL })
    }).not.toThrow()
  })
})

describe('spans', () => {
  it('measures elapsed time and tags the record with the span name', () => {
    const { clock, logger, records } = harness()
    const span = startSpan(logger, 'db.listNotes', { table: 'notes' })
    clock.ms += 42
    expect(span.end()).toBe(42)
    expect(records).toHaveLength(1)
    expect(records[0]?.message).toBe('span db.listNotes')
    expect(records[0]?.fields).toEqual({ table: 'notes', span: 'db.listNotes', durationMs: 42 })
  })

  it('ends once, whatever the caller does', () => {
    // A span that ends twice double-counts in every aggregate built on it, and a
    // doubled p95 is indistinguishable from a real regression.
    const { clock, logger, records } = harness()
    const span = startSpan(logger, 'work')
    clock.ms += 10
    expect(span.end()).toBe(10)
    clock.ms += 500
    expect(span.end()).toBe(10)
    expect(records).toHaveLength(1)
  })

  it('never reports a negative duration when the wall clock steps back', () => {
    // One negative sample poisons a sum or a mean for the whole window. Clamping
    // loses this span's timing and preserves everything computed from it.
    const { clock, logger } = harness()
    const span = startSpan(logger, 'ntp-victim')
    clock.ms -= 5_000
    expect(span.end()).toBe(0)
  })

  it('times the work, returns its result, and records the outcome', () => {
    const { clock, logger, records } = harness()
    const result = withSpan(logger, 'render', () => {
      clock.ms += 7
      return 'done'
    })
    expect(result).toBe('done')
    expect(records[0]?.fields).toEqual({ outcome: 'ok', span: 'render', durationMs: 7 })
  })

  it('records a throw as a field and RETHROWS it unchanged', () => {
    // The seam observes; it never swallows. The failure travels back to whoever
    // decides whether it is worth reporting — one failure, one report.
    const { clock, logger, records } = harness()
    const boom = new Error('driver exploded')
    expect(() =>
      withSpan(logger, 'write', () => {
        clock.ms += 3
        throw boom
      }),
    ).toThrow(boom)
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe('info')
    expect(records[0]?.fields).toEqual({
      outcome: 'threw',
      cause: { name: 'Error', message: 'driver exploded' },
      span: 'write',
      durationMs: 3,
    })
  })

  it('times the whole async thunk, not its synchronous prologue', async () => {
    // The reason withSpanAsync is a separate name rather than an overload: an
    // overloaded withSpan would end the span before the awaited work ran.
    const { clock, logger, records } = harness()
    const result = await withSpanAsync(logger, 'fetch', async () => {
      await Promise.resolve()
      clock.ms += 30
      return 'body'
    })
    expect(result).toBe('body')
    expect(records[0]?.fields).toEqual({ outcome: 'ok', span: 'fetch', durationMs: 30 })
  })

  it('records and rethrows a rejection', async () => {
    const { logger, records } = harness()
    await expect(
      withSpanAsync(logger, 'fetch', () => Promise.reject(new Error('timed out'))),
    ).rejects.toThrow('timed out')
    expect(records[0]?.fields).toMatchObject({
      outcome: 'threw',
      cause: { name: 'Error', message: 'timed out' },
    })
  })

  it('redacts span fields like any others', () => {
    const { logger, records } = harness()
    startSpan(logger, 'sign-in', { authorization: SENTINEL }).end({ apiKey: SENTINEL })
    expect(JSON.stringify(records)).not.toContain(SENTINEL)
    expect(records[0]?.fields).toMatchObject({ authorization: REDACTED, apiKey: REDACTED })
  })
})
