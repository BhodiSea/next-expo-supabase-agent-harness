// DAL DTO-shape tests against a drizzle pg-proxy stand-in for the db context.
// These always run (no DATABASE_URL guard, no skip path — a skipped test must
// never read as green); real cross-tenant isolation runs in tests/rls/ against
// the compose DB. The proxy sits at the DAL's real SQL boundary: every
// statement drizzle emits lands in the callback with its parameters.
import { type NewNote, NOTES_PAGE_LIMIT_MAX } from '@app/contracts'
import { notes } from '@app/schema'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { describe, expect, it, vi } from 'vitest'
import type { UserTx } from '../db/context.js'
import { decodeNotesCursor } from './cursor.js'

const state = vi.hoisted(() => ({
  queries: [] as { sql: string; params: unknown[] }[],
  rows: [] as unknown[][],
  userIds: [] as string[],
}))

// The pg-proxy driver hands back rows in array mode, ordered like the select
// list — which for select().from(notes) is the table's column definition order.
const COLUMNS = Object.keys(getTableColumns(notes))
const proxyDb = drizzle((sql, params) => {
  state.queries.push({ sql, params })
  return Promise.resolve({ rows: state.rows })
})

vi.mock('../db/context.js', () => ({
  withUserContext: <T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> => {
    state.userIds.push(userId)
    return fn(proxyDb as unknown as UserTx)
  },
}))

const { notesDal } = await import('./notes.js')

// RFC-4122-valid fixtures: NoteDto's uuid validation checks the variant bits.
const USER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

// createdAt uses the Postgres text form at full microsecond precision — the
// DAL must pass it through VERBATIM (a Date round-trip would truncate to
// milliseconds and corrupt keyset cursors).
const validRow = () => ({
  body: '',
  createdAt: '2026-01-01 00:00:00.123456+00',
  embedding: null,
  id: NOTE_ID,
  ownerId: USER_ID,
  sourceConfidence: null,
  sourceModel: null,
  title: 'zod-parsed at the DAL exit',
})

const asDriverRow = (row: Record<string, unknown>) => COLUMNS.map((column) => row[column])

const reset = (rows: Record<string, unknown>[]) => {
  state.rows = rows.map(asDriverRow)
  state.queries = []
  state.userIds = []
}

// A user who does NOT own anything here: used to prove the wire can never choose
// the owner of a row.
const ATTACKER_ID = '00000000-0000-4000-8000-0000deadbeef'

// Four notes in exactly the (created_at, id) DESC order the keyset ORDER BY
// returns them. Three items + one sentinel is the smallest page that can tell
// "the LAST item" apart from "the second item" — a 2-row page cannot.
const NEWEST = {
  ...validRow(),
  createdAt: '2026-01-04 00:00:00.000004+00',
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
}
const SECOND = {
  ...validRow(),
  createdAt: '2026-01-03 00:00:00.000003+00',
  id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
}
const THIRD = {
  ...validRow(),
  createdAt: '2026-01-02 00:00:00.000002+00',
  id: 'c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f',
}
const SENTINEL = {
  ...validRow(),
  createdAt: '2026-01-01 00:00:00.000001+00',
  id: 'd4e5f6a7-b8c9-4d0e-bf2a-3b4c5d6e7f80',
}

/** The single LIMIT parameter drizzle bound for the statement under test. */
const limitParam = () => state.queries[0]?.params.at(-1)

describe('notes DAL returns Zod-parsed DTOs, never raw rows', () => {
  it('list: parses rows into the NotesPage shape (timestamptz text kept verbatim)', async () => {
    reset([validRow()])
    const page = await notesDal.list(USER_ID, { limit: 50 })
    expect(page).toEqual({
      items: [
        {
          id: NOTE_ID,
          ownerId: USER_ID,
          title: 'zod-parsed at the DAL exit',
          body: '',
          embedding: null,
          sourceModel: null,
          sourceConfidence: null,
          createdAt: '2026-01-01 00:00:00.123456+00',
        },
      ],
      nextCursor: null,
    })
  })

  it('list: decodes a pgvector text value into number[]', async () => {
    const embedding = Array.from({ length: 1024 }, () => 0.25)
    reset([{ ...validRow(), embedding: JSON.stringify(embedding) }])
    const page = await notesDal.list(USER_ID, { limit: 50 })
    expect(page.items[0]?.embedding).toEqual(embedding)
  })

  it('list: runs inside withUserContext with the caller identity', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 50 })
    expect(state.userIds).toEqual([USER_ID])
  })

  it('list: rejects malformed rows instead of passing them through', async () => {
    reset([{ ...validRow(), id: 'not-a-uuid' }])
    await expect(notesDal.list(USER_ID, { limit: 50 })).rejects.toThrow()
  })

  it('list: always issues a bounded SELECT — LIMIT present even without a cursor', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 50 })
    expect(state.queries).toHaveLength(1)
    expect(state.queries[0]?.sql).toMatch(/limit \$\d+$/)
    // limit+1: one sentinel row past the page is the has-more probe.
    expect(state.queries[0]?.params).toContain(51)
  })

  it('list: clamps a hostile limit to the contract max before it reaches SQL', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 10_000 })
    expect(state.queries[0]?.params).toContain(201)
  })

  it('list: emits nextCursor only when a sentinel row proves another page exists', async () => {
    const older = {
      ...validRow(),
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      createdAt: '2025-12-31 23:59:59.999999+00',
    }
    const sentinel = {
      ...validRow(),
      id: '550e8400-e29b-41d4-a716-446655440000',
      createdAt: '2025-12-30 00:00:00+00',
    }
    reset([validRow(), older, sentinel])
    const page = await notesDal.list(USER_ID, { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).not.toBeNull()
    // The cursor is the keyset of the LAST RETURNED item — decode round-trips it.
    expect(decodeNotesCursor(page.nextCursor ?? '')).toEqual({
      createdAt: older.createdAt,
      id: older.id,
    })
  })

  it('list: threads the decoded cursor into a keyset row comparison, never OFFSET', async () => {
    reset([])
    const cursor = { createdAt: '2026-01-01 00:00:00.123456+00', id: NOTE_ID }
    await notesDal.list(USER_ID, { limit: 50, cursor })
    const query = state.queries[0]
    expect(query?.sql).toContain('("notes"."created_at", "notes"."id") < ')
    expect(query?.sql).not.toMatch(/offset/i)
    expect(query?.params).toContain(cursor.createdAt)
    expect(query?.params).toContain(cursor.id)
  })

  it('create: returns the parsed created note (body defaults to empty)', async () => {
    reset([validRow()])
    const note = await notesDal.create(USER_ID, { title: 'zod-parsed at the DAL exit' })
    expect(note.id).toBe(NOTE_ID)
    expect(note.createdAt).toBe('2026-01-01 00:00:00.123456+00')
  })

  it('create: throws loudly when the insert returns no row', async () => {
    reset([])
    await expect(notesDal.create(USER_ID, { title: 'missing returning row' })).rejects.toThrow(
      /returned no row/,
    )
  })

  it('get: returns null when RLS yields no visible row', async () => {
    reset([])
    await expect(notesDal.get(USER_ID, NOTE_ID)).resolves.toBeNull()
  })

  it('remove: reports whether a row was deleted', async () => {
    // delete().returning({ id }) selects a single column — single-element rows.
    state.rows = [[NOTE_ID]]
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(true)
    state.rows = []
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(false)
  })
})

// The clamp is defence in depth BELOW the route's Zod bound: whatever a future
// caller passes, the SQL that leaves this file is bounded. Each arm of
// Math.min(Math.max(Math.trunc(limit), 1), MAX) is pinned separately, because a
// dropped arm is exactly how an unbounded (or absurd) SELECT ships.
describe('notes DAL clamps the page limit before it can reach SQL', () => {
  it('clamps a zero limit UP to 1 (LIMIT 2 — the page plus its sentinel)', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 0 })
    expect(limitParam()).toBe(2)
  })

  it('clamps a negative limit UP to 1 — a negative LIMIT is a driver-level error', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: -50 })
    expect(limitParam()).toBe(2)
  })

  it('TRUNCATES a fractional limit — Postgres will not take LIMIT 6.9', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 5.9 })
    expect(limitParam()).toBe(6)
    expect(state.queries[0]?.params).not.toContain(6.9)
  })

  it('clamps a limit above the contract max DOWN to the max (+ the sentinel)', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 500 })
    expect(limitParam()).toBe(NOTES_PAGE_LIMIT_MAX + 1)
    // ...however hostile the caller: there is no input that buys an unbounded scan.
    reset([])
    await notesDal.list(USER_ID, { limit: Number.MAX_SAFE_INTEGER })
    expect(limitParam()).toBe(NOTES_PAGE_LIMIT_MAX + 1)
  })

  it('asks for exactly ONE row past the page — the has-more sentinel', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 7 })
    expect(limitParam()).toBe(8)
  })
})

// Pagination correctness: WHICH row the cursor points at decides whether the
// next page resumes, repeats, or skips rows. A cursor built from the wrong row
// is silent data loss, so the assertions below name the exact row.
describe('notes DAL keyset pagination points the cursor at the LAST returned row', () => {
  it('emits NO cursor when exactly `limit` rows come back (no sentinel = no next page)', async () => {
    reset([NEWEST, SECOND])
    const page = await notesDal.list(USER_ID, { limit: 2 })
    expect(page.items).toHaveLength(2)
    // rows.length === limit is NOT "more rows exist" — advertising a next page
    // here hands the client a cursor onto an empty page forever.
    expect(page.nextCursor).toBeNull()
  })

  it('emits a cursor for the LAST ITEM — not the sentinel, not the middle of the page', async () => {
    reset([NEWEST, SECOND, THIRD, SENTINEL])
    const page = await notesDal.list(USER_ID, { limit: 3 })
    expect(page.items).toHaveLength(3)
    expect(page.items.map((item) => item.id)).toEqual([NEWEST.id, SECOND.id, THIRD.id])
    const decoded = decodeNotesCursor(page.nextCursor ?? '')
    expect(decoded).toEqual({ createdAt: THIRD.createdAt, id: THIRD.id })
    // The sentinel is dropped from the page, so resuming from it would SKIP it.
    expect(decoded?.id).not.toBe(SENTINEL.id)
    // ...and resuming from any earlier row would REPEAT rows already delivered.
    expect(decoded?.id).not.toBe(SECOND.id)
    expect(decoded?.id).not.toBe(NEWEST.id)
  })

  it('carries the last row microsecond-exact, so the next seek cannot skip a row', async () => {
    reset([NEWEST, SECOND, THIRD, SENTINEL])
    const page = await notesDal.list(USER_ID, { limit: 3 })
    expect(decodeNotesCursor(page.nextCursor ?? '')?.createdAt).toBe(
      '2026-01-02 00:00:00.000002+00',
    )
  })

  it('emits no cursor for an empty page', async () => {
    reset([])
    const page = await notesDal.list(USER_ID, { limit: 3 })
    expect(page.items).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })
})

// owner_id is the authorization fact. It is bound from the verified token
// identity the DAL was called with, and the INSERT statement is the only place
// that can be checked — the returned row is whatever the database sent back.
describe('notes DAL binds INSERT values from the verified identity, never the wire', () => {
  it('binds exactly (body, ownerId, title) — an empty VALUES list would insert defaults', async () => {
    reset([validRow()])
    await notesDal.create(USER_ID, { body: 'prose', title: 'zod-parsed at the DAL exit' })
    const insert = state.queries[0]
    expect(insert?.sql).toMatch(/^insert into "notes"/)
    // Bound in the table's column order: body, owner_id, title.
    expect(insert?.params).toEqual(['prose', USER_ID, 'zod-parsed at the DAL exit'])
  })

  it('turns an ABSENT body into the empty string — never undefined, never a default', async () => {
    reset([validRow()])
    await notesDal.create(USER_ID, { title: 'zod-parsed at the DAL exit' })
    // `data.body ?? ''`: an undefined body would drop the column from the
    // statement entirely; any other fallback would write the wrong text.
    expect(state.queries[0]?.params).toEqual(['', USER_ID, 'zod-parsed at the DAL exit'])
  })

  it('takes ownerId from the userId ARGUMENT and ignores an ownerId supplied on the wire', async () => {
    reset([validRow()])
    // NewNoteInput picks { body, title } only — an owner_id from the client is
    // stripped at parse, and the DAL binds the token identity regardless.
    const hostile: unknown = { ownerId: ATTACKER_ID, title: 'zod-parsed at the DAL exit' }
    await notesDal.create(USER_ID, hostile as NewNote)
    const params = state.queries[0]?.params ?? []
    expect(params[1]).toBe(USER_ID)
    expect(params).not.toContain(ATTACKER_ID)
    expect(state.userIds).toEqual([USER_ID])
  })
})

describe('notes DAL single-row reads and deletes report the truth', () => {
  it('get: returns the parsed note when the row IS visible', async () => {
    reset([validRow()])
    const note = await notesDal.get(USER_ID, NOTE_ID)
    // The undefined-guard must not swallow a real row: `get` returning null for
    // a visible note is an availability bug that reads exactly like RLS working.
    expect(note).not.toBeNull()
    expect(note?.id).toBe(NOTE_ID)
    expect(note?.ownerId).toBe(USER_ID)
    expect(note?.createdAt).toBe('2026-01-01 00:00:00.123456+00')
  })

  it('get: rejects a malformed row instead of passing it through', async () => {
    reset([{ ...validRow(), id: 'not-a-uuid' }])
    await expect(notesDal.get(USER_ID, NOTE_ID)).rejects.toThrow()
  })

  it('remove: the DELETE asks for RETURNING "id" — that is what makes the boolean truthful', async () => {
    reset([])
    state.rows = [[NOTE_ID]]
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(true)
    // Without a RETURNING column list the driver reports no rows and every
    // delete would answer 404 — or, worse, answer true for a row RLS hid.
    expect(state.queries[0]?.sql).toMatch(/^delete from "notes" .*returning "id"$/)
    expect(state.queries[0]?.params).toEqual([NOTE_ID])
  })
})
