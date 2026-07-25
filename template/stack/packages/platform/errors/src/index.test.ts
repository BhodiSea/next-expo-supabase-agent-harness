// The kernel's two invariants, both of which are silent when broken:
//   1. SERIALIZATION — every variant survives a JSON round-trip with its
//      discriminant intact. Break it and screens start rendering the default
//      branch of a switch that still compiles.
//   2. CLOSURE — the union, the constructor namespace, and the runtime kind
//      list name exactly the same set. Break it and a new kind ships with no
//      constructor, or a constructor ships that no screen can ever receive.
import { describe, expect, it, vi } from 'vitest'
import type { ActionOutcome, AppError, AppErrorKind } from './index.js'
import {
  APP_ERROR_KINDS,
  appError,
  isAppError,
  isOk,
  outcomeErr,
  outcomeOk,
  toOutcome,
  toOutcomeAsync,
  unwrapOr,
} from './index.js'

// One fully-populated instance per kind — every optional field present, so the
// round-trip assertions exercise the widest shape each variant can take.
const SAMPLES: Readonly<Record<AppErrorKind, AppError>> = {
  unauthorized: appError.unauthorized({ message: 'no bearer token' }),
  forbidden: appError.forbidden({ code: 'not_a_member', message: 'not in this workspace' }),
  notFound: appError.notFound({ resource: 'note', message: 'no such note' }),
  conflict: appError.conflict({ resource: 'note', code: 'title_taken' }),
  validation: appError.validation({ fields: ['title', 'body.blocks.0'], message: 'bad input' }),
  rateLimited: appError.rateLimited({ retryAfterSeconds: 30 }),
  rlsDenied: appError.rlsDenied({ relation: 'notes' }),
  unavailable: appError.unavailable({ message: 'database unreachable' }),
  unknown: appError.unknown(),
}

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown

describe('AppError closure', () => {
  it('names the same kinds in the union, the namespace, and the runtime list', () => {
    // Object.keys of the samples map is typed by AppErrorKind, so a kind added
    // to the union without a sample fails to compile before it reaches here.
    expect([...APP_ERROR_KINDS]).toEqual(Object.keys(SAMPLES).sort())
    expect(APP_ERROR_KINDS).toHaveLength(9)
  })

  it('gives every constructor its own discriminant and a non-empty stable code', () => {
    for (const kind of APP_ERROR_KINDS) {
      const error = SAMPLES[kind]
      expect(error.kind).toBe(kind)
      expect(error.code).not.toBe('')
      expect(typeof error.code).toBe('string')
    }
  })

  it('defaults the code per kind and lets a call site narrow it', () => {
    expect(appError.notFound().code).toBe('not_found')
    expect(appError.validation().code).toBe('validation_failed')
    expect(appError.rateLimited().code).toBe('rate_limited')
    expect(appError.rlsDenied().code).toBe('rls_denied')
    // A narrower code never changes the kind — screens keep one branch.
    const narrowed = appError.validation({ code: 'title_too_long' })
    expect(narrowed).toEqual({ kind: 'validation', code: 'title_too_long' })
  })

  it('is exhaustively switchable — an added kind reds this switch at compile time', () => {
    const describeKind = (error: AppError): string => {
      switch (error.kind) {
        case 'unauthorized':
          return 'sign in'
        case 'forbidden':
          return 'application rule refused'
        case 'notFound':
          return `absent: ${error.resource ?? 'resource'}`
        case 'conflict':
          return `conflict: ${error.resource ?? 'resource'}`
        case 'validation':
          return `invalid: ${(error.fields ?? []).join(',')}`
        case 'rateLimited':
          return `retry in ${String(error.retryAfterSeconds ?? 0)}s`
        case 'rlsDenied':
          return `policy refused: ${error.relation ?? 'relation'}`
        case 'unavailable':
          return 'dependency down'
        case 'unknown':
          return 'unclassified'
        default: {
          // Unreachable while the switch is exhaustive. If a kind is added to
          // the union and NOT handled above, `error` is no longer `never` here
          // and this assignment stops compiling — which is the whole reason
          // failures are modelled as a discriminated union.
          const exhaustive: never = error
          return exhaustive
        }
      }
    }

    for (const kind of APP_ERROR_KINDS) {
      expect(describeKind(SAMPLES[kind])).not.toBe('')
    }
  })
})

describe('serialization', () => {
  it('round-trips every variant through JSON with the discriminant intact', () => {
    for (const kind of APP_ERROR_KINDS) {
      const error = SAMPLES[kind]
      const revived = roundTrip(error)
      expect(revived).toEqual(error)
      expect((revived as AppError).kind).toBe(kind)
      expect(isAppError(revived)).toBe(true)
    }
  })

  it('round-trips the envelope itself, on both arms', () => {
    const success: ActionOutcome<{ id: string }> = outcomeOk({ id: 'note-1' })
    expect(roundTrip(success)).toEqual(success)

    for (const kind of APP_ERROR_KINDS) {
      const failure = outcomeErr(SAMPLES[kind])
      expect(roundTrip(failure)).toEqual(failure)
    }
  })

  it('omits an unset message rather than carrying it as undefined', () => {
    const bare = appError.unauthorized()
    // JSON.stringify DROPS undefined-valued keys, so a present-but-undefined
    // message would make an error stop deep-equalling itself across the wire.
    expect(Object.hasOwn(bare, 'message')).toBe(false)
    expect(roundTrip(bare)).toEqual(bare)
    expect(JSON.stringify(bare)).toBe('{"kind":"unauthorized","code":"unauthorized"}')
  })

  it('carries no Error instances, Symbols, or Dates on the error channel', () => {
    for (const kind of APP_ERROR_KINDS) {
      const error = SAMPLES[kind]
      expect(error).not.toBeInstanceOf(Error)
      expect(Object.getOwnPropertySymbols(error)).toHaveLength(0)
      for (const value of Object.values(error)) {
        expect(value).not.toBeInstanceOf(Date)
        const primitive = typeof value === 'string' || typeof value === 'number'
        expect(primitive || Array.isArray(value)).toBe(true)
      }
    }
  })
})

describe('isAppError', () => {
  it('accepts every constructed variant and rejects lookalikes', () => {
    for (const kind of APP_ERROR_KINDS) expect(isAppError(SAMPLES[kind])).toBe(true)
    expect(isAppError(null)).toBe(false)
    expect(isAppError('notFound')).toBe(false)
    expect(isAppError(new Error('boom'))).toBe(false)
    expect(isAppError({ kind: 'teapot', code: 'teapot' })).toBe(false)
    expect(isAppError({ kind: 'notFound' })).toBe(false) // no code
  })
})

describe('the envelope', () => {
  it('narrows on ok and exposes the data', () => {
    const outcome: ActionOutcome<number> = outcomeOk(42)
    expect(isOk(outcome)).toBe(true)
    expect(unwrapOr(outcome, 0)).toBe(42)
    if (!isOk(outcome)) throw new Error('expected the success arm')
    expect(outcome.data).toBe(42)
  })

  it('narrows on failure and exposes the union', () => {
    const outcome: ActionOutcome<number> = outcomeErr(appError.notFound({ resource: 'note' }))
    expect(isOk(outcome)).toBe(false)
    expect(unwrapOr(outcome, 0)).toBe(0)
    if (isOk(outcome)) throw new Error('expected the failure arm')
    // The discriminant survived the envelope: the screen switches, it does not
    // parse a message string.
    expect(outcome.error.kind).toBe('notFound')
    expect(outcome.error).toEqual({ kind: 'notFound', code: 'not_found', resource: 'note' })
  })

  it('collapses a throw to unknown and hands the cause to the observer', () => {
    const onThrow = vi.fn<(cause: unknown) => void>()
    const outcome = toOutcome<number>(() => {
      throw new Error('driver exploded: connection string localhost:5432')
    }, onThrow)

    expect(outcome).toEqual({ ok: false, error: { kind: 'unknown', code: 'unknown' } })
    // The thrown text never reaches the envelope — a driver string on the wire
    // is an information leak with no reader.
    expect(JSON.stringify(outcome)).not.toContain('driver exploded')
    expect(onThrow).toHaveBeenCalledTimes(1)
    expect(onThrow.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('passes a non-throwing thunk straight through', () => {
    expect(toOutcome(() => 'value')).toEqual({ ok: true, data: 'value' })
  })

  it('collapses a rejection to unknown in the async form', async () => {
    const onThrow = vi.fn<(cause: unknown) => void>()
    const outcome = await toOutcomeAsync<string>(
      () => Promise.reject(new Error('timeout')),
      onThrow,
    )
    expect(outcome).toEqual({ ok: false, error: { kind: 'unknown', code: 'unknown' } })
    expect(onThrow).toHaveBeenCalledTimes(1)

    expect(await toOutcomeAsync(() => Promise.resolve(7))).toEqual({ ok: true, data: 7 })
  })
})
