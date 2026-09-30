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
//
// rpc() AND upsert() (1.1.0). The recorder writes each as its own op, and four rules judge
// what PostgREST or PostgreSQL would refuse at runtime. Both ops skip rules 3 and 5 (an rpc
// has no table, and an upsert's lookup is its conflict arbiter); rules 1, 2, 4 and 6 still
// apply, and an rpc or upsert is `kind: "write"`, so rule 1 never reds one.
//   7. rpc resolves   — a migration must create `public.<name>`: `public` is the one schema
//                       supabase/config.toml exposes, and PostgREST answers PGRST202 for a
//                       function its schema cache does not hold.
//   8. rpc arguments  — the recorded argument names must include every input parameter
//                       (IN, INOUT or VARIADIC) that has no DEFAULT, and must name no
//                       parameter the function lacks. Either mismatch is PGRST202 too.
//   9. upsert arbiter — the conflict columns must equal, as a set, the columns of a UNIQUE
//                       index or primary key that still exists. With no onConflict they are
//                       the primary key's, as PostgREST resolves them. PostgreSQL raises an
//                       error when ON CONFLICT inference finds no such index.
//  10. upsert tenant  — on a tenant table the payload carries the tenant column, as rule 5
//                       asks of an insert.
// LIMITS, stated rather than hidden. The parser does not model DROP FUNCTION, so a dropped
// function still resolves. resolveFunction matches on the name alone, so overloads collapse
// to the last definition in migration order. Index parsing drops the predicate of a partial
// index, so a partial UNIQUE index, which ON CONFLICT without an index predicate cannot
// infer, still reads as an arbiter. A function with an unnamed input parameter resolves, but
// its arguments are not judged. The function BODY an rpc runs is judged by no rule here.
// SOURCE: docs/harness/gates-catalog.md (query-shapes) [corpus: harness/doctrine]
// SOURCE: https://docs.postgrest.org/en/v12/references/errors.html#group-2-schema-cache
// SOURCE: https://docs.postgrest.org/en/v12/references/api/tables_views.html#on-conflict
// SOURCE: https://www.postgresql.org/docs/17/sql-insert.html
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, rampNote, skipOrFail, stampGate } from './lib/gate.mjs'
import { parseShapes, probeModules, resolveIndex } from './lib/query-shapes.mjs'
import { foldOnlyFindings, foldTouches, historyFor, withhold } from './lib/sql-fold-ramp.mjs'
import {
  parseFunctions,
  parseIndexes,
  readSqlDir,
  resolveFunction,
  splitStatements,
} from './lib/sql-parse.mjs'
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

// Folded (1.1.0): a DROP TABLE takes the table's indexes with it, so a re-created table is
// served only by the indexes created after it (tools/lib/sql-parse.mjs).
const statements = historyFor(splitStatements(readSqlDir(MIGRATIONS_DIR)))
const { all: indexes } = parseIndexes(statements)
const functions = parseFunctions(statements)
const errs = []
const served = []

// ---- rules 7-10: rpc() and upsert() ---------------------------------------------------

const PARAM_MODE = /^(IN|OUT|INOUT|VARIADIC)\s+/i
// Types whose first word reads like an identifier. Without them the unnamed parameter
// `double precision` would read as one named "double".
const MULTIWORD_TYPE =
  /^(?:double\s+precision|character\s+varying|bit\s+varying|national\s+char|time(?:stamp)?\s+with(?:out)?\s+time\s+zone)\b/i
const PARAM_NAME = /^([a-z_][a-z0-9_$]*)\s+\S/i

/**
 * One parameter declaration, `[mode] [name] type [DEFAULT expr | = expr]`, read from its
 * text: parseFunctions keeps the text but not the mode or the default, and its own name
 * reading takes the `IN` of `INOUT x` or of a name like `invite_rank` for a mode. `name` is
 * null for an unnamed parameter, and folds to lower case as PostgreSQL folds an unquoted
 * one (splitStatements drops the quotes of a quoted identifier, so a quoted mixed-case name
 * reads folded too).
 */
function paramOf(raw) {
  const mode = raw.match(PARAM_MODE)?.[1]?.toUpperCase() ?? 'IN'
  const rest = raw.replace(PARAM_MODE, '')
  const cut = rest.search(/\bDEFAULT\b|=/i)
  const decl = (cut === -1 ? rest : rest.slice(0, cut)).trim()
  const m = MULTIWORD_TYPE.test(decl) ? null : decl.match(PARAM_NAME)
  const name = m === null ? null : m[1].toLowerCase()
  return { hasDefault: cut !== -1, mode, name }
}

/** Rules 7 and 8: the function exists in `public`, and the call names its parameters. */
function rpcFindings(shape, at) {
  const { args, name } = shape.rpc
  const qualified = `public.${name}`
  const fn = resolveFunction(functions, qualified)
  if (fn === undefined) {
    return [
      `${at}: calls rpc ${qualified}, which no migration creates — \`public\` is the schema PostgREST exposes, and it answers PGRST202 (not found in the schema cache) for a function it does not hold. Create it in ${MIGRATIONS_DIR}/, or call a name a migration creates.`,
    ]
  }
  const inputs = fn.params.map((p) => paramOf(p.raw)).filter((p) => p.mode !== 'OUT')
  // An unnamed input parameter cannot be matched by name: stated as a limit in the header.
  if (inputs.some((p) => p.name === null)) return []
  const out = []
  const missing = inputs.filter((p) => !p.hasDefault && !args.includes(p.name)).map((p) => p.name)
  if (missing.length > 0) {
    out.push(
      `${at}: calls rpc ${qualified} without its required parameter(s) ${missing.join(', ')} — every input parameter with no DEFAULT must be named, or PostgREST finds no function with that argument list and answers PGRST202.`,
    )
  }
  const unknown = args.filter((a) => !inputs.some((p) => p.name === a))
  if (unknown.length > 0) {
    out.push(
      `${at}: calls rpc ${qualified} and names ${unknown.join(', ')}, which ${qualified} has no input parameter called — PostgREST matches a function by its argument names, so it finds none and answers PGRST202.`,
    )
  }
  return out
}

/** Order-free identity of a column set. NUL cannot appear in an identifier. */
const columnSet = (columns) => [...new Set(columns)].sort().join('\u0000')

/** Rule 9's arbiter: the UNIQUE index or primary key ON CONFLICT would infer, or null. */
function arbiterOf(shape) {
  const unique = indexes.filter((idx) => idx.table === shape.table && idx.unique)
  if (shape.onConflict === null) return unique.find((idx) => idx.primaryKey) ?? null
  const want = columnSet(shape.onConflict)
  return unique.find((idx) => columnSet(idx.columns.map((c) => c.name)) === want) ?? null
}

/** Rules 9 and 10, plus the served line when the arbiter resolves. */
function upsertFindings(shape, at) {
  const out = []
  if (!untenanted.has(shape.table) && !shape.payload.includes(tenantColumn)) {
    out.push(
      `${at}: upsert into tenant table "${shape.table}" writes no ${tenantColumn} — the WITH CHECK policy will refuse it at runtime.`,
    )
  }
  const arbiter = arbiterOf(shape)
  if (arbiter !== null)
    return { findings: out, served: `${shape.id} -> ON CONFLICT ${arbiter.name}` }
  const target = `public.${shape.table}`
  if (shape.onConflict === null) {
    out.push(
      `${at}: upsert into ${target} with no onConflict targets the primary key, as PostgREST resolves it, and no migration gives ${target} one — there is no arbiter for the conflict. Add a primary key, or pass onConflict naming the columns of a UNIQUE index.`,
    )
  } else {
    const cols = shape.onConflict
    out.push(
      `${at}: upsert into ${target} ON CONFLICT (${cols.join(', ')}) — no UNIQUE index or primary key on ${target} has exactly those columns, so PostgreSQL cannot infer an arbiter and the statement fails at runtime. Name the columns of a unique index that exists, or add one: CREATE UNIQUE INDEX ${shape.table}_${cols.join('_')}_key ON ${target} (${cols.join(', ')});`,
    )
  }
  return { findings: out, served: null }
}

/** Rules 7-10 for one rpc or upsert row. */
function judgeCall(shape, at) {
  if (shape.op === 'upsert') return upsertFindings(shape, at)
  const findings = rpcFindings(shape, at)
  return {
    findings,
    served: findings.length === 0 ? `${shape.id} -> rpc public.${shape.rpc.name}` : null,
  }
}

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

  // 7-10. An rpc or upsert is judged by its own rules and skips rules 3 and 5, explicitly:
  // an rpc's table is null, and an upsert carries no equality to lead an index with.
  if (shape.op === 'rpc' || shape.op === 'upsert') {
    const call = judgeCall(shape, at)
    errs.push(...call.findings)
    if (call.served !== null) served.push(call.served)
    continue
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

// THE 1.1.0 HISTORY FOLD RAMP (#75). An index a DROP TABLE took with it no longer serves a
// shape. That finding is new judgement of applied history the old parser could not read, so on
// an install whose baseVersion predates 1.1.0 it is a dated NOTE until 1.2.0; a finding both
// readings produce stays hard. tools/lib/sql-fold-ramp.mjs replays this script over the
// pre-fold history to tell them apart.
const fold = await foldOnlyFindings(import.meta.url, [errs], foldTouches(statements))
if (!fold.replayed) {
  console.log(
    `${GATE}: the 1.0.x replay of the migration history did not report, so no finding is lifted by the 1.1.0 fold ramp`,
  )
}
if (fold.foldOnly.length > 0) {
  const foldRamped = rampNote(GATE, '1.1.0', 'the SQL history fold (DROP TABLE and ALTER POLICY)', {
    until: '1.2.0',
  })
  if (foldRamped) {
    withhold([errs], fold.foldOnly)
    for (const e of fold.foldOnly) console.log(`${GATE}: NOTE — (ramp) ${e}`)
  }
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
