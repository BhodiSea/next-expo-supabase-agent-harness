// tools/lib/corpus.mjs — the ONE reader of the citation corpus (1.0.4). The `provenance`
// gate (tools/check-sources.mjs), the ADR check in `docs-sync` (tools/check-docs-sync.mjs)
// and the corpus_search MCP server (tools/mcp/corpus-search-server.mjs) all read it here,
// so the three can never disagree about which ids resolve.
//
// TWO FILES, ONE CORPUS.
//   - tools/mcp/corpus/index.json — the harness's pinned authorities. OWNED: hash-pinned by
//     gate-integrity, write-guarded, re-planted by `update`, and MANDATORY.
//   - tools/mcp/corpus/project.json — the project's own authorities, `{ comment, entries }`.
//     SEEDED and optional: absent counts as empty. Through 1.0.3 the only place to add an
//     authority was the owned index, so adding one forked it, gate-integrity redded until a
//     human re-recorded its sha, and `update` parked every upstream change for a hand merge.
// A project entry goes through the same lint as an upstream one, justifies only the groups
// it declares, and may not reuse an upstream id: a project adds authorities, never replaces
// one. The docs recommend a `project/` id prefix without requiring it, so entries moved out
// of a forked index keep their ids and their citations still resolve; a later upstream id
// that collides with one reds naming both files.
//
// PURE OVER ITS ARGUMENTS. It never reads process.cwd() or process.env: the caller passes
// the root, an optional upstream-index path (the server's CORPUS_INDEX_URL override) and,
// when it wants the per-entry lint, the known decision-group keys. It deliberately does NOT
// import provenance-rules.mjs, whose module body reads tools/decision-groups.json and throws
// on a malformed one: the server must keep answering then, so the group keys are an argument.
// SOURCE: docs/harness/README.md (the provenance pipeline; pinned corpus) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const UPSTREAM_CORPUS = 'tools/mcp/corpus/index.json'
export const PROJECT_CORPUS = 'tools/mcp/corpus/project.json'
const PROJECT_KEYS = ['comment', 'entries']

/**
 * @typedef {{ id: string, file: string, entry: Record<string, any> }} CorpusEntry
 * @typedef {{ status: string, list: any[], problems: string[] }} FileRead
 */

/** @param {string} path @returns {{ absent: true } | { error: string } | { value: any }} */
function readJson(path) {
  if (!existsSync(path)) return { absent: true }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** @param {string} path @param {string} label @returns {FileRead} */
function readUpstream(path, label) {
  const read = readJson(path)
  if ('absent' in read) {
    return {
      status: 'missing',
      list: [],
      problems: [`${label}: missing — the pinned corpus is part of the provenance surface`],
    }
  }
  if ('error' in read) {
    return { status: 'malformed', list: [], problems: [`${label}: invalid JSON (${read.error})`] }
  }
  if (!Array.isArray(read.value)) {
    return { status: 'malformed', list: [], problems: [`${label}: expected an ARRAY of entries`] }
  }
  return { status: 'ok', list: read.value, problems: [] }
}

// The project file's shape, in the shape of the overrides check in tools/check-sources.mjs,
// plus the one rule that check lacks: an unknown top-level key reds, because a misspelled
// `entries` would otherwise load nothing while a reviewer believes it pinned something.
// Any of these fails closed: provenance reds, docs-sync skips its corpus-id check, and the
// server serves no project id.
/** @param {any} raw @returns {string | null} */
function projectShapeProblem(raw) {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof raw.comment !== 'string'
  ) {
    return `${PROJECT_CORPUS}: expected { comment: string, entries: array } — a malformed project corpus fails closed`
  }
  if (!Array.isArray(raw.entries)) {
    return `${PROJECT_CORPUS}: \`entries\` is not an array — a malformed project corpus fails closed`
  }
  const unknown = Object.keys(raw).filter((k) => !PROJECT_KEYS.includes(k))
  if (unknown.length > 0) {
    return `${PROJECT_CORPUS}: unknown top-level key ${unknown.map((k) => JSON.stringify(k)).join(', ')} — only "comment" and "entries" are read, so a misspelled key would pin nothing; a malformed project corpus fails closed`
  }
  return null
}

/** @param {string} path @returns {FileRead} */
function readProject(path) {
  const read = readJson(path)
  if ('absent' in read) return { status: 'absent', list: [], problems: [] }
  if ('error' in read) {
    const problem = `${PROJECT_CORPUS}: invalid JSON (${read.error}) — a malformed project corpus fails closed`
    return { status: 'malformed', list: [], problems: [problem] }
  }
  const problem = projectShapeProblem(read.value)
  if (problem !== null) return { status: 'malformed', list: [], problems: [problem] }
  return { status: 'ok', list: read.value.entries, problems: [] }
}

/** @param {any} entry @returns {string | null} */
function entryId(entry) {
  return typeof entry?.id === 'string' && entry.id.trim() !== '' ? entry.id : null
}

// The per-entry lint, moved here from tools/check-sources.mjs with its rules unchanged. Each
// message now leads with the file the entry lives in.
/**
 * @param {Record<string, any>} entry @param {string} id @param {string} file
 * @param {Set<string>} known @param {Set<string>} covered @param {string[]} problems
 */
function lintEntry(entry, id, file, known, covered, problems) {
  for (const field of ['title', 'url', 'version']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      problems.push(
        `${file}: corpus entry ${id}: missing/empty ${field} — pinned entries must name their authority`,
      )
    }
  }
  if (typeof entry.text !== 'string' || entry.text.trim() === '') {
    problems.push(
      `${file}: corpus entry ${id}: missing/empty text — nothing to hash, nothing cited`,
    )
    return
  }
  const actual = createHash('sha256').update(entry.text, 'utf8').digest('hex')
  if (entry.sha256 !== actual) {
    problems.push(
      `${file}: corpus entry ${id} text/hash mismatch — the corpus is tamper-evident data`,
    )
  }
  // groups is MANDATORY: a missing `groups` key would be a WILDCARD — citing such an entry
  // would short-circuit the per-site group-match. `groups: []` is the explicit
  // "presence-only" marker: it grounds citation existence and justifies no flagged group.
  if (!Array.isArray(entry.groups)) {
    problems.push(
      `${file}: corpus entry ${id}: missing/invalid \`groups\` — declare an array of decision-group keys, or [] for a presence-only authority (a groups-less entry can never universally justify a flagged decision site)`,
    )
    return
  }
  for (const g of entry.groups) {
    if (known.has(g)) {
      covered.add(g)
    } else {
      problems.push(
        `${file}: corpus entry ${id}: unknown decision group ${JSON.stringify(g)} (known: ${[...known].join(', ')})`,
      )
    }
  }
}

/**
 * Collect one file's entries. Every entry with an id comes back tagged with its file, lint
 * failures included; an id-less one is a lint problem only.
 * @param {FileRead} read @param {string} file @param {{ known: Set<string> | null, covered: Set<string>, problems: string[], taken: Set<string> | null }} ctx
 * @returns {CorpusEntry[]}
 */
function collect(read, file, ctx) {
  /** @type {CorpusEntry[]} */
  const out = []
  for (const entry of read.list) {
    const id = entryId(entry)
    if (id !== null) out.push({ id, file, entry })
    if (ctx.known === null) continue
    if (id === null) {
      ctx.problems.push(
        `${file}: entry with missing/empty id: ${String(JSON.stringify(entry)).slice(0, 80)}`,
      )
      continue
    }
    // A colliding project entry is linted like any other, and covers nothing: the upstream
    // entry of that id is the one every reader keeps.
    const collides = ctx.taken?.has(id) === true
    lintEntry(entry, id, file, ctx.known, collides ? new Set() : ctx.covered, ctx.problems)
  }
  return out
}

/**
 * Load the corpus: the upstream index (mandatory) and the project file (optional).
 *
 * `entries` lists the upstream entries first, so a reader that keeps the first entry per
 * id (corpusById) always keeps the upstream one. `problems` holds file-level reds always,
 * and the per-entry lint only when `groupKeys` is passed. `upstream` is 'ok' | 'missing' |
 * 'malformed'; `project` is 'ok' | 'absent' | 'malformed', and a malformed project file
 * contributes no entries.
 *
 * @param {{ root: string, upstreamPath?: string, groupKeys?: Iterable<string> }} opts
 * @returns {{ entries: CorpusEntry[], problems: string[], upstream: string, project: string, coveredGroups: Set<string> }}
 */
export function loadCorpus({ root, upstreamPath, groupKeys }) {
  const upstreamLabel = upstreamPath ?? UPSTREAM_CORPUS
  const upstream = readUpstream(upstreamPath ?? join(root, UPSTREAM_CORPUS), upstreamLabel)
  const project = readProject(join(root, PROJECT_CORPUS))
  const problems = [...upstream.problems, ...project.problems]
  const coveredGroups = new Set()
  const known = groupKeys === undefined ? null : new Set(groupKeys)
  const base = { known, covered: coveredGroups, problems }
  const upstreamEntries = collect(upstream, upstreamLabel, { ...base, taken: null })
  const taken = new Set(upstreamEntries.map((e) => e.id))
  const projectEntries = collect(project, PROJECT_CORPUS, { ...base, taken })
  for (const { id } of projectEntries.filter((e) => taken.has(e.id))) {
    problems.push(
      `${PROJECT_CORPUS}: corpus id ${JSON.stringify(id)} is already pinned in ${upstreamLabel} — a project adds authorities and never replaces one, so rename the project entry (the recommended prefix is project/) and its citations`,
    )
  }
  return {
    entries: [...upstreamEntries, ...projectEntries],
    problems,
    upstream: upstream.status,
    project: project.status,
    coveredGroups,
  }
}

/**
 * Index loaded entries by id, keeping the FIRST entry per id — the upstream one on a
 * collision, since loadCorpus lists upstream entries first.
 * @param {CorpusEntry[]} entries @returns {Map<string, CorpusEntry>}
 */
export function corpusById(entries) {
  const byId = new Map()
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e)
  return byId
}
