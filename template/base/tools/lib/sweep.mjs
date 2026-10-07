// tools/lib/sweep.mjs — the duplication sweep: every registered family over one index of the
// tree, as one deterministic document (2.1.0, #186). `check-duplication.mjs --sweep --json`
// prints it and `--explain '<key12>'` reads one record of it. It decides no verdict: every
// record's `status` is `advisory` until the exact rule goes live (#201), and the tier the
// rule would give rides as `facts.tier`.
//
// THE FAMILIES (v2 §2.4). One index, built once: shapes.mjs's callables, importers.mjs's
// importer index, and the rule files home() judges legality by.
//   - exact: equal `alpha`, 2 or more members, at least FLOOR tokens, not data-shaped, and a
//     home other than NONE. Tier `owed`.
//   - exact-nohome: the same with home NONE. Tier `advisory`, never owed: the gate must not
//     demand a move its own machine knows is illegal.
//   - exact-small: equal `lit` (the literals equal too), SMALL_FLOOR <= tokens < FLOOR.
//     Advisory. Its fingerprint is the `lit` hash; the verbatim stream it hashes, and so
//     every literal, is never printed.
//   - near-miss: a pair, never a class (the relation is not transitive). An LSH prefilter
//     over the MinHash signatures (NEAR_MISS.bands bands of NEAR_MISS.rows rows; a bucket
//     of more than NEAR_MISS.idiom members is an idiom and is not paired), then the pair is
//     verified: Jaccard of the shingle sets at least NEAR_MISS.jaccard, equal arity, both
//     sides at least NEAR_MISS.tokens tokens and NEAR_MISS.stmts statements, RNR at least
//     NEAR_MISS.rnr, neither data-shaped nor mostly JSX. Advisory, with "differs at" facts
//     (lib/differs.mjs).
//   - the six complexity families (lib/complexity.mjs), advisory and never owed.
// The constants are PROVISIONAL: the exact rule's gate-proposal freezes them after eval A's
// development split (#188, #194), and TOKEN_CONVENTION is frozen with FLOOR.
//
// LITERAL PARAMETERS. When an exact class's members differ in their literals, `params`
// counts the differing literal positions and the move reads "with N literal parameters":
// importing one copy where another said something different is the silent behaviour change
// the count exists to prevent, so IMPORT is only offered when the literals are equal.
//
// RANKING (v2 §2.4): owed before advisory, then cross-workspace spread, member count,
// tokens, fingerprint. The document itself is sorted by key.
//
// COMPLETENESS. A leg is complete only when it ran to its end and every record it built
// passed the closed schema. With no parser the TS legs are written incomplete and the
// sweep reports the missing prerequisite; the SQL legs still run.
//
// DETERMINISM. The document holds no timestamp, absolute path, hostname or environment
// value; paths are repository-relative POSIX; every sort is explicit and compares code
// units, never a locale.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { COMPLEXITY_FAMILIES, complexityHits } from './complexity.mjs'
import { differsAt } from './differs.mjs'
import {
  dottedCallee,
  enumOf,
  key12,
  path,
  renderDiffersAt,
  sqlName,
  subjectId,
  symbol,
  UNPRINTABLE,
} from './closed-text.mjs'
import { advisoryKey, advisoryRecordOk, noteMissingPrerequisite } from './gate.mjs'
import { home, loadForbidden } from './homes.mjs'
import { loadParser } from './i18n-tree.mjs'
import { buildImporters } from './importers.mjs'
import { extractorDigest, extractTree } from './shapes.mjs'
import { readCensus } from './workspace-tiers.mjs'

/** @typedef {import('./shapes.mjs').Callable} Callable */

/** The exact rule's token floor (provisional). */
export const FLOOR = 30
/** Where the exact-small band starts (provisional). */
export const SMALL_FLOOR = 20
/** The near-miss thresholds (provisional). */
export const NEAR_MISS = Object.freeze({
  jaccard: 0.8,
  tokens: 30,
  stmts: 2,
  rnr: 0.5,
  jsxShare: 0.5,
  bands: 16,
  rows: 4,
  idiom: 50,
})

const PRODUCER = 'duplication'
const EXACT_RULES = ['exact', 'exact-small', 'exact-nohome']

/**
 * @typedef {{ v: number, producer: string, rule: string, status: string, subject: string,
 *   fp: string, counts: Record<string, number>, facts: Record<string, any> }} SweepRecord
 * @typedef {{ ts: any, files: import('./shapes.mjs').TsFile[], callables: Callable[],
 *   importers: any, homes: import('./homes.mjs').HomeContext }} SweepIndex
 * @typedef {{ producer: string, leg: string, rules: readonly string[], parser: boolean,
 *   records: (index: SweepIndex) => any[] }} SweepFamily
 */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sha = (text) => createHash('sha256').update(text).digest('hex')

/** Groups of two or more by a key, each sorted by path then line. */
function classesBy(items, keyOf) {
  const by = new Map()
  for (const c of items) by.set(keyOf(c), [...(by.get(keyOf(c)) ?? []), c])
  return [...by.values()]
    .filter((m) => m.length >= 2)
    .map((m) => m.sort((a, b) => cmp(a.path, b.path) || a.line - b.line))
}

/** One member as a fact: where it is and what it is called. */
const member = (c) => ({ path: c.path, line: c.line, name: c.name })

const workspaceCount = (members) => new Set(members.map((c) => c.workspace.name)).size

/** The literal positions at which a class's members differ. */
function literalParams(members) {
  const n = members[0].literals.length
  let differing = 0
  for (let i = 0; i < n; i += 1) {
    if (new Set(members.map((c) => c.literals[i])).size > 1) differing += 1
  }
  return differing
}

// ---- the exact families ---------------------------------------------------------------

function exactRecord(index, lang, members) {
  const litEqual = new Set(members.map((c) => c.lit)).size === 1
  const params = literalParams(members)
  const where = home({ lang, members, litEqual }, index.homes)
  const rule = where.kind === 'none' ? 'exact-nohome' : 'exact'
  const fp = members[0].alpha
  return {
    v: 1,
    producer: PRODUCER,
    rule,
    status: 'advisory',
    subject: fp,
    fp,
    counts: { members: members.length, workspaces: workspaceCount(members), tokens: members[0].tokens, params },
    facts: {
      tier: rule === 'exact' ? 'owed' : 'advisory',
      lang,
      home: where.kind,
      ...(where.target === null ? {} : { target: member(where.target) }),
      members: members.map(member),
    },
  }
}

function smallRecord(lang, members) {
  const fp = members[0].lit
  return {
    v: 1,
    producer: PRODUCER,
    rule: 'exact-small',
    status: 'advisory',
    subject: fp,
    fp,
    counts: { members: members.length, workspaces: workspaceCount(members), tokens: members[0].tokens, params: 0 },
    facts: { tier: 'advisory', lang, members: members.map(member) },
  }
}

/** exact, exact-nohome and exact-small over one language's callables. */
function exactRecords(index, lang) {
  const pool = index.callables.filter((c) => c.lang === lang && c.tokens >= SMALL_FLOOR)
  const out = []
  for (const members of classesBy(pool, (c) => c.alpha)) {
    if (members[0].tokens < FLOOR) {
      for (const same of classesBy(members, (c) => c.lit)) out.push(smallRecord(lang, same))
    } else if (!members[0].dataShaped) {
      // One stream, so one verdict: a data-shaped class is never owed, and never listed.
      out.push(exactRecord(index, lang, members))
    }
  }
  return out
}

// ---- near-miss ------------------------------------------------------------------------

const eligible = (c) =>
  c.tokens >= NEAR_MISS.tokens &&
  c.stmts >= NEAR_MISS.stmts &&
  c.rnr >= NEAR_MISS.rnr &&
  !c.dataShaped &&
  c.jsxShare <= NEAR_MISS.jsxShare

/** Candidate pairs (indices into pool, i < j) from the LSH buckets, idiom buckets skipped. */
function candidatePairs(pool) {
  const buckets = new Map()
  for (const [i, c] of pool.entries()) {
    for (let band = 0; band < NEAR_MISS.bands; band += 1) {
      const rows = c.mh.slice(band * NEAR_MISS.rows, (band + 1) * NEAR_MISS.rows).join(',')
      const key = `${String(band)}:${rows}`
      buckets.set(key, [...(buckets.get(key) ?? []), i])
    }
  }
  const pairs = new Set()
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > NEAR_MISS.idiom) continue
    for (let x = 0; x < bucket.length; x += 1) {
      for (let y = x + 1; y < bucket.length; y += 1) pairs.add(`${String(bucket[x])},${String(bucket[y])}`)
    }
  }
  return [...pairs].map((p) => p.split(',').map(Number))
}

function jaccard(a, b) {
  let both = 0
  for (const s of a) if (b.has(s)) both += 1
  const either = a.size + b.size - both
  return either === 0 ? 0 : both / either
}

function nearMissRecord(index, x, y, j) {
  const [a, b] = [x, y].sort((p, q) => cmp(p.subject, q.subject))
  return {
    v: 1,
    producer: PRODUCER,
    rule: 'near-miss',
    status: 'advisory',
    subject: `${a.subject} ${b.subject}`,
    fp: sha(`${a.alpha} ${b.alpha}`).slice(0, 12),
    counts: { members: 2, workspaces: workspaceCount([a, b]), tokens: Math.min(a.tokens, b.tokens) },
    facts: {
      tier: 'advisory',
      lang: a.lang,
      jaccard: Math.floor(j * 100) / 100,
      members: [member(a), member(b)],
      ...differsAt(index.ts, a, b),
    },
  }
}

/** Verified near-miss pairs over one language's callables. */
function nearMissRecords(index, lang) {
  const pool = index.callables.filter((c) => c.lang === lang && eligible(c))
  const out = []
  for (const [i, k] of candidatePairs(pool)) {
    const a = pool[i]
    const b = pool[k]
    if (a.alpha === b.alpha || a.arity !== b.arity) continue
    const j = jaccard(a.shingles, b.shingles)
    if (j >= NEAR_MISS.jaccard) out.push(nearMissRecord(index, a, b, j))
  }
  return out
}

// ---- complexity -----------------------------------------------------------------------

function complexityRecords(index) {
  return complexityHits(index.ts, index.files, index.importers).map((h) => ({
    v: 1,
    producer: PRODUCER,
    rule: h.family,
    status: 'advisory',
    subject: h.subject,
    fp: h.fp,
    counts: { tokens: h.tokens },
    facts: { tier: 'advisory', member: { path: h.path, line: h.line, name: h.name }, ...h.facts },
  }))
}

// ---- the registry ---------------------------------------------------------------------

/**
 * Every family the sweep runs, as legs: one pure function each, returning records. A later
 * family (#189, #196, #197, #198) registers here under its own producer.
 * @type {readonly SweepFamily[]}
 */
export const SWEEP_FAMILIES = Object.freeze([
  { producer: PRODUCER, leg: 'exact-sql', rules: EXACT_RULES, parser: false, records: (ix) => exactRecords(ix, 'sql') },
  { producer: PRODUCER, leg: 'exact-ts', rules: EXACT_RULES, parser: true, records: (ix) => exactRecords(ix, 'ts') },
  { producer: PRODUCER, leg: 'near-miss-sql', rules: ['near-miss'], parser: false, records: (ix) => nearMissRecords(ix, 'sql') },
  { producer: PRODUCER, leg: 'near-miss-ts', rules: ['near-miss'], parser: true, records: (ix) => nearMissRecords(ix, 'ts') },
  { producer: PRODUCER, leg: 'complexity', rules: COMPLEXITY_FAMILIES, parser: true, records: complexityRecords },
])

/**
 * The ranking order: owed before advisory, then cross-workspace spread, member count,
 * tokens (each descending), then fingerprint.
 * @param {SweepRecord} a @param {SweepRecord} b
 */
export function byRank(a, b) {
  const owed = (r) => (r.facts.tier === 'owed' ? 0 : 1)
  return (
    owed(a) - owed(b) ||
    (b.counts.workspaces ?? 1) - (a.counts.workspaces ?? 1) ||
    (b.counts.members ?? 1) - (a.counts.members ?? 1) ||
    (b.counts.tokens ?? 0) - (a.counts.tokens ?? 0) ||
    cmp(a.fp, b.fp)
  )
}

/** Build the index the legs read. `ts` null builds the SQL half only. */
function buildIndex(ts) {
  const { files, callables } = extractTree(ts)
  const importers = buildImporters()
  return { ts, files, callables, importers, homes: { importers, census: readCensus(), forbidden: loadForbidden() } }
}

/** Run one leg: its records when it completes, nothing and incomplete when it cannot. */
function runLeg(family, index) {
  if (family.parser && index.ts === null) return { complete: false, records: [] }
  try {
    const built = family.records(index)
    const records = built.filter((r) => advisoryRecordOk(r))
    return { complete: records.length === built.length, records }
  } catch {
    return { complete: false, records: [] }
  }
}

/**
 * The sweep document: every leg's terminator and every record, each validated against the
 * closed schema (lib/gate.mjs advisoryRecordOk; one that fails is dropped and leaves its leg
 * incomplete), sorted by key.
 * @param {any} ts the parser, or null
 */
export function sweep(ts) {
  const index = buildIndex(ts)
  const legs = []
  const records = []
  for (const family of SWEEP_FAMILIES) {
    const run = runLeg(family, index)
    legs.push({ producer: family.producer, leg: family.leg, complete: run.complete })
    records.push(...run.records)
  }
  const keyed = records.map((r) => ({ key: advisoryKey(r), r })).sort((a, b) => cmp(a.key, b.key))
  return {
    v: 1,
    x: extractorDigest(ts),
    legs,
    records: keyed.map(({ r }) => r),
    complete: legs.every((l) => l.complete),
  }
}

// ---- --explain ------------------------------------------------------------------------
// One record, through the closed printers of lib/closed-text.mjs and a fixed vocabulary:
// nothing the tree's authors wrote is printed outside a code span, so the output carries no
// `@`, `#` + digit or `<` outside one.

const KEY12 = /^[0-9a-f]{12}$/
const STATUS_TEXT = { advisory: 'advisory (no verdict)', 'ramp-withheld': 'withheld', blocking: 'blocking' }
const TIER = enumOf(['owed', 'advisory'])

/** A member's place, `path:line`, in one code span; a name through its printer. */
function place(m) {
  return path.ok(m?.path) && Number.isInteger(m?.line) ? `\`${m.path}:${String(m.line)}\`` : UNPRINTABLE
}
const nameOf = (m) => (sqlName.ok(m?.name) ? sqlName.print(m.name) : dottedCallee.print(m?.name))
const memberText = (m) => `${place(m)} ${nameOf(m)}`

/** One fact value through the first printer that admits it; containers recursively. */
function factValue(v) {
  if (Array.isArray(v)) return v.length === 0 ? 'none' : v.map(factValue).join(', ')
  if (v !== null && typeof v === 'object') {
    return `(${Object.entries(v)
      .map(([k, x]) => `${symbol.ok(k) ? k : UNPRINTABLE} ${factValue(x)}`)
      .join(', ')})`
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const printer = [symbol, dottedCallee, sqlName, path].find((p) => p.ok(v))
  return printer === undefined ? UNPRINTABLE : printer.print(v)
}

const HOME_TEXT = {
  import: 'IMPORT',
  module: 'MODULE',
  lift: 'LIFT',
  none: 'NONE',
}

/** The move a home asks for, in the fixed vocabulary, with its literal parameters. */
function moveText(r) {
  const { home: kind, lang, target } = r.facts
  const params = r.counts.params ?? 0
  const withParams = params > 0 ? ` with ${String(params)} literal parameter${params === 1 ? '' : 's'}` : ''
  if (kind === 'import') {
    return `import ${nameOf(target)} from ${place(target)} in every other member's file, and delete their copies`
  }
  if (kind === 'module' && lang === 'sql') {
    return `one function in schema \`private\`, added by a forward migration, called by every member${withParams}`
  }
  if (kind === 'module') return `one new module in this workspace, called by every member${withParams}`
  if (kind === 'lift') return `a new package under \`packages/shared/\` that every member imports${withParams}`
  return 'none: no module every member may import exists or may be created, so this stays advisory'
}

const SHOWN = new Set(['tier', 'home', 'target', 'members', 'member', 'arms', 'lang'])

/**
 * The --explain text of one record.
 * @param {SweepRecord} r
 * @returns {string}
 */
export function explainRecord(r) {
  const key = advisoryKey(r).slice(0, 12)
  const lines = [
    `${r.producer}: ${r.rule} ${key12.print(key)} · ${STATUS_TEXT[r.status] ?? UNPRINTABLE} · tier ${TIER.print(r.facts.tier)}`,
    `subject    ${r.subject.split(' ').map((id) => subjectId.print(id)).join(' and ')}`,
  ]
  const members = r.facts.members ?? (r.facts.member === undefined ? [] : [r.facts.member])
  for (const m of members) lines.push(`member     ${memberText(m)}`)
  if (r.facts.home !== undefined) {
    lines.push(`home       ${HOME_TEXT[r.facts.home] ?? UNPRINTABLE}`, `move       ${moveText(r)}`)
  }
  if (r.facts.arms !== undefined) lines.push(renderDiffersAt(r.facts))
  const counts = Object.entries(r.counts).map(([k, n]) => `${k} ${String(n)}`)
  const facts = Object.entries(r.facts)
    .filter(([k]) => !SHOWN.has(k))
    .map(([k, v]) => `${k} ${factValue(v)}`)
  lines.push(`facts      ${[...counts, ...facts].join(' · ')}`)
  return lines.join('\n')
}

/** @param {any} ts */
function explainMain(ts, arg) {
  if (typeof arg !== 'string' || !KEY12.test(arg)) {
    console.error(`${PRODUCER}: --explain takes one key12, the 12 hex digits a NOTE or an issue prints`)
    return 1
  }
  const doc = sweep(ts)
  const found = doc.records.filter((r) => advisoryKey(r).startsWith(arg)).sort(byRank)
  if (found.length === 0) {
    const partial = doc.complete ? '' : ' (the sweep was incomplete, so a record may be missing)'
    console.error(`${PRODUCER}: no record has the key ${key12.print(arg)}${partial}`)
    return 1
  }
  console.log(found.map(explainRecord).join('\n\n'))
  return 0
}

/**
 * The duplication gate's read modes: `--sweep --json` prints the document and exits 0 only
 * when every leg completed; `--explain '<key12>'` prints one record and exits 0 only when it
 * is found. With no parser the TS legs are incomplete and the missing prerequisite is
 * recorded.
 * @param {string[]} argv @param {() => Promise<unknown>} [load] the parser's loader
 * @returns {Promise<number>} the exit code
 */
export async function sweepMain(argv, load) {
  const ts = await loadParser(load)
  if (ts === null) {
    noteMissingPrerequisite(PRODUCER, 'typescript could not be loaded, so the sweep\'s TS legs did not run')
  }
  const at = argv.indexOf('--explain')
  if (at !== -1) return explainMain(ts, argv[at + 1])
  if (!argv.includes('--json')) {
    console.error(`${PRODUCER}: --sweep prints one JSON document; run it as --sweep --json`)
    return 1
  }
  const doc = sweep(ts)
  process.stdout.write(`${JSON.stringify(doc)}\n`)
  return doc.complete ? 0 : 1
}
