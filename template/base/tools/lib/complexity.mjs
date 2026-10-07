// tools/lib/complexity.mjs — the six complexity families (B3) of the duplication sweep
// (2.1.0, #186). Whole-tree, syntax only, over the trees shapes.mjs already parsed. Every fact
// is advisory and never owed: they reach a reviewer as packet items (#187) and an issue only
// after eval B measures a family precise enough (#205), so a recipe here is a question worth
// asking, never a verdict.
//
// The families, in precedence order. A function yields at most ONE record, under its
// highest-precedence family, with its lower matches as `also`.
//   1. pass-through — the body is `return [await] g(…)` passing exactly its own parameters,
//      in order. Excluded: tRPC handlers (a file under `routers/` or importing
//      `@trpc/server`), `'use server'` actions, `route.ts` handlers, and port adapters (a
//      vertical file that imports a structural port.ts, the test vertical-anatomy.mjs's
//      importsAPort applies).
//   2. helper-split — a function calls at least 2 private helpers of its file that nothing
//      else calls, or one such helper that takes at least 3 of its locals as arguments
//      ("conjoined"). A helper that is ever passed by reference (a callback) is not one.
//      Facts: {helpers, conjoined, lines} (at most 4 helper lines).
//   3. intent-hiding — a one-expression function whose expression is at most 12 tokens and
//      that has at most 2 call sites, or whose name has as many words as its expression has
//      tokens. Excluded: type guards, `use*` hooks.
//   4. single-consumer — an exported interface, type, function or class with exactly 1
//      non-test importing file. Excluded: `src/data/port.ts`, `page.tsx`, `layout.tsx`,
//      `route.ts`, `page.meta.ts`, barrels and `packages/shared/*` (the rule of two, #191,
//      owns those).
//   5. bool-selector — a boolean parameter that is the top-level split (the first statement
//      is `if (p)` / `if (!p)`, or the body is `p ? … : …`), or that is passed a literal
//      `true` or `false` at 2 or more call sites. Excluded: functions that return JSX.
//   6. edge-guard — an early `return` of `[]`, `null`, `undefined`, `0`, `''` or `false`
//      under an emptiness test (`.length`/`.size` against 0, or `!x.length`; never
//      `!x?.length`, which a null `x` passes too) or a null test, before a general path that
//      yields the same value on that input: a returned `map`/`filter`/`flatMap`, a `reduce`
//      seeded with the same literal, or a `for…of` whose accumulator starts at it and is
//      returned by the very next statement (after a null test, only an optional-chained
//      general path qualifies). Between the guard and that path, and between the
//      accumulator's declaration and the guard, stand only inert statements: declarations of
//      plain names to literals (or arrays and objects of them), so nothing there can throw,
//      return or change the value on that input. Facts: {returns, generalLine, generalKind}.
//
// CALL SITES are counted syntactically, by callee name: calls of the function's own name in
// its file, plus calls of the local name (or `ns.name`) each importing file binds, in the
// files importers.mjs resolves. A call through any other alias is not seen.
// NOT COMPUTED here: D.2's `new` fact (the sweep is whole-tree and base-free; #187 computes
// `new` against the merge base, for ordering only). RECORDED GAP: no recipe measures
// provenance-induced slop (helpers split only to pass a complexity cap, wrappers added only
// to cross a layer); eval D measures it outside the tree.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dottedCallee, symbol } from './closed-text.mjs'
import { exportName } from './homes.mjs'
import { blankComments } from './source-text.mjs'
import { importsAPort } from './vertical-anatomy.mjs'

/** The families, in precedence order. */
export const COMPLEXITY_FAMILIES = [
  'pass-through',
  'helper-split',
  'intent-hiding',
  'single-consumer',
  'bool-selector',
  'edge-guard',
]

/** @typedef {import('./shapes.mjs').Callable} Callable */
/** @typedef {import('./shapes.mjs').TsFile} TsFile */
/** @typedef {ReturnType<typeof import('./importers.mjs').buildImporters>} Importers */
/**
 * @typedef {{ family: string, subject: string, path: string, line: number, name: string,
 *   fp: string, tokens: number, typed?: boolean, facts: Record<string, any> }} Hit
 */

// ---- the shared context -------------------------------------------------------------------

/**
 * Everything the recipes read: the parsed files, the importer index, and a lazy parse of
 * any importing file outside the extractor's scope.
 */
class Tree {
  /** @param {any} ts @param {TsFile[]} files @param {Importers} importers */
  constructor(ts, files, importers) {
    this.ts = ts
    this.importers = importers
    /** @type {Map<string, any>} */
    this.sources = new Map(files.map((f) => [f.path, f.sf]))
    /** @type {Map<string, Map<string, any[]>>} */
    this.calls = new Map()
  }

  /** The syntax tree of a file, parsed once. */
  sf(path) {
    if (!this.sources.has(path)) {
      const kind = path.endsWith('.tsx') ? this.ts.ScriptKind.TSX : this.ts.ScriptKind.TS
      const text = readFileSync(path, 'utf8')
      this.sources.set(
        path,
        this.ts.createSourceFile(path, text, this.ts.ScriptTarget.Latest, true, kind),
      )
    }
    return this.sources.get(path)
  }

  /** Every call expression of a file, by callee text (`f` or `ns.f`). */
  callsIn(path) {
    if (!this.calls.has(path)) this.calls.set(path, indexCalls(this.ts, this.sf(path)))
    return this.calls.get(path)
  }

  /**
   * Every syntactic call of a callable: its own name in its file, and each importing file's
   * local names for it.
   * @param {Callable} c @returns {{ path: string, call: any }[]}
   */
  callSites(c) {
    const out = (this.callsIn(c.path).get(c.name) ?? []).map((call) => ({ path: c.path, call }))
    const name = exportName(c, this.importers)
    if (name === null) return out
    for (const imp of this.importers.importersOf(c.path, name)) {
      if (imp.file === c.path) continue
      for (const local of imp.locals) {
        for (const call of this.callsIn(imp.file).get(local) ?? [])
          out.push({ path: imp.file, call })
      }
    }
    return out
  }
}

/** The callee text of every call in a file: `f(…)` → `f`, `ns.f(…)` → `ns.f`. */
function indexCalls(ts, sf) {
  const map = new Map()
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const e = node.expression
      let key = null
      if (ts.isIdentifier(e)) key = e.text
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        key = `${e.expression.text}.${e.name.text}`
      }
      if (key !== null) map.set(key, [...(map.get(key) ?? []), node])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return map
}

const lineAt = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/** A function body's statements; an expression body is one return of it. */
function bodyStatements(ts, fn) {
  if (fn.body === undefined) return []
  if (ts.isBlock(fn.body)) return [...fn.body.statements]
  return [{ kind: ts.SyntaxKind.ReturnStatement, expression: fn.body, synthetic: true }]
}

/** The returned expression of a one-expression function, or null. */
function soleExpression(ts, fn) {
  const st = bodyStatements(ts, fn)
  if (st.length !== 1 || st[0].kind !== ts.SyntaxKind.ReturnStatement) return null
  return st[0].expression ?? null
}

/** An expression without its parentheses and `as`/`satisfies` wrappers; undefined for none. */
export function unwrap(ts, e) {
  let n = e ?? undefined
  while (
    n !== undefined &&
    (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n))
  ) {
    n = n.expression
  }
  return n
}

/** The text of a callee, dotted, when every segment is an identifier; else null. */
export function calleeText(ts, e) {
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    const head = calleeText(ts, e.expression)
    return head === null ? null : `${head}.${e.name.text}`
  }
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  return null
}

// ---- 1. pass-through -----------------------------------------------------------------------

/** Is the callable's file a transport seam the recipe excludes? */
function transportSeam(c, file) {
  const path = c.path
  if (/(^|\/)route\.tsx?$/.test(path) || /(^|\/)routers\//.test(path)) return true
  const text = blankComments(file.src)
  if (/^\s*(['"])use server\1/.test(text) || /from\s*['"]@trpc\/server/.test(text)) return true
  const m = /^(packages\/verticals\/[^/]+\/src)\/(.+)$/.exec(path)
  return m !== null && importsAPort(m[1], m[2], text)
}

/** @param {Tree} tree @param {Callable} c @param {TsFile} file */
function passThrough(tree, c, file) {
  const { ts } = tree
  const fn = c.node
  let e = unwrap(ts, soleExpression(ts, fn))
  if (e === undefined) return null
  const awaited = ts.isAwaitExpression(e)
  if (awaited) e = unwrap(ts, e.expression)
  if (!ts.isCallExpression(e)) return null
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null))
  if (params.includes(null) || e.arguments.length !== params.length) return null
  if (!e.arguments.every((a, i) => ts.isIdentifier(a) && a.text === params[i])) return null
  const callee = calleeText(ts, e.expression)
  if (callee === null || transportSeam(c, file)) return null
  // A callee the closed printer cannot print stays out of the facts; the hit does not.
  return { ...(dottedCallee.ok(callee) ? { callee } : {}), awaited, arity: params.length }
}

// ---- 2. helper-split ----------------------------------------------------------------------

/** Is a callable declared at the top level of its file? */
function topLevel(ts, c, sf) {
  if (ts.isFunctionDeclaration(c.node)) return c.node.parent === sf
  // arrow → VariableDeclaration → VariableDeclarationList → VariableStatement → SourceFile
  return c.node.parent?.parent?.parent?.parent === sf
}

/**
 * The file's private top-level helpers that are called exactly once and never referenced
 * otherwise (a helper passed by reference is a callback, not a split), each with its call.
 */
function singleCallHelpers(ts, file) {
  const helpers = new Map()
  for (const c of file.callables) {
    if (c.kind === 'function' && !c.exported && topLevel(ts, c, file.sf)) {
      helpers.set(c.name, { c, refs: 0, calls: [] })
    }
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && helpers.has(node.text) && !isDeclarationName(ts, node)) {
      const h = helpers.get(node.text)
      const p = node.parent
      if (ts.isCallExpression(p) && p.expression === node) h.calls.push(p)
      else h.refs += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sf)
  return [...helpers.values()].filter((h) => h.calls.length === 1 && h.refs === 0)
}

function isDeclarationName(ts, id) {
  const p = id.parent
  return (
    (ts.isFunctionDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isPropertyAccessExpression(p)) &&
    p.name === id
  )
}

/** The function node a call sits in (the nearest enclosing callable of the file). */
function enclosing(ts, node, byNode) {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (byNode.has(p)) return byNode.get(p)
  }
  return null
}

/** Bound names of a callable (parameters and locals), by text. */
function localsOf(ts, fn) {
  const names = new Set()
  const visit = (node) => {
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return names
}

/** helper-split hits for one file, keyed by the calling callable. */
function helperSplits(tree, file) {
  const { ts } = tree
  const byNode = new Map(file.callables.map((c) => [c.node, c]))
  const perCaller = new Map()
  for (const h of singleCallHelpers(ts, file)) {
    const caller = enclosing(ts, h.calls[0], byNode)
    if (caller === null || caller === h.c) continue
    const locals = localsOf(ts, caller.node)
    const taken = h.calls[0].arguments.filter(
      (a) => ts.isIdentifier(a) && locals.has(a.text),
    ).length
    const entry = perCaller.get(caller) ?? { helpers: [], conjoined: 0 }
    entry.helpers.push(h.c)
    if (taken >= 3) entry.conjoined += 1
    perCaller.set(caller, entry)
  }
  const out = new Map()
  for (const [caller, { helpers, conjoined }] of perCaller) {
    if (helpers.length < 2 && conjoined < 1) continue
    const lines = helpers
      .map((h) => h.line)
      .sort((a, b) => a - b)
      .slice(0, 4)
    out.set(caller, { helpers: helpers.length, conjoined, lines })
  }
  return out
}

// ---- 3. intent-hiding ---------------------------------------------------------------------

/** Words in an identifier: camelCase, PascalCase, snake_case and digits split. */
const nameWords = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean).length

/** The leaf tokens under a node, counted as shapes.mjs counts a body's (empty lists are none). */
function tokenCount(ts, node, sf) {
  const kids = node.getChildren(sf)
  if (kids.length === 0) return node.kind === ts.SyntaxKind.SyntaxList ? 0 : 1
  return kids.reduce((n, k) => n + tokenCount(ts, k, sf), 0)
}

/** @param {Tree} tree @param {Callable} c */
function intentHiding(tree, c) {
  const { ts } = tree
  const fn = c.node
  const expr = soleExpression(ts, fn)
  if (expr === null) return null
  if (/^use[A-Z0-9]/.test(c.name.split('.').at(-1))) return null
  if (fn.type !== undefined && ts.isTypePredicateNode(fn.type)) return null
  const tokens = tokenCount(ts, expr, c.file.sf)
  const words = nameWords(c.name.split('.').at(-1))
  const calls = c.kind === 'function' ? tree.callSites(c).length : 0
  if ((tokens <= 12 && calls <= 2) || words === tokens) return { tokens, calls, words }
  return null
}

// ---- 4. single-consumer -------------------------------------------------------------------

const SINGLE_CONSUMER_EXCLUDED = [
  /(^|\/)src\/data\/port\.ts$/,
  /(^|\/)page\.tsx$/,
  /(^|\/)layout\.tsx$/,
  /(^|\/)route\.ts$/,
  /(^|\/)page\.meta\.ts$/,
  /^packages\/shared\//,
]

/** A declaration's fingerprint: its text with whitespace runs collapsed, hashed to 12 hex. */
const textFp = (text) =>
  createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex').slice(0, 12)

/** The exported interface/type/function/class declarations of a file: name → {kind, line, fp}. */
function exportedDeclarations(ts, file) {
  const out = new Map()
  const exported = (node, name) =>
    (ts.getModifiers?.(node) ?? node.modifiers ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    ) || file.localExports.has(name)
  for (const st of file.sf.statements) {
    const kind = declarationKind(ts, st)
    if (kind === null) continue
    for (const name of declaredNames(ts, st, kind)) {
      if (exported(st, name))
        out.set(name, { kind, line: lineAt(file.sf, st), fp: textFp(st.getText(file.sf)) })
    }
  }
  return out
}

function declarationKind(ts, st) {
  if (ts.isInterfaceDeclaration(st)) return 'interface'
  if (ts.isTypeAliasDeclaration(st)) return 'type'
  if (ts.isClassDeclaration(st)) return 'class'
  if (ts.isFunctionDeclaration(st) && st.body !== undefined) return 'function'
  if (ts.isVariableStatement(st)) {
    const fnish = st.declarationList.declarations.every(
      (d) =>
        d.initializer !== undefined &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)),
    )
    return fnish ? 'function' : null
  }
  return null
}

function declaredNames(ts, st, kind) {
  if (kind === 'function' && ts.isVariableStatement(st)) {
    return st.declarationList.declarations
      .filter((d) => ts.isIdentifier(d.name))
      .map((d) => d.name.text)
  }
  return st.name === undefined ? [] : [st.name.text]
}

/**
 * single-consumer hits for one file: name → {kind, line, importer}.
 * @param {Tree} tree @param {TsFile} file
 */
function singleConsumers(tree, file) {
  const out = new Map()
  if (SINGLE_CONSUMER_EXCLUDED.some((re) => re.test(file.path))) return out
  if (tree.importers.isBarrel(file.path)) return out
  for (const [name, decl] of exportedDeclarations(tree.ts, file)) {
    const as = tree.importers.defaultName(file.path) === name ? 'default' : name
    const imps = tree.importers.importersOf(file.path, as).filter((i) => i.file !== file.path)
    if (imps.length === 1) out.set(name, { ...decl, importer: imps[0].file })
  }
  return out
}

// ---- 5. bool-selector ---------------------------------------------------------------------

function returnsJsx(ts, fn) {
  let found = false
  const visit = (node) => {
    if (found) return
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      found = true
      return
    }
    if (node !== fn && ts.isFunctionLike(node)) return
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return found
}

const isBooleanParam = (ts, p) =>
  p.type?.kind === ts.SyntaxKind.BooleanKeyword ||
  p.initializer?.kind === ts.SyntaxKind.TrueKeyword ||
  p.initializer?.kind === ts.SyntaxKind.FalseKeyword

/** Is the parameter (or its negation) the condition of the body's top-level split? */
function topLevelSplit(ts, fn, name) {
  const isParam = (e) => {
    const u = unwrap(ts, e)
    if (u === undefined) return false
    if (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.ExclamationToken) {
      return isParam(u.operand)
    }
    return ts.isIdentifier(u) && u.text === name
  }
  const first = bodyStatements(ts, fn)[0]
  if (first === undefined) return false
  if (first.kind === ts.SyntaxKind.IfStatement) return isParam(first.expression)
  const e = first.kind === ts.SyntaxKind.ReturnStatement ? unwrap(ts, first.expression) : undefined
  return e !== undefined && ts.isConditionalExpression(e) && isParam(e.condition)
}

/** @param {Tree} tree @param {Callable} c */
function boolSelector(tree, c) {
  const { ts } = tree
  const fn = c.node
  if (returnsJsx(ts, fn)) return null
  const sites = c.kind === 'function' ? tree.callSites(c) : []
  for (const [index, p] of fn.parameters.entries()) {
    if (!ts.isIdentifier(p.name) || !isBooleanParam(ts, p)) continue
    const split = topLevelSplit(ts, fn, p.name.text)
    const literalSites = sites.filter(({ call }) => {
      const a = call.arguments[index]
      return (
        a !== undefined &&
        (a.kind === ts.SyntaxKind.TrueKeyword || a.kind === ts.SyntaxKind.FalseKeyword)
      )
    }).length
    if (split || literalSites >= 2) {
      const param = symbol.ok(p.name.text) ? { param: p.name.text } : {}
      return { ...param, index, split, literalSites }
    }
  }
  return null
}

// ---- 6. edge-guard ------------------------------------------------------------------------

/** The literal an early return yields, as a closed enum, or null. */
function guardValue(ts, e) {
  const u = unwrap(ts, e)
  if (u === undefined) return 'undefined'
  if (ts.isArrayLiteralExpression(u) && u.elements.length === 0) return 'empty-array'
  if (u.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isIdentifier(u) && u.text === 'undefined') return 'undefined'
  if (ts.isNumericLiteral(u) && u.text === '0') return 'zero'
  if ((ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) && u.text === '')
    return 'empty-string'
  if (u.kind === ts.SyntaxKind.FalseKeyword) return 'false'
  return null
}

/** The subject and kind of an emptiness or null test, or null. */
function guardTest(ts, cond) {
  const u = unwrap(ts, cond)
  if (u === undefined) return null
  if (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.ExclamationToken) {
    const sized = negatedSize(ts, u.operand)
    return sized !== null ? { subject: sized, test: 'empty' } : null
  }
  if (!ts.isBinaryExpression(u)) return null
  const op = u.operatorToken.kind
  const eq = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(op)
  if (!eq) return null
  const sized = sizeOf(ts, unwrap(ts, u.left))
  if (sized !== null && ts.isNumericLiteral(u.right) && u.right.text === '0')
    return { subject: sized, test: 'empty' }
  const nul =
    u.right.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(u.right) && u.right.text === 'undefined')
  if (nul && ts.isIdentifier(u.left)) return { subject: u.left.text, test: 'null' }
  return null
}

/** `x.length` / `x.size` → `x`. */
function sizeOf(ts, e) {
  if (e === undefined || !ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression))
    return null
  return ['length', 'size'].includes(e.name.text) ? e.expression.text : null
}

/**
 * The `x` of `!x.length` / `!x.size`. Not of `!x?.length`: a null `x` passes that test too,
 * and no general path yields the guarded value on null.
 */
function negatedSize(ts, operand) {
  const inner = unwrap(ts, operand)
  return inner !== undefined && ts.isOptionalChain(inner) ? null : sizeOf(ts, inner)
}

/** An early `if (test) return X` as {subject, test, returns}, or null. */
function earlyReturn(ts, st) {
  if (st.kind !== ts.SyntaxKind.IfStatement || st.elseStatement !== undefined) return null
  let then = st.thenStatement
  if (ts.isBlock(then)) {
    if (then.statements.length !== 1) return null
    then = then.statements[0]
  }
  if (!ts.isReturnStatement(then)) return null
  const returns = guardValue(ts, then.expression)
  const test = guardTest(ts, st.expression)
  return returns === null || test === null ? null : { ...test, returns }
}

const GENERAL_METHODS = new Set(['map', 'filter', 'flatMap'])

/**
 * The kind of a returned `subject.map/filter/flatMap(…)` or seeded `subject.reduce(…)` that
 * yields the guarded value on the guarded input, or null.
 */
function generalPath(ts, st, guard) {
  if (st.kind !== ts.SyntaxKind.ReturnStatement) return null
  const e = unwrap(ts, st.expression)
  if (e === undefined || !ts.isCallExpression(e)) return null
  const callee = e.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null
  if (callee.expression.text !== guard.subject) return null
  const method = callee.name.text
  const seed = method === 'reduce' ? e.arguments[1] : undefined
  if (!GENERAL_METHODS.has(method) && seed === undefined) return null
  // After a null test only `subject?.m(…)` yields the guard's `undefined` on that input.
  if (guard.test === 'null') {
    return callee.questionDotToken !== undefined && guard.returns === 'undefined' ? method : null
  }
  if (seed === undefined) return guard.returns === 'empty-array' ? method : null
  return guardValue(ts, seed) === guard.returns ? method : null
}

/**
 * A value whose evaluation cannot throw: a literal, or an array or object of them (no
 * spread, no computed key).
 */
function inertValue(ts, e) {
  const u = unwrap(ts, e)
  if (u === undefined || ts.isLiteralExpression(u) || guardValue(ts, u) !== null) return true
  if (u.kind === ts.SyntaxKind.TrueKeyword) return true
  if (ts.isArrayLiteralExpression(u)) return u.elements.every((x) => inertValue(ts, x))
  if (!ts.isObjectLiteralExpression(u)) return false
  return u.properties.every(
    (p) =>
      ts.isPropertyAssignment(p) &&
      !ts.isComputedPropertyName(p.name) &&
      inertValue(ts, p.initializer),
  )
}

/**
 * Is a statement one that cannot throw, return or rebind the subject on any input? Only a
 * `let`/`const`/`var` of plain names (never the subject's) to inert values is.
 */
function inert(ts, st, subject) {
  if (!ts.isVariableStatement(st) || (st.declarationList.flags & ts.NodeFlags.Using) !== 0)
    return false
  return st.declarationList.declarations.every(
    (d) => ts.isIdentifier(d.name) && d.name.text !== subject && inertValue(ts, d.initializer),
  )
}

/** The last declaration of `name` in the first `end` body statements, with its index; or null. */
function lastDeclaration(ts, statements, end, name) {
  for (let at = end - 1; at >= 0; at -= 1) {
    const st = statements[at]
    const list = ts.isVariableStatement(st) ? st.declarationList.declarations : []
    const d = list.findLast((x) => ts.isIdentifier(x.name) && x.name.text === name)
    if (d !== undefined) return { at, d }
  }
  return null
}

/**
 * A `for (… of subject)` directly before the closing `return acc`, where `acc` was last
 * declared with the guarded value and only inert statements sit between that declaration
 * and the guard. generalAfter holds the statements from the guard to the loop to that rule.
 */
function forOfPath(ts, statements, at, guard) {
  const st = statements[at]
  const last = statements[at + 1]
  if (guard.test !== 'empty' || at !== statements.length - 2 || !ts.isForOfStatement(st))
    return false
  if (!ts.isIdentifier(st.expression) || st.expression.text !== guard.subject) return false
  const acc = ts.isReturnStatement(last) && last.expression !== undefined ? last.expression : null
  if (acc === null || !ts.isIdentifier(acc)) return false
  const decl = lastDeclaration(ts, statements, at, acc.text)
  if (decl === null || guardValue(ts, decl.d.initializer) !== guard.returns) return false
  return statements.slice(decl.at + 1, guard.at).every((s) => inert(ts, s, guard.subject))
}

/**
 * The first general path after the guard at `guard.at`, reached past inert statements only
 * (anything else might throw or return on the guarded input): {at, kind}, or null.
 */
function generalAfter(ts, statements, guard) {
  for (let j = guard.at + 1; j < statements.length; j += 1) {
    const kind = forOfPath(ts, statements, j, guard)
      ? 'for-of'
      : generalPath(ts, statements[j], guard)
    if (kind !== null) return { at: j, kind }
    if (!inert(ts, statements[j], guard.subject)) return null
  }
  return null
}

/** @param {Tree} tree @param {Callable} c @param {TsFile} file */
function edgeGuard(tree, c, file) {
  const { ts } = tree
  const statements = bodyStatements(ts, c.node).filter((s) => !s.synthetic)
  for (const [i, st] of statements.entries()) {
    const guard = earlyReturn(ts, st)
    if (guard === null) continue
    const general = generalAfter(ts, statements, { ...guard, at: i })
    if (general !== null) {
      return {
        returns: guard.returns,
        generalLine: lineAt(file.sf, statements[general.at]),
        generalKind: general.kind,
      }
    }
  }
  return null
}

// ---- the sweep's entry ---------------------------------------------------------------------

/**
 * The recipes in precedence order: each returns its facts for a callable, or null.
 * @type {[string, (tree: Tree, c: Callable, file: TsFile, ctx: any) => any][]}
 */
const RECIPES = [
  ['pass-through', (tree, c, file) => passThrough(tree, c, file)],
  ['helper-split', (_tree, c, _file, ctx) => ctx.splits.get(c) ?? null],
  ['intent-hiding', (tree, c) => intentHiding(tree, c)],
  ['single-consumer', (_tree, c, _file, ctx) => consumerFacts(c, ctx.consumers)],
  ['bool-selector', (tree, c) => boolSelector(tree, c)],
  ['edge-guard', (tree, c, file) => edgeGuard(tree, c, file)],
]

/** A callable's single-consumer facts, when it is an export with one importing file. */
function consumerFacts(c, consumers) {
  const decl = c.kind === 'function' && c.exported ? consumers.get(c.name) : undefined
  if (decl === undefined || decl.kind !== 'function') return null
  return { importers: 1, kind: decl.kind, importer: decl.importer }
}

/**
 * Every complexity hit in the tree, one per function (its highest-precedence family, the
 * rest as `also`) plus one per single-consumer type, interface or class. Pure over its
 * inputs; sorted by subject.
 * @param {any} ts @param {TsFile[]} files @param {Importers} importers
 * @returns {Hit[]}
 */
export function complexityHits(ts, files, importers) {
  const tree = new Tree(ts, files, importers)
  const hits = files.flatMap((file) => fileHits(tree, file))
  disambiguateTypes(hits)
  return hits.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
}

function fileHits(tree, file) {
  const ctx = { splits: helperSplits(tree, file), consumers: singleConsumers(tree, file) }
  const out = []
  for (const c of file.callables) {
    const found = RECIPES.map(([family, recipe]) => [family, recipe(tree, c, file, ctx)]).filter(
      ([, facts]) => facts !== null,
    )
    if (found.length === 0) continue
    const [family, top] = found[0]
    out.push(hit(family, c, { ...top, also: found.slice(1).map(([f]) => f) }))
  }
  for (const [name, decl] of ctx.consumers) {
    if (decl.kind !== 'function') out.push(typeHit(file, name, decl))
  }
  return out
}

/** Two type hits one package exports under one name take the path form of the subject. */
function disambiguateTypes(hits) {
  const count = new Map()
  for (const h of hits) count.set(h.subject, (count.get(h.subject) ?? 0) + 1)
  for (const h of hits) {
    if (h.typed === true && count.get(h.subject) > 1) h.subject = `${h.path}#${h.name}`
  }
}

/** @param {string} family @param {Callable} c @param {Record<string, any>} facts @returns {Hit} */
const hit = (family, c, facts) => ({
  family,
  subject: c.subject,
  path: c.path,
  line: c.line,
  name: c.name,
  fp: c.alpha,
  tokens: c.tokens,
  facts,
})

/** A single-consumer type, interface or class: its subject is the export itself. */
function typeHit(file, name, decl) {
  return {
    family: 'single-consumer',
    subject: `${file.workspace.name}#${name}`,
    path: file.path,
    line: decl.line,
    name,
    fp: decl.fp,
    tokens: 0,
    typed: true,
    facts: { importers: 1, kind: decl.kind, importer: decl.importer, also: [] },
  }
}
