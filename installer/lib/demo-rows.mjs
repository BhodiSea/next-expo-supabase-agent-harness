// The demo's register rows (2.0.0, #85).
//
// `init --with-demo` overlays the demo's copy of each seeded register it changes
// (tools/mutation-baseline.json, tools/generated/query-shapes.json, PARITY.md, …). `eject`
// gives an unchanged register back as the default install's bytes; a register the project
// has changed since init keeps the project's rows, and only the demo's rows go. Which rows
// are the demo's is not guessed at eject time: template/demo-index.json lists them, as
// {file, jsonPointer} for a JSON register and {file, rowKey} for a markdown table, because a
// JSON pointer cannot address a markdown row, and the same with `restore: true` for a row of
// the default copy the demo dropped or changed. scripts/check-demo-index.mjs generates the
// index and holds it complete in both directions.
//
// A row is deleted only where it still EQUALS the row the demo shipped. The pointer is tried
// first; when it misses (the project inserted a row before it, which shifts every index
// after), the row is looked for by value in the same container, so a shifted pointer can
// never delete the project's row that now sits at it. Array rows go in descending index
// order, so a deletion never moves a pointer still to be resolved. A default row comes back
// only where it is absent, at the default's position; one the project replaced with its own
// value stays the project's. Whatever cannot be judged is kept and reported, never guessed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { templateRoot } from './copy.mjs'

/** The sidecar index, relative to template/. */
const DEMO_INDEX = 'demo-index.json'

/** @typedef {{ file: string, jsonPointer?: string, rowKey?: string, restore?: boolean }} DemoRow */

/**
 * The shipped index. Fail loud: an absent or unparsable index is a packaging regression, and
 * reading it as "no rows" would make `eject` leave every demo row behind in silence.
 *
 * @param {string} [path]
 * @returns {{ rows: DemoRow[] }}
 */
export function readDemoIndex(path = join(templateRoot(), DEMO_INDEX)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`template/${DEMO_INDEX} is missing or not valid JSON (${/** @type {Error} */ (e).message}) — installer packaging is broken`)
  }
  if (!Array.isArray(parsed?.rows)) throw new Error(`template/${DEMO_INDEX} has no rows[] — installer packaging is broken`)
  return parsed
}

/**
 * RFC 6901 reference tokens of a JSON pointer (`~1` is `/`, `~0` is `~`).
 *
 * @param {string} pointer
 * @returns {string[]}
 */
export function pointerTokens(pointer) {
  // '' is the whole document (RFC 6901 §5): no tokens, and no container to delete it from.
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error(`not a JSON pointer: ${JSON.stringify(pointer)}`)
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/** @param {string[]} tokens */
export function tokensToPointer(tokens) {
  return tokens.map((t) => `/${t.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')
}

/**
 * The value a pointer names, with the container and key that hold it.
 *
 * @param {unknown} doc
 * @param {string} pointer
 * @returns {{ found: false } | { found: true, value: unknown, parent: unknown[] | Record<string, unknown>, key: string | number }}
 */
export function resolvePointer(doc, pointer) {
  /** @type {any} */
  let value = doc
  /** @type {any} */
  let parent
  /** @type {string | number} */
  let key = ''
  for (const token of pointerTokens(pointer)) {
    if (value === null || typeof value !== 'object') return { found: false }
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= value.length) return { found: false }
      key = Number(token)
    } else {
      if (!Object.hasOwn(value, token)) return { found: false }
      key = token
    }
    parent = value
    value = value[key]
  }
  return parent === undefined ? { found: false } : { found: true, value, parent, key }
}

/** Key-order-insensitive JSON equality: the project may have reformatted, not reordered, a row. */
/** @param {unknown} v @returns {string} */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v)
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * Descending pointer order: within one container, the highest array index first.
 *
 * @param {string} a
 * @param {string} b
 */
function deepestLast(a, b) {
  const ta = pointerTokens(a)
  const tb = pointerTokens(b)
  const pa = tokensToPointer(ta.slice(0, -1))
  const pb = tokensToPointer(tb.slice(0, -1))
  if (pa !== pb) return pa < pb ? -1 : 1
  const [la, lb] = [ta.at(-1) ?? '', tb.at(-1) ?? '']
  if (/^\d+$/.test(la) && /^\d+$/.test(lb)) return Number(lb) - Number(la)
  return la < lb ? 1 : -1
}

/**
 * The container a pointer's last token addresses, from the document root.
 *
 * @param {unknown} doc @param {string[]} tokens
 * @returns {{ found: false } | { found: true, value: unknown }}
 */
function holderOf(doc, tokens) {
  if (tokens.length === 1) return { found: true, value: doc }
  const at = resolvePointer(doc, tokensToPointer(tokens.slice(0, -1)))
  return at.found ? { found: true, value: at.value } : { found: false }
}

/**
 * Delete one shipped row from `doc`: at its pointer when it still equals the shipped row,
 * otherwise wherever the same container holds an equal row.
 *
 * @param {unknown} doc
 * @param {string} pointer
 * @param {unknown} shipped
 * @returns {boolean} whether a row was deleted
 */
function deleteOne(doc, pointer, shipped) {
  const want = canonical(shipped)
  const tokens = pointerTokens(pointer)
  const holder = holderOf(doc, tokens)
  if (!holder.found) return false
  const container = /** @type {any} */ (holder.value)
  if (Array.isArray(container)) {
    const at = resolvePointer(doc, pointer)
    const i = at.found && canonical(at.value) === want ? Number(at.key) : container.findIndex((x) => canonical(x) === want)
    if (i === -1) return false
    container.splice(i, 1)
    return true
  }
  const key = /** @type {string} */ (tokens.at(-1))
  if (container === null || typeof container !== 'object' || !Object.hasOwn(container, key)) return false
  if (canonical(container[key]) !== want) return false
  delete container[key]
  return true
}

/**
 * Put `key: value` into `obj` right after the key that precedes it in the default copy, so a
 * restored key lands where the default has it rather than at the end.
 *
 * @param {Record<string, unknown>} obj @param {string} key @param {unknown} value @param {string[]} order
 */
function insertKey(obj, key, value, order) {
  const entries = Object.entries(obj)
  const prev = order[order.indexOf(key) - 1]
  const after = prev === undefined ? -1 : entries.findIndex(([k]) => k === prev)
  entries.splice(prev === undefined ? 0 : after === -1 ? entries.length : after + 1, 0, [key, value])
  for (const k of Object.keys(obj)) delete obj[k]
  for (const [k, v] of entries) obj[k] = v
}

/**
 * Restore one default row into `doc` where it is absent. An array element goes back at its
 * default index (clamped); an object key goes back only when the key is absent, so a value
 * the project set stays the project's.
 *
 * @param {unknown} doc @param {unknown} def @param {string} pointer @param {unknown} value
 * @returns {boolean} whether the row was restored
 */
function restoreOne(doc, def, pointer, value) {
  const tokens = pointerTokens(pointer)
  const holder = holderOf(doc, tokens)
  if (!holder.found) return false
  const container = /** @type {any} */ (holder.value)
  const key = /** @type {string} */ (tokens.at(-1))
  if (Array.isArray(container)) {
    if (container.some((x) => canonical(x) === canonical(value))) return false
    container.splice(Math.min(Number(key), container.length), 0, value)
    return true
  }
  if (container === null || typeof container !== 'object' || Object.hasOwn(container, key)) return false
  const defHolder = /** @type {any} */ (holderOf(def, tokens))
  insertKey(container, key, value, Object.keys(defHolder.found ? defHolder.value : {}))
  return true
}

/** Ascending pointer order, array indexes numerically: the order the default holds its rows in. */
/** @param {string} a @param {string} b */
function shallowFirst(a, b) {
  return -deepestLast(a, b)
}

/**
 * The demo's rows taken out of a JSON register the project changed, and the default's rows
 * put back.
 *
 * @param {string} currentText the register on disk
 * @param {string} demoText the demo's copy of the register, as shipped
 * @param {string} defaultText the default install's copy, as shipped
 * @param {DemoRow[]} rows the index rows for this file
 * @returns {{ content: string, deleted: string[], restored: string[], kept: string[] }}
 */
function trimJsonRows(currentText, demoText, defaultText, rows) {
  const doc = JSON.parse(currentText)
  const demo = JSON.parse(demoText)
  const def = JSON.parse(defaultText)
  const deleted = []
  const restored = []
  const kept = []
  const pointers = (restore) => rows.filter((r) => (r.restore === true) === restore).map((r) => /** @type {string} */ (r.jsonPointer))
  for (const pointer of pointers(false).sort(deepestLast)) {
    const shipped = resolvePointer(demo, pointer)
    if (shipped.found && deleteOne(doc, pointer, shipped.value)) deleted.push(pointer)
    else kept.push(pointer)
  }
  for (const pointer of pointers(true).sort(shallowFirst)) {
    const want = resolvePointer(def, pointer)
    if (!want.found) kept.push(pointer)
    else if (restoreOne(doc, def, pointer, want.value)) restored.push(pointer)
  }
  return { content: `${JSON.stringify(doc, null, 2)}\n`, deleted, restored, kept }
}

/**
 * The first cell of a markdown table row, or null for any other line (prose, a header
 * separator).
 *
 * @param {string} line
 * @returns {string | null}
 */
export function rowKeyOf(line) {
  const m = /^\|\s*([^|]*?)\s*\|/.exec(line)
  if (m === null || /^:?-+:?$/.test(m[1])) return null
  return m[1]
}

/** Row key -> line, in file order. @param {string} text */
function tableRows(text) {
  return new Map(
    text.split('\n').flatMap((l) => {
      const key = rowKeyOf(l)
      return key === null ? [] : [[key, l]]
    }),
  )
}

/**
 * Where a restored row goes: after the row that precedes it in the default table, else after
 * the current table's last row.
 *
 * @param {string[]} lines @param {string[]} defaultKeys @param {string} key
 */
function restoreAt(lines, defaultKeys, key) {
  const prev = defaultKeys[defaultKeys.indexOf(key) - 1]
  const after = prev === undefined ? -1 : lines.findIndex((l) => rowKeyOf(l) === prev)
  if (after !== -1) return after + 1
  let last = -1
  lines.forEach((l, i) => {
    if (l.startsWith('|')) last = i
  })
  return last + 1
}

/**
 * The demo's rows taken out of a markdown register (PARITY.md): a line goes when its first
 * cell is an indexed row key AND the whole line still equals the line the demo shipped; a
 * default row comes back when no line equal to it is present.
 *
 * @param {string} currentText @param {string} demoText @param {string} defaultText @param {DemoRow[]} rows
 * @returns {{ content: string, deleted: string[], restored: string[], kept: string[] }}
 */
function trimMarkdownRows(currentText, demoText, defaultText, rows) {
  const shipped = tableRows(demoText)
  const defaults = tableRows(defaultText)
  const defaultKeys = [...defaults.keys()]
  const lines = currentText.split('\n')
  const deleted = []
  const restored = []
  const kept = []
  for (const { rowKey: key } of rows.filter((r) => r.restore !== true)) {
    const i = lines.findIndex((l) => l === shipped.get(/** @type {string} */ (key)))
    if (i === -1) kept.push(/** @type {string} */ (key))
    else {
      lines.splice(i, 1)
      deleted.push(/** @type {string} */ (key))
    }
  }
  const restores = rows.filter((r) => r.restore === true).map((r) => /** @type {string} */ (r.rowKey))
  for (const key of restores.sort((a, b) => defaultKeys.indexOf(a) - defaultKeys.indexOf(b))) {
    const line = defaults.get(key)
    if (line === undefined) kept.push(key)
    else if (!lines.includes(line)) {
      lines.splice(restoreAt(lines, defaultKeys, key), 0, line)
      restored.push(key)
    }
  }
  return { content: lines.join('\n'), deleted, restored, kept }
}

/**
 * The demo's rows taken out of one register, and the default's put back, whichever kind of
 * register it is.
 *
 * @param {string} file the register's install path
 * @param {string} currentText @param {string} demoText @param {string} defaultText
 * @param {DemoRow[]} rows the index rows for this file
 */
export function trimDemoRows(file, currentText, demoText, defaultText, rows) {
  if (file.endsWith('.json')) return trimJsonRows(currentText, demoText, defaultText, rows)
  return trimMarkdownRows(currentText, demoText, defaultText, rows)
}
