// scripts/lib/companion-table.mjs — the one reader of a reviewer body's companion table
// (1.1.0, #66), shared by tests/gates/reviewer-companions.test.mjs, which holds the shipped
// bodies to it, and scripts/reviewer-eval.mjs, which checks that every id a case says a
// reviewer must name is a row that reviewer's body carries.
//
// A reviewer body's rubric asks about lines a diff contains. The companion table asks the
// converse: given what the diff introduces, what must land with it. Each row is
//
//   | `<id>` | The diff introduces | It must also bring | Stated in | Enforced by |
//
// under the heading `## WHAT MUST ACCOMPANY IT`. `Stated in` names, in backticks, the
// install paths where the harness already states the rule (a row restates a rule, it never
// makes one). `Enforced by` is `review only`, or the backticked chain steps that red the
// absence. The reviewer reports each row that applies as `<id>: present (file:line)` or
// `<id>: absent`.
//
// Factory-side only: nothing in an install reads the table, so no gate, hook or chain step
// depends on this parser, and a malformed table is a red in the factory's own tests.

export const COMPANION_HEADING = '## WHAT MUST ACCOMPANY IT'

const COMPANION_COLUMNS = [
  'id',
  'The diff introduces',
  'It must also bring',
  'Stated in',
  'Enforced by',
]

export const REVIEW_ONLY = 'review only'

const ROW_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SEPARATOR_CELL = /^:?-{3,}:?$/

/** The cells of a markdown table line, trimmed; null when the line is not a table row. */
function cellsOf(line) {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null
  return t
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim())
}

/** The backticked spans of a cell, in order. @param {string} cell @returns {string[]} */
function codeSpans(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

/** The body's lines with CRLF folded, so every index below is a line number minus one. */
const linesOf = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

/**
 * Parse one data row. Returns the row, or a sentence saying what is wrong with it.
 * @param {string[]} cells @param {number} lineNo
 */
function parseRow(cells, lineNo) {
  if (cells.length !== COMPANION_COLUMNS.length) {
    return `line ${String(lineNo)}: ${String(cells.length)} cell(s), the table has ${String(COMPANION_COLUMNS.length)} columns`
  }
  const [idCell, introduces, bring, statedCell, enforcedCell] = cells
  const id = /^`([^`]+)`$/.exec(idCell)?.[1] ?? ''
  if (!ROW_ID.test(id)) {
    return `line ${String(lineNo)}: the id cell must be one backticked kebab-case id, got ${JSON.stringify(idCell)}`
  }
  const statedIn = codeSpans(statedCell)
  if (introduces === '' || bring === '' || statedIn.length === 0) {
    return `line ${String(lineNo)} (${id}): every row names what the diff introduces, what it must bring, and at least one backticked path it is stated in`
  }
  const enforcedBy = enforcedCell === REVIEW_ONLY ? [REVIEW_ONLY] : codeSpans(enforcedCell)
  if (enforcedBy.length === 0) {
    return `line ${String(lineNo)} (${id}): \`Enforced by\` is \`${REVIEW_ONLY}\` or one or more backticked chain steps`
  }
  return { id, introduces, bring, statedIn, enforcedBy, line: lineNo }
}

/**
 * The first table after `start`: its header cells, and every row line up to the first line
 * that is not a table row.
 * @param {string[]} lines @param {number} start
 */
function tableAfter(lines, start) {
  let i = start
  while (i < lines.length && cellsOf(lines[i]) === null && !lines[i].startsWith('## ')) i += 1
  const header = i < lines.length ? cellsOf(lines[i]) : null
  const rows = []
  if (header === null) return { header: null, headerLine: -1, rows }
  const headerLine = i
  i += 1
  while (i < lines.length && cellsOf(lines[i]) !== null) {
    rows.push({ cells: cellsOf(lines[i]) ?? [], lineNo: i + 1 })
    i += 1
  }
  return { header, headerLine, rows }
}

/**
 * A reviewer body's companion table. `headingLines` holds every line number (1-based) the
 * heading sits on, so a caller can hold a body to exactly one; the table is read under the
 * first. `problems` is empty when the table is whole: the five columns in order, a
 * separator row, at least one data row, and each row well formed with a unique id.
 * @param {unknown} text the whole agent file
 */
export function companionTable(text) {
  const lines = linesOf(text)
  const headingLines = lines.flatMap((l, i) => (l.trimEnd() === COMPANION_HEADING ? [i + 1] : []))
  if (headingLines.length === 0) return { headingLines, rows: [], problems: [`no \`${COMPANION_HEADING}\` heading`] }
  const { header, rows: raw } = tableAfter(lines, headingLines[0])
  if (header === null || header.join('|') !== COMPANION_COLUMNS.join('|')) {
    return {
      headingLines,
      rows: [],
      problems: [`the first table under the heading must have the columns ${COMPANION_COLUMNS.join(' | ')}`],
    }
  }
  const problems = []
  const [separator, ...data] = raw
  if (separator === undefined || !separator.cells.every((c) => SEPARATOR_CELL.test(c))) {
    problems.push('the header row must be followed by a `| --- |` separator row')
  }
  const rows = []
  for (const { cells, lineNo } of data) {
    const row = parseRow(cells, lineNo)
    if (typeof row === 'string') problems.push(row)
    else if (rows.some((r) => r.id === row.id)) problems.push(`line ${String(lineNo)}: id \`${row.id}\` is repeated`)
    else rows.push(row)
  }
  if (rows.length === 0 && problems.length === 0) problems.push('the table has no rows')
  return { headingLines, rows, problems }
}

/**
 * Where a body's closing parts start, as 1-based line numbers (null when absent): the first
 * paragraph that opens with `Flag ONLY`, the first `Severities:` line, and the paragraph the
 * body closes on (the verdict demand, by the rule tools/lib/agent-roster.mjs holds).
 * @param {unknown} text
 */
export function closingLines(text) {
  const lines = linesOf(text)
  const firstLine = (re) => {
    const i = lines.findIndex((l) => re.test(l))
    return i === -1 ? null : i + 1
  }
  let last = lines.length - 1
  while (last > 0 && lines[last].trim() === '') last -= 1
  let start = last
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1
  return {
    flagOnly: firstLine(/^Flag ONLY\b/),
    severities: firstLine(/^Severities:/),
    closing: start + 1,
  }
}
