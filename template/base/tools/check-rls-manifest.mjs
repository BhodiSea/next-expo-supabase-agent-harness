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
// FOUR CHECKS ADDED IN 0.2.0, each closing a hole this gate provably had:
//
//   1. NEGATION (unramped). The gate collected ENABLE and FORCE and nothing else, so
//      a later migration containing `ALTER TABLE x DISABLE ROW LEVEL SECURITY` — or
//      `NO FORCE`, or `DISABLE TRIGGER` — matched no pattern, left the table in the
//      `enabled` set, and the gate reported the table fully covered. Unramped
//      deliberately: no legitimate install has ever turned RLS off, so ramping this
//      would protect only a tampered tree.
//   2. HELPER-BODY RESOLUTION. The initPlan check read the policy text alone, so
//      moving `auth.uid()` into a plain SQL helper and calling the helper bare
//      vacated it. Predicates now resolve one hop through locally-defined function
//      bodies.
//   3. CORRELATED-SUBQUERY BAN. `EXISTS (SELECT 1 FROM memberships m WHERE
//      m.org_id = notes.org_id AND m.user_id = (SELECT auth.uid()))` satisfies both
//      the old vacuity check and the old initPlan regex — it does contain
//      `(select ... auth.uid()`. It is also a per-row SubPlan that re-enters the
//      referenced table's own policies. Only uncorrelated forms hoist to an InitPlan.
//   4. SECURITY DEFINER DISCIPLINE. A definer function is the standard Supabase
//      privilege-escalation footgun. Each one must be allowlisted with a reason in
//      tools/security-definer-allow.json, pin `SET search_path = ''`, and take no
//      identity-shaped parameter (a caller who can say WHO THEY ARE is not
//      authenticated, they are trusted). On the EXECUTE surface the rule is not
//      "no wide grant" but "prove the default was undone": PostgreSQL grants
//      EXECUTE to PUBLIC at creation and Supabase's default privileges add anon, so
//      a migration that names no grants at all still ships an anon-callable definer
//      function. Every definer function must therefore show a REVOKE from PUBLIC and
//      anon; EXECUTE to `authenticated` is legal only for an allowlisted function,
//      because PostgREST switches to the JWT's role before calling and there is no
//      other way for a client-callable RPC to exist.
//
// AND ONE ADDED IN 0.6.0 — the POLICY → GRANT closure. Table privileges are checked
// BEFORE row security, so a policy naming a role that holds no privilege is unreachable
// code. This gate has parsed grants since 0.2.0 and used only the FUNCTION half; the table
// half was dead output, so a table with ENABLE + FORCE + four policies + both registries +
// an owner index and no GRANT statement anywhere was green. It is invisible today because
// Supabase's default privileges cover anon/authenticated/service_role in `public` — and
// those defaults stop applying to projects created on or after 2026-10-30. See
// tools/lib/table-grants.mjs.
//
// Static and <100ms: statement-level SQL parsing via tools/lib/sql-parse.mjs, not
// substring vibes — an early regex version was defeated by the shipped migration's
// own `AS PERMISSIVE` syntax and never looked at predicates at all. The runtime
// twins re-assert isolation and the index/initPlan facts from pg_catalog against
// `supabase start`: supabase/tests/*.sql (pgTAP) and tests/rls/ (the client), both
// via tests/rls/run-rls.mjs.
// SOURCE: docs/harness/README.md (schema-rls gate) [corpus: postgres/rls-force]
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import {
  parseFunctions,
  parseGrants,
  parseIndexes,
  parsePolicies,
  parseRlsToggles,
  readSqlDir,
  readSqlDirByFile,
  splitStatements,
  stripSchema,
} from './lib/sql-parse.mjs'
import { policyGrantProblems } from './lib/table-grants.mjs'

const GATE = 'schema-rls'
const SCHEMAS_DIR = 'supabase/schemas'
const MIGRATIONS_DIR = 'supabase/migrations'
const EXEMPT = 'tools/rls-exempt.json'
const DEFINER_ALLOW = 'tools/security-definer-allow.json'
const DB_CONTEXT = 'tests/rls/db-context.ts'
const PGTAP_STRUCTURE = 'supabase/tests/rls_structure.test.sql'
const CONFIG_TOML = 'supabase/config.toml'
const RAMP = '0.2.0'
const RAMP_GRANTS = '0.6.0'

if (!existsSync(SCHEMAS_DIR)) skipOrFail(GATE, `${SCHEMAS_DIR} not found (no schema surface yet)`)

// 1. Declared tables = the DESIRED state (supabase/schemas). The inventory every
//    other check is closed over.
const declaredTables = new Set()
for (const stmt of splitStatements(readSqlDir(SCHEMAS_DIR))) {
  const m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)/i)
  if (m) declaredTables.add(stripSchema(m[1]))
}
if (declaredTables.size === 0) skipOrFail(GATE, `no CREATE TABLE found in ${SCHEMAS_DIR} yet`)

// 2. Exemptions — the ONE escape hatch, so its parse fails LOUD, never open.
//    Canonical shape: { "comment": string, "exempt": [{ "table": string, "reason": string }] }
function reviewedList(path, key, itemKey) {
  const out = new Map()
  if (!existsSync(path)) return out
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(GATE, `${path} is not valid JSON (${e.message}) — the list must be reviewable data`)
  }
  if (!Array.isArray(parsed[key])) {
    fail(
      GATE,
      `${path} must carry a "${key}" ARRAY of {${itemKey}, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed[key]) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry[itemKey] === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${path}: every entry must be {"${itemKey}": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    out.set(entry[itemKey].toLowerCase(), entry)
  }
  return out
}

const exempt = new Set(reviewedList(EXEMPT, 'exempt', 'table').keys())
const definerAllow = reviewedList(DEFINER_ALLOW, 'allow', 'function')

// 3. Statement-level parse of the APPLIED migration SQL — the history a database
//    actually replays. RLS is only real once it is in a migration; a policy that
//    lives only in the declarative schema never ran. Parsed PER FILE so a negation
//    can name the migration that introduced it.
const perFile = readSqlDirByFile(MIGRATIONS_DIR)
const allStatements = perFile.flatMap((f) => f.statements)

const { enabled, forced, disabled, unforced, triggersDisabled } = parseRlsToggles(allStatements)
const { policies } = parsePolicies(allStatements)
const { leading: indexedLeading } = parseIndexes(allStatements)
const functions = parseFunctions(allStatements)
const grants = parseGrants(allStatements)

const createdTables = new Set()
for (const stmt of allStatements) {
  const m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)/i)
  if (m) createdTables.add(stripSchema(m[1]))
}

/** Which migration file a statement came from — for negation messages that name it. */
function fileOf(stmt) {
  return perFile.find((f) => f.statements.includes(stmt))?.file ?? MIGRATIONS_DIR
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
// New-in-0.2.0 findings, held separately so the ramp can downgrade them to NOTEs on
// an install whose seeded content predates the check.
const rampedErrs = []

// ---------------------------------------------------------------------------
// Predicate analysis
// ---------------------------------------------------------------------------

// A predicate is vacuous when it always passes; a per-row identity call (no initPlan
// sub-select) is a correctness-adjacent perf failure the runtime suite cannot see (it
// tests 2 rows, production has 2 million).
const IDENTITY_CALL = /\b(?:auth\.uid|auth\.jwt|current_setting)\s*\(/i
const IDENTITY_IN_SUBSELECT = /\(\s*select\b[^)]*(?:auth\.uid|auth\.jwt|current_setting)\s*\(/i

// Locally-defined function bodies, so a predicate that calls a helper is judged on
// what the helper DOES, not on the fact that it is a call.
// The body's EXPRESSION, not its statement: a SQL-language helper is written
// `SELECT auth.uid()`, and that leading SELECT belongs to the function definition,
// not to the value it returns. Inlining it verbatim would manufacture the very
// `(SELECT ...)` sub-select the initPlan rule is looking for and green the bare call.
const fnBodies = new Map()
for (const f of functions) {
  if (f.body === null) continue
  const expr = f.body
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/^select\s+/i, '')
  fnBodies.set(f.qualified, expr)
  fnBodies.set(f.name, expr)
}

/**
 * The predicate with every local helper call replaced, IN PLACE, by that helper's
 * body (one hop). Substituting at the call site rather than appending is what keeps
 * the initPlan check positional: `owner_id = helper()` inlines to a bare identity
 * call and reds, while `owner_id = (SELECT helper())` inlines to the sub-select form
 * and passes. Appending the body would have judged both identically.
 */
function resolved(body) {
  let text = body
  // Longest name first, so `public.f` is consumed before a bare `f` can match inside it.
  for (const name of [...fnBodies.keys()].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${name.replace(/\./g, '\\.')}\\s*\\([^()]*\\)`, 'gi')
    text = text.replace(re, `(${fnBodies.get(name).trim()})`)
  }
  return text
}

// A sub-select that reads a RELATION is a SubPlan when it references the outer row and
// a join when it does not; either way it is not the uncorrelated scalar the planner
// hoists once per statement. `(select auth.uid())` and `(select private.member_org_ids())`
// have no FROM and are exactly the shape that hoists.
const SUBSELECT_WITH_FROM = /\(\s*select\b[^()]*(?:\([^()]*\)[^()]*)*\bfrom\b/i

function checkPredicate(table, policyName, kind, body) {
  if (body === null) return
  const trimmed = body.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === '(true)') {
    errs.push(`${table}: policy ${policyName} has a vacuous ${kind} (true) — it permits every row`)
    return
  }
  const full = resolved(body)
  if (IDENTITY_CALL.test(full) && !IDENTITY_IN_SUBSELECT.test(full)) {
    errs.push(
      `${table}: policy ${policyName} calls an identity function per row — wrap it in a scalar sub-select (initPlan pattern): (select auth.uid())`,
    )
  }
  if (SUBSELECT_WITH_FROM.test(body)) {
    rampedErrs.push(
      `${table}: policy ${policyName} ${kind} contains a sub-select over a relation — a correlated SubPlan is evaluated PER ROW and re-enters that table's own policies. Use an uncorrelated scalar helper, e.g. \`= ANY((SELECT private.member_org_ids())::uuid[])\`. Predicate: ${body.trim()}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Per-table checks
// ---------------------------------------------------------------------------

for (const table of [...declaredTables].sort()) {
  if (exempt.has(table)) continue
  if (!enabled.has(table)) errs.push(`${table}: no ENABLE ROW LEVEL SECURITY in any migration`)
  if (!forced.has(table))
    errs.push(`${table}: no FORCE ROW LEVEL SECURITY (owner would bypass policies)`)

  // The negation set — unramped. A table that is ever turned off is not covered,
  // whatever an earlier migration said.
  if (disabled.has(table)) {
    errs.push(
      `${table}: RLS is DISABLED by a later migration (${fileOf(disabled.get(table))}) — an ENABLE in an earlier migration does not survive it. Re-enable it in a NEW migration, or remove the DISABLE.`,
    )
  }
  if (unforced.has(table)) {
    errs.push(
      `${table}: FORCE is removed by NO FORCE ROW LEVEL SECURITY in ${fileOf(unforced.get(table))} — the table owner then bypasses every policy.`,
    )
  }
  if (triggersDisabled.has(table)) {
    errs.push(
      `${table}: triggers are DISABLED in ${fileOf(triggersDisabled.get(table))} — a disabled trigger silently stops enforcing whatever it guarded (updated_at, org freeze, audit).`,
    )
  }

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

// ---------------------------------------------------------------------------
// THE POLICY → GRANT CLOSURE (0.6.0)
// ---------------------------------------------------------------------------
// Table privileges are checked BEFORE row security, so a policy naming a role that holds
// no privilege on the table is unreachable code that reads in review as a granted one.
// Until now this gate parsed the grants (parseGrants has been called since 0.2.0) and used
// only the FUNCTION half of that parse for the EXECUTE surface above — the table half was
// dead output, which is why a table shipping ENABLE + FORCE + four policies + both isolation
// registries + an owner index and NO GRANT statement anywhere was fully green.
//
// It is dated. Supabase's default privileges have always granted anon/authenticated/
// service_role on every new table in `public`, which is exactly what makes the omission
// invisible — the policy works because the default already handed the role its privileges.
// For projects created on or after 2026-10-30 that stops, so the same migration file 403s
// in the next project it is replayed into. The reasoning, the carve-outs and the reason the
// reverse direction is NOT asserted live in tools/lib/table-grants.mjs.
// SOURCE: https://supabase.com/docs/guides/api (Data API grants and exposed schemas)
//
// The domain is POLICIES, not declared tables: it runs over exempt tables too, because an
// exemption in tools/rls-exempt.json is an exemption from the per-operation MODEL (the audit
// trail must have no UPDATE policy) and says nothing about whether the policies a table does
// carry are reachable.
const grantErrs = policyGrantProblems({
  policies,
  grants,
  tables: new Set([...declaredTables, ...createdTables, ...policies.keys()]),
})

// ---------------------------------------------------------------------------
// SECURITY DEFINER discipline
// ---------------------------------------------------------------------------
// A definer function runs as its OWNER. That is the correct tool for the one job RLS
// cannot do (letting a caller read rows they may not read directly, under a rule the
// function itself enforces) and a privilege-escalation primitive everywhere else.
// SOURCE: https://www.postgresql.org/docs/17/sql-createfunction.html (writing SECURITY DEFINER functions safely)

// Anchored, so a TARGET-shaped parameter (`p_target_user_id` — who the caller is
// acting ON) is distinguishable from an IDENTITY-shaped one (`user_id` — who the
// caller claims to BE). The first is a legitimate argument; the second is the
// footgun, because a definer function that accepts who-am-I is not authenticating
// anyone, it is trusting them.
const IDENTITY_PARAM = /^_?(uid|user_id|actor|actor_id|caller|caller_id|current_user_id|auth_uid)$/i

for (const fn of functions) {
  if (!fn.securityDefiner) continue
  const allowed = definerAllow.get(fn.qualified) ?? definerAllow.get(fn.name)
  if (allowed === undefined) {
    rampedErrs.push(
      `${fn.qualified}: SECURITY DEFINER with no entry in ${DEFINER_ALLOW} — a definer function runs as its owner and bypasses the caller's policies; register it with a reason, or make it SECURITY INVOKER`,
    )
    continue
  }
  if (fn.searchPath !== '') {
    rampedErrs.push(
      `${fn.qualified}: SECURITY DEFINER without \`SET search_path = ''\` (got ${fn.searchPath === null ? 'no SET at all' : `'${fn.searchPath}'`}) — a caller who controls search_path resolves your unqualified names to their own objects and runs them as the owner`,
    )
  }
  for (const p of fn.params) {
    if (IDENTITY_PARAM.test(p.name)) {
      rampedErrs.push(
        `${fn.qualified}: SECURITY DEFINER takes an identity-shaped parameter '${p.name}' — a definer function must derive the caller from auth.uid() internally, never accept who-am-I as an argument`,
      )
    }
  }
}

// THE ABSENCE OF A REVOKE IS THE EXPOSURE, which is why this half is unramped and
// why "no GRANT statement anywhere" is not evidence of safety.
//
// PostgreSQL grants EXECUTE to PUBLIC on every function at creation, and Supabase's
// default privileges additionally grant anon/authenticated in `public`. So a
// SECURITY DEFINER function created by a migration that says nothing about grants is
// already callable by an unauthenticated caller over PostgREST — and a gate that
// only inspects GRANT statements sees a clean migration and reports green. The
// REVOKE is the only evidence a migration can carry that the default was undone.
//
// Unramped, for the reason the 0.2.0 security-headers bug taught: the subject here is
// a file the HARNESS ships (the tenancy spine's RPCs). Ramping it would make the rule
// advisory on precisely the tree that has definer functions, and the shipped 0.1.3
// scaffold has none — so no legitimate legacy install has one to sweep, and the ramp
// would protect only a tree that added one.
const revokedFrom = new Map() // bare/qualified fn name -> Set<role>
for (const g of grants) {
  if (g.kind !== 'REVOKE') continue
  if (!g.privileges.includes('EXECUTE') && !g.privileges.includes('ALL')) continue
  const target = g.target.replace(/\(.*$/, '').trim()
  if (!revokedFrom.has(target)) revokedFrom.set(target, new Set())
  for (const r of g.roles) revokedFrom.get(target).add(r)
}

const grantedExecute = new Map() // bare/qualified fn name -> Set<role>
for (const g of grants) {
  if (g.kind !== 'GRANT' || !g.privileges.includes('EXECUTE')) continue
  const target = g.target.replace(/\(.*$/, '').trim()
  if (!grantedExecute.has(target)) grantedExecute.set(target, new Set())
  for (const r of g.roles) grantedExecute.get(target).add(r)
}

for (const fn of functions) {
  if (!fn.securityDefiner) continue
  const allowed = definerAllow.get(fn.qualified) ?? definerAllow.get(fn.name)
  const revoked = revokedFrom.get(fn.qualified) ?? revokedFrom.get(fn.name) ?? new Set()
  const granted = grantedExecute.get(fn.qualified) ?? grantedExecute.get(fn.name) ?? new Set()

  for (const role of ['public', 'anon']) {
    if (granted.has(role)) {
      errs.push(
        `${fn.qualified}: EXECUTE granted to ${role} on a SECURITY DEFINER function — a definer function runs as its owner, so this hands an unauthenticated caller the owner's authority through POST /rest/v1/rpc/${fn.name}`,
      )
    } else if (!revoked.has(role)) {
      errs.push(
        `${fn.qualified}: no \`REVOKE EXECUTE ON FUNCTION … FROM ${role.toUpperCase()}\` in any migration — PostgreSQL grants EXECUTE to PUBLIC on every new function and Supabase's default privileges additionally grant anon, so a definer function that names no grants is ALREADY callable by an unauthenticated caller. Add: REVOKE ALL ON FUNCTION ${fn.qualified}(…) FROM PUBLIC, anon;`,
      )
    }
  }

  // EXECUTE to `authenticated` is the ONLY way a PostgREST RPC can be reached —
  // PostgREST switches to the JWT's role before calling, so there is no "dedicated
  // role reached through a narrow policy" path for a client-callable function. It is
  // therefore legal, but only as a recorded decision: the allowlist entry IS the
  // review, and the write-guard + escape-list registration make editing it an act
  // that lands in the PR diff.
  if (granted.has('authenticated') && allowed === undefined) {
    errs.push(
      `${fn.qualified}: EXECUTE granted to authenticated on a SECURITY DEFINER function with no entry in ${DEFINER_ALLOW} — a client-callable definer function is a deliberate privilege-escalation surface and must be registered with a reason`,
    )
  }
}

// ---------------------------------------------------------------------------
// Non-public schemas
// ---------------------------------------------------------------------------
// A table outside `public` is legal — it is how the audit trail stays unreachable by
// PostgREST — but only when it is declared like every other table AND its schema is
// absent from [api].schemas. A non-public table exposed over the API is strictly
// worse than a public one, because no reviewer thinks to look for it.
if (existsSync(CONFIG_TOML)) {
  const apiSchemas = readFileSync(CONFIG_TOML, 'utf8')
    .match(/^\s*schemas\s*=\s*\[([^\]]*)\]/m)?.[1]
    ?.split(',')
    .map((s) => s.trim().replace(/["']/g, '').toLowerCase())
    .filter(Boolean)
  if (apiSchemas !== undefined) {
    for (const table of [...declaredTables, ...createdTables]) {
      if (!table.includes('.')) continue
      const schema = table.slice(0, table.indexOf('.'))
      if (apiSchemas.includes(schema)) {
        errs.push(
          `${table}: schema '${schema}' is listed in [api].schemas (${CONFIG_TOML}) — a table kept out of \`public\` to be unreachable by PostgREST must not then be published by it`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------

if (rampedErrs.length > 0) {
  const ramped = rampNote(
    GATE,
    RAMP,
    `${rampedErrs.length} finding(s) from the 0.2.0 checks (correlated policy predicates, SECURITY DEFINER discipline)`,
    { until: '0.4.0' },
  )
  if (ramped) for (const e of rampedErrs) console.log(`${GATE}: NOTE — ${e}`)
  else errs.push(...rampedErrs)
}

// RAMPED, for one release, and the argument is narrower than "it is new".
//
// On a Supabase project created before 2026-10-30 a policy with no GRANT behind it WORKS —
// the default privileges already handed the role what it needs — so a consumer's committed,
// reviewed, passing migration becomes red on upgrade for a defect that has not yet bitten.
// That is the population a ramp exists for, and it is not the population the unramped
// checks above address (no legitimate install has ever turned RLS off, and the 0.1.3
// scaffold shipped no definer functions, so those two ramps would have protected only a
// tampered tree). Here there is a real legacy population and a real, dated fuse.
//
// The grace is one release, not one quarter: at this line's cadence 0.7.0 lands months
// before 2026-10-30, so the deadline the ramp ledger enforces arrives well ahead of the
// deadline the check is about. And a NOTE here is not silence — rampNote prints on every
// armed call, and each finding below carries the exact GRANT statement that discharges it.
if (grantErrs.length > 0) {
  const ramped = rampNote(
    GATE,
    RAMP_GRANTS,
    `${grantErrs.length} policy/policies whose role holds no matching table GRANT (the 2026-10-30 Data API default-privilege flip)`,
    { until: '0.7.0' },
  )
  if (ramped) for (const e of grantErrs) console.log(`${GATE}: NOTE — ${e}`)
  else errs.push(...grantErrs)
}

failures(
  GATE,
  errs,
  `Add the RLS statements to a NEW migration and the table to ISOLATION_TARGETS + rls_targets, or (human decision) exempt it with a reason in ${EXEMPT}.`,
)
ok(
  GATE,
  `${declaredTables.size} table(s): FORCE RLS (never disabled) + per-op policies + real, uncorrelated predicates + owner-column indexes + dual isolation-registry coverage + every policy role holds a matching table GRANT${functions.some((f) => f.securityDefiner) ? ` + ${functions.filter((f) => f.securityDefiner).length} reviewed definer function(s)` : ''}`,
)
