import { type ActionOutcome, type AppError, appError, outcomeErr } from '@app/errors'

// The fold from next-safe-action's result to THE envelope.
//
// next-safe-action reports three different outcomes — parsed-and-ran, failed-validation,
// threw — through three optional fields, and a caller left to inspect them itself re-derives
// this mapping (differently) at every call site. That is not hypothetical: it is exactly what
// this file was extracted from, two Server Actions that had drifted only in their copy.
//
// STRUCTURALLY TYPED, ON PURPOSE. `SafeActionResult` describes the shape rather than
// importing next-safe-action's own type, and that buys two things. The module stays free of
// a value import, so it is a pure function the web unit lane measures and a test can exhaust
// without a framework; and the action files keep the framework type at their own boundary,
// where it belongs, instead of re-exporting it into the UI layer.
// SOURCE: packages/platform/errors/src/index.ts (one envelope on the data channel; a domain
// failure is a returned value, never a throw)

/** The three channels a next-safe-action call can answer on. */
export interface SafeActionResult<T> {
  /** The action's own return — already an envelope, so it rides back unchanged. */
  readonly data?: ActionOutcome<T> | undefined
  /** Populated by handleServerError (lib/safe-action.ts), which returns an AppError. */
  readonly serverError?: AppError | undefined
  /** next-safe-action's per-field report. Deliberately `unknown`: see `invalid` below. */
  readonly validationErrors?: unknown
}

/** The two sentences only the call site can write. */
export interface ActionFailureCopy {
  /**
   * Shown when the input failed the contract. Stays GENERIC by design — field-level detail
   * belongs to the form, which holds the same zod contract and can validate before
   * submitting. Echoing the server's per-field report through this envelope would define a
   * second error vocabulary for every screen to learn. For a token-redeeming action it also
   * has to be indistinguishable from "expired or already used", or the message tells a
   * guesser whether their guess was well-formed — the first bit of a token oracle.
   */
  readonly invalid: string
  /** Shown on the unreachable-by-construction arm. Names the operation, not the cause. */
  readonly failed: string
}

/**
 * Collapse the three channels onto one, in the order the channels actually exclude each
 * other. The final arm is unreachable by construction — but "unreachable" is a claim about a
 * dependency, not a fact, and the alternative is returning `undefined` into a signature that
 * promises an outcome.
 *
 * `outcomeErr`, not `toOutcome`: `toOutcome(fn)` RUNS a thunk and wraps its result, catching
 * a throw. It is not a way to lift an already-built `AppError`. Lifting is what `outcomeErr`
 * is for, and `serverError` is already an `AppError` — re-wrapping it would lose its code.
 */
export function foldActionResult<T>(
  result: SafeActionResult<T>,
  copy: ActionFailureCopy,
): ActionOutcome<T> {
  if (result.data !== undefined) return result.data
  if (result.validationErrors !== undefined) {
    return outcomeErr(appError.validation({ message: copy.invalid }))
  }
  if (result.serverError !== undefined) return outcomeErr(result.serverError)
  return outcomeErr(appError.unknown({ message: copy.failed }))
}
