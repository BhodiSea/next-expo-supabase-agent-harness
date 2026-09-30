// tools/lib/spec-anchor.mjs — the pure half of `node tools/spec-anchor.mjs`: find the
// headings of a spec, give each one an id, and cut out one section. No filesystem access;
// the CLI reads the file and decides the exit code.
//
// IDS ARE GITHUB'S HEADING ANCHORS, so `specs/x.md#security-invariants` is also a link
// that works on GitHub: lowercase, every character that is not a letter, a mark, a
// decimal or letter number, a connector (`_`), a space or a hyphen dropped, then each
// space a `-`. That is why the template's headings say "and", never "&": `Files &
// interfaces` would become `files--interfaces`. Ids come from the heading as written, so
// a heading holding a link or `_emphasis_` can differ from GitHub's anchor; keep headings
// plain words. When two headings produce the same id the id is AMBIGUOUS and refused:
// GitHub would suffix the second one `-1`, and a citation that silently lands on the
// first of two sections is worse than one that fails.
//
// ONLY ATX HEADINGS (`#` to `######`, at most three leading spaces) count, and never one
// inside a fenced code block (``` or ~~~, closed by a run of the same character at least
// as long) or inside an HTML comment that opens a line (`<!--`, closed on the line that
// holds `-->`), so a section commented out of a spec has no id, as on GitHub. A line
// indented four spaces is code, not a heading, and a heading whose text yields an empty id
// (`## ???`) has nothing to cite and is left out. CRLF and a leading BOM read exactly as LF.
// SOURCE: docs/harness/README.md (Spec-first SOP) [corpus: harness/doctrine]
import { posix } from 'node:path'
import { toPosix } from './fs-walk.mjs'

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const COMMENT_OPEN = /^ {0,3}<!--/
const NOT_IN_ID = /[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu

/**
 * GitHub's anchor for a heading's text.
 * @public exported for the harness repo's gate suite (tests/gates/spec-anchor.test.mjs)
 * @param {string} text
 */
export const headingId = (text) => text.toLowerCase().replace(NOT_IN_ID, '').replace(/ /g, '-')

/** @param {string} source */
const toLines = (source) =>
  source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

/**
 * One step of the fence state: the open fence after `line`, or null outside a fence.
 * @param {{ char: string, len: number } | null} open
 * @param {string} line
 */
function fenceAfter(open, line) {
  const m = FENCE.exec(line)
  if (open === null) return m ? { char: m[1][0], len: m[1].length } : null
  const closes =
    m !== null && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === ''
  return closes ? null : open
}

/**
 * Whether an HTML comment is still open after `line`: one opens only at the start of a line
 * and closes on the line that holds `-->` after its opener (CommonMark's HTML block kind 2).
 * @param {boolean} open
 * @param {string} line
 */
function commentAfter(open, line) {
  if (open) return !line.includes('-->')
  const m = COMMENT_OPEN.exec(line)
  return m !== null && !line.includes('-->', m[0].length)
}

/** @typedef {{ fence: { char: string, len: number } | null, comment: boolean }} Block */

/**
 * One step of the block state: an open comment or fence swallows the other's markers.
 * @param {Block} block
 * @param {string} line
 * @returns {Block}
 */
function blockAfter(block, line) {
  if (block.comment) return { fence: null, comment: commentAfter(true, line) }
  if (block.fence !== null) return { fence: fenceAfter(block.fence, line), comment: false }
  const fence = fenceAfter(null, line)
  return { fence, comment: fence === null && commentAfter(false, line) }
}

/**
 * @typedef {{ level: number, text: string, id: string, line: number }} Heading
 * @param {string[]} lines
 * @returns {Heading[]}
 */
function headingsOf(lines) {
  const out = []
  /** @type {Block} */
  let block = { fence: null, comment: false }
  lines.forEach((line, i) => {
    const inside = block.fence !== null || block.comment
    block = blockAfter(block, line)
    if (inside || block.fence !== null || block.comment) return
    const m = ATX.exec(line)
    const id = m?.[2] ? headingId(m[2]) : ''
    if (id !== '') out.push({ level: m[1].length, text: m[2], id, line: i + 1 })
  })
  return out
}

/**
 * Every heading of a spec, in order, with its 1-based line.
 * @param {string} source
 */
export const parseHeadings = (source) => headingsOf(toLines(source))

/**
 * The section `id` names: its heading and everything under it, up to the next heading of
 * the same or a higher level, trailing blank lines dropped.
 * @param {string} source
 * @param {string} id
 * @returns {{ kind: 'ok', heading: Heading, text: string }
 *   | { kind: 'unknown', headings: Heading[] }
 *   | { kind: 'ambiguous', lines: number[], headings: Heading[] }}
 */
export function findSection(source, id) {
  const lines = toLines(source)
  const headings = headingsOf(lines)
  const hits = headings.filter((h) => h.id === id)
  if (hits.length === 0) return { kind: 'unknown', headings }
  if (hits.length > 1) return { kind: 'ambiguous', lines: hits.map((h) => h.line), headings }
  const [heading] = hits
  const next = headings.find((h) => h.line > heading.line && h.level <= heading.level)
  const body = lines.slice(heading.line - 1, next ? next.line - 1 : lines.length)
  while (body.length > 1 && body[body.length - 1].trim() === '') body.pop()
  return { kind: 'ok', heading, text: `${body.join('\n')}\n` }
}

/**
 * The index: one `<id>\t<line>\t<#…> <text>` line per heading.
 * @param {Heading[]} headings
 */
export const formatIndex = (headings) =>
  headings.map((h) => `${h.id}\t${String(h.line)}\t${'#'.repeat(h.level)} ${h.text}\n`).join('')

/**
 * The lexical half of the containment rule: a relative path to a `.md` file under
 * `specs/`, judged on POSIX separators so a Windows path is held to the same rule. The
 * CLI adds the realpath half (a symlink out of specs/).
 * @param {string} arg
 * @returns {{ kind: 'ok', rel: string } | { kind: 'refused', why: string }}
 */
export function specPath(arg) {
  const p = toPosix(arg)
  if (p === '') return { kind: 'refused', why: 'no path given' }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p))
    return { kind: 'refused', why: 'an absolute or drive path' }
  const rel = posix.normalize(p)
  if (!rel.startsWith('specs/')) return { kind: 'refused', why: 'not under specs/' }
  if (!rel.endsWith('.md')) return { kind: 'refused', why: 'not a .md file' }
  return { kind: 'ok', rel }
}
