import type { AppError, AppErrorKind } from '@app/errors'

// User-facing copy for the envelope, chosen from `kind` + `code` — never from `error.message`.
//
// THAT RULE IS THE WHOLE POINT OF THIS FILE. `AppError.message` is documented as
// developer-facing English for logs: it is written by whichever layer constructed the error,
// it is not localized, and it can carry internals (a driver string, a constraint name, a
// relation). Rendering it is how "duplicate key value violates unique constraint
// notes_pkey" ends up on a customer's screen. `code` is the stable, machine-readable
// identity that a translation key is explicitly allowed to depend on.
//
// The map is TOTAL over AppErrorKind (`Record<AppErrorKind, string>`, not a partial one), so
// adding a kind to the kernel's union is a compile error here rather than a silent fallthrough
// to "something went wrong" that nobody notices until a user reports an unhelpful screen.
// SOURCE: packages/platform/errors/src/index.ts (message is developer-facing; copy is chosen
// from kind + code on the client)

const BY_KIND: Readonly<Record<AppErrorKind, string>> = {
  conflict: 'Someone else changed this first. Reload and try again.',
  forbidden: 'You do not have access to do that.',
  notFound: 'That is not here.',
  // No "try again" here, unlike rateLimited directly below, and the difference is the
  // whole reason the two kinds are separate: waiting does not free a quota. The only
  // actions that do are deleting rows or raising the ceiling, so the copy points at
  // those instead of inviting a retry that cannot succeed.
  // SOURCE: packages/platform/errors/src/index.ts (quotaExceeded carries no retry hint)
  quotaExceeded:
    'This organization has reached its limit. Remove some items, or contact an admin to raise it.',
  // "wait a moment and try again" rather than a number: the kernel carries
  // `retryAfterSeconds` when the server sent one, and inventing a duration here would
  // contradict it. Retrying IS the correct client response to 429 — unlike a quota, which
  // is not retryable and gets its own code.
  // SOURCE: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
  rateLimited: 'Too many attempts. Wait a moment and try again.',
  rlsDenied: 'You do not have access to do that.',
  unauthorized: 'Please sign in and try again.',
  unavailable: 'The service is temporarily unavailable. Try again shortly.',
  unknown: 'Something went wrong. Try again.',
  validation: 'Check the fields and try again.',
}

/**
 * Per-CODE overrides, for the few failures this surface can act on specifically. Keyed by
 * `code` because that is the fine identity; `kind` alone would collapse "you are not in an
 * organization" into the same sentence as every other refusal, and the two need different
 * next actions from the reader.
 */
const BY_CODE: Readonly<Record<string, string>> = {
  org_context_required: 'Choose an organization to continue.',
}

export function errorCopy(error: AppError): string {
  return BY_CODE[error.code] ?? BY_KIND[error.kind]
}
