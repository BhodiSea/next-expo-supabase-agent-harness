// tools/lib/shapes.mjs — the Single Home extractor (2.1.0, #186): one record per callable in
// the duplication gate's scope, for the exact, near-miss and complexity families of
// `node tools/check-duplication.mjs --sweep --json`. No verdict reads it yet: the gate's Stop
// run is L0 alone, and the exact rule goes live only with #201.
//
// SCOPE. The duplication scan roots (lib/duplication-scope.mjs: apps/*/src, the flat
// packages/*/src, the layered packages/*/*/src, apps/web/app and apps/web/lib), with L0's
// exclusions (tests, `generated/`, `*.gen.ts`, `database.types.ts`, `.d.ts`), plus
// supabase/migrations and supabase/schemas. TS callables
// are function declarations, function expressions and arrow functions bound to a `const`,
// and class methods, at any depth; each needs a body. LIMIT: a TS callable whose name the
// closed printers refuse (lib/closed-text.mjs: a `#private`, string-literal, numeric or
// computed method name, a name holding `$` or a non-ASCII letter, one over 64 characters)
// is not extracted at all, since no record could name it: no class, near-miss or complexity
// record reaches it, and a callable inside it is scoped as if it were not there; a SQL
// function with a name segment over 63 characters is skipped the same way. SQL
// callables are the CREATE FUNCTION statements sql-parse.mjs reads, folded last-wins over
// the migration history by the identity PostgreSQL gives a function, its qualified name and
// input argument types: a later CREATE OR REPLACE of a signature replaces it, a new argument
// list is an overload that lives beside the old one, and a DROP FUNCTION removes the
// signature it names (every overload of a name it gives no argument list). supabase/schemas
// fills in a signature no migration defines.
//
// THE NORMALISER (one for both languages). Hashing starts at the parameter list: the name,
// `export` and every other modifier are outside it. Bound names (parameters, locals, inner
// function and class names, catch variables; in SQL parameters, DECLAREd variables and FOR
// loop variables) become `$1…$n` in order of first occurrence, and the callable's own name
// becomes `$f` where its body can name it: a TS function's (a declaration's, or the `const`
// it is bound to) and a SQL function's. A method's name is not in scope in its body, so a
// method has no `$f`. Properties after `.` and `?.`, object keys, free identifiers and type
// tokens stay as written, but a TS name spelled `S` or `N` enters the stream escaped (`\S`,
// `\N`, one token still), so no name reads as a literal. String, template, regex and JSX-text
// literals become `S`, numbers `N`. A SQL parameter takes its `$k` in declaration order, an
// unnamed one too, though only a declared name is bound (an unnamed parameter's type stays
// as written), and a positional `$n` in a body takes the slot of the parameter it refers to.
// Comments and whitespace are dropped. Shorthand properties and shorthand binding elements
// expand to `key: $n`, so `{ noteId }` hashes as `{ noteId: $2 }` (without it, a second
// vertical's `taskCreated(origin, taskId, occurredAt)` hashes equal to `noteCreated` and its
// LIFT would emit the wrong payload key). `alpha` is the hash of that stream; `lit` hashes
// the same stream with every literal kept verbatim, and is never printed.
//
// THE TOKEN CONVENTION (TOKEN_CONVENTION below, frozen together with FLOOR and part of the
// extractor digest). A callable's token count is the length of its normalised stream: every
// token from the parameter list's opening parenthesis through the end of the body,
// including the parentheses, the type annotations, the return type, the `=>` of an arrow,
// the body's braces, trailing commas and written semicolons. An arrow with one bare
// parameter counts as if its parenthesis pair were written. Type parameters come before the
// parameter list and are not counted. A template literal is one `S` per literal part
// (head, middles, tail) plus its substitutions' tokens. In SQL the stream runs from the
// parameter list through the end of the statement, keywords and unquoted names lower-cased;
// the dollar quotes that open and close the body count as one `$$` token each, like a
// body's braces, a positional `$n` counts one, and the body is tokenised like the rest. Two
// normalisers can disagree by one token on the same body (the plan's prototype and its
// fact-check did, at `useTheme` 29/30): this paragraph is what fixes the count.
//
// Data-shaped bodies are never owed: a body is data-shaped when its repetition ratio is
// under 0.5 or its literal density is over 0.5. The repetition ratio (RNR) is the share of
// tokens of the normalised stream NOT inside a tandem repeat: a token is repeated when it
// sits in a run that repeats the run just before it (periods 1 to 16), from the second copy
// on. Literal density is the share of `S` and `N` tokens. The JSX share (near-miss's "mostly
// JSX") is the share of the stream's tokens that sit inside a JSX element or fragment, so the
// whitespace between children, which never enters the stream, counts for nothing.
//
// THE PARSER is the project's own `typescript`, loaded by the caller through loadParser()
// (lib/i18n-tree.mjs) and passed in; syntax only (createSourceFile, no program). The SQL legs
// need no parser.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dottedCallee, sqlName } from './closed-text.mjs'
import { duplicationScanRoots, isGeneratedPath, isScannedName } from './duplication-scope.mjs'
import { walkFiles } from './fs-walk.mjs'
import { endOfBlockComment, parseFunctions, qualify, statementSpans } from './sql-parse.mjs'

/**
 * The token convention, verbatim in the extractor digest: a change to what counts as a token
 * is a change to every class near FLOOR, so it changes `x` with the code.
 */
export const TOKEN_CONVENTION =
  'tc1: from the parameter list open paren through the body end; parens, types, return type, arrow, braces, trailing commas and written semicolons count; a bare arrow parameter counts its implied parens; type parameters do not count; a template literal is one S per literal part; SQL keywords and unquoted names lower-cased; each body dollar quote is one $$ token; a positional $n is one token'

// ---- scope ------------------------------------------------------------------------------

/** Every TS file in scope, repository-relative POSIX, sorted. @returns {string[]} */
function scopeFiles() {
  const out = []
  for (const root of duplicationScanRoots()) {
    const base = root.split('\\').join('/')
    for (const rel of walkFiles(root, { filter: isScannedName })) {
      const path = `${base}/${rel}`
      if (!isGeneratedPath(path)) out.push(path)
    }
  }
  return out.sort()
}

// ---- workspaces -------------------------------------------------------------------------

/**
 * The workspace a path belongs to: the nearest directory above it holding a package.json,
 * with its package name. SQL lives in the `supabase` workspace.
 * @param {string} path repository-relative POSIX
 * @param {Map<string, {dir: string, name: string}>} cache
 * @returns {{ dir: string, name: string }}
 */
function workspaceOf(path, cache) {
  const parts = path.split('/')
  for (let n = parts.length - 1; n > 0; n -= 1) {
    const dir = parts.slice(0, n).join('/')
    if (cache.has(dir)) return cache.get(dir)
    const manifest = `${dir}/package.json`
    if (!existsSync(manifest)) continue
    let name = dir
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof parsed?.name === 'string') name = parsed.name
    } catch {
      /* an unreadable manifest names its workspace by directory */
    }
    const ws = { dir, name }
    cache.set(dir, ws)
    return ws
  }
  return { dir: parts[0], name: parts[0] }
}

// ---- hashing ----------------------------------------------------------------------------

/** @param {string[]} stream @returns {string} 12 hex */
const hash12 = (stream) =>
  createHash('sha256').update(JSON.stringify(stream)).digest('hex').slice(0, 12)

/** FNV-1a, 32-bit, over a string's UTF-16 code units. @param {string} text */
function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** FNV-1a over the four bytes of a 32-bit value. @param {number} value */
function fnv1aWord(value) {
  let h = 0x811c9dc5
  for (let shift = 0; shift < 32; shift += 8) {
    h ^= (value >>> shift) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// 64 fixed seeds from a fixed linear congruential sequence: the permutations never change
// between runs or machines, so neither does a MinHash.
const SEEDS = (() => {
  const out = []
  let s = 0x9e3779b9
  for (let i = 0; i < 64; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out.push(s)
  }
  return out
})()

/** The 4-gram shingles of a stream, as a set of strings. @param {string[]} stream */
export function shingles(stream) {
  const out = new Set()
  if (stream.length < 4) {
    out.add(stream.join('\u0001'))
    return out
  }
  for (let i = 0; i + 4 <= stream.length; i += 1) out.add(stream.slice(i, i + 4).join('\u0001'))
  return out
}

/**
 * A 64-permutation MinHash over a shingle set: FNV-1a for the shingle, then FNV-1a of the
 * shingle hash XOR each fixed seed as the permutation.
 * @param {Set<string>} set @returns {number[]}
 */
export function minhash(set) {
  const mins = new Array(64).fill(0xffffffff)
  for (const sh of set) {
    const base = fnv1a(sh)
    for (let i = 0; i < 64; i += 1) {
      const v = fnv1aWord((base ^ SEEDS[i]) >>> 0)
      if (v < mins[i]) mins[i] = v
    }
  }
  return mins
}

// ---- the stream's measures ------------------------------------------------------------

const MAX_PERIOD = 16

/** The repetition ratio: the share of tokens not inside a tandem repeat. @param {string[]} s */
export function repetitionRatio(s) {
  if (s.length === 0) return 1
  const repeated = new Uint8Array(s.length)
  for (let p = 1; p <= MAX_PERIOD; p += 1) markTandem(s, p, repeated)
  let count = 0
  for (const r of repeated) count += r
  return 1 - count / s.length
}

/** Mark the second-and-later copies of every run repeating at period `p`. */
function markTandem(s, p, repeated) {
  let run = 0
  for (let i = p; i <= s.length; i += 1) {
    if (i < s.length && s[i] === s[i - p]) {
      run += 1
      continue
    }
    if (run >= p) repeated.fill(1, i - run, i)
    run = 0
  }
}

/** @param {string[]} s */
export const literalDensity = (s) =>
  s.length === 0 ? 0 : s.filter((t) => t === 'S' || t === 'N').length / s.length

/** @param {string[]} s */
export const isDataShaped = (s) => repetitionRatio(s) < 0.5 || literalDensity(s) > 0.5

// ---- TypeScript -------------------------------------------------------------------------

/** @typedef {any} TsNode */

/**
 * @typedef {{
 *   lang: 'ts' | 'sql', path: string, line: number, name: string, scope?: string, subject: string,
 *   workspace: { dir: string, name: string }, kind: 'function' | 'method' | 'sql',
 *   exported: boolean, tokens: number, stmts: number, arity: number,
 *   alpha: string, lit: string, stream: string[], ends: number[], literals: string[], sig: string[],
 *   mh: number[], dataShaped: boolean, rnr: number, jsxShare: number,
 *   node?: TsNode, file?: TsFile,
 * }} Callable
 * @typedef {{ path: string, workspace: { dir: string, name: string }, sf: TsNode,
 *   src: string, callables: Callable[], localExports: Set<string> }} TsFile
 */

/** The names a file exports by an `export { a, b as c }` list with no `from`. */
function localExportNames(ts, sf) {
  const names = new Set()
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier !== undefined) continue
    const clause = st.exportClause
    if (clause === undefined || !ts.isNamedExports(clause)) continue
    for (const el of clause.elements) names.add((el.propertyName ?? el.name).text)
  }
  return names
}

const hasModifier = (ts, node, kind) =>
  (ts.getModifiers?.(node) ?? node.modifiers ?? []).some((m) => m.kind === kind)

/**
 * Every callable node of a source file with its own name, at any depth: function
 * declarations, function expressions and arrows bound to a `const`, class methods. `scope`
 * is the dotted chain of the callables it sits in, outermost first ('' at the top level).
 * `own` is the name in scope in the body (null for a method).
 * @returns {{ node: TsNode, name: string, own: string | null, kind: 'function' | 'method',
 *   exported: boolean, scope: string }[]}
 */
function callableNodes(ts, sf, localExports) {
  const out = []
  const visit = (node, scope) => {
    const found = callableOf(ts, node, localExports)
    if (found !== null) out.push({ ...found, scope })
    const inner = found === null ? scope : scope === '' ? found.name : `${scope}.${found.name}`
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  ts.forEachChild(sf, (child) => visit(child, ''))
  return out
}

/**
 * The callable a node declares, or null. One whose name the closed printer of a record's
 * member name (lib/closed-text.mjs dottedCallee) refuses is none: no record could name it.
 */
function callableOf(ts, node, localExports) {
  const found = declaredCallable(ts, node, localExports)
  return found !== null && dottedCallee.ok(found.name) ? found : null
}

function declaredCallable(ts, node, localExports) {
  if (ts.isFunctionDeclaration(node) && node.body !== undefined && node.name !== undefined) {
    const exported =
      hasModifier(ts, node, ts.SyntaxKind.ExportKeyword) || localExports.has(node.name.text)
    return { node, name: node.name.text, own: node.name.text, kind: 'function', exported }
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && constFunction(ts, node)) {
    const statement = node.parent?.parent
    const exported =
      (statement !== undefined && hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) ||
      localExports.has(node.name.text)
    const fn = node.initializer
    return { node: fn, name: node.name.text, own: node.name.text, kind: 'function', exported }
  }
  if (ts.isMethodDeclaration(node) && node.body !== undefined && ts.isClassLike(node.parent)) {
    const cls = node.parent
    const className = cls.name?.text ?? 'default'
    const method = ts.isIdentifier(node.name) ? node.name.text : node.name.getText()
    const exported = hasModifier(ts, cls, ts.SyntaxKind.ExportKeyword)
    // A method's name is not a binding in its body (it recurses through `this.`), so a bare
    // identifier spelled like it names something else and stays as written.
    return { node, name: `${className}.${method}`, own: null, kind: 'method', exported }
  }
  return null
}

/** A `const` declaration whose initializer is a function expression or an arrow. */
function constFunction(ts, decl) {
  const init = decl.initializer
  if (init === undefined) return false
  if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return false
  const list = decl.parent
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
}

/** Every name a callable binds: parameters, locals, inner function/class names, catch vars. */
function boundNames(ts, fn) {
  const names = new Set()
  const addBinding = (name) => {
    if (name === undefined) return
    if (ts.isIdentifier(name)) {
      names.add(name.text)
      return
    }
    for (const el of name.elements ?? []) if (!ts.isOmittedExpression(el)) addBinding(el.name)
  }
  const visit = (node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
      addBinding(node.name)
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      node !== fn
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return names
}

const isJsDoc = (ts, node) =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode

/**
 * The leaf tokens of a callable from its parameter list on, in source order. An arrow whose
 * single parameter is written bare gets its implied parentheses.
 */
function leafTokens(ts, fn, sf) {
  /** @type {any[]} */
  const out = []
  const collect = (node) => {
    if (isJsDoc(ts, node)) return
    const kids = node.getChildren(sf)
    if (kids.length === 0) {
      // An empty list (`()`, `[]`) is a container with nothing in it, not a token.
      if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.kind !== ts.SyntaxKind.SyntaxList) {
        out.push(node)
      }
      return
    }
    for (const k of kids) collect(k)
  }
  const kids = fn.getChildren(sf)
  const open = kids.findIndex((k) => k.kind === ts.SyntaxKind.OpenParenToken)
  const params = kids.findIndex(
    (k) => k.kind === ts.SyntaxKind.SyntaxList && k.pos >= fn.parameters.pos,
  )
  const start = open !== -1 ? open : params
  const bare = open === -1
  for (let i = start; i < kids.length; i += 1) {
    if (bare && i === params) out.push({ synthetic: '(' })
    collect(kids[i])
    if (bare && i === params) out.push({ synthetic: ')' })
  }
  return out
}

/**
 * `S` for a string, template-part, regex or JSX-text literal, `N` for a number, else null.
 * By kind value: the reverse names of ts.SyntaxKind are its range markers for some kinds
 * (NumericLiteral reads back as `FirstLiteralToken`), so a name lookup misses them.
 */
function literalClass(ts, kind) {
  const K = ts.SyntaxKind
  if (kind === K.NumericLiteral || kind === K.BigIntLiteral) return 'N'
  const strings = [
    K.StringLiteral,
    K.NoSubstitutionTemplateLiteral,
    K.TemplateHead,
    K.TemplateMiddle,
    K.TemplateTail,
    K.RegularExpressionLiteral,
    K.JsxText,
  ]
  return strings.includes(kind) ? 'S' : null
}

/** Is an identifier leaf in a position whose text is kept as written (a property or key)? */
function keptPosition(ts, id) {
  const p = id.parent
  if (p === undefined) return false
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (p.name ?? p.right) === id) {
    return true
  }
  if (ts.isBindingElement(p)) return p.propertyName === id
  if (
    ts.isPropertyAssignment(p) ||
    ts.isPropertySignature(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessor(p) ||
    ts.isSetAccessor(p) ||
    ts.isEnumMember(p) ||
    ts.isJsxAttribute(p)
  ) {
    return p.name === id
  }
  return ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)
}

/** Is an identifier a shorthand property or shorthand binding element (expands to key: v)? */
function shorthandPosition(ts, id) {
  const p = id.parent
  if (p === undefined) return false
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id
  return (
    ts.isBindingElement(p) &&
    p.propertyName === undefined &&
    p.dotDotDotToken === undefined &&
    p.name === id &&
    ts.isObjectBindingPattern(p.parent)
  )
}

/**
 * The normalised stream of one callable, plus its verbatim twin and its literals.
 * @param {any} ts @param {TsNode} fn @param {TsNode} sf @param {string | null} own
 * @param {{ expand: boolean }} opts
 */
function normaliseTs(ts, fn, sf, own, { expand }) {
  const bound = boundNames(ts, fn)
  const numbering = new Map()
  const slot = (text) => {
    if (text === own) return '$f'
    if (!bound.has(text)) return text
    if (!numbering.has(text)) numbering.set(text, `$${numbering.size + 1}`)
    return numbering.get(text)
  }
  const acc = { stream: [], verbatim: [], literals: [], slot, expand }
  // `ends[i]` is the source end of the leaf stream[i] came from, so a consumer can slice
  // the stream by statement (lib/differs.mjs aligns top-level statements that way).
  const ends = []
  let jsx = 0
  for (const leaf of leafTokens(ts, fn, sf)) {
    const from = acc.stream.length
    pushLeaf(ts, leaf, sf, acc)
    const real = leaf.synthetic === undefined
    // What the leaf put in the stream, so dropped whitespace JSX text counts for nothing.
    if (real && insideJsx(ts, leaf)) jsx += acc.stream.length - from
    const end = real ? leaf.end : fn.parameters.pos
    for (let i = from; i < acc.stream.length; i += 1) ends.push(end)
  }
  return { stream: acc.stream, verbatim: acc.verbatim, literals: acc.literals, jsx, ends }
}

/** One leaf token into the normalised stream and its verbatim twin. */
function pushLeaf(ts, leaf, sf, acc) {
  if (leaf.synthetic !== undefined) {
    acc.stream.push(leaf.synthetic)
    acc.verbatim.push(leaf.synthetic)
    return
  }
  if (leaf.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces) return
  if (leaf.kind === ts.SyntaxKind.Identifier) {
    pushIdentifier(ts, leaf, acc)
    return
  }
  const text = leaf.getText(sf)
  const literal = literalClass(ts, leaf.kind)
  if (literal === null) {
    acc.stream.push(text)
    acc.verbatim.push(text)
    return
  }
  if (leaf.kind === ts.SyntaxKind.JsxText && text.trim() === '') return
  acc.stream.push(literal)
  acc.verbatim.push(text)
  acc.literals.push(text)
}

/** A name spelled like a literal placeholder, escaped: one token still, never `S` or `N`. */
const asName = (text) => (text === 'S' || text === 'N' ? `\\${text}` : text)

function pushIdentifier(ts, id, { slot, stream, verbatim, expand }) {
  const text = id.text
  if (keptPosition(ts, id)) {
    stream.push(asName(text))
    verbatim.push(asName(text))
    return
  }
  if (expand && shorthandPosition(ts, id)) {
    stream.push(asName(text), ':')
    verbatim.push(asName(text), ':')
  }
  const value = asName(slot(text))
  stream.push(value)
  verbatim.push(value)
}

function insideJsx(ts, node) {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return true
    if (ts.isFunctionLike(p)) return false
  }
  return false
}

const STATEMENT_KINDS = [
  'VariableStatement',
  'ExpressionStatement',
  'ReturnStatement',
  'IfStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoStatement',
  'SwitchStatement',
  'ThrowStatement',
  'TryStatement',
  'BreakStatement',
  'ContinueStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
  'LabeledStatement',
]

/** Statements in a body, recursively; an expression body is one. */
function statementCount(ts, fn) {
  if (fn.body === undefined) return 0
  if (!ts.isBlock(fn.body)) return 1
  const kinds = new Set(STATEMENT_KINDS.map((k) => ts.SyntaxKind[k]))
  let n = 0
  const visit = (node) => {
    if (kinds.has(node.kind)) n += 1
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn.body, visit)
  return n
}

/** The signature as written: the parameter list and the return type, literals as S/N. */
function signatureTokens(ts, fn, sf) {
  const sig = []
  const end = fn.type !== undefined ? fn.type.end : fn.parameters.end + 1
  for (const leaf of leafTokens(ts, fn, sf)) {
    if (leaf.synthetic !== undefined) {
      sig.push(leaf.synthetic)
      // A bare arrow parameter takes no return type: its implied `)` ends the signature.
      if (leaf.synthetic === ')') break
      continue
    }
    if (leaf.pos >= end) break
    sig.push(literalClass(ts, leaf.kind) ?? leaf.getText(sf))
  }
  return sig
}

/** @returns {string} 1-based line of a node's first token */
const lineOfNode = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/**
 * Extract every callable of one TS source.
 * @param {any} ts @param {string} path repository-relative POSIX
 * @param {string} src @param {{ dir: string, name: string }} workspace
 * @param {{ expand?: boolean }} [opts]
 * @returns {TsFile}
 */
export function extractTs(ts, path, src, workspace, { expand = true } = {}) {
  const tsx = path.endsWith('.tsx')
  const sf = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const localExports = localExportNames(ts, sf)
  /** @type {TsFile} */
  const file = { path, workspace, sf, src, callables: [], localExports }
  for (const found of callableNodes(ts, sf, localExports)) {
    const fn = found.node
    const norm = normaliseTs(ts, fn, sf, found.own, { expand })
    file.callables.push(
      finish({
        lang: 'ts',
        path,
        line: lineOfNode(sf, found.kind === 'method' ? fn : (fn.parent?.name ?? fn)),
        name: found.name,
        scope: found.scope,
        workspace,
        kind: found.kind,
        exported: found.exported,
        stmts: statementCount(ts, fn),
        arity: fn.parameters.length,
        sig: signatureTokens(ts, fn, sf),
        norm,
        node: fn,
        file,
      }),
    )
  }
  return file
}

/**
 * Fill the hashed, measured fields every callable record carries.
 * @param {any} input @returns {Callable}
 */
function finish({ norm, ...rest }) {
  const stream = norm.stream
  const set = shingles(stream)
  const rnr = repetitionRatio(stream)
  return {
    ...rest,
    subject: '',
    tokens: stream.length,
    alpha: hash12(stream),
    lit: hash12(norm.verbatim),
    stream,
    ends: norm.ends ?? [],
    literals: norm.literals,
    mh: minhash(set),
    shingles: set,
    rnr,
    dataShaped: rnr < 0.5 || literalDensity(stream) > 0.5,
    jsxShare: stream.length === 0 ? 0 : norm.jsx / stream.length,
  }
}

// ---- SQL --------------------------------------------------------------------------------

/**
 * @typedef {{ value: string, literal: boolean, raw: string, index: number, inBody: boolean }}
 *   SqlToken
 * @typedef {{ mode: string, name: string | null, type: SqlToken[] }} SqlParam
 */

// One token per lexeme: comments, quoted strings (E'', '', dollar-quoted), numbers, quoted
// and unquoted names, the multi-character operators and a positional parameter (`$1`), then
// any other single character. A block comment is matched by its `/*` alone and skipped to
// where sql-parse.mjs ends it, at the `*/` that closes the outermost one: PostgreSQL nests
// them. A quoted string's only escape is `''`, as sql-parse.mjs scans it, so a backslash is
// an ordinary character and no string can backtrack exponentially.
const SQL_TOKEN =
  /(--[^\n]*)|(\/\*)|(\s+)|([eE]?'(?:''|[^'])*')|(\$([A-Za-z_]\w*)?\$)|(\d+(?:\.\d+)?)|("(?:""|[^"])*")|([A-Za-z_][\w$]*)|(::|:=|<>|!=|>=|<=|\|\||->>|->|=>|\$\d+|[^\s])/g

/**
 * Tokenise a SQL text: comments and whitespace dropped, names lower-cased, a nested
 * dollar-quoted string one literal, and a top-level `$tag$` one `$$` delimiter. Each token
 * carries its offset and whether it sits inside the function body (between the delimiters).
 * @param {string} text
 * @returns {SqlToken[]}
 */
function sqlTokens(text) {
  const out = []
  let open = null
  const re = new RegExp(SQL_TOKEN.source, 'g')
  let m = re.exec(text)
  while (m !== null) {
    const [whole, lineC, blockC, ws, str, dollar, , num, quoted, word] = m
    const index = m.index
    if (blockC !== undefined) {
      re.lastIndex = endOfBlockComment(text, index)
    } else if (dollar !== undefined) {
      const r = dollarToken(text, re, whole, open)
      // The body's own delimiters are outside it; a nested dollar-quoted literal is inside.
      out.push({ ...r.token, index, inBody: open !== null && r.open !== null })
      open = r.open
    } else if (lineC === undefined && ws === undefined) {
      out.push({ ...plainToken(whole, str, num, quoted, word), index, inBody: open !== null })
    }
    m = re.exec(text)
  }
  return out
}

/** A token that is not a dollar quote: a string or number literal, a name, or punctuation. */
function plainToken(whole, str, num, quoted, word) {
  if (str !== undefined) return { value: 'S', literal: true, raw: whole }
  if (num !== undefined) return { value: 'N', literal: true, raw: whole }
  if (quoted !== undefined) return { value: quoted.slice(1, -1), literal: false, raw: whole }
  if (word !== undefined) return { value: word.toLowerCase(), literal: false, raw: whole }
  return { value: whole, literal: false, raw: whole }
}

/** A `$tag$`: the body's own delimiter is a `$$` token; any other opens a nested literal. */
function dollarToken(text, re, tag, open) {
  if (open === null) return { open: tag, token: { value: '$$', literal: false, raw: '$$' } }
  if (tag === open) return { open: null, token: { value: '$$', literal: false, raw: '$$' } }
  const end = text.indexOf(tag, re.lastIndex)
  const stop = end === -1 ? text.length : end + tag.length
  const raw = text.slice(re.lastIndex - tag.length, stop)
  re.lastIndex = stop
  return { open, token: { value: 'S', literal: true, raw } }
}

const SQL_NAME = /^[A-Za-z_]\w*$/
const SQL_POSITIONAL = /^\$\d+$/
const SQL_MODES = new Set(['in', 'out', 'inout', 'variadic'])
// The first two words of a type PostgreSQL spells in two or more: an unnamed parameter of
// type `double precision` is not one named `double`.
const SQL_SPLIT_TYPE =
  /^(?:double precision|(?:bit|char|character|national|nchar) (?:varying|char|character)|time(?:stamp)? with(?:out)?|interval (?:year|month|day|hour|minute|second))$/

/** An unquoted word. @param {SqlToken | undefined} t */
const sqlWord = (t) => t !== undefined && !t.literal && /^[A-Za-z_]/.test(t.raw)
/** A name as a declaration writes one: an unquoted word or a quoted identifier. */
const sqlDeclName = (t) => sqlWord(t) || (t !== undefined && t.raw.startsWith('"'))

/**
 * One parameter declaration, `[mode] [name] type [DEFAULT expr | = expr]`, from its tokens.
 * `name` is null for an unnamed parameter (a type alone, after any mode); `type` is the
 * type's tokens, the name and the default left out.
 * @param {SqlToken[]} decl @returns {SqlParam}
 */
function sqlParam(decl) {
  const moded = decl.length > 1 && sqlWord(decl[0]) && SQL_MODES.has(decl[0].value)
  const rest = moded ? decl.slice(1) : decl
  const cut = rest.findIndex((t) => t.raw === '=' || (sqlWord(t) && t.value === 'default'))
  const head = cut === -1 ? rest : rest.slice(0, cut)
  const named =
    head.length > 1 &&
    sqlDeclName(head[0]) &&
    sqlDeclName(head[1]) &&
    !SQL_SPLIT_TYPE.test(`${head[0].value} ${head[1].value}`)
  return {
    mode: moded ? decl[0].value : 'in',
    name: named ? head[0].value : null,
    type: named ? head.slice(1) : head,
  }
}

/**
 * The parenthesised list whose `(` is tokens[open], split at its top-level commas into
 * parameter declarations, and the index just past its `)`.
 * @param {SqlToken[]} tokens @param {number} open
 * @returns {{ params: SqlParam[], end: number }}
 */
function sqlArgList(tokens, open) {
  /** @type {SqlToken[][]} */
  const decls = [[]]
  let depth = 0
  let i = open + 1
  for (; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.raw === ')' && depth === 0) break
    if (t.raw === '(') depth += 1
    else if (t.raw === ')') depth -= 1
    if (t.raw === ',' && depth === 0) decls.push([])
    else decls[decls.length - 1].push(t)
  }
  return { params: decls.filter((d) => d.length > 0).map(sqlParam), end: i + 1 }
}

// PostgreSQL's own name for each alias a migration may write, so that `int` in a CREATE and
// `integer` in the DROP of the same function read as one type.
const SQL_TYPE_ALIAS = new Map(
  Object.entries({
    int: 'integer',
    int4: 'integer',
    int2: 'smallint',
    int8: 'bigint',
    float4: 'real',
    float8: 'double precision',
    float: 'double precision',
    bool: 'boolean',
    decimal: 'numeric',
    varchar: 'character varying',
    'char varying': 'character varying',
    char: 'character',
    bpchar: 'character',
    varbit: 'bit varying',
    timestamptz: 'timestamp with time zone',
    'timestamp without time zone': 'timestamp',
    timetz: 'time with time zone',
    'time without time zone': 'time',
  }),
)

/**
 * A parameter's type as PostgreSQL tells functions apart by it: its modifiers (`(10,2)`) and
 * array bounds dropped, a `pg_catalog.` or `public.` qualifier dropped, an alias read as the
 * name it stands for.
 * @param {SqlToken[]} tokens
 */
function sqlTypeKey(tokens) {
  const words = []
  let array = ''
  let depth = 0
  for (const t of tokens) {
    if (t.raw === '(' || t.raw === ')') depth += t.raw === '(' ? 1 : -1
    else if (depth === 0 && (t.raw === '[' || t.value === 'array')) array = '[]'
    else if (depth === 0 && !t.literal && t.raw !== ']') words.push(t.value)
  }
  const base = words
    .join(' ')
    .replace(/ \. /g, '.')
    .replace(/^(?:pg_catalog|public)\./, '')
  return `${SQL_TYPE_ALIAS.get(base) ?? base}${array}`
}

/**
 * A function's identity in PostgreSQL, the fold's key: its qualified name and the types of
 * its input parameters (an OUT parameter is not one).
 * @param {string} qualified @param {SqlParam[]} params
 */
const sqlKey = (qualified, params) =>
  `${qualified}(${params
    .filter((p) => p.mode !== 'out')
    .map((p) => sqlTypeKey(p.type))
    .join(',')})`

/** DECLAREd variables and FOR loop variables of a PL/pgSQL body, from its tokens. */
function sqlLocals(tokens) {
  const body = tokens.filter((t) => t.inBody && !t.literal)
  const names = []
  const declare = body.findIndex((t) => t.value === 'declare')
  const begin = body.findIndex((t) => t.value === 'begin')
  let head = true
  for (const t of declare === -1 || begin < declare ? [] : body.slice(declare + 1, begin)) {
    if (head && SQL_NAME.test(t.value)) names.push(t.value)
    head = t.value === ';'
  }
  for (const [i, t] of body.entries()) {
    const next = body[i + 1]?.value ?? ''
    if (t.value === 'for' && body[i + 2]?.value === 'in' && SQL_NAME.test(next)) names.push(next)
  }
  return names
}

/** The statements of a function body: its non-empty `;`-separated runs. */
function sqlBodyStatements(tokens) {
  let n = 0
  let run = false
  for (const t of tokens.filter((x) => x.inBody)) {
    const ends = t.value === ';' && !t.literal
    if (ends && run) n += 1
    run = !ends
  }
  return n + (run ? 1 : 0)
}

/**
 * The normalised stream of one SQL function, from its statement's tokens: from the
 * parameter list's `(` to the end of the statement. Every parameter takes its slot in
 * declaration order, an unnamed one too, though only a declared name is bound; a positional
 * `$n` takes the slot of the parameter it refers to, the n-th input parameter in a `language
 * sql` body and the n-th of all of them in PL/pgSQL, which numbers OUT parameters too.
 * @param {any} fn parseFunctions' record @param {SqlToken[]} tokens from the list's `(` on
 * @param {SqlParam[]} params
 */
function normaliseSql(fn, tokens, params) {
  /** @type {Map<string | number, string>} */
  const numbering = new Map(params.map((p, i) => [p.name ?? i, `$${i + 1}`]))
  const positional = params.flatMap((p, i) =>
    fn.language === 'plpgsql' || p.mode !== 'out' ? [p.name ?? i] : [],
  )
  const bound = new Set([...params.flatMap((p) => p.name ?? []), ...sqlLocals(tokens)])
  const ctx = { tokens, schema: fn.schema, name: fn.name, bound, numbering, positional }
  const stream = []
  const verbatim = []
  const literals = []
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.literal) {
      stream.push(t.value)
      verbatim.push(t.raw)
      literals.push(t.raw)
      continue
    }
    const value = sqlSlot(t, i, ctx)
    if (value === null) continue
    stream.push(value)
    verbatim.push(value)
  }
  return { stream, verbatim, literals, jsx: 0 }
}

/** The normalised value of one SQL token, or null when it is folded into the one before. */
function sqlSlot(t, i, { tokens, schema, name, bound, numbering, positional }) {
  const value = t.value
  if (SQL_POSITIONAL.test(t.raw)) {
    return slotOf(positional[Number(value.slice(1)) - 1] ?? value, numbering)
  }
  const prev = tokens[i - 1]?.value
  if (value === schema && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === name) {
    return '$f'
  }
  if ((value === '.' || value === name) && tokens[i - (value === '.' ? 1 : 2)]?.value === schema) {
    const owner = value === '.' ? tokens[i + 1]?.value : value
    if (owner === name) return null
  }
  if (prev === '.' || !bound.has(value)) return value
  return slotOf(value, numbering)
}

/**
 * The `$k` of a parameter or a bound name; one its declaration did not number (a local, or
 * a positional `$n` past the last parameter) is numbered on its first occurrence.
 * @param {string | number} key @param {Map<string | number, string>} numbering
 */
function slotOf(key, numbering) {
  if (!numbering.has(key)) numbering.set(key, `$${numbering.size + 1}`)
  return /** @type {string} */ (numbering.get(key))
}

const DROP_FUNCTION = /^DROP FUNCTION /i

/**
 * The SQL functions in scope, folded by PostgreSQL's identity for a function, its qualified
 * name and input argument types: the last definition of a signature across
 * supabase/migrations wins and a later `DROP FUNCTION` removes it; supabase/schemas fills in
 * a signature no migration defines. Two overloads of one name are two callables, in the order
 * their signatures were first defined, so assignSubjects gives the later its ordinal
 * (`sql:<schema>.<fn>_2`).
 * @returns {Callable[]}
 */
function extractSqlTree() {
  const live = foldSqlDir('supabase/migrations')
  for (const [key, fn] of foldSqlDir('supabase/schemas')) if (!live.has(key)) live.set(key, fn)
  return [...live.values()]
}

/** @param {string} dir @returns {Map<string, Callable>} */
function foldSqlDir(dir) {
  const live = new Map()
  if (!existsSync(dir)) return live
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    foldSqlFile(`${dir}/${f}`, live)
  }
  return live
}

/**
 * Apply one SQL file's CREATE FUNCTION and DROP FUNCTION statements to `live`, keyed by
 * signature: a CREATE OR REPLACE of a signature replaces it where it stands, and a new
 * argument list adds an overload beside the old one. sql-parse.mjs reads each statement; its
 * tokens come from the statement's raw extent, where a comment in the body still ends at its
 * line.
 * @param {string} path @param {Map<string, Callable>} live
 */
function foldSqlFile(path, live) {
  const raw = readFileSync(path, 'utf8')
  for (const span of statementSpans(raw)) {
    if (DROP_FUNCTION.test(span.text)) {
      dropSqlFunctions(sqlTokens(raw.slice(span.start, span.end)), live)
      continue
    }
    const fn = parseFunctions([span.text])[0]
    // A name the closed printer refuses (a segment over 63 characters, which PostgreSQL
    // itself truncates) is no callable here, as for TS: no record could name it.
    if (fn === undefined || !sqlName.ok(fn.qualified)) continue
    const statement = sqlTokens(raw.slice(span.start, span.end))
    const line = raw.slice(0, span.start + (statement[0]?.index ?? 0)).split('\n').length
    const { key, callable } = sqlCallable(fn, path, line, statement)
    live.set(key, callable)
  }
}

/**
 * Apply `DROP FUNCTION [IF EXISTS] name [(args)] [, ...]` to `live`: each target with an
 * argument list drops that signature, and one with none every overload of its name.
 * @param {SqlToken[]} tokens @param {Map<string, Callable>} live
 */
function dropSqlFunctions(tokens, live) {
  const at = (k) => tokens[k]?.value ?? ''
  const ifExists = at(2) === 'if' && at(3) === 'exists'
  let i = ifExists ? 4 : 2
  while (i < tokens.length) {
    let name = at(i)
    if (at(i + 1) === '.') {
      name = `${name}.${at(i + 2)}`
      i += 2
    }
    i += 1
    const list = tokens[i]?.raw === '(' ? sqlArgList(tokens, i) : null
    if (list !== null) i = list.end
    dropOverloads(live, qualify(name).qualified, list?.params ?? null, ifExists)
    if (at(i) !== ',') return
    i += 1
  }
}

/**
 * Drop one DROP FUNCTION target from `live`: the signature its argument list names, or every
 * overload of its name when it gives no list.
 * @param {Map<string, Callable>} live @param {string} qualified
 * @param {SqlParam[] | null} params @param {boolean} ifExists
 */
function dropOverloads(live, qualified, params, ifExists) {
  const named = [...live.keys()].filter((k) => live.get(k)?.name === qualified)
  const hit = params === null ? named : named.filter((k) => k === sqlKey(qualified, params))
  // PostgreSQL refuses a DROP that matches no function, so one that applied matched: when the
  // types read differently here than in their CREATE (a spelling the alias table lacks), the
  // name's one overload is the one it dropped. An IF EXISTS may have matched nothing.
  const gone = hit.length === 0 && !ifExists && named.length === 1 ? named : hit
  for (const k of gone) live.delete(k)
}

const SQL_WORKSPACE = Object.freeze({ dir: 'supabase', name: 'supabase' })

/**
 * One SQL function's record and its fold key. Its `sig` is the parameter list as written,
 * through the `)` that closes it: names as declared and lower-cased, literals as S and N.
 * @param {any} fn parseFunctions' record @param {string} path @param {number} line
 * @param {SqlToken[]} statement
 * @returns {{ key: string, callable: Callable }}
 */
function sqlCallable(fn, path, line, statement) {
  const open = statement.findIndex((t) => t.raw === '(')
  const { params, end } = sqlArgList(statement, open)
  const callable = finish({
    lang: 'sql',
    path,
    line,
    name: fn.qualified,
    workspace: SQL_WORKSPACE,
    kind: 'sql',
    exported: true,
    stmts: sqlBodyStatements(statement),
    arity: params.length,
    sig: statement.slice(open, end).map((t) => t.value),
    norm: normaliseSql(fn, statement.slice(open), params),
  })
  return { key: sqlKey(fn.qualified, params), callable }
}

// ---- the tree ---------------------------------------------------------------------------

/**
 * Extract the whole tree. `ts` null runs the SQL half only (the TS legs are then
 * incomplete, which is the caller's to report). Subject ids follow v2's table: an exported
 * callable is `<package>#<name>`, an unexported one `<path>#<name>`, a method
 * `<path>#<Class>.<method>`, a SQL function `sql:<schema>.<fn>`. A nested callable is
 * qualified by the callable it sits in (`<path>#<outer>.<inner>`; two segments at most, the
 * closed subject printer's bound), and an exported name two files of one package share falls
 * back to the path form, so every subject is unique.
 * @param {any} ts the parser, or null
 * @param {{ expand?: boolean }} [opts]
 * @returns {{ files: TsFile[], callables: Callable[] }}
 */
export function extractTree(ts, { expand = true } = {}) {
  const cache = new Map()
  const files = []
  if (ts !== null) {
    for (const path of scopeFiles()) {
      const src = readFileSync(path, 'utf8')
      files.push(extractTs(ts, path, src, workspaceOf(path, cache), { expand }))
    }
  }
  const callables = [...files.flatMap((f) => f.callables), ...extractSqlTree()]
  assignSubjects(callables)
  return { files, callables }
}

/** A TS callable's name in its file: a method or a top-level one as is, a nested one under its parent's. */
const qualified = (c) =>
  c.kind === 'method' || c.scope === '' ? c.name : `${c.scope.split('.').at(-1)}.${c.name}`

/** @param {Callable[]} callables */
function assignSubjects(callables) {
  const pkgForm = (c) => `${c.workspace.name}#${c.name}`
  const counts = new Map()
  for (const c of callables) {
    if (c.lang === 'ts' && c.exported && c.kind === 'function' && c.scope === '') {
      counts.set(pkgForm(c), (counts.get(pkgForm(c)) ?? 0) + 1)
    }
  }
  const base = (c) => {
    if (c.lang === 'sql') return `sql:${c.name}`
    const unique = c.kind === 'function' && c.exported && c.scope === ''
    return unique && counts.get(pkgForm(c)) === 1 ? pkgForm(c) : `${c.path}#${qualified(c)}`
  }
  // Two callables of one name in one file (an overload, a same-named helper in two
  // functions' bodies, or one nested deeper than its parent's own name tells): the later
  // ones carry an ordinal, never their line, because a subject enters the advisory key and a
  // line must not. The ordinal skips every subject already taken, a real `<name>_2` included,
  // so no two callables share a subject.
  const bases = callables.map(base)
  const taken = new Set(bases)
  const next = new Map()
  callables.forEach((c, i) => {
    const s = bases[i]
    let k = next.get(s)
    if (k === undefined) {
      c.subject = s
      next.set(s, 2)
      return
    }
    while (taken.has(withOrdinal(s, k))) k += 1
    c.subject = withOrdinal(s, k)
    taken.add(c.subject)
    next.set(s, k + 1)
  })
}

/**
 * `subject` with ordinal `k` on its last segment, which is cut to keep the segment within 63
 * characters (the closed SQL name's bound, one under a symbol's), so the subject still prints.
 * @param {string} subject @param {number} k
 */
function withOrdinal(subject, k) {
  const suffix = `_${String(k)}`
  const cut = Math.max(subject.lastIndexOf('.'), subject.lastIndexOf('#')) + 1
  return `${subject.slice(0, cut)}${subject.slice(cut, cut + 63 - suffix.length)}${suffix}`
}

/**
 * This module and every tools/lib module it reaches through relative static imports, as
 * file URLs, sorted: the bytes that define what the extractor computes.
 * @returns {URL[]}
 */
function importClosure() {
  const seen = new Map()
  const queue = [new URL(import.meta.url)]
  while (queue.length > 0) {
    const url = queue.shift()
    if (seen.has(url.href)) continue
    const text = readFileSync(url, 'utf8')
    seen.set(url.href, url)
    for (const m of text.matchAll(/^import\s[^;]*?from\s+'(\.\/[^']+)'/gm)) {
      queue.push(new URL(m[1], url))
    }
  }
  return [...seen.values()].sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0))
}

/**
 * The extractor digest, printed as `x`: sha256 of this module and its tools/lib import
 * closure (bytes only, never a path), plus the parser's version and TOKEN_CONVENTION, first
 * 12 hex. A TypeScript patch release or an edit to any module the extractor runs changes it.
 * @param {{ version?: string } | null} ts
 */
export function extractorDigest(ts) {
  const h = createHash('sha256')
  for (const url of importClosure()) {
    h.update(readFileSync(url))
    h.update('\0')
  }
  h.update(`${ts?.version ?? 'no-parser'}\0${TOKEN_CONVENTION}`)
  return h.digest('hex').slice(0, 12)
}
