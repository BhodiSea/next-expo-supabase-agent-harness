#!/usr/bin/env node
// Gate: query-shapes — every statement the DALs actually issue is SERVED BY AN INDEX
// and BOUNDED, judged against the manifest their own execution wrote.
//
// THE CLAIM THIS GATE EXISTS TO FALSIFY. The whole tenancy design rests on one
// performance assertion: that `org_id = ANY(<InitPlan uuid[]>)` plus the list screen's
// keyset order is an ORDERED INDEX SCAN, not a filter followed by a Sort over every
// tenant's rows. Until this gate existed nothing in the repo could contradict it —
// `schema-rls` proves the index EXISTS and pgTAP proves its leading column, and both
// stay green while the index serves the filter and the sort is done in memory.
//
// WHY STATIC HERE AND LIVE IN CI. This half is decidable from the migration text: given
// the columns a query filters on and the columns it orders by, either some index
// carries them as a prefix in the right directions or none does, and that is a
// one-line authoring-time mistake an agent must be told about in the same turn.
// The half that needs a real planner, real statistics and real cardinality is
// tools/check-db-perf.mjs, in the path-filtered `db-scale` lane. Neither subsumes the
// other: this one cannot prove the planner CHOOSES the index it found, and that one
// cannot run in six seconds.
//
// THE RULES, and what each one catches that the others do not:
//   1. bounded    — a read with no LIMIT and no aggregate is a query whose cost is the
//                   tenant's row count. It is fine on the day it ships, forever.
//   2. no `extra` — any builder method outside the reviewed set, by name. This is where
//                   `.range()` / `.offset()` die: OFFSET pagination re-reads and
//                   re-discards every skipped row, so page 500 costs 500 pages.
//   3. served     — an index whose leading columns are the equality set, followed by
//                   the ORDER BY columns in order and in a single scan direction.
//   4. seek/sort  — a keyset cursor's columns must be exactly the sort columns, in the
//                   same order. A cursor that disagrees with the sort silently skips or
//                   repeats rows at page boundaries — a correctness bug that looks like
//                   a pagination preference.
//   5. tenant-led — on a tenant table, the tenant column must be in the equality set
//                   AND lead the serving index. This is a PERFORMANCE rule with an
//                   authorization shadow: the policy qual filters by org either way,
//                   but without the leading column it filters by scanning.
//   6. ceiling    — no LIMIT above `[api].max_rows`, which PostgREST silently truncates
//                   to, breaking the has-more probe every keyset page depends on.
// SOURCE: docs/harness/gates-catalog.md (query-shapes) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, rampNote, skipOrFail, stampGate } from './lib/gate.mjs'
import { parseShapes, probeModules, resolveIndex } from './lib/query-shapes.mjs'
import { parseIndexes, readSqlDir, splitStatements } from './lib/sql-parse.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'query-shapes'
const MANIFEST = 'tools/generated/query-shapes.json'
const TENANCY = 'tools/tenancy.json'
const LIMITS = 'tools/db-limits.json'
const MIGRATIONS_DIR = 'supabase/migrations'
const VERTICALS_ROOT = 'packages/verticals'
const RAMP = '0.2.0'

const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

// No DAL surface at all: nothing to judge. Distinguished from "a DAL exists and the
// manifest is empty", which is the tampering case and fails closed below.
if (!existsSync(VERTICALS_ROOT) || !existsSync(MIGRATIONS_DIR)) {
  skipOrFail(
    GATE,
    `no ${VERTICALS_ROOT}/ or ${MIGRATIONS_DIR}/ — there are no query shapes to serve`,
  )
}

// THE ADOPTION SEAM, and it has to come BEFORE the absent/empty manifest verdicts.
//
// An empty manifest has two utterly different causes and only one of them is a defect:
//   - no vertical carries a src/data/query-probes.ts — the DAL was never instrumented.
//     That is every install that predates 0.2.0, and the probes are seedOnInitOnly, so
//     `update` deliberately does not plant them. Judging it is a gate reporting on a
//     feature the tree does not have.
//   - probes EXIST and the manifest is absent or empty — generation never ran, or the
//     file was emptied. Every rule below would then pass over nothing.
// Deriving both from probeModules() (shared with the generator) is what keeps the
// distinction honest: the gate cannot ramp its way past an instrumented DAL, and it
// cannot demand a manifest from a tree with nothing to record.
const probes = probeModules()
if (probes.length === 0) {
  const note = `no ${VERTICALS_ROOT}/*/src/data/query-probes.ts — the DAL is not instrumented`
  if (rampNote(GATE, RAMP, note, { until: '0.4.0' })) {
    ok(GATE, `pre-${RAMP} install with no query probes — adopt with \`update --refresh-seeded\``)
  }
  skipOrFail(
    GATE,
    `no ${VERTICALS_ROOT}/*/src/data/query-probes.ts — a DAL no probe drives records no shapes, so every rule here would judge an empty list`,
  )
}

if (!existsSync(MANIFEST)) {
  // The generator is the only thing that writes this file, and `contracts` proves it is
  // fresh. Its ABSENCE beside an INSTRUMENTED DAL means generation never ran, so every
  // rule below would pass over an empty list.
  fail(
    GATE,
    `${MANIFEST} is missing while ${probes.length} query-probe module(s) exist — run \`pnpm gen\` and commit it (an absent manifest would make every rule in this gate vacuous)`,
  )
}

let shapes
try {
  shapes = parseShapes(readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${MANIFEST}: ${e.message} — it is generated and write-guard-protected, so a malformed manifest is tampering; re-run \`pnpm gen\``,
  )
}

if (shapes.length === 0) {
  fail(
    GATE,
    `${MANIFEST} is EMPTY while ${probes.length} query-probe module(s) exist — a manifest with no shapes passes every check below without judging anything; re-run \`pnpm gen\``,
  )
}

const ramped = rampNote(
  GATE,
  RAMP,
  'index-service and boundedness rules over the generated query-shape manifest',
  { until: '0.4.0' },
)

const tenancy = JSON.parse(readFileSync(TENANCY, 'utf8'))
const tenantColumn = tenancy.tenantColumn
const untenanted = new Set((tenancy.untenantedTables ?? []).map((t) => t.table))
const maxRows = existsSync(LIMITS)
  ? (JSON.parse(readFileSync(LIMITS, 'utf8')).apiMaxRows ?? null)
  : null

const { all: indexes } = parseIndexes(splitStatements(readSqlDir(MIGRATIONS_DIR)))
const errs = []
const served = []

for (const shape of shapes) {
  const at = `${MANIFEST} (${shape.id})`

  // 2. Unreviewed builder methods, by name.
  if (shape.extra.length > 0) {
    errs.push(
      `${at}: uses ${shape.extra.map((m) => `.${m}()`).join(', ')} — outside the reviewed query grammar. OFFSET/range pagination in particular re-reads and discards every skipped row, so cost grows with page number; use the keyset cursor (packages/verticals/notes is the worked pattern). SOURCE: https://use-the-index-luke.com/no-offset`,
    )
  }

  // 1. Boundedness.
  if (shape.kind === 'unbounded') {
    errs.push(
      `${at}: unbounded read — no LIMIT, no aggregate projection. Its cost is the tenant's whole row count, so it is fast exactly until a customer is successful. Add an unconditional .limit() (keyset) or project an aggregate.`,
    )
  }
  if (maxRows !== null && shape.limit !== null && shape.limit > maxRows) {
    errs.push(
      `${at}: LIMIT ${String(shape.limit)} exceeds [api].max_rows ${String(maxRows)} — PostgREST truncates silently at max_rows, so the sentinel row a keyset page uses to detect "has more" never arrives and pagination stops one page early with no error.`,
    )
  }

  // 4. Cursor/sort agreement, and — the rule a live plan probe earned — the cursor must
  // be able to POSITION the scan, not merely filter it.
  if (shape.orColumns.length > 0) {
    const sortCols = shape.order.map((o) => o.column)
    if (shape.orColumns.join(',') !== sortCols.join(',')) {
      errs.push(
        `${at}: keyset cursor is over (${shape.orColumns.join(', ')}) but the sort is (${sortCols.join(', ') || '<none>'}) — a cursor that disagrees with the ORDER BY skips or repeats rows at every page boundary.`,
      )
    }
    // THE EXPENSIVE MISTAKE THAT LOOKS RIGHT. The natural way to write a keyset seek is
    // one disjunction covering both lexicographic cases — `created_at < X OR
    // (created_at = X AND id < Y)` — and it is correct, portable and O(page number).
    // PostgreSQL cannot turn a top-level OR into an index range, so the whole predicate
    // lands in `Filter:` and the scan still starts at the newest row the tenant owns.
    // Measured on 1.1M seeded rows at page 1000: 1115 rows discarded to return 21.
    // That is the OFFSET cost the cursor exists to avoid, in a keyset costume, and it is
    // invisible to every other check here. An indexable RANGE on the leading sort column
    // (sent as its own predicate, alongside the disjunction) is what positions the scan.
    const leadSort = shape.order[0]?.column
    if (leadSort !== undefined && !shape.range.some((r) => r.column === leadSort)) {
      errs.push(
        `${at}: the keyset seek carries no range predicate on "${leadSort}", its leading sort column — a top-level OR cannot bound an index scan, so the cursor becomes a Filter and every page re-reads and discards the rows before it (the exact cost of OFFSET). Send the range as its own predicate too: .lte('${leadSort}', <cursor value>) alongside the disjunction.`,
      )
    }
  }

  // 5. Tenant column present on any statement against a tenant table.
  const tenantTable = !untenanted.has(shape.table)
  if (tenantTable && shape.op !== 'insert' && !shape.eq.includes(tenantColumn)) {
    errs.push(
      `${at}: ${shape.op} on tenant table "${shape.table}" with no ${tenantColumn} equality — the policy still filters by tenant, but without the leading column it filters by SCANNING every tenant's rows. Add .eq('${tenantColumn}', <the resolved acting org>).`,
    )
  }
  if (tenantTable && shape.op === 'insert' && !shape.payload.includes(tenantColumn)) {
    errs.push(
      `${at}: insert into tenant table "${shape.table}" writes no ${tenantColumn} — the WITH CHECK policy will refuse it at runtime.`,
    )
  }

  // 3. An index that serves filter AND sort. INSERT has no lookup to serve.
  if (shape.op === 'insert') continue
  const match = resolveIndex(shape, indexes)
  if (match === null) {
    const want = [
      ...shape.eq,
      ...shape.order.map((o) => `${o.column} ${o.ascending ? 'ASC' : 'DESC'}`),
    ].join(', ')
    errs.push(
      `${at}: no index on public.${shape.table} serves it. It filters on (${shape.eq.join(', ') || '<none>'}) and orders by (${shape.order.map((o) => `${o.column} ${o.ascending ? 'ASC' : 'DESC'}`).join(', ') || '<none>'}); an index needs those columns as a PREFIX — the equality set first, then the sort columns in order and in one scan direction. Add: CREATE INDEX ${shape.table}_${[...shape.eq, ...shape.order.map((o) => o.column)].join('_')}_idx ON public.${shape.table} (${want});`,
    )
    continue
  }
  if (tenantTable && match.index.columns[0]?.name !== tenantColumn) {
    errs.push(
      `${at}: served by ${match.index.name}, whose leading column is "${match.index.columns[0]?.name ?? '<none>'}" and not "${tenantColumn}" — on a tenant table the tenant key must lead, or every tenant's rows are in the scan before the filter runs.`,
    )
    continue
  }
  served.push(
    `${shape.id} -> ${match.index.name}${match.direction === 'backward' ? ' (backward)' : ''}`,
  )
}

if (ramped) {
  if (errs.length > 0) {
    console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) held back by the ${RAMP} ramp:`)
    for (const e of errs) console.log(`  - ${e}`)
  }
  ok(
    GATE,
    `RAMPED to ${RAMP} — ${String(shapes.length)} query shape(s) read, findings reported as NOTEs`,
  )
}

failures(GATE, errs)
recordGreen()
ok(
  GATE,
  `${String(shapes.length)} query shape(s), each bounded and index-served: ${served.join('; ')}`,
)
