// tools/lib/duplication-allow.mjs — the one reader of tools/duplication-allow.json (#175).
// The register keeps its shape, `{ "comment": …, "allow": [ … ] }`, and each entry is one of
// four kinds (SINGLE-HOME §2.4, v2 §2.5):
//   - an L0 row, `{fingerprint, reason}`: an L0 token window by fingerprint, as before;
//   - an exact or near row, `{fingerprint, rule: "exact" | "near", members, reason}`: an
//     exact class, or a near-miss pair, whose member SUBJECTS equal `members`;
//   - a mirror row, `{mirror: [pathA, pathB], reason}`: two directories (members at the same
//     relative path) or two files, for a deliberate dual implementation;
//   - a wire row, `{fingerprint, rule: "<check>", members, reason}`: one wire binding, read
//     only by the step that owns `rule` (rowsFor), never by this gate's verdict.
//
// MATCHING IS BY MEMBERS. A row that names its members exempts those members and no others:
// a third copy, or a copy swapped into a file nobody reviewed, is not covered by the row two
// named files earned. The fingerprint is evidence only. When it no longer equals the class's,
// the class is still accepted and `accepted-class-changed` says the reviewed reason may no
// longer hold.
//
// SHAPE ERRORS are `duplication`'s alone: `readRegister` returns them, the gate reds on them,
// and every other reader takes only the rows that passed, so a step never reds on a row it
// does not own. An L0 row keeps the check it always had (a string fingerprint and a
// non-empty reason), so no row an install holds today becomes invalid.
//
// ONLY A HUMAN APPLIES A ROW (decision A2). The register is write-guarded and an ESCAPE_LIST;
// an agent stages `harness-proposals/<id>.json` and a human runs `apply-proposal`. There is
// no source marker: copied with the code it would grant the copy nothing, because rows bind
// members.
//
// Imports only node:fs, so the Stop run's L0 loads nothing heavier.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'

export const ALLOW_PATH = 'tools/duplication-allow.json'

/**
 * The closed `rule` set: the two duplication rules and the wire families that take rows.
 * `wire-bound` is not here: its sites use tools/dto-bounds-allow.json (#181). The complexity
 * families take no rows; they are never owed.
 * @public read by the wire steps (#189, #196, #197, #198) and the factory's constant test
 * @type {readonly string[]}
 */
export const ROW_RULES = Object.freeze([
  'exact',
  'near',
  'wire-orphan',
  'validation-parity',
  'respelled-guard',
  'parity-truth',
  'twin-schema',
  'twin-args',
  'wire-restate',
  'i18n-key-parity',
])

/** A new-kind row's reason is at least this long: a reviewer's sentence, not a token. */
export const REASON_MIN = 20

/**
 * @typedef {{ kind: 'l0', fingerprint: string, reason: string }} L0Row
 * @typedef {{ kind: 'rule', rule: string, members: string[], fingerprint?: string, reason: string }} RuleRow
 * @typedef {{ kind: 'mirror', mirror: [string, string], reason: string }} MirrorRow
 * @typedef {L0Row | RuleRow | MirrorRow} Row
 * @typedef {{ rule: 'stale-row' | 'accepted-class-diverged' | 'accepted-class-changed', subject: string, row: RuleRow }} Finding
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A repository-relative POSIX path: no leading `/`, no `..` or `.` segment, no `\`. */
const repoPath = (v) =>
  typeof v === 'string' &&
  v !== '' &&
  !v.startsWith('/') &&
  !v.includes('\\') &&
  !/^[A-Za-z]:/.test(v) &&
  v.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

const longReason = (v) => typeof v === 'string' && v.trim().length >= REASON_MIN

/** Why a new-kind `rule` row is malformed, or null. */
function ruleRowProblem(entry) {
  const { rule, members } = entry
  if (rule === 'wire-bound') {
    return '`rule: "wire-bound"` takes no row here: a wire-bound site is exempted in tools/dto-bounds-allow.json'
  }
  if (typeof rule !== 'string' || !ROW_RULES.includes(rule)) {
    return `unknown rule ${JSON.stringify(rule)}: a rule is one of ${ROW_RULES.join(', ')}`
  }
  if (!Array.isArray(members) || !members.every((m) => typeof m === 'string' && m !== '')) {
    return '"members" must be an array of subject strings'
  }
  if (members.length < 2) return '"members" must name at least 2 subjects'
  if (new Set(members).size !== members.length) return '"members" names a subject twice'
  if (rule === 'near' && members.length !== 2) return 'a near row names exactly 2 members, the pair'
  if (entry.fingerprint !== undefined && typeof entry.fingerprint !== 'string') {
    return '"fingerprint", when present, must be a string'
  }
  return null
}

/** Why a mirror row is malformed, or null. */
function mirrorRowProblem(entry) {
  const { mirror } = entry
  if (entry.rule !== undefined) return 'a row is a rule row or a mirror row, not both'
  if (!Array.isArray(mirror) || mirror.length !== 2 || !mirror.every(repoPath)) {
    return '"mirror" must be exactly two repository-relative paths'
  }
  if (mirror[0] === mirror[1]) return '"mirror" must name two different paths'
  return null
}

/**
 * Why one entry is malformed, or null when it is a row.
 * @param {unknown} entry @returns {string | null}
 */
export function rowProblem(entry) {
  if (!isObject(entry)) return 'an entry must be an object'
  const e = /** @type {Record<string, any>} */ (entry)
  if (e.rule === undefined && e.mirror === undefined) {
    const l0 =
      typeof e.fingerprint === 'string' && typeof e.reason === 'string' && e.reason.trim() !== ''
    return l0 ? null : 'every entry must be {"fingerprint": string, "reason": non-empty string}'
  }
  const kindProblem = e.mirror === undefined ? ruleRowProblem(e) : mirrorRowProblem(e)
  if (kindProblem !== null) return kindProblem
  if (!longReason(e.reason)) {
    return `"reason" must be a reviewer's sentence of at least ${String(REASON_MIN)} characters`
  }
  return null
}

/** @param {Record<string, any>} e @returns {Row} */
function toRow(e) {
  if (e.mirror !== undefined)
    return { kind: 'mirror', mirror: [e.mirror[0], e.mirror[1]], reason: e.reason }
  if (e.rule !== undefined) {
    return {
      kind: 'rule',
      rule: e.rule,
      members: [...e.members],
      ...(e.fingerprint === undefined ? {} : { fingerprint: e.fingerprint }),
      reason: e.reason,
    }
  }
  return { kind: 'l0', fingerprint: e.fingerprint, reason: e.reason }
}

/**
 * Parse the register's text. `error` is set when the file is not a register at all (not JSON,
 * or no `allow` array); otherwise `rows` holds every well-formed entry, with its index in
 * `allow`, and `problems` one line per malformed entry, naming it.
 * @param {string} text
 * @returns {{ error: string | null, rows: (Row & { index: number })[], problems: string[] }}
 */
export function parseRegister(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      error: `${ALLOW_PATH} is not valid JSON (${e.message}) — the exemption list must be reviewable data`,
      rows: [],
      problems: [],
    }
  }
  if (!isObject(parsed) || !Array.isArray(parsed.allow)) {
    return {
      error: `${ALLOW_PATH} must carry an "allow" ARRAY of {"fingerprint": string, "reason": string} entries`,
      rows: [],
      problems: [],
    }
  }
  const rows = []
  const problems = []
  for (const [index, entry] of parsed.allow.entries()) {
    const problem = rowProblem(entry)
    if (problem === null) rows.push({ ...toRow(entry), index })
    else
      problems.push(
        `${ALLOW_PATH}: entry ${String(index)}: ${problem} — got ${JSON.stringify(entry)}`,
      )
  }
  return { error: null, rows, problems }
}

/**
 * Read the register. An absent file is an empty register.
 * @param {string} [file]
 */
export function readRegister(file = ALLOW_PATH) {
  if (!existsSync(file)) return { error: null, rows: [], problems: [] }
  return parseRegister(readFileSync(file, 'utf8'))
}

/**
 * The well-formed rows of the given rules, for a wire step: it applies only its own rows and
 * never sees a shape error, which is `duplication`'s to report.
 * @public read by the wire steps (#189, #196, #197, #198)
 * @param {readonly string[]} rules @param {string} [file]
 * @returns {RuleRow[]}
 */
export function rowsFor(rules, file = ALLOW_PATH) {
  return /** @type {RuleRow[]} */ (
    readRegister(file).rows.filter((r) => r.kind === 'rule' && rules.includes(r.rule))
  )
}

// ---- mirror rows ----------------------------------------------------------------------

/** `p`'s path relative to `side`: '' for the file itself, null when it is not under it. */
function under(side, p) {
  if (p === side) return ''
  return p.startsWith(`${side}/`) ? p.slice(side.length + 1) : null
}

/**
 * Do two paths sit one on each side of a mirror row, at the same relative path? For a file
 * pair that is the two files themselves.
 * @param {MirrorRow} row @param {string} a @param {string} b
 */
export function mirrored(row, a, b) {
  const [x, y] = row.mirror
  for (const [p, q] of [
    [a, b],
    [b, a],
  ]) {
    const rel = under(x, p)
    if (rel !== null && rel === under(y, q)) return true
  }
  return false
}

/**
 * Does any mirror row cover the pair of paths?
 * @param {Row[]} rows @param {string} a @param {string} b
 */
export const anyMirror = (rows, a, b) =>
  rows.some((r) => r.kind === 'mirror' && mirrored(/** @type {MirrorRow} */ (r), a, b))

// ---- members-bound rows against the tree (v2 §2.5) ------------------------------------

/**
 * How an exact class stands against the `exact` rows: `none` when no row names any of its
 * members; `accepted` when every member is listed by the row naming the most of them, with
 * `changed` when that row's fingerprint is not the class's; `unlisted` when some member is
 * not listed (a third copy, or a swap into another file), naming those members. `unlisted`
 * is the class the gate reds once the exact rule is live (#201); until then it is a fact.
 * @param {Row[]} rows @param {{ fp: string, subjects: string[] }} cls
 * @returns {{ state: 'none' | 'accepted' | 'unlisted', row: RuleRow | null, changed: boolean, unlisted: string[] }}
 */
export function judgeClass(rows, cls) {
  let best = null
  let bestOverlap = 0
  for (const r of rows) {
    if (r.kind !== 'rule' || r.rule !== 'exact') continue
    const overlap = r.members.filter((m) => cls.subjects.includes(m)).length
    if (overlap > bestOverlap) {
      best = /** @type {RuleRow} */ (r)
      bestOverlap = overlap
    }
  }
  if (best === null) return { state: 'none', row: null, changed: false, unlisted: [] }
  const listed = best.members
  const unlisted = cls.subjects.filter((s) => !listed.includes(s))
  if (unlisted.length > 0) return { state: 'unlisted', row: best, changed: false, unlisted }
  return { state: 'accepted', row: best, changed: best.fingerprint !== cls.fp, unlisted: [] }
}

/**
 * Is a near-miss pair the pair a `near` row names? Its advisory then closes `not_planned`.
 * @param {Row[]} rows @param {[string, string]} pair
 */
export const nearAccepted = (rows, pair) =>
  rows.some(
    (r) => r.kind === 'rule' && r.rule === 'near' && pair.every((s) => r.members.includes(s)),
  )

/**
 * What the members-bound rows say about the tree, as findings for advisory records:
 *   - `stale-row` for a row member that no longer exists (never red; `--prune` drops the row),
 *     and for a `near` row that matches no near-miss pair;
 *   - `accepted-class-diverged` for an `exact` row member that still exists but is in none of
 *     the row's classes and no longer hashes to the row's fingerprint: the edited side;
 *   - `accepted-class-changed` for an accepted class whose fingerprint is not the row's.
 * `subjects` maps every subject in the tree to its `alpha`; `classes` are the exact classes;
 * `pairs` the near-miss pairs, each sorted.
 * @param {Row[]} rows
 * @param {{ subjects: Map<string, string>, classes: { fp: string, subjects: string[] }[], pairs: string[][] }} tree
 * @returns {Finding[]}
 */
export function rowFindings(rows, tree) {
  /** @type {Finding[]} */
  const out = []
  for (const r of rows) {
    if (r.kind !== 'rule' || !['exact', 'near'].includes(r.rule)) continue
    const row = /** @type {RuleRow} */ (r)
    const missing = row.members.filter((m) => !tree.subjects.has(m))
    for (const m of missing) out.push({ rule: 'stale-row', subject: m, row })
    if (row.rule === 'exact') out.push(...exactRowFindings(row, tree))
    else if (missing.length === 0 && !pairMatched(row, tree.pairs)) {
      out.push({ rule: 'stale-row', subject: [...row.members].sort().join(' '), row })
    }
  }
  return out
}

/** Does a near row name one of the tree's near-miss pairs? @param {RuleRow} row @param {string[][]} pairs */
const pairMatched = (row, pairs) => pairs.some((p) => p.every((s) => row.members.includes(s)))

/**
 * An `exact` row's diverged members and changed classes.
 * @param {RuleRow} row @param {{ subjects: Map<string, string>, classes: { fp: string, subjects: string[] }[] }} tree
 * @returns {Finding[]}
 */
function exactRowFindings(row, tree) {
  /** @type {Finding[]} */
  const out = []
  const judged = tree.classes
    .map((c) => ({ c, j: judgeClass([row], c) }))
    .filter(({ j }) => j.state !== 'none')
  const inClass = new Set(judged.flatMap(({ c }) => c.subjects))
  for (const m of row.members) {
    const alpha = tree.subjects.get(m)
    if (alpha !== undefined && !inClass.has(m) && alpha !== row.fingerprint) {
      out.push({ rule: 'accepted-class-diverged', subject: m, row })
    }
  }
  for (const { c, j } of judged) {
    if (j.state === 'accepted' && j.changed)
      out.push({ rule: 'accepted-class-changed', subject: c.fp, row })
  }
  return out
}

/**
 * Is a row stale, so that `--prune` drops it? A rule row (`exact` or `near`) when a member no
 * longer exists or a `near` row matches no pair; a mirror row when either side is gone. An
 * L0 row is never stale here: a fingerprint that matches nothing on one shape of the tree can
 * be the match on another (the i18n rows of a scaffold with and without the example).
 * @param {Row} row @param {{ subjects: Map<string, string>, pairs: string[][] }} tree
 * @param {(p: string) => boolean} [exists]
 */
export function isStale(row, tree, exists = existsSync) {
  if (row.kind === 'mirror') return !row.mirror.every((p) => exists(p))
  if (row.kind !== 'rule' || !['exact', 'near'].includes(row.rule)) return false
  if (row.members.some((m) => !tree.subjects.has(m))) return true
  return row.rule === 'near' && !pairMatched(row, tree.pairs)
}
