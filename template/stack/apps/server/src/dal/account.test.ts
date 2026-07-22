// Statement-shape gate for the account-deletion DAL: exactly ONE statement, a
// DELETE with NO application WHERE clause — the RLS policy qual IS the filter
// (visibility under FORCE RLS is bounded by the app.user_id GUC), so an
// application-side owner filter here could only ever mask a policy regression.
// The live cross-tenant proof (tests/rls/cross-tenant-isolation.test.ts) is
// where "only the caller's rows die" is asserted against real Postgres; this
// suite pins the SQL SHAPE through the same capturing pg-proxy seam the notes
// DAL uses.
import { describe, expect, it, vi } from 'vitest'
import type { UserTx } from '../db/context.js'

const state = vi.hoisted(() => ({
  statementCount: 0,
  statements: [] as string[],
  rows: [] as unknown[][],
}))

const { drizzle } = await import('drizzle-orm/pg-proxy')
const proxyDb = drizzle((sql) => {
  state.statementCount += 1
  state.statements.push(sql)
  return Promise.resolve({ rows: state.rows })
})

vi.mock('../db/context.js', () => ({
  withUserContext: <T>(_userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> =>
    fn(proxyDb as unknown as UserTx),
}))

const { accountDal } = await import('./account.js')

const USER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'

describe('accountDal.deleteAllOwnedData', () => {
  it('emits exactly ONE DELETE, with no application owner filter (RLS is the filter)', async () => {
    state.statementCount = 0
    state.statements = []
    state.rows = [['id-1'], ['id-2']]

    const result = await accountDal.deleteAllOwnedData(USER_ID)

    expect(state.statementCount).toBe(1)
    const sql = state.statements[0] ?? ''
    expect(sql).toMatch(/^delete from "notes"/i)
    expect(sql).not.toMatch(/where/i)
    // The RETURNING projection is exactly the id — the deleted-count contract
    // rides it, and a `returning *` would ship whole rows nobody consumes
    // (mutation-killed: .returning({}) emits a different clause).
    expect(sql).toMatch(/returning "id"/i)
    expect(result).toEqual({ deletedNotes: 2 })
  })

  it('reports zero honestly — an already-empty account deletes to a zero count', async () => {
    state.statementCount = 0
    state.statements = []
    state.rows = []

    const result = await accountDal.deleteAllOwnedData(USER_ID)

    expect(result).toEqual({ deletedNotes: 0 })
  })
})
