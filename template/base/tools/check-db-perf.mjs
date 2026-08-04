#!/usr/bin/env node
// Gate: db-perf — the PLAN, at scale, under real RLS. The live half of `query-shapes`,
// and the only check in this repo that can falsify the claim the tenancy design rests on.
//
// THE PROOF THAT MAKES IT NECESSARY, measured rather than argued (selftest Canary 24).
// Drop `notes_org_id_created_at_id_idx` from the live database and change no file. The
// index is still declared in the migration and in supabase/schemas, and `notes_pkey`
// still leads with the tenant key — so `schema-rls`, `tenancy`, `query-shapes` and all
// 109 pgTAP tests STAY GREEN, while every list page in the product becomes a filter plus
// an in-memory sort of the tenant's rows. This gate reds on it three ways at once: a Sort
// node, the planner falling back to `notes_pkey`, and 1491 buffers against a 900 budget.
//
// Two tidier-sounding versions of that proof were tried and do NOT work, recorded so
// nobody re-derives them: rewriting a policy predicate as `org_id::text = $1::text`
// leaves the DAL's own indexable equality in place, so the plan does not change; and
// making a tenancy helper VOLATILE changes nothing either, because an uncorrelated
// sub-select becomes an InitPlan regardless of volatility.
//
// IT ASSERTS SHAPE, NEVER MILLISECONDS. Timings are printed and never compared: a
// wall-clock threshold on a shared CI runner is a coin flip, and a flaky perf gate gets
// deleted, taking the real assertion with it. What is asserted is structural and does
// not flap — which index the planner CHOSE, that there is no Sort above a keyset leaf,
// that no per-row SubPlan sits beneath a tenant scan, and that the buffer count is in
// the right order of magnitude.
//
// `SET enable_seqscan = off` IS DELIBERATELY NOT USED. Forcing the plan is the classic
// way to make this gate lie: with seqscan disabled the planner will use ANY index, and a
// table whose only index is useless still produces an Index Scan node. The plan must be
// the one the planner would actually pick, or the assertion is about the flag.
// SOURCE: https://www.postgresql.org/docs/17/using-explain.html
//
// It runs in the path-filtered `db-scale` CI lane, never in the agent-time chain: it
// needs `supabase/seeds/scale.sql` applied (millions of rows) and a real ANALYZE. If the
// table is smaller than the reviewed floor it SKIPS LOUDLY locally and FAILS in CI —
// a plan probe against a small table certifies nothing, and certifying nothing while
// printing OK is the failure mode this whole harness exists to prevent.
// SOURCE: docs/harness/gates-catalog.md (db-perf) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'
import { parseShapes, resolveIndex, selectSql } from './lib/query-shapes.mjs'
import { parseIndexes, readSqlDir, splitStatements } from './lib/sql-parse.mjs'

const GATE = 'db-perf'
const MANIFEST = 'tools/generated/query-shapes.json'
const BASELINE = 'tools/db-perf-baseline.json'
const TENANCY = 'tools/tenancy.json'
const MIGRATIONS_DIR = 'supabase/migrations'

if (!existsSync(MANIFEST)) skipOrFail(GATE, `${MANIFEST} is missing — run \`pnpm gen\``)
if (!existsSync(BASELINE)) {
  fail(GATE, `${BASELINE} is missing — the plan budgets must exist as reviewable data`)
}

const dbUrl = process.env['SUPABASE_DB_URL']
if (dbUrl === undefined || dbUrl === '') {
  skipOrFail(
    GATE,
    'SUPABASE_DB_URL is not set — the plan probe needs a live, scale-seeded database',
  )
}

let postgres
try {
  // `postgres` is a SCAFFOLD dependency, and this file lives in the harness repo where
  // it is deliberately absent — so the specifier is unresolvable exactly here and
  // resolvable exactly where the gate runs. Suppressed on the import line rather than
  // by excluding the file from tsconfig (the older precedent for scaffold-only imports),
  // because excluding it would stop typechecking the other ~200 lines of a brand-new
  // gate to silence one specifier. If `postgres` is ever added to the harness root, this
  // suppression goes unused and reds — which is the correct prompt to delete it.
  // @ts-expect-error -- scaffold-only dependency; resolvable in an installed consumer, never here
  ;({ default: postgres } = await import('postgres'))
} catch {
  skipOrFail(GATE, 'the `postgres` driver is not installed — run pnpm install')
}

const shapes = parseShapes(readFileSync(MANIFEST, 'utf8')).filter((s) => s.op === 'select')
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const tenancy = JSON.parse(readFileSync(TENANCY, 'utf8'))
const tenantColumn = tenancy.tenantColumn
const { all: indexes } = parseIndexes(splitStatements(readSqlDir(MIGRATIONS_DIR)))

// prepare:false because a named prepared statement lives on one backend and the next
// request gets another — the same rule the whole repo is held to.
const sql = postgres(dbUrl, { max: 1, prepare: false })
const errs = []
const report = []

/** Every node in an EXPLAIN JSON plan tree, depth first. */
function* walkPlan(node) {
  yield node
  for (const child of node.Plans ?? []) yield* walkPlan(child)
}

/**
 * The tenant with the most rows — the whale the seed created. Chosen by MEASUREMENT
 * rather than by a hardcoded fixture id, so the probe measures whatever the seed
 * actually produced and a reseeding with different ids does not silently probe an org
 * with four rows in it.
 */
async function whaleOrg(table) {
  const rows = await sql.unsafe(
    `SELECT "${tenantColumn}" AS org, count(*)::bigint AS n
       FROM public."${table}" GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
  )
  return rows[0] ?? null
}

/**
 * Values for a shape's placeholders, resolved FROM THE DATABASE. A fixture file of
 * literals would drift from the seed and would eventually probe rows that do not exist,
 * which plans beautifully and proves nothing.
 *
 * The keyset row is taken from deep inside the tenant's range (not the newest row), so
 * the seek predicate actually has to traverse rather than matching at the very first
 * index entry. The OFFSET here is fixture SELECTION, not application pagination — the
 * thing the `query-shapes` gate bans in a DAL, used once against a probe's own setup.
 */
async function bindValues(shape, org) {
  const orderCols = shape.order.map((o) => `"${o.column}" ${o.ascending ? 'ASC' : 'DESC'}`)
  const deep = await sql.unsafe(
    `SELECT * FROM public."${shape.table}" WHERE "${tenantColumn}" = $1
       ${orderCols.length > 0 ? `ORDER BY ${orderCols.join(', ')}` : ''}
       LIMIT 1 OFFSET 1000`,
    [org],
  )
  const sample =
    deep[0] ??
    (
      await sql.unsafe(
        `SELECT * FROM public."${shape.table}" WHERE "${tenantColumn}" = $1 LIMIT 1`,
        [org],
      )
    )[0]
  if (sample === undefined) return null
  return (column) => (column === tenantColumn ? org : sample[column])
}

async function explainAs(userId, text, values) {
  return await sql.begin(async (tx) => {
    // The Supabase impersonation model, transaction-local: the `authenticated` role is
    // policy-subject (never BYPASSRLS) and auth.uid() reads the claims' `sub`.
    // SOURCE: request.jwt.claims + SET LOCAL ROLE authenticated [corpus: postgres/rls-force]
    await tx`SET LOCAL ROLE authenticated`
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: 'authenticated', sub: userId })}, true)`
    const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values)
    return rows[0]['QUERY PLAN'][0]
  })
}

function judge(shape, plan, indexName, budget) {
  const root = plan.Plan
  const nodes = [...walkPlan(root)]
  const found = []
  for (const n of nodes) {
    if (n['Node Type'] === 'Seq Scan' && n['Relation Name'] === shape.table) {
      found.push(
        `Seq Scan on public.${shape.table} — the planner priced reading EVERY tenant's rows below using ${indexName}. Either the predicate is not indexable (a cast or a function on the indexed side is the usual cause) or the statistics are stale (ANALYZE).`,
      )
    }
    if (n['Node Type'] === 'Sort' || n['Node Type'] === 'Incremental Sort') {
      found.push(
        `${n['Node Type']} node (keys: ${(n['Sort Key'] ?? []).join(', ')}) — the index must SUPPLY the order, not merely the filter. A sort above a keyset leaf means the index tail does not match the ORDER BY, and its cost grows with the tenant's row count on every page.`,
      )
    }
    if (n['Parent Relationship'] === 'SubPlan') {
      found.push(
        `per-row SubPlan (${n['Node Type']}) beneath the tenant scan — a correlated sub-select re-evaluated once per candidate row. The tenancy helpers must be uncorrelated so the planner hoists them into a single InitPlan.`,
      )
    }
  }
  const usedIndexes = nodes.map((n) => n['Index Name']).filter((n) => n !== undefined)
  if (!usedIndexes.includes(indexName)) {
    found.push(
      `expected the planner to choose ${indexName} (the index tools/check-query-shapes.mjs resolved statically); it used ${usedIndexes.length > 0 ? usedIndexes.join(', ') : '<no index at all>'}. The static gate and this one MUST agree — a disagreement means one of them is measuring a query the app does not send.`,
    )
  }
  const rowsOut = Number(root['Actual Rows'] ?? 0)
  const blocks = Number(root['Shared Hit Blocks'] ?? 0) + Number(root['Shared Read Blocks'] ?? 0)
  if (rowsOut > budget.maxActualRows) {
    found.push(
      `returned ${String(rowsOut)} rows, budget ${String(budget.maxActualRows)} — the statement is not bounded the way the manifest says it is.`,
    )
  }
  if (blocks > budget.maxSharedBlocks) {
    found.push(
      `touched ${String(blocks)} shared buffers, budget ${String(budget.maxSharedBlocks)} — the plan reaches the right rows by reading far too much of the table.`,
    )
  }
  return { found, rows: rowsOut, blocks, ms: Number(root['Actual Total Time'] ?? 0) }
}

try {
  const tables = [...new Set(shapes.map((s) => s.table))]
  for (const table of tables) {
    const floor = baseline.minRows?.[table]
    if (typeof floor !== 'number') {
      fail(
        GATE,
        `${BASELINE}: no minRows floor for "${table}" — without one this gate would certify a two-row table`,
      )
    }
    const rows = await sql.unsafe(`SELECT count(*)::bigint AS n FROM public."${table}"`)
    const n = Number(rows[0].n)
    if (n < floor) {
      await sql.end({ timeout: 5 }).catch(() => {})
      skipOrFail(
        GATE,
        `public.${table} holds ${String(n)} row(s), below the reviewed floor of ${String(floor)} — a plan probe against a small table certifies nothing (apply supabase/seeds/scale.sql: \`pnpm db:scale\`)`,
      )
    }
  }

  for (const shape of shapes) {
    const match = resolveIndex(shape, indexes)
    if (match === null) {
      errs.push(`${shape.id}: no index resolves for it statically — fix \`query-shapes\` first`)
      continue
    }
    const org = await whaleOrg(shape.table)
    if (org === null) {
      errs.push(`${shape.id}: public.${shape.table} has no rows to probe`)
      continue
    }
    const members = await sql.unsafe(
      `SELECT "${tenancy.membershipUserColumn}" AS uid FROM ${tenancy.membershipTable}
         WHERE "${tenantColumn}" = $1 ORDER BY 1 LIMIT 1`,
      [org.org],
    )
    const actor = members[0]?.uid
    if (actor === undefined) {
      errs.push(
        `${shape.id}: the largest tenant has no member to impersonate — the probe would run with no policy applied, which is not the query production runs`,
      )
      continue
    }
    const { columns, text } = selectSql(shape)
    const bind = await bindValues(shape, org.org)
    if (bind === null) {
      errs.push(`${shape.id}: no sample row in the largest tenant to bind placeholders from`)
      continue
    }
    const plan = await explainAs(actor, text, columns.map(bind))
    const budget = baseline.budgets?.[shape.id] ?? baseline.budgets?.default
    if (budget === undefined) {
      fail(GATE, `${BASELINE}: no budget for ${shape.id} and no "default" entry`)
    }
    const verdict = judge(shape, plan, match.index.name, budget)
    for (const f of verdict.found) errs.push(`${shape.id}: ${f}`)
    report.push(
      `${shape.id} -> ${match.index.name} (${String(verdict.rows)} rows, ${String(verdict.blocks)} blocks, ${verdict.ms.toFixed(1)}ms)`,
    )
  }
} finally {
  await sql.end({ timeout: 5 }).catch(() => {})
}

// Timings are REPORTED, never asserted — see the header.
for (const line of report) console.log(`  ${line}`)
failures(GATE, errs)
ok(
  GATE,
  `${String(shapes.length)} read shape(s) planned as ordered index scans under live RLS at scale`,
)
