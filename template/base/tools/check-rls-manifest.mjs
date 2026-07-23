#!/usr/bin/env node
// Gate: schema-rls — every table DECLARED in supabase/schemas/*.sql is covered, in
// the APPLIED migration SQL (supabase/migrations/*.sql), by ENABLE + FORCE ROW LEVEL
// SECURITY and per-operation policies; every policy predicate is real (no
// USING (true)) and resolves identity through the initPlan sub-select pattern
// ((select auth.uid())); every table a migration creates is declared in a schema;
// every non-exempt table is wired into BOTH runtime registries — the client suite's
// ISOLATION_TARGETS (tests/rls/db-context.ts) and the pgTAP structural suite's
// rls_targets (supabase/tests/rls_structure.test.sql) — which must name the SAME set
// on the SAME owner columns, so neither can silently under-cover; and every target's
// owner column is the LEADING column of some migration-declared index (a PRIMARY KEY
// or UNIQUE on that column counts). Or the table is explicitly exempted in
// tools/rls-exempt.json (write-guard-protected, human-reviewed, reasons required).
//
// Static and <100ms: statement-level SQL parsing, not substring vibes — an early
// regex version was defeated by the shipped migration's own `AS PERMISSIVE` syntax
// and never looked at predicates at all. The runtime twins re-assert isolation and
// the index/initPlan facts from pg_catalog against `supabase start`:
// supabase/tests/*.sql (pgTAP) and tests/rls/ (the client), both via
// tests/rls/run-rls.mjs.
// SOURCE: docs/harness/README.md (schema-rls gate) [corpus: postgres/rls-force]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'schema-rls'
const SCHEMAS_DIR = 'supabase/schemas'
const MIGRATIONS_DIR = 'supabase/migrations'
const EXEMPT = 'tools/rls-exempt.json'
const DB_CONTEXT = 'tests/rls/db-context.ts'
const PGTAP_STRUCTURE = 'supabase/tests/rls_structure.test.sql'

if (!existsSync(SCHEMAS_DIR)) skipOrFail(GATE, `${SCHEMAS_DIR} not found (no schema surface yet)`)

// Concatenate every .sql in a directory in filename order — the cumulative text is
// what the database ends up running.
function readSqlDir(dir) {
  if (!existsSync(dir)) return ''
  let raw = ''
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    raw += `\n${readFileSync(join(dir, f), 'utf8')}`
  }
  return raw
}

// Strip line comments (they legally contain SQL keywords), drop double quotes, and
// collapse each statement to one whitespace-normalized line. Dollar-quoted function
// bodies split into fragments that match none of the DDL patterns below — harmless.
function statementsOf(raw) {
  return raw
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .replace(/"/g, '')
    .split(/;|--> statement-breakpoint/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const stripSchema = (t) => t.replace(/^public\./, '')

// 1. Declared tables = the DESIRED state (supabase/schemas). This is the pgTable
//    analogue: the inventory every other check is closed over.
const declaredTables = new Set()
for (const stmt of statementsOf(readSqlDir(SCHEMAS_DIR))) {
  const m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)/i)
  if (m) declaredTables.add(stripSchema(m[1].toLowerCase()))
}
if (declaredTables.size === 0) skipOrFail(GATE, `no CREATE TABLE found in ${SCHEMAS_DIR} yet`)

// 2. Exemptions — the ONE escape hatch, so its parse fails LOUD, never open.
//    Canonical shape: { "comment": string, "exempt": [{ "table": string, "reason": string }] }
const exempt = new Set()
if (existsSync(EXEMPT)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(EXEMPT, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${EXEMPT} is not valid JSON (${e.message}) — the exemption list must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.exempt)) {
    fail(
      GATE,
      `${EXEMPT} must carry an "exempt" ARRAY of {table, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed.exempt) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.table === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${EXEMPT}: every exemption must be {"table": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    exempt.add(entry.table)
  }
}

// 3. Statement-level parse of the APPLIED migration SQL — the history a database
//    actually replays. RLS is only real once it is in a migration; a policy that
//    lives only in the declarative schema never ran.
const enabled = new Set()
const forced = new Set()
const createdTables = new Set()
// table -> Set of leading index columns (CREATE INDEX / PK / UNIQUE)
const indexedLeading = new Map()
// table -> op -> [{ name, using, check }]
const policies = new Map()

function registerLeading(table, col) {
  const c = col.toLowerCase()
  if (!indexedLeading.has(table)) indexedLeading.set(table, new Set())
  indexedLeading.get(table).add(c)
}

for (const stmt of statementsOf(readSqlDir(MIGRATIONS_DIR))) {
  let m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) ENABLE ROW LEVEL SECURITY$/i)
  if (m) {
    enabled.add(stripSchema(m[1].toLowerCase()))
    continue
  }
  m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) FORCE ROW LEVEL SECURITY$/i)
  if (m) {
    forced.add(stripSchema(m[1].toLowerCase()))
    continue
  }
  m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)/i)
  if (m) {
    const table = stripSchema(m[1].toLowerCase())
    createdTables.add(table)
    // An INLINE primary key is the owner index for a table whose owner column IS
    // its id (e.g. public.profiles): `id uuid PRIMARY KEY` creates the index the
    // policy qual rides, with no separate CREATE INDEX. Parse the column list so
    // that counts. The list is everything between the first `(` and the final `)`.
    const cols = stmt.match(/^CREATE TABLE[^(]*\((.*)\)\s*$/is)?.[1]
    if (cols !== undefined) {
      // Column-level `<col> <type> ... PRIMARY KEY|UNIQUE` (not the table-level
      // `PRIMARY KEY (...)` form, which the negative lookahead excludes).
      for (const cm of cols.matchAll(
        /(?:^|,)\s*([a-z0-9_]+)\b[^,]*?\b(?:PRIMARY KEY|UNIQUE)\b(?!\s*\()/gi,
      )) {
        registerLeading(table, cm[1])
      }
      // Table-level `[CONSTRAINT x] PRIMARY KEY|UNIQUE (<col>, ...)` — leading col.
      for (const cm of cols.matchAll(/\b(?:PRIMARY KEY|UNIQUE)\s*\(\s*([a-z0-9_]+)/gi)) {
        registerLeading(table, cm[1])
      }
    }
    continue
  }
  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] <name> ON [ONLY] <table>
  //   [USING <method>] (<col> [...], ...) — record the LEADING column only; a
  //   second-position owner column does not serve the policy's equality qual.
  m = stmt.match(
    /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?[a-z0-9_]+ ON (?:ONLY )?([a-z0-9_.]+)(?: USING [a-z0-9_]+)? ?\((.+)\)/i,
  )
  if (m === null) {
    // ALTER TABLE <t> ADD CONSTRAINT <n> PRIMARY KEY|UNIQUE (<col>, ...) backs an
    // index too — count its leading column the same way.
    m = stmt.match(
      /^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) ADD CONSTRAINT [a-z0-9_]+ (?:PRIMARY KEY|UNIQUE) ?\((.+?)\)/i,
    )
  }
  if (m) {
    const table = stripSchema(m[1].toLowerCase())
    // First bare identifier of the first column item; an expression index
    // (e.g. lower(col)) yields the function name and correctly never matches —
    // it cannot serve the policy's plain equality qual.
    const leading = m[2]
      .split(',')[0]
      .trim()
      .toLowerCase()
      .match(/^[a-z0-9_]+/)?.[0]
    if (leading !== undefined) registerLeading(table, leading)
    continue
  }
  // CREATE POLICY <name> ON <table> [AS PERMISSIVE|RESTRICTIVE] [FOR <op>]
  //   [TO <roles>] [USING (...)] [WITH CHECK (...)]
  m = stmt.match(/^CREATE POLICY ([a-z0-9_]+) ON ([a-z0-9_.]+)(.*)$/i)
  if (m) {
    const [, name, tableRaw, rest] = m
    const table = stripSchema(tableRaw.toLowerCase())
    const op = (
      rest.match(/\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1] ?? 'ALL'
    ).toUpperCase()
    const using = rest.match(/\bUSING \((.*?)\)(?: WITH CHECK|$)/is)?.[1] ?? null
    const check = rest.match(/\bWITH CHECK \((.*)\)$/is)?.[1] ?? null
    if (!policies.has(table)) policies.set(table, new Map())
    const byOp = policies.get(table)
    if (!byOp.has(op)) byOp.set(op, [])
    byOp.get(op).push({ name, using, check })
  }
}

// 4. Runtime-matrix closure. TWO registries the runtime suites drive, which the gate
//    holds to the SAME set so a table cannot be proven by one and forgotten by the
//    other. ISOLATION_TARGETS (the client suite) carries the owner column too.
//    `null` = the registry file is absent (pre-scaffold shapes) — its checks are
//    then inert and the pg_catalog twins still enforce the fact at runtime.
let isolationTargets = null
const targetOwnerColumns = new Map()
if (existsSync(DB_CONTEXT)) {
  const ctx = readFileSync(DB_CONTEXT, 'utf8')
  isolationTargets = new Set([...ctx.matchAll(/\btable:\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]))
  for (const m of ctx.matchAll(
    /\btable:\s*['"]([a-z0-9_]+)['"]\s*,\s*ownerColumn:\s*['"]([a-z0-9_]+)['"]/g,
  )) {
    targetOwnerColumns.set(m[1], m[2])
  }
}

let pgtapTargets = null
if (existsSync(PGTAP_STRUCTURE)) {
  const insert = readFileSync(PGTAP_STRUCTURE, 'utf8').match(
    /INSERT\s+INTO\s+rls_targets\b[^;]*;/i,
  )?.[0]
  if (insert !== undefined) {
    pgtapTargets = new Map()
    for (const m of insert.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*\)/g)) {
      pgtapTargets.set(m[1], m[2])
    }
  }
}

const OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
const errs = []

// A predicate is vacuous when it always passes; a per-row identity call (no initPlan
// sub-select) is a correctness-adjacent perf failure the runtime suite cannot see (it
// tests 2 rows, production has 2 million).
const IDENTITY_CALL = /\b(?:auth\.uid|auth\.jwt|current_setting)\s*\(/i
const IDENTITY_IN_SUBSELECT = /\(\s*select\b[^)]*(?:auth\.uid|auth\.jwt|current_setting)\s*\(/i
function checkPredicate(table, policyName, kind, body) {
  if (body === null) return
  const trimmed = body.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === '(true)') {
    errs.push(`${table}: policy ${policyName} has a vacuous ${kind} (true) — it permits every row`)
    return
  }
  if (IDENTITY_CALL.test(body) && !IDENTITY_IN_SUBSELECT.test(body)) {
    errs.push(
      `${table}: policy ${policyName} calls an identity function per row — wrap it in a scalar sub-select (initPlan pattern): (select auth.uid())`,
    )
  }
}

for (const table of [...declaredTables].sort()) {
  if (exempt.has(table)) continue
  if (!enabled.has(table)) errs.push(`${table}: no ENABLE ROW LEVEL SECURITY in any migration`)
  if (!forced.has(table))
    errs.push(`${table}: no FORCE ROW LEVEL SECURITY (owner would bypass policies)`)

  const byOp = policies.get(table) ?? new Map()
  for (const op of OPS) {
    if (!byOp.has(op) && !byOp.has('ALL')) {
      errs.push(`${table}: no policy FOR ${op} (per-operation policies required)`)
    }
  }
  for (const [, list] of byOp) {
    for (const p of list) {
      checkPredicate(table, p.name, 'USING', p.using)
      checkPredicate(table, p.name, 'WITH CHECK', p.check)
    }
  }

  if (isolationTargets !== null && !isolationTargets.has(table)) {
    errs.push(
      `${table}: not wired into ISOLATION_TARGETS (${DB_CONTEXT}) — the client suite never proves its isolation; add a target entry (or exempt with a reviewed reason)`,
    )
  }
  if (pgtapTargets !== null && !pgtapTargets.has(table)) {
    errs.push(
      `${table}: not listed in rls_targets (${PGTAP_STRUCTURE}) — the pgTAP structural suite never asserts its shape; add a ('${table}', '<owner_column>') row (or exempt with a reviewed reason)`,
    )
  }

  const ownerCol = targetOwnerColumns.get(table)
  if (ownerCol !== undefined) {
    if (!(indexedLeading.get(table)?.has(ownerCol) ?? false)) {
      errs.push(
        `${table}: no index with leading column ${ownerCol} in any migration — every RLS policy filters by it, so an un-indexed owner column degrades to a per-row sequential scan at scale; add one in a migration (a PRIMARY KEY on the owner column counts)`,
      )
    }
    const pgtapOwner = pgtapTargets?.get(table)
    if (pgtapOwner !== undefined && pgtapOwner !== ownerCol) {
      errs.push(
        `${table}: the two registries disagree on the owner column — ${DB_CONTEXT} says '${ownerCol}', ${PGTAP_STRUCTURE} says '${pgtapOwner}'`,
      )
    }
  }
}

// Two-way closure: a registry row naming a table no schema declares is a stale row —
// the runtime suite silently over- or under-asserts, exactly the drift the plan's
// two-way parity discipline exists to catch.
for (const table of isolationTargets ?? []) {
  if (!declaredTables.has(table) && !exempt.has(table)) {
    errs.push(
      `${table}: listed in ISOLATION_TARGETS (${DB_CONTEXT}) but no schema declares it — remove the stale target or add the table`,
    )
  }
}
for (const table of pgtapTargets?.keys() ?? []) {
  if (!declaredTables.has(table) && !exempt.has(table)) {
    errs.push(
      `${table}: listed in rls_targets (${PGTAP_STRUCTURE}) but no schema declares it — remove the stale row or add the table`,
    )
  }
}

// Migration-only tables escape BOTH the schema net and the isolation matrix — surface
// them. (Applied history diverging from the declarative schema is itself the drift.)
for (const table of [...createdTables].sort()) {
  if (declaredTables.has(table) || exempt.has(table)) continue
  errs.push(
    `${table}: created by a migration but not declared in ${SCHEMAS_DIR} — undeclared tables escape the schema gate and the isolation matrix`,
  )
}

failures(
  GATE,
  errs,
  `Add the RLS statements to a NEW migration and the table to ISOLATION_TARGETS + rls_targets, or (human decision) exempt it with a reason in ${EXEMPT}.`,
)
ok(
  GATE,
  `${declaredTables.size} table(s): FORCE RLS + per-op policies + real predicates + owner-column indexes + dual isolation-registry coverage`,
)
