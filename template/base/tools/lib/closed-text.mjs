// tools/lib/closed-text.mjs — the one home for every closed printer (2.1.0, #185).
//
// WHAT IT IS FOR. What the harness prints from the tree into an agent's context (the session
// brief, an advisory NOTE, and from #186 the review packet and the issue bodies) is an
// injection surface: a file name, a symbol or a case label is text an author chose. A closed
// printer prints a value only when it fits a closed set, and prints anything else as the
// fixed `(unprintable)`, so no value can carry a sentence, a newline or markup.
//
// A PREDICATE AND A RENDERER. Each printer is `{ ok, print }`. `print` puts a passing value
// inside a code span, and no set admits a backtick, so no value can close its span; a failing
// value prints as a bare `(unprintable)`. Numbers and enum members print bare, because their
// vocabulary is the harness's and not an author's. Agent and gate names are the brief's to
// print bare (lib/harness-brief.mjs), as they always have been.
//
// PURE. It imports nothing, reads nothing and writes nothing, so every reader can load it
// (lib/gate.mjs, lib/harness-brief.mjs, check-mobile-parity.mjs), and a stamp list that
// names it names its whole closure.
// SOURCE: docs/harness/README.md (the session-start brief)

/** What a refused value prints as. */
export const UNPRINTABLE = '(unprintable)'

/** @typedef {{ ok: (v: unknown) => boolean, print: (v: unknown) => string }} Printer */

/** @param {(v: unknown) => boolean} ok @returns {Printer} */
const spanned = (ok) => ({ ok, print: (v) => (ok(v) ? `\`${String(v)}\`` : UNPRINTABLE) })

/** @param {(v: unknown) => boolean} ok @returns {Printer} */
const bare = (ok) => ({ ok, print: (v) => (ok(v) ? String(v) : UNPRINTABLE) })

/** @param {RegExp} re @returns {(v: unknown) => boolean} */
const fits = (re) => (v) => typeof v === 'string' && re.test(v)

// ── names and paths (moved from lib/harness-brief.mjs) ──────────────────────────

/** An agent, gate or leg name: a lowercase word of at most 64 characters. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
// A printed path: repository-relative POSIX, at most 160 characters, from a closed set that
// admits the App Router's ( ) [ ] (2.0.x, #153: route groups and dynamic segments printed as
// `(unprintable)` through 2.0.2). No segment is empty, `.` or `..`, or starts with `-`. It
// prints inside a code span; a backtick is not in the set, so no path can close the span.
const PATH_RE = /^[A-Za-z0-9._@+()[\]/-]{1,160}$/

/** @param {unknown} v */
const pathOk = (v) =>
  typeof v === 'string' &&
  PATH_RE.test(v) &&
  v.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('-'))
/** @type {Printer} */
export const path = spanned(pathOk)

// ── v2's printers (plan-v2 §3) ──────────────────────────────────────────────────

// A symbol. `\w` has no `$`, so a name holding one is refused.
const SYMBOL_RE = /^[A-Za-z_]\w{0,63}$/
/** @public a printer of the closed set, for the advisory record and the packet (#186) */
export const symbol = spanned(fits(SYMBOL_RE))
/** @public a printer of the closed set: `schema.name` or `name`, lowercase-led */
export const sqlName = spanned(fits(/^[a-z_]\w{0,62}(\.[a-z_]\w{0,62})?$/))

// A signature is rebuilt from the extractor's token array (#186), never copied from source:
// each token is a symbol (`S` stands for a string literal type, `N` for a number) or one
// punctuation token from the closed list, and any other token makes the whole signature
// unprintable. The spacing is the printer's own: a space after `,` `:` `;`, one on each side
// of `=>` `|` `&` `=`, and one between two words.
const SIGNATURE_PUNCTUATION = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  ',',
  ':',
  ';',
  '?',
  '.',
  '...',
  '=>',
  '|',
  '&',
  '=',
])
const SPACED_AFTER = new Set([',', ':', ';'])
const SPACED_AROUND = new Set(['=>', '|', '&', '='])

/** @param {unknown} t */
const signatureToken = (t) =>
  typeof t === 'string' && (SYMBOL_RE.test(t) || SIGNATURE_PUNCTUATION.has(t))

/** @param {string[]} tokens */
function joinSignature(tokens) {
  let out = ''
  let prev = ''
  for (const t of tokens) {
    if (SPACED_AROUND.has(t)) out += ` ${t} `
    else {
      if (SYMBOL_RE.test(t) && SYMBOL_RE.test(prev)) out += ' '
      out += SPACED_AFTER.has(t) ? `${t} ` : t
    }
    prev = t
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/** @param {unknown} v */
const signatureOk = (v) => Array.isArray(v) && v.length > 0 && v.every(signatureToken)
/** @public a printer of the closed set, for the extractor's signatures (#186) @type {Printer} */
export const signature = {
  ok: signatureOk,
  print: (v) =>
    signatureOk(v) ? `\`${joinSignature(/** @type {string[]} */ (v))}\`` : UNPRINTABLE,
}

/**
 * A member of a closed set the harness wrote, printed bare.
 * @public for the record's enums and the packet (#186)
 * @param {readonly string[]} values @returns {Printer}
 */
export function enumOf(values) {
  const members = new Set(values)
  return bare((v) => typeof v === 'string' && members.has(v))
}
/** @public a finite number, printed bare */
export const number = bare((v) => typeof v === 'number' && Number.isFinite(v))
/** A non-negative integer, printed bare. */
const count = bare((v) => Number.isInteger(v) && Number(v) >= 0)

// ── the four new printers (SINGLE-HOME §2.6) ────────────────────────────────────

/** @public the most segments a dotted callee may have */
export const DOTTED_CALLEE_MAX = 4
// A dotted callee, `appError.conflict`: one to DOTTED_CALLEE_MAX segments, each a symbol.
// Four rather than the packet draft's three, because `api.notes.create.mutate`, the call
// validation-parity binds on (#196), has four (the bound #185 left to its review).
/** @type {Printer} */
export const dottedCallee = spanned((v) => {
  if (typeof v !== 'string') return false
  const segments = v.split('.')
  return segments.length <= DOTTED_CALLEE_MAX && segments.every((s) => SYMBOL_RE.test(s))
})
// `namespace.action`: lowercase-kebab namespace, camel-ish action, DIGITS ADMITTED in both.
// tools/check-mobile-parity.mjs reads its ledger with this one copy.
export const ACTION_RE = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/
/** @public a printer of the closed set */
export const action = spanned(fits(ACTION_RE))
/** @public a printer of the closed set: a message-catalog key */
export const i18nKey = spanned(fits(/^[A-Za-z0-9_.-]{1,80}$/))
/** @public a printer of the closed set: a screen's testID */
export const testId = spanned(fits(/^[a-z0-9][a-z0-9-]{0,63}$/))

/** The one printed id: the first 12 hex digits of an advisory key. */
export const key12 = spanned(fits(/^[0-9a-f]{12}$/))

// A subject id (plan-v2 §2.2): `<package-or-path>#<name>` for a callable, the name a symbol or
// `Class.method`; `sql:<schema>.<fn>` for a SQL function; `lane:<job>` for a CI lane; or a
// class fingerprint, 12 hex digits. Two ids make a near-miss subject, joined by one space,
// which no printer admits. A `#` here is always followed by a letter or `_`, never a digit.
const LANE_RE = /^lane:[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/** @param {string} name */
const memberName = (name) => {
  const segments = name.split('.')
  return segments.length <= 2 && segments.every((s) => SYMBOL_RE.test(s))
}

/** @param {unknown} v */
function subjectIdOk(v) {
  if (typeof v !== 'string') return false
  if (key12.ok(v) || LANE_RE.test(v)) return true
  if (v.startsWith('sql:')) return sqlName.ok(v.slice(4))
  const hash = v.lastIndexOf('#')
  return hash > 0 && pathOk(v.slice(0, hash)) && memberName(v.slice(hash + 1))
}
/** @type {Printer} */
export const subjectId = spanned(subjectIdOk)

// ── N3: case labels and "differs at" (SINGLE-HOME §2.6) ─────────────────────────

// An identifier label prints through the symbol printer, so `FOREIGN_KEY_VIOLATION` prints.
// A literal label prints when it fits LABEL_LITERAL_RE, and otherwise as `#n`, n its arm's
// index, inside the span: a bare `#3` is an issue link on GitHub. The aligner (#186) matches
// arms on a constant's VALUE, which is compared there and never reaches a printer (R21).
const LABEL_LITERAL_RE = /^[A-Za-z0-9_]{1,12}$/

/**
 * One case label.
 * @public for the aligner's facts and the packet (#186)
 * @param {unknown} kind 'identifier' | 'literal' @param {unknown} text @param {number} index
 * @returns {string}
 */
export function caseLabel(kind, text, index) {
  if (kind === 'identifier') return symbol.print(text)
  if (kind !== 'literal' || !count.ok(index)) return UNPRINTABLE
  return fits(LABEL_LITERAL_RE)(text) ? `\`${String(text)}\`` : `\`#${String(index)}\``
}

/** @param {number} n @param {string} one */
const counted = (n, one) => `${count.print(n)} ${n === 1 ? one : `${one}s`}`

/** @param {unknown} v @returns {Record<string, unknown>} */
const fields = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : {}

/**
 * N3's "differs at" lines, from the aligner's facts (#186). `arms` holds one entry per case
 * value that A and B both handle and map apart, flat so that it fits a record's facts:
 * `{ aKind, aLabel, bKind, bLabel, aCallee, bCallee }`, each kind 'identifier' or 'literal'.
 * `bOnly` counts B's labels that have no arm in A, and the case groups they fall in.
 *   - A value both sides name alike prints its name once; two names print as `A` / `B`.
 *   - The callees print as `A` | `B`, or `same pair` when they repeat the previous arm's.
 * @public for the near-miss records and the packet (#186)
 * @param {unknown} facts @returns {string}
 */
export function renderDiffersAt(facts) {
  const f = fields(facts)
  const arms = Array.isArray(f.arms) ? f.arms : []
  let prior = null
  const shown = arms.map((raw, i) => {
    const arm = fields(raw)
    const a = caseLabel(arm.aKind, arm.aLabel, i)
    const b = caseLabel(arm.bKind, arm.bLabel, i)
    const pair = `${dottedCallee.print(arm.aCallee)} | ${dottedCallee.print(arm.bCallee)}`
    const callees = pair === prior ? 'same pair' : pair
    prior = pair
    return `case ${a === b ? a : `${a} / ${b}`}: ${callees}`
  })
  const lines = [`${'DIFFERS AT'.padEnd(12)}${shown.length > 0 ? shown.join(' · ') : 'none'}`]
  const bOnly = fields(f.bOnly)
  if (bOnly.labels !== undefined) {
    const labels = /** @type {number} */ (bOnly.labels)
    const groups = /** @type {number} */ (bOnly.groups)
    lines.push(
      `${'B ONLY'.padEnd(12)}${counted(labels, 'label')} in ${counted(groups, 'case group')}`,
    )
  }
  return lines.join('\n')
}
