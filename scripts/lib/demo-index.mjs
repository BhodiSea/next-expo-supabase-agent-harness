// The demo index and the owned-file scan behind scripts/check-demo-index.mjs (2.0.0, #85).
// Pure over a template root: every function here takes the root (or texts read from it), so
// the factory test runs the same code over a fixture tree.
//
// THE INDEX. template/demo-index.json lists, for every SEEDED register the demo replaces (a
// JSON file, or a markdown file's table rows), what its copy changes against the default
// copy, as rows:
//   {file, jsonPointer}                 a value the demo adds: an object key, an array
//                                       element, or a changed scalar. The pointer is into the
//                                       DEMO copy; `eject` deletes it from a register the
//                                       project has changed, only where it still equals the
//                                       demo's value (installer/lib/demo-rows.mjs).
//   {file, jsonPointer, restore: true}  a value the default copy carries and the demo drops
//                                       or changes; the pointer is into the DEFAULT copy, and
//                                       `eject` puts it back where it is absent.
//   {file, rowKey} / {..., restore}     the same two for a markdown table row, keyed by its
//                                       first cell, because a JSON pointer cannot address one.
// Array elements are compared whole (key-order-insensitive), so a changed element is one
// row out and one row in. The check holds the committed index to the computed one both
// ways, and to its generated form; `--write` writes the computed one.
//
// THE OWNED FILES. A demo path is an install path only the demo ships (a file, or a
// directory nothing else ships into), or the name of a package only the demo ships. An owned
// file in scope must name none: owned files are the same in every install, so one that names
// a demo path breaks, or describes a tree that is not there, when the demo is absent. Scope is
// every owned file of the base, stack, preset and module trees except documentation
// (Markdown anywhere, and everything under docs/, such as a module's slice listings) — the
// maintainer's decision (2.0.0) is that prose may describe the worked example — and a JSON
// object that says `"demo": true` (the exports-walls census entry, which the boundaries gate
// keeps dormant without the demo) is not read. SLOTS are the generic locations the default
// leaves empty and the harness's tools name by convention.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { storageToInstall } from '../../installer/lib/copy.mjs'
import { canonical, resolvePointer, rowKeyOf, tokensToPointer } from '../../installer/lib/demo-rows.mjs'
import { walkFiles } from '../../installer/lib/fs-walk.mjs'
import { fileMode } from '../../installer/lib/manifest.mjs'

export const INDEX_FILE = 'demo-index.json'
export const INDEX_LABEL = `template/${INDEX_FILE}`

/**
 * Locations a default scaffold leaves empty that the harness's own tools name by
 * convention, so naming them is not naming the demo:
 *   packages/verticals           where every vertical lives (boundaries, query-shapes, the
 *                                event-catalog generator, the slice skill all walk it);
 *   apps/web/lib/app-data        a slice's RSC read seam (the slice skill; vitest's
 *                                coverage exclusion of the seams by convention);
 *   supabase/seeds/scale.sql     the db-scale lane's seed, which a project with a DAL brings
 *                                (quality-gate.yml, tools/check-db-perf.mjs).
 */
const SLOTS = ['packages/verticals', 'apps/web/lib/app-data', 'supabase/seeds', 'supabase/seeds/scale.sql']

/**
 * Install path -> absolute source path for every file of the given trees, later trees
 * replacing earlier ones at the same install path (the overlay rule).
 * @param {string} templateDir @param {string[]} trees
 * @returns {Map<string, string>}
 */
function treeEntries(templateDir, trees) {
  const out = new Map()
  for (const tree of trees) {
    const root = join(templateDir, tree)
    for (const rel of walkFiles(root)) out.set(storageToInstall(rel), join(root, rel))
  }
  return out
}

/** Every module and preset tree under the template root, as tree names. @param {string} templateDir */
function optionalTrees(templateDir) {
  const under = (dir) =>
    [...new Set(walkFiles(join(templateDir, dir)).map((rel) => `${dir}/${rel.split('/')[0]}`))].sort()
  return [...under('presets'), ...under('modules')]
}

/**
 * The plans a demo path is judged against: the default plan (base + stack) and every
 * optional tree an install may add (presets, modules).
 * @param {string} templateDir
 */
function defaultTrees(templateDir) {
  return { plan: treeEntries(templateDir, ['base', 'stack']), optional: treeEntries(templateDir, optionalTrees(templateDir)) }
}

// ---- JSON rows -------------------------------------------------------------------------

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The rows a demo JSON value adds or changes against the default value at the same place.
 * @param {string} file @param {unknown} demo @param {unknown} def @param {string[]} at
 * @returns {Array<{ file: string, jsonPointer: string, restore?: true }>}
 */
function jsonRows(file, demo, def, at = []) {
  if (canonical(demo) === canonical(def)) return []
  if (isObject(demo) && isObject(def)) return objectRows(file, demo, def, at)
  if (Array.isArray(demo) && Array.isArray(def)) return arrayRows(file, demo, def, at)
  if (at.length === 0) return [{ file, jsonPointer: '' }]
  const jsonPointer = tokensToPointer(at)
  return [
    { file, jsonPointer },
    { file, jsonPointer, restore: true },
  ]
}

/** @param {string} file @param {Record<string, unknown>} demo @param {Record<string, unknown>} def @param {string[]} at */
function objectRows(file, demo, def, at) {
  const rows = []
  for (const key of Object.keys(demo)) {
    if (!Object.hasOwn(def, key)) rows.push({ file, jsonPointer: tokensToPointer([...at, key]) })
    else rows.push(...jsonRows(file, demo[key], def[key], [...at, key]))
  }
  for (const key of Object.keys(def)) {
    if (!Object.hasOwn(demo, key)) rows.push({ file, jsonPointer: tokensToPointer([...at, key]), restore: /** @type {const} */ (true) })
  }
  return rows
}

/** @param {string} file @param {unknown[]} demo @param {unknown[]} def @param {string[]} at */
function arrayRows(file, demo, def, at) {
  const left = (from, against) => {
    const pool = against.map(canonical)
    return from.flatMap((el, i) => {
      const hit = pool.indexOf(canonical(el))
      if (hit !== -1) {
        pool.splice(hit, 1)
        return []
      }
      return [i]
    })
  }
  return [
    ...left(demo, def).map((i) => ({ file, jsonPointer: tokensToPointer([...at, String(i)]) })),
    ...left(def, demo).map((i) => ({ file, jsonPointer: tokensToPointer([...at, String(i)]), restore: /** @type {const} */ (true) })),
  ]
}

// ---- markdown rows ---------------------------------------------------------------------

/** Table rows by key, and every other line in order. @param {string} text */
function splitMarkdown(text) {
  /** @type {Map<string, string>} */
  const rows = new Map()
  /** @type {string[]} */
  const prose = []
  for (const line of text.split('\n')) {
    const key = rowKeyOf(line)
    if (key === null) prose.push(line)
    else rows.set(key, line)
  }
  return { rows, prose }
}

/**
 * @param {string} file @param {string} demoText @param {string} defText
 * @returns {{ rows: Array<{ file: string, rowKey: string, restore?: true }>, proseDiffers: boolean }}
 */
function markdownRows(file, demoText, defText) {
  const demo = splitMarkdown(demoText)
  const def = splitMarkdown(defText)
  const rows = []
  for (const [key, line] of demo.rows) if (def.rows.get(key) !== line) rows.push({ file, rowKey: key })
  for (const [key, line] of def.rows) {
    if (demo.rows.get(key) !== line) rows.push({ file, rowKey: key, restore: /** @type {const} */ (true) })
  }
  return { rows, proseDiffers: demo.prose.join('\n') !== def.prose.join('\n') }
}

// ---- the expected index ----------------------------------------------------------------

/** @param {string} path */
function parseJsonOrNull(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return null
  }
}

/** Sort key: file, then pointer or row key, then delete before restore. @param {any} r */
const rowSortKey = (r) => `${r.file}\0${r.jsonPointer ?? r.rowKey}\0${r.restore === true ? 1 : 0}`

/** @param {any[]} rows */
function sortRows(rows) {
  return [...rows].sort((a, b) => (rowSortKey(a) < rowSortKey(b) ? -1 : rowSortKey(a) > rowSortKey(b) ? 1 : 0))
}

/**
 * The rows one shared demo file contributes, and whether it is a register at all.
 * @param {string} ip @param {string} demoPath @param {string} defPath @param {string[]} problems
 */
function sharedRows(ip, demoPath, defPath, problems) {
  if (ip.endsWith('.md')) {
    const md = markdownRows(ip, readFileSync(demoPath, 'utf8'), readFileSync(defPath, 'utf8'))
    if (md.proseDiffers) {
      problems.push(`${ip}: the copies differ outside table rows — \`eject\` trims rows, so text outside them must be the same in both copies`)
    }
    return md.rows
  }
  if (!ip.endsWith('.json')) return []
  const demo = parseJsonOrNull(demoPath)
  const def = parseJsonOrNull(defPath)
  if (demo === null || def === null) return []
  const rows = jsonRows(ip, demo.value, def.value)
  if (rows.some((r) => r.jsonPointer === '')) {
    problems.push(`${ip}: the copies differ at the root — no row can carry the change; keep both copies the same JSON type`)
    return []
  }
  return rows
}

/**
 * The index the trees imply, and the structural problems found while computing it.
 * @param {string} templateDir
 */
export function expectedIndex(templateDir) {
  const { plan } = defaultTrees(templateDir)
  const demo = treeEntries(templateDir, ['demo'])
  /** @type {string[]} */
  const problems = []
  const rows = []
  const registers = new Set()
  for (const [ip, demoPath] of demo) {
    const defPath = plan.get(ip)
    if (defPath === undefined) continue
    if (fileMode(ip) !== 'seeded') {
      problems.push(`${ip}: the demo replaces an OWNED file — owned files are the same in every install, so the demo may replace only seeded ones (make the owned file read the demo's state instead)`)
      continue
    }
    const fileRows = sharedRows(ip, demoPath, defPath, problems)
    if (fileRows.length > 0) registers.add(ip)
    rows.push(...fileRows)
  }
  return { rows: sortRows(rows), registers, problems }
}

// ---- the committed index ---------------------------------------------------------------

/**
 * The committed index's rows, or a problem naming why it cannot be read.
 * @param {string} templateDir
 * @returns {{ rows: any[] } | { problem: string }}
 */
export function readCommittedIndex(templateDir) {
  const path = join(templateDir, INDEX_FILE)
  if (!existsSync(path)) return { problem: `${INDEX_LABEL} is missing — run \`node scripts/check-demo-index.mjs --write\`` }
  const parsed = parseJsonOrNull(path)
  if (parsed === null) return { problem: `${INDEX_LABEL} is not valid JSON — regenerate it with --write` }
  if (!Array.isArray(parsed.value?.rows)) return { problem: `${INDEX_LABEL} has no rows[] array — regenerate it with --write` }
  return { rows: parsed.value.rows }
}

/** @param {any} r */
const describe = (r) => `${r.file} ${r.jsonPointer !== undefined ? r.jsonPointer : `row ${r.rowKey}`}${r.restore === true ? ' (restore)' : ''}`

/**
 * Does an index row name a value that exists in the copy it points into?
 * @param {string} templateDir @param {any} r
 */
function resolves(templateDir, r) {
  const trees = r.restore === true ? ['base', 'stack'] : ['demo']
  const path = treeEntries(templateDir, trees).get(r.file)
  if (path === undefined) return false
  if (r.rowKey !== undefined) return splitMarkdown(readFileSync(path, 'utf8')).rows.has(r.rowKey)
  const doc = parseJsonOrNull(path)
  return doc !== null && typeof r.jsonPointer === 'string' && resolvePointer(doc.value, r.jsonPointer).found
}

/**
 * Both directions: an expected row the index lacks, and an index row that is not expected.
 * @param {string} templateDir @param {any[]} committed @param {any[]} expected
 */
export function indexProblems(templateDir, committed, expected) {
  const key = (r) => rowSortKey(r)
  const have = new Set(committed.map(key))
  const want = new Set(expected.map(key))
  const problems = []
  for (const r of expected) {
    if (have.has(key(r))) continue
    const what = r.restore === true ? 'the default row' : 'the demo row'
    problems.push(`${describe(r)}: ${what} is missing from ${INDEX_LABEL} — \`eject\` would leave it behind on a register the project changed`)
  }
  for (const r of committed) {
    if (want.has(key(r))) continue
    problems.push(
      resolves(templateDir, r)
        ? `${describe(r)}: indexed, but the default copy carries the same row — it is not the demo's`
        : `${describe(r)}: the index entry resolves to nothing`,
    )
  }
  return problems
}

/** The index file's generated text. @param {any[]} rows */
export function renderIndex(rows) {
  return `${JSON.stringify(
    {
      '//': 'GENERATED by `node scripts/check-demo-index.mjs --write` — never edit by hand. For each seeded register the worked example replaces (template/demo), the rows its copy adds or changes against the default copy: a jsonPointer into the demo copy (or a rowKey for a markdown table row) that `eject` deletes from a register the project changed, and, with restore: true, a row of the default copy that `eject` puts back. scripts/lib/demo-index.mjs says how the rows are computed.',
      rows,
    },
    null,
    2,
  )}\n`
}

// ---- the owned-file scan ---------------------------------------------------------------

/**
 * Every demo path: files only the demo ships, the directories nothing else ships into
 * (topmost first, SLOTS and their ancestors excepted), and the packages only it ships.
 * @param {string} templateDir
 * @returns {string[]}
 */
export function demoNeedles(templateDir) {
  const { plan, optional } = defaultTrees(templateDir)
  const others = [...plan.keys(), ...optional.keys()]
  const demo = treeEntries(templateDir, ['demo'])
  const only = [...demo.keys()].filter((ip) => !plan.has(ip) && !optional.has(ip))
  const isSlot = (p) => SLOTS.some((s) => s === p || s.startsWith(`${p}/`))
  const dirs = new Set()
  for (const ip of only) {
    const parts = ip.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!isSlot(dir) && !others.some((o) => o.startsWith(`${dir}/`))) dirs.add(dir)
    }
  }
  const topDirs = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && d.startsWith(`${o}/`)))
  const packages = only
    .filter((ip) => /^packages\/.+\/package\.json$/.test(ip))
    .map((ip) => parseJsonOrNull(/** @type {string} */ (demo.get(ip)))?.value?.name)
    .filter((n) => typeof n === 'string')
  return [...new Set([...only.filter((ip) => !isSlot(ip)), ...topDirs.map((d) => `${d}/`), ...packages])].sort()
}

/** A JSON value with every object that says "demo": true removed. @param {unknown} v @returns {unknown} */
function withoutDemoObjects(v) {
  if (Array.isArray(v)) return v.filter((x) => !(isObject(x) && x.demo === true)).map(withoutDemoObjects)
  if (!isObject(v)) return v
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => !(isObject(x) && x.demo === true))
      .map(([k, x]) => [k, withoutDemoObjects(x)]),
  )
}

/** The text a scan reads: JSON with its demo objects removed, anything else verbatim. @param {string} ip @param {string} text */
function scannedText(ip, text) {
  if (!ip.endsWith('.json')) return text
  try {
    return JSON.stringify(withoutDemoObjects(JSON.parse(text)))
  } catch {
    return text
  }
}

/**
 * Owned files in scope that name a demo path, as `<path>:<line>: names <needle>`.
 * @param {string} templateDir @param {string[]} needles
 */
export function ownedProblems(templateDir, needles) {
  const { plan, optional } = defaultTrees(templateDir)
  const problems = []
  for (const [ip, path] of [...plan, ...optional]) {
    if (ip.endsWith('.md') || ip.startsWith('docs/') || fileMode(ip) !== 'owned') continue
    const text = readFileSync(path, 'utf8')
    const scanned = scannedText(ip, text)
    const lines = text.split('\n')
    for (const needle of needles) {
      if (!scanned.includes(needle)) continue
      const at = lines.findIndex((l) => l.includes(needle))
      problems.push(`${ip}:${at + 1}: names ${needle} — an owned file is the same in every install, and this path ships only with the worked example (\`init --with-demo\`)`)
    }
  }
  return problems.sort()
}
