// The RECORDING PORT — the instrument tools/gen-query-shapes.mjs drives the DAL with.
//
// It is harness-owned (gate-integrity hashes it) for the same reason a scale is not
// supplied by the person being weighed: the manifest's whole value is that it is
// DERIVED BY EXECUTION rather than declared. A vertical supplies the drivers (which
// function, which branch, which inputs); this file supplies the observation, and a
// vertical cannot edit what the observation reports.
//
// WHY A PROXY RATHER THAN A HAND-WRITTEN FAKE. A fake implements the methods it knows
// about, so the FIRST thing an unreviewed builder call does is crash — and the obvious
// repair is to add the method to the fake, which silently teaches the instrument to
// ignore it. The proxy records EVERY method by name, including ones no port declares,
// so `.range(...)` / `.offset(...)` (PostgREST's OFFSET pagination) arrive in the
// manifest as `extra` and the gate reds on them by name. An instrument that cannot see
// the thing you are trying to ban is an instrument that certifies its absence.
// SOURCE: https://docs.postgrest.org/en/v12/references/api/pagination_count.html
//
// The recorder resolves every await to `{ data: [], error: null }` — a well-formed
// EMPTY result. Deliberately not an error and deliberately not a row: an error result
// would send each DAL function down its failure branch before it finished building the
// query, and a synthetic row would have to be shaped like the contract, which is a
// second place for the row contract to live.
// SOURCE: docs/harness/README.md (generated artifacts are runtime walks, never source lexes) [corpus: harness/doctrine]

/**
 * The builder methods the shape grammar understands. Anything else a DAL calls lands
 * in `extra` and the `query-shapes` gate reds naming it — so the reviewed set can only
 * grow through this file, which is hashed.
 */
export const KNOWN_METHODS = new Set([
  'delete',
  'eq',
  'gt',
  'gte',
  'insert',
  'is',
  'limit',
  'lt',
  'lte',
  'or',
  'order',
  'select',
  'update',
])

/**
 * Inequalities are recorded as their own class, separate from equalities, because they
 * play a different role in a plan: an equality can sit anywhere in the index prefix, a
 * range can only bound the scan if it is on the FIRST sort column. Collapsing the two
 * would lose the distinction the `query-shapes` gate needs to red a keyset seek whose
 * cursor cannot start the scan anywhere.
 */
const RANGE_METHODS = new Set(['gt', 'gte', 'lt', 'lte'])

/** The one empty, well-formed PostgREST outcome every recorded await resolves to. */
const EMPTY_OUTCOME = Object.freeze({ data: [], error: null })

function makeQuery(chain) {
  const proxy = new Proxy(Object.create(null), {
    get(_target, prop) {
      // `await builder` reads `.then`; it must NOT be recorded as a query operator.
      if (prop === 'then') {
        return (resolve) => {
          resolve(EMPTY_OUTCOME)
        }
      }
      // Symbols reach here from structuredClone/inspect/Promise plumbing. Returning a
      // recording function for them would both corrupt the chain and break `await`.
      if (typeof prop !== 'string') return undefined
      return (...args) => {
        chain.calls.push({ method: prop, args })
        return proxy
      }
    },
  })
  return proxy
}

/**
 * A recording database port plus the chains it captured, in call order.
 * `db` satisfies any DAL written against a PostgREST-shaped client: every method is
 * chainable and every chain is awaitable.
 */
export function createRecorder() {
  const chains = []
  const db = {
    from(table) {
      const chain = { table: String(table), calls: [] }
      chains.push(chain)
      return makeQuery(chain)
    },
  }
  return { chains, db }
}

/**
 * PostgREST filter strings carry literal VALUES (a keyset cursor's timestamp and uuid).
 * Those come from the probe's inputs, so committing them would make the manifest churn
 * on a fixture edit and would put a row's data in a file the whole team reads. The
 * OPERATORS and COLUMNS are the shape; the values are not.
 */
export function normalizeFilter(filter) {
  return filter.replace(/(\.[a-z]+\.)(?:"[^"]*"|[^,()]*)/g, '$1?')
}

/** Columns named by a PostgREST filter string, in order of first appearance. */
export function filterColumns(filter) {
  const seen = []
  for (const m of filter.matchAll(/(?:^|[,(])\s*([a-z_][a-z0-9_]*)\.[a-z]+\./g)) {
    if (!seen.includes(m[1])) seen.push(m[1])
  }
  return seen
}

/**
 * How a shape is BOUNDED, derived from what the DAL actually built — never self-declared.
 * A `kind` a probe could assert would be a promise about the query rather than a
 * property of it, and the promise is the part that stays true after the query changes.
 *
 *   aggregate — the projection is a PostgREST aggregate/head request: it returns one row
 *               by construction, so no LIMIT is required.
 *   single    — LIMIT 1 with no ordering: a point read.
 *   keyset    — ordered AND limited: a page. Whether the cursor SEEK is present is a
 *               branch of the same shape, not a different kind.
 *   write     — insert/update/delete. Bounded by its own equality predicate, which the
 *               gate checks separately.
 *   unbounded — everything else. The gate reds on it; it is the shape that reads every
 *               row a tenant owns and grows without limit forever.
 */
export function boundKind(shape) {
  if (shape.op !== 'select') return 'write'
  if (/\bcount\b|\bsum\(|\bavg\(|\bmin\(|\bmax\(/i.test(shape.columns ?? '')) return 'aggregate'
  if (shape.order.length > 0 && shape.limit !== null) return 'keyset'
  if (shape.limit === 1 && shape.order.length === 0) return 'single'
  return 'unbounded'
}

/**
 * One captured chain -> one shape row. Pure; the CLI supplies identity (vertical, fn, id)
 * and this supplies everything that came from the DAL's own behaviour.
 */
/** Which statement the chain built. A chain carries at most one of these by construction. */
function operationOf(named) {
  for (const write of ['delete', 'insert', 'update']) {
    if (named(write).length > 0) return write
  }
  return 'select'
}

/** Columns named across every `.or()` in the chain, in order of first appearance. */
function orColumnsOf(filters) {
  const out = []
  for (const f of filters) {
    for (const col of filterColumns(f)) if (!out.includes(col)) out.push(col)
  }
  return out
}

export function normalizeChain(chain) {
  const calls = chain.calls
  const named = (name) => calls.filter((c) => c.method === name)
  const op = operationOf(named)

  const selects = named('select')
  const payloadCall = named('insert')[0] ?? named('update')[0]
  const payload =
    payloadCall === undefined ? [] : Object.keys(payloadCall.args[0] ?? {}).sort(codeUnit)

  const orFilters = named('or').map((c) => String(c.args[0] ?? ''))
  const orColumns = orColumnsOf(orFilters)

  const limits = named('limit')
  const shape = {
    columns: selects.length > 0 ? String(selects.at(-1).args[0] ?? '') : null,
    eq: named('eq').map((c) => String(c.args[0])),
    // `.is(col, null)` is an IS NULL predicate; `.is(col, true)` is not, and conflating
    // them would let a boolean filter claim the index treatment a null test gets.
    is: named('is')
      .filter((c) => c.args[1] === null)
      .map((c) => String(c.args[0])),
    limit: limits.length > 0 ? Number(limits.at(-1).args[0]) : null,
    op,
    or: orFilters.length > 0 ? orFilters.map(normalizeFilter).join(' AND ') : null,
    orColumns,
    order: named('order').map((c) => ({
      ascending: Boolean(c.args[1]?.ascending),
      column: String(c.args[0]),
    })),
    payload,
    range: calls
      .filter((c) => RANGE_METHODS.has(c.method))
      .map((c) => ({ column: String(c.args[0]), op: c.method })),
    table: chain.table,
  }
  shape.extra = [...new Set(calls.map((c) => c.method).filter((m) => !KNOWN_METHODS.has(m)))].sort(
    codeUnit,
  )
  shape.kind = boundKind(shape)
  return shape
}

/** Code-unit (locale-independent) string order — see lib/inventory.mjs. */
function codeUnit(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}
