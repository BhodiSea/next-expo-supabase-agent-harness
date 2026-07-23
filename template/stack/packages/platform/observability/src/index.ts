// ---------------------------------------------------------------------------
// @app/observability — the logging and timing SEAM, and a platform leaf.
//
// It imports NOTHING. The layering law would permit the kernel ({errors,
// events}), and it still takes neither, for reasons that are about behaviour
// rather than tidiness:
//
//  1. @app/errors would let a `cause` field be typed as `AppError`. That is
//     precisely the wrong shape: `toOutcome(run, onThrow)` hands this seam an
//     `unknown` — a driver object, a string, a rejected promise's value — and
//     the throws that most need reporting are exactly the ones the taxonomy
//     does not classify. A reporter that understands only modelled failures
//     drops the unmodelled ones.
//  2. @app/events would bind a log line to the analytics registry. They are
//     different artifacts: an event is a durable row an analyst reads next year
//     (which is why that package's payloads are plain, boring types), a log line
//     is a short-lived diagnostic an operator reads during an incident. One
//     import here would make an event rename a change to logging, and vice
//     versa.
//  3. Zero imports means this module can be called from ANYWHERE — from inside
//     the error kernel's `onThrow`, from a DAL, from a screen — with no risk of
//     an import cycle. A logger that cannot be called from some layer is a
//     logger that layer works around, and the workaround is a bare `console`
//     call that nothing redacts.
//
// NO VENDOR SDK, on purpose. A crash reporter or a tracing agent is a MODULE
// (see the crash-reporting module), and it attaches HERE, at the sink, behind
// the redaction pass. That ordering is the whole design: a vendor transport
// added later cannot see a raw value, because by the time a record reaches a
// sink it has already been through `redactFields`.
//
// The exports-walls census sanctions this package for a `./client` subpath, and
// it deliberately does not have one YET: nothing in this file touches a host
// API a bundler must resolve, so the single "." barrel is Metro-safe as it
// stands. The day a node-only transport lands here is the day the split becomes
// real — the census entry is already written for it, and adding a transport to
// this barrel without splitting is the accident it describes.
// ---------------------------------------------------------------------------

/**
 * Severity, ordered least to most urgent. A closed union rather than a number:
 * levels are compared, filtered and rendered, and a free-form string level makes
 * every one of those a guess.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Every level, in severity order — the order a threshold is expressed in. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * Rank per level. `Readonly<Record<LogLevel, number>>` is the closure lock: a
 * level added to the union with no rank fails to compile, and a rank whose key
 * is not a level is an excess property on this literal. No second hand-kept list.
 */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * The structured half of a log line. `unknown`, not a JSON-safe union, because
 * callers pass what they have — a caught value, a response object, a config —
 * and a type that forbids that just gets a `String(…)` at the call site, which
 * is a redaction bypass. `redactFields` is what makes the value safe, and it
 * runs on everything.
 */
export type LogFields = Readonly<Record<string, unknown>>

/**
 * What a sink receives. `fields` is ALREADY redacted and already JSON-safe — a
 * sink may `JSON.stringify` it with no try/catch, because the redaction pass is
 * also the serialization pass (see `redactValue`).
 *
 * There is no timestamp. Deliberate: the two surfaces disagree about the clock
 * (a phone's is user-settable), so the only trustworthy timestamp is the one the
 * ingesting system stamps on arrival. What this package DOES own is elapsed
 * time, which is a difference and therefore immune to any clock offset.
 */
export interface LogRecord {
  readonly level: LogLevel
  readonly message: string
  readonly fields: LogFields
}

/** Where a record goes. One function — the entire vendor-integration surface. */
export type LogSink = (record: LogRecord) => void

/** The value substituted for anything the redaction pass refuses to emit. */
export const REDACTED = '[redacted]'

/**
 * Key fragments that mark a field as unemittable.
 *
 * Matched as SUBSTRINGS of a normalized key, so `apiKey`, `API_KEY`,
 * `x-api-key` and `apikey` are one rule rather than four, and `accessToken`,
 * `refresh_token` and `Set-Cookie` are all caught by the fragment they contain.
 * Fragments, not exact names, because the names are invented at the call site
 * and an exact list is a list that is always one field out of date.
 */
export const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'token',
  'password',
  'authorization',
  'apikey',
  'secret',
  'cookie',
]

/**
 * Normalize away the separator conventions before matching: casing and
 * punctuation are style, not meaning. `X-Api-Key`, `x_api_key` and `apiKey` are
 * the same field with three authors.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Whether a field name may never carry its value into a log record. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

/**
 * How deep the walk goes before it stops describing and starts truncating.
 *
 * Four levels is enough for the shapes that actually get logged (a record, a
 * nested request descriptor, a list of small objects) and short enough that one
 * accidental `logger.info('x', { props })` on a React tree cannot turn a log
 * line into a megabyte. The cap is not a safety feature — the cycle guard below
 * is — it is a cost bound.
 */
const MAX_DEPTH = 4

/**
 * The redaction and serialization pass, in one walk.
 *
 * ===========================================================================
 *                     WHY REDACTION LIVES AT THE SEAM
 * ===========================================================================
 * Redacting at each call site is a rule, and a rule is a thing every future
 * author has to know, remember, and apply correctly at 2am while debugging the
 * thing that made them add the log line. It fails silently — the line looks
 * fine, it HAS a value in it — and it fails permanently: log lines are copied
 * into tickets, shipped to a warehouse, attached to crash reports and forwarded
 * to third-party sinks. A leaked credential in a log line cannot be recalled
 * any more than one compiled into a shipped bundle can (see @app/env).
 *
 * One pass at the seam is different in kind, not degree:
 *   - it is ENFORCED rather than remembered — every emission goes through this
 *     function, so a call site written by someone who never read this file
 *     inherits the guarantee anyway;
 *   - it is TESTABLE as one property instead of as N call-site reviews;
 *   - it sits strictly UPSTREAM of the sink, which is where a vendor transport
 *     attaches. A redaction pass inside the transport would protect only the
 *     transports that implement it.
 *
 * THE LIMITS, STATED RATHER THAN DISCOVERED. This matches on the NAME, which is
 * all that is knowable about a value's sensitivity before you know where it came
 * from. So it over-redacts (a field innocently called `secretSanta` loses its
 * value — a debugging detail, cheap) and it cannot see a credential inside an
 * innocently-named field (`{ note: 'my password is …' }`, or a database URL with
 * a password in its authority component — cheap only because the upstream rule
 * is that such values are never handed to a log field in the first place).
 * Redaction is the LAST net. It is not the only one, and treating it as the only
 * one is how the first one stops being maintained.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // Primitives pass through. `typeof null === 'object'`, so null is handled here
  // rather than in the object branch below.
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  // Everything JSON cannot carry becomes a TAG rather than being dropped.
  // JSON.stringify silently omits functions, symbols and undefined and THROWS on
  // a bigint; a tag keeps the record JSON-safe by construction (the promise this
  // module makes to every sink) and keeps the field's existence visible, which
  // is usually the fact the reader needed.
  if (typeof value !== 'object') return `[${typeof value}]`

  // Cycles are not exotic — a request object referencing its response, a node
  // referencing its parent. Without this the walk never returns.
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[truncated]'

  seen.add(value)
  try {
    return redactObject(value, depth, seen)
  } finally {
    // The guard tracks the current PATH, not every object ever visited: released
    // on the way back up so a value referenced twice in one record — the same
    // row in two lists, one shared config object — is expanded both times. A
    // visit-scoped guard would report the second reference as '[circular]',
    // which is a lie about the data and the hardest kind of log bug to chase.
    seen.delete(value)
  }
}

/** The object half of the walk. Split out so the guard above has one exit. */
function redactObject(value: object, depth: number, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => redactValue(item, depth + 1, seen))
  }

  // An Error is the most likely non-plain value here: it is what the kernel's
  // `toOutcome(run, onThrow)` hands over. Name and message only — a stack is not
  // enumerable (JSON.stringify drops it anyway) and routinely carries absolute
  // build-machine paths, which is not information this seam should forward to a
  // client transport.
  if (value instanceof Error) return { name: value.name, message: value.message }

  // A Date is JSON-safe already, but only via its own toJSON; making the ISO
  // string explicit means the record's own JSON-safety does not depend on a
  // sink calling JSON.stringify rather than inspecting the object.
  if (value instanceof Date) return value.toISOString()

  // Maps and Sets have no own enumerable properties, so the generic walk below
  // would report them as `{}` — an empty object where there was data is worse
  // than a tag that says how much data there was.
  if (value instanceof Map) return `[Map(${String(value.size)})]`
  if (value instanceof Set) return `[Set(${String(value.size)})]`

  // The cast is what `Object.entries` cannot express for a bare `object` (it
  // would hand back `any` values, and an `any` inside the redaction pass is a
  // hole in exactly the wrong place). Sound here: every remaining case is a
  // walkable object, and each value is immediately re-entered as `unknown`.
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) continue // absent in, absent out — see @app/errors
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(nested, depth + 1, seen)
  }
  return out
}

/**
 * Redact one field record. The public entry to the walk above.
 *
 * A fresh `WeakSet` per call, on top of the path-scoped release inside the walk:
 * the guard is about one record's shape and must not carry state between log
 * lines.
 */
export function redactFields(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {}
  const seen = new WeakSet<object>()
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value, 0, seen)
  }
  return out
}

/** The host's console, if this runtime has one. */
interface ConsoleLike {
  readonly log: (line: string) => void
}

// Discovered through globalThis rather than imported: `node:console` would make
// this package unresolvable under Metro, and a bare `console` reference would
// need an ambient type list this package deliberately does not have. The
// optional shape is honest — a runtime with no console is a runtime where the
// default sink does nothing, which is the correct behaviour for a seam whose
// real transports are injected.
// SOURCE: globalThis is the one cross-environment way to reach the global object
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/globalThis
const hostConsole = (globalThis as unknown as { readonly console?: ConsoleLike }).console

/**
 * The default sink: one JSON line per record.
 *
 * `...record.fields` comes FIRST so the record's own `level` and `message`
 * always win. A caller-supplied field named `level` must not be able to rewrite
 * the envelope around it — that is log injection, and it is how a warn line gets
 * filed as debug by whatever is reading the stream.
 *
 * Every level goes to the same stream because every record carries its level.
 * Splitting by severity makes an operator reassemble two interleaved streams to
 * see one timeline.
 */
export const consoleSink: LogSink = (record) => {
  if (hostConsole === undefined) return
  hostConsole.log(
    JSON.stringify({ ...record.fields, level: record.level, message: record.message }),
  )
}

/** A sink that discards. For tests, and for a surface that has not wired one. */
export const silentSink: LogSink = () => {
  // Intentionally empty: the seam's null object.
}

/** How a logger is built. Every option has a default; none of them is a surprise. */
export interface LoggerOptions {
  /** Where records go. Defaults to one JSON line on the host console. */
  readonly sink?: LogSink
  /** Records below this rank are dropped BEFORE redaction runs. Defaults to `info`. */
  readonly minLevel?: LogLevel
  /** Fields merged into every record — a request id, a surface name, a release. */
  readonly base?: LogFields
  /**
   * The clock, in milliseconds, for span timing.
   *
   * Defaults to `Date.now`, which is a WALL clock: it can step backwards when
   * the host corrects its time mid-span. A host that has a monotonic clock
   * should pass one (`() => performance.now()`); this package will not reach for
   * a host global to find one, because being reachable from every surface is the
   * property that makes it usable at all.
   * SOURCE: Date.now returns wall-clock milliseconds and is not monotonic
   * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now
   * SOURCE: performance.now is the monotonic counterpart a host may supply
   * https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
   */
  readonly now?: () => number
}

/** The seam every surface calls. */
export interface Logger {
  /** The one emission path; the four named levels are sugar over it. */
  readonly log: (level: LogLevel, message: string, fields?: LogFields) => void
  readonly debug: (message: string, fields?: LogFields) => void
  readonly info: (message: string, fields?: LogFields) => void
  readonly warn: (message: string, fields?: LogFields) => void
  readonly error: (message: string, fields?: LogFields) => void
  /** A logger carrying extra base fields — request scope, without a global. */
  readonly child: (fields: LogFields) => Logger
  /** The clock this logger times spans with. Exposed so a span is testable. */
  readonly now: () => number
}

/**
 * Build a logger.
 *
 * Level gating happens BEFORE redaction on purpose: redaction is the expensive
 * part (it walks the whole field record), and a debug line in a production
 * process should cost a number comparison and nothing else.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink
  const minRank = LEVEL_RANK[options.minLevel ?? 'info']
  const base = options.base ?? {}
  const now = options.now ?? Date.now

  const log = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[level] < minRank) return
    sink({ level, message, fields: redactFields({ ...base, ...fields }) })
  }

  return {
    log,
    debug: (message, fields) => {
      log('debug', message, fields)
    },
    info: (message, fields) => {
      log('info', message, fields)
    },
    warn: (message, fields) => {
      log('warn', message, fields)
    },
    error: (message, fields) => {
      log('error', message, fields)
    },
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
    now,
  }
}

/** An open measurement. `end` is idempotent — see `startSpan`. */
export interface Span {
  readonly name: string
  /** Close the span, emit one record, and return the elapsed milliseconds. */
  readonly end: (fields?: LogFields) => number
}

/**
 * Open a span.
 *
 * `end` is IDEMPOTENT: a second call returns the same duration and emits
 * nothing. A span that ends twice — an early return that also runs a `finally`,
 * a retry that reuses the handle — double-counts in every aggregate built on top
 * of it, and a doubled p95 is indistinguishable from a real regression.
 *
 * The duration is clamped at zero. A wall clock can step backwards mid-span, and
 * a negative duration is not a measurement, it is a clock event: one of them
 * poisons a sum or an average for the whole window. Clamping loses one span's
 * timing and preserves everything computed from it; pass a monotonic `now` to
 * avoid the case entirely.
 */
export function startSpan(logger: Logger, name: string, fields: LogFields = {}): Span {
  const startedAt = logger.now()
  let settled: number | null = null

  const end = (endFields: LogFields = {}): number => {
    if (settled !== null) return settled
    const durationMs = Math.max(0, Math.round(logger.now() - startedAt))
    settled = durationMs
    logger.info(`span ${name}`, { ...fields, ...endFields, span: name, durationMs })
    return durationMs
  }

  return { name, end }
}

/**
 * Time `run`, emit one span record, and return its result.
 *
 * The span record is emitted at `info` whether or not `run` threw, and the
 * outcome rides the record as a FIELD. A span line is a measurement, not an
 * alarm: the failure itself travels back to the caller (as the kernel's
 * `ActionOutcome`, or as the rethrown value here) and is reported by whoever
 * decides it is worth reporting. Two systems reporting one failure at two
 * severities is how an incident gets counted twice and paged for once.
 *
 * The thrown value is RETHROWN unchanged. This seam observes; it never swallows.
 */
export function withSpan<T>(logger: Logger, name: string, run: () => T, fields: LogFields = {}): T {
  const span = startSpan(logger, name, fields)
  try {
    const result = run()
    span.end({ outcome: 'ok' })
    return result
  } catch (cause) {
    // `cause` goes in raw; the redaction pass turns an Error into { name,
    // message } and tags anything it cannot serialize.
    span.end({ outcome: 'threw', cause })
    throw cause
  }
}

/**
 * `withSpan` for an async thunk.
 *
 * A separate name rather than an overload, for exactly the reason
 * `toOutcomeAsync` is separate in @app/errors: an overload would let
 * `withSpan(logger, 'x', async () => …)` typecheck, and it would time the
 * synchronous prologue only — the span would end at ~0ms while the work it
 * claims to measure was still running, and a rejection would escape the catch
 * entirely.
 */
export async function withSpanAsync<T>(
  logger: Logger,
  name: string,
  run: () => Promise<T>,
  fields: LogFields = {},
): Promise<T> {
  const span = startSpan(logger, name, fields)
  try {
    const result = await run()
    span.end({ outcome: 'ok' })
    return result
  } catch (cause) {
    span.end({ outcome: 'threw', cause })
    throw cause
  }
}
