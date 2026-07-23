// ---------------------------------------------------------------------------
// @app/errors — THE KERNEL.
//
// This module imports NOTHING. Not zod, not a vendor SDK, not a sibling
// workspace. It is the bottom of the layering law, so every other package may
// depend on it and it may depend on none of them; that is what makes it safe to
// pull into a Next server bundle, a browser bundle, and a Hermes native binary
// at the same time.
//
// ===========================================================================
//                              THE ENVELOPE RULE
// ===========================================================================
// A DOMAIN FAILURE RIDES THE DATA CHANNEL. IT IS NEVER THROWN.
//
// Every procedure, Server Action, and data-access function returns
// `ActionOutcome<T>` — a plain, JSON-safe object — on success AND on failure.
// It does not throw a TRPCError, an HTTPException, or a subclass of Error to
// signal "not found", "forbidden", or "that title is too long".
//
// The reason is mechanical, not stylistic. `AppError` is a DISCRIMINATED UNION
// and the screens switch on `kind`. A throw crossing the transport is flattened
// by the transport: tRPC serializes a thrown error into `{ message, code,
// data }`, the discriminant becomes a prose string, and the exhaustive switch
// on the other side degrades into string sniffing that no compiler checks. The
// first time a new kind is added, every screen silently falls through to its
// default branch — and nothing reds. Riding the data channel keeps the union
// intact end to end, so adding a kind reds every incomplete switch at compile
// time, which is the entire point of modelling failures as a union.
//
// The ONE sanctioned throw is transport-level authentication (the auth
// middleware rejecting a request that carries no identity at all). That is not
// a domain failure — there is no domain call yet — and the mobile normalize
// layer folds it straight back into `appError.unauthorized()` so the screens
// still see one shape.
// SOURCE: docs/harness/README.md (the envelope rule: domain failures ride the
// data channel; only transport auth throws) [corpus: harness/doctrine]
//
// ===========================================================================
//                             THE SERIALIZATION RULE
// ===========================================================================
// `AppError` is built exclusively from JSON primitives — strings, numbers, and
// arrays of strings. No `Error` instances (their `message`/`stack` do not
// survive `JSON.stringify` and their prototype does not survive at all), no
// `Symbol` (silently dropped), no `Date` (round-trips to a string and stops
// being a Date). The transport carries no superjson-style transformer, so the
// error channel is provably JSON-safe by construction and the round-trip test
// in this package's suite proves it for every variant.
//
// The DATA channel's JSON-safety is the caller's duty: a DTO that smuggles a
// `Date` through `data` is a wire bug, and the contracts package's zod schemas
// are where that is caught.
// ---------------------------------------------------------------------------

/**
 * Fields every failure carries, whatever its kind.
 *
 * `K` is intentionally unconstrained (`extends string`, not
 * `extends AppErrorKind`): `AppErrorKind` is DERIVED from `AppError` below, so
 * constraining it here would close a type-level cycle.
 */
export interface AppErrorCore<K extends string> {
  /**
   * THE discriminant. Every screen, every mapper, and every exhaustive switch
   * keys off this field and nothing else.
   */
  readonly kind: K
  /**
   * Stable, machine-readable, snake_case. `kind` is the COARSE class a screen
   * branches on; `code` is the FINE identity a log line, a metric label, or a
   * translation key is allowed to depend on. Two different validation failures
   * share `kind: 'validation'` and differ by `code`, so a screen keeps one
   * branch while an operator keeps two distinguishable events.
   */
  readonly code: string
  /**
   * Developer-facing English for logs and developer surfaces. It is NOT the
   * user-visible string: localized copy is chosen on the client from `kind` +
   * `code`, because a server-side sentence cannot know the reader's locale and
   * a server-side sentence rendered raw is how internals leak into a UI.
   *
   * Optional and, when unused, ABSENT — never present-but-undefined. See
   * `core()` for why that distinction is load-bearing.
   */
  readonly message?: string
}

/**
 * Every failure this system can name. Closed on purpose: an unmodelled failure
 * is `unknown`, which is honest, rather than a tenth ad-hoc shape invented at a
 * call site that no screen knows how to render.
 */
export type AppError =
  /** No verified identity at all — sign in. */
  | AppErrorCore<'unauthorized'>
  /** Identity verified, permission refused. Distinct from `rlsDenied`: this is an
   * application rule the code evaluated, not a database policy that fired. */
  | AppErrorCore<'forbidden'>
  /** The addressed thing does not exist FOR THIS CALLER. See the empty-set
   * reading in @app/supabase: an RLS-filtered read is indistinguishable from
   * absence, and that is the correct answer, not a leak. */
  | (AppErrorCore<'notFound'> & { readonly resource?: string })
  /** The write lost a race or violated a uniqueness rule; retrying the same
   * write unchanged will fail the same way. */
  | (AppErrorCore<'conflict'> & { readonly resource?: string })
  /** The input did not satisfy the contract. `fields` are DOT-PATHS into the
   * submitted object so a form can attach each message to its input. */
  | (AppErrorCore<'validation'> & { readonly fields?: readonly string[] })
  // SOURCE: 429 carries Retry-After as delta-seconds — back-pressure is its own
  // kind, never folded into `unavailable`. https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
  | (AppErrorCore<'rateLimited'> & { readonly retryAfterSeconds?: number })
  /** A database row-security policy refused the write (Postgres 42501). Kept
   * separate from `forbidden` so an operator can tell "the app said no" from
   * "the database said no" — they have completely different fixes. */
  | (AppErrorCore<'rlsDenied'> & { readonly relation?: string })
  /** A dependency is down, timing out, or shedding load. The ONLY kind for which
   * retrying the identical request is a sane client response. */
  | AppErrorCore<'unavailable'>
  /** Unclassified. Reaching this means something threw where nothing should
   * have; it is a bug report, not a user-facing explanation. */
  | AppErrorCore<'unknown'>

/** The discriminant's value set, derived from the union so the two cannot drift. */
export type AppErrorKind = AppError['kind']

/** Options accepted by every constructor. */
export interface AppErrorOptions {
  /** Override the kind's default code with a finer, still-stable identifier. */
  readonly code?: string
  /** Developer-facing English. Omit it rather than passing `undefined`. */
  readonly message?: string
}

/** `notFound` / `conflict` options: which thing. */
export interface ResourceErrorOptions extends AppErrorOptions {
  readonly resource?: string
}

/** `validation` options: which dot-paths failed. */
export interface ValidationErrorOptions extends AppErrorOptions {
  readonly fields?: readonly string[]
}

/** `rateLimited` options: how long the caller should wait, in whole seconds. */
export interface RetryAfterErrorOptions extends AppErrorOptions {
  readonly retryAfterSeconds?: number
}

/** `rlsDenied` options: which relation's policy refused. */
export interface RlsErrorOptions extends AppErrorOptions {
  readonly relation?: string
}

/**
 * Assemble the shared half of every variant.
 *
 * `message` is SPREAD conditionally instead of assigned. Two separate rules make
 * that necessary and they reinforce each other:
 *
 *  1. `exactOptionalPropertyTypes` — `{ message?: string }` and
 *     `{ message: string | undefined }` are different types, and only the first
 *     one models "the key is not there".
 *  2. `JSON.stringify` DROPS undefined-valued keys. An error built with
 *     `message: undefined` would not deep-equal itself after a JSON round-trip,
 *     so a cache comparison, a test assertion, or a React memo key would report
 *     a spurious change on every hop across the wire.
 *
 * Absent in, absent out.
 */
function core<K extends AppErrorKind>(kind: K, defaultCode: string, options: AppErrorOptions) {
  return {
    kind,
    code: options.code ?? defaultCode,
    ...(options.message === undefined ? {} : { message: options.message }),
  }
}

/**
 * The constructor namespace. Call sites read `appError.notFound({ resource:
 * 'note' })`, which is greppable per kind and makes an unmodelled failure
 * obvious: there is simply no function to call.
 */
export const appError = {
  /** No verified identity. The mobile normalize layer folds transport 401s here. */
  unauthorized: (options: AppErrorOptions = {}) => core('unauthorized', 'unauthorized', options),

  /** Identity verified, application rule refused. */
  forbidden: (options: AppErrorOptions = {}) => core('forbidden', 'forbidden', options),

  /** Absent, or filtered away by row security — deliberately indistinguishable. */
  notFound: (options: ResourceErrorOptions = {}) => ({
    ...core('notFound', 'not_found', options),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
  }),

  /** Uniqueness violation or a lost write race. */
  conflict: (options: ResourceErrorOptions = {}) => ({
    ...core('conflict', 'conflict', options),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
  }),

  /** Contract violation. `fields` are dot-paths, so a form can place each message. */
  validation: (options: ValidationErrorOptions = {}) => ({
    ...core('validation', 'validation_failed', options),
    ...(options.fields === undefined ? {} : { fields: options.fields }),
  }),

  // SOURCE: Retry-After is delta-seconds (a whole number of seconds), so the
  // field is seconds — never milliseconds, never a date string
  // https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
  rateLimited: (options: RetryAfterErrorOptions = {}) => ({
    ...core('rateLimited', 'rate_limited', options),
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
  }),

  /** A row-security policy refused the write. @see @app/supabase mapPostgresError. */
  rlsDenied: (options: RlsErrorOptions = {}) => ({
    ...core('rlsDenied', 'rls_denied', options),
    ...(options.relation === undefined ? {} : { relation: options.relation }),
  }),

  /** A dependency is down or shedding load — the one retryable kind. */
  unavailable: (options: AppErrorOptions = {}) => core('unavailable', 'unavailable', options),

  /** Unclassified. Produced by `toOutcome` when something throws. */
  unknown: (options: AppErrorOptions = {}) => core('unknown', 'unknown', options),
}

// Compile-time closure, BOTH directions. `_MissingConstructor` catches a kind
// added to the union with no constructor; `_StrayConstructor` catches a
// constructor whose key is not a kind (a typo), which would otherwise poison the
// runtime kind list below. Both must resolve to `never` for this line to
// compile, so the union and the namespace cannot drift apart silently.
type _MissingConstructor = Exclude<AppErrorKind, keyof typeof appError>
type _StrayConstructor = Exclude<keyof typeof appError, AppErrorKind>
type _KindClosure = [_MissingConstructor, _StrayConstructor] extends [never, never] ? true : never
const _kindClosure: _KindClosure = true

// The cast is the narrowing `Object.keys` cannot express (it is typed
// `string[]` for any object). It is sound HERE and only here, because the
// closure lock directly above proves the key set equals the kind set.
const sortedKinds = Object.keys(appError).sort() as AppErrorKind[]

/**
 * Every kind, at runtime, sorted for determinism (it feeds generated inventories
 * and snapshot assertions). DERIVED from the constructor namespace rather than
 * hand-listed: a second hand-maintained list is a second thing to forget.
 */
export const APP_ERROR_KINDS: readonly AppErrorKind[] = sortedKinds

// Set, not Array#includes: `includes` on a `readonly AppErrorKind[]` rejects a
// plain `string` argument, and widening the array's type to `string[]` to please
// it would discard exactly the checking this list exists for.
const KIND_SET: ReadonlySet<string> = new Set<string>(APP_ERROR_KINDS)

/**
 * Structural guard for values arriving from OUTSIDE the type system — a cached
 * payload read back from storage, a message posted across a bridge, a `catch`
 * binding. Inside the typed call graph you do not need it.
 *
 * Deliberately shallow: it checks the discriminant and the code, which is what
 * every consumer branches on. A deep validator here would need a schema library,
 * and the kernel imports nothing.
 *
 * @public consumed by the mobile normalize layer and by outcome de-serialization.
 */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { readonly kind?: unknown; readonly code?: unknown }
  return (
    typeof candidate.kind === 'string' &&
    KIND_SET.has(candidate.kind) &&
    typeof candidate.code === 'string'
  )
}

/** The success arm of the envelope. */
export interface OkOutcome<T> {
  readonly ok: true
  readonly data: T
}

/** The failure arm of the envelope. Carries the union, never an Error. */
export interface ErrOutcome {
  readonly ok: false
  readonly error: AppError
}

/**
 * The serializable envelope every operation returns.
 *
 * `ok` is a boolean literal discriminant rather than a `status: 'ok' | 'error'`
 * string because it narrows in a plain `if (outcome.ok)` with no import and no
 * helper — the shape a screen reaches for by reflex is the shape that already
 * type-narrows.
 */
export type ActionOutcome<T> = ErrOutcome | OkOutcome<T>

/** Lift a value into the success arm. */
export function outcomeOk<T>(data: T): ActionOutcome<T> {
  return { ok: true, data }
}

/**
 * Lift a failure into the failure arm. Returns `ActionOutcome<never>`, which is
 * assignable to `ActionOutcome<T>` for every `T` — so a failure path never has
 * to name the success type it is not producing.
 */
export function outcomeErr(error: AppError): ActionOutcome<never> {
  return { ok: false, error }
}

/**
 * Run `run` and wrap its result in the envelope; if it THROWS, return
 * `appError.unknown()`.
 *
 * This is the last line of defence at a boundary, not a general error-handling
 * idiom. Under the envelope rule a domain failure never throws, so anything
 * caught here is a programming fault or an infrastructure fault. It collapses to
 * `unknown` DELIBERATELY: guessing that an unclassified throw was really a
 * "not found" is how a 500 gets rendered as an empty list and the incident is
 * discovered by a customer instead of by a metric.
 *
 * The thrown value is NOT copied into `message` — a stack trace or a driver
 * error string on the wire is an information leak with no reader. Pass
 * `onThrow` to route the cause into @app/observability, which is where causes
 * belong.
 */
export function toOutcome<T>(run: () => T, onThrow?: (cause: unknown) => void): ActionOutcome<T> {
  try {
    return outcomeOk(run())
  } catch (cause) {
    onThrow?.(cause)
    return outcomeErr(appError.unknown())
  }
}

/**
 * `toOutcome` for an async thunk. A separate name rather than an overload
 * because an overload would let `toOutcome(async () => …)` typecheck while
 * returning `ActionOutcome<Promise<T>>` — an envelope wrapped around an
 * unawaited promise, whose rejection escapes the catch entirely.
 */
export async function toOutcomeAsync<T>(
  run: () => Promise<T>,
  onThrow?: (cause: unknown) => void,
): Promise<ActionOutcome<T>> {
  try {
    return outcomeOk(await run())
  } catch (cause) {
    onThrow?.(cause)
    return outcomeErr(appError.unknown())
  }
}

/** Narrowing predicate, for call sites that cannot use `if (outcome.ok)` directly. */
export function isOk<T>(outcome: ActionOutcome<T>): outcome is OkOutcome<T> {
  return outcome.ok
}

/**
 * The data, or `fallback` when the outcome failed. For read paths with a sane
 * neutral value (an empty list, a zero count) — never for writes, where
 * swallowing the error is the bug.
 */
export function unwrapOr<T>(outcome: ActionOutcome<T>, fallback: T): T {
  return outcome.ok ? outcome.data : fallback
}
