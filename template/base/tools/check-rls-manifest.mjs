#!/usr/bin/env node
// Gate: schema-rls — every Drizzle pgTable is covered by FORCE ROW LEVEL SECURITY and
// per-operation policies in the migration SQL, every policy predicate is real (no
// USING (true)) and uses the initPlan sub-select pattern, every table the migrations
// create is declared in the schema, every non-exempt table is wired into the
// runtime isolation matrix (tests/rls/db-context.ts ISOLATION_TARGETS) — or is
// explicitly exempted in tools/rls-exempt.json (write-guard-protected, human-reviewed,
// reasons required) — and every isolation target's owner column is the LEADING column
// of some migration-created index (the policies filter by it on every statement; an
// un-indexed owner column is a per-row sequential scan at scale). Static and <100ms:
// statement-level SQL parsing, not substring vibes — an early regex version was defeated
// by the shipped migration's own `AS PERMISSIVE` syntax and never looked at predicates
// at all. The runtime twin (tests/rls/) re-asserts the index and initPlan facts from
// pg_catalog and EXPLAIN.
// SOURCE: docs/harness/README.md (schema-rls gate) [corpus: postgres/rls-force]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'schema-rls'
const SCHEMA_DIR = 'packages/schema/src'
const MIGRATIONS_DIR = 'packages/schema/drizzle'
const EXEMPT = 'tools/rls-exempt.json'
const DB_CONTEXT = 'tests/rls/db-context.ts'

if (!existsSync(SCHEMA_DIR)) skipOrFail(GATE, `${SCHEMA_DIR} not found (no schema surface yet)`)

// 1. Declared tables from Drizzle schema source: pgTable('name', ...)
const declaredTables = new Set()
for (const rel of walkFiles(SCHEMA_DIR, {
  filter: (p) => /\.ts$/.test(p) && !/\.(test|spec)\.ts$/.test(p),
})) {
  const src = readFileSync(`${SCHEMA_DIR}/${rel}`, 'utf8')
  for (const m of src.matchAll(/pgTable\(\s*['"]([a-z0-9_]+)['"]/g)) declaredTables.add(m[1])
}

if (declaredTables.size === 0) skipOrFail(GATE, 'no pgTable declarations found yet')

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

// 3. Statement-level parse of the cumulative migration SQL.
let rawSql = ''
if (existsSync(MIGRATIONS_DIR)) {
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    rawSql += `\n${readFileSync(join(MIGRATIONS_DIR, f), 'utf8')}`
  }
}
// Strip line comments (they legally contain SQL keywords), normalize quotes and
// whitespace, then split into statements.
const statements = rawSql
  .split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n')
  .replace(/"/g, '')
  .split(/;|--> statement-breakpoint/)
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

const stripSchema = (t) => t.replace(/^public\./, '')

const enabled = new Set()
const forced = new Set()
const createdTables = new Set()
// table -> Set of leading index columns (CREATE INDEX / PK / UNIQUE constraints)
const indexedLeading = new Map()
// table -> op -> [{ name, using, check }]
const policies = new Map()

for (const stmt of statements) {
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
    createdTables.add(stripSchema(m[1].toLowerCase()))
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
    if (leading !== undefined) {
      if (!indexedLeading.has(table)) indexedLeading.set(table, new Set())
      indexedLeading.get(table).add(leading)
    }
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

// 4. Runtime-matrix closure: tables wired into ISOLATION_TARGETS.
let isolationTargets = null // null = suite file absent (pre-scaffold shapes)
// table -> ownerColumn, when the entry keeps the scaffolded `table:` -> `ownerColumn:`
// key order. An unmatchable entry only skips the STATIC index check — the runtime
// pg_catalog check in tests/rls/ still enforces it against the live database.
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

const OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
const errs = []

// A predicate is vacuous when it always passes; per-row current_setting (no
// initPlan sub-select) is a correctness-adjacent perf failure the runtime
// suite cannot see (it tests 2 rows, production has 2 million).
function checkPredicate(table, policyName, kind, body) {
  if (body === null) return
  const trimmed = body.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === '(true)') {
    errs.push(`${table}: policy ${policyName} has a vacuous ${kind} (true) — it permits every row`)
    return
  }
  if (/current_setting\(/i.test(body) && !/\(\s*select\b[^)]*current_setting\(/i.test(body)) {
    errs.push(
      `${table}: policy ${policyName} calls current_setting() per row — wrap it in a scalar sub-select (initPlan pattern): (select current_setting('app.user_id', true))`,
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
      `${table}: not wired into ISOLATION_TARGETS (${DB_CONTEXT}) — the runtime suite never proves its isolation; add a target entry (or exempt with a reviewed reason)`,
    )
  }

  const ownerCol = targetOwnerColumns.get(table)
  if (ownerCol !== undefined && !(indexedLeading.get(table)?.has(ownerCol) ?? false)) {
    errs.push(
      `${table}: no index with leading column ${ownerCol} in any migration — every RLS policy filters by it, so an un-indexed owner column degrades to a per-row sequential scan at scale; add one in a NEW migration (see 0001_notes_owner_idx.sql)`,
    )
  }
}

// Migration-only tables escape BOTH the static and runtime nets — surface them.
for (const table of [...createdTables].sort()) {
  if (declaredTables.has(table) || exempt.has(table)) continue
  errs.push(
    `${table}: created by a migration but not declared as a pgTable in ${SCHEMA_DIR} — undeclared tables escape the schema gate and the isolation matrix`,
  )
}

failures(
  GATE,
  errs,
  `Add the RLS statements to a NEW migration and the table to ISOLATION_TARGETS, or (human decision) exempt it with a reason in ${EXEMPT}.`,
)
ok(
  GATE,
  `${declaredTables.size} table(s): FORCE RLS + per-op policies + real predicates + owner-column indexes + isolation-matrix coverage`,
)
