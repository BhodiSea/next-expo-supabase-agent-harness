// The mapper's two invariants, both of which are silent when broken:
//   1. THE EMPTY-SET PRINCIPLE — a read that finds nothing is `notFound`, never
//      a denial. Break it and every id in the table becomes an existence oracle.
//   2. NO DRIVER TEXT ON THE WIRE — PostgREST's message/details/hint quote
//      column names, constraint definitions and sometimes row VALUES. Break it
//      and row content is rendered on a user's screen.
import { describe, expect, it } from 'vitest'
import { isRlsDenied, mapPostgresError, type PostgresFailure, readMiss } from './errors.js'

const failure = (code: string | undefined, message = 'driver text'): PostgresFailure =>
  code === undefined ? { message } : { code, message }

describe('the empty-set principle', () => {
  it('reports a read miss as notFound, never as a denial', () => {
    expect(readMiss()).toEqual({ kind: 'notFound', code: 'not_found' })
    expect(readMiss('note')).toEqual({ kind: 'notFound', code: 'not_found', resource: 'note' })
  })

  it('maps PostgREST "no rows" to notFound rather than forbidden or rlsDenied', () => {
    // PGRST116 is what `.single()` raises when RLS filtered the row away AND
    // what it raises when the row genuinely does not exist. The two are the same
    // observation; distinguishing them in the response is the leak.
    const mapped = mapPostgresError(failure('PGRST116'), { resource: 'note' })
    expect(mapped.kind).toBe('notFound')
  })

  it('never produces forbidden — an application rule is not the database', () => {
    const codes = ['42501', '23505', '23503', '23502', '23514', '22P02', 'PGRST116', 'PGRST301']
    for (const code of codes) {
      expect(mapPostgresError(failure(code)).kind).not.toBe('forbidden')
    }
  })
})

describe('mapPostgresError', () => {
  it('maps 42501 to rlsDenied and carries the relation for the operator', () => {
    const mapped = mapPostgresError(failure('42501'), { relation: 'notes' })
    expect(mapped).toMatchObject({ kind: 'rlsDenied', code: 'rls_denied', relation: 'notes' })
  })

  it('omits the relation rather than carrying it as undefined', () => {
    const mapped = mapPostgresError(failure('42501'))
    // JSON.stringify drops undefined-valued keys, so a present-but-undefined
    // relation would stop the error deep-equalling itself across the wire.
    expect(Object.hasOwn(mapped, 'relation')).toBe(false)
  })

  it('maps 23505 unique violation to conflict', () => {
    const mapped = mapPostgresError(failure('23505'), { resource: 'note' })
    expect(mapped).toMatchObject({ kind: 'conflict', code: 'unique_violation', resource: 'note' })
  })

  it('maps 23503 foreign key to validation, not conflict', () => {
    // `conflict` tells a client to retry. Retrying an identical write against a
    // parent row that is not there fails identically, forever.
    expect(mapPostgresError(failure('23503'))).toMatchObject({
      kind: 'validation',
      code: 'foreign_key_violation',
    })
  })

  it('maps constraint and cast failures to validation', () => {
    for (const code of ['23502', '23514', '22P02']) {
      expect(mapPostgresError(failure(code))).toMatchObject({
        kind: 'validation',
        code: 'constraint_violation',
      })
    }
  })

  it('maps lost write races to conflict — re-read, then retry', () => {
    for (const code of ['40001', '40P01']) {
      expect(mapPostgresError(failure(code)).kind).toBe('conflict')
    }
  })

  it('maps a rejected JWT to unauthorized, distinct from a policy denial', () => {
    // Re-authenticating fixes this one and cannot fix 42501. Folding them
    // together loops a client through a login it already holds.
    expect(mapPostgresError(failure('PGRST301'))).toMatchObject({
      kind: 'unauthorized',
      code: 'session_expired',
    })
    expect(mapPostgresError(failure('42501')).kind).toBe('rlsDenied')
  })

  it('maps a missing RPC to unknown — there is no client-side remedy', () => {
    expect(mapPostgresError(failure('PGRST202'))).toMatchObject({
      kind: 'unknown',
      code: 'rpc_not_found',
    })
  })

  // 53400 is `configuration_limit_exceeded`, which the quota trigger raises. It sits in
  // class 53 — the same class as 53300 (too_many_connections) — and class 53 is otherwise
  // mapped to the retryable `unavailable`. That adjacency is the whole point of this test:
  // if the QUOTA_EXCEEDED case were removed or reordered below the class fallback, a quota
  // refusal would be reported as transient and every client would retry a write that
  // cannot succeed until somebody upgrades their plan. Nothing else in the suite could
  // tell the difference, which is why the mutation lane found all four branches here alive.
  it('maps 53400 to quotaExceeded — NOT to the retryable class-53 fallback beneath it', () => {
    const mapped = mapPostgresError(failure('53400'), { resource: 'note' })
    expect(mapped.kind).toBe('quotaExceeded')
    expect(mapped.kind).not.toBe('unavailable')
    // The driver text quotes the org id and the raw counts, so it must not reach a screen:
    // the message is the module's own, fixed string.
    expect(mapped).toMatchObject({ message: 'a per-org quota refused the write' })
    expect(JSON.stringify(mapped)).not.toContain('driver text')
    // Its class-53 neighbour still maps the other way — a mutant that collapsed the two
    // would have to break this line as well.
    expect(mapPostgresError(failure('53300')).kind).toBe('unavailable')
  })

  it('treats only the transient SQLSTATE classes as retryable', () => {
    for (const code of ['08006', '53300', '57014']) {
      expect(mapPostgresError(failure(code)).kind).toBe('unavailable')
    }
    // 42P01 (undefined_table) is permanent. Calling it retryable would have a
    // client hammer a database that rejected the query on its merits.
    expect(mapPostgresError(failure('42P01')).kind).toBe('unknown')
  })

  it('does not guess "transient" for a failure with no code at all', () => {
    // DNS, TLS, a dead pooler — all arrive codeless. An absent code means we do
    // not know what happened, and "retry" is the expensive wrong guess.
    expect(mapPostgresError(failure(undefined))).toMatchObject({
      kind: 'unknown',
      code: 'database_rejected',
    })
  })
})

describe('driver text containment', () => {
  it('never forwards message, details or hint onto the error channel', () => {
    const leaky: PostgresFailure = {
      code: '23505',
      details: 'Key (email)=(person@example.test) already exists.',
      hint: 'see constraint notes_email_key',
      message: 'duplicate key value violates unique constraint "notes_email_key"',
    }
    const serialized = JSON.stringify(mapPostgresError(leaky, { resource: 'note' }))
    expect(serialized).not.toContain('person@example.test')
    expect(serialized).not.toContain('notes_email_key')
    expect(serialized).not.toContain('duplicate key')
  })

  it('produces a JSON-safe error for every code it knows', () => {
    const codes = [
      '42501',
      '23505',
      '23503',
      '23502',
      '23514',
      '22P02',
      '40001',
      '40P01',
      'PGRST116',
      'PGRST301',
      'PGRST202',
      '08006',
      'nope',
    ]
    for (const code of codes) {
      const mapped = mapPostgresError(failure(code), { relation: 'notes', resource: 'note' })
      expect(JSON.parse(JSON.stringify(mapped))).toEqual(mapped)
      expect(mapped).not.toBeInstanceOf(Error)
    }
  })
})

describe('isRlsDenied', () => {
  it('is true only for 42501', () => {
    expect(isRlsDenied({ code: '42501', message: 'x' })).toBe(true)
    expect(isRlsDenied({ code: '23505', message: 'x' })).toBe(false)
    expect(isRlsDenied({ message: 'x' })).toBe(false)
  })
})

// --- R3c mutation-kill tests (added by triage) ---
describe('the lost-race conflict carries its fine identity', () => {
  it('maps 40001 and 40P01 to code write_conflict and carries the resource', () => {
    for (const code of ['40001', '40P01']) {
      expect(mapPostgresError(failure(code), { resource: 'note' })).toMatchObject({
        kind: 'conflict',
        code: 'write_conflict',
        resource: 'note',
      })
    }
  })
})
