import { appError, outcomeErr, outcomeOk } from '@app/errors'
import { describe, expect, it } from 'vitest'
import { foldActionResult } from '../lib/action-outcome'

// The fold from next-safe-action's three channels onto the one envelope. It was extracted in
// 0.4.0 from two Server Actions the duplication gate caught — which is the point of testing
// it here rather than through either action: the mapping is now ONE function, and a change to
// it changes both surfaces at once.
// SOURCE: apps/web/lib/action-outcome.ts

const COPY = { invalid: 'That input is not valid.', failed: 'The operation failed.' }

describe('foldActionResult', () => {
  it('passes the action’s own envelope through unchanged', () => {
    // `data` is ALREADY an ActionOutcome — re-wrapping it would nest an envelope in an
    // envelope and every screen's `outcome.ok` check would read the wrapper's discriminant.
    const inner = outcomeOk({ id: 'note-1' })
    expect(foldActionResult({ data: inner }, COPY)).toBe(inner)
  })

  it('passes a FAILED envelope through unchanged too', () => {
    // The data channel carries domain failures as values. A returned error outcome is the
    // action answering correctly, not the framework reporting a fault, so it must not be
    // re-mapped onto the generic copy.
    const inner = outcomeErr(appError.notFound({ resource: 'note' }))
    expect(foldActionResult({ data: inner }, COPY)).toBe(inner)
  })

  it('maps validationErrors to the kernel’s validation kind with the CALLER’s copy', () => {
    const out = foldActionResult({ validationErrors: { title: ['too short'] } }, COPY)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.error.kind).toBe('validation')
    expect(out.error.message).toBe(COPY.invalid)
  })

  it('never echoes the per-field report into the envelope', () => {
    // Field-level detail belongs to the form, which holds the same zod contract. Echoing the
    // server's report here would define a second error vocabulary for every screen — and for
    // a token-redeeming action it is also a guessing oracle.
    const out = foldActionResult({ validationErrors: { token: ['malformed base64url'] } }, COPY)
    expect(JSON.stringify(out)).not.toContain('base64url')
    expect(JSON.stringify(out)).not.toContain('token')
  })

  it('lifts serverError VERBATIM rather than re-wrapping it', () => {
    // handleServerError already returns an AppError. Re-wrapping would replace its code with
    // `unknown`, and the code is the only part of a failure a screen is allowed to branch on.
    const serverError = appError.rateLimited({ retryAfterSeconds: 30 })
    const out = foldActionResult({ serverError }, COPY)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.error).toBe(serverError)
    expect(out.error.code).toBe('rate_limited')
  })

  it('answers with the failed copy when every channel is empty', () => {
    // Unreachable by construction — and asserted anyway, because "unreachable" is a claim
    // about a dependency. The alternative is `undefined` leaking into a signature that
    // promises an outcome.
    const out = foldActionResult({}, COPY)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.error.kind).toBe('unknown')
    expect(out.error.message).toBe(COPY.failed)
  })

  it('prefers data over the other channels when more than one is present', () => {
    // Channel precedence is behaviour, not an accident of statement order: a result that
    // carries both a value and a stale validation report must answer with the value.
    const inner = outcomeOk({ id: 'note-1' })
    const out = foldActionResult(
      { data: inner, serverError: appError.unknown(), validationErrors: { a: ['b'] } },
      COPY,
    )
    expect(out).toBe(inner)
  })

  it('prefers validationErrors over serverError', () => {
    const out = foldActionResult(
      { serverError: appError.unavailable(), validationErrors: { a: ['b'] } },
      COPY,
    )
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.error.kind).toBe('validation')
  })
})
