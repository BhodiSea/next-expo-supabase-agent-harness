// EXPLAIN plan-regression probe: at realistic scale, every RLS-scoped query the DAL
// ACTUALLY ISSUES must reach its table through an index that serves the whole query —
// the policy predicate, the ordering, and the keyset range — with identity resolved ONCE
// per statement (initPlan), never per row. The isolation suite proves WHO can see rows;
// this file proves the ACCESS PATH — the classic silent failure is a green isolation
// matrix over 4 rows that ships a sequential scan at 2 million.
//
// TWO probes, and the second exists because the first was not enough.
//
//   (1) POLICY SHAPE (the 0.1.4 probe, unchanged): EXPLAIN a bare `SELECT * FROM <table>`
//       and assert the policy alone reaches the table by index, once per statement. That
//       is a statement about the POLICY, independent of any DAL — still worth making, but
//       it is not a statement about the application.
//
//   (2) DAL SHAPES (v0.1.6): EXPLAIN every query the DAL really emits. Probe (1) passed
//       for five releases while notesDal.list() — the only list query the app has — planned
//       a top-N sort over the owner's ENTIRE partition (100 010 rows read to return a
//       51-row page, 1 032 buffers) with the row-value cursor demoted from an Index Cond to
//       a Filter. Nothing was wrong with probe (1); it was looking at a statement nobody
//       runs. So probe (2) does not write SQL at all: it calls the real DAL through a
//       capturing drizzle pg-proxy and EXPLAINs the bytes the DAL emitted. tests/rls/
//       dal-shapes.ts is the registry, and EVERY DAL method must appear in it — the closure
//       check below fails when one does not, so an unmeasured query cannot be added by
//       accident.
//
// Method: bulk-seed PROBE_ROWS rows across PROBE_OWNERS distinct synthetic owners as the
// migrator (RLS WITH CHECK forbids cross-owner seeding via the app role, and ANALYZE
// requires table ownership) with FORCE lifted transactionally — FORCE binds the OWNER too,
// so even the migrator cannot touch foreign rows without it — pin statistics with ANALYZE,
// then run a plain EXPLAIN (FORMAT JSON) AS app_api and assert the plan shape. EXPLAIN
// PLANS, it never EXECUTES, so the registered create/remove shapes write and delete
// nothing. Assertions run only through the unprivileged role; the migrator connection
// seeds and cleans, nothing else.
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: postgres/rls-initplan]
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  appSql,
  ISOLATION_TARGETS,
  RLS_SUITE_READY,
  type Sql,
  USER_A,
  withUser,
} from './db-context'

// Planner math the constants must respect. TWO independent requirements, and until 0.1.6
// only the first was understood:
//
//   SELECTIVITY — the policy qual `owner = (select …)` is an unknown Param at plan time, so
//     it is estimated at 1/n_distinct, NOT from the actual owner. With only 2 owners that is
//     50% and a Seq Scan is the CORRECT plan, so the probe must seed many distinct owners or
//     its "no Seq Scan" assertion is meaningless. 100 owners → 1% estimated → the index wins
//     decisively, and removing it flips the plan to Seq Scan, which is exactly the regression.
//
//   ROWS PER OWNER > PAGE SIZE — this is the one the old probe got wrong, and it is why the
//     missing keyset index survived five releases. At 10 rows per owner (its old 10k/1k seed)
//     a 51-row page is the owner's ENTIRE data: there is nothing to sort, the ORDER BY is
//     free, and an index that carries the ordering saves nothing. The planner correctly
//     chooses a sort, and a probe asserting "no Sort" there would be asserting something
//     FALSE. A keyset index only earns its keep once a user has more rows than a page — so
//     the seed must give them more. 250 rows per owner (a modest real user; the page is 51)
//     puts the plan firmly on the far side of the crossover: with the composite index the
//     planner walks it in order and stops at 51; without it, it reads all 250 and sorts —
//     which is what the gate must be able to see.
//
// Measured crossover on PG16 with this schema: 10 rows/owner → Sort (correct); 100+ →
// ordered Index Scan. 250 leaves comfortable headroom on both sides.
// SOURCE: PostgreSQL selectivity estimation for non-constant equality
// (var_eq_non_const uses 1/n_distinct) [corpus: postgres/rls-initplan]
const PROBE_ROWS = 25_000
const PROBE_OWNERS = 100
const IDENT = /^[a-z_][a-z0-9_]*$/

// Plan nodes a DAL query may not contain. Seq Scan is the classic RLS regression; a Sort
// means the index does not carry the query's ORDER BY, so the database sorts the owner's
// whole partition to return one page — O(their rows) per request instead of O(page).
const FORBIDDEN_NODES = ['Seq Scan', 'Sort', 'Incremental Sort'] as const

// Deterministic synthetic owner for row i of a table: md5 hex is a valid uuid text
// form, so the seed set is reproducible and exactly enumerable for cleanup.
function ownerSeriesExpr(table: string, series: string): string {
  return `md5('${table}:' || (${series})::text)::uuid`
}

// The ONE sanctioned migrator use outside tests/migrations/: bulk-seeding foreign
// owners and ANALYZE both require the table owner. Never copy this into app or
// assertion code — the bash-guard confines this DSN to the harness runners.
function migratorSql(): Sql {
  const url = process.env['MIGRATOR_DATABASE_URL']
  if (!url) throw new Error('MIGRATOR_DATABASE_URL not set (run via node tests/rls/run-rls.mjs)')
  return postgres(url, { max: 1, prepare: false })
}

function scalarParam(table: string, column: string, value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error(`plan probe: ${table}.${column} seedRow value must be a scalar to bulk-seed`)
}

// FORCE RLS applies to the table owner as well (that is its point — see 0000_init),
// so the migrator's seed/cleanup DML would be denied (INSERT) or silently match zero
// rows (DELETE). Lift FORCE for exactly one transaction: ALTER TABLE is transactional
// and concurrent readers see only committed state, so the catalog checks running in
// the sibling suite can never observe FORCE off.
// SOURCE: PostgreSQL ALTER TABLE — FORCE ROW LEVEL SECURITY binds the owner
// [corpus: postgres/rls-force]
async function withForceLifted(
  migrator: Sql,
  table: string,
  fn: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await migrator.begin(async (tx) => {
    await tx.unsafe(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`)
    await fn(tx)
    await tx.unsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
  })
}

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Parent Relationship'?: string
  Plans?: PlanNode[]
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((child) => flatten(child))]
}

/** EXPLAIN (plans only — never executes) a statement as app_api carrying USER_A's identity. */
async function explainAs(
  sql: Sql,
  statement: string,
  params: readonly unknown[],
): Promise<PlanNode[]> {
  const rows = await withUser(sql, USER_A, async (tx) => {
    // jit compiles nothing under plain EXPLAIN but is pinned off anyway so the
    // probe stays byte-comparable if it ever grows an ANALYZE option.
    // SOURCE: deterministic plan-shape testing [corpus: harness/doctrine]
    await tx`SELECT set_config('jit', 'off', true)`
    return tx.unsafe(`EXPLAIN (FORMAT JSON) ${statement}`, params as never[])
  })
  const planJson = (rows[0] as Record<string, unknown> | undefined)?.['QUERY PLAN']
  const root = (planJson as { Plan: PlanNode }[] | undefined)?.[0]?.Plan
  if (root === undefined) throw new Error(`EXPLAIN returned no parseable plan for: ${statement}`)
  return flatten(root)
}

// ---------------------------------------------------------------------------
// Probe (2) adoption. tests/rls/dal-shapes.ts is SEEDED and seedOnInitOnly: a fresh 0.1.6
// install ships it and the DAL probe is turn-fatal; an UPGRADED install does not, because
// the registry names THAT project's DAL methods and only they can write it. Absent → this
// probe self-disables with the adoption command (the same pattern as the styleguide
// manifest's newer sections). It never ambushes an install that has not opted in.
// ---------------------------------------------------------------------------
const SHAPES_ADOPTED = existsSync(fileURLToPath(new URL('./dal-shapes.ts', import.meta.url)))
const DAL_DIR = new URL('../../apps/server/src/dal/', import.meta.url)

interface CapturedStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

// The pg-proxy execution callback — the exact seam apps/server/src/dal/notes.statements.
// test.ts uses to COUNT statements; here we keep them. Every statement a DAL method emits
// must pass through this to execute, so no query can hide from it. Rows come back empty,
// so the DAL's post-processing (Zod parse, "insert returned no row") may then throw — that
// is fine and expected: capture already happened, and only the SQL is wanted.
const capture: { statements: CapturedStatement[] } = { statements: [] }

/** Run a DAL method against the capturing proxy and return the SQL it emitted. */
async function captureStatements(shape: {
  run: (userId: string) => Promise<unknown>
}): Promise<CapturedStatement[]> {
  capture.statements = []
  await shape.run(USER_A).catch(() => undefined)
  return [...capture.statements]
}

/** Every `*Dal` export's methods across apps/server/src/dal/*.ts, as '<export>.<method>'. */
async function loadDalMethods(): Promise<string[]> {
  const files = readdirSync(DAL_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .sort()
  const methods: string[] = []
  for (const file of files) {
    const mod: Record<string, unknown> = await import(new URL(file, DAL_DIR).href)
    for (const [exportName, value] of Object.entries(mod)) {
      // Convention (apps/server/src/types.ts): a data-access contract is exported as an
      // object named <entity>Dal. Anything else under dal/ is a helper (cursor codecs, …).
      if (!exportName.endsWith('Dal') || typeof value !== 'object' || value === null) continue
      for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
        if (typeof member === 'function') methods.push(`${exportName}.${key}`)
      }
    }
  }
  return methods.sort()
}

if (!RLS_SUITE_READY) {
  describe.skip('RLS plan regression (skipped: database not ready)', () => {
    it('database not ready — plan probe self-skips (run node tests/rls/run-rls.mjs; FAILS CLOSED in CI)', () => {
      expect(true).toBe(true)
    })
  })
} else {
  let sql: Sql
  let migrator: Sql

  beforeAll(async () => {
    sql = appSql()
    migrator = migratorSql()
    for (const t of ISOLATION_TARGETS) {
      const sample = t.seedRow(USER_A)
      const otherCols = Object.keys(sample).filter((c) => c !== t.ownerColumn)
      for (const name of [t.table, t.ownerColumn, ...otherCols]) {
        if (!IDENT.test(name)) throw new Error(`plan probe: suspicious identifier "${name}"`)
      }
      const cols = [t.ownerColumn, ...otherCols].map((c) => `"${c}"`).join(', ')
      const placeholders = otherCols.map((_c, i) => `, $${String(i + 1)}`).join('')
      await withForceLifted(migrator, t.table, async (tx) => {
        await tx.unsafe(
          `INSERT INTO "${t.table}" (${cols})
             SELECT ${ownerSeriesExpr(t.table, `i % ${String(PROBE_OWNERS)}`)}${placeholders}
             FROM generate_series(1, ${String(PROBE_ROWS)}) AS i`,
          otherCols.map((c) => scalarParam(t.table, c, sample[c])),
        )
      })
      // Pinned statistics: the assertions below are about the PLANNER's choice, so
      // the probe never depends on autovacuum timing.
      await migrator.unsafe(`ANALYZE "${t.table}"`)
    }
  }, 60_000)

  afterAll(async () => {
    for (const t of ISOLATION_TARGETS) {
      await withForceLifted(migrator, t.table, async (tx) => {
        await tx.unsafe(
          `DELETE FROM "${t.table}" WHERE "${t.ownerColumn}" IN
               (SELECT ${ownerSeriesExpr(t.table, 'i')}
                FROM generate_series(0, ${String(PROBE_OWNERS - 1)}) AS i)`,
        )
      })
      await migrator.unsafe(`ANALYZE "${t.table}"`)
    }
    await migrator.end({ timeout: 5 })
    await sql.end({ timeout: 5 })
  }, 60_000)

  describe('RLS plan regression — policy shape (EXPLAIN, pinned stats)', () => {
    it.each(
      ISOLATION_TARGETS,
    )('$table: the RLS-scoped list uses the owner index once per statement (no Seq Scan, no per-row SubPlan)', async (t) => {
      // Mirrors the DAL list contract: NO owner_id WHERE clause — the policy is the only
      // qual, so this plan is exactly what the policy alone produces.
      const nodes = await explainAs(sql, `SELECT * FROM "${t.table}"`, [])

      const tableScans = nodes.filter((n) => n['Relation Name'] === t.table)
      expect(
        tableScans.length,
        `${t.table}: some plan node must scan the table`,
      ).toBeGreaterThanOrEqual(1)
      for (const scan of tableScans) {
        expect(
          scan['Node Type'],
          `${t.table}: must be reached through the ${t.ownerColumn} index at ${String(PROBE_ROWS)} rows — a Seq Scan here is the silent 100x RLS regression`,
        ).toMatch(/^(Index Scan|Index Only Scan|Bitmap Heap Scan)$/)
      }
      expect(
        nodes.filter((n) => n['Parent Relationship'] === 'SubPlan'),
        `${t.table}: a correlated SubPlan means the policy re-resolves identity per row — keep the (select current_setting(...)) initPlan shape`,
      ).toHaveLength(0)
      expect(
        nodes.some((n) => n['Parent Relationship'] === 'InitPlan'),
        `${t.table}: the identity sub-select must plan as a once-per-statement InitPlan`,
      ).toBe(true)
    })
  })
}

// ---------------------------------------------------------------------------
// Probe (2): every DAL query shape. The CLOSURE half is a pure registry-vs-source check —
// it needs no database and runs on every `pnpm test`. The EXPLAIN half needs the seeded
// table, so it joins the RLS_SUITE_READY branch.
// ---------------------------------------------------------------------------
if (!SHAPES_ADOPTED) {
  describe('DAL query plans (not adopted)', () => {
    it('self-disables when tests/rls/dal-shapes.ts is absent', () => {
      console.warn(
        'NOTE — DAL plan probe inactive: tests/rls/dal-shapes.ts is absent, so the queries the DAL\n' +
          '       actually issues (their ordering, keyset ranges and filters) are UNMEASURED — only the\n' +
          '       bare policy predicate is proven. The registry names YOUR DAL methods, so `update`\n' +
          '       cannot write it for you. Adopt it with:\n' +
          '         npx next-expo-supabase-agent-harness update --refresh-seeded tests/rls/dal-shapes.ts\n' +
          '       then add `drizzle-orm` to the ROOT devDependencies (the probe captures emitted SQL\n' +
          "       through drizzle's pg-proxy) and register one shape per DAL method.",
      )
      expect(SHAPES_ADOPTED).toBe(false)
    })
  })
} else {
  // vi.doMock, NOT vi.mock: doMock is not hoisted, so it can sit behind this adoption branch
  // and only affects the dynamic imports below it. A consumer without the registry never
  // resolves apps/server/src/db/context.js — or drizzle-orm — at all.
  vi.doMock('../../apps/server/src/db/context.js', () => ({
    withUserContext: async <T>(_userId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const { drizzle } = await import('drizzle-orm/pg-proxy')
      const proxy = drizzle((sql: string, params: unknown[]) => {
        capture.statements.push({ sql, params })
        return Promise.resolve({ rows: [] })
      })
      return fn(proxy)
    },
  }))

  const { DAL_SHAPES } = await import('./dal-shapes.js')
  const dalMethods = await loadDalMethods()

  describe('DAL plan registry closure (static — no database required)', () => {
    it('every DAL method has at least one registered plan shape', () => {
      const registered = new Set(DAL_SHAPES.map((s) => s.method))
      const unregistered = dalMethods.filter((m) => !registered.has(m))
      expect(
        unregistered,
        `apps/server/src/dal exports ${String(dalMethods.length)} method(s); the ones listed have NO plan\n` +
          'shape in tests/rls/dal-shapes.ts, so the SQL they emit is EXPLAINed by nothing and can ship a\n' +
          'Seq Scan or a whole-partition Sort at scale while every gate stays green. Add one shape per\n' +
          'method — and one per interesting ARGUMENT shape, since a first page and a cursor page plan\n' +
          'differently.',
      ).toEqual([])
    })

    it('every registered shape names a real DAL method and a seeded table', () => {
      const known = new Set(dalMethods)
      // A stale shape is not cosmetic: it is a probe that silently stopped covering
      // anything, which is exactly the fail-open this file exists to prevent.
      const stale = DAL_SHAPES.filter((s) => !known.has(s.method)).map((s) => s.id)
      expect(
        stale,
        'shape(s) naming a DAL method that no longer exists — delete or retarget them',
      ).toEqual([])

      const tables = new Set(ISOLATION_TARGETS.map((t) => t.table))
      const unseeded = DAL_SHAPES.filter((s) => !tables.has(s.table)).map((s) => s.id)
      expect(
        unseeded,
        'shape(s) whose `table` is not an ISOLATION_TARGETS entry in tests/rls/db-context.ts. Only those\n' +
          'tables are bulk-seeded and ANALYZEd, so this plan would be measured against an EMPTY table —\n' +
          "where a Seq Scan is the planner's CORRECT choice and the probe would prove nothing. Register\n" +
          'the table for isolation first.',
      ).toEqual([])
    })

    it('every forbidden-node allowance carries a reason', () => {
      const unjustified = DAL_SHAPES.filter(
        (s) => (s.allow?.length ?? 0) > 0 && (s.reason ?? '').trim() === '',
      ).map((s) => s.id)
      expect(
        unjustified,
        'shape(s) allowing a forbidden plan node with no `reason` — accepting a Sort or a Seq Scan is a\n' +
          'reviewed human decision and has to say why, in the file',
      ).toEqual([])
    })

    it('every registered shape actually emits SQL (no vacuous shape)', async () => {
      // Anti-vacuity: a shape whose run() short-circuits before touching the database (a
      // guard clause, a cache hit) would "pass" every plan assertion below by having no plan
      // at all. The probe must never report green on a query it never saw.
      for (const shape of DAL_SHAPES) {
        expect(
          (await captureStatements(shape)).length,
          `${shape.id}: run() emitted NO SQL — this shape measures nothing`,
        ).toBeGreaterThanOrEqual(1)
      }
    })
  })

  if (RLS_SUITE_READY) {
    describe('DAL query plans — the SQL the DAL really emits (EXPLAIN, pinned stats)', () => {
      let sql: Sql

      beforeAll(() => {
        sql = appSql()
      })
      afterAll(async () => {
        await sql.end({ timeout: 5 })
      })

      it.each(
        DAL_SHAPES,
      )('$id: plans with no Seq Scan, no Sort, and no per-row SubPlan', async (shape) => {
        const statements = await captureStatements(shape)
        expect(statements.length, `${shape.id}: run() emitted no SQL`).toBeGreaterThanOrEqual(1)
        const allowed = new Set<string>(shape.allow ?? [])

        for (const statement of statements) {
          const nodes = await explainAs(sql, statement.sql, statement.params)

          // Non-vacuous: the plan must actually touch the table this shape claims to probe.
          const touching = nodes.filter((n) => n['Relation Name'] === shape.table)
          expect(
            touching.length,
            `${shape.id}: no plan node touches "${shape.table}" — the shape's declared table is wrong, so\n` +
              `nothing about this query was really checked.\nSQL: ${statement.sql}`,
          ).toBeGreaterThanOrEqual(1)

          const offending = nodes
            .map((n) => n['Node Type'])
            .filter((t) => FORBIDDEN_NODES.includes(t as (typeof FORBIDDEN_NODES)[number]))
            .filter((t) => !allowed.has(t))
          expect(
            offending,
            `${shape.id}: forbidden plan node(s).\n` +
              '  A Seq Scan under an RLS policy is the silent 100x regression — every page reads the whole\n' +
              "  table. A Sort means the index does not carry this query's ORDER BY, so the database sorts\n" +
              "  the owner's ENTIRE partition to return one page: O(all their rows) per request instead of\n" +
              '  O(page). That is precisely the defect 0002_notes_keyset_idx.sql fixed, and it recurs\n' +
              '  whenever a new ORDER BY is not carried by an index.\n' +
              '  FIX: add a migration indexing (<owner column>, <the ORDER BY columns, in their declared\n' +
              '  direction>) so ONE index serves the policy, the ordering and the keyset range.\n' +
              `  If the plan is genuinely acceptable, add allow: ['<node>'] + a reason to the shape in\n` +
              `  tests/rls/dal-shapes.ts — a reviewed human decision.\nSQL: ${statement.sql}`,
          ).toEqual([])

          // A correlated SubPlan re-resolves identity (or a sub-select) PER ROW.
          expect(
            nodes.filter((n) => n['Parent Relationship'] === 'SubPlan'),
            `${shape.id}: a correlated SubPlan re-evaluates per row — keep the\n` +
              `(select current_setting(...)) initPlan shape in the policy.\nSQL: ${statement.sql}`,
          ).toHaveLength(0)

          // Reads must resolve identity once per statement. A pure INSERT ... VALUES plans no
          // scan of the table (its WITH CHECK is applied at execution, not planned as an
          // InitPlan), so requiring one there would be a false red.
          if (touching.some((n) => /Scan$/.test(n['Node Type']))) {
            expect(
              nodes.some((n) => n['Parent Relationship'] === 'InitPlan'),
              `${shape.id}: the identity sub-select must plan as a once-per-statement InitPlan.\nSQL: ${statement.sql}`,
            ).toBe(true)
          }
        }
      })

      it('no forbidden-node allowance is stale', async () => {
        // The reviewed escape must not rot into a fail-open. If a shape allows 'Sort' but the
        // plan no longer HAS one, the allowance suppresses nothing — and sits there ready to
        // hide a real sort the next time an index changes. Delete it.
        for (const shape of DAL_SHAPES) {
          if ((shape.allow?.length ?? 0) === 0) continue
          const seen = new Set<string>()
          for (const statement of await captureStatements(shape)) {
            for (const node of await explainAs(sql, statement.sql, statement.params)) {
              seen.add(node['Node Type'])
            }
          }
          for (const allowance of shape.allow ?? []) {
            expect(
              seen.has(allowance),
              `${shape.id}: allow: ['${allowance}'] no longer suppresses anything — the plan contains no\n` +
                `${allowance} node. Delete the allowance: a stale escape is a loaded gun aimed at the next\n` +
                'index change.',
            ).toBe(true)
          }
        }
      })
    })
  }
}
