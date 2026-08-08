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
// THE DIRECTION IS ONE-WAY, DELIBERATELY. Policy ⇒ grant is asserted; grant ⇒ policy is
// NOT. `GRANT SELECT, DELETE ON TABLE public.orgs TO service_role` is a legitimate,
// ADR-governed grant with no policy behind it precisely because `service_role` BYPASSES
// row security — a grant⇒policy rule would red the shipped tree for being correct.
//
// PURE — no fs, no process. Callers parse the SQL and own every exit.
// SOURCE: docs/harness/gates-catalog.md (schema-rls)

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
