// tools/lib/table-grants.mjs — the POLICY → GRANT closure.
//
// THE FACT THE WHOLE FILE RESTS ON: PostgreSQL checks TABLE PRIVILEGES FIRST and row
// security SECOND. A role that holds no privilege on a table never reaches the policy
// stage at all — the statement raises 42501 (`permission denied for table`), which
// PostgREST surfaces as HTTP 403. So a `CREATE POLICY … TO app_reader` with no matching
// `GRANT … TO app_reader` is not a narrow permission, it is UNREACHABLE CODE that reads
// in review as a granted one.
// SOURCE: https://www.postgresql.org/docs/17/ddl-rowsecurity.html (row security is applied
// in addition to, and after, the normal privilege system)
//
// WHY THIS BECAME URGENT, and why the check is dated. Supabase has always applied DEFAULT
// PRIVILEGES in `public` that grant `anon`, `authenticated` and `service_role` on every
// newly created table, which is why the omission is invisible: a policy `TO authenticated`
// with no GRANT behind it works perfectly, because the default already handed the role its
// privileges. That stops for projects created on or after 2026-10-30 — new tables arrive
// with no grants at all, and the `auto_expose_new_tables` switch that would have restored
// the old behaviour is itself removed on the same date. A migration written and reviewed
// today therefore keeps working in the project it was written against and 403s in the next
// project it is replayed into, with the SQL byte-identical in both. An explicit GRANT is
// the only form that survives the flip, which is what this closure requires.
// SOURCE: https://supabase.com/docs/guides/api (Data API grants and exposed schemas)
//
// THE CLOSURE IS ONE-WAY, DELIBERATELY. Policy ⇒ grant is asserted for every role; grant ⇒
// policy is NOT asserted for `service_role`. `GRANT SELECT, DELETE ON TABLE public.orgs TO
// service_role` is a legitimate, ADR-governed grant with no policy behind it precisely because
// `service_role` BYPASSES row security — a grant⇒policy rule over it would red the shipped
// tree for being correct. The reverse direction for the two roles that do NOT bypass row
// security is the grant BOUND at the end of this file (1.1.0), over a second fold.
//
// PURE — no fs, no process. Callers parse the SQL and own every exit.
// SOURCE: docs/harness/gates-catalog.md (schema-rls)
import { parseCreatedTables, parseGrants, stripSchema, withTableDrops } from './sql-parse.mjs'

/** The four operations a policy can name. TRUNCATE/REFERENCES/TRIGGER are not policied. */
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

/** The roles Supabase's default privileges cover — the ones the 2026-10-30 flip is about. */
const DEFAULT_PRIVILEGE_ROLES = new Set(['anon', 'authenticated', 'service_role'])

/** PostgreSQL's implicit "every role" grantee. A privilege held here is held by all. */
const PUBLIC = 'public'

/** `public.x` is parsed as `x`; every other schema keeps its prefix. Re-qualify for SQL. */
const qualify = (table) => (table.includes('.') ? table : `public.${table}`)

const inSchema = (table, schema) =>
  schema === PUBLIC ? !table.includes('.') : table.startsWith(`${schema}.`)

/**
 * The DML privileges one GRANT/REVOKE moves — empty when the statement is not about a
 * table's DML surface at all.
 *
 * The object-type filter is load-bearing and not cosmetic: `REVOKE ALL ON SCHEMA audit
 * FROM anon` and `REVOKE ALL ON TABLE audit.events FROM anon` both reduce to the bare
 * name `audit`/`audit.events` once the schema prefix is handled, and folding a SCHEMA
 * statement into a table's ledger would let a USAGE grant read as a SELECT grant.
 */
function movedPrivileges(entry) {
  if (entry.object === 'FUNCTION' || entry.object === 'SCHEMA') return []
  // `GRANT EXECUTE ON public.f(uuid) TO x` — SQL lets the FUNCTION keyword be omitted,
  // and the argument list is the only thing that distinguishes it from a table name.
  if (entry.object === null && entry.target.includes('(')) return []
  if (entry.privileges.some((p) => p === 'ALL' || p.startsWith('ALL '))) return DML
  return entry.privileges.filter((p) => DML.includes(p))
}

/** Which table(s) one statement's target names — `ALL TABLES IN SCHEMA` fans out. */
function targetTables(entry, tables) {
  if (entry.object !== 'ALL TABLES IN SCHEMA') return [entry.target]
  return [...tables].filter((t) => inSchema(t, entry.target))
}

function move(held, table, role, ops, granting) {
  if (!held.has(table)) held.set(table, new Map())
  const byRole = held.get(table)
  if (!byRole.has(role)) byRole.set(role, new Set())
  const set = byRole.get(role)
  for (const op of ops) {
    if (granting) set.add(op)
    else set.delete(op)
  }
}

/**
 * The privilege each role ends up holding on each table, folded IN STATEMENT ORDER.
 *
 * Order is the whole point. The shipped idiom is `REVOKE ALL … FROM anon, service_role`
 * followed by a narrow `GRANT SELECT, INSERT, UPDATE, DELETE … TO authenticated`, and a
 * set-union reading of those two statements says `anon` holds everything. Replaying them
 * in file order is the only reading that matches what the database will do.
 *
 * Not exported: `knip --strict` refuses a surface with no call site, and the only honest
 * consumer is the closure below. A caller that wants the ledger for its own reason should
 * export it in the commit that first reads it.
 *
 * @param {{kind: string, privileges: string[], object: string|null, target: string, roles: string[]}[]} grants
 * @param {Iterable<string>} tables every table name known to the parse, for the fan-out
 * @returns {Map<string, Map<string, Set<string>>>} table → role → privileges
 */
function foldTableGrants(grants, tables) {
  const held = new Map()
  for (const g of grants) {
    const ops = movedPrivileges(g)
    if (ops.length === 0) continue
    for (const table of targetTables(g, tables)) {
      for (const role of g.roles) move(held, table, role, ops, g.kind === 'GRANT')
    }
  }
  return held
}

function holds(held, table, role, op) {
  const byRole = held.get(table)
  if (byRole === undefined) return false
  // A privilege granted to PUBLIC is held by every role, and no REVOKE from a named role
  // takes it away — the two grants are independent entries in the ACL.
  return (byRole.get(role)?.has(op) ?? false) || (byRole.get(PUBLIC)?.has(op) ?? false)
}

/** A predicate that is literally `false` admits no row, so it needs no privilege. */
function isFalse(clause) {
  if (clause === null || clause === undefined) return false
  return clause.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim().toLowerCase() === 'false'
}

/**
 * Whether a policy is exempt from the closure, and why — the three carve-outs, each of
 * which would otherwise make the gate tell correct code it is wrong.
 */
function skipReason(policy) {
  // 1. DENY-ALL. `WITH CHECK (false)` is the shipped way to say "this role may never
  //    insert here" while still holding SELECT. Requiring an INSERT grant behind it would
  //    demand the tree hand out exactly the privilege the policy exists to refuse.
  if (isFalse(policy.using) || isFalse(policy.check)) return 'deny-all'
  // 2. NO `TO` CLAUSE. The policy applies to PUBLIC, i.e. to whatever roles hold the
  //    privilege — there is no named role to close over, so there is nothing to assert.
  if (policy.roles.length === 0) return 'no-role'
  // 3. RESTRICTIVE. A restrictive policy only ever SUBTRACTS rows; writing one defensively
  //    for a role that holds nothing is coherent. Only a PERMISSIVE policy carries the
  //    claim "this role is expected to reach these rows", which is the claim being closed.
  if (policy.permissive === 'RESTRICTIVE') return 'restrictive'
  return null
}

function explain(role) {
  if (DEFAULT_PRIVILEGE_ROLES.has(role)) {
    return `\`${role}\` holds table privileges in \`public\` by DEFAULT today — Supabase's Data API applies them to every newly created table — so this policy WORKS in the project it was written against and raises 42501 (PostgREST: HTTP 403) in any project created on or after 2026-10-30, when that default stops being applied. The SQL is byte-identical in both. An explicit GRANT is the only form that survives the flip`
  }
  return `\`${role}\` is not one of the roles Supabase's default privileges cover, so it holds NOTHING on this table and never has — every statement it issues raises 42501 (permission denied for table) before row security is ever consulted, which means this policy has not narrowed access, it has never run`
}

/** One policy's claims, appended to `out`. `FOR ALL` is four claims, not one. */
function claimsOf(out, table, declaredOp, list) {
  const ops = declaredOp === 'ALL' ? DML : [declaredOp]
  for (const policy of list) {
    if (skipReason(policy) !== null) continue
    for (const role of policy.roles) {
      for (const op of ops) out.push({ table, role, op, policy: policy.name })
    }
  }
}

/**
 * Every (table, role, operation) some policy CLAIMS is reachable.
 *
 * Flattened out of the judging loop deliberately: the nesting is five deep (table → op →
 * policy → role → op) and the harness holds itself to the same cognitive-complexity ceiling
 * of 15 it holds consumers to. Sorted by table so a finding list is stable across runs —
 * an unordered gate is a gate whose diff nobody can read.
 */
function claimedTriples(policies) {
  const out = []
  for (const [table, byOp] of policies) {
    for (const [declaredOp, list] of byOp) claimsOf(out, table, declaredOp, list)
  }
  return out.sort((a, b) => a.table.localeCompare(b.table))
}

/**
 * Every (table, role, operation) a policy admits but no migration grants.
 *
 * Deduplicated on that triple: two policies naming the same role and operation are one
 * missing grant, and reporting it twice would make the finding count read as a measure of
 * how many policies were written rather than of how many grants are absent.
 *
 * @param {{policies: Map<string, Map<string, object[]>>, grants: object[], tables: Iterable<string>}} input
 * @returns {string[]}
 */
export function policyGrantProblems({ policies, grants, tables }) {
  const held = foldTableGrants(grants, tables)
  const problems = []
  const seen = new Set()
  for (const { table, role, op, policy } of claimedTriples(policies)) {
    const key = `${table}|${role}|${op}`
    if (holds(held, table, role, op) || seen.has(key)) continue
    seen.add(key)
    problems.push(
      `${table}: policy ${policy} admits \`${role}\` FOR ${op}, but no migration GRANTs ${op} on ${table} to it. ${explain(role)}. A policy FILTERS the rows a privilege already reaches; it is never the source of the privilege. Add to a NEW migration: \`GRANT ${op} ON TABLE ${qualify(table)} TO ${role};\``,
    )
  }
  return problems
}

// ---------------------------------------------------------------------------
// THE GRANT BOUND, THE THREE-ROLE REVOKE DOCTRINE, THE GENERATED ASSERTIONS (1.1.0, #74)
// ---------------------------------------------------------------------------
// The closure above folds explicit statements only, and it starts EMPTY, so it never sees
// what Supabase's default privileges hand a role: ALL on every new table in `public`, for
// anon, authenticated and service_role. The 1.0.2 escape was exactly that — a grant wider
// than its policies, which no static check found and a runtime pgTAP assertion caught only
// after the local CLI floated to a stack that applies the default. So a SECOND fold runs
// here, in two halves walked in one pass:
//
//   - DEFAULT-SEEDED: at each CREATE TABLE of a `public` table the table starts with every
//     table privilege for the three roles. This is what the platform hands out, and it is
//     what the BOUND judges: every privilege anon or authenticated holds, directly or
//     through PUBLIC, must be admitted by a policy. They are the two client roles that do
//     not bypass row security. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are never admitted
//     by a policy (row security does not apply to them): they are revoked, or listed with a
//     reason in tools/grant-bound-allow.json.
//   - EXPLICIT: the same table starts with nothing. The DOCTRINE is that the two halves
//     agree for all three roles — the table revoked the default from each, and whatever a
//     role keeps was granted explicitly. That is what keeps service_role to explicit,
//     ADR'd grants without judging those against policies, and it is what lets the
//     generated pgTAP file commit one expectation that holds whether or not the platform
//     applied its default (it stops for projects created on or after 2026-10-30).
//
// AN UPPER BOUND FAILS OPEN WHERE THE CLOSURE FAILS CLOSED: a grant the parse misreads is an
// extra closure finding, but in the bound it HIDES a privilege. So the statement forms
// parseGrants misreads are normalised here (WITH GRANT OPTION, GRANTED BY, CASCADE, GROUP,
// REVOKE GRANT OPTION FOR, column lists, several tables in one statement), a schema-wide
// statement reaches only the tables that exist at that point in the history, and a GRANT or
// REVOKE the parse cannot read at all is reported, never skipped.
//
// Out of scope, and each can only ADD a finding here, never remove one: sequences, custom
// roles and ALTER DEFAULT PRIVILEGES (the bound keeps assuming the platform default), views.
// SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html (the eight table privileges; MAINTAIN is new in 17)
// SOURCE: https://www.postgresql.org/docs/17/sql-revoke.html (a table-level REVOKE also revokes the column privileges)
// SOURCE: https://supabase.com/docs/guides/api (Data API grants and exposed schemas)

/** The roles Supabase's default privileges cover, in the order findings and rows list them. */
const SEEDED_ROLES = ['anon', 'authenticated', 'service_role']

/** The roles that do NOT bypass row security, so a policy is what bounds their privileges. */
const BOUNDED_ROLES = ['anon', 'authenticated']

/** Every table privilege through PostgreSQL 16, in the order the documentation lists them. */
const PRE_17 = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

/** The scaffold's major, and the reading for a tree that does not say: for the bound, more privileges can only mean more findings. */
const DEFAULT_MAJOR = 17

const ALLOW_FILE = 'tools/grant-bound-allow.json'
const DOCTRINE_ADR = 'docs/adr/20260930-three-role-revoke.md'

/** PostgreSQL 17 added MAINTAIN; `has_table_privilege` rejects it on 16 and earlier. */
const tablePrivileges = (major) => (major >= 17 ? [...PRE_17, 'MAINTAIN'] : [...PRE_17])

/**
 * `[db].major_version` from a supabase/config.toml, read the way check-version-sync reads it;
 * null when the file does not say.
 * @param {string} configToml
 * @returns {number | null}
 */
export function postgresMajor(configToml) {
  const m = /^major_version\s*=\s*(\d+)/m.exec(configToml)
  return m === null ? null : Number(m[1])
}

const PRIVILEGE_STATEMENT = /^(?:GRANT|REVOKE)\s[\s\S]*?\sON\s/i
const NOT_A_TABLE =
  /^(?:GRANT|REVOKE)\s[\s\S]*?\sON\s+(?:SEQUENCE|ALL\s+(?:SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES)|FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|DOMAIN|TYPE|LANGUAGE|LARGE\s+OBJECT|FOREIGN|TABLESPACE|PARAMETER)\s/i
const OPTION_ONLY = /^REVOKE\s+GRANT\s+OPTION\s+FOR\s/i

/**
 * The statement with the clauses that change WHO may re-grant (not what is held) read off,
 * so parseGrants sees a plain role list. Without this, `… TO authenticated WITH GRANT OPTION`
 * parses as a grant to one role named `authenticated with grant option`.
 */
const normalised = (stmt) =>
  stmt
    .replace(/\s+(?:CASCADE|RESTRICT)$/i, '')
    .replace(/\s+GRANTED\s+BY\s+\S+$/i, '')
    .replace(/\s+WITH\s+GRANT\s+OPTION$/i, '')
    .replace(/(\s(?:TO|FROM)\s+|,\s*)GROUP\s+/gi, '$1')

/**
 * The privileges one statement moves, each marked when it names a column list. parseGrants
 * splits its privilege list on every comma, a column list's included, so it is re-joined and
 * read at the top level here.
 */
function privilegeItems(entry, privileges) {
  const out = []
  for (const raw of entry.privileges
    .join(',')
    .replace(/\([^)]*\)/g, '(C)')
    .split(',')) {
    const m = /^([A-Z ]+?)\s*(\(C\))?$/.exec(raw.trim())
    if (m === null) continue
    const name = m[1].trim().replace(/ PRIVILEGES$/, '')
    const names = name === 'ALL' ? privileges : privileges.filter((p) => p === name)
    for (const privilege of names) out.push({ privilege, columns: m[2] !== undefined })
  }
  return out
}

/** The tables one statement reaches: several named ones, or a schema's tables as of NOW. */
function targetsOf(entry, fold) {
  const names = entry.target.split(',').map((t) => stripSchema(t.trim()))
  if (entry.object === 'ALL TABLES IN SCHEMA') {
    return [...fold.tables].filter(([, info]) => names.includes(info.schema)).map(([t]) => t)
  }
  return names.filter((t) => fold.tables.has(t))
}

function setOf(byTable, table, role) {
  const byRole = byTable.get(table)
  if (!byRole.has(role)) byRole.set(role, new Set())
  return byRole.get(role)
}

function moveOne(fold, table, role, { privilege, columns }, granting) {
  const onColumns = setOf(fold.columns, table, role)
  if (columns) {
    if (granting) onColumns.add(privilege)
    else onColumns.delete(privilege)
    return
  }
  // A table-level REVOKE also revokes that privilege on every column of the table.
  if (!granting) onColumns.delete(privilege)
  for (const half of [fold.seeded, fold.explicit]) {
    const set = setOf(half, table, role)
    if (granting) set.add(privilege)
    else set.delete(privilege)
  }
}

function applyPrivilegeStatement(fold, stmt) {
  if (NOT_A_TABLE.test(stmt) || OPTION_ONLY.test(stmt)) return
  const [entry] = parseGrants([normalised(stmt)])
  if (entry === undefined) {
    fold.unread.push(
      `the grant bound cannot read \`${stmt}\` — a GRANT or REVOKE it cannot place could hide a privilege, so it is reported rather than skipped. Write it in the plain form: GRANT|REVOKE <privileges> ON [TABLE] <schema>.<table>[, …] TO|FROM <role>[, …]`,
    )
    return
  }
  // A function reached without the FUNCTION keyword carries its argument list in the target.
  if (entry.object === 'FUNCTION' || entry.target.includes('(')) return
  const items = privilegeItems(entry, fold.privileges)
  for (const table of targetsOf(entry, fold)) {
    for (const role of entry.roles) {
      for (const item of items) moveOne(fold, table, role, item, entry.kind === 'GRANT')
    }
  }
}

function addTable(fold, stmt) {
  const [created] = parseCreatedTables([stmt])
  if (created === undefined) return
  const [name, info] = created
  // CREATE TABLE IF NOT EXISTS of a table that exists changes nothing, in the database too.
  if (fold.tables.has(name)) return
  fold.tables.set(name, { qualified: info.qualified, schema: info.schema })
  const seeded = new Map()
  if (info.schema === 'public') {
    for (const role of SEEDED_ROLES) seeded.set(role, new Set(fold.privileges))
  }
  fold.seeded.set(name, seeded)
  fold.explicit.set(name, new Map())
  fold.columns.set(name, new Map())
}

/**
 * Both halves of the privilege fold, walked once in statement order. A DROP TABLE forgets the
 * table (a later CREATE starts it from the default again), and GRANT/REVOKE move both halves
 * alike. Column-level privileges are kept apart: `has_table_privilege` does not see them, so
 * only the bound reads them.
 *
 * @param {string[]} statements the migration history, already split
 * @param {number | null} major `[db].major_version`; null reads as 17
 * @returns {{ major: number, privileges: string[], tables: Map<string, {qualified: string, schema: string}>, seeded: Map<string, Map<string, Set<string>>>, explicit: Map<string, Map<string, Set<string>>>, columns: Map<string, Map<string, Set<string>>>, unread: string[] }}
 */
export function foldPrivileges(statements, major) {
  const m = major ?? DEFAULT_MAJOR
  const fold = {
    major: m,
    privileges: tablePrivileges(m),
    tables: new Map(),
    seeded: new Map(),
    explicit: new Map(),
    columns: new Map(),
    unread: [],
  }
  for (const { stmt, dropped } of withTableDrops(statements)) {
    if (dropped !== null) {
      for (const t of dropped)
        for (const c of [fold.tables, fold.seeded, fold.explicit, fold.columns]) c.delete(t)
    } else if (/^CREATE TABLE /i.test(stmt)) addTable(fold, stmt)
    else if (PRIVILEGE_STATEMENT.test(stmt)) applyPrivilegeStatement(fold, stmt)
  }
  return fold
}

/** Code-unit order, never localeCompare: the rendered bytes must not depend on the machine. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sortedTables = (fold) => [...fold.tables.keys()].sort(byCodeUnit)
const held = (half, table, role) => half.get(table)?.get(role) ?? new Set()

// ── the doctrine ─────────────────────────────────────────────────────────────────────────

/** Every (table, role) whose default-seeded privileges exceed its explicit ones. */
function doctrineGaps(fold) {
  const gaps = []
  for (const table of sortedTables(fold)) {
    for (const role of SEEDED_ROLES) {
      const explicit = held(fold.explicit, table, role)
      const seeded = held(fold.seeded, table, role)
      const extra = fold.privileges.filter((p) => seeded.has(p) && !explicit.has(p))
      if (extra.length === 0) continue
      gaps.push({ table, role, extra, keep: fold.privileges.filter((p) => explicit.has(p)) })
    }
  }
  return gaps
}

function doctrineFix(fold, { table, role, keep }) {
  const q = fold.tables.get(table).qualified
  const grant = keep.length > 0 ? [`GRANT ${keep.join(', ')} ON TABLE ${q} TO ${role};`] : []
  return [`REVOKE ALL ON TABLE ${q} FROM ${role};`, ...grant]
}

/**
 * The doctrine's findings: a role that holds a privilege only because the platform's default
 * put it there. Each prints the REVOKE and GRANT that clear it.
 * @param {ReturnType<typeof foldPrivileges>} fold
 * @returns {string[]}
 */
export function doctrineProblems(fold) {
  return doctrineGaps(fold).map((gap) => {
    const q = fold.tables.get(gap.table).qualified
    const adr =
      gap.role === 'authenticated'
        ? ' A REVOKE from authenticated needs the `-- adr:` marker the `migrations` gate asks for.'
        : ''
    return `${gap.table}: the platform default still reaches \`${gap.role}\` — it holds ${gap.extra.join(', ')} on ${q} only because Supabase's default privileges granted them when the table was created, and no migration revoked them. The doctrine (${DOCTRINE_ADR}) is that every table revokes ALL from anon, authenticated and service_role and then grants exactly what it keeps, so what a role holds does not depend on whether the platform applied its default (a project created on or after 2026-10-30 gets none). Clear it in a NEW migration: ${doctrineFix(fold, gap).join(' ')}${adr}`
  })
}

/**
 * The statements that clear every doctrine finding at once, one per line — what
 * tools/gen-grant-assertions.mjs prints when it refuses, and what a consumer puts in a new
 * migration.
 * @public exported for the harness repo's upgrade sweep (scripts/ci/upgrade-sweep.mjs writes
 * these into a swept install's own migration, as the runbook tells a consumer to) and its
 * gate suite (tests/gates/table-grants.test.mjs)
 * @param {ReturnType<typeof foldPrivileges>} fold
 * @returns {string}
 */
export function doctrineFixSql(fold) {
  return doctrineGaps(fold)
    .flatMap((gap) => doctrineFix(fold, gap))
    .map((line) => `${line}\n`)
    .join('')
}

// ── the bound ────────────────────────────────────────────────────────────────────────────

const allowKey = (table, role, privilege) => `${table}|${role}|${privilege}`

/** A policy that admits `role` to `privilege`: PERMISSIVE, that operation or ALL, the role, public or no role, and not literally false. */
function admittedBy(policies, table, role, privilege) {
  if (!DML.includes(privilege)) return false
  const byOp = policies.get(table)
  if (byOp === undefined) return false
  return [...(byOp.get(privilege) ?? []), ...(byOp.get('ALL') ?? [])].some(
    (p) =>
      p.permissive !== 'RESTRICTIVE' &&
      !isFalse(p.using) &&
      !isFalse(p.check) &&
      (p.roles.length === 0 || p.roles.includes(role) || p.roles.includes(PUBLIC)),
  )
}

/** What one bounded role holds on one table, per privilege and by which route. */
function holdings(fold, table, role) {
  const direct = held(fold.seeded, table, role)
  const viaPublic = held(fold.seeded, table, PUBLIC)
  const onColumns = held(fold.columns, table, role)
  const publicColumns = held(fold.columns, table, PUBLIC)
  return fold.privileges
    .map((p) => ({
      p,
      direct: direct.has(p) || onColumns.has(p),
      viaPublic: viaPublic.has(p) || publicColumns.has(p),
      tableLevel: direct.has(p) || viaPublic.has(p),
    }))
    .filter((h) => h.direct || h.viaPublic)
}

function boundFinding(fold, table, role, wide, keep) {
  const q = fold.tables.get(table).qualified
  const allPublic = wide.every((h) => h.viaPublic && !h.direct)
  const label = (h) => {
    if (!h.tableLevel) return `${h.p} (on columns)`
    return h.viaPublic && !h.direct && !allPublic ? `${h.p} (through PUBLIC)` : h.p
  }
  const from = [
    ...(wide.some((h) => h.direct) ? [role] : []),
    ...(wide.some((h) => h.viaPublic) ? ['PUBLIC'] : []),
  ]
  const fix = [
    ...from.map((r) => `REVOKE ALL ON TABLE ${q} FROM ${r};`),
    ...(keep.length > 0 ? [`GRANT ${keep.join(', ')} ON TABLE ${q} TO ${role};`] : []),
  ].join(' ')
  const publicNote = from.includes('PUBLIC')
    ? ' A REVOKE from PUBLIC also takes the privilege from every other role that held it only through PUBLIC: grant each what its policies admit.'
    : ''
  return `${table}: \`${role}\` holds ${wide.map(label).join(', ')} on ${q}${allPublic ? ' (through PUBLIC)' : ''}, which no policy admits — a grant wider than the table's policies. A DML privilege is admitted by a PERMISSIVE policy FOR that operation (or ALL) naming \`${role}\`, public or no role, whose predicate is not literally false; TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are never admitted, because row security does not apply to them. Clear it in a NEW migration: ${fix}${publicNote} Or (a human decision) list each (table, role, privilege) with a reason in ${ALLOW_FILE}.`
}

function staleAllowRows(fold, policies, allow) {
  const out = []
  for (const row of allow.values()) {
    const q = fold.tables.get(row.table)?.qualified ?? qualify(row.table)
    const holds =
      fold.tables.has(row.table) &&
      holdings(fold, row.table, row.role).some((h) => h.p === row.privilege)
    const where = `${ALLOW_FILE} allows (${row.table}, ${row.role}, ${row.privilege})`
    if (!holds) {
      out.push(
        `${where}, but \`${row.role}\` does not hold ${row.privilege} on ${q} — a stale row allows a grant that no longer exists. Remove it.`,
      )
    } else if (admittedBy(policies, row.table, row.role, row.privilege)) {
      out.push(`${where}, but a policy already admits it — the row allows nothing. Remove it.`)
    }
  }
  return out
}

/**
 * The bound: every privilege anon or authenticated holds in the DEFAULT-SEEDED fold, directly,
 * through PUBLIC or on columns, is admitted by a policy or allowed by a reviewed row. One
 * finding per (table, role), with the exact REVOKE and GRANT that clear it, then one per
 * stale allow row.
 * @param {ReturnType<typeof foldPrivileges>} fold
 * @param {Map<string, Map<string, object[]>>} policies the live policies, table → op → list
 * @param {Map<string, {table: string, role: string, privilege: string}>} allow from grantAllowRows
 * @returns {string[]}
 */
export function grantBoundProblems(fold, policies, allow) {
  const out = []
  for (const table of sortedTables(fold)) {
    for (const role of BOUNDED_ROLES) {
      const all = holdings(fold, table, role)
      const excused = (h) =>
        admittedBy(policies, table, role, h.p) || allow.has(allowKey(table, role, h.p))
      const wide = all.filter((h) => !excused(h))
      if (wide.length === 0) continue
      const keep = all.filter((h) => h.tableLevel && excused(h)).map((h) => h.p)
      out.push(boundFinding(fold, table, role, wide, keep))
    }
  }
  return [...out, ...staleAllowRows(fold, policies, allow)]
}

function allowRow(entry, privileges) {
  if (entry === null || typeof entry !== 'object') return null
  const { table, role, privilege, reason } = entry
  const strings = [table, role, privilege, reason].every((v) => typeof v === 'string')
  if (!strings || reason.trim() === '' || !BOUNDED_ROLES.includes(role)) return null
  const p = privilege.trim().toUpperCase()
  return privileges.includes(p)
    ? { table: stripSchema(table.trim()), role, privilege: p, reason }
    : null
}

/**
 * tools/grant-bound-allow.json, parsed by the caller: `{ "allow": [{ table, role, privilege,
 * reason }] }`, keyed on (table, role, privilege) — two rows for one table must not overwrite
 * each other. Every shape problem is returned for the caller to report; the file is
 * absent-as-empty, which is the caller's to decide.
 * @param {unknown} parsed
 * @param {string[]} privileges the configured major's table privileges
 * @returns {{ rows: Map<string, {table: string, role: string, privilege: string, reason: string}>, problems: string[] }}
 */
export function grantAllowRows(parsed, privileges) {
  const rows = new Map()
  const isObject = parsed !== null && typeof parsed === 'object'
  const list = isObject ? /** @type {{ allow?: unknown }} */ (parsed).allow : undefined
  if (!Array.isArray(list)) {
    const got = isObject ? Object.keys(parsed) : parsed
    return {
      rows,
      problems: [
        `${ALLOW_FILE} must carry an "allow" ARRAY of {table, role, privilege, reason} entries — got ${JSON.stringify(got)}`,
      ],
    }
  }
  const problems = []
  for (const entry of list) {
    const row = allowRow(entry, privileges)
    if (row === null) {
      problems.push(
        `${ALLOW_FILE}: every entry must be {"table": string, "role": "anon" | "authenticated", "privilege": one of ${privileges.join(', ')}, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    } else if (rows.has(allowKey(row.table, row.role, row.privilege))) {
      problems.push(
        `${ALLOW_FILE} names (${row.table}, ${row.role}, ${row.privilege}) twice — one reviewed reason per (table, role, privilege)`,
      )
    } else {
      rows.set(allowKey(row.table, row.role, row.privilege), row)
    }
  }
  return { rows, problems }
}

// ── the generated assertions ─────────────────────────────────────────────────────────────

const GENERATED_FILE = 'supabase/tests/rls_grants.generated.test.sql'

/** One row per (table, role, privilege), from the EXPLICIT fold, PUBLIC counted for every role as has_table_privilege counts it. */
function expectedRows(fold) {
  const rows = []
  for (const table of fold.tables.keys()) {
    const q = fold.tables.get(table).qualified
    const viaPublic = held(fold.explicit, table, PUBLIC)
    for (const role of SEEDED_ROLES) {
      const own = held(fold.explicit, table, role)
      for (const p of fold.privileges) rows.push([q, role, p, own.has(p) || viaPublic.has(p)])
    }
  }
  return rows.sort(
    (a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]) || byCodeUnit(a[2], b[2]),
  )
}

function renderText(fold) {
  const rows = expectedRows(fold)
  const values = rows.map(
    ([t, r, p, e], i) => `    ('${t}', '${r}', '${p}', ${e})${i === rows.length - 1 ? '' : ','}`,
  )
  const n = fold.privileges.length
  return `-- ${GENERATED_FILE} — GENERATED by tools/gen-grant-assertions.mjs.
-- Do not edit it: run \`node tools/gen-grant-assertions.mjs\` (\`pnpm gen\` runs it) and commit
-- the result. schema-rls renders this file in memory and fails when the committed copy is
-- missing or differs, so a table list or a plan() here is never counted by hand.
--
-- What it asserts: for every table a migration creates, and for each of anon,
-- authenticated and service_role, each of the ${n} table privileges of PostgreSQL ${fold.major} is
-- held exactly when the migrations grant it. The expectation is the fold of the EXPLICIT
-- GRANT and REVOKE statements, counting a grant to PUBLIC for every role, as
-- has_table_privilege() does. The generator renders only while every table has revoked the
-- platform default from all three roles, so no row depends on whether Supabase applied its
-- default privileges to a new table:
-- ${DOCTRINE_ADR}
-- Column-level privileges are outside has_table_privilege() and outside this file;
-- schema-rls bounds them statically.
-- SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
-- SOURCE: https://www.postgresql.org/docs/17/functions-info.html

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(1);

SELECT is_empty(
  $$ SELECT e.table_name, e.role_name, e.privilege, e.expected
       FROM (VALUES
${values.join('\n')}
       ) AS e (table_name, role_name, privilege, expected)
      WHERE has_table_privilege(e.role_name::name, e.table_name, e.privilege)
            IS DISTINCT FROM e.expected $$,
  'anon, authenticated and service_role hold exactly the table privileges the migrations grant (PostgreSQL ${fold.major}: ${n} table privileges)'
);

SELECT * FROM finish();

ROLLBACK;
`
}

/**
 * supabase/tests/rls_grants.generated.test.sql for this history, or why it cannot be rendered:
 * a statement the fold could not read, a table that fails the doctrine (named), or no table at
 * all — an empty assertion would pass against any database.
 * @param {ReturnType<typeof foldPrivileges>} fold
 * @returns {{ text: string | null, refusal: string | null }}
 */
export function renderGrantAssertions(fold) {
  if (fold.unread.length > 0) {
    return {
      text: null,
      refusal: `the migration history holds ${fold.unread.length} GRANT or REVOKE statement(s) the fold cannot read, so no expectation rendered from it can be trusted:\n${fold.unread.map((u) => `  - ${u}`).join('\n')}`,
    }
  }
  const failing = [...new Set(doctrineGaps(fold).map((g) => g.table))]
  if (failing.length > 0) {
    return {
      text: null,
      refusal: `${failing.length} table(s) fail the three-role revoke doctrine: ${failing.join(', ')}. While one does, what a role holds on it depends on whether the platform applied its default privileges, so no expectation can be committed for it. Put these statements in a NEW migration (with the \`-- adr:\` marker a revoke from authenticated needs), then run this again:\n${doctrineFixSql(fold)}`,
    }
  }
  if (fold.tables.size === 0) {
    return {
      text: null,
      refusal:
        'no migration creates a table, so there is nothing to assert — an empty assertion file would pass against any database',
    }
  }
  return { text: renderText(fold), refusal: null }
}
