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
//      entry in tools/mcp/corpus/index.json (the harness's pinned authorities,
//      owned) or tools/mcp/corpus/project.json (the project's own, seeded; 1.0.4);
//   3. the corpus itself is tamper-evident data — each entry in either file
//      carries a sha256 over its text, non-empty title/url/version, and the
//      entries' `groups` tags must cover every decision group the heuristic can
//      flag. The per-entry lint lives in tools/lib/corpus.mjs, the one reader
//      of both files, which docs-sync and the corpus_search server share. A
//      project id that reuses an upstream id reds naming both files: a project
//      adds authorities, never replaces one;
//   4. group-match: a decision site citing a corpus entry must cite one whose
//      `groups` cover the site's OWN decision group — a resolvable citation
//      that grounds a different decision class is not justification. Reviewed
//      cross-group escapes live in tools/provenance-overrides.json.
// All four checks are FLOOR-NATIVE here: this harness shipped them from its
// first release, so there is no version ramp to hide behind — every install
// vintage gets them hard (the rampNote mechanism in tools/lib/gate.mjs exists
// for checks added AFTER consumers install, not for these). The per-edit hook
// enforces only the presence floor (see provenance-rules.mjs: no corpus load
// per edit).
//
// MANDATORY AND ADVISORY CLASSES (1.1.0, #69). The presence check (1) and the
// group-match (4) judge a site by its decision classes. A site in any MANDATORY
// class reds exactly as before. A site whose every class is ADVISORY
// (provenance-rules.mjs ADVISORY_DECISION_GROUPS, less any class the seeded
// tools/decision-groups.json promotes) prints one
// `provenance: ADVISORY (n) — file:line [class]` line on every run, green or
// red, and is never a red on its own. Resolvability, the host allowlist, corpus
// integrity and the coverage lockstep stay hard for every class: a citation
// that is written must be true.
// SOURCE: docs/harness/README.md (the gate is the enforcement; provenance) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { isAllowedCitationHost } from './lib/citation-domains.mjs'
import { corpusById, loadCorpus, PROJECT_CORPUS, UPSTREAM_CORPUS } from './lib/corpus.mjs'
import { fail, MAX_BUFFER, ok } from './lib/gate.mjs'
// The rules as a NAMESPACE for the 1.1.0 surface (#69): an install can keep a FORK of
// tools/lib/provenance-rules.mjs that `update` parked while it re-planted this gate, and a
// named import of an export the fork lacks fails at LINK time. Through the namespace a
// missing isMandatorySite is `undefined`, and every class then stays mandatory, exactly as
// before the split. The 0.x names stay named.
import * as rulesLib from './lib/provenance-rules.mjs'
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
// Messages about the upstream file's own integrity name index.json; messages that say
// where to ADD an authority name project.json, because extending the owned index forks it.
const CORPUS_PATH = UPSTREAM_CORPUS
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

const uncited = [] // MANDATORY decision sites with no SOURCE in the window (hook parity)
const problems = [] // resolvability + corpus-integrity failures
const semantic = [] // semantic findings: group-match + URL-host allowlist (floor-native, still hard)
const citedSites = [] // cited decision sites, held for the corpus group-match below
// ADVISORY findings (1.1.0): an uncited site or a group-match miss whose classes are all
// advisory. Printed on every run, never a red. { at: 'file:line', groups, why }
const advisory = []

// A fork of the rules lib that predates the split has no isMandatorySite, and no `groups`
// on its findings: every site is then mandatory, as it was.
const isMandatorySite =
  typeof rulesLib.isMandatorySite === 'function' ? rulesLib.isMandatorySite : () => true

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
    if (isMandatorySite(f.groups)) uncited.push(`${file}:${f.line}  ${f.excerpt}`)
    else advisory.push({ at: `${file}:${f.line}`, groups: f.groups, why: 'no SOURCE citation' })
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
          `pin the authority in ${PROJECT_CORPUS} and cite [corpus: <id>] (add the entry in the same PR), ` +
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
// Both files, one lint (tools/lib/corpus.mjs). The upstream index stays MANDATORY: when it
// is missing or malformed the corpus checks below stand down, exactly as before 1.0.4, and
// the project file never stands in for it.
const knownGroupKeys = new Set(DECISION_GROUPS.map((g) => g.key))
const corpus = loadCorpus({ root: process.cwd(), groupKeys: knownGroupKeys })
problems.push(...corpus.problems)
const corpusReady = corpus.upstream === 'ok'
const knownIds = new Set(corpus.entries.map((e) => e.id))
const coveredGroups = corpus.coveredGroups
if (corpusReady) {
  // Depth lockstep: the heuristic must never flag a decision class the corpus
  // cannot ground — every group needs at least one authorizing entry.
  for (const g of DECISION_GROUPS) {
    if (!coveredGroups.has(g.key)) {
      problems.push(
        `decision group '${g.key}' (${g.description}) has no corpus entry tagged groups: ["${g.key}"] in ${CORPUS_PATH} or ${PROJECT_CORPUS} — add the authority that grounds it to ${PROJECT_CORPUS}`,
      )
    }
  }
}

// ── 2b. group-match: cited corpus entries must justify the decision class ─────
// For each cited decision site, the UNION of the cited entries' `groups` must
// cover every group the site's line matched. Unknown cited ids are already
// failed by sweep 3 below, so they are simply skipped here. Reviewed
// { file, group, id } overrides accept a specific cross-group pairing. On an id both
// files pin (already a red above), the upstream entry's groups decide.
if (corpusReady) {
  const entryGroups = new Map()
  for (const [id, { entry }] of corpusById(corpus.entries)) {
    // Absent/invalid groups is already a `problems` red above; treat it as [] here so a
    // malformed entry can never open a wildcard by being cited.
    entryGroups.set(id, Array.isArray(entry.groups) ? entry.groups : [])
  }
  for (const site of citedSites) {
    const refs = [...site.payload.matchAll(CORPUS_REF)].map((m) => m[1])
    const known = refs.filter((id) => entryGroups.has(id))
    if (known.length === 0) continue // URL/path citation, or unresolvable ids (sweep 3 reds those)
    // No wildcard: a presence-only ([]) entry contributes NO covered groups, so citing one
    // at a flagged decision site does not auto-satisfy the group-match. The site must
    // cite an entry whose groups actually include the flagged class.
    const covered = new Set(known.flatMap((id) => entryGroups.get(id)))
    // A site in any mandatory class is judged whole, advisory co-classes included (1.1.0).
    const mandatorySite = isMandatorySite(site.groups)
    for (const g of site.groups) {
      if (covered.has(g)) continue
      if (overrides.some((o) => o.file === site.file && o.group === g && refs.includes(o.id))) {
        continue
      }
      const cited = known.map((id) => `${id} (groups: ${entryGroups.get(id).join(', ') || 'none'})`)
      if (!mandatorySite) {
        advisory.push({
          at: `${site.file}:${site.line}`,
          groups: [g],
          why: `cited ${cited.join('; ')} does not cover this class`,
        })
        continue
      }
      semantic.push(
        `${site.file}:${site.line}  decision group '${g}' is not justified by the cited corpus ` +
          `entr${known.length === 1 ? 'y' : 'ies'} ${cited.join('; ')} — cite an entry whose groups ` +
          `include '${g}' (add the authority to ${PROJECT_CORPUS} in the same PR if it is missing), or add ` +
          `a reviewed { file, group, id, reason } entry to ${OVERRIDES_PATH}`,
      )
    }
  }
}

// ── 3. every corpus reference in the tracked tree must resolve ────────────────
if (corpusReady) {
  for (const file of tracked.filter((f) => !BINARY_FILE.test(f))) {
    const src = read(file)
    if (src === null || !src.includes('[corpus:')) continue
    src.split('\n').forEach((ln, i) => {
      for (const m of ln.matchAll(CORPUS_REF)) {
        if (!knownIds.has(m[1])) {
          problems.push(
            `${file}:${i + 1}  [corpus: ${m[1]}] does not resolve to any entry in ${CORPUS_PATH} or ${PROJECT_CORPUS}`,
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

// Every run prints the advisory findings, green or red, one line each. The line is shaped so
// that neither graduate's ramp-NOTE filter nor any Stop-hook collector (SKIPPED, STAMPED,
// FALLBACK MODEL) can take it for one of theirs.
// The classes still advisory on THIS install: the owned list less any seeded promotion.
const advisoryClasses = (rulesLib.ADVISORY_DECISION_GROUPS ?? []).filter(
  (key) => rulesLib.isMandatoryGroup?.(key) === false,
)
for (const a of advisory) {
  process.stdout.write(
    `provenance: ADVISORY (${String(advisory.length)}) — ${a.at} [${a.groups.join(', ')}] ${a.why}\n`,
  )
}
if (advisory.length) {
  process.stdout.write(
    `check:sources — ${String(advisory.length)} advisory finding(s) above, in advisory classes ` +
      `(${advisoryClasses.join(', ')}): reported on every run, never a red on their own. Cite them, ` +
      'or promote a class with "mandatory": ["<key>"] in tools/decision-groups.json\n',
  )
}

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

process.stdout.write(
  advisory.length
    ? `check:sources — every mandatory decision site carries a justified SOURCE citation; ${String(advisory.length)} advisory finding(s) reported above\n`
    : 'check:sources — all decision sites carry SOURCE citations (0 flagged)\n',
)
process.stdout.write(
  `check:sources — corpus verified: ${String(corpus.entries.length)} entr(ies) hash-clean, all corpus refs resolve, ${String(coveredGroups.size)}/${String(knownGroupKeys.size)} decision groups covered; ${advisory.length ? 'group-match clean for every mandatory site, ' : 'group-match + '}URL-host allowlist clean\n`,
)
ok(
  'provenance',
  `resolvable, group-matched citations over a tamper-evident corpus${advisory.length ? `; ${String(advisory.length)} advisory finding(s) reported, not a red` : ''}`,
)
