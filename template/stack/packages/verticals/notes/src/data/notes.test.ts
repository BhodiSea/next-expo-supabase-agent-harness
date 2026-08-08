import { appError } from '@app/errors'
import { beforeEach, describe, expect, it } from 'vitest'
import { decodeNotesCursor, encodeNotesCursor } from '../domain/cursor.js'
import type { NoteEvent } from '../events.js'
import {
  createNote,
  deleteNote,
  getNote,
  listAuthoredNotes,
  listNotes,
  type NoteWriteContext,
  updateNote,
} from './notes.js'
import type { NotesDatabase, PostgrestOutcome, PostgrestQuery, PostgrestTable } from './port.js'
import { NOTE_COLUMNS } from './rows.js'

// ---------------------------------------------------------------------------
// A fake PostgREST client, in twenty lines. This is the payoff of typing the
// DAL against a structural port instead of a concrete Supabase client: the
// branches that matter most — an RLS denial, a row that no longer matches its
// contract, a delete that hits nothing — are the ones a live database will not
// produce on demand, and here they are one literal away.
//
// It also RECORDS every call, so the tests can assert the query that was built
// (the projection, the ordering, the keyset filter) and not merely the value
// that came back.
// ---------------------------------------------------------------------------

type Call = [method: string, ...args: unknown[]]

function fakeDatabase(outcome: PostgrestOutcome): { calls: Call[]; db: NotesDatabase } {
  const calls: Call[] = []
  const record = (method: string, ...args: unknown[]): void => {
    calls.push([method, ...args])
  }

  // A real Promise wearing the builder's methods: awaiting the chain resolves
  // the scripted outcome, exactly as PostgREST's thenable builder does.
  const query: PostgrestQuery = Object.assign(Promise.resolve(outcome), {
    eq: (column: string, value: string): PostgrestQuery => {
      record('eq', column, value)
      return query
    },
    is: (column: string, value: null): PostgrestQuery => {
      record('is', column, value)
      return query
    },
    limit: (count: number): PostgrestQuery => {
      record('limit', count)
      return query
    },
    lte: (column: string, value: string): PostgrestQuery => {
      record('lte', column, value)
      return query
    },
    or: (filters: string): PostgrestQuery => {
      record('or', filters)
      return query
    },
    order: (column: string, options: { readonly ascending: boolean }): PostgrestQuery => {
      record('order', column, options)
      return query
    },
    select: (columns: string): PostgrestQuery => {
      record('select', columns)
      return query
    },
  })

  const table: PostgrestTable = {
    delete: (): PostgrestQuery => {
      record('delete')
      return query
    },
    insert: (values: Readonly<Record<string, unknown>>): PostgrestQuery => {
      record('insert', values)
      return query
    },
    select: (columns: string): PostgrestQuery => {
      record('select', columns)
      return query
    },
    update: (values: Readonly<Record<string, unknown>>): PostgrestQuery => {
      record('update', values)
      return query
    },
  }

  const db: NotesDatabase = {
    from: (name: string): PostgrestTable => {
      record('from', name)
      return table
    },
  }

  return { calls, db }
}

const rows = (data: unknown): PostgrestOutcome => ({ data, error: null })
const denied = (code: string): PostgrestOutcome => ({
  data: null,
  error: { code, message: 'new row violates row-level security policy for table "notes"' },
})

const ACTOR_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
const NOW = '2026-06-01T12:00:00.000+00:00'

function row(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const suffix = String(index).padStart(2, '0')
  return {
    archived_at: null,
    body: `body ${index}`,
    created_at: `2026-01-${suffix}T00:00:00.000000+00:00`,
    id: `3f2504e0-4f89-41d3-9a0c-0305e82c33${suffix}`,
    owner_id: ACTOR_ID,
    title: `note ${index}`,
    updated_at: `2026-01-${suffix}T00:00:00.000000+00:00`,
    ...overrides,
  }
}

let emitted: NoteEvent[] = []
const writeContext = (): NoteWriteContext => ({
  actorId: ACTOR_ID,
  emit: (event) => {
    emitted.push(event)
  },
  now: NOW,
  orgId: ORG_ID,
})

/** The read half of the same scope, for the two functions that take no write context. */
const scope = { orgId: ORG_ID }

beforeEach(() => {
  emitted = []
})

const listQuery = { includeArchived: false, limit: 50 }

describe('listNotes', () => {
  it('returns the render shape, never a raw row', async () => {
    const { db } = fakeDatabase(rows([row(1, { body: 'hello world' })]))
    const outcome = await listNotes(db, scope, listQuery)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const [item] = outcome.data.items
    expect(item).toEqual({
      createdAt: '2026-01-01T00:00:00.000000+00:00',
      excerpt: 'hello world',
      hasBody: true,
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      isArchived: false,
      title: 'note 1',
      updatedAt: '2026-01-01T00:00:00.000000+00:00',
    })
    // The two columns that must NOT reach a surface.
    expect(item).not.toHaveProperty('ownerId')
    expect(item).not.toHaveProperty('body')
  })

  // The DAL half of the orphaned-row regression (rows.test.ts holds the parser half).
  // The blast radius is what makes this worth its own case: the row parse sits inside
  // listNotes' try/catch, so ONE note whose author has left the company would take the
  // whole page down as `contractDrift` — an internal error for every reader in the org,
  // not a missing byline on one card.
  it('serves a page containing a note whose owner was deleted', async () => {
    const { db } = fakeDatabase(rows([row(1), row(2, { owner_id: null })]))
    const outcome = await listNotes(db, scope, listQuery)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.items).toHaveLength(2)
    // And it is still a VIEW: losing attribution must not start leaking the column.
    for (const item of outcome.data.items) expect(item).not.toHaveProperty('ownerId')
  })

  it('builds the query the keyset index was created for', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    await listNotes(db, scope, listQuery)

    expect(calls).toContainEqual(['from', 'notes'])
    expect(calls).toContainEqual(['select', NOTE_COLUMNS])
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(calls).toContainEqual(['order', 'id', { ascending: false }])
    // limit + 1: the sentinel row is the has-more probe.
    expect(calls).toContainEqual(['limit', 51])
  })

  it('hides archived notes by default and includes them on request', async () => {
    const hidden = fakeDatabase(rows([]))
    await listNotes(hidden.db, scope, listQuery)
    expect(hidden.calls).toContainEqual(['is', 'archived_at', null])

    const shown = fakeDatabase(rows([]))
    await listNotes(shown.db, scope, { ...listQuery, includeArchived: true })
    expect(shown.calls.some(([method]) => method === 'is')).toBe(false)
  })

  it('clamps the page size below the DAL — no caller can demand an unbounded scan', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    await listNotes(db, scope, { ...listQuery, limit: 10_000 })
    expect(calls).toContainEqual(['limit', 201])
  })

  it('mints a next cursor only when the sentinel row came back', async () => {
    const page = Array.from({ length: 3 }, (_, index) => row(index + 1))
    const short = fakeDatabase(rows(page))
    const shortOutcome = await listNotes(short.db, scope, { ...listQuery, limit: 3 })
    expect(shortOutcome.ok && shortOutcome.data.nextCursor).toBeNull()

    const full = fakeDatabase(rows([...page, row(4)]))
    const fullOutcome = await listNotes(full.db, scope, { ...listQuery, limit: 3 })
    expect(fullOutcome.ok).toBe(true)
    if (!fullOutcome.ok) return
    expect(fullOutcome.data.items).toHaveLength(3)
    // The cursor is the LAST RETURNED row's key — not the sentinel's, which the
    // caller never saw and must therefore receive on the next page.
    expect(decodeNotesCursor(fullOutcome.data.nextCursor ?? '')).toEqual({
      createdAt: '2026-01-03T00:00:00.000000+00:00',
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
    })
  })

  it('sends the cursor as an indexable RANGE plus a tie-break, never as one disjunction', async () => {
    const cursor = encodeNotesCursor({
      createdAt: '2026-01-03T00:00:00.000000+00:00',
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
    })
    const { calls, db } = fakeDatabase(rows([]))
    await listNotes(db, scope, { ...listQuery, cursor })

    // BOTH predicates, and the split is the assertion. The single-disjunction
    // spelling this replaced (`created_at.lt.X, and(created_at.eq.X, id.lt.Y)`)
    // is logically identical and quietly O(page number): PostgreSQL cannot turn
    // a top-level OR into an index range, so the scan still starts at the
    // tenant's newest row and discards everything already shown. Measured on
    // 1.1M rows at page 1000: 1115 rows removed by filter, versus 3.
    expect(calls).toContainEqual(['lte', 'created_at', '2026-01-03T00:00:00.000000+00:00'])
    expect(calls).toContainEqual([
      'or',
      'created_at.lt."2026-01-03T00:00:00.000000+00:00",id.lt."3f2504e0-4f89-41d3-9a0c-0305e82c3303"',
    ])
  })

  it('rejects a cursor that is not one we minted, and never queries', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    const outcome = await listNotes(db, scope, { ...listQuery, cursor: 'AAAA' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.validation({
        code: 'invalid_cursor',
        fields: ['cursor'],
        message: 'the page cursor is not one this server minted',
      }),
    )
    expect(calls).toEqual([])
  })

  it('reports an RLS denial as rlsDenied, NOT as an empty list', async () => {
    // PostgREST resolves rather than rejects, so a DAL that read `data` before
    // `error` would render this as "you have no notes".
    //
    // `rlsDenied` rather than `forbidden`: the distinction is for the operator —
    // one means the application said no, the other means the database said no,
    // and they have completely different fixes.
    const { db } = fakeDatabase(denied('42501'))
    const outcome = await listNotes(db, scope, listQuery)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.rlsDenied({
        relation: 'notes',
        message: 'a row-security policy refused the list',
      }),
    )
  })

  it('reports a row that no longer matches its contract as an internal fault', async () => {
    const { db } = fakeDatabase(rows([row(1, { title: undefined })]))
    const outcome = await listNotes(db, scope, listQuery)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'contract_drift',
        message: 'a notes row did not match its contract during the list',
      }),
    )
  })

  it('survives a protocol surprise in the data channel', async () => {
    const { db } = fakeDatabase({ data: 'not rows', error: null })
    const outcome = await listNotes(db, scope, listQuery)
    expect(outcome.ok && outcome.data.items).toEqual([])
  })
})

describe('getNote', () => {
  const ref = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }

  it('returns the view for a visible note', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok && outcome.data.id).toBe(ref.id)
    expect(calls).toContainEqual(['eq', 'id', ref.id])
    expect(calls).toContainEqual(['limit', 1])
  })

  it('reports notFound — never forbidden — when nothing comes back', async () => {
    // RLS filters SELECT rather than failing it, so "hidden" and "gone" are the
    // same empty result. Distinguishing them would turn every uuid in the table
    // into an existence oracle.
    const { db } = fakeDatabase(rows([]))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(appError.notFound({ resource: 'note' }))
  })

  it('maps a rejected JWT to unauthorized (re-authenticating CAN fix it)', async () => {
    const { db } = fakeDatabase(denied('PGRST301'))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unauthorized({
        code: 'session_expired',
        message: 'the access token was rejected',
      }),
    )
  })

  it('never forwards the driver message (it quotes columns, constraints and values)', async () => {
    const { db } = fakeDatabase({
      data: null,
      error: { code: '08006', message: 'connection to server at "10.0.0.4" failed' },
    })
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(JSON.stringify(outcome.error)).not.toContain('10.0.0.4')
    // SQLSTATE class 08 is a connection exception: retrying the identical
    // request IS sane, so it maps to the one retryable kind.
    expect(outcome.error).toEqual(
      appError.unavailable({ message: 'the notes store was unreachable during the read' }),
    )
  })

  it('maps an unrecognised SQLSTATE to unknown, never to a retry hint', async () => {
    // Telling a client to retry a permanent failure just multiplies the load
    // that caused it.
    const { db } = fakeDatabase({ data: null, error: { code: '42P01', message: 'no such table' } })
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'notes_store_rejected',
        message: 'the notes store rejected the read',
      }),
    )
  })
})

describe('createNote', () => {
  it('takes the tenant key and the attribution from CONTEXT, never from the input', async () => {
    // The smuggle probe. `CreateNoteSchema` carries neither field, so a caller
    // that supplies them is doing something the contract cannot express — and the
    // insert must still carry the CONTEXT's values. This is the unit-level twin of
    // the supabase-js suite's cross-tenant INSERT assertion: there the database
    // refuses, here the DAL never even offers it the chance.
    const { calls, db } = fakeDatabase(rows([row(1)]))
    const hostile = {
      org_id: '00000000-0000-4000-8000-0000000000ff',
      owner_id: '00000000-0000-4000-8000-0000000000fe',
      title: 'smuggled',
    } as unknown as Parameters<typeof createNote>[2]
    await createNote(db, writeContext(), hostile)

    expect(calls).toContainEqual([
      'insert',
      { body: '', org_id: ORG_ID, owner_id: ACTOR_ID, title: 'smuggled' },
    ])
  })

  it('takes owner_id from the verified actor and never from the input', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    await createNote(db, writeContext(), { body: 'hello', title: '  spaced   title ' })

    expect(calls).toContainEqual([
      'insert',
      { body: 'hello', org_id: ORG_ID, owner_id: ACTOR_ID, title: 'spaced title' },
    ])
    expect(calls).toContainEqual(['select', NOTE_COLUMNS])
  })

  it('substitutes the empty body so both insert paths return the same shape', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    await createNote(db, writeContext(), { title: 'no body' })
    expect(calls).toContainEqual([
      'insert',
      { body: '', org_id: ORG_ID, owner_id: ACTOR_ID, title: 'no body' },
    ])
  })

  it('emits notes.created carrying the DATABASE timestamp, not the request one', async () => {
    const { db } = fakeDatabase(rows([row(1)]))
    await createNote(db, writeContext(), { title: 'note 1' })

    expect(emitted).toEqual([
      {
        name: 'notes.created',
        payload: {
          actorId: ACTOR_ID,
          noteId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          occurredAt: '2026-01-01T00:00:00.000000+00:00',
          orgId: ORG_ID,
        },
      },
    ])
    expect(emitted[0]?.payload.occurredAt).not.toBe(NOW)
  })

  it('maps an INSERT policy rejection to forbidden and emits nothing', async () => {
    const { db } = fakeDatabase(denied('42501'))
    const outcome = await createNote(db, writeContext(), { title: 'note 1' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.rlsDenied({
        relation: 'notes',
        message: 'a row-security policy refused the create',
      }),
    )
    expect(emitted).toEqual([])
  })

  it('reports a write that cannot be read back as an internal fault', async () => {
    // No error and no returned row means the RETURNING projection was filtered
    // by a SELECT policy: the row was written, the caller may not see it.
    const { db } = fakeDatabase(rows([]))
    const outcome = await createNote(db, writeContext(), { title: 'note 1' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'write_not_readable',
        message: 'the note was written but could not be read back',
      }),
    )
    expect(emitted).toEqual([])
  })
})

describe('updateNote', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('sends only the patched columns, plus the request instant', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    await updateNote(db, writeContext(), { id, title: ' renamed  note ' })
    expect(calls).toContainEqual(['update', { title: 'renamed note', updated_at: NOW }])
    expect(calls).toContainEqual(['eq', 'id', id])
  })

  it('archives with the request instant and un-archives to null', async () => {
    const on = fakeDatabase(rows([row(1, { archived_at: NOW })]))
    await updateNote(on.db, writeContext(), { id, isArchived: true })
    expect(on.calls).toContainEqual(['update', { archived_at: NOW, updated_at: NOW }])

    const off = fakeDatabase(rows([row(1)]))
    await updateNote(off.db, writeContext(), { id, isArchived: false })
    expect(off.calls).toContainEqual(['update', { archived_at: null, updated_at: NOW }])
  })

  it('treats an empty body as a real value, not as absent', async () => {
    const { calls, db } = fakeDatabase(rows([row(1, { body: '' })]))
    await updateNote(db, writeContext(), { body: '', id })
    expect(calls).toContainEqual(['update', { body: '', updated_at: NOW }])
  })

  it('names WHICH fields changed in the event, and never their values', async () => {
    const { db } = fakeDatabase(rows([row(1, { updated_at: '2026-07-07T07:07:07.000000+00:00' })]))
    await updateNote(db, writeContext(), { body: 'secret text', id, isArchived: true })

    expect(emitted).toEqual([
      {
        name: 'notes.updated',
        payload: {
          actorId: ACTOR_ID,
          fields: ['body', 'isArchived'],
          noteId: id,
          occurredAt: '2026-07-07T07:07:07.000000+00:00',
          orgId: ORG_ID,
        },
      },
    ])
    expect(JSON.stringify(emitted)).not.toContain('secret text')
  })

  it('refuses an empty patch even from a caller that skipped the schema', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    const outcome = await updateNote(db, writeContext(), { id })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.validation({
        code: 'empty_patch',
        message: 'an update must change at least one field',
      }),
    )
    expect(calls).toEqual([])
  })

  it('reports notFound when the UPDATE policy filtered the row out', async () => {
    const { db } = fakeDatabase(rows([]))
    const outcome = await updateNote(db, writeContext(), { id, title: 'renamed' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(appError.notFound({ resource: 'note' }))
    expect(emitted).toEqual([])
  })

  it('maps a constraint violation to conflict — the caller can refetch and retry', async () => {
    const { db } = fakeDatabase(denied('23505'))
    const outcome = await updateNote(db, writeContext(), { id, title: 'renamed' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.conflict({
        resource: 'note',
        message: 'the update conflicts with the current state of the note',
      }),
    )
  })
})

describe('deleteNote', () => {
  const ref = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }

  it('returns the removed id and emits with the row’s own timestamp', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    const outcome = await deleteNote(db, writeContext(), ref)

    expect(outcome.ok && outcome.data).toEqual({ id: ref.id })
    expect(calls).toContainEqual(['delete'])
    expect(calls).toContainEqual(['eq', 'id', ref.id])
    // A delete has no surviving row to read a timestamp from afterwards, which
    // is exactly why the projection is selected on the way out.
    expect(calls).toContainEqual(['select', NOTE_COLUMNS])
    expect(emitted).toEqual([
      {
        name: 'notes.deleted',
        payload: {
          actorId: ACTOR_ID,
          noteId: ref.id,
          occurredAt: '2026-01-01T00:00:00.000000+00:00',
          orgId: ORG_ID,
        },
      },
    ])
  })

  it('reports notFound when nothing was removed, and emits nothing', async () => {
    const { db } = fakeDatabase(rows([]))
    const outcome = await deleteNote(db, writeContext(), ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(appError.notFound({ resource: 'note' }))
    expect(emitted).toEqual([])
  })

  it('maps a DELETE policy rejection to forbidden', async () => {
    const { db } = fakeDatabase(denied('42501'))
    const outcome = await deleteNote(db, writeContext(), ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.rlsDenied({
        relation: 'notes',
        message: 'a row-security policy refused the delete',
      }),
    )
    expect(emitted).toEqual([])
  })
})

// --- R3c mutation-kill tests (added by triage) ---
describe('mutation kills — SQLSTATE taxonomy (errors.ts)', () => {
  const ref = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }

  it('maps a CHECK constraint violation (23514) to conflict', async () => {
    const { db } = fakeDatabase(denied('23514'))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.conflict({
        resource: 'note',
        message: 'the read conflicts with the current state of the note',
      }),
    )
  })

  it('maps a FOREIGN KEY violation (23503) to conflict', async () => {
    const { db } = fakeDatabase(denied('23503'))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.conflict({
        resource: 'note',
        message: 'the read conflicts with the current state of the note',
      }),
    )
  })

  it('maps PostgREST PGRST116 (no rows) to notFound', async () => {
    const { db } = fakeDatabase(denied('PGRST116'))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(appError.notFound({ resource: 'note' }))
  })

  it('treats SQLSTATE class 53 as retryable → unavailable', async () => {
    const { db } = fakeDatabase(denied('53300'))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unavailable({ message: 'the notes store was unreachable during the read' }),
    )
  })

  it('treats SQLSTATE class 57 as retryable → unavailable', async () => {
    const { db } = fakeDatabase(denied('57014'))
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unavailable({ message: 'the notes store was unreachable during the read' }),
    )
  })

  it('maps a code-less transport failure to unknown, never throwing', async () => {
    const { db } = fakeDatabase({
      data: null,
      error: { message: 'transport failed with no sqlstate' },
    })
    const outcome = await getNote(db, scope, ref)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'notes_store_rejected',
        message: 'the notes store rejected the read',
      }),
    )
  })
})

describe('mutation kills — contract drift per operation (notes.ts)', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const driftOutcome = (): PostgrestOutcome => rows([row(1, { title: undefined })])

  it('names the read operation when a fetched row breaks its contract', async () => {
    const { db } = fakeDatabase(driftOutcome())
    const outcome = await getNote(db, scope, { id })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'contract_drift',
        message: 'a notes row did not match its contract during the read',
      }),
    )
  })

  it('names the create operation on contract drift and emits nothing', async () => {
    const { db } = fakeDatabase(driftOutcome())
    const outcome = await createNote(db, writeContext(), { title: 'note 1' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'contract_drift',
        message: 'a notes row did not match its contract during the create',
      }),
    )
    expect(emitted).toEqual([])
  })

  it('names the update operation on contract drift and emits nothing', async () => {
    const { db } = fakeDatabase(driftOutcome())
    const outcome = await updateNote(db, writeContext(), { id, title: 'renamed' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'contract_drift',
        message: 'a notes row did not match its contract during the update',
      }),
    )
    expect(emitted).toEqual([])
  })

  it('names the delete operation on contract drift and emits nothing', async () => {
    const { db } = fakeDatabase(driftOutcome())
    const outcome = await deleteNote(db, writeContext(), { id })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual(
      appError.unknown({
        code: 'contract_drift',
        message: 'a notes row did not match its contract during the delete',
      }),
    )
    expect(emitted).toEqual([])
  })

  it('records title in the changed-fields event by its real name', async () => {
    const { db } = fakeDatabase(rows([row(1)]))
    await updateNote(db, writeContext(), { id, title: 'renamed' })
    expect(emitted).toEqual([
      {
        name: 'notes.updated',
        payload: {
          actorId: ACTOR_ID,
          fields: ['title'],
          noteId: id,
          occurredAt: '2026-01-01T00:00:00.000000+00:00',
          orgId: ORG_ID,
        },
      },
    ])
  })
})

// --- R3c mutation-kill tests (added by triage) ---
describe('clampPageLimit defense-in-depth — a non-finite limit still yields a bounded scan', () => {
  it('clamps Infinity to the safe floor rather than an unbounded probe', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    await listNotes(db, scope, { ...listQuery, limit: Number.POSITIVE_INFINITY })
    // Original returns 1 -> limit(1+1); dropping the finite guard returns 200 -> limit(201).
    expect(calls).toContainEqual(['limit', 2])
  })
})

// --- the tenant filter, on every read and every write -----------------------
//
// WHY THIS EXISTS AT ALL, given that RLS is the boundary. The `.eq('org_id', …)` in the DAL
// is defence in depth, not the enforcement — a policy denial is what actually stops a
// cross-tenant read, and tests/rls plus the pgTAP twin are what prove that. But the mutation
// lane found all four of these call sites SURVIVING: every one could have its column name
// emptied and no test noticed. That is worth closing on its own terms, because the filter
// carries a PERFORMANCE guarantee as well as an authorization shadow. `org_id` leads
// notes_org_id_created_at_id_idx, so without it the policy still filters by org — by
// scanning the table and discarding other tenants' rows. Correct results, cost proportional
// to every customer's data. That is the failure `query-shapes` and the db-scale plan probe
// exist to catch one layer up, and it should not be reachable by a one-character edit here.
//
// These assert the COLUMN NAME and the value together. Asserting the value alone leaves
// `.eq('', orgId)` alive, which is precisely the mutant that was surviving. createNote is
// absent because it is already covered above ("takes the tenant key and the attribution from
// CONTEXT") — its insert path was never among the survivors.
describe('every scoped DAL function filters on the tenant column', () => {
  const ref = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }

  it('listNotes filters on org_id — the leading column of the keyset index', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    await listNotes(db, scope, listQuery)
    expect(calls).toContainEqual(['eq', 'org_id', ORG_ID])
  })

  it('getNote filters on org_id as well as the row id', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    await getNote(db, scope, ref)
    expect(calls).toContainEqual(['eq', 'org_id', ORG_ID])
  })

  it('updateNote filters on org_id, so a foreign id matches nothing before RLS is consulted', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    await updateNote(db, writeContext(), { id: ref.id, title: 'renamed' })
    expect(calls).toContainEqual(['eq', 'org_id', ORG_ID])
  })

  it('deleteNote filters on org_id', async () => {
    const { calls, db } = fakeDatabase(rows([row(1)]))
    await deleteNote(db, writeContext(), ref)
    expect(calls).toContainEqual(['eq', 'org_id', ORG_ID])
  })

  it('listAuthoredNotes filters on org_id like every other scoped read', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 50 })
    expect(calls).toContainEqual(['eq', 'org_id', ORG_ID])
  })
})

// ---------------------------------------------------------------------------
// listAuthoredNotes — the DSR export read, and the header's ONE owner_id
// carve-out. The invariant proof at the router layer lives in
// packages/api/src/routers/system.export.test.ts; these are the DAL's own
// branches, driven the same way as every sibling above.
// ---------------------------------------------------------------------------

const authoredScope = { actorId: ACTOR_ID, orgId: ORG_ID }

/** An export-projection row — no owner_id, no archived_at, org_id present. */
function exportRow(index: number): Record<string, unknown> {
  const suffix = String(index).padStart(2, '0')
  return {
    body: `body ${index}`,
    created_at: `2026-01-${suffix}T00:00:00.000000+00:00`,
    id: `3f2504e0-4f89-41d3-9a0c-0305e82c33${suffix}`,
    org_id: ORG_ID,
    title: `note ${index}`,
    updated_at: `2026-01-${suffix}T00:00:00.000000+00:00`,
  }
}

describe('listAuthoredNotes (the export read)', () => {
  it('filters owner_id = the actor IN the query — authored-only is application logic', async () => {
    // RLS admits every org-mate's notes to this caller; without this filter the
    // page is green, well-formed, and somebody else's data. The one filter in
    // this file whose deletion the database would NOT catch — see the header.
    const { calls, db } = fakeDatabase(rows([]))
    await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 50 })
    expect(calls).toContainEqual(['eq', 'owner_id', ACTOR_ID])
  })

  it('returns the export projection: org attribution rides, owner does not echo back', async () => {
    const { calls, db } = fakeDatabase(rows([exportRow(1)]))
    const outcome = await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 50 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.items).toEqual([
      {
        body: 'body 1',
        createdAt: '2026-01-01T00:00:00.000000+00:00',
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        orgId: ORG_ID,
        title: 'note 1',
        updatedAt: '2026-01-01T00:00:00.000000+00:00',
      },
    ])
    // The export projection, not the list projection: no owner_id round trip.
    expect(calls).toContainEqual(['select', 'id, org_id, title, body, created_at, updated_at'])
  })

  it('includes archived rows — an export answers "what is mine", not "what is on screen"', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 50 })
    expect(calls.some(([method]) => method === 'is')).toBe(false)
  })

  it('pages with the sentinel row and mints the next inner cursor from the LAST page row', async () => {
    const { calls, db } = fakeDatabase(rows([exportRow(3), exportRow(2), exportRow(1)]))
    const outcome = await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 2 })
    expect(calls).toContainEqual(['limit', 3])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.items).toHaveLength(2)
    expect(outcome.data.nextCursor).not.toBeNull()
    if (outcome.data.nextCursor === null) return
    expect(decodeNotesCursor(outcome.data.nextCursor)).toEqual({
      createdAt: '2026-01-02T00:00:00.000000+00:00',
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
    })
  })

  it('sends the seek as range + tie-break, like the list it mirrors', async () => {
    const cursor = encodeNotesCursor({
      createdAt: '2026-01-02T00:00:00.000000+00:00',
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
    })
    const { calls, db } = fakeDatabase(rows([]))
    await listAuthoredNotes(db, authoredScope, { cursor, limit: 50 })
    expect(calls).toContainEqual(['lte', 'created_at', '2026-01-02T00:00:00.000000+00:00'])
    expect(calls.some(([method]) => method === 'or')).toBe(true)
  })

  it('rejects a cursor the codec did not mint, before any query is built', async () => {
    const { calls, db } = fakeDatabase(rows([]))
    const outcome = await listAuthoredNotes(db, authoredScope, { cursor: '!!!', limit: 50 })
    expect(outcome).toEqual({
      ok: false,
      error: appError.validation({
        code: 'invalid_cursor',
        fields: ['cursor'],
        message: 'the page cursor is not one this server minted',
      }),
    })
    expect(calls).toHaveLength(0)
  })

  it('maps a store refusal through the shared taxonomy, naming the export operation', async () => {
    const { db } = fakeDatabase(denied('42501'))
    const outcome = await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 50 })
    expect(outcome).toEqual({
      ok: false,
      error: appError.rlsDenied({
        relation: 'notes',
        message: 'a row-security policy refused the export',
      }),
    })
  })

  it('folds a drifted row into contract_drift for the export operation', async () => {
    const { db } = fakeDatabase(rows([{ ...exportRow(1), created_at: 'not-a-timestamp' }]))
    const outcome = await listAuthoredNotes(db, authoredScope, { cursor: null, limit: 50 })
    expect(outcome).toEqual({
      ok: false,
      error: appError.unknown({
        code: 'contract_drift',
        message: 'a notes row did not match its contract during the export',
      }),
    })
  })
})
