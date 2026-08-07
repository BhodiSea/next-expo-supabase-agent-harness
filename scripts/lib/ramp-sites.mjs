// The shipped ramp fleet, as data — one scanner, three consumers.
//
// `rampNote(gate, minVersion, detail, { until })` fires a NOTE when the install's
// baseVersion is BELOW minVersion and its harnessVersion is BELOW until; it hard-fails
// ("RAMP EXPIRED") when baseVersion is still below minVersion but harnessVersion has
// reached until; and it is INERT — returns false at gate.mjs's first guard — whenever
// baseVersion is already at or above minVersion.
//
// That third case is the one nobody was counting. A ramp whose minVersion sits BELOW the
// oldest release this lineage ever tagged can never fire on any install that has ever
// existed: every real baseVersion is >= the oldest tag, so the escape is unreachable and
// the `until` deadline it advertises is decoration. Six of the eighteen 0.4.0-dated call
// sites were in exactly that state, and the only reason anyone noticed is that somebody
// counted. This module is that count, made mechanical.
//
// Consumers: scripts/check-ramp-ledger.mjs (the factory closure), scripts/ci/upgrade-lane.sh
// (which derives the NOTEs a given baseline should produce, instead of asserting "at least
// one" and thereby demanding every release invent a ramp at minVersion == itself), and
// tests/gates/ramp-expiry.test.mjs.
// SOURCE: template/base/tools/lib/gate.mjs (rampNote's three states)
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOOLS_DIR = fileURLToPath(new URL('../../template/base/tools', import.meta.url))

/**
 * The oldest release THIS lineage ever tagged. Declared as data rather than derived from
 * `git tag`, because a "Use this template" copy starts from a single commit with no tags
 * (README, "fork the harness itself") and a check that silently weakens in a fork is worse
 * than one that states its authority. `checkLineageFloor` corroborates it against git when
 * tags are present.
 *
 * 0.1.3 because entries at 0.1.2 and below are the ANCESTOR's — see the CHANGELOG lineage
 * note. A minVersion of 0.1.0 or 0.1.2 therefore names a vintage no install of this harness
 * has ever carried.
 */
export const LINEAGE_FLOOR = '0.1.3'

/** @param {string} a @param {string} b @returns {-1|0|1} */
export function cmpDotted(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

/**
 * Every `rampNote(` call in `src`, by balanced-paren scan: its argument text and the index
 * of the token itself (which `consumesResult` needs to read what precedes it).
 * Deliberately not a regex: several call sites span five lines and carry nested template
 * literals with their own parentheses.
 * @param {string} src @returns {Array<{args: string, at: number}>}
 */
export function rampNoteCalls(src) {
  const calls = []
  const needle = 'rampNote('
  let from = 0
  for (;;) {
    const at = src.indexOf(needle, from)
    if (at === -1) return calls
    from = at + needle.length
    // A prose mention inside a comment reads identically to a call, and the gate scripts
    // explain their own ramps at length. Judge by the line prefix: no real call site is
    // preceded by `//` or a block-comment `*` on its own line.
    const line = src.slice(src.lastIndexOf('\n', at) + 1, at)
    if (line.includes('//') || /^\s*\*/.test(line)) continue
    let depth = 1
    let i = from
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === '(') depth += 1
      else if (c === ')') depth -= 1
      i += 1
    }
    calls.push({ args: src.slice(from, i - 1), at })
  }
}

/**
 * Resolve `rampNote(GATE, RAMP, …)`'s second argument when it is an identifier rather than
 * a literal. Several gates hoist it to a module constant (`const RAMP = '0.2.0'`,
 * `const MIN_VERSION = '0.1.2'`, `const AGENTS_RAMP = '0.2.0'`), and a scanner that only
 * understood literals would silently report those sites as unparseable — which reads as
 * "no finding" and is how a closure goes vacuous.
 * @param {string} src @param {string} token
 */
function resolveVersionToken(src, token) {
  const literal = token.match(/^'([\d.]+)'$/)
  if (literal) return literal[1]
  if (!/^[A-Z_][A-Z0-9_]*$/.test(token)) return null
  const declared = src.match(new RegExp(`\\b${token}\\s*=\\s*'([\\d.]+)'`))
  return declared ? declared[1] : null
}

/**
 * Whether a call site USES rampNote's return value.
 *
 * This is the difference between an escape and a decoration, and it is invisible at the
 * deadline: `rampNote` prints `RAMP EXPIRED` to stderr and returns false, so a call whose
 * result is discarded takes the same path it always took. check-rate-limits.mjs shipped in
 * exactly that state through three releases — the expiry line printed and the gate then
 * called `ok()` and exited 0. An alarm that rings into a green run is worse than no alarm,
 * because the release notes count it.
 *
 * Judged by the text immediately BEFORE the call: consumed sites are preceded by `if (`,
 * `!`, an assignment, a boolean operator, or `return`; an unconsumed one sits after `;`,
 * `{` or `}` as a bare expression statement.
 * @param {string} src @param {number} at index of the `rampNote(` token
 */
function consumesResult(src, at) {
  return /(?:[(!=&|?:,]|\breturn)$/.test(src.slice(0, at).trimEnd())
}

/**
 * Every ramp call site across a set of ALREADY-READ gate sources.
 *
 * Injectable, and the injection is not decoration: the deadline ratchet
 * (`deadlineRegressions`) has to scan the PREVIOUS RELEASE TAG's tree, which exists only
 * as `git show` output and never as a directory. Same split as scripts/lib/escape-registry.mjs
 * — the pure function takes data, the caller owns the I/O.
 *
 * @param {Array<{file: string, src: string}>} sources
 * @returns {Array<{file: string, gate: string, line: number, minVersion: string|null, until: string|null, consumed: boolean, args: string}>}
 */
export function rampSitesFromSources(sources) {
  const out = []
  for (const { file, src } of [...sources].sort((a, b) => a.file.localeCompare(b.file))) {
    if (!src.includes('rampNote(')) continue
    // The gate's OWN name, not the filename. The two differ often enough that deriving
    // one from the other is wrong rather than merely ugly: check-rls-manifest.mjs prints
    // `schema-rls`, check-prompts-lock.mjs prints `prompts`. Anything that greps a gate's
    // output — the upgrade lane's expectation set above all — needs the name the gate
    // actually writes, and the ledger printed the stripped filename for a release.
    const gate = src.match(/^const GATE = '([^']+)'/m)?.[1] ?? file.replace(/^check-|\.mjs$/g, '')
    for (const { args, at } of rampNoteCalls(src)) {
      // The second positional argument, textually: `GATE, <token>, …`.
      const second = args.split(',')[1]?.trim() ?? ''
      const untilMatch = args.match(/until\s*:\s*'([\d.]+)'/)
      out.push({
        file,
        gate,
        line: src.slice(0, at).split('\n').length,
        minVersion: resolveVersionToken(src, second),
        until: untilMatch ? untilMatch[1] : null,
        consumed: consumesResult(src, at),
        args,
      })
    }
  }
  return out
}

/**
 * Every shipped ramp call site, read from a directory on disk.
 * @param {string} [toolsDir]
 */
export function shippedRampSites(toolsDir = TOOLS_DIR) {
  return rampSitesFromSources(
    readdirSync(toolsDir)
      .sort()
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => ({ file: f, src: readFileSync(join(toolsDir, f), 'utf8') })),
  )
}

/**
 * Which of `sites` a given install would see, and how.
 *
 * `base` is the install's baseVersion (the vintage of its SEEDED content); `harness` is the
 * harness release it now runs. Mirrors gate.mjs exactly, in its order:
 *   inert   — base >= minVersion: the check is already live, no NOTE, no expiry
 *   expired — base < minVersion AND harness >= until: hard failure
 *   noting  — base < minVersion AND harness < until: advisory NOTE
/*
 * The parameter is the two fields this actually reads, not the full site record. The
 * classification is a property of a (minVersion, until) pair — a caller reasoning about a
 * HYPOTHETICAL vintage (the tests, the upgrade lane's expectation set) has no file, line or
 * call text to offer, and demanding them would make the narrower question unaskable.
 */
/**
 * @template {{minVersion: string|null, until: string|null}} S
 * @param {string} base @param {string} harness @param {readonly S[]} sites
 * @returns {{inert: S[], expired: S[], noting: S[]}}
 */
export function classifyForInstall(base, harness, sites) {
  const inert = []
  const expired = []
  const noting = []
  for (const site of sites) {
    if (site.minVersion === null || site.until === null) continue
    if (cmpDotted(base, site.minVersion) >= 0) inert.push(site)
    else if (cmpDotted(harness, site.until) >= 0) expired.push(site)
    else noting.push(site)
  }
  return { inert, expired, noting }
}

/**
 * Sites whose escape has NEVER been reachable: minVersion below the oldest release this
 * lineage tagged, so gate.mjs's `base >= minVersion` guard has returned false on every
 * install that has ever existed. The check is unconditional in practice and the ramp is
 * decoration — delete the wrapper rather than carrying a deadline that cannot arrive.
 * @param {ReturnType<typeof shippedRampSites>} sites @param {string} [floor]
 */
export function neverArmed(sites, floor = LINEAGE_FLOOR) {
  return sites.filter((s) => s.minVersion !== null && cmpDotted(s.minVersion, floor) < 0)
}

// ── the deadline ratchet (0.5.0) ────────────────────────────────────────────────────
//
// WHAT WAS UNENFORCED. docs/runbooks/harness-upgrade.md states, in the imperative voice
// the whole runbook is written in: "There is no flag that extends a deadline — extending
// one is a harness release, deliberately." Nothing checked it. Editing `until: '0.5.0'`
// to `'0.6.0'` in a gate script bought a green release and passed every control in the
// repository, including this file's own ledger, which only ever read the CURRENT tree.
//
// WHY IT COMPARES AGAINST THE PREVIOUS RELEASE TAG, and not a committed ledger file. A
// `scripts/ramp-ledger.json` recording last release's deadlines is edited by the same
// commit that edits the deadline — one diff, both sides, green. A git TAG is the one
// artifact in the repository a working-tree commit cannot rewrite, which is exactly the
// property a ratchet needs. It is the same reasoning scripts/check-dependency-channel.mjs
// uses for the catalog delta.
//
// THE KEY, and its one honest hole. Ramp sites carry no stable id, so they are grouped by
// `(file, minVersion)` and each group's deadlines are compared as SORTED LISTS, pointwise.
// That catches every single-edit evasion, including moving ONE of the four sites that
// share check-docs-sync.mjs's 0.3.0 group. What it does NOT catch is moving one deadline
// later while ADDING a new site to the same group at the old deadline in the same commit:
// the sorted lists then line up. Stating that is better than implying it cannot happen —
// closing it needs a stable per-site id, which is a 20-call-site signature change this
// release did not take. In the meantime the residual path requires fabricating a
// plausible new rampNote call in a CODEOWNERS-covered gate script, which is a visible act
// rather than a one-character edit.
/**
 * `file|minVersion` -> that group's deadlines, ascending. Sorting is what makes the
 * pointwise comparison meaningful when a group holds several sites.
 * @param {Array<{file: string, minVersion: string|null, until: string|null}>} sites
 * @returns {Map<string, string[]>}
 */
function groupDeadlines(sites) {
  const m = new Map()
  for (const s of sites) {
    if (s.minVersion === null || s.until === null) continue
    const k = `${s.file}|${s.minVersion}`
    m.set(k, [...(m.get(k) ?? []), s.until])
  }
  for (const list of m.values()) list.sort(cmpDotted)
  return m
}

/**
 * Every (file, minVersion) slot whose deadline is later now than it was then.
 *
 * A group present THEN and absent NOW is skipped, not reported: deleting a rampNote
 * wrapper makes the check unconditional, which is stricter than the ramp it replaced.
 * @param {Map<string, string[]>} before @param {Map<string, string[]>} now
 * @returns {Array<{file: string, minVersion: string, from: string, to: string}>}
 */
function findRegressions(before, now) {
  const out = []
  for (const [k, prevList] of before) {
    const nowList = now.get(k) ?? []
    const [file, minVersion] = k.split('|')
    for (let i = 0; i < Math.min(prevList.length, nowList.length); i += 1) {
      if (cmpDotted(nowList[i], prevList[i]) > 0) {
        out.push({ file, minVersion, from: prevList[i], to: nowList[i] })
      }
    }
  }
  return out
}

/**
 * Deadlines that moved LATER since the previous release, minus the reviewed extensions.
 *
 * @param {{
 *   previous: Array<{file: string, minVersion: string|null, until: string|null}>,
 *   current: Array<{file: string, minVersion: string|null, until: string|null}>,
 *   extensions?: Array<{file?: string, minVersion?: string, from?: string, to?: string, why?: string}>,
 * }} input
 * @returns {{ problems: string[], regressions: Array<{file: string, minVersion: string, from: string, to: string}> }}
 */
export function deadlineRegressions({ previous, current, extensions = [] }) {
  const regressions = findRegressions(groupDeadlines(previous), groupDeadlines(current))
  const problems = []

  const matches = (e, r) =>
    e.file === r.file && e.minVersion === r.minVersion && e.from === r.from && e.to === r.to

  for (const r of regressions) {
    const excuse = extensions.find((e) => matches(e, r))
    if (excuse === undefined) {
      problems.push(
        `${r.file}: a ramp at minVersion ${r.minVersion} moved its deadline from ${r.from} to ${r.to}. docs/runbooks/harness-upgrade.md promises consumers "there is no flag that extends a deadline — extending one is a harness release, deliberately". If this release IS that deliberate act, record it as a \`rampExtensions\` entry under this version in template/migrations.json ({ file, minVersion, from, to, why }); otherwise restore ${r.from} and sweep the finding.`,
      )
      continue
    }
    if (typeof excuse.why !== 'string' || excuse.why.length < 40) {
      problems.push(
        `${r.file}: the rampExtensions entry extending ${r.minVersion} from ${r.from} to ${r.to} has a \`why\` of ${String(excuse.why?.length ?? 0)} chars. It is the only thing a consumer reads to learn why a deadline they were told was fixed has moved — an empty reason is the flag this control exists to deny.`,
      )
    }
  }

  // The inverse. An extension naming no regression is either a typo (so the real
  // extension is unexcused and reds above) or a leftover from a previous release that now
  // pre-authorises a move nobody has reviewed.
  for (const e of extensions) {
    if (!regressions.some((r) => matches(e, r))) {
      problems.push(
        `template/migrations.json records a rampExtensions entry for ${String(e.file)} minVersion ${String(e.minVersion)} (${String(e.from)} → ${String(e.to)}), but no such deadline move exists between the previous release and this tree — a stale extension is a standing permission slip. Remove it.`,
      )
    }
  }

  return { problems, regressions }
}
