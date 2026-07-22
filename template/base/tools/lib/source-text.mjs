// Shared source-text primitives for the gate scripts that scan code TEXTUALLY.
//
// Every gate here is a regex scanner, not a compiler, and that is a deliberate trade: zero
// dependencies, no parse step, and over-detection reds (with a reviewed allowlist as the
// escape) rather than failing open. But two mistakes recur, and both are fail-OPEN, so
// they live here once instead of being re-made per gate:
//
//   1. A COMMENT SATISFIES A CHECK. The styleguide gate shipped exactly this: a design
//      token named only inside a `//` comment counted as "this file references a status
//      token", so a colourless error surface passed. Blank comments BEFORE testing for
//      anything a file is required to contain.
//
//   2. BLANKING SHIFTS OFFSETS, so reported line numbers drift and brace matching walks
//      into the wrong place. blankComments therefore PRESERVES POSITION: comment
//      characters become spaces, newlines are kept, and lineOf() still names the true line.
//
// SOURCE: docs/harness/gates-catalog.md (gate scripts scan text; over-detection is the
// safe direction) [corpus: harness/doctrine]

/** Same length, same newlines, no content — so offsets and line numbers survive. */
const blank = (s) => s.replace(/[^\n]/g, ' ')

/**
 * Blank `/* … *\/` and `// …` comments, preserving every offset and line break. The
 * `[^:]` guard keeps the `//` in `https://…` from being read as a comment opener.
 *
 * Blanking can only make a caller STRICTER, never fail open: a commented-out construct
 * stops matching (no phantom sites), and a construct named only in prose stops satisfying
 * a requirement.
 */
export function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, pre, com) => pre + blank(com))
}

/** 1-based line number of `index` in `src`. */
export function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

const CLOSERS = { '(': ')', '[': ']', '{': '}' }

// A `/` opens a REGEX only where a value may not appear — after an operator, an opening
// bracket, a comma, or a keyword. Everywhere else it is division. Getting this wrong is
// not cosmetic: mistaking `w / 2` for a regex swallows the rest of the line and brace
// matching lands in the wrong place.
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%~^<>]$/
const REGEX_KEYWORD = /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|throw|do|else)$/

function isRegexStart(src, i) {
  if (src[i] !== '/' || src[i + 1] === '/' || src[i + 1] === '*') return false
  const before = src.slice(Math.max(0, i - 16), i).replace(/\s+$/, '')
  if (before === '') return true
  return REGEX_PRECEDER.test(before) || REGEX_KEYWORD.test(before)
}

/** Index just past the string / template literal / regex whose delimiter is at `i`. */
function skipDelimited(src, i, delim) {
  let j = i + 1
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    // A newline ends an unterminated regex — never run past the line.
    if (delim === '/' && ch === '\n') return j
    if (ch === delim) return j + 1
    j += 1
  }
  return src.length
}

/** Index just past the comment opening at `i`. */
function skipComment(src, i) {
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i)
    return nl === -1 ? src.length : nl
  }
  const end = src.indexOf('*/', i + 2)
  return end === -1 ? src.length : end + 2
}

/**
 * Index just past the delimiter that OPENS at `open` — one of `(`, `[`, `{` — honouring
 * nesting, strings, template literals, regex literals and comments. A brace inside a
 * string or a regex does not count (`/f(o)o/` would otherwise miscount). Returns
 * src.length when unbalanced, so a caller can never loop forever on malformed input.
 */
export function skipBalanced(src, open) {
  const closer = CLOSERS[src[open]]
  if (closer === undefined) return open
  const opener = src[open]
  let depth = 0
  let i = open
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') i = skipDelimited(src, i, ch)
    else if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) i = skipComment(src, i)
    else if (isRegexStart(src, i)) i = skipDelimited(src, i, '/')
    else {
      if (ch === opener) depth += 1
      else if (ch === closer && (depth -= 1) === 0) return i + 1
      i += 1
    }
  }
  return src.length
}
