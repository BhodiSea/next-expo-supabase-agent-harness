// The DAL query-shape registry the plan probe drives (v0.1.6). SEEDED — this file is
// yours: `update` never rewrites it, and it grows with your DAL.
//
// WHY THIS EXISTS. Until 0.1.6 the plan probe EXPLAINed exactly one statement, and that
// statement was hand-written in the probe itself:
//     SELECT * FROM notes
// It asserted the table was not reached by a Seq Scan, and it was right — and useless,
// because the application never issues that query. What notesDal.list() actually emits is
// a keyset seek with an ORDER BY, and for five releases it planned a top-N sort over the
// owner's ENTIRE partition (100 010 rows read to return a 51-row page) with the row-value
// cursor demoted from an Index Cond to a Filter. Every gate was green. The probe had
// simply never looked at the query.
//
// So the probe no longer writes its own SQL. Every shape below CALLS THE REAL DAL through
// a capturing drizzle pg-proxy — the same seam apps/server/src/dal/notes.statements.test.ts
// uses to count statements — and the SQL that gets EXPLAINed is the SQL the DAL emitted,
// byte for byte, parameters and all. A registry of copied query TEXT would drift from the
// DAL the first time someone edited a .where(); this cannot drift, because there is
// nothing to copy.
//
// REGISTER EVERY DAL METHOD, AND EVERY INTERESTING ARGUMENT SHAPE. plan-regression.test.ts
// imports each apps/server/src/dal/*.ts, enumerates the methods on its `*Dal` export, and
// FAILS if any method has no entry here — a query nothing measures cannot be added by
// accident. Argument shapes matter as much as methods: a first page and a cursor page plan
// differently (the cursor adds the row-value range condition), so both are registered.
// Extra entries are always safe; each costs one EXPLAIN against the seeded table.
//
// The probe runs `EXPLAIN` — it PLANS, it never EXECUTES — so registering create/remove
// shapes writes and deletes nothing.
// SOURCE: docs/harness/gates-catalog.md (rls-isolation — DAL plan probe) [corpus: harness/doctrine]
import { accountDal } from '../../apps/server/src/dal/account.js'
import { notesDal } from '../../apps/server/src/dal/notes.js'

/** Plan-node types the probe rejects outright, unless a shape allows one by name. */
export type ForbiddenNode = 'Seq Scan' | 'Sort' | 'Incremental Sort'

export interface DalShape {
  /** Unique label for this probe, e.g. 'notesDal.list:cursor'. Appears in failures. */
  readonly id: string
  /**
   * '<dalExport>.<method>' — the DAL method this shape exercises. The closure check
   * matches these against the real exports, so it must be spelled exactly.
   */
  readonly method: string
  /**
   * The table whose statistics back this plan. Must be one of db-context.ts's
   * ISOLATION_TARGETS — that is what the probe bulk-seeds and ANALYZEs to PROBE_ROWS.
   */
  readonly table: string
  /**
   * Reviewed escape: plan nodes tolerated for THIS shape. Empty by default, and it
   * should stay that way — every entry is a query reading rows it will not return.
   * A stale/unused allowance FAILS (it can never silently rot into a fail-open).
   */
  readonly allow?: readonly ForbiddenNode[]
  /** Required whenever `allow` is non-empty: why this plan is acceptable anyway. */
  readonly reason?: string
  /** Drives the real DAL. The proxy captures whatever SQL this emits. */
  readonly run: (userId: string) => Promise<unknown>
}

// A uuid that exists in nobody's data. `get`/`remove` plan identically whether or not the
// row is there — EXPLAIN never executes, so the planner only ever sees the parameter.
const ABSENT_ID = '00000000-0000-4000-8000-000000000000'

// A cursor positioned mid-table. The VALUES do not steer the plan shape (they are bound
// parameters), but they must parse: the DAL takes an already-decoded NoteCursorKey.
const MID_CURSOR = { createdAt: '2026-01-01 00:00:00.000000+00', id: ABSENT_ID }

export const DAL_SHAPES: readonly DalShape[] = [
  {
    id: 'notesDal.list:first-page',
    method: 'notesDal.list',
    table: 'notes',
    run: (userId) => notesDal.list(userId, { limit: 50 }),
  },
  {
    // The hot path, and the one that was broken: page 2+ adds the row-value comparison
    // the DAL calls an index range condition. If the index cannot serve the ORDER BY, this
    // shape is where it shows — as a Sort node, and as a Filter instead of an Index Cond.
    id: 'notesDal.list:cursor-page',
    method: 'notesDal.list',
    table: 'notes',
    run: (userId) => notesDal.list(userId, { limit: 50, cursor: MID_CURSOR }),
  },
  {
    id: 'notesDal.create',
    method: 'notesDal.create',
    table: 'notes',
    run: (userId) => notesDal.create(userId, { title: 'plan probe' }),
  },
  {
    id: 'notesDal.get',
    method: 'notesDal.get',
    table: 'notes',
    run: (userId) => notesDal.get(userId, ABSENT_ID),
  },
  {
    id: 'notesDal.remove',
    method: 'notesDal.remove',
    table: 'notes',
    run: (userId) => notesDal.remove(userId, ABSENT_ID),
  },
  {
    // Account deletion (Apple 5.1.1(v)): a DELETE with no application WHERE —
    // the RLS policy qual IS the filter, so the plan must still reach the
    // owner's partition through the owner-leading index (at 1% estimated
    // selectivity a Seq Scan here would be the silent full-table walk).
    id: 'accountDal.deleteAllOwnedData',
    method: 'accountDal.deleteAllOwnedData',
    table: 'notes',
    run: (userId) => accountDal.deleteAllOwnedData(userId),
  },
]
