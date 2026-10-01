// THE FIELD-REPORT RECORD AND THE ROADMAP NAME THE SAME PULL REQUEST FOR EVERY ITEM.
//
// Issue #37 indexed the design record's sections (N01–N21, R01–R08, B01–B03) one issue per
// item, and each issue was built in one pull request of a stack. Three places now say where
// each section went: the status table at the top of design/FIELD-UPGRADES-2026-09.md, the
// status line under each section's heading, and the ROADMAP bullet that links the section.
// They were written by hand, in one change, and nothing else reads them, so this test holds
// them to each other: every section has a status line and a table row, the two carry the
// same (release, pull request, issue, stack position) tuples, every ROADMAP bullet that links
// a section names only pairs that section's status names, under the ROADMAP heading for the
// release that status gives, and every built part of a section is on the roadmap.
//
// It reads text and checks agreement only. It does not ask GitHub whether a pull request is
// open or merged, and it pins no number: the tuples are the record's, not the test's.
// SOURCE: design/FIELD-UPGRADES-2026-09.md · ROADMAP.md
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const DESIGN = 'design/FIELD-UPGRADES-2026-09.md'
const design = read(DESIGN)
const roadmap = read('ROADMAP.md')
const lines = (text) => text.split(/\r?\n/)
const unwrap = (text) => text.replace(/\s*\r?\n\s*/g, ' ').trim()

/** @typedef {{ release: string, pr: number, issue: number, position: number }} Built */

/** @param {Built} b */
const tupleKey = (b) => `${b.release} pull request #${String(b.pr)} issue #${String(b.issue)} position ${String(b.position)}`

const STATUS_HEADING = /^## Status on (\d{4}-\d{2}-\d{2})$/
const SECTION_HEADING = /^## ([NRB]\d{2}): /
const STATUS_LINE = /^\*\*Status on (\d{4}-\d{2}-\d{2})\.\*\*/
const LINE_TUPLE = /for (\d+\.\d+\.\d+) in pull request #(\d+) \(issue #(\d+), stack position (\d+)\)/g
const TABLE_ROW = /^\| ([NRB]\d{2}) \| #(\d+) \| #(\d+) \| (\d+) \| (\d+\.\d+\.\d+) \|/

/** The date the status table is dated, or '' when the heading is missing. */
function statusDate() {
  for (const line of lines(design)) {
    const m = STATUS_HEADING.exec(line)
    if (m) return m[1]
  }
  return ''
}

/**
 * Each section key mapped to the paragraph right under its heading (unwrapped), or '' when
 * the heading is followed by nothing.
 * @returns {Map<string, string>}
 */
function sectionLeads() {
  /** @type {Map<string, string>} */
  const leads = new Map()
  const all = lines(design)
  all.forEach((line, i) => {
    const m = SECTION_HEADING.exec(line)
    if (!m) return
    let from = i + 1
    while (from < all.length && all[from].trim() === '') from += 1
    let to = from
    while (to < all.length && all[to].trim() !== '') to += 1
    leads.set(m[1], unwrap(all.slice(from, to).join('\n')))
  })
  return leads
}

/**
 * The status table's rows, grouped by section key.
 * @returns {Map<string, Built[]>}
 */
function tableRows() {
  /** @type {Map<string, Built[]>} */
  const rows = new Map()
  for (const line of lines(design)) {
    const m = TABLE_ROW.exec(line)
    if (!m) continue
    const built = { pr: Number(m[3]), issue: Number(m[2]), position: Number(m[4]), release: m[5] }
    rows.set(m[1], [...(rows.get(m[1]) ?? []), built])
  }
  return rows
}

/** @param {string} lead @returns {Built[]} */
function lineTuples(lead) {
  return [...lead.matchAll(LINE_TUPLE)].map((m) => ({
    release: m[1],
    pr: Number(m[2]),
    issue: Number(m[3]),
    position: Number(m[4]),
  }))
}

/** @param {Built[]} list */
const sortedKeys = (list) => list.map(tupleKey).sort()

/**
 * The ROADMAP's field-report bullets: the release of the `###` heading each sits under, the
 * design section it links, and the (issue, pull request) pairs it names.
 * @returns {Array<{ release: string, key: string, pairs: Array<[number, number]>, text: string }>}
 */
function roadmapBullets() {
  const all = lines(roadmap)
  const start = all.findIndex((line) => line === '## Field-report upgrades')
  const end = all.findIndex((line, i) => i > start && line.startsWith('## '))
  assert.ok(start !== -1 && end !== -1, 'ROADMAP.md must keep its "## Field-report upgrades" section')
  /** @type {Array<{ release: string, key: string, pairs: Array<[number, number]>, text: string }>} */
  const out = []
  let release = ''
  /** @type {string[]} */
  let open = []
  const flush = () => {
    if (open.length === 0) return
    const text = unwrap(open.join('\n'))
    const key = /\[([NRB]\d{2})\]\(design\/FIELD-UPGRADES-2026-09\.md#/.exec(text)?.[1] ?? ''
    const pairs = [...text.matchAll(/issue #(\d+), pull request #(\d+)/g)].map(
      (m) => /** @type {[number, number]} */ ([Number(m[1]), Number(m[2])]),
    )
    out.push({ release, key, pairs, text })
    open = []
  }
  for (const line of all.slice(start, end)) {
    const heading = /^### (\d+\.\d+\.\d+),/.exec(line)
    if (heading || line.startsWith('- ') || line.trim() === '') flush()
    if (heading) release = heading[1]
    if (line.startsWith('- ') || (open.length > 0 && line.startsWith('  '))) open.push(line)
  }
  flush()
  return out
}

test('the design record has a dated status table, and every section has a status line of that date', () => {
  const date = statusDate()
  assert.notEqual(date, '', `${DESIGN} must carry a "## Status on <YYYY-MM-DD>" section`)
  const leads = sectionLeads()
  assert.ok(leads.size >= 30, `${DESIGN}: found only ${String(leads.size)} section headings`)
  /** @type {string[]} */
  const problems = []
  for (const [key, lead] of leads) {
    const m = STATUS_LINE.exec(lead)
    if (!m) problems.push(`${key}: the first paragraph under the heading is not a "**Status on <date>.**" line`)
    else if (m[1] !== date) problems.push(`${key}: its status line is dated ${m[1]}, the table ${date}`)
    else if (lineTuples(lead).length === 0)
      problems.push(`${key}: its status line names no "for <release> in pull request #N (issue #N, stack position N)"`)
  }
  assert.deepEqual(problems, [])
})

test("the status table and each section's status line carry the same tuples, and every section has a row", () => {
  const leads = sectionLeads()
  const rows = tableRows()
  /** @type {string[]} */
  const problems = []
  for (const key of rows.keys()) if (!leads.has(key)) problems.push(`table row ${key} names no section`)
  for (const [key, lead] of leads) {
    const fromTable = sortedKeys(rows.get(key) ?? [])
    const fromLine = sortedKeys(lineTuples(lead))
    if (fromTable.length === 0) problems.push(`${key}: no row in the status table`)
    else if (fromLine.join(' | ') !== fromTable.join(' | '))
      problems.push(`${key}: the status line says [${fromLine.join(' | ')}], the table [${fromTable.join(' | ')}]`)
  }
  assert.deepEqual(problems, [])
})

test('no pull request or stack position is claimed by two rows', () => {
  const all = [...tableRows().values()].flat()
  const prs = all.map((b) => b.pr)
  const positions = all.map((b) => b.position)
  assert.equal(new Set(prs).size, prs.length, `a pull request is listed twice: ${prs.join(', ')}`)
  assert.equal(new Set(positions).size, positions.length, `a stack position is listed twice: ${positions.join(', ')}`)
})

test('every ROADMAP field-report bullet names its pull request, under the heading of the release it was built for', () => {
  const rows = tableRows()
  /** @type {string[]} */
  const problems = []
  for (const bullet of roadmapBullets()) {
    const where = `ROADMAP.md bullet "${bullet.text.slice(0, 60)}…"`
    if (bullet.key === '') problems.push(`${where} links no design section`)
    else if (bullet.pairs.length === 0) problems.push(`${where} names no "issue #N, pull request #N"`)
    for (const [issue, pr] of bullet.pairs) {
      const built = (rows.get(bullet.key) ?? []).find((b) => b.issue === issue && b.pr === pr)
      if (!built) problems.push(`${where}: issue #${String(issue)}, pull request #${String(pr)} is not in ${bullet.key}'s status`)
      else if (built.release !== bullet.release)
        problems.push(`${where}: sits under ${bullet.release} but ${bullet.key}'s status builds it for ${built.release}`)
    }
  }
  assert.deepEqual(problems, [])
})

test('every built part of every section is on the roadmap', () => {
  const named = new Set(roadmapBullets().flatMap((b) => b.pairs.map(([issue, pr]) => `${b.key} ${String(issue)} ${String(pr)}`)))
  /** @type {string[]} */
  const missing = []
  for (const [key, built] of tableRows())
    for (const b of built)
      if (!named.has(`${key} ${String(b.issue)} ${String(b.pr)}`))
        missing.push(`${key}: issue #${String(b.issue)}, pull request #${String(b.pr)} (${b.release})`)
  assert.deepEqual(missing, [])
})

// ── The whole stack: the ROADMAP's work-plan table and the design record's table together ──
// The design table holds the field-report positions and the ROADMAP's work-plan table the
// rest (the release bumps, the follow-ups, issue #10 and the record's own position). Between
// them every position from 1 up must be claimed, by one issue and one pull request, in release
// order, and the tag positions both prose paragraphs state must be each release's last one.

/** @typedef {{ position: number, release: string, issue: number, pr: string, where: string }} Claim */

const PLAN_ROW = /^\| (\d+) \| (\d+\.\d+\.\d+) \| #(\d+) \| (?:[A-Z]\d{2}|—) \| (#\d+|—) \|/

/** @returns {Claim[]} */
function stackClaims() {
  /** @type {Claim[]} */
  const claims = []
  for (const line of lines(roadmap)) {
    const m = PLAN_ROW.exec(line)
    if (m) claims.push({ position: Number(m[1]), release: m[2], issue: Number(m[3]), pr: m[4], where: 'ROADMAP.md' })
  }
  for (const [key, built] of tableRows())
    for (const b of built)
      claims.push({ position: b.position, release: b.release, issue: b.issue, pr: `#${String(b.pr)}`, where: `${DESIGN} ${key}` })
  return claims
}

/** @param {string} a @param {string} b */
const releaseOrder = (a, b) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/**
 * The "<release> on [position] <n>" pairs of the one paragraph in `text` that says releases
 * are tagged on their last position.
 * @param {string} text
 */
function statedTags(text) {
  const para = text.split(/\r?\n\s*\r?\n/).map(unwrap).find((p) => /tag(?:s|ged)? each release on its last position|tagged on its last position/.test(p)) ?? ''
  return [...para.matchAll(/(\d+\.\d+\.\d+) on (?:position )?(\d+)\b/g)].map((m) => `${m[1]}@${m[2]}`)
}

test('every stack position from 1 up is claimed once, by one issue and pull request, in release order', () => {
  /** @type {Map<number, Claim[]>} */
  const byPosition = new Map()
  for (const c of stackClaims()) byPosition.set(c.position, [...(byPosition.get(c.position) ?? []), c])
  const last = Math.max(...byPosition.keys())
  /** @type {string[]} */
  const problems = []
  let previous = '0.0.0'
  for (let position = 1; position <= last; position += 1) {
    const claims = byPosition.get(position) ?? []
    const shapes = new Set(claims.map((c) => `${c.release} issue #${String(c.issue)} ${c.pr}`))
    if (claims.length === 0) problems.push(`position ${String(position)}: no row claims it`)
    else if (shapes.size > 1) problems.push(`position ${String(position)}: rows disagree (${claims.map((c) => c.where).join(', ')}): ${[...shapes].join(' / ')}`)
    else if (releaseOrder(claims[0].release, previous) < 0) problems.push(`position ${String(position)}: ${claims[0].release} after ${previous}`)
    if (claims.length > 0) previous = claims[0].release
  }
  const prs = [...byPosition.values()].map((claims) => claims[0].pr).filter((pr) => pr !== '—')
  assert.equal(new Set(prs).size, prs.length, `a pull request is claimed by two positions: ${prs.join(', ')}`)
  assert.deepEqual(problems, [])
})

test("the tag positions the ROADMAP and the design record state are each release's last position", () => {
  /** @type {Map<string, number>} */
  const lastOf = new Map()
  for (const c of stackClaims()) lastOf.set(c.release, Math.max(lastOf.get(c.release) ?? 0, c.position))
  const derived = [...lastOf].sort(([a], [b]) => releaseOrder(a, b)).map(([release, position]) => `${release}@${String(position)}`)
  assert.ok(derived.length > 0, 'no stack position is claimed anywhere')
  assert.deepEqual(statedTags(roadmap), derived, 'ROADMAP.md: the work-plan paragraph names other tag positions')
  assert.deepEqual(statedTags(design), derived, `${DESIGN}: the status paragraph names other tag positions`)
})
