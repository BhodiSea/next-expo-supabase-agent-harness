import type { AppError, AppErrorKind } from '@app/errors'
import type { MessageKey } from './catalog'
import { t } from './index'

// Envelope copy: `AppError` → a catalog key → a rendered string.
//
// IT LIVES INSIDE THE SEAM, and the move is the point. Through 0.5.0 this was
// `apps/web/lib/error-copy.ts` holding its English inline — the single largest block of
// user-facing copy on this surface, sitting outside any catalog. The `i18n` gate would not
// have caught it even after the web root was added, because its object-literal rule matches
// `label|title|subtitle|description` keys and these are keyed by error kind. A gate that
// cannot see a file is a poor reason to leave the file wrong; the mobile twin
// (apps/mobile/src/i18n/errors.ts) already lived inside the seam, so this is the two
// surfaces agreeing rather than a new idea.
//
// COPY IS CHOSEN FROM `kind` + `code`, NEVER FROM `error.message`. `AppError.message` is
// documented as developer-facing English for logs: written by whichever layer constructed
// the error, unlocalized, and free to carry internals (a driver string, a constraint name, a
// relation). Rendering it is how "duplicate key value violates unique constraint notes_pkey"
// reaches a customer's screen.
// SOURCE: packages/platform/errors/src/index.ts (message is developer-facing; copy is chosen
// from kind + code on the client)

/**
 * TOTAL over `AppErrorKind` — a `Record`, not a partial one — so adding a kind to the
 * kernel's union is a COMPILE ERROR here rather than a silent fallthrough to "something went
 * wrong" that nobody notices until a user reports an unhelpful screen.
 */
const KEY_BY_KIND: Readonly<Record<AppErrorKind, MessageKey>> = {
  conflict: 'error.conflict',
  forbidden: 'error.forbidden',
  notFound: 'error.notFound',
  quotaExceeded: 'error.quotaExceeded',
  // `rateLimited` and `quotaExceeded` map to DIFFERENT copy on purpose, and the split is the
  // cited decision: retrying is the correct client response to 429, and it is exactly the
  // wrong response to a quota, which no amount of waiting frees.
  // SOURCE: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
  rateLimited: 'error.rateLimited',
  rlsDenied: 'error.rlsDenied',
  unauthorized: 'error.unauthorized',
  unavailable: 'error.unavailable',
  unknown: 'error.unknown',
  validation: 'error.validation',
}

/**
 * Per-CODE overrides, for the few failures this surface can act on specifically. Keyed by
 * `code` because that is the fine identity; `kind` alone would collapse "you are not in an
 * organization" into the same sentence as every other refusal, and the two need different
 * next actions from the reader.
 */
const KEY_BY_CODE: Readonly<Record<string, MessageKey>> = {
  org_context_required: 'error.code.org_context_required',
}

export function errorCopy(error: AppError): string {
  return t(KEY_BY_CODE[error.code] ?? KEY_BY_KIND[error.kind])
}
