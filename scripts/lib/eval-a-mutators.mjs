// Eval A's seven mutators (2.1.0, #188; plan v2 §11 A): each takes one corpus helper and
// returns the second home a careless edit would make of it, or null where the mutation does
// not apply to that helper. Every mutator is a pure function of the helper and a seed: the
// same inputs give the same bytes on every machine, so a case tree, and every key the sweep
// prints over it, is fixed by the committed corpus and seed.
//
//   rename      every bound name (parameters, locals, catch variables, inner function and
//               class names) respelled; a shorthand property or binding keeps its key
//               (`{ noteId }` becomes `{ noteId: v2_ }`). The normaliser reads bound names as
//               slots, so the copy's `alpha` equals the helper's: owed recall on renames is
//               true by construction. Null when one name is declared twice in the helper (a
//               shadowed name), where a respelling could change what a reference means.
//   literal     one string, template or numeric literal changed. `alpha` is unchanged and
//               `lit` differs, so an owed class with one literal parameter. Null with no
//               literal outside a property key, an import or a type.
//   reorder     one to three statement edits: two adjacent statements swapped where a block
//               has them, otherwise a `void 0` statement inserted.
//   sibling     the helper unchanged, placed in a sibling vertical (the case tree decides
//               where; the text is the helper's).
//   sql-schema  a SQL helper re-created in another schema: the qualified name's schema
//               changed, the body as it was.
//   move        the helper unchanged, alone in another file: the original is gone, so the
//               sweep must stay silent about it.
//   resemble    an edit that pulls a function into resemblance: the helper with a share of
//               its property names respelled. Properties stay as written in the stream, so
//               `alpha` differs while most shingles survive: a near-miss candidate.
//
// TS mutators parse with the project's own `typescript` (syntax only); the SQL ones read the
// text. A TS mutator returns null for SQL and the SQL one for TS.

/** The mutators, in report order. */
export const MUTATORS = Object.freeze(['rename', 'literal', 'reorder', 'sibling', 'sql-schema', 'move', 'resemble'])

/** mulberry32: a 32-bit seeded generator. @param {number} seed @returns {() => number} */
export function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 32-bit seed for one helper and mutator from the corpus seed. */
export function seedFor(seed, id, mutator) {
  let h = seed >>> 0
  for (const ch of `${id}:${mutator}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return h
}

/** Apply text edits `{ start, end, text }` (non-overlapping) to `src`. */
function applyEdits(src, edits) {
  let out = src
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/** Parse a helper's text and return its source file and outermost function declaration. */
function parse(ts, helper) {
  const kind = helper.ext === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(`h.${helper.ext}`, helper.text, ts.ScriptTarget.Latest, true, kind)
  const fn = sf.statements.find((s) => ts.isFunctionDeclaration(s))
  return fn === undefined ? null : { sf, fn }
}

/** Every node under `node`, depth first. */
function nodesOf(ts, node) {
  const out = []
  const visit = (n) => {
    out.push(n)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return out
}

// ---- rename ---------------------------------------------------------------------------

/** The identifiers a binding name (identifier or pattern) binds. */
function boundIdentifiers(ts, name) {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundIdentifiers(ts, el.name)))
}

/**
 * The declaring identifiers of every name the function binds, its own name excluded: the
 * names of parameters and variable declarations (a catch variable is one), patterns
 * included, and inner function and class names.
 */
function bindings(ts, fn) {
  const out = []
  for (const n of nodesOf(ts, fn)) {
    if (ts.isParameter(n) || ts.isVariableDeclaration(n)) out.push(...boundIdentifiers(ts, n.name))
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name !== undefined) out.push(n.name)
  }
  return out
}

/** Whether an identifier is a name in a member or key position, not a reference. */
function isKeyPosition(ts, id) {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === id) return true
  if ((ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === id) return true
  if (ts.isBindingElement(p) && p.propertyName === id) return true
  if (ts.isQualifiedName(p) && p.right === id) return true
  return ts.isJsxAttribute(p) || (ts.isEnumMember(p) && p.name === id)
}

/** The edit that respells one reference or declaration of a bound name. */
function renameEdit(ts, sf, id, to) {
  const p = id.parent
  const at = { start: id.getStart(sf), end: id.end }
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return { ...at, text: `${id.text}: ${to}` }
  if (ts.isBindingElement(p) && p.name === id && p.propertyName === undefined && ts.isObjectBindingPattern(p.parent)) {
    return { ...at, text: `${id.text}: ${to}` }
  }
  return { ...at, text: to }
}

/** @param {any} ts @param {any} helper @param {number} seed */
function rename(ts, helper, seed) {
  if (helper.lang !== 'ts') return null
  const parsed = parse(ts, helper)
  if (parsed === null) return null
  const { sf, fn } = parsed
  const declared = bindings(ts, fn)
  const names = [...new Set(declared.map((id) => id.text))]
  if (names.length === 0) return null
  const ids = nodesOf(ts, fn).filter((n) => ts.isIdentifier(n) && n !== fn.name && !isKeyPosition(ts, n))
  // One name declared twice, or read where nothing in the helper declares it, is ambiguous.
  if (names.length !== declared.length) return null
  const prefix = ['v', 'w', 'k', 'q'][Math.floor(prng(seed)() * 4)]
  const to = new Map(names.map((name, i) => [name, `${prefix}${String(i + 1)}_`]))
  const taken = new Set(nodesOf(ts, sf).filter((n) => ts.isIdentifier(n)).map((n) => n.text))
  if ([...to.values()].some((n) => taken.has(n))) return null
  const refs = ids.filter((id) => to.has(id.text))
  return applyEdits(helper.text, refs.map((id) => renameEdit(ts, sf, id, to.get(id.text))))
}

// ---- literal --------------------------------------------------------------------------

function isSwappable(ts, n) {
  const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)
  if (!literal) return false
  const p = n.parent
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n) return false
  if (ts.isLiteralTypeNode(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return false
  return !ts.isElementAccessExpression(p) || p.argumentExpression !== n
}

/** A different literal of the same kind. */
function swapped(ts, sf, n) {
  if (ts.isNumericLiteral(n)) return String(Number(n.text) + 1)
  const raw = n.getText(sf)
  return `${raw.slice(0, -1)}-x${raw.slice(-1)}`
}

/** @param {any} ts @param {any} helper @param {number} seed */
function literal(ts, helper, seed) {
  if (helper.lang === 'sql') return sqlLiteral(helper, seed)
  const parsed = parse(ts, helper)
  if (parsed === null) return null
  const { sf, fn } = parsed
  const pool = nodesOf(ts, fn).filter((n) => isSwappable(ts, n))
  if (pool.length === 0) return null
  const n = pool[Math.floor(prng(seed)() * pool.length)]
  return applyEdits(helper.text, [{ start: n.getStart(sf), end: n.end, text: swapped(ts, sf, n) }])
}

/** SQL: one single-quoted string inside the body changed (comments skipped). */
function sqlLiteral(helper, seed) {
  const body = bodyRange(helper.text)
  if (body === null) return null
  // Comments first, so an apostrophe in one never opens a string.
  const pool = [...helper.text.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g)].filter(
    (m) => m[0].startsWith("'") && m.index > body.start && m.index < body.end,
  )
  if (pool.length === 0) return null
  const m = pool[Math.floor(prng(seed)() * pool.length)]
  return applyEdits(helper.text, [{ start: m.index, end: m.index + m[0].length, text: `${m[0].slice(0, -1)}-x'` }])
}

/** The `$$ … $$` body of a SQL helper, as offsets. */
function bodyRange(text) {
  const open = /\$([A-Za-z_]\w*)?\$/.exec(text)
  if (open === null) return null
  const close = text.indexOf(open[0], open.index + open[0].length)
  return close === -1 ? null : { start: open.index, end: close }
}

// ---- reorder --------------------------------------------------------------------------

const MOVABLE = (ts, s) => ts.isExpressionStatement(s) || ts.isVariableStatement(s)

/** @param {any} ts @param {any} helper @param {number} seed */
function reorder(ts, helper, seed) {
  if (helper.lang !== 'ts') return null
  const parsed = parse(ts, helper)
  if (parsed === null || parsed.fn.body === undefined) return null
  const { sf, fn } = parsed
  const rand = prng(seed)
  const edits = 1 + Math.floor(rand() * 3)
  const pairs = nodesOf(ts, fn)
    .filter((n) => ts.isBlock(n))
    .flatMap((b) => b.statements.slice(1).map((s, i) => [b.statements[i], s]))
    .filter(([a, b]) => MOVABLE(ts, a) && MOVABLE(ts, b))
  const out = []
  const used = new Set()
  for (let k = 0; k < edits; k += 1) {
    const free = pairs.filter(([a, b]) => !used.has(a) && !used.has(b))
    if (free.length === 0) break
    const [a, b] = free[Math.floor(rand() * free.length)]
    used.add(a).add(b)
    out.push({ start: a.getStart(sf), end: a.end, text: b.getText(sf) }, { start: b.getStart(sf), end: b.end, text: a.getText(sf) })
  }
  if (out.length === 0) {
    const first = fn.body.statements[0]
    const at = first === undefined ? fn.body.end - 1 : first.getStart(sf)
    out.push({ start: at, end: at, text: 'void 0\n  ' })
  }
  return applyEdits(helper.text, out)
}

// ---- sibling, sql-schema, move --------------------------------------------------------

/** @param {any} _ts @param {any} helper */
const sibling = (_ts, helper) => (helper.lang === 'ts' ? helper.text : null)

/** @param {any} _ts @param {any} helper */
const move = (_ts, helper) => helper.text

const SQL_NAME = /(create\s+(?:or\s+replace\s+)?function\s+)([A-Za-z_]\w*)\.([A-Za-z_]\w*)/i

/** @param {any} _ts @param {any} helper */
function sqlSchema(_ts, helper) {
  if (helper.lang !== 'sql') return null
  const m = SQL_NAME.exec(helper.text)
  if (m === null) return null
  return helper.text.replace(SQL_NAME, `$1${m[2] === 'eval_other' ? 'eval_third' : 'eval_other'}.$3`)
}

/** A SQL helper re-created under another function name, so the copy does not replace it. */
export function sqlRenamed(text, suffix) {
  return text.replace(SQL_NAME, `$1$2.$3_${suffix}`)
}

// ---- resemble -------------------------------------------------------------------------

/** @param {any} ts @param {any} helper @param {number} seed */
function resemble(ts, helper, seed) {
  if (helper.lang !== 'ts') return null
  const parsed = parse(ts, helper)
  if (parsed === null) return null
  const { sf, fn } = parsed
  const props = nodesOf(ts, fn).filter((n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name))
  if (props.length === 0) return null
  const names = [...new Set(props.map((p) => p.name.text))].sort()
  const rand = prng(seed)
  const pick = new Set(names.filter(() => rand() < 0.25))
  if (pick.size === 0) pick.add(names[Math.floor(rand() * names.length)])
  const edits = props
    .filter((p) => pick.has(p.name.text))
    .map((p) => ({ start: p.name.getStart(sf), end: p.name.end, text: `${p.name.text}Of` }))
  return applyEdits(helper.text, edits)
}

/** The mutator functions by name. */
export const MUTATE = Object.freeze({
  rename,
  literal,
  reorder,
  sibling,
  'sql-schema': sqlSchema,
  move,
  resemble,
})
