// tools/lib/surface-deferral.mjs — the judgement behind tools/surfaces.json (1.1.0), as pure
// logic.
//
// WHAT PROBLEM THIS SOLVES. The `mobile` paths filter in quality-gate.yml includes the shared
// packages the app is made of, and for a real app that is right. A project that builds its
// web surface first has every backend pull request arm both device lanes (`mobile-e2e` and
// `perf-lane`) against the app the scaffold shipped, and until this register it had no way
// to say so short of forking the owned workflow. A row here says it: a dated deferral of one
// surface, with a reason, which the `changes` job reads so a pull request skips those two
// lanes while the row is live.
//
// WHY A ROW CANNOT GO STALE QUIETLY. A stale deferral keeps hiding both lanes, so a row is
// live only while BOTH of these hold:
//   - the CONTENT TRIPWIRE. Every file `git ls-files` lists under the surface's tree still
//     has the sha256 the installer recorded in .harness/manifest.json, and every record
//     under that tree still has a tracked file. The first real screen, an added file, a
//     deleted one or an absent manifest voids the row, and the lanes then test the edited
//     app. The tree is the surface's own directory alone: a web-first project edits the
//     shared packages on every backend change, and counting them would void every row on
//     its first pull request. A shared change that forces an edit under apps/mobile/ voids
//     it through that edit.
//   - the DATE. `deferredUntil` is the last deferred day. After it a pull request runs the
//     lanes again, and the scheduled review (`floor-review`) reds naming the row.
// The manifest is a sound baseline because `init` records a sha for every file it plants,
// apps/ is seeded (a plain `update` never re-records it), `update --refresh-seeded` rewrites
// a file and its record together, the manifest is committed, and .harness/ is write-guarded.
//
// PURE — no fs, no process, no clock (`today` is a parameter), and the file list is a
// parameter too, so the Windows leg runs every branch. The CLI in tools/ci/surface-deferral.mjs
// owns every read and every exit.
// SOURCE: docs/harness/gates-catalog.md (the device lanes; the surface deferral)

/** The register's path, as the CLI reads it and every message names it. */
export const REGISTER_PATH = 'tools/surfaces.json'

const MANIFEST_PATH = '.harness/manifest.json'

/**
 * The surfaces a row may defer, and what a deferral skips. `mobile` is the only one: the web
 * lane's runner fails closed on an absent surface by design, and no shipped job would read a
 * `web` row, so accepting one would record a decision nothing enforces.
 */
export const SURFACES = Object.freeze({
  mobile: Object.freeze({
    tree: 'apps/mobile/',
    lanes: Object.freeze(['mobile-e2e', 'perf-lane']),
  }),
})

/** Zero-padded ISO calendar date, the shape every dated register in this tree uses. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A line break of any kind. The reason is written to $GITHUB_OUTPUT as `key=value`, so a
 * break would start a second output line the pull request's author chose.
 */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/

/** How many void causes a review problem quotes before it counts the rest. */
const CAUSES_QUOTED = 3

/** @param {unknown} value */
const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value))

/**
 * A real calendar day in YYYY-MM-DD. Built from the string alone (UTC midnight), so no local
 * clock or timezone enters: 2027-02-30 fails because it does not round-trip.
 * @param {unknown} value
 */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const day = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value
}

/**
 * @typedef {{ surface: string, deferredUntil: string, reason: string }} Row
 * @typedef {{ path: string, sha256?: string, error?: string }} TrackedFile
 * @typedef {Row & { status: 'live' | 'expired' | 'void', causes: string[], compared: number }} Classified
 */

/**
 * One row's problems, or none. Split out of parseRegister for the complexity bar.
 * @param {unknown} row @param {number} i @param {Map<string, number>} seen
 * @returns {string[]}
 */
function rowProblems(row, i, seen) {
  const at = `${REGISTER_PATH} deferrals[${String(i)}]`
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return [`${at} is not an object — a row is { "surface", "deferredUntil", "reason" }.`]
  }
  const { surface, deferredUntil, reason } = /** @type {Record<string, unknown>} */ (row)
  const problems = []
  if (typeof surface !== 'string' || !Object.hasOwn(SURFACES, surface)) {
    problems.push(
      `${at}: surface ${show(surface)} is not a known surface (known: ${Object.keys(SURFACES).join(', ')}).`,
    )
  } else if (seen.has(surface)) {
    problems.push(
      `${at}: surface ${show(surface)} repeats deferrals[${String(seen.get(surface))}] — one row per surface, or the two dates contradict each other.`,
    )
  } else {
    seen.set(surface, i)
  }
  if (!isCalendarDate(deferredUntil)) {
    problems.push(`${at}: deferredUntil ${show(deferredUntil)} is not a YYYY-MM-DD date.`)
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    problems.push(
      `${at}: reason is empty or not a string — a deferral says why the surface is not built yet.`,
    )
  } else if (LINE_BREAK.test(reason)) {
    problems.push(
      `${at}: reason contains a line break — it is written to $GITHUB_OUTPUT as one key=value line, so keep it on one line.`,
    )
  }
  return problems
}

/**
 * The register, judged for shape. `text` is the file's content, or null when it is absent
 * (absent is the same as empty: no deferral). A problem anywhere means the register as a
 * whole defers nothing; `rows` still carries the well-formed rows so the review can report
 * them.
 * @param {string | null} text
 * @returns {{ rows: Row[], problems: string[], absent: boolean }}
 */
export function parseRegister(text) {
  if (text === null) return { rows: [], problems: [], absent: true }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      rows: [],
      problems: [`${REGISTER_PATH} is not valid JSON (${e.message}).`],
      absent: false,
    }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.deferrals)) {
    return {
      rows: [],
      problems: [
        `${REGISTER_PATH} must be an object with a \`deferrals\` array (the shipped shape is { "//": "…", "deferrals": [] }).`,
      ],
      absent: false,
    }
  }
  const seen = new Map()
  const rows = []
  const problems = []
  parsed.deferrals.forEach((/** @type {unknown} */ row, /** @type {number} */ i) => {
    const found = rowProblems(row, i, seen)
    if (found.length === 0) rows.push(/** @type {Row} */ (row))
    problems.push(...found)
  })
  return { rows, problems, absent: false }
}

/**
 * The content tripwire over one surface's tree.
 *
 * `files` is every tracked file under the tree with the sha256 of its bytes (or an `error`
 * when it could not be read); null with a `listError` when the listing itself failed.
 * `manifest` is the parsed install record, or null when it is absent; `manifestError` says
 * why it could not be read at all. Every doubt is a cause: a record with no sha, an
 * unreadable file, a manifest with no files map. A cause voids the row and the lanes run.
 *
 * @param {{ tree: string, files: TrackedFile[] | null, manifest: any, listError?: string, manifestError?: string }} input
 * @returns {{ compared: number, causes: string[] }}
 */
export function compareTree({ tree, files, manifest, listError, manifestError }) {
  if (manifestError !== undefined) {
    return { compared: 0, causes: [`${MANIFEST_PATH} could not be read (${manifestError})`] }
  }
  if (files === null) {
    return {
      compared: 0,
      causes: [`the tracked files under ${tree} could not be listed (${String(listError)})`],
    }
  }
  if (manifest === null || manifest === undefined) {
    return {
      compared: 0,
      causes: [
        `${MANIFEST_PATH} is absent, so nothing records what the installer planted under ${tree}`,
      ],
    }
  }
  const records = manifest.files
  if (records === null || typeof records !== 'object' || Array.isArray(records)) {
    return { compared: 0, causes: [`${MANIFEST_PATH} records no \`files\` map`] }
  }
  const tracked = files.filter((f) => f.path.startsWith(tree))
  const causes = tracked.flatMap((f) => fileCause(f, records[f.path]))
  const trackedPaths = new Set(tracked.map((f) => f.path))
  for (const recorded of Object.keys(records)
    .filter((p) => p.startsWith(tree))
    .sort()) {
    if (!trackedPaths.has(recorded)) {
      causes.push(`${recorded} is recorded in ${MANIFEST_PATH} but is not a tracked file`)
    }
  }
  return { compared: tracked.length, causes }
}

/**
 * One tracked file against its record.
 * @param {TrackedFile} file @param {{ sha256?: unknown } | undefined} record
 * @returns {string[]}
 */
function fileCause(file, record) {
  if (record === undefined) {
    return [`${file.path} has no record in ${MANIFEST_PATH} (a file the installer did not plant)`]
  }
  if (file.error !== undefined) return [`${file.path} cannot be read (${file.error})`]
  if (typeof record?.sha256 !== 'string' || record.sha256 !== file.sha256) {
    return [`${file.path} differs from the sha the installer recorded`]
  }
  return []
}

/**
 * Every well-formed row, classified. A cause makes a row `void` whatever its date (the tree
 * is the stronger claim); otherwise a row whose last deferred day is before `today` is
 * `expired`; otherwise it is `live`.
 * @param {{ rows: Row[], today: string, manifest: any, files: TrackedFile[] | null, listError?: string, manifestError?: string }} input
 * @returns {Classified[]}
 */
export function classifyRows({ rows, today, manifest, files, listError, manifestError }) {
  return rows.map((row) => {
    const { compared, causes } = compareTree({
      tree: SURFACES[row.surface].tree,
      files,
      manifest,
      listError,
      manifestError,
    })
    /** @type {Classified['status']} */
    let status = 'live'
    if (causes.length > 0) status = 'void'
    else if (row.deferredUntil < today) status = 'expired'
    return { ...row, status, causes, compared }
  })
}

/**
 * The two values `--mode=pr` writes to $GITHUB_OUTPUT. Only a live mobile row in a register
 * with no problem at all defers; `deferral` is `<until>: <reason>`, empty otherwise.
 * @param {Classified[]} classified @param {string[]} problems
 * @returns {{ deferred: boolean, deferral: string }}
 */
export function prOutputs(classified, problems) {
  const live = classified.find((r) => r.surface === 'mobile' && r.status === 'live')
  if (problems.length > 0 || live === undefined) return { deferred: false, deferral: '' }
  return { deferred: true, deferral: `${live.deferredUntil}: ${live.reason}` }
}

/**
 * What the scheduled review reds on: every expired or void row, named with its surface and
 * date. A live row is clean.
 * @param {Classified[]} classified @param {string} today
 * @returns {string[]}
 */
export function reviewProblems(classified, today) {
  return classified.flatMap((row) => {
    if (row.status === 'void') {
      const quoted = row.causes.slice(0, CAUSES_QUOTED).join('; ')
      const more = row.causes.length - CAUSES_QUOTED
      return [
        `${REGISTER_PATH}: the ${row.surface} deferral is VOID — ${quoted}${more > 0 ? `; and ${String(more)} more` : ''}. The surface is being built, so the row no longer describes the tree: delete it, and the device lanes run on every ${row.surface} change again.`,
      ]
    }
    if (row.status === 'expired') {
      return [
        `${REGISTER_PATH}: the ${row.surface} deferral lapsed after ${row.deferredUntil} (today is ${today}). A pull request already runs the device lanes again; delete the row, or re-date it in a reviewed commit whose reason says what changed.`,
      ]
    }
    return []
  })
}
