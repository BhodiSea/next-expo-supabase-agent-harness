#!/usr/bin/env node
// Gate: tenancy — every org-scoped table's isolation is enforced by policies whose
// predicates match the CLOSED set of reviewed forms in tools/tenancy.json, on a
// tenant key the schema cannot let drift.
//
// WHY A CLOSED FORM SET, NOT A HEURISTIC. The schema-rls gate proves a predicate is
// REAL (not `true`, identity hoisted, no relation sub-select). It cannot prove the
// predicate scopes by TENANT: `org_id = (SELECT auth.uid())` — a tenant column
// compared to a user id — passes every realness check that exists and isolates
// nothing. So this gate inverts the burden: a predicate is correct only if every
// top-level OR arm carries one of the reviewed forms, and anything else reds
// PRINTING THE EXACT NORMALIZED PREDICATE IT SAW, so admitting a new form is a
// copy-paste, CODEOWNERS-reviewed diff to predicateForms — owned data, never an
// escape hatch. Arms, not whole predicates: an AND inside an arm can only narrow,
// but `<scope> OR owner_id = (SELECT auth.uid())` is as open as its weakest arm —
// that OR is exactly how per-user scope quietly re-opens an org table.
//
// THE CORRELATED-ARGUMENT BAN is the other half of the same inversion. The two legal
// forms call ZERO-argument helpers inside uncorrelated scalar sub-selects — the shape
// the planner hoists to one InitPlan per statement (the `(SELECT auth.uid())` trick).
// `(SELECT private.member_rank(org_id)) >= 30` is syntactically wrapped in `(SELECT`
// and passes every wrapper check, but passing a column of the row under test makes it
// a correlated SubPlan: a per-row membership lookup that re-enters the membership
// table's own policies. Any call handed the tenant column reds unless the function is
// in knownPureFunctions (coalesce and friends — pure, no relation access).
// SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
//
// RECURSION IS STRUCTURAL, NOT LUCK. The helpers read the membership table as
// SECURITY INVOKER, so the membership table's own SELECT policy must be self-only
// (`user_id = (SELECT auth.uid())`) and must never call them. The ONE exception is
// the rpc writer's admin arm, which routes through readerScopeHelper — a definer
// owned by readerRole, whose own seat policy is self-only and helper-free, so the
// chain terminates in one hop instead of looping.
//
// WHAT THE FAILURE ACTUALLY LOOKS LIKE, because the folklore is wrong: it is
// `54001 stack depth limit exceeded`, NOT the tidy `42P17 infinite recursion
// detected in policy`. 42P17 comes from the rewriter's cycle check, which only sees
// a cycle once the SQL helper is INLINED — and `SET search_path = ''` populates
// pg_proc.proconfig, which makes inlining illegal. So the recursion happens at
// runtime and exhausts the stack. Verified against PostgreSQL 17. Anyone grepping
// logs for "infinite recursion" after this breaks will find nothing.
//
// The checks here are explicitly a SMELL TEST; the executable probe in
// supabase/tests (a real SELECT per table per impersonated role) is the proof.
//
// THE RPC WRITER ROLE, AND WHY THE GATE INSISTS ON ITS PAIRED SELECT POLICY.
// Every table ships FORCE ROW LEVEL SECURITY, so a SECURITY DEFINER function's
// writes are policy-checked against the role that OWNS the function — the owner is
// not exempt. Seat writes must be denied to `authenticated` (a self-keyed INSERT
// policy is a self-service seat grant), which means that without a second role
// holding a write policy, NO role in the database can create a membership: the
// first create_org call fails 42501 and `supabase db reset` dies at seed. The
// reviewed `rpcWriterRole` is that writer.
//
// Admitting the role is not enough, and the failure of the naive version is silent
// rather than loud: a rank-scoped write policy TO that role calls the rank helper,
// which is SECURITY INVOKER and therefore reads the seat table AS THE RPC ROLE. Give
// the role no SELECT policy and the read hits RLS default-deny, the helper returns
// an empty map, every rank comparison is false, and the write matches ZERO ROWS AND
// REPORTS SUCCESS — every promotion in production would look fine and change
// nothing. So the gate requires the pair: any helper-bearing write policy TO the rpc
// role obliges a self-only SELECT policy for that same role. Self-only, because
// auth.uid() is GUC-derived and role-switch-independent (it still resolves to the
// human caller inside the definer), and because a helper-bearing SELECT policy here
// would be re-entered by the helper that called it.
//
// THE ONE ESCAPE WITH A CLOCK. Everything above describes a finished org-scoped
// database, and an install already carrying production rows cannot become one in a
// single migration: the tenant key must arrive NULLable, be backfilled out of band,
// and only then take NOT NULL — with the old owner-scoped policies alive beside the
// new ones the whole time, because permissive policies OR and dropping the old set
// early blanks the product. `dualScopedTables` licenses exactly that state on exactly
// the named table, and carries an `until` harness version. The comparison is against
// the manifest's harnessVersion, NOT baseVersion: baseVersion moves only when a human
// graduates a ramp, so a deadline measured against it is one the escapee controls,
// while harnessVersion advances on every `installer update`. The entry also reds the
// moment the tenant key becomes NOT NULL — so on the happy path the escape is stale
// before its deadline is ever reached, and the deadline only fires for a transition
// that stalled. docs/runbooks/tenancy-adoption.md is the procedure.
//
// THE RAMP GUARDS ADOPTION, NOT CORRECTNESS (the security-headers lesson, applied
// before the bug this time): an upgrading pre-0.2.0 install with no tenant column
// gets a NOTE, because hard-failing an install the spine has not reached yet is an
// upgrade ambush. But the moment ANY table carries the tenant column the surface is
// adopted, and wrong predicates are a hard red regardless of manifest vintage — a
// tenancy gate that is advisory on the tree that HAS tenancy is decoration.
// SOURCE: docs/harness/gates-catalog.md (tenancy) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import {
  cmpDotted,
  fail,
  failures,
  installedHarnessVersion,
  ok,
  rampNote,
  skipOrFail,
  stampGate,
} from './lib/gate.mjs'
import {
  matchParen,
  parseColumnFacts,
  parseCreatedTables,
  parseFunctions,
  resolveFunction,
  parseGrants,
  parseIndexes,
  parsePolicies,
  parseTriggers,
  qualify,
  readSqlDir,
  splitStatements,
  splitTopLevelOr,
  stripSchema,
} from './lib/sql-parse.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'tenancy'
const CONFIG = 'tools/tenancy.json'
const AUDIT_COLUMNS = 'tools/audit-columns.json'
const PII_COLUMNS = 'tools/pii-columns.json'
const MIGRATIONS_DIR = 'supabase/migrations'
const CONFIG_TOML = 'supabase/config.toml'
const RAMP = '0.2.0'

// ---------------------------------------------------------------------------
// The contract — reviewed data, FAIL CLOSED on every malformation. An empty or
// half-missing contract must never green the thing it was supposed to define.
// ---------------------------------------------------------------------------

if (!existsSync(CONFIG)) {
  fail(
    GATE,
    `${CONFIG} is missing — the tenancy contract must exist as reviewable data before any schema is judged against it (restore it from git or re-run the installer update)`,
  )
}
let cfg
try {
  cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${CONFIG} is not valid JSON (${e.message}) — the contract must be reviewable data; the gate fails closed rather than guessing`,
  )
}

const STRING_KEYS = [
  'tenantColumn',
  'orgTable',
  'membershipTable',
  'membershipUserColumn',
  'membershipRankColumn',
  'scopeHelper',
  'rankHelper',
  'freezeFunction',
  'membershipFreezeFunction',
  'rpcWriterRole',
  'readerRole',
  'readerScopeHelper',
  'auditSchema',
  'auditTable',
  'auditWriteFunction',
  'auditDenyFunction',
  'auditWriterRole',
  'auditReaderRole',
  'quotaWriterRole',
  'auditPartitionColumn',
  'auditActorColumn',
]
for (const key of STRING_KEYS) {
  if (typeof cfg[key] !== 'string' || cfg[key].trim() === '') {
    fail(
      GATE,
      `${CONFIG}: "${key}" must be a non-empty string — a contract missing a section cannot green the checks that section governs`,
    )
  }
}
if (cfg.directoryRpc !== null && typeof cfg.directoryRpc !== 'string') {
  fail(
    GATE,
    `${CONFIG}: "directoryRpc" must be a function name or an EXPLICIT null (a recorded "no member directory" decision) — an absent key is an omission, not a decision`,
  )
}
if (
  cfg.roles === null ||
  typeof cfg.roles !== 'object' ||
  Array.isArray(cfg.roles) ||
  Object.keys(cfg.roles).length === 0 ||
  Object.values(cfg.roles).some((v) => !Number.isInteger(v))
) {
  fail(
    GATE,
    `${CONFIG}: "roles" must map role names to integer ranks (non-empty) — the rank-floor form validates its threshold against these`,
  )
}
if (!Array.isArray(cfg.predicateForms)) fail(GATE, `${CONFIG}: "predicateForms" must be an array`)
if (cfg.predicateForms.length === 0) {
  fail(
    GATE,
    `${CONFIG}: "predicateForms" is EMPTY — with no legal form every predicate would be judged against nothing; the gate fails closed rather than passing vacuously`,
  )
}
for (const f of cfg.predicateForms) {
  if (
    f === null ||
    typeof f !== 'object' ||
    typeof f.name !== 'string' ||
    typeof f.sql !== 'string' ||
    f.sql.trim() === ''
  ) {
    fail(
      GATE,
      `${CONFIG}: every predicateForms entry must be {"name", "sql"} — got ${JSON.stringify(f)}`,
    )
  }
  // A form narrowed to specific tables is how a STRUCTURAL exception (the seat
  // table's self-row, the not-yet-a-member acceptance write) stays reviewable
  // instead of becoming a general licence every tenant table can claim. Narrowing
  // therefore obliges a reason, exactly like an escape entry.
  if (f.tables !== undefined) {
    const okShape =
      Array.isArray(f.tables) &&
      f.tables.length > 0 &&
      f.tables.every((t) => typeof t === 'string' && t.trim() !== '') &&
      typeof f.reason === 'string' &&
      f.reason.trim().length >= 20
    if (!okShape) {
      fail(
        GATE,
        `${CONFIG}: predicate form "${f.name}" narrows to specific tables, so it must carry a non-empty "tables" array AND a substantive "reason" — a table-scoped exception is a decision, not a default`,
      )
    }
  }
}
if (typeof cfg.requireSelfSelectPolicy !== 'boolean') {
  fail(
    GATE,
    `${CONFIG}: "requireSelfSelectPolicy" must be a boolean — it governs whether a write policy TO ${cfg.rpcWriterRole} obliges the paired self-only SELECT policy that keeps the INVOKER helpers from reading empty; an absent key is an omission, not a decision`,
  )
}
for (const key of ['knownPureFunctions', 'nonPublicSchemas']) {
  if (!Array.isArray(cfg[key]) || cfg[key].some((s) => typeof s !== 'string')) {
    fail(GATE, `${CONFIG}: "${key}" must be an array of strings`)
  }
}
if (!Number.isInteger(cfg.auditReadRank) || !Object.values(cfg.roles).includes(cfg.auditReadRank)) {
  fail(
    GATE,
    `${CONFIG}: "auditReadRank" must be one of the configured role ranks (${Object.values(cfg.roles)
      .sort((a, b) => a - b)
      .join(
        ', ',
      )}) — the audit read policy's floor is checked against it, and a floor that matches no role is either unreachable or wide open`,
  )
}
// The trail must be PostgREST-invisible, and the two ways of saying so must agree:
// declaring `audit` unreachable in one key while omitting it from the list the
// [api].schemas check reads would leave the whole schema published and the gate green.
if (!cfg.nonPublicSchemas.map((s) => s.toLowerCase()).includes(cfg.auditSchema.toLowerCase())) {
  fail(
    GATE,
    `${CONFIG}: "auditSchema" is '${cfg.auditSchema}' but nonPublicSchemas does not list it — the audit trail's whole defence is that PostgREST cannot see its schema, and only nonPublicSchemas is checked against [api].schemas. The contract disagrees with itself`,
  )
}
if (qualify(cfg.auditTable).schema !== cfg.auditSchema.toLowerCase()) {
  fail(
    GATE,
    `${CONFIG}: "auditTable" (${cfg.auditTable}) is not in "auditSchema" (${cfg.auditSchema}) — a trail in a schema nobody declared unreachable is a trail PostgREST may be serving`,
  )
}
if (cfg.auditWriterRole === cfg.auditReaderRole) {
  fail(
    GATE,
    `${CONFIG}: auditWriterRole and auditReaderRole are the same role ('${cfg.auditWriterRole}') — the split is the control. One role means every path that can append to the trail can also read every tenant's history out of it, which is the exfiltration an audit trail is least able to detect: it leaves no audit row`,
  )
}

function reviewedEntries(key, requiredKeys) {
  const list = cfg[key]
  if (!Array.isArray(list)) fail(GATE, `${CONFIG}: "${key}" must be an array`)
  for (const entry of list) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      requiredKeys.every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '') &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${CONFIG}: every "${key}" entry must be {${requiredKeys.map((k) => `"${k}"`).join(', ')}, "reason"} with a non-empty reason — got ${JSON.stringify(entry)}`,
      )
    }
  }
  return list
}
/**
 * A sibling reviewed-data file, read with the same fail-closed discipline as the
 * contract itself. Absent is legal and means "no entries"; MALFORMED is not, and
 * never degrades to empty — an unreadable deny-list that reads as an empty deny-list
 * is the exact failure the audit capture rules exist to prevent.
 */
function readReviewedFile(path, key, requiredKeys) {
  if (!existsSync(path)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${path} is not valid JSON (${e.message}) — the list must be reviewable data; the gate fails closed rather than treating it as empty`,
    )
  }
  if (!Array.isArray(parsed[key])) {
    fail(
      GATE,
      `${path} must carry a "${key}" ARRAY of {${requiredKeys.map((k) => `"${k}"`).join(', ')}, "reason"} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed[key]) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      requiredKeys.every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '') &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${path}: every "${key}" entry must be {${requiredKeys.map((k) => `"${k}"`).join(', ')}, "reason"} with a non-empty reason — got ${JSON.stringify(entry)}`,
      )
    }
  }
  return parsed[key]
}

const exemptTables = reviewedEntries('exemptTables', ['table'])
const uniqueEscapes = reviewedEntries('uniqueWithoutTenantColumn', ['table', 'index'])
const untenantedTables = reviewedEntries('untenantedTables', ['table'])
const dualScoped = reviewedEntries('dualScopedTables', ['table', 'ownerColumn', 'until'])
const auditExemptTables = reviewedEntries('auditExemptTables', ['table'])

// ---------------------------------------------------------------------------
// The expiring escape. Everything else in this contract is a standing decision;
// this one is a DEADLINE, and it is validated before any schema is read because a
// deadline that cannot be evaluated is not a deadline.
// ---------------------------------------------------------------------------
const liveHarnessVersion = installedHarnessVersion(GATE)
for (const e of dualScoped) {
  if (!/^\d+\.\d+\.\d+/.test(e.until)) {
    fail(
      GATE,
      `${CONFIG}: dualScopedTables entry for '${e.table}' has until='${e.until}', which is not a dotted version — the deadline must be comparable to the installed harnessVersion or the escape never expires`,
    )
  }
  // No manifest means no version to measure the deadline against. A dual-scoped
  // entry only ever describes a real install MID-ADOPTION, so a tree with no
  // install record has nothing to be mid-adoption about — and honoring the escape
  // there would make it permanent by simply deleting .harness/, which is the one
  // outcome this whole mechanism exists to prevent.
  if (liveHarnessVersion === null) {
    fail(
      GATE,
      `${CONFIG}: dualScopedTables names '${e.table}' with until=${e.until}, but there is no readable .harness/manifest.json harnessVersion to compare it against — an expiring escape whose expiry cannot be read is a permanent escape, so the gate fails closed. Remove the entry (a tree with no install record is not mid-adoption) or restore the manifest`,
    )
  }
}
// The expiry itself is a FINDING, not a malformation — it batches with the policy
// errors below so an install that is both overdue AND has a real predicate bug sees
// both in one run rather than fixing the deadline only to discover the bug.
const expiredDualScopes = dualScoped.filter(
  (e) => cmpDotted(liveHarnessVersion ?? '0.0.0', e.until) >= 0,
)

// Internal coherence: the helpers the config names must be the helpers the forms
// call — a renamed helper that predicateForms never mentions is a contract that
// disagrees with itself, and every downstream check would silently judge air.
const scopeName = qualify(cfg.scopeHelper).name
const rankName = qualify(cfg.rankHelper).name
const formsText = cfg.predicateForms.map((f) => f.sql.toLowerCase()).join('\n')
if (!formsText.includes(scopeName)) {
  fail(
    GATE,
    `${CONFIG}: no predicate form mentions scopeHelper ${cfg.scopeHelper} — the contract disagrees with itself`,
  )
}
if (!formsText.includes(rankName)) {
  fail(
    GATE,
    `${CONFIG}: no predicate form mentions rankHelper ${cfg.rankHelper} — the contract disagrees with itself`,
  )
}

const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

// ---------------------------------------------------------------------------
// Parse the applied history. Migrations only — like schema-rls, tenancy is only
// real once it is in the history a database actually replays.
// ---------------------------------------------------------------------------

const statements = splitStatements(readSqlDir(MIGRATIONS_DIR))
const columnFacts = parseColumnFacts(statements)
const tenantCol = cfg.tenantColumn.toLowerCase()

const tenantTables = [...columnFacts.entries()]
  .filter(([, cols]) => cols.has(tenantCol))
  .map(([table]) => table)
  .sort()

// The adoption seam. rampNote fires only for a manifest whose baseVersion predates
// the ramp — an EXISTING install the tenancy spine has not reached. A fresh 0.2.0+
// scaffold ships the spine, so a fresh tree with no tenant column is a stripped
// tree: loud local skip, hard CI fail.
if (tenantTables.length === 0) {
  if (
    rampNote(
      GATE,
      RAMP,
      `no ${tenantCol} column in any migration — the tenancy spine arrives in ${RAMP}`,
      { until: '0.4.0' },
    )
  ) {
    ok(
      GATE,
      `pre-${RAMP} install without a tenancy surface — adopt via docs/runbooks/tenancy-adoption.md`,
    )
  }
  skipOrFail(GATE, `no table carries a ${tenantCol} column (no tenancy surface yet)`)
}

const indexes = parseIndexes(statements)
const functions = parseFunctions(statements)
const triggers = parseTriggers(statements)
const grants = parseGrants(statements)
const membership = stripSchema(cfg.membershipTable)
const orgQualified = qualify(cfg.orgTable).qualified
// Declared up here because `judged` has to exclude it: the audit trail carries the
// tenant column, so column-driven discovery finds it, but the tenant-table rules are
// WRONG for it (no FK on the tenant key, no freeze trigger). checkAuditTrail() below
// judges it by stronger rules instead.
const auditTable = stripSchema(cfg.auditTable)
const errs = []

// Live policy state, folded in statement order so a DROP POLICY actually removes
// the policy from judgment (and a policy created after a drop is judged fresh).
const live = new Map() // table -> Map<policyName, { op, roles, permissive, using, check }>
for (const stmt of statements) {
  const { policies: created, dropped } = parsePolicies([stmt])
  for (const [table, byOp] of created) {
    for (const [op, list] of byOp) {
      for (const p of list) {
        if (!live.has(table)) live.set(table, new Map())
        live.get(table).set(p.name, { ...p, op })
      }
    }
  }
  for (const d of dropped) live.get(d.table)?.delete(d.name)
}

// The escape hatches close both ways: an entry naming a surface that no longer
// exists is a latent hole waiting for the surface to come back under it.
const exempt = new Set(exemptTables.map((e) => e.table.toLowerCase()))
for (const e of exemptTables) {
  if (!tenantTables.includes(e.table.toLowerCase())) {
    errs.push(
      `${CONFIG}: exemptTables names '${e.table}' but no migration gives it a ${tenantCol} column — stale escape entries hide future holes; remove it`,
    )
  }
}
for (const e of uniqueEscapes) {
  const t = e.table.toLowerCase()
  if (
    !indexes.all.some((idx) => idx.table === t && idx.unique && idx.name === e.index.toLowerCase())
  ) {
    errs.push(
      `${CONFIG}: uniqueWithoutTenantColumn names '${e.table}.${e.index}' but no migration declares that unique constraint — stale escape entries hide future holes; remove it`,
    )
  }
}

// The dual-scoped escape closes THREE ways, and the deadline is only the last of
// them. The other two are what make the happy path self-cleaning: an entry whose
// table finished the contract phase (tenant key now NOT NULL) is stale the moment
// the migration lands, and an entry naming a column or table that does not exist
// was never licensing anything real.
const dualByTable = new Map(dualScoped.map((e) => [e.table.toLowerCase(), e]))
for (const e of dualScoped) {
  const t = e.table.toLowerCase()
  if (!columnFacts.has(t)) {
    errs.push(
      `${CONFIG}: dualScopedTables names '${e.table}' but no migration creates it — stale escape entries hide future holes; remove it`,
    )
    continue
  }
  const cols = columnFacts.get(t)
  if (!cols.has(tenantCol)) {
    errs.push(
      `${CONFIG}: dualScopedTables names '${e.table}' but no migration gives it a ${tenantCol} column — this entry licenses the MIDDLE of the adoption (a nullable tenant key beside the surviving ${e.ownerColumn} policies), and a table with no tenant key has not started one. Run the expand migration first, or remove the entry`,
    )
    continue
  }
  if (!cols.has(e.ownerColumn.toLowerCase())) {
    errs.push(
      `${CONFIG}: dualScopedTables entry for '${e.table}' names ownerColumn '${e.ownerColumn}', which no migration gives that table — the escape would license a predicate over a column that does not exist, so it admits nothing and hides nothing; fix the name or remove the entry`,
    )
  }
  if (cols.get(tenantCol).notNull) {
    errs.push(
      `${CONFIG}: dualScopedTables still names '${e.table}', but its ${tenantCol} is ALREADY NOT NULL — the backfill finished and the contract phase landed, so from here the entry is pure widening: it keeps ${e.ownerColumn}-scoped policies legal on a table that no longer needs them, which is per-user scope surviving inside an org-scoped product. DROP those policies (with an \`-- adr:\` marker) and delete this entry`,
    )
  }
}
for (const e of expiredDualScopes) {
  errs.push(
    `${CONFIG}: the dual-scoped transition for '${e.table}' was declared to end at harness ${e.until}; this install now runs ${liveHarnessVersion}. Finish it — backfill ${tenantCol}, \`ALTER TABLE public.${e.table} ALTER COLUMN ${tenantCol} SET NOT NULL\`, DROP the ${e.ownerColumn}-scoped policies (with an \`-- adr:\` marker), then delete this entry. See docs/runbooks/tenancy-adoption.md. Extending the deadline is a CODEOWNERS-reviewed diff on purpose: a transition state nobody re-approves is a per-user product wearing an org-scoped schema`,
  )
}

// ---------------------------------------------------------------------------
// EVERY table is tenant-scoped, or says why not.
// ---------------------------------------------------------------------------
// This is what makes the gate about MULTI-TENANCY rather than merely about the
// tables that are multi-tenant already. Every other check here is discovered BY
// the tenant column, so without this rule the way to pass is to leave the column
// off: a new vertical whose table carries only `owner_id` is never judged at all,
// and a per-user table in a B2B product is a design regression no test would show
// — every isolation assertion about it passes, because per-user isolation is
// strictly tighter than per-org.
//
// It is not a hypothetical mistake. The scaffold's own vertical-slice template
// predates the org model and teaches exactly that shape, so the most likely author
// of an untenanted table is an agent following the repo's instructions correctly.
const untenanted = new Set(untenantedTables.map((e) => e.table.toLowerCase()))
const orgTableName = stripSchema(cfg.orgTable)
const createdTables = parseCreatedTables(statements)
// A PARTITION is not a table any tenancy rule means. It declares no column list of
// its own (`CREATE TABLE x PARTITION OF y DEFAULT` declares none), so column-driven
// discovery sees an empty table and reports the most confident possible wrong finding
// — "created with no tenant column" — about an object whose tenancy is its parent's.
const partitions = new Set(
  [...createdTables].filter(([, t]) => t.partitionOf !== null).map(([name]) => name),
)
for (const e of untenantedTables) {
  const t = e.table.toLowerCase()
  if (!columnFacts.has(t)) {
    errs.push(
      `${CONFIG}: untenantedTables names '${e.table}' but no migration creates it — stale escape entries hide future holes; remove it`,
    )
  } else if (columnFacts.get(t).has(tenantCol)) {
    errs.push(
      `${CONFIG}: untenantedTables names '${e.table}' but it DOES carry a ${tenantCol} column — remove the escape so the table is judged like every other tenant table`,
    )
  }
}
for (const [table, cols] of [...columnFacts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  // The org table is the tenant; its own id IS the tenant key, which is why
  // checkOrgTable judges it separately rather than by column discovery.
  if (
    cols.has(tenantCol) ||
    table === orgTableName ||
    untenanted.has(table) ||
    partitions.has(table)
  )
    continue
  errs.push(
    `${table}: created with no ${tenantCol} column, so no tenancy rule reaches it — in an org-scoped product a table without a tenant key is a per-user table, and per-user isolation passes every cross-tenant test while quietly making the data unreachable to the colleagues who are supposed to share it. Add \`${tenantCol} uuid NOT NULL REFERENCES ${cfg.orgTable} (id) ON DELETE CASCADE\` plus the org-scoped policy set, or record it in ${CONFIG} untenantedTables with a reason`,
  )
}

const judged = tenantTables.filter((t) => !exempt.has(t) && t !== auditTable)

// ---------------------------------------------------------------------------
// Normalization + the compiled form set. Matching happens on a whitespace-free,
// lowercased, public.-stripped canon; MESSAGES print the single-spaced display
// form so the fix is a copy-paste.
// ---------------------------------------------------------------------------

const display = (s) =>
  s
    .toLowerCase()
    .replace(/\bpublic\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
const canon = (s) => display(s).replace(/ /g, '')
const rankValues = new Set(Object.values(cfg.roles))

function compileForm(f, scopeColumn) {
  const sql =
    scopeColumn === tenantCol
      ? f.sql
      : f.sql.replace(new RegExp(`\\b${tenantCol}\\b`, 'gi'), scopeColumn)
  return {
    name: f.name,
    tables: f.tables?.map((t) => stripSchema(t)) ?? null,
    rx: new RegExp(
      canon(sql)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\{rank\\\}/g, '(\\d+)'),
      'g',
    ),
  }
}
const forms = cfg.predicateForms.map((f) => compileForm(f, tenantCol))
// The ORG table is a tenant table whose scope column is its own primary key — it
// carries no org_id, so without this substitution the root of the whole model would
// be the one table the closed form set never judged.
const orgScopeColumn = 'id'
const orgForms = cfg.predicateForms.map((f) => compileForm(f, orgScopeColumn))

// A dual-scoped table gets ONE extra form, synthesized from its own entry and
// narrowed to itself: the legacy owner arm it is in the middle of retiring. Routing
// it through the same compiler as every reviewed form is the point — the arm is then
// judged by the identical machinery (top-level OR split, correlated-argument ban,
// relation sub-select ban), so the escape widens exactly one predicate shape on
// exactly one table and cannot become a general licence.
function formSetFor(table) {
  const e = dualByTable.get(table)
  if (e === undefined) return forms
  return [
    ...forms,
    compileForm(
      {
        name: 'dual-scope-legacy-owner',
        sql: `${e.ownerColumn} = (SELECT auth.uid())`,
        tables: [table],
      },
      tenantCol,
    ),
  ]
}

/**
 * null = no form matches anywhere in the arm; { badRank } = right shape, off-scale
 * floor. A form narrowed to `tables` is only offered to those tables, so the seat
 * table's self-row exception cannot silently license a self-row predicate on notes.
 */
function scopeTermOf(arm, table, formSet = forms) {
  const a = canon(arm)
  let offScale = null
  for (const f of formSet) {
    if (f.tables !== null && !f.tables.includes(table)) continue
    for (const m of a.matchAll(f.rx)) {
      if (m[1] === undefined || rankValues.has(Number(m[1]))) return { matched: f.name }
      offScale = { matched: f.name, badRank: Number(m[1]) }
    }
  }
  return offScale
}

// A sub-select that reads a relation is a per-row SubPlan (correlated) or a hidden
// join (not); either way it is not the hoisted scalar the forms are built from.
const SUBSELECT_WITH_FROM = /\(\s*select\b[^()]*(?:\([^()]*\)[^()]*)*\bfrom\b/i
// SQL keywords that read as `name (` in normalized text — never function calls.
const KEYWORD_CALLS = new Set([
  'and',
  'or',
  'not',
  'in',
  'any',
  'all',
  'some',
  'exists',
  'select',
  'case',
  'when',
  'then',
  'else',
  'between',
  'is',
  'like',
  'ilike',
  'similar',
  'cast',
  'row',
  'array',
  'values',
  'filter',
  'over',
  'from',
  'where',
  'group',
  'order',
])
const knownPure = new Set(cfg.knownPureFunctions.map((s) => s.toLowerCase()))
const rpcRole = cfg.rpcWriterRole.toLowerCase()
const readerRole = cfg.readerRole.toLowerCase()
const auditWriterRole = cfg.auditWriterRole.toLowerCase()
const auditReaderRole = cfg.auditReaderRole.toLowerCase()
const quotaWriterRole = cfg.quotaWriterRole.toLowerCase()
const readerHelperName = qualify(cfg.readerScopeHelper).name
// The closed set of roles that may hold a tenant policy. Every one of them exists
// because FORCE ROW LEVEL SECURITY subjects a definer function's OWNER to policies, so
// a table whose writes are denied to `authenticated` needs some other role to hold the
// write policy or nothing can ever write it. Adding to this set is a contract edit.
const POLICY_ROLES = new Set([
  'authenticated',
  rpcRole,
  readerRole,
  auditWriterRole,
  auditReaderRole,
  quotaWriterRole,
])

/** Function calls in `body` whose argument list references the row's scope column. */
function correlatedCalls(body, scopeColumn) {
  const colRe = new RegExp(`\\b${scopeColumn}\\b`, 'i')
  const found = []
  for (const m of body.matchAll(/([a-z0-9_.]+)\s*\(/gi)) {
    const name = m[1].toLowerCase()
    const bare = name.slice(name.lastIndexOf('.') + 1)
    if (KEYWORD_CALLS.has(bare) || knownPure.has(bare)) continue
    const span = matchParen(body, m.index + m[0].length - 1)
    if (span !== null && colRe.test(body.slice(span[0], span[1]))) found.push(name)
  }
  return found
}

function checkTenantPredicate(table, polName, kind, body, opts = {}) {
  if (body === null) return
  // A deny-all predicate grants nothing, so it cannot widen anything and needs no
  // reviewed form. This is how a table says "writes go only through the RPCs": the
  // permissive policy must EXIST (schema-rls requires one per operation) while
  // admitting no row.
  if (canon(body) === 'false' || canon(body) === '(false)') return
  const { formSet = forms, scopeColumn = tenantCol } = opts
  for (const fn of correlatedCalls(body, scopeColumn)) {
    errs.push(
      `${table}: policy ${polName} ${kind} passes ${scopeColumn} INTO ${fn}(...) — a helper handed a column of the row under test is a correlated SubPlan re-evaluated PER ROW (and it re-enters the membership table's own policies); the legal forms call zero-argument helpers hoisted once per statement`,
    )
  }
  if (SUBSELECT_WITH_FROM.test(body)) {
    errs.push(
      `${table}: policy ${polName} ${kind} contains a sub-select over a relation — tenant predicates use the uncorrelated zero-argument helper forms in ${CONFIG}. Predicate: '${display(body)}'`,
    )
  }
  const arms = splitTopLevelOr(body)
  for (const arm of arms) {
    const verdict = scopeTermOf(arm, table, formSet)
    if (verdict === null) {
      errs.push(
        arms.length === 1
          ? `${table}: policy ${polName} ${kind} matches NO reviewed predicate form — saw '${display(arm)}'. The legal forms live in ${CONFIG} predicateForms; admitting a new one is a CODEOWNERS-reviewed diff, not a rewrite of this message`
          : `${table}: policy ${polName} ${kind} has a top-level OR arm carrying no tenancy scope term — '${display(arm)}'. An AND inside an arm can only narrow, but every OR arm is an independent grant, so each must carry a reviewed form (this is what stops '... OR owner_id = (select auth.uid())' re-opening per-user scope)`,
      )
    } else if (verdict.badRank !== undefined) {
      errs.push(
        `${table}: policy ${polName} ${kind} uses rank floor ${verdict.badRank}, which is not a configured role rank (${[...rankValues].sort((a, b) => a - b).join(', ')}) — an off-scale floor is a typo that silently widens or bricks the operation`,
      )
    }
  }
}

// Two roles may hold a tenant policy, and only two. `authenticated` is the human
// caller. The rpc writer role is the owner of the allowlisted definer RPCs — it
// exists because FORCE ROW LEVEL SECURITY subjects even a function's owner to
// policies, so with seat writes denied to authenticated (as they must be) a
// database with no writer role is one where no seat can ever be created.
function checkPolicyRoles(table, p) {
  if (p.roles.length === 0) {
    errs.push(
      `${table}: policy ${p.name} has no TO clause — it defaults to PUBLIC (every role, anon included); tenant policies are TO authenticated (or TO ${rpcRole} for a definer-RPC write path)`,
    )
    return
  }
  const bad = p.roles.filter((r) => !POLICY_ROLES.has(r))
  if (bad.length > 0) {
    errs.push(
      `${table}: policy ${p.name} is granted TO ${bad.join(', ')} — tenant policies are TO authenticated, or TO the reviewed rpc writer role ${rpcRole} (${CONFIG}), and nothing else (anon has no membership; service_role bypasses RLS and is REVOKEd instead)`,
    )
  }
}

function checkTenantPolicies(table, pols) {
  const formSet = formSetFor(table)
  for (const p of pols) {
    checkPolicyRoles(table, p)
    if (p.permissive === 'RESTRICTIVE') continue // ANDs onto the permissive set — can only narrow
    checkTenantPredicate(table, p.name, 'USING', p.using, { formSet })
    checkTenantPredicate(table, p.name, 'WITH CHECK', p.check, { formSet })
  }
}

/**
 * THE PAIRING RULE, and the reason it is not optional.
 *
 * A policy whose predicate calls a rank/scope helper is evaluated with current_user
 * set to the role the policy names. Those helpers are SECURITY INVOKER, so they read
 * the seat table AS THAT ROLE. Give the role no SELECT policy on the seat table and
 * the read hits RLS default-deny: the helper returns an empty set, every rank
 * comparison is false, and the statement MATCHES ZERO ROWS AND REPORTS SUCCESS.
 * Nothing raises, no gate notices.
 *
 * That failure is identical in shape and opposite in consequence on the two sides:
 *
 *   a WRITE policy (the rpc role, on seats) silently changes nothing — every
 *   promotion in production looks fine and does not happen;
 *   a READ policy (the audit reader, on the trail) silently returns nothing — the
 *   compliance history looks empty to the admin entitled to it, which reads as
 *   "no activity" rather than as a fault.
 *
 * So the rule is closed over EVERY non-`authenticated` role that appears in ANY
 * helper-bearing policy, rather than over the one role that had the problem first.
 * `authenticated` is excluded because its self-only seat policy is required
 * separately by checkMembershipTable — a rule that demanded it here too would report
 * the same missing policy twice.
 *
 * The paired policy must be the self-only scalar. A helper-bearing SELECT policy on
 * the seat table would be re-entered by the helper it calls (54001 stack depth
 * exceeded), which is why the seat table's SELECT is the one place the closed form
 * set admits `self-row`.
 */
/**
 * role -> the helper-bearing policies that oblige it. Closed over EVERY table, because
 * the helper always reads the SEAT table no matter which table's policy called it: a
 * policy on the audit trail needs the seat-table SELECT policy exactly as much as one
 * on the seat table does.
 */
function collectHelperObligations() {
  const obliged = new Map()
  for (const [table, byName] of live) {
    for (const p of byName.values()) {
      if (!helperMentioned(`${p.using ?? ''} ${p.check ?? ''}`)) continue
      // `authenticated` is excluded because checkMembershipTable requires its self-only
      // seat policy separately — obliging it here would report the same gap twice.
      for (const role of p.roles.filter((r) => r !== 'authenticated')) {
        obliged.set(role, [...(obliged.get(role) ?? []), `${table}.${p.name}`])
      }
    }
  }
  return obliged
}

function checkHelperRolePairing() {
  if (!cfg.requireSelfSelectPolicy) return
  const obliged = collectHelperObligations()
  if (obliged.size === 0) return

  const selfTerm = canon(`${cfg.membershipUserColumn} = (select auth.uid())`)
  const seatPolicies = [...(live.get(membership)?.values() ?? [])]
  for (const [role, policies] of [...obliged].sort(([a], [b]) => a.localeCompare(b))) {
    const paired = seatPolicies.some(
      (p) =>
        p.roles.includes(role) &&
        (p.op === 'SELECT' || p.op === 'ALL') &&
        p.using !== null &&
        canon(p.using).includes(selfTerm),
    )
    if (paired) continue
    errs.push(
      `${role} holds helper-bearing polic(ies) — ${policies.sort().join(', ')} — but no self-only SELECT policy on ${membership}. ${cfg.rankHelper} is SECURITY INVOKER, so while those policies are evaluated it reads ${membership} AS ${role}, hits RLS default-deny, and returns an EMPTY map. Every rank comparison is then false, and the statement affects ZERO ROWS WHILE REPORTING SUCCESS — a write that silently does nothing, or a read that silently returns nothing, with no error anywhere. Add: CREATE POLICY ${membership}_select_${role} ON public.${membership} FOR SELECT TO ${role} USING (${cfg.membershipUserColumn} = (SELECT auth.uid()));`,
    )
  }
}

function helperMentioned(text) {
  const t = text.toLowerCase()
  return t.includes(scopeName) || t.includes(rankName)
}

// ---------------------------------------------------------------------------
// The membership table is the ONE table whose policies must NOT match the forms:
// self-only read (the recursion terminator), deny-all writes (seat changes go
// only through the definer RPCs). RECURSION SMELL TEST — the executable recursion
// probe in supabase/tests is the proof; this is the early warning.
// ---------------------------------------------------------------------------

/**
 * The seat table's SELECT policies are the ONE place a helper call is forbidden
 * outright: the helpers read this table, so a SELECT policy that calls one is
 * re-entered by it (42P17, "infinite recursion detected in policy"). Write
 * policies are safe — the inner read they trigger is governed by the self-only
 * SELECT policy, which terminates.
 */
// The seat table's SELECT policies, where the whole recursion story lives.
//
// Two roles get a self-only, HELPER-FREE policy and nothing else: `authenticated`
// (the human read) and the readerRole (the base case of the chain). One role — the
// rpc writer — may additionally carry an admin arm, because PostgreSQL AND-s this
// table's SELECT policies onto the WHERE clause of every seat UPDATE/DELETE, so
// without it an admin's promotion matches zero rows. That arm may call the reviewed
// readerScopeHelper and NOTHING else: readerScopeHelper is SECURITY DEFINER owned by
// the readerRole, so its read of this table is judged against the readerRole's
// helper-free policy and the chain terminates. Any OTHER helper here is the recursive
// case — it reads this table as the querying role and re-enters this same policy.
function checkMembershipSelect(p, selfTerm) {
  const using = p.using ?? ''
  const isReaderPolicy = p.roles.includes(readerRole)
  const mayWiden = p.roles.includes(rpcRole) && !isReaderPolicy
  // helperMentioned covers scopeHelper and rankHelper — the two INVOKER helpers that
  // read this table as the caller. readerScopeHelper is deliberately not one of them.
  if (helperMentioned(using)) {
    errs.push(
      `${membership}: SELECT policy ${p.name} calls an INVOKER tenancy helper (${cfg.scopeHelper}/${cfg.rankHelper}) — those read ${membership} as the querying role, so a SELECT policy here is re-entered by the very helper it called. That is the recursive case, and it surfaces as SQLSTATE 54001 (stack depth exceeded) rather than 42P17, because SET search_path = '' blocks the inlining the rewriter's cycle check depends on. Route the widening through ${cfg.readerScopeHelper} instead, which is SECURITY DEFINER owned by ${cfg.readerRole} and therefore reads under a policy that calls nothing`,
    )
    return
  }
  if (!mayWiden && canon(using).includes(canon(readerHelperName))) {
    errs.push(
      `${membership}: SELECT policy ${p.name} calls ${cfg.readerScopeHelper}, but that helper is reserved for the ${rpcRole} policy. Called from the ${cfg.readerRole} policy it re-enters itself (${cfg.readerRole} is the definer's own owner); called from the ${'authenticated'} policy it would hand every admin a member directory this design does not have`,
    )
    return
  }
  if (p.using !== null && !canon(p.using).includes(selfTerm)) {
    errs.push(
      `${membership}: SELECT policy ${p.name} is not self-only — expected the predicate to contain '${display(`${cfg.membershipUserColumn} = (select auth.uid())`)}', saw '${display(p.using)}'. Self-only SELECT is what makes the INVOKER helpers recursion-safe AND what makes them return the caller's real rank map during a definer RPC`,
    )
  }
}

// The base case must EXIST, and it must be the shape the chain depends on. Without
// this the readerRole could lose its policy entirely and the definer scope helper
// would read under RLS default-deny — returning an empty org array, which makes every
// admin arm false, which puts seat management back to matching zero rows. That is the
// same silent failure the rpc pairing rule exists to prevent, one role further down.
function checkReaderBaseCase(byName) {
  if (!cfg.readerScopeHelper) return
  const readerPolicies = [...byName.values()].filter(
    (p) => p.roles.includes(readerRole) && (p.op === 'SELECT' || p.op === 'ALL'),
  )
  if (readerPolicies.length === 0) {
    errs.push(
      `${membership}: no SELECT policy TO ${cfg.readerRole} — ${cfg.readerScopeHelper} is SECURITY DEFINER owned by that role, so its read of ${membership} hits RLS default-deny, returns an EMPTY array, and every admin arm resolving through it is false. Seat management then matches ZERO ROWS while reporting success. Add the self-only, helper-free policy that terminates the recursion chain`,
    )
    return
  }
  for (const p of readerPolicies) {
    if (
      p.using === null ||
      !canon(p.using).includes(canon(`${cfg.membershipUserColumn} = (select auth.uid())`))
    ) {
      errs.push(
        `${membership}: SELECT policy ${p.name} TO ${cfg.readerRole} must be exactly the self-only scalar — it is the TERMINAL node of the recursion chain, and anything broader either re-enters the chain or widens what a definer call can see`,
      )
    }
  }
}

function checkMembershipPolicy(p, selfTerm) {
  if (p.op === 'ALL') {
    errs.push(
      `${membership}: policy ${p.name} is FOR ALL — read and write need OPPOSITE predicates on this table, so one policy cannot serve both; split it per operation`,
    )
    return
  }
  if (p.op === 'SELECT') {
    checkMembershipSelect(p, selfTerm)
    return
  }
  // A write policy TO the human role must be deny-all: a self-keyed INSERT policy
  // would let any user grant THEMSELVES a seat in any org they can name.
  if (!p.roles.includes(rpcRole)) {
    for (const b of [p.using, p.check]) {
      if (b !== null && canon(b) !== 'false' && canon(b) !== '(false)') {
        errs.push(
          `${membership}: ${p.op} policy ${p.name} is TO authenticated and is not deny-all — seat changes go ONLY through the allowlisted definer RPCs (whose writes run as ${rpcRole}); a direct ${p.op} policy keyed on the caller lets any user grant THEMSELVES a seat in any org. Use USING (false) / WITH CHECK (false)`,
        )
      }
    }
    return
  }
  // A write policy TO the rpc role is a real predicate, judged by the same closed
  // form set as every other tenant table.
  checkTenantPredicate(membership, p.name, 'USING', p.using)
  checkTenantPredicate(membership, p.name, 'WITH CHECK', p.check)
}

function checkMembershipTable(pols) {
  const selfTerm = canon(`${cfg.membershipUserColumn} = (select auth.uid())`)
  for (const p of pols) {
    checkPolicyRoles(membership, p)
    checkMembershipPolicy(p, selfTerm)
  }
  if (!pols.some((p) => p.op === 'SELECT' && p.roles.includes('authenticated'))) {
    errs.push(
      `${membership}: no SELECT policy TO authenticated — the self-only SELECT policy is the recursion terminator the helpers rely on; without it every member set reads empty (and a later broad policy would be worse)`,
    )
  }
  checkReaderBaseCase(new Map(pols.map((p) => [p.name, p])))
  for (const g of grants) {
    if (g.kind !== 'GRANT' || g.target !== membership || !g.roles.includes('authenticated'))
      continue
    const writes = g.privileges.filter((p) =>
      ['INSERT', 'UPDATE', 'DELETE', 'ALL', 'ALL PRIVILEGES'].includes(p),
    )
    if (writes.length > 0) {
      errs.push(
        `${membership}: GRANT ${writes.join(', ')} TO authenticated — the seat table is read-only to authenticated; seat changes go through the definer RPCs (statement: ${g.stmt})`,
      )
    }
  }
}

/**
 * The org table is a tenant table whose scope column is its own primary key. It
 * carries no tenant column, so the column-driven discovery below never reaches it
 * — which would leave the ROOT of the tenancy model as the one table whose
 * policies nothing judged. `USING (created_by = (select auth.uid()) OR name IS NOT
 * NULL)` would otherwise pass every static gate in the repo while publishing every
 * org row to every user.
 */
function checkOrgTable() {
  const orgTable = stripSchema(cfg.orgTable)
  if (!columnFacts.has(orgTable)) {
    errs.push(
      `${cfg.orgTable}: named by ${CONFIG} as the org table but no migration creates it — every tenant key REFERENCES it, so the spine cannot apply`,
    )
    return
  }
  const pols = [...(live.get(orgTable)?.values() ?? [])]
  if (pols.length === 0) {
    errs.push(
      `${orgTable}: no policies — the org table is the root of the tenancy model and is judged by the same closed form set (with '${orgScopeColumn}' as its scope column)`,
    )
    return
  }
  for (const p of pols) {
    checkPolicyRoles(orgTable, p)
    if (p.permissive === 'RESTRICTIVE') continue
    const opts = { formSet: orgForms, scopeColumn: orgScopeColumn }
    checkTenantPredicate(orgTable, p.name, 'USING', p.using, opts)
    checkTenantPredicate(orgTable, p.name, 'WITH CHECK', p.check, opts)
  }
}

// ---------------------------------------------------------------------------
// Schema shape per tenant table: the key cannot be NULL, cannot dangle, cannot
// move, and every unique constraint stays partition-ready.
// ---------------------------------------------------------------------------

function checkTenantColumnDdl(table) {
  const col = columnFacts.get(table).get(tenantCol)
  // Suspended for a dual-scoped table, because a nullable key IS the expand phase:
  // org_id arrives NULL on every pre-tenancy row and only takes NOT NULL once the
  // backfill is done. The escape's expiry is what keeps that window from becoming
  // the permanent state; nothing here needs to.
  if (!col.notNull && !dualByTable.has(table)) {
    errs.push(
      `${table}.${tenantCol}: not NOT NULL — a NULL tenant key is invisible to '= ANY(...)' (NULL is never equal), so the row disappears for everyone including its author, and the first "fix" anyone writes is 'OR ${tenantCol} IS NULL', a global leak. A fresh table ships NOT NULL in its creating migration; an install MID-ADOPTION from a pre-tenancy release records the table in ${CONFIG} dualScopedTables with an expiring \`until\` (docs/runbooks/tenancy-adoption.md) and finishes with SET NOT NULL`,
    )
  }
  if (col.references !== orgQualified) {
    errs.push(
      `${table}.${tenantCol}: no FOREIGN KEY to ${cfg.orgTable} (saw ${col.references ?? 'no REFERENCES at all'}) — an unreferenced tenant key can hold orphan ids no org owns and no membership can ever match`,
    )
  }
}

function checkUniqueInclusion(table) {
  // Suspended wholesale for a dual-scoped table, and it has to be wholesale: EVERY
  // unique on a mid-adoption table is necessarily tenant-blind, because they were
  // all declared before the tenant column existed — and a nullable column cannot
  // join a primary key, so reshaping them is itself a contract-phase act. Folding
  // them under the dual-scope deadline instead of a separate uniqueWithoutTenantColumn
  // entry per constraint is what keeps ONE clock on the transition: a second escape
  // list would not expire, so the papercut would quietly outlive the thing it was
  // written for.
  if (dualByTable.has(table)) return
  for (const idx of indexes.all) {
    if (idx.table !== table || !idx.unique) continue
    if (idx.columns.some((c) => c.name === tenantCol)) continue
    if (
      uniqueEscapes.some(
        (e) => e.table.toLowerCase() === table && e.index.toLowerCase() === idx.name,
      )
    )
      continue
    errs.push(
      `${table}: UNIQUE/PRIMARY KEY '${idx.name}' (${idx.columns.map((c) => c.name).join(', ')}) omits ${tenantCol} — partitioning by tenant requires every unique constraint to include the partition key, and a tenant-blind unique is a cross-org information channel (an insert failure reveals another org's value). Include ${tenantCol}, or (human decision) register the constraint in ${CONFIG} uniqueWithoutTenantColumn with a reason`,
    )
  }
}

function checkFreezeTrigger(table, fnName) {
  const want = qualify(fnName).qualified
  const trig = triggers.find(
    (tr) =>
      tr.table === table &&
      tr.timing === 'BEFORE' &&
      tr.events.includes('UPDATE') &&
      tr.execute !== null &&
      qualify(tr.execute).qualified === want,
  )
  if (trig === undefined) {
    errs.push(
      `${table}: no BEFORE UPDATE trigger executing ${fnName} — without the freeze an UPDATE can move a row between orgs and every scope check above becomes advisory. Add: CREATE TRIGGER ${table}_freeze BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION ${fnName}();`,
    )
    return
  }
  if (trig.forEach !== 'ROW') {
    errs.push(
      `${table}: freeze trigger ${trig.name} is FOR EACH STATEMENT — a statement trigger sees no OLD/NEW pair, so it freezes nothing`,
    )
  }
  if (trig.when !== null) {
    errs.push(
      `${table}: freeze trigger ${trig.name} carries a WHEN clause — a disarmable freeze is not a freeze; the function body does its own OLD/NEW comparison`,
    )
  }
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------
// Judged by its OWN rules, because for this one table the ordinary tenant rules are
// wrong rather than merely inconvenient: its tenant key must NOT be a foreign key
// (an ON DELETE CASCADE makes deleting an org delete the record of what was done
// inside it), and it must carry no freeze trigger (it forbids UPDATE outright, which
// is strictly stronger than freezing one column).
//
// What replaces them is the four-layer closure below plus the one rule that makes the
// whole trail non-vacuous: EVERY org-scoped table carries an audit trigger. Without
// that, a green gate is compatible with an audit schema that records nothing.

const auditWriteFn = qualify(cfg.auditWriteFunction).qualified
const auditPartitionCol = cfg.auditPartitionColumn.toLowerCase()

/** Layer 2: no client role holds a grant on the trail, and the writer only appends. */
function checkAuditGrants() {
  for (const g of grants) {
    if (g.kind !== 'GRANT' || g.target !== auditTable) continue
    const clients = g.roles.filter(
      (r) => !['app_audit_writer', auditWriterRole, auditReaderRole].includes(r),
    )
    if (clients.length > 0) {
      errs.push(
        `${cfg.auditTable}: GRANT ${g.privileges.join(', ')} TO ${clients.join(', ')} — layer 2 is that NO client role holds a grant here. service_role in particular BYPASSES RLS, so for it the grant is the only control that binds at all (statement: ${g.stmt})`,
      )
    }
    if (
      g.roles.includes(auditWriterRole) &&
      g.privileges.some((p) => ['UPDATE', 'DELETE', 'ALL', 'ALL PRIVILEGES'].includes(p))
    ) {
      errs.push(
        `${cfg.auditTable}: GRANT ${g.privileges.join(', ')} TO ${cfg.auditWriterRole} — the writer appends and nothing else; UPDATE or DELETE authority on the trail defeats the point of routing every write through one function`,
      )
    }
  }
}

/** Layers 1 and 2: no write policy, no client grant. */
function checkAuditImmutabilityPolicies() {
  for (const p of live.get(auditTable)?.values() ?? []) {
    if (p.op === 'UPDATE' || p.op === 'DELETE' || p.op === 'ALL') {
      errs.push(
        `${cfg.auditTable}: policy ${p.name} is FOR ${p.op} — the trail is append-only, and the ABSENCE of an update/delete policy is layer 1 of four. A policy here does not merely permit an edit, it makes the other three layers the only thing standing between a compliance record and whoever can reach this role`,
      )
    }
    if (p.op === 'INSERT' && !p.roles.includes(auditWriterRole)) {
      errs.push(
        `${cfg.auditTable}: INSERT policy ${p.name} is TO ${p.roles.join(', ') || 'PUBLIC'} — only ${cfg.auditWriterRole} may append, and it is reachable ONLY as the owner of ${cfg.auditWriteFunction}. Any other role holding an insert policy can write history it authored`,
      )
    }
    if (p.op === 'SELECT' && !p.roles.includes(auditReaderRole)) {
      errs.push(
        `${cfg.auditTable}: SELECT policy ${p.name} is TO ${p.roles.join(', ') || 'PUBLIC'} — the read path is ${cfg.auditReaderRole} alone, behind a definer function. The writer must not be able to read: one role for both means every path that can append can also exfiltrate every tenant's history`,
      )
    }
  }
  const actorCheck = [...(live.get(auditTable)?.values() ?? [])].find(
    (p) => p.op === 'INSERT',
  )?.check
  if (
    actorCheck !== undefined &&
    actorCheck !== null &&
    !canon(actorCheck).includes(canon(cfg.auditActorColumn))
  ) {
    errs.push(
      `${cfg.auditTable}: the INSERT policy's WITH CHECK does not constrain ${cfg.auditActorColumn} (saw '${display(actorCheck)}') — the row's actor must be checked against the DATABASE's own opinion of who is acting, e.g. \`${cfg.auditActorColumn} IS NOT DISTINCT FROM (SELECT auth.uid())\`. Without it a caller who reached ${cfg.auditWriterRole} can write history blaming somebody else, and every layer above records the forgery faithfully`,
    )
  }
  checkAuditGrants()
}

/** Layers 3 and 4: the triggers that survive BYPASSRLS and TRUNCATE. */
function checkAuditImmutabilityTriggers() {
  const denyFn = qualify(cfg.auditDenyFunction).qualified
  const onAudit = triggers.filter(
    (t) => t.table === auditTable || t.table.startsWith(`${auditTable}_`),
  )
  const rowGuard = onAudit.find(
    (t) =>
      t.table === auditTable &&
      t.timing === 'BEFORE' &&
      t.forEach === 'ROW' &&
      t.events.includes('UPDATE') &&
      t.events.includes('DELETE'),
  )
  if (rowGuard === undefined) {
    errs.push(
      `${cfg.auditTable}: no BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger — this is layer 3, and it is the ONLY layer that binds a role holding BYPASSRLS. Verified: \`postgres\` on Supabase holds rolbypassrls, so layers 1 and 2 do nothing to it while the trigger still fires. Add: CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON ${cfg.auditTable} FOR EACH ROW EXECUTE FUNCTION ${cfg.auditDenyFunction}();`,
    )
  } else if (rowGuard.when !== null) {
    errs.push(
      `${cfg.auditTable}: the immutability trigger ${rowGuard.name} carries a WHEN clause — a disarmable immutability guard is not one, and the condition is written by exactly the person the trail exists to record`,
    )
  } else if (qualify(rowGuard.execute ?? '').qualified !== denyFn) {
    errs.push(
      `${cfg.auditTable}: the immutability trigger ${rowGuard.name} executes ${rowGuard.execute}, not ${cfg.auditDenyFunction} — ${CONFIG} names the raising function, and a trigger running something else may return without raising at all`,
    )
  }

  // Layer 4, on the parent AND on every partition a migration creates. PostgreSQL
  // clones ROW triggers to partitions (including ones created later — verified) but
  // does NOT clone TRUNCATE triggers, and truncating a leaf directly does not fire the
  // parent's. A trail guarded only at the parent is emptiable one month at a time.
  const truncateGuarded = new Set(
    onAudit
      .filter((t) => t.timing === 'BEFORE' && t.events.includes('TRUNCATE'))
      .map((t) => t.table),
  )
  if (!truncateGuarded.has(auditTable)) {
    errs.push(
      `${cfg.auditTable}: no BEFORE TRUNCATE ... FOR EACH STATEMENT trigger — this is layer 4, and no row trigger can substitute for it: TRUNCATE removes rows without ever producing an OLD/NEW pair, so the layer-3 trigger above never fires. Add: CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON ${cfg.auditTable} FOR EACH STATEMENT EXECUTE FUNCTION ${cfg.auditDenyFunction}();`,
    )
  }
  for (const t of truncateGuarded) {
    const trig = onAudit.find((x) => x.table === t && x.events.includes('TRUNCATE'))
    if (trig !== undefined && trig.forEach !== 'STATEMENT') {
      errs.push(
        `${t}: TRUNCATE trigger ${trig.name} is FOR EACH ROW — PostgreSQL only ever fires TRUNCATE triggers per statement, so a row-level one is never invoked and the guard is inert`,
      )
    }
  }
  // Every partition this migration history CREATES must carry its own truncate guard.
  // Partitions created at runtime by the maintenance function are covered by the check
  // on that function's body below, not here.
  for (const [table, meta] of createdTables) {
    if (meta.partitionOf !== auditTable) continue
    if (!truncateGuarded.has(table)) {
      errs.push(
        `${table}: a partition of ${cfg.auditTable} created by a migration with no BEFORE TRUNCATE trigger of its own — TRUNCATE triggers are NOT cloned to partitions, so \`TRUNCATE ${table}\` succeeds while the parent's guard never fires. Add the per-partition twin`,
      )
    }
  }
}

/** The write path: one definer function, an actor it derives rather than accepts. */
function checkAuditWriter() {
  const fn = resolveFunction(functions, auditWriteFn)
  if (fn === undefined) {
    errs.push(
      `${cfg.auditWriteFunction}: named by ${CONFIG} as the audit writer but defined in no migration — every audit trigger executes it, so applying them fails`,
    )
    return
  }
  if (!fn.securityDefiner) {
    errs.push(
      `${cfg.auditWriteFunction}: not SECURITY DEFINER — as invoker it would insert as the CALLING user, who holds no grant on ${cfg.auditTable} (layer 2), so every audited write would fail 42501`,
    )
  }
  if (fn.searchPath !== '') {
    errs.push(
      `${cfg.auditWriteFunction}: does not pin SET search_path = '' (saw ${fn.searchPath === null ? 'no SET at all' : `'${fn.searchPath}'`}) — a definer function whose search_path a caller controls resolves unqualified names to objects the caller planted, and runs them as ${cfg.auditWriterRole}`,
    )
  }
  if (fn.params.length > 0) {
    errs.push(
      `${cfg.auditWriteFunction}: takes ${fn.params.length} parameter(s) — a trigger function takes none; per-table configuration travels as TRIGGER ARGUMENTS (TG_ARGV), which are fixed in the DDL and cannot be chosen by a caller`,
    )
  }
  const body = fn.body ?? ''
  if (!new RegExp(`\\b${cfg.auditActorColumn}\\b`, 'i').test(body)) {
    errs.push(
      `${cfg.auditWriteFunction}: body never sets ${cfg.auditActorColumn} — the actor must be derived INSIDE the writer from the verified caller. A column DEFAULT is not equivalent and is the standard mistake: a default applies only when the writer OMITS the column, so it records whoever the writer says they are`,
    )
  }
  // The actor must come from the caller, not from anything the audited statement can
  // influence. A row column named actor/user would be the audited table's own opinion
  // of who acted, which is the thing under investigation.
  if (!/\b(auth\.uid|caller_id)\s*\(/i.test(body)) {
    errs.push(
      `${cfg.auditWriteFunction}: body derives no verified identity (expected a call to auth.uid() or the private caller-id helper) — an audit trail whose actor comes from the ROW rather than from the session records what the writer claimed, not what the database observed`,
    )
  }
  // The trap this file's own first version fell into: a raising cast of a GUC inside
  // the trigger aborts the statement that fired it, so one malformed header value
  // stops every write in the product.
  const actorDefault = columnFacts.get(auditTable)?.get(cfg.auditActorColumn)
  if (
    actorDefault !== undefined &&
    actorDefault.stmts.some((s) => /\bactor_id\b[^,]*\bDEFAULT\b/i.test(s))
  ) {
    errs.push(
      `${cfg.auditTable}.${cfg.auditActorColumn}: has a column DEFAULT — remove it. A DEFAULT is applied only when the inserting statement OMITS the column, so any writer that supplies it chooses its own actor; the value must be assigned inside ${cfg.auditWriteFunction}, where the caller cannot reach it, and cross-checked by the INSERT policy`,
    )
  }
}

/** The tenant key: present, NOT NULL, and deliberately not a foreign key. */
function checkAuditColumns() {
  const cols = columnFacts.get(auditTable)
  const key = cols.get(tenantCol)
  if (key === undefined) {
    errs.push(
      `${cfg.auditTable}: no ${tenantCol} column — every read of the trail filters by tenant, so a trail without one is a trail nobody can be shown`,
    )
  } else {
    if (!key.notNull) {
      errs.push(
        `${cfg.auditTable}.${tenantCol}: not NOT NULL — a NULL tenant key is invisible to every read policy, so the row is retained forever and shown to nobody: the worst of both properties`,
      )
    }
    if (key.references !== null) {
      errs.push(
        `${cfg.auditTable}.${tenantCol}: REFERENCES ${key.references} — the audit trail's tenant key must NOT be a foreign key. With ON DELETE CASCADE, deleting an org deletes the record of everything done inside it, so the evidence is destroyed by the single act most likely to need investigating; with any other action, the constraint blocks org deletion outright. The id is retained as an opaque value that outlives the row it names`,
      )
    }
  }
  if (!cols.has(auditPartitionCol)) {
    errs.push(
      `${cfg.auditTable}: no ${auditPartitionCol} column — ${CONFIG} names it as the partition key, and retention is a partition DROP because it is the only removal an append-only table can support`,
    )
  }
}

/**
 * THE CLOSURE, and the only check here that makes the rest non-vacuous. Everything
 * above describes a well-built trail; this asserts that anything is written to it.
 */
/**
 * The per-table trigger shape. Returns the `table.column` keys this trigger captures
 * BY VALUE — arguments 3 and beyond, the ones that copy data into the trail.
 */
function checkAuditTriggerShape(table, trig) {
  if (trig.timing !== 'AFTER') {
    errs.push(
      `${table}: audit trigger ${trig.name} is ${trig.timing}, not AFTER — a BEFORE trigger records writes that then fail, so the trail claims changes the database rejected`,
    )
  }
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    if (!trig.events.includes(op)) {
      errs.push(
        `${table}: audit trigger ${trig.name} does not fire on ${op} — a trail missing one operation is a trail with a blind spot at exactly the operation somebody chose to leave out`,
      )
    }
  }
  if (trig.forEach !== 'ROW') {
    errs.push(
      `${table}: audit trigger ${trig.name} is FOR EACH STATEMENT — a statement trigger sees no row, so it can record neither which row changed nor which tenant it belonged to`,
    )
  }
  if (trig.when !== null) {
    errs.push(
      `${table}: audit trigger ${trig.name} carries a WHEN clause ('${display(trig.when)}') — a conditional audit trigger is a trail with a documented blind spot whose condition is written by the same person the trail exists to record. Filter when READING, never when writing`,
    )
  }
  const args = trig.args ?? []
  const scopeColumn = table === stripSchema(cfg.orgTable) ? 'id' : tenantCol
  if (args[0] !== scopeColumn) {
    errs.push(
      `${table}: audit trigger ${trig.name} declares tenant column '${args[0] ?? '<none>'}', expected '${scopeColumn}' — ${cfg.auditWriteFunction} reads the tenant from that argument, so a wrong one either raises on every write or files every row under the wrong tenant`,
    )
  }
  const cols = columnFacts.get(table) ?? new Map()
  const captured = []
  for (const [i, col] of args.entries()) {
    if (!cols.has(col.toLowerCase())) {
      errs.push(
        `${table}: audit trigger ${trig.name} names column '${col}', which the table does not have — the trigger will raise on the first write to it`,
      )
    }
    if (i >= 2) captured.push(`${table}.${col.toLowerCase()}`)
  }
  return captured
}

function checkAuditCoverage() {
  const captured = new Map() // `${table}.${column}` -> true
  // The one escape from the closure, and it stays narrow because the closure is what
  // makes every other audit rule non-vacuous. It reds when stale (below) and suspends
  // nothing else: an exempt table is still tenant-scoped, policied and frozen.
  const auditExempt = new Set(auditExemptTables.map((e) => e.table.toLowerCase()))
  for (const e of auditExemptTables) {
    if (!columnFacts.has(e.table.toLowerCase())) {
      errs.push(
        `${CONFIG}: auditExemptTables names '${e.table}' but no migration creates it — a stale audit exemption is a table-shaped hole waiting for a table to arrive under it; remove it`,
      )
    }
  }
  for (const table of [...judged, stripSchema(cfg.orgTable)].sort()) {
    if (auditExempt.has(table)) continue
    const trig = triggers.find(
      (t) =>
        t.table === table && t.execute !== null && qualify(t.execute).qualified === auditWriteFn,
    )
    if (trig === undefined) {
      errs.push(
        `${table}: org-scoped, but no AFTER INSERT OR UPDATE OR DELETE trigger executing ${cfg.auditWriteFunction} — a table outside the trail is a table whose changes leave no record, and the gap is invisible precisely because everything else about it is correct. Add: CREATE TRIGGER ${table}_audit AFTER INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION ${cfg.auditWriteFunction}('${tenantCol}', '<identity column>');`,
      )
      continue
    }
    for (const key of checkAuditTriggerShape(table, trig)) captured.set(key, true)
  }
  checkCaptureLists(captured)
}

/**
 * Value capture, closed BOTH ways against the two reviewed lists. One way alone is
 * not enough: checking only that captures are declared lets a stale declaration
 * outlive the trigger it described, and checking only that declarations are used
 * lets an undeclared capture ship.
 */
function checkCaptureLists(captured) {
  const pii = new Map()
  for (const e of readReviewedFile(PII_COLUMNS, 'columns', ['table', 'column'])) {
    pii.set(`${e.table.toLowerCase()}.${e.column.toLowerCase()}`, e)
  }
  const declared = new Map()
  for (const e of readReviewedFile(AUDIT_COLUMNS, 'capture', ['table', 'column'])) {
    declared.set(`${e.table.toLowerCase()}.${e.column.toLowerCase()}`, e)
  }

  for (const key of captured.keys()) {
    if (pii.has(key)) {
      errs.push(
        `${key}: captured by an audit trigger but listed in ${PII_COLUMNS} — value capture republishes the column into a table every rank-${cfg.auditReadRank} admin can read, with a retention measured in years. Reason on file: ${pii.get(key).reason}`,
      )
    }
    if (!declared.has(key)) {
      errs.push(
        `${key}: captured by an audit trigger with no entry in ${AUDIT_COLUMNS} — capturing a VALUE (rather than the fact that the column changed) makes the trail a second, less-policied home for that data, so it is a reviewed decision with a reason, not a trigger-argument edit`,
      )
    }
  }
  for (const key of declared.keys()) {
    if (!captured.has(key)) {
      errs.push(
        `${AUDIT_COLUMNS}: declares capture of '${key}' but no audit trigger passes that column — a stale entry reads as an approved capture that is not happening, so the next person to add the argument does it unreviewed. Remove it, or add the trigger argument`,
      )
    }
    if (pii.has(key)) {
      errs.push(
        `${AUDIT_COLUMNS}: declares capture of '${key}', which ${PII_COLUMNS} forbids — the two reviewed lists contradict each other, and the gate will not choose between them`,
      )
    }
  }
  checkPiiListLive(pii)
}

/**
 * Stale-entry closure on the deny list itself: a rule naming a column that no longer
 * exists protects nothing and reads as coverage.
 */
function checkPiiListLive(pii) {
  for (const key of pii.keys()) {
    const [t, c] = key.split('.')
    if (!columnFacts.has(t)) {
      errs.push(
        `${PII_COLUMNS}: names '${key}' but no migration creates table '${t}' — a deny-list entry for a table that does not exist forbids nothing while reading as protection; remove it`,
      )
    } else if (!columnFacts.get(t).has(c)) {
      errs.push(
        `${PII_COLUMNS}: names '${key}' but table '${t}' has no column '${c}' — the column was renamed or dropped and the protection lapsed silently; update the entry`,
      )
    }
  }
}

function checkAuditTrail() {
  if (!columnFacts.has(auditTable)) {
    // Adoption, not correctness: an install upgrading from a pre-0.2.0 release has no
    // audit schema, and the audit migration is seedOnInitOnly so `update` never plants
    // it. Hard-failing that install would be an upgrade ambush. The moment the table
    // exists, every rule above is a hard red regardless of manifest vintage.
    if (
      rampNote(GATE, RAMP, `no ${cfg.auditTable} table — the audit trail arrives in ${RAMP}`, {
        until: '0.4.0',
      })
    )
      return
    errs.push(
      `${cfg.auditTable}: named by ${CONFIG} as the audit trail but no migration creates it — without it every org-scoped table's changes leave no record. See docs/adr/20260202-audit-trail.md`,
    )
    return
  }
  checkAuditColumns()
  checkAuditImmutabilityPolicies()
  checkAuditImmutabilityTriggers()
  checkAuditWriter()
  checkAuditCoverage()
}

for (const table of judged) {
  const pols = [...(live.get(table)?.values() ?? [])]
  if (table === membership) checkMembershipTable(pols)
  else checkTenantPolicies(table, pols)
  checkTenantColumnDdl(table)
  checkUniqueInclusion(table)
  checkFreezeTrigger(
    table,
    table === membership ? cfg.membershipFreezeFunction : cfg.freezeFunction,
  )
}
checkOrgTable()
checkHelperRolePairing()
checkAuditTrail()

// ---------------------------------------------------------------------------
// The named machinery must exist and hold its declared shape — a contract whose
// helpers are missing or mis-declared judges policies against functions that will
// never run the way the forms assume.
// ---------------------------------------------------------------------------

function checkHelper(name) {
  const fn = resolveFunction(functions, qualify(name).qualified)
  if (fn === undefined) {
    errs.push(
      `${name}: named by ${CONFIG} (the predicate forms call it) but defined in no migration — CREATE POLICY would fail at apply time, or a later same-named function gets the job`,
    )
    return
  }
  if (fn.securityDefiner) {
    errs.push(
      `${name}: SECURITY DEFINER — the scope helpers must be SECURITY INVOKER: as invoker they read ${cfg.membershipTable} under its own self-only policy (the recursion-safety design); as definer they bypass it and become an escalation surface`,
    )
  }
  if (fn.volatility !== 'STABLE') {
    errs.push(
      `${name}: declared ${fn.volatility} — the helpers must be STABLE so the planner may hoist the scalar sub-select to one InitPlan per statement`,
    )
  }
  if (fn.searchPath !== '') {
    errs.push(
      `${name}: does not pin SET search_path = '' (saw ${fn.searchPath === null ? 'no SET at all' : `'${fn.searchPath}'`}) — an unpinned search_path resolves unqualified names to whatever the caller planted first`,
    )
  }
  if (fn.params.length > 0) {
    errs.push(
      `${name}: takes ${fn.params.length} parameter(s) — zero arguments is what makes the sub-select uncorrelated; a parameter is how the row under test sneaks in and turns it into a per-row SubPlan`,
    )
  }
  const memBare = qualify(cfg.membershipTable).name
  if (fn.body !== null && !new RegExp(`\\b${memBare}\\b`, 'i').test(fn.body)) {
    errs.push(
      `${name}: body never reads ${cfg.membershipTable} — the helper must derive the caller's set from the membership table, not from anything the caller hands it`,
    )
  }
}
checkHelper(cfg.scopeHelper)
checkHelper(cfg.rankHelper)

function checkFreezeFunction(fnName) {
  const fn = resolveFunction(functions, qualify(fnName).qualified)
  if (fn === undefined) {
    errs.push(
      `${fnName}: named by ${CONFIG} but defined in no migration — the freeze triggers execute it, so applying them fails (or a later same-named function silently gets the job)`,
    )
    return
  }
  if (fn.body === null || !/\braise\b/i.test(fn.body)) {
    errs.push(`${fnName}: body never RAISEs — a freeze that does not raise is a comment`)
  }
}
checkFreezeFunction(cfg.freezeFunction)
if (judged.includes(membership)) checkFreezeFunction(cfg.membershipFreezeFunction)

if (cfg.directoryRpc !== null) {
  const fn = resolveFunction(functions, qualify(cfg.directoryRpc).qualified)
  if (fn === undefined) {
    errs.push(
      `${cfg.directoryRpc}: named by ${CONFIG} as the directory RPC but defined in no migration — set "directoryRpc": null if this install deliberately ships no member directory`,
    )
  } else if (!fn.securityDefiner) {
    errs.push(
      `${cfg.directoryRpc}: not SECURITY DEFINER — as invoker it can only ever see the caller's own membership row (self-only policy), a directory of one; its definer discipline (allowlist, search_path, grants) is enforced by the schema-rls gate`,
    )
  }
}

// The non-public schemas exist to be UNREACHABLE over PostgREST (helpers, audit).
// Publishing one in [api].schemas hands every client a direct door.
if (existsSync(CONFIG_TOML)) {
  const apiSchemas =
    readFileSync(CONFIG_TOML, 'utf8')
      .match(/^\s*schemas\s*=\s*\[([^\]]*)\]/m)?.[1]
      ?.split(',')
      .map((s) => s.trim().replace(/["']/g, '').toLowerCase())
      .filter(Boolean) ?? []
  for (const s of cfg.nonPublicSchemas) {
    if (apiSchemas.includes(s.toLowerCase())) {
      errs.push(
        `schema '${s}' is listed in [api].schemas (${CONFIG_TOML}) — ${CONFIG} nonPublicSchemas declares it PostgREST-invisible; publishing it exposes every object inside to direct API calls`,
      )
    }
  }
}

failures(
  GATE,
  errs,
  `The contract is ${CONFIG}: predicateForms is owned data (widening it is a CODEOWNERS-reviewed diff); exemptTables, untenantedTables, uniqueWithoutTenantColumn and dualScopedTables are the only per-table escapes, each requires a reason, and each reds when it goes stale — dualScopedTables also reds when it outlives its \`until\`.`,
)
recordGreen()
ok(
  GATE,
  `${judged.length} tenant table(s) × ${forms.length} reviewed predicate form(s): scope-closed policies (every OR arm), NOT NULL FK tenant keys, tenant-complete uniques, freeze triggers, invoker-safe zero-arg helpers, membership self-only, append-only audit trail (4 immutability layers, split writer/reader, audited on every org-scoped table)${
    dualScoped.length > 0
      ? ` — ${dualScoped.length} table(s) MID-ADOPTION under a dual scope expiring at ${dualScoped.map((e) => `${e.table}@${e.until}`).join(', ')}`
      : ''
  }`,
)
