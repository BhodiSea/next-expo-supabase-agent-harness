import { APP_ERROR_KINDS, appError } from '@app/errors'
import { describe, expect, it } from 'vitest'
import { errorCopy } from '../lib/i18n/errors'

// The rule this file exists to keep: user-facing copy comes from `kind` + `code`, NEVER
// from `error.message`. `message` is developer-facing English written by whichever layer
// constructed the error, and rendering it is how "duplicate key value violates unique
// constraint notes_pkey" reaches a customer's screen.
// SOURCE: packages/platform/errors/src/index.ts (message is developer-facing; copy is
// chosen from kind + code on the client)

describe('errorCopy', () => {
  // TOTALITY, at runtime. The BY_KIND map is typed `Record<AppErrorKind, string>`, so a
  // missing kind is a compile error — but only while the map stays exhaustive by TYPE. A
  // future refactor that widens it to a partial (or an `as` that silences the checker)
  // would compile and return `undefined` for the new kind, and `undefined` renders as an
  // empty error surface: the failure mode is a blank box, not a crash. APP_ERROR_KINDS is
  // DERIVED from the kernel's constructor namespace, so this iterates the real union.
  it.each(APP_ERROR_KINDS)('returns non-empty copy for the %s kind', (kind) => {
    const error = appError[kind]()
    const copy = errorCopy(error)
    expect(copy).toBeTypeOf('string')
    expect(copy.trim().length).toBeGreaterThan(0)
  })

  it('never leaks the developer-facing message', () => {
    // The one assertion that catches the whole failure class: a copy function that fell
    // back to `error.message` would pass every other test in this file.
    const leaky = {
      ...appError.conflict({ resource: 'note' }),
      message: 'duplicate key value violates unique constraint notes_pkey',
    }
    expect(errorCopy(leaky)).not.toContain('notes_pkey')
    expect(errorCopy(leaky)).not.toContain('duplicate key')
  })

  it('distinguishes quotaExceeded from rateLimited — waiting never clears a quota', () => {
    // These two are separate kinds precisely because the correct client response differs.
    // Copy that invites a retry on a quota teaches users to retry forever, so the absence
    // of retry language here is the assertion, not a stylistic preference.
    // SOURCE: docs/adr/20260203-resource-limits.md (quotaExceeded is deliberately NOT rateLimited)
    const quota = errorCopy(appError.quotaExceeded({ metric: 'notes', limit: 100 }))
    const rate = errorCopy(appError.rateLimited({ retryAfterSeconds: 30 }))
    expect(quota).not.toBe(rate)
    expect(quota.toLowerCase()).not.toMatch(/try again|wait/)
    expect(rate.toLowerCase()).toMatch(/try again/)
  })

  it('prefers a per-code override over the kind default', () => {
    // `org_context_required` is a forbidden-kind failure with a different next action:
    // "choose an organization", not "you do not have access". Collapsing it into the kind
    // default is what makes a recoverable state read as a dead end.
    const scoped = { ...appError.forbidden(), code: 'org_context_required' }
    expect(errorCopy(scoped)).not.toBe(errorCopy(appError.forbidden()))
    expect(errorCopy(scoped).toLowerCase()).toContain('organization')
  })

  it('falls back to the kind when the code has no override', () => {
    expect(errorCopy(appError.notFound({ resource: 'note' }))).toBe(errorCopy(appError.notFound()))
  })
})
