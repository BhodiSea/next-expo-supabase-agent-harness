// tools/lib/shapes.mjs — the Single Home extractor (2.1.0, #186): one record per callable in
// the duplication gate's scope, for the exact, near-miss and complexity families of
// `node tools/check-duplication.mjs --sweep --json`. No verdict reads it yet: the gate's Stop
// run is L0 alone, and the exact rule goes live only with #201.
//
// SCOPE. The duplication scan roots (apps/*/src, the layered packages/*/*/src, apps/web/app
// and apps/web/lib), with L0's exclusions (tests, `generated/`, `*.gen.ts`,
// `database.types.ts`, `.d.ts`), plus supabase/migrations and supabase/schemas. TS callables
// are function declarations, function expressions and arrow functions bound to a `const`,
// and class methods, at any depth; each needs a body. SQL callables are the CREATE FUNCTION
// statements sql-parse.mjs reads, folded last-wins over the migration history (a function a
// later migration replaces is judged as replaced; one it drops is gone), with
// supabase/schemas filling in a function no migration defines.
//
// THE NORMALISER (one for both languages). Hashing starts at the parameter list: the name,
// `export` and every other modifier are outside it. Bound names (parameters, locals, inner
// function and class names, catch variables; in SQL parameters, DECLAREd variables and FOR
// loop variables) become `$1…$n` in order of first occurrence, and the callable's own name
// becomes `$f`. Properties after `.` and `?.`, object keys, free identifiers and type tokens
// stay as written. String, template, regex and JSX-text literals become `S`, numbers `N`.
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
// body's braces, and the body is tokenised like the rest. Two normalisers can disagree by
// one token on the same body (the plan's prototype and its fact-check did, at `useTheme`
// 29/30): this paragraph is what fixes the count.
//
// Data-shaped bodies are never owed: a body is data-shaped when its repetition ratio is
// under 0.5 or its literal density is over 0.5. The repetition ratio (RNR) is the share of
// tokens of the normalised stream NOT inside a tandem repeat: a token is repeated when it
// sits in a run that repeats the run just before it (periods 1 to 16), from the second copy
// on. Literal density is the share of `S` and `N` tokens.
//
// THE PARSER is the project's own `typescript`, loaded by the caller through loadParser()
// (lib/i18n-tree.mjs) and passed in; syntax only (createSourceFile, no program). The SQL legs
// need no parser.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './fs-walk.mjs'
import { parseFunctions, qualify, splitStatements } from './sql-parse.mjs'

/**
 * The token convention, verbatim in the extractor digest: a change to what counts as a token
 * is a change to every class near FLOOR, so it changes `x` with the code.
 */
export const TOKEN_CONVENTION =
  'tc1: from the parameter list open paren through the body end; parens, types, return type, arrow, braces, trailing commas and written semicolons count; a bare arrow parameter counts its implied parens; type parameters do not count; a template literal is one S per literal part; SQL keywords and unquoted names lower-cased; each body dollar quote is one $$ token'

// ---- scope ------------------------------------------------------------------------------
// The duplication gate's scan roots, moved here (2.1.0) so the gate's L0 scan and the
// extractor read ONE list. See check-duplication.mjs for why apps/web is named and the
// layered groups are descended.

/** `<scope>/<d>/src`, or for a layered group `<scope>/<d>/<inner>/src`, in a fixed order. */
function srcRootsUnder(scope) {
  if (!existsSync(scope)) return []
  return readdirSync(scope)
    .sort()
    .flatMap((d) => {
      const src = join(scope, d, 'src')
      if (existsSync(src)) return [src]
      const groupDir = join(scope, d)
      return readdirSync(groupDir)
        .sort()
        .map((inner) => join(groupDir, inner, 'src'))
        .filter((nested) => existsSync(nested))
    })
}

/** @returns {string[]} the TS scan roots, relative, in a fixed order */
export function duplicationScanRoots() {
  const web = [join('apps', 'web', 'app'), join('apps', 'web', 'lib')].filter((d) => existsSync(d))
  return [...srcRootsUnder('apps'), ...srcRootsUnder('packages'), ...web]
}

/** The walk filter both scans apply to a path relative to its root. @param {string} rel */
export const isScannedName = (rel) =>
  /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel) && !/\.d\.ts$/.test(rel)

/** A machine-written module, by path. @param {string} path */
export const isGeneratedPath = (path) =>
  /\.gen\.tsx?$/.test(path) ||
  /(^|\/)generated\//.test(path) ||
  /(^|\/)database\.types\.ts$/.test(path)

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
export function workspaceOf(path, cache) {
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
 *   lang: 'ts' | 'sql', path: string, line: number, name: string, subject: string,
 *   workspace: { dir: string, name: string }, kind: 'function' | 'method' | 'sql',
 *   exported: boolean, tokens: number, stmts: number, arity: number,
 *   alpha: string, lit: string, stream: string[], literals: string[], sig: string[],
 *   mh: number[], dataShaped: boolean, rnr: number, jsxShare: number,
 *   node?: TsNode, file?: TsFile, body?: string,
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
 * declarations, function expressions and arrows bound to a `const`, class methods.
 * @returns {{ node: TsNode, name: string, own: string, kind: 'function' | 'method', exported: boolean }[]}
 */
function callableNodes(ts, sf, localExports) {
  const out = []
  const visit = (node) => {
    const found = callableOf(ts, node, localExports)
    if (found !== null) out.push(found)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return out
}

function callableOf(ts, node, localExports) {
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
    return { node, name: `${className}.${method}`, own: method, kind: 'method', exported }
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
  const params = kids.findIndex((k) => k.kind === ts.SyntaxKind.SyntaxList && k.pos >= fn.parameters.pos)
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
 * @param {any} ts @param {TsNode} fn @param {TsNode} sf @param {string} own
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
  const acc = { stream: [], verbatim: [], literals: [], jsx: 0, slot, expand }
  for (const leaf of leafTokens(ts, fn, sf)) pushLeaf(ts, leaf, sf, acc)
  return { stream: acc.stream, verbatim: acc.verbatim, literals: acc.literals, jsx: acc.jsx }
}

/** One leaf token into the normalised stream and its verbatim twin. */
function pushLeaf(ts, leaf, sf, acc) {
  if (leaf.synthetic !== undefined) {
    acc.stream.push(leaf.synthetic)
    acc.verbatim.push(leaf.synthetic)
    return
  }
  if (insideJsx(ts, leaf)) acc.jsx += 1
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

function pushIdentifier(ts, id, { slot, stream, verbatim, expand }) {
  const text = id.text
  if (keptPosition(ts, id)) {
    stream.push(text)
    verbatim.push(text)
    return
  }
  if (expand && shorthandPosition(ts, id)) {
    stream.push(text, ':')
    verbatim.push(text, ':')
  }
  const value = slot(text)
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
    literals: norm.literals,
    mh: minhash(set),
    shingles: set,
    rnr,
    dataShaped: rnr < 0.5 || literalDensity(stream) > 0.5,
    jsxShare: stream.length === 0 ? 0 : norm.jsx / stream.length,
  }
}

// ---- SQL --------------------------------------------------------------------------------

// One token per lexeme: comments, quoted strings (E'', '', dollar-quoted), numbers, quoted
// and unquoted names, the multi-character operators, then any other single character.
const SQL_TOKEN =
  /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|(\s+)|([eE]?'(?:''|\\.|[^'])*')|(\$([A-Za-z_]\w*)?\$)|(\d+(?:\.\d+)?)|("(?:""|[^"])*")|([A-Za-z_][\w$]*)|(::|:=|<>|!=|>=|<=|\|\||->>|->|=>|[^\s])/g

/**
 * Tokenise a SQL text: comments and whitespace dropped, names lower-cased, a nested
 * dollar-quoted string one literal, and a top-level `$tag$` one `$$` delimiter.
 * @param {string} text @returns {{ value: string, literal: boolean, raw: string }[]}
 */
function sqlTokens(text) {
  const out = []
  let open = null
  const re = new RegExp(SQL_TOKEN.source, 'g')
  let m = re.exec(text)
  while (m !== null) {
    const [whole, lineC, blockC, ws, str, dollar, , num, quoted, word] = m
    if (lineC === undefined && blockC === undefined && ws === undefined) {
      if (dollar !== undefined) {
        const r = dollarToken(text, re, whole, open)
        open = r.open
        out.push(r.token)
      } else if (str !== undefined) out.push({ value: 'S', literal: true, raw: whole })
      else if (num !== undefined) out.push({ value: 'N', literal: true, raw: whole })
      else if (quoted !== undefined) out.push({ value: quoted.slice(1, -1), literal: false, raw: whole })
      else if (word !== undefined) out.push({ value: word.toLowerCase(), literal: false, raw: whole })
      else out.push({ value: whole, literal: false, raw: whole })
    }
    m = re.exec(text)
  }
  return out
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

/** DECLAREd variables and FOR loop variables of a PL/pgSQL body. */
function sqlLocals(body) {
  const names = []
  const declare = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(body ?? '')
  if (declare !== null) {
    for (const decl of declare[1].split(';')) {
      const m = /^\s*([A-Za-z_]\w*)\s+/.exec(decl)
      if (m !== null) names.push(m[1].toLowerCase())
    }
  }
  for (const m of (body ?? '').matchAll(/\bFOR\s+([A-Za-z_]\w*)\s+IN\b/gi)) {
    names.push(m[1].toLowerCase())
  }
  return names
}

/**
 * The normalised stream of one SQL function: from the parameter list's `(` to the end of
 * the statement.
 */
function normaliseSql(fn, { schema, name }) {
  const open = fn.stmt.indexOf('(')
  const tokens = sqlTokens(fn.stmt.slice(open))
  const bound = new Set([...fn.params.map((p) => p.name), ...sqlLocals(fn.body)])
  const numbering = new Map()
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
    const value = sqlSlot(t.value, { tokens, i, schema, name, bound, numbering })
    if (value === null) continue
    stream.push(value)
    verbatim.push(value)
  }
  return { stream, verbatim, literals, jsx: 0 }
}

/** The normalised value of one SQL token, or null when it is folded into the one before. */
function sqlSlot(value, { tokens, i, schema, name, bound, numbering }) {
  const prev = tokens[i - 1]?.value
  if (value === schema && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === name) {
    return '$f'
  }
  if ((value === '.' || value === name) && tokens[i - (value === '.' ? 1 : 2)]?.value === schema) {
    const owner = value === '.' ? tokens[i + 1]?.value : value
    if (owner === name) return null
  }
  if (prev === '.' || !bound.has(value)) return value
  if (!numbering.has(value)) numbering.set(value, `$${numbering.size + 1}`)
  return numbering.get(value)
}

/** The 1-based line of a function's CREATE in its file, matched in order by name. */
function sqlLines(raw, fns) {
  const lines = []
  let cursor = 0
  for (const fn of fns) {
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w]+"?(?:\s*\.\s*"?[\w]+"?)?)\s*\(/gi
    re.lastIndex = cursor
    let m = re.exec(raw)
    while (m !== null && qualify(m[1].replace(/["\s]/g, '')).qualified !== fn.qualified) {
      m = re.exec(raw)
    }
    if (m === null) {
      lines.push(1)
      continue
    }
    cursor = m.index + m[0].length
    lines.push(raw.slice(0, m.index).split('\n').length)
  }
  return lines
}

const DROP_FUNCTION = /^DROP FUNCTION (?:IF EXISTS )?([a-z0-9_.]+)/i

/**
 * The SQL functions in scope, folded: the last definition across supabase/migrations wins
 * and a later `DROP FUNCTION` removes it; supabase/schemas fills in what no migration
 * defines.
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
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    foldSqlFile(`${dir}/${f}`, live)
  }
  return live
}

/** Apply one SQL file's CREATE FUNCTION and DROP FUNCTION statements to `live`. */
function foldSqlFile(path, live) {
  const raw = readFileSync(path, 'utf8')
  const statements = splitStatements(raw)
  const fns = parseFunctions(statements)
  const lines = sqlLines(raw, fns)
  let k = 0
  for (const stmt of statements) {
    const drop = DROP_FUNCTION.exec(stmt)
    if (drop !== null) {
      live.delete(qualify(drop[1]).qualified)
      continue
    }
    if (!/^CREATE (?:OR REPLACE )?FUNCTION /i.test(stmt)) continue
    const fn = fns[k]
    const line = lines[k]
    k += 1
    if (fn === undefined) continue
    live.set(fn.qualified, sqlCallable(fn, path, line))
  }
}

const SQL_WORKSPACE = Object.freeze({ dir: 'supabase', name: 'supabase' })

/** @returns {Callable} */
function sqlCallable(fn, path, line) {
  const norm = normaliseSql(fn, fn)
  const sigEnd = norm.stream.indexOf(')')
  const body = fn.body ?? ''
  return finish({
    lang: 'sql',
    path,
    line,
    name: fn.qualified,
    workspace: SQL_WORKSPACE,
    kind: 'sql',
    exported: true,
    stmts: body.split(';').filter((s) => s.trim() !== '').length,
    arity: fn.params.filter((p) => p.raw.trim() !== '').length,
    sig: sigEnd === -1 ? [] : norm.stream.slice(0, sigEnd + 1),
    norm,
    body,
  })
}

// ---- the tree ---------------------------------------------------------------------------

/**
 * Extract the whole tree. `ts` null runs the SQL half only (the TS legs are then
 * incomplete, which is the caller's to report). Subject ids follow v2's table: an exported
 * callable is `<package>#<name>`, an unexported one `<path>#<name>`, a method
 * `<path>#<Class>.<method>`, a SQL function `sql:<schema>.<fn>`; an exported name two files
 * of one package share falls back to the path form, so every subject is unique.
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

/** @param {Callable[]} callables */
function assignSubjects(callables) {
  const pkgForm = (c) => `${c.workspace.name}#${c.name}`
  const counts = new Map()
  for (const c of callables) {
    if (c.lang === 'ts' && c.exported && c.kind === 'function') {
      counts.set(pkgForm(c), (counts.get(pkgForm(c)) ?? 0) + 1)
    }
  }
  const seen = new Map()
  for (const c of callables) {
    if (c.lang === 'sql') c.subject = `sql:${c.name}`
    else if (c.kind === 'function' && c.exported && counts.get(pkgForm(c)) === 1) {
      c.subject = pkgForm(c)
    } else c.subject = `${c.path}#${c.name}`
    // Two unexported functions of one name in one file (nested helpers): the later ones
    // carry their line, so a subject still names one callable.
    const n = (seen.get(c.subject) ?? 0) + 1
    seen.set(c.subject, n)
    if (n > 1) c.subject = `${c.subject}@${String(c.line)}`
  }
}

// ---- the digest -------------------------------------------------------------------------

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
