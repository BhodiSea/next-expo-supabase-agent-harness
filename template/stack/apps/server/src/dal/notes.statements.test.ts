// N+1 regression gate: the notes DAL must execute a FIXED number of SQL
// statements no matter how many rows come back. The counter is the drizzle
// pg-proxy execution callback — the exact seam postgres.js's `debug` hook
// instruments on a live connection: EVERY statement the DAL emits (including
// any per-row follow-up query an N+1 regression would introduce) must pass
// through it to execute, so the count cannot false-green.
//
// Expected counts, and why:
//   list()   = exactly 1 — the single keyset SELECT (WHERE + ORDER BY + LIMIT
//              in one statement). Row mapping happens in process, never via
//              per-row queries.
//   create() = exactly 1 — INSERT ... RETURNING carries the created row back.
// The surrounding BEGIN / set_config('app.user_id', …) / COMMIT live in the
// real withUserContext (mocked here) and are constant per call by
// construction — the transaction wrapper cannot scale with row count. The rls
// lane proves that wrapper against a live database.
import { notes } from '@app/schema'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { describe, expect, it, vi } from 'vitest'
import type { UserTx } from '../db/context.js'

const state = vi.hoisted(() => ({
  statementCount: 0,
  rows: [] as unknown[][],
}))

const proxyDb = drizzle(() => {
  state.statementCount += 1
  return Promise.resolve({ rows: state.rows })
})

vi.mock('../db/context.js', () => ({
  withUserContext: <T>(_userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> =>
    fn(proxyDb as unknown as UserTx),
}))

const { notesDal } = await import('./notes.js')

const USER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const COLUMNS = Object.keys(getTableColumns(notes))

// Deterministic uuid-shaped ids: 32 hex digits derived from the row index.
const rowId = (i: number) => {
  const hex = i.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

const driverRows = (count: number): unknown[][] =>
  Array.from({ length: count }, (_, i) => {
    const row: Record<string, unknown> = {
      body: '',
      createdAt: `2026-01-01 00:00:${String(59 - (i % 60)).padStart(2, '0')}.${String(
        999999 - i,
      ).padStart(6, '0')}+00`,
      embedding: null,
      id: rowId(i),
      ownerId: USER_ID,
      sourceConfidence: null,
      sourceModel: null,
      title: `note ${String(i)}`,
    }
    return COLUMNS.map((column) => row[column])
  })

describe('statement-count invariance (N+1 gate)', () => {
  it('list() is exactly ONE statement when the page comes back empty', async () => {
    state.rows = []
    state.statementCount = 0
    await notesDal.list(USER_ID, { limit: 50 })
    expect(state.statementCount).toBe(1)
  })

  it('list() is STILL exactly ONE statement for a full page + sentinel (201 rows)', async () => {
    state.rows = driverRows(201)
    state.statementCount = 0
    const page = await notesDal.list(USER_ID, { limit: 200 })
    // Non-vacuous: the rows really flowed through (full page, has-more cursor).
    expect(page.items).toHaveLength(200)
    expect(page.nextCursor).not.toBeNull()
    expect(state.statementCount).toBe(1)
  })

  it('create() is exactly ONE statement (INSERT ... RETURNING, no read-back)', async () => {
    state.rows = driverRows(1)
    state.statementCount = 0
    await notesDal.create(USER_ID, { title: 'one statement' })
    expect(state.statementCount).toBe(1)
  })
})
