#!/usr/bin/env node
// Gate: query-budget — how many statements the API actually sends per unit of work.
//
// It is the N+1 detector, and it is the only check here that can see one. `query-shapes`
// proves each statement is index-served; `db-perf` proves the planner agrees at scale.
// Both are per-STATEMENT, and an N+1 is a defect of COUNT: a hundred perfectly-indexed
// point reads inside one request is a hundred round trips, each fast, together a page
// that takes a second and gets slower with every row the customer adds.
//
// It wraps a command rather than issuing its own requests:
//
//   node tools/check-query-budget.mjs -- pnpm --filter mobile exec jest live-api-proof
//
// so what it measures is REAL traffic through the real transport, not a synthetic call
// this file invented and would keep passing after the app stopped making it.
//
// THE FILTER IS LOAD-BEARING. `userid = 'authenticator'::regrole` restricts the count to
// statements PostgREST issued on behalf of a request. Without it the numbers include
// GoTrue's own session bookkeeping, Realtime's polling and Storage's metadata — none of
// which the application controls, all of which move on a Supabase upgrade, and together
// enough to swamp the signal. `dbid` pins it to this database, because the local stack's
// other databases share the counter.
//
// TWO ANTI-VACUITY CLAUSES, because this gate's failure mode is silence, not noise:
//   - after the reset and BEFORE the command, the filtered count must be ZERO. A
//     non-zero pre-count means the reset did not take (insufficient privilege is the
//     usual reason) and every delta afterwards is a sum with an unknown constant in it.
//   - after the command, the filtered count must be GREATER than zero. A run that
//     recorded no statements at all is not a run with a small budget — it is an
//     instrument that is not connected, and it would report OK forever.
// SOURCE: https://www.postgresql.org/docs/17/pgstatstatements.html
// SOURCE: docs/harness/gates-catalog.md (query-budget) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'query-budget'
const BASELINE = 'tools/db-perf-baseline.json'

const sep = process.argv.indexOf('--')
const command = sep === -1 ? [] : process.argv.slice(sep + 1)
if (command.length === 0) {
  fail(GATE, 'usage: node tools/check-query-budget.mjs -- <command…> (the workload to measure)')
}
if (!existsSync(BASELINE)) {
  fail(GATE, `${BASELINE} is missing — the statement budgets must exist as reviewable data`)
}
const budget = JSON.parse(readFileSync(BASELINE, 'utf8')).queryBudget
if (budget === undefined) {
  fail(
    GATE,
    `${BASELINE}: no "queryBudget" block — the budget must be reviewed data, not a default in code`,
  )
}

const dbUrl = process.env['SUPABASE_DB_URL']
if (dbUrl === undefined || dbUrl === '') {
  skipOrFail(GATE, 'SUPABASE_DB_URL is not set — the statement counter needs the live database')
}

let postgres
try {
  ;({ default: postgres } = await import('postgres'))
} catch {
  skipOrFail(GATE, 'the `postgres` driver is not installed — run pnpm install')
}

const sql = postgres(dbUrl, { max: 1, prepare: false })

// The statements PostgREST issued against THIS database, normalized by pg_stat_statements
// (literals replaced by $n), so a hundred point reads of a hundred different ids collapse
// into one row with calls = 100 — which is exactly the shape of an N+1.
const FILTERED = `
  SELECT query, calls, rows
    FROM pg_stat_statements
   WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND userid = 'authenticator'::regrole`

const errs = []
let status = 0
try {
  const ext = await sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`
  if (ext.length === 0) {
    await sql.end({ timeout: 5 }).catch(() => {})
    skipOrFail(
      GATE,
      'pg_stat_statements is not installed in this database — no statement counter exists to read',
    )
  }
  const role = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'authenticator'`
  if (role.length === 0) {
    await sql.end({ timeout: 5 }).catch(() => {})
    skipOrFail(GATE, 'no `authenticator` role — this is not a PostgREST-fronted database')
  }

  await sql`SELECT pg_stat_statements_reset()`
  const pre = await sql.unsafe(FILTERED)
  if (pre.length > 0) {
    errs.push(
      `${String(pre.length)} statement(s) already counted immediately after pg_stat_statements_reset() — the reset did not take (usually insufficient privilege), so every number below would carry an unknown constant`,
    )
  }

  const [bin, ...args] = command
  const run = spawnSync(bin, args, { env: process.env, shell: false, stdio: 'inherit' })
  status = run.status ?? 1

  const rows = await sql.unsafe(FILTERED)
  const total = rows.reduce((n, r) => n + Number(r.calls), 0)
  if (total === 0) {
    errs.push(
      'ZERO statements recorded for the `authenticator` role — the workload never reached PostgREST, so this run measured nothing. A budget met by an instrument that is not connected is not a budget.',
    )
  }
  if (total > budget.maxStatements) {
    errs.push(
      `${String(total)} statements for this workload, budget ${String(budget.maxStatements)}`,
    )
  }
  for (const r of rows) {
    if (Number(r.calls) > budget.maxCallsPerQuery) {
      errs.push(
        `one normalized statement ran ${String(r.calls)} times (budget ${String(budget.maxCallsPerQuery)}) — the N+1 shape: ${String(r.query).replace(/\s+/g, ' ').slice(0, 160)}`,
      )
    }
  }
  console.log(
    `${GATE}: ${String(total)} statement(s) across ${String(rows.length)} distinct shape(s) for the measured workload`,
  )
} finally {
  await sql.end({ timeout: 5 }).catch(() => {})
}

failures(GATE, errs)
if (status !== 0) {
  fail(
    GATE,
    `the measured workload itself failed (exit ${String(status)}) — its statement count is not a verdict on anything`,
  )
}
ok(GATE, 'statement count within the reviewed budget, and the counter proved live')
