#!/usr/bin/env node
// Deterministic CI mirror of .claude/hooks/posttool-source-check.mjs — the PostTool hook
// only fires inside Claude Code; this runs the IDENTICAL heuristic over the whole tracked
// tree in `pnpm validate` + CI so unsourced decision sites are caught on every PR, not just
// during an edit. Both layers import the heuristic from tools/lib/provenance-rules.mjs —
// one source of truth, drift is structurally impossible.
//
// Beyond the hook's fast presence check, this gate enforces RESOLVABILITY and
// JUSTIFICATION:
//   1. every SOURCE payload must ground somewhere real — a corpus reference, a
//      repo-relative path that exists, or an https:// URL whose host is on the
//      shared allowlist in tools/lib/citation-domains.mjs (an arbitrary URL is
//      a claim, not an authority);
//   2. every corpus reference anywhere in the tracked tree must resolve to an
//      entry in tools/mcp/corpus/index.json;
//   3. the corpus itself is tamper-evident data — each entry carries a sha256
//      over its text, non-empty title/url/version, and the entries' `groups`
//      tags must cover every decision group the heuristic can flag;
//   4. group-match: a decision site citing a corpus entry must cite one whose
//      `groups` cover the site's OWN decision group — a resolvable citation
//      that grounds a different decision class is not justification. Reviewed
//      cross-group escapes live in tools/provenance-overrides.json.
// All four checks are FLOOR-NATIVE here: this harness shipped them from its
// first release, so there is no version ramp to hide behind — every install
// vintage gets them hard (the rampNote mechanism in tools/lib/gate.mjs exists
// for checks added AFTER consumers install, not for these). The per-edit hook
// enforces only the presence floor (see provenance-rules.mjs: no corpus load
// per edit — a hook can only block or pass).
// SOURCE: docs/harness/README.md (the gate is the enforcement; provenance) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { isAllowedCitationHost } from './lib/citation-domains.mjs'
import { fail, MAX_BUFFER, ok } from './lib/gate.mjs'
import {
  CORPUS_REF,
  DECISION_GROUPS,
  extractHttpsUrlHosts,
  extractSourceComments,
  findCitedDecisionSites,
  findUncitedDecisionSites,
  gateFileMatch,
  gateScansFile,
  payloadResolves,
} from './lib/provenance-rules.mjs'

// cwd-relative like every other gate (fixtures and scaffolds carry their own corpus).
const CORPUS_PATH = 'tools/mcp/corpus/index.json'
// Reviewed cross-group citation escapes. ABSENT is fine and means "no escapes";
// MALFORMED fails closed — the file is write-guard-protected, so unparseable
// content is tampering, not config.
const OVERRIDES_PATH = 'tools/provenance-overrides.json'
// Never regex binary blobs in the tree-wide corpus-reference sweep.
const BINARY_FILE =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tar|exe|dll|so|dylib|gguf|hbc|node)$/i

function trackedFiles() {
  // ONE bare `git ls-files` for the whole gate (was two): the gate-file sweep filters
  // this with gateFileMatch in-process (replacing the old GATE_FILE_GLOBS pathspecs),
  // the corpus sweep filters out binaries. execFileSync, never a shell — no argv to
  // glob and nothing for sh to mangle. MAX_BUFFER: a large monorepo (or a force-tracked
  // node_modules) ENOBUFS-crashes node's 1 MB default instead of a named gate error.
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
}

// Enumerate the tracked tree exactly once; both sweeps below reuse it.
const tracked = trackedFiles()

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const uncited = [] // decision sites with no SOURCE in the window (hook parity)
const problems = [] // resolvability + corpus-integrity failures
const semantic = [] // semantic findings: group-match + URL-host allowlist (floor-native, still hard)
const citedSites = [] // cited decision sites, held for the corpus group-match below

// ── 0. reviewed cross-group overrides: schema-validated, fail closed ──────────
// Shape: { comment: string, entries: [{ file, group, id, reason }] } — every
// field a non-empty string, group a known decision-group key, no extra keys
// (a typo'd key would silently grant nothing while a reviewer believes it did).
const overrides = []
if (existsSync(OVERRIDES_PATH)) {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'))
  } catch (e) {
    fail(
      'provenance',
      `${OVERRIDES_PATH} is not valid JSON (${e.message}) — it is write-guard-protected, so a corrupt overrides file is tampering; restore it from git history`,
    )
  }
  const groupKeys = new Set(DECISION_GROUPS.map((g) => g.key))
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof raw.comment !== 'string' ||
    !Array.isArray(raw.entries)
  ) {
    problems.push(
      `${OVERRIDES_PATH}: expected { comment: string, entries: array } — malformed overrides fail closed`,
    )
  } else {
    raw.entries.forEach((entry, i) => {
      const errs = []
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(
          `${OVERRIDES_PATH}: entries[${String(i)}] is not an object — malformed overrides fail closed`,
        )
        return
      }
      for (const field of ['file', 'group', 'id', 'reason']) {
        if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
          errs.push(`missing/empty ${field}`)
        }
      }
      for (const key of Object.keys(entry)) {
        if (!['file', 'group', 'id', 'reason'].includes(key))
          errs.push(`unknown key ${JSON.stringify(key)}`)
      }
      if (typeof entry.group === 'string' && entry.group !== '' && !groupKeys.has(entry.group)) {
        errs.push(
          `unknown decision group ${JSON.stringify(entry.group)} (known: ${[...groupKeys].join(', ')})`,
        )
      }
      if (errs.length) {
        problems.push(
          `${OVERRIDES_PATH}: entries[${String(i)}]: ${errs.join('; ')} — malformed overrides fail closed`,
        )
        return
      }
      overrides.push(entry)
    })
  }
}

// ── 1. decision sites need a SOURCE, and every SOURCE must resolve ────────────
for (const file of tracked.filter(gateFileMatch).filter(gateScansFile)) {
  const src = read(file)
  if (src === null) continue
  for (const f of findUncitedDecisionSites(src)) {
    uncited.push(`${file}:${f.line}  ${f.excerpt}`)
  }
  for (const site of findCitedDecisionSites(src)) {
    citedSites.push({ file, ...site })
  }
  for (const s of extractSourceComments(src)) {
    if (payloadResolves(s.payload)) continue
    // Distinguish a host-allowlist miss from a payload that grounds nowhere at all.
    const badHosts = extractHttpsUrlHosts(s.payload).filter((h) => !isAllowedCitationHost(h))
    if (badHosts.length) {
      semantic.push(
        `${file}:${s.line}  SOURCE cites URL host(s) not on the citation allowlist: ${badHosts.join(', ')} — ` +
          `pin the authority in ${CORPUS_PATH} and cite [corpus: <id>] (extend the corpus in the same PR), ` +
          'or add the domain to tools/lib/citation-domains.mjs via a reviewed human edit',
      )
    } else {
      problems.push(
        `${file}:${s.line}  SOURCE payload resolves to nothing — need an allowlisted https:// URL, ` +
          `an existing repo-relative path, or a corpus reference (got: ${JSON.stringify(s.payload.trim().slice(0, 80))})`,
      )
    }
  }
}

// ── 2. corpus integrity: tamper-evident, well-formed, group-covering ──────────
let corpus = null
if (!existsSync(CORPUS_PATH)) {
  problems.push(`${CORPUS_PATH}: missing — the pinned corpus is part of the provenance surface`)
} else {
  try {
    corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))
  } catch (e) {
    problems.push(`${CORPUS_PATH}: invalid JSON (${e.message})`)
  }
  if (corpus !== null && !Array.isArray(corpus)) {
    problems.push(`${CORPUS_PATH}: expected an ARRAY of entries`)
    corpus = null
  }
}

const knownIds = new Set()
const knownGroupKeys = new Set(DECISION_GROUPS.map((g) => g.key))
const coveredGroups = new Set()
if (corpus !== null) {
  for (const entry of corpus) {
    const id = typeof entry?.id === 'string' && entry.id.trim() !== '' ? entry.id : null
    if (id === null) {
      problems.push(
        `${CORPUS_PATH}: entry with missing/empty id: ${JSON.stringify(entry).slice(0, 80)}`,
      )
      continue
    }
    knownIds.add(id)
    for (const field of ['title', 'url', 'version']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        problems.push(
          `corpus entry ${id}: missing/empty ${field} — pinned entries must name their authority`,
        )
      }
    }
    if (typeof entry.text !== 'string' || entry.text.trim() === '') {
      problems.push(`corpus entry ${id}: missing/empty text — nothing to hash, nothing cited`)
      continue
    }
    const actual = createHash('sha256').update(entry.text, 'utf8').digest('hex')
    if (entry.sha256 !== actual) {
      problems.push(`corpus entry ${id} text/hash mismatch — the corpus is tamper-evident data`)
    }
    // groups is MANDATORY: a missing `groups` key would be a WILDCARD — citing such an
    // entry would short-circuit the per-site group-match, so any groups-less shipped entry
    // could justify any flagged decision class. Every entry must declare its groups;
    // `groups: []` is the explicit "presence-only" marker (a real authority for a decision
    // NOT in the flagged taxonomy — a11y, tokens, migration discipline) that grounds
    // citation existence but can never justify a flagged decision group.
    if (!Array.isArray(entry.groups)) {
      problems.push(
        `corpus entry ${id}: missing/invalid \`groups\` — declare an array of decision-group keys, or [] for a presence-only authority (a groups-less entry can never universally justify a flagged decision site)`,
      )
    } else {
      for (const g of entry.groups) {
        if (knownGroupKeys.has(g)) {
          coveredGroups.add(g)
        } else {
          problems.push(
            `corpus entry ${id}: unknown decision group ${JSON.stringify(g)} (known: ${[...knownGroupKeys].join(', ')})`,
          )
        }
      }
    }
  }
  // Depth lockstep: the heuristic must never flag a decision class the corpus
  // cannot ground — every group needs at least one authorizing entry.
  for (const g of DECISION_GROUPS) {
    if (!coveredGroups.has(g.key)) {
      problems.push(
        `decision group '${g.key}' (${g.description}) has no corpus entry tagged groups: ["${g.key}"] in ${CORPUS_PATH}`,
      )
    }
  }
}

// ── 2b. group-match: cited corpus entries must justify the decision class ─────
// For each cited decision site, the UNION of the cited entries' `groups` must
// cover every group the site's line matched. Unknown cited ids are already
// failed by sweep 3 below, so they are simply skipped here. Reviewed
// { file, group, id } overrides accept a specific cross-group pairing.
if (corpus !== null) {
  const entryGroups = new Map()
  for (const entry of corpus) {
    if (typeof entry?.id === 'string' && entry.id !== '') {
      // Absent/invalid groups is already a `problems` red above; treat it as [] here so a
      // malformed entry can never open a wildcard by being cited.
      entryGroups.set(entry.id, Array.isArray(entry.groups) ? entry.groups : [])
    }
  }
  for (const site of citedSites) {
    const refs = [...site.payload.matchAll(CORPUS_REF)].map((m) => m[1])
    const known = refs.filter((id) => entryGroups.has(id))
    if (known.length === 0) continue // URL/path citation, or unresolvable ids (sweep 3 reds those)
    // No wildcard: a presence-only ([]) entry contributes NO covered groups, so citing one
    // at a flagged decision site does not auto-satisfy the group-match. The site must
    // cite an entry whose groups actually include the flagged class.
    const covered = new Set(known.flatMap((id) => entryGroups.get(id)))
    for (const g of site.groups) {
      if (covered.has(g)) continue
      if (overrides.some((o) => o.file === site.file && o.group === g && refs.includes(o.id))) {
        continue
      }
      const cited = known.map((id) => `${id} (groups: ${entryGroups.get(id).join(', ') || 'none'})`)
      semantic.push(
        `${site.file}:${site.line}  decision group '${g}' is not justified by the cited corpus ` +
          `entr${known.length === 1 ? 'y' : 'ies'} ${cited.join('; ')} — cite an entry whose groups ` +
          `include '${g}' (extend ${CORPUS_PATH} in the same PR if the authority is missing), or add ` +
          `a reviewed { file, group, id, reason } entry to ${OVERRIDES_PATH}`,
      )
    }
  }
}

// ── 3. every corpus reference in the tracked tree must resolve ────────────────
if (corpus !== null) {
  for (const file of tracked.filter((f) => !BINARY_FILE.test(f))) {
    const src = read(file)
    if (src === null || !src.includes('[corpus:')) continue
    src.split('\n').forEach((ln, i) => {
      for (const m of ln.matchAll(CORPUS_REF)) {
        if (!knownIds.has(m[1])) {
          problems.push(
            `${file}:${i + 1}  [corpus: ${m[1]}] does not resolve to any entry in ${CORPUS_PATH}`,
          )
        }
      }
    })
  }
}

// The semantic checks (group-match + host allowlist) are floor-native in this
// harness — never version-ramped, hard on every install vintage. A future check
// added to this gate AFTER consumers install would use rampNote (tools/lib/
// gate.mjs) instead; these two predate every install by construction.
problems.push(...semantic)

if (uncited.length) {
  process.stderr.write(
    `Provenance gate (check:sources): ${String(uncited.length)} decision site(s) lack an inline ` +
      '`// SOURCE:` (`-- SOURCE:` in SQL) citation. Add `SOURCE: <authoritative URL or doc id>` ' +
      'on/above each, then re-run /verify-citations:\n' +
      `${uncited.join('\n')}\n`,
  )
}
if (problems.length) {
  process.stderr.write(
    `Provenance gate (check:sources): ${String(problems.length)} citation-resolvability / corpus-integrity / citation-justification failure(s):\n` +
      `${problems.join('\n')}\n`,
  )
}
if (uncited.length || problems.length) {
  fail(
    'provenance',
    `${String(uncited.length + problems.length)} provenance failure(s) — details above`,
  )
}

process.stdout.write('check:sources — all decision sites carry SOURCE citations (0 flagged)\n')
process.stdout.write(
  `check:sources — corpus verified: ${String(corpus.length)} entr(ies) hash-clean, all corpus refs resolve, ${String(coveredGroups.size)}/${String(knownGroupKeys.size)} decision groups covered; group-match + URL-host allowlist clean\n`,
)
ok('provenance', 'resolvable, group-matched citations over a tamper-evident corpus')
