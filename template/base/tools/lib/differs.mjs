// tools/lib/differs.mjs — the "differs at" facts of a near-miss pair (2.1.0, #186). Syntax
// only, over the trees and streams shapes.mjs already built. Two alignments:
//
//   - SWITCH ARMS. When both bodies hold a top-level `switch`, its arms align by label. A
//     label naming a file-local `const` (not a `let` or `var`, which may be reassigned)
//     initialised with a string or number literal aligns on that literal (N3), compared the
//     way `lit` compares it, as the verbatim token; the value never enters a fact, so two
//     mappers that name one SQLSTATE differently align instead of printing false one-sided
//     arms. Every other label aligns by its own text. `as`, `satisfies` and parentheses are
//     looked through, on a label and on a const's initialiser alike. An arm's callee is the
//     dotted callee of the call or `new` it returns, throws or evaluates first, read through
//     braces; "same" means equal callee text. Arms are counted both as labels and as case
//     groups (the labels that share one body).
//   - TOP-LEVEL STATEMENTS (the switch aside). They align by their normalised tokens with
//     the bound-name slots collapsed to `$`, so one extra statement does not renumber the
//     rest; the longest common subsequence aligns, and what is left over is one-sided. For
//     SQL the statements are the body's `;`-separated runs of the normalised stream, between
//     its `$$` delimiters, so a header that differs is never counted as a body statement.
//
// The facts are the shape closed-text.mjs's renderDiffersAt reads, flat so they fit a record:
// { arms: [{ aKind, aLabel?, bKind, bLabel?, aCallee?, bCallee? }], aOnly, bOnly }, each kind
// 'identifier' or 'literal', and `aOnly` / `bOnly` { labels, groups, statements }. An arm is
// listed only when its two callees differ, ordered by callee pair and then by A's arm order,
// so equal pairs sit together. A label's text is kept only when the printer renderDiffersAt
// uses for its kind can print it: a name must be a symbol, so a dotted one (`Code.Unique`)
// takes the literal kind with no text, and a literal written in the case itself must fit the
// case-label form; a label with no text prints as its arm's index. A callee is kept only
// when the dotted-callee printer admits it; a missing callee means the arm calls nothing, or
// nothing that printer can name.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { dottedCallee, symbol } from './closed-text.mjs'
import { calleeText, unwrap } from './complexity.mjs'

/** @typedef {import('./shapes.mjs').Callable} Callable */

const LITERAL_LABEL = /^[A-Za-z0-9_]{1,12}$/
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Is a variable statement a `const` (not `let`, `var` or `using`)? */
const isConst = (ts, st) =>
  (st.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const

/** The file's top-level `const NAME = <string or number literal>`s: name → verbatim token. */
function literalConsts(ts, sf) {
  const out = new Map()
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !isConst(ts, st)) continue
    for (const d of st.declarationList.declarations) {
      const init = unwrap(ts, d.initializer)
      if (!ts.isIdentifier(d.name) || init === undefined) continue
      if (
        ts.isStringLiteral(init) ||
        ts.isNumericLiteral(init) ||
        ts.isNoSubstitutionTemplateLiteral(init)
      ) {
        out.set(d.name.text, init.getText(sf))
      }
    }
  }
  return out
}

/** The first top-level `switch` of a block body, or null. */
function topSwitch(ts, fn) {
  if (fn.body === undefined || !ts.isBlock(fn.body)) return null
  return fn.body.statements.find((st) => ts.isSwitchStatement(st)) ?? null
}

/**
 * One case label: its kind, its printable text, and the key it aligns on. A name the symbol
 * printer refuses (a dotted `Code.Unique`) takes the literal kind with no text, whose
 * printer falls back to the arm's index.
 */
function caseLabel(ts, clause, consts, sf) {
  if (!ts.isCaseClause(clause)) return { kind: 'identifier', text: 'default', key: 'default' }
  const e = unwrap(ts, clause.expression)
  const named = calleeText(ts, e)
  if (named !== null) {
    const value = consts.get(named)
    const key = value === undefined ? `name:${named}` : `lit:${value}`
    return symbol.ok(named) ? { kind: 'identifier', text: named, key } : { kind: 'literal', key }
  }
  const cooked = ts.isStringLiteral(e) || ts.isNumericLiteral(e) ? e.text : null
  const text = cooked !== null && LITERAL_LABEL.test(cooked) ? cooked : undefined
  return { kind: 'literal', text, key: `lit:${e.getText(sf)}` }
}

/** The call or `new` a statement returns, throws or evaluates, past an `await`; or undefined. */
function statementCall(ts, st) {
  const e =
    ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isExpressionStatement(st)
      ? unwrap(ts, st.expression)
      : undefined
  const call = e !== undefined && ts.isAwaitExpression(e) ? unwrap(ts, e.expression) : e
  return call !== undefined && (ts.isCallExpression(call) || ts.isNewExpression(call))
    ? call
    : undefined
}

/**
 * The callee an arm's statements return, throw or evaluate first, read through braces: null
 * when the arm returns or throws before any call, undefined when it runs off its end.
 */
function armCallee(ts, statements) {
  for (const st of statements) {
    const inner = ts.isBlock(st) ? armCallee(ts, st.statements) : undefined
    if (inner !== undefined) return inner
    const call = statementCall(ts, st)
    if (call !== undefined) return calleeText(ts, call.expression)
    if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return null
  }
  return undefined
}

/** A switch's case groups: labels that share one body, with that body's callee. */
function caseGroups(ts, sw, sf) {
  const consts = literalConsts(ts, sf)
  const groups = []
  let labels = []
  for (const clause of sw.caseBlock.clauses) {
    labels.push(caseLabel(ts, clause, consts, sf))
    if (clause.statements.length === 0) continue
    groups.push({ labels, callee: armCallee(ts, clause.statements) ?? null })
    labels = []
  }
  if (labels.length > 0) groups.push({ labels, callee: null })
  return groups
}

/** One aligned arm whose callees differ, as renderDiffersAt reads it. */
function armFact(la, lb, ga, gb) {
  const printable = (callee) => (callee !== null && dottedCallee.ok(callee) ? callee : undefined)
  const fact = {
    aKind: la.kind,
    aLabel: la.text,
    bKind: lb.kind,
    bLabel: lb.text,
    aCallee: printable(ga.callee),
    bCallee: printable(gb.callee),
  }
  return Object.fromEntries(Object.entries(fact).filter(([, v]) => v !== undefined))
}

/** The labels of `groups` no aligned arm took, and the case groups they fall in. */
function unmatched(groups, matched) {
  let labels = 0
  const hit = new Set()
  for (const [gi, g] of groups.entries()) {
    for (const l of g.labels) {
      if (matched.has(l.key)) continue
      labels += 1
      hit.add(gi)
    }
  }
  return { labels, groups: hit.size }
}

/** Align two switches' arms. */
function alignArms(A, B) {
  const inB = new Map()
  for (const g of B) for (const l of g.labels) if (!inB.has(l.key)) inB.set(l.key, { g, l })
  const matched = new Set()
  const arms = []
  for (const g of A) {
    for (const l of g.labels) {
      const m = inB.get(l.key)
      if (m === undefined) continue
      matched.add(l.key)
      if (g.callee !== m.g.callee) arms.push({ fact: armFact(l, m.l, g, m.g), order: arms.length })
    }
  }
  // Equal callee pairs sit together, so the renderer can say "same pair"; then A's order.
  const pair = ({ fact }) => `${fact.aCallee ?? ''} ${fact.bCallee ?? ''}`
  arms.sort((x, y) => cmp(pair(x), pair(y)) || x.order - y.order)
  return {
    arms: arms.map(({ fact }) => fact),
    aOnly: unmatched(A, matched),
    bOnly: unmatched(B, matched),
  }
}

/** A stream run's alignment key: tokens joined, with numbered slots collapsed. */
const runKey = (tokens) => tokens.map((t) => (/^\$\d+$/.test(t) ? '$' : t)).join(' ')

/** The top-level statements of a TS callable (its switch aside), as alignment keys. */
function tsStatementKeys(ts, c, sw) {
  const body = c.node.body
  if (body === undefined) return []
  const statements = ts.isBlock(body) ? body.statements.filter((st) => st !== sw) : [body]
  return statements.map((st) =>
    runKey(c.stream.filter((_t, i) => c.ends[i] > st.pos && c.ends[i] <= st.end)),
  )
}

/**
 * The `;`-separated runs of a SQL callable's body, as alignment keys. The body is the stream
 * between its `$$` delimiters (a nested dollar quote is one literal token, never a `$$`); a
 * body written as a quoted string has none, and the whole stream stands in.
 */
function sqlStatementKeys(c) {
  const open = c.stream.indexOf('$$')
  const close = c.stream.lastIndexOf('$$')
  const body = open !== -1 && close > open ? c.stream.slice(open + 1, close) : c.stream
  const runs = [[]]
  for (const t of body) {
    if (t === ';') runs.push([])
    else runs.at(-1).push(t)
  }
  return runs.filter((r) => r.length > 0).map(runKey)
}

/** How many of each side's keys the longest common subsequence leaves unaligned. */
function unaligned(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return { a: a.length - dp[0][0], b: b.length - dp[0][0] }
}

/**
 * The "differs at" facts of a near-miss pair, A and B in the pair's subject order.
 * @param {any} ts @param {Callable} a @param {Callable} b
 */
export function differsAt(ts, a, b) {
  const none = { labels: 0, groups: 0 }
  if (a.lang !== 'ts') {
    const left = unaligned(sqlStatementKeys(a), sqlStatementKeys(b))
    return {
      arms: [],
      aOnly: { ...none, statements: left.a },
      bOnly: { ...none, statements: left.b },
    }
  }
  const sa = topSwitch(ts, a.node)
  const sb = topSwitch(ts, b.node)
  const both = sa !== null && sb !== null
  const arms = both
    ? alignArms(caseGroups(ts, sa, a.file.sf), caseGroups(ts, sb, b.file.sf))
    : { arms: [], aOnly: none, bOnly: none }
  const left = unaligned(
    tsStatementKeys(ts, a, both ? sa : null),
    tsStatementKeys(ts, b, both ? sb : null),
  )
  return {
    arms: arms.arms,
    aOnly: { ...arms.aOnly, statements: left.a },
    bOnly: { ...arms.bOnly, statements: left.b },
  }
}
