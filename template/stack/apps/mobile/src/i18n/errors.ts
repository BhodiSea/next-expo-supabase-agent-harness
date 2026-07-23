import { TransportErrorCode } from '@app/contracts'
import { type AppError, type AppErrorKind, isAppError } from '@app/errors'
import type { MessageKey } from './catalog'
import { t } from './index'

// Turning a failure into copy a HUMAN can read.
//
// An error surface that renders `error.message` straight to the user is showing whatever
// string the server or the transport happened to produce — "UNAUTHORIZED", "Network request
// failed", a driver message on a bad day. It is English, it is untranslatable (it arrives at
// runtime, from another process), and it is not written for the person reading it.
//
// The envelope already carries the thing that IS a contract: `AppError`, a closed
// DISCRIMINATED UNION from @app/errors with a `kind` and a stable snake_case `code`. That is
// what the client localizes. The developer-facing `message` stays available — but as a
// technical DETAIL beneath the translated copy, where it belongs: it is for the person
// reading the support ticket, not the person filing it.
// SOURCE: @app/errors — `kind` is the COARSE class a screen branches on, `code` is the FINE
// identity a translation key is allowed to depend on

/**
 * One catalog key per AppError KIND. `satisfies Record<AppErrorKind, MessageKey>` is doing
 * real work in BOTH directions: a kind added to the kernel's union with no entry here is a
 * COMPILE error rather than a silently-untranslated string in production, and an entry whose
 * key is not in the catalog fails the same way. Neither list can drift from the other.
 */
const BY_KIND = {
  // A write that lost a race or violated a uniqueness rule. Retrying the identical write
  // fails identically, so the copy asks for a reload rather than offering a retry.
  conflict: 'error.api.conflict',
  // Identity verified, permission refused — and NOT the same sentence as `unauthorized`.
  // Telling a signed-in user to sign in sends them round a loop they cannot exit.
  forbidden: 'error.api.forbidden',
  notFound: 'error.api.not_found',
  rateLimited: 'error.api.rate_limited',
  // Deliberately the SAME copy as `forbidden`. The kernel keeps the two kinds apart so an
  // operator can tell "the app said no" from "the database's policy said no" — completely
  // different fixes — but the person on the phone is refused either way, and inventing a
  // second sentence for them would leak which layer refused.
  rlsDenied: 'error.api.forbidden',
  unauthorized: 'error.api.unauthorized',
  // The only retryable kind, and the only one that is honest about the network: the request
  // never reached a procedure. "Something went wrong on the server" is a lie in a tunnel,
  // and it sends the user to support instead of to their signal bars.
  unavailable: 'error.api.offline',
  unknown: 'error.api.internal',
  validation: 'error.api.bad_request',
} as const satisfies Record<AppErrorKind, MessageKey>

/**
 * CODE overrides, consulted before the kind map. The kernel's contract is that two failures
 * can share a `kind` and differ by `code`, and version skew is exactly that case: it arrives
 * as `conflict` (the skew guard is the only thing on this router that throws one), but "this
 * app is out of date" and "that write lost a race" are not the same instruction to the user.
 * SOURCE: packages/api/src/skew.ts · @app/contracts TransportErrorCode
 */
const BY_CODE = {
  [TransportErrorCode.enum.version_skew]: 'error.api.version_skew',
} as const satisfies Record<string, MessageKey>

export interface UserFacingError {
  /** Translated copy — what the user is actually asked to read. */
  readonly message: string
  /** The raw underlying message. A technical detail, shown quietly; never the headline. */
  readonly detail: string | null
  /**
   * The envelope's stable machine code, quoted next to the failure so "it failed" becomes a
   * ticket an engineer can trace. It replaces the request id the inherited HTTP transport
   * minted per response: tRPC carries no such header, and echoing a field that is always
   * null would be chrome pretending to be provenance. `code` is real, stable, and greppable
   * in the server's logs, which is what the request id was actually for.
   */
  readonly code: string | null
}

/** The catalog key for a failure: fine `code` first, coarse `kind` as the floor. */
function keyFor(error: AppError): MessageKey {
  const override = (BY_CODE as Partial<Record<string, MessageKey>>)[error.code]
  return override ?? BY_KIND[error.kind as AppErrorKind]
}

/**
 * Translate any value into user-facing copy. Never throws, never returns an empty string: a
 * failure that cannot be described is still a failure the user must be told about.
 *
 * It takes `unknown` rather than `AppError` on purpose. Everything that crosses
 * `callProcedure` is already an envelope, but the screens also handle values from outside
 * the typed graph — a Supabase `AuthError`, a throw from a native module, a rejected promise
 * in a hook's own plumbing. `isAppError` is the kernel's own structural guard for exactly
 * that boundary; anything it rejects lands in the honest fallback below.
 */
export function translateError(cause: unknown): UserFacingError {
  if (isAppError(cause)) {
    return {
      message: t(keyFor(cause)),
      detail: cause.message ?? null,
      code: cause.code,
    }
  }
  // Not an envelope at all: the failure never reached (or never came back through) the
  // transport. "Could not reach the server" is honest about the only thing we actually know.
  return {
    message: t('error.api.offline'),
    detail: cause instanceof Error ? cause.message : String(cause),
    code: null,
  }
}
