// Shared reading of tools/generated/query-shapes.json — the manifest the DAL's own
// behaviour writes (tools/gen-query-shapes.mjs). Two consumers, and they MUST agree:
//
//   tools/check-query-shapes.mjs  — static: an index exists that serves each shape.
//   tools/check-db-perf.mjs       — live: the planner actually CHOOSES it at scale.
//
// The agreement is the point. If the static gate resolved one index and the plan probe
// asserted another, a passing pair would prove nothing about either — so index
// resolution and SQL synthesis both live here, once.
// SOURCE: docs/harness/gates-catalog.md (query-shapes / db-perf) [corpus: harness/doctrine]
import { existsSync, readdirSync } from 'node:fs'

/**
 * Probe modules are found BY CONVENTION, never by a registry file. A registry is one
 * more place a vertical can be omitted from, and omission is the failure mode this
 * whole artifact exists to make impossible.
 *
 * It lives HERE, not in the generator, because a THIRD consumer needs the same answer
 * for a different reason: `check-query-shapes` has to tell "this DAL was never
 * instrumented" (a pre-0.2.0 install, ramped) apart from "it was instrumented and the
 * manifest is empty" (tampering, fatal). If the gate re-derived the convention it would
 * be free to disagree with the generator, and the two verdicts that must never diverge
 * are exactly "there is nothing to record" and "there is something and it is missing".
 */
const PROBE_PATH = ['src', 'data', 'query-probes.ts'].join('/')
const VERTICALS_ROOT = 'packages/verticals'

export function probeModules() {
  if (!existsSync(VERTICALS_ROOT)) return []
  const found = []
  for (const dir of readdirSync(VERTICALS_ROOT).sort()) {
    const rel = `${VERTICALS_ROOT}/${dir}/${PROBE_PATH}`
    if (existsSync(rel)) found.push({ path: rel, vertical: dir })
  }
  return found
}

/** A JSON array whose every element is a string. */
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Fields every manifest row must carry, with the type each must have. */
const ROW_SHAPE = {
  columns: (v) => v === null || typeof v === 'string',
  eq: Array.isArray,
  extra: Array.isArray,
  fn: (v) => typeof v === 'string',
  id: (v) => typeof v === 'string' && v.length > 0,
  is: Array.isArray,
  kind: (v) => typeof v === 'string',
  limit: (v) => v === null || Number.isInteger(v),
  op: (v) => ['delete', 'insert', 'rpc', 'select', 'update', 'upsert'].includes(v),
  or: (v) => v === null || typeof v === 'string',
  orColumns: Array.isArray,
  order: Array.isArray,
  payload: Array.isArray,
  range: Array.isArray,
  // An rpc names a function, not a table (see OP_SHAPE below).
  table: (v, row) => (row.op === 'rpc' ? v === null : typeof v === 'string' && v.length > 0),
  vertical: (v) => typeof v === 'string',
}

/**
 * The one key each of the two 1.1.0 ops adds, required on that op (the recorder writes it on
 * no other row, so a 1.0.x manifest parses unchanged). An rpc row with no `rpc`, or an upsert
 * row with no `onConflict`, fails closed: without it the gate would judge a call whose target
 * it cannot name.
 *   rpc        — { name, args }: the function name, and the sorted argument names.
 *   onConflict — the sorted conflict columns, or null for the primary key.
 */
const OP_SHAPE = {
  rpc: {
    rpc: (v) =>
      v !== null &&
      typeof v === 'object' &&
      typeof v.name === 'string' &&
      v.name.length > 0 &&
      stringList(v.args),
  },
  upsert: { onConflict: (v) => v === null || stringList(v) },
}
const opShapeOf = (op) =>
  typeof op === 'string' && Object.hasOwn(OP_SHAPE, op) ? OP_SHAPE[op] : {}

/**
 * Parse and structurally validate the manifest. Throws with a precise reason on
 * anything malformed — the file is generated and write-guard-protected, so a manifest
 * that does not parse is tampering or a broken generator, never a project that has not
 * got round to it yet.
 */
export function parseShapes(text) {
  let rows
  try {
    rows = JSON.parse(text)
  } catch (e) {
    throw new Error(`not valid JSON (${e.message})`)
  }
  if (!Array.isArray(rows)) throw new Error('must be a JSON ARRAY of shape rows')
  for (const [i, row] of rows.entries()) {
    if (row === null || typeof row !== 'object')
      throw new Error(`row ${String(i)} is not an object`)
    for (const [key, valid] of Object.entries({ ...ROW_SHAPE, ...opShapeOf(row.op) })) {
      if (!valid(row[key], row)) {
        throw new Error(`row ${String(i)} (${String(row.id ?? '?')}): bad or missing "${key}"`)
      }
    }
  }
  return rows
}

/**
 * Does `index` serve `shape` — filter, sort and direction together?
 *
 * The rule is a PREFIX rule, and it is the whole reason the manifest records ordering
 * rather than just columns. An index whose leading columns are the equality set makes
 * the WHERE clause an Index Cond; an index that ALSO carries the ORDER BY columns, in
 * order, immediately after them makes the sort disappear. An index with the right
 * columns in the wrong positions serves the filter and then sorts the result — which is
 * fast on a seeded test database and a table scan plus an external merge sort in
 * production.
 *
 * DIRECTION IS ALL-OR-NOTHING. PostgreSQL can walk a btree backwards, so
 * `(org_id, created_at DESC, id DESC)` serves `ORDER BY created_at DESC, id DESC`
 * (forward) and `ORDER BY created_at ASC, id ASC` (backward) equally. It does NOT serve
 * a MIXED order — `created_at DESC, id ASC` needs its own index — because a single
 * scan direction cannot reverse one column and not the next.
 * SOURCE: https://www.postgresql.org/docs/17/indexes-ordering.html
 */
export function indexServes(shape, index) {
  const eq = shape.eq
  const cols = index.columns
  if (cols.length < eq.length + shape.order.length) return null
  const head = cols.slice(0, eq.length).map((c) => c.name)
  // Equality columns may sit in any order in the index prefix: `a = $1 AND b = $2` is
  // served identically by (a, b, …) and (b, a, …). Joined on NUL, which cannot appear
  // in a PostgreSQL identifier, so no column name can forge a separator and collide two
  // different key sets into one string. Written as the ESCAPE `\u0000`, never as a literal
  // NUL byte: a raw NUL makes the whole file `data` rather than text, and grep then skips
  // it in SILENCE — this file was invisible to `grep -r` until that was fixed.
  if (
    head.length !== eq.length ||
    [...eq].sort().join('\u0000') !== [...head].sort().join('\u0000')
  )
    return null
  if (shape.order.length === 0) return 'forward'
  let forward = true
  let backward = true
  for (const [i, want] of shape.order.entries()) {
    const got = cols[eq.length + i]
    if (got.name !== want.column) return null
    if (want.ascending === got.desc) forward = false
    else backward = false
  }
  return forward ? 'forward' : backward ? 'backward' : null
}

/**
 * The index that serves `shape`, or null. Deterministic: shortest first (the narrowest
 * index that does the job is the one the planner is likeliest to pick and the one whose
 * name the plan probe should assert), then by name.
 */
export function resolveIndex(shape, indexes) {
  const candidates = indexes
    .filter((idx) => idx.table === shape.table)
    .map((idx) => ({ direction: indexServes(shape, idx), index: idx }))
    .filter((c) => c.direction !== null)
    .sort(
      (a, b) =>
        a.index.columns.length - b.index.columns.length || (a.index.name < b.index.name ? -1 : 1),
    )
  return candidates[0] ?? null
}

// ---- PostgREST filter -> SQL ----------------------------------------------------
// The `or(...)` a keyset seek builds is PostgREST's logical grammar, not SQL, and the
// plan probe has to run the SAME predicate the app sends or it is EXPLAINing a
// different, easier query. This parser is deliberately TOTAL and fail-closed: anything
// it does not recognize throws rather than being dropped, because a silently dropped
// disjunct turns a two-branch seek into a one-branch range scan that plans beautifully.
// SOURCE: https://docs.postgrest.org/en/v12/references/api/tables_views.html#logical-operators

const OPERATORS = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=', neq: '<>' }

/** Split on commas that are not inside parentheses. */
function splitTop(text) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

function filterTerm(term, emit) {
  const group = term.match(/^(and|or)\s*\((.*)\)$/is)
  if (group !== null) {
    const joiner = group[1].toLowerCase() === 'and' ? ' AND ' : ' OR '
    return `(${splitTop(group[2])
      .map((t) => filterTerm(t, emit))
      .join(joiner)})`
  }
  const leaf = term.match(/^([a-z_][a-z0-9_]*)\.([a-z]+)\.(.*)$/is)
  if (leaf === null) throw new Error(`unparseable PostgREST filter term: ${term}`)
  const [, column, op, value] = leaf
  if (op === 'is') {
    if (value.toLowerCase() !== 'null') throw new Error(`unsupported is-filter value: ${value}`)
    return `"${column}" IS NULL`
  }
  const sqlOp = OPERATORS[op.toLowerCase()]
  if (sqlOp === undefined) throw new Error(`unsupported PostgREST operator: ${op}`)
  return `"${column}" ${sqlOp} ${emit(column)}`
}

/**
 * A normalized filter string (values already replaced by `?`) as a SQL boolean, with
 * `emit(column)` supplying a placeholder per value in left-to-right order. The top level
 * of a PostgREST `.or(a,b)` is a disjunction.
 */
function filterToSql(filter, emit) {
  return `(${splitTop(filter)
    .map((t) => filterTerm(t, emit))
    .join(' OR ')})`
}

/**
 * The SQL statement a SELECT shape describes, as `{ text, columns }` — `columns` names
 * the value each `$n` placeholder needs, in order, so the caller can bind them from a
 * live database rather than from a fixture. Only SELECT shapes are synthesized: an
 * INSERT/UPDATE/DELETE probe would WRITE, and a gate that mutates the database it is
 * measuring is a gate nobody can run twice.
 */
export function selectSql(shape) {
  if (shape.op !== 'select') throw new Error(`selectSql: ${shape.id} is a ${shape.op}, not a read`)
  const params = []
  const bind = (column) => {
    params.push(column)
    return `$${String(params.length)}`
  }
  const where = shape.eq.map((c) => `"${c}" = ${bind(c)}`)
  for (const r of shape.range) {
    const op = OPERATORS[r.op]
    if (op === undefined) throw new Error(`unsupported range operator: ${r.op}`)
    where.push(`"${r.column}" ${op} ${bind(r.column)}`)
  }
  for (const c of shape.is) where.push(`"${c}" IS NULL`)
  if (shape.or !== null) {
    // The generator joins multiple .or() calls with ' AND ' — PostgREST ANDs successive
    // top-level filters, so each parenthesized disjunction is its own conjunct.
    for (const part of shape.or.split(' AND ')) where.push(filterToSql(part, bind))
  }
  const order = shape.order.map((o) => `"${o.column}" ${o.ascending ? 'ASC' : 'DESC'}`)
  const projection = (shape.columns ?? '*')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .map((c) => `"${c}"`)
    .join(', ')
  const text = [
    `SELECT ${projection === '' ? '*' : projection}`,
    `FROM public."${shape.table}"`,
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    order.length > 0 ? `ORDER BY ${order.join(', ')}` : '',
    shape.limit === null ? '' : `LIMIT ${String(shape.limit)}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { columns: params, text }
}
