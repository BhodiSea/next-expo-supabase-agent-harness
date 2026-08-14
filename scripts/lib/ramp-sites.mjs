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

/**
 * Every released vintage a consumer could still be carrying — the populations the ledger
 * classifies an upgrade against.
 *
 * IT LIVES HERE BECAUSE THERE MUST BE ONE COPY. Through 0.5.0 this array was a literal in
 * `check-ramp-ledger.mjs` under a comment reading "The list must grow with every release,
 * which is what the test below pins", and a SECOND hand-typed literal in
 * `tests/gates/ramp-ledger.test.mjs`. Nothing compared them and nothing pinned growth, so
 * the comment asserted a control that did not exist — a release could forget to add its
 * predecessor and every check stayed green. `checkVintages` below is the control the
 * comment was describing; this export is what stops the two copies drifting while it works.
 *
 * Data rather than `git tag` for the same reason as LINEAGE_FLOOR: a template copy has no
 * tags, and a check that silently weakens in a fork is worse than one that states its
 * authority. Corroborated against git whenever tags are present.
 */
export const VINTAGES = [
  LINEAGE_FLOOR,
  '0.2.0',
  '0.2.1',
  '0.3.0',
  '0.4.0',
  '0.5.0',
  '0.6.0',
  '0.7.0',
  '0.8.0',
  '0.9.0',
  '0.9.5',
  '0.9.9',
]

/**
 * Bidirectional closure of VINTAGES against the tags git actually has.
 *
 * MISSING is the failure this exists for: a released tag below the version being cut that
 * nobody added. `classifyForInstall` is never called for that population, so the ledger
 * reports it as unaffected and the release notes under-state their own blast radius —
 * exactly what happened to 0.4.0 before 0.5.0 noticed by hand.
 *
 * STALE is the cheap other half: an entry naming a version this lineage never released.
 *
 * @param {string[]} tags release tags, with or without the leading `v`
 * @param {string} version the version being cut
 * @param {string[]} vintages
 * @returns {string[]} problems, empty when closed
 */
export function checkVintages(tags, version, vintages = VINTAGES) {
  const released = new Set(
    tags.map((t) => String(t).replace(/^v/, '')).filter((t) => /^\d+\.\d+\.\d+$/.test(t)),
  )
  const problems = []
  for (const t of [...released].sort(cmpDotted)) {
    if (cmpDotted(t, version) >= 0) continue
    if (cmpDotted(t, LINEAGE_FLOOR) < 0) continue
    if (!vintages.includes(t)) {
      problems.push(
        `v${t} is a released vintage below ${version} and is absent from VINTAGES (scripts/lib/ramp-sites.mjs) — the ledger never classifies that population, so this release would report it as unaffected without ever asking. Add '${t}'.`,
      )
    }
  }
  for (const v of vintages) {
    if (released.size > 0 && !released.has(v)) {
      problems.push(
        `VINTAGES names '${v}', which is not a released tag of this lineage — a population that never existed cannot be affected, and a stale entry is how the list stops meaning anything.`,
      )
    }
  }
  return problems
}

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
 * The highest `v*.*.*` tag STRICTLY BELOW `version`, or null.
 *
 * STRICTLY BELOW is the entire content of this function, and the version that introduced its
 * caller shipped without it. "The previous release" is the tree a release compares ITSELF
 * against — the deadline ratchet, the dependency channel, the seeded-additions diff all key
 * on it — and the moment the release is tagged, the highest tag IS this version. The caller
 * then diffs HEAD against its own tree, finds no deadline move, and reports the release's own
 * reviewed `rampExtensions` record as a stale permission slip: green through development and
 * red on `main` forever after the tag lands.
 *
 * scripts/ci/upgrade-lane.sh states the rule and implements it correctly — "upgrading from
 * the version you are is a no-op that would pass this lane while proving nothing." This is
 * that rule with one home, so the next reader of release history cannot get a different
 * answer from the one the lane gets.
 * @param {string[]} tags  every tag, any order, `v`-prefixed or not
 * @param {string} version this tree's package.json version
 * @returns {string|null}  the tag as given (prefix preserved), or null when none qualifies
 */
export function highestReleaseBelow(tags, version) {
  return (
    tags
      .map((t) => String(t).trim())
      .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t))
      .filter((t) => cmpDotted(t.replace(/^v/, ''), version) < 0)
      .sort((a, b) => cmpDotted(a.replace(/^v/, ''), b.replace(/^v/, '')))
      .at(-1) ?? null
  )
}

/**
 * Advance past a quoted run starting at `open`; returns the index of its closing quote, or
 * the end of the text when the quote never closes.
 * @param {string} text @param {number} open
 */
function skipQuoted(text, open) {
  const q = text[open]
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === q) return i
  }
  return text.length
}

/**
 * A call's argument text, split on TOP-LEVEL commas only.
 *
 * Not `args.split(',')`, which is what this replaced. The second argument survived that
 * treatment by luck — no comma precedes it — but the third does not: the detail string at
 * check-gate-integrity.mjs:152 reads `'hash coverage of the enforcement configs (.mcp.json,
 * lefthook.yml, …)'`, five commas and a paren pair inside one quoted literal. A naive split
 * hands back a fragment, and a fragment used as an identity key is an identity that changes
 * whenever the prose around it does.
 *
 * Known limit: a quote nested inside a template literal's `${…}` ends the scan early. No
 * shipped site has one, and the failure mode is a mis-spanned — but still STABLE — detail,
 * so the ratchet key degrades in precision rather than in reliability.
 * @param {string} text @returns {string[]}
 */
function splitArgs(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') i = skipQuoted(text, i)
    else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim())
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
 * @returns {Array<{file: string, gate: string, line: number, minVersion: string|null, until: string|null, detail: string|null, consumed: boolean, args: string}>}
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
      // `GATE, <minVersion>, <detail>, { until }` — positional, textually.
      const positional = splitArgs(args)
      const untilMatch = args.match(/until\s*:\s*'([\d.]+)'/)
      out.push({
        file,
        gate,
        line: src.slice(0, at).split('\n').length,
        minVersion: resolveVersionToken(src, positional[1] ?? ''),
        until: untilMatch ? untilMatch[1] : null,
        // The escape's IDENTITY — see the ratchet's header. Source text, whitespace-collapsed
        // so a reflow across lines is not a rename.
        detail: positional[2]?.replace(/\s+/g, ' ') ?? null,
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
// THE KEY IS THE DETAIL STRING (0.6.0). Sites are grouped by `(file, detail)` — the third
// positional argument to `rampNote`, the prose that names the escape — and each group's
// deadlines are compared as SORTED LISTS, pointwise.
//
// It was `(file, minVersion)` through 0.5.0, and 0.6.0 walked straight through the hole that
// leaves. check-docs-sync.mjs's AGENTS.md gate-list ramp had to be RE-OPENED: it expired at
// 0.5.0, this release injects a chain step via configSteps, AGENTS.md is seeded so `update`
// cannot rewrite it, and hard-redding every existing install on an upgrade they did not ask
// for is the ambush the whole mechanism exists to prevent. Re-opening means widening the
// forgiven population — minVersion 0.3.0 -> 0.6.0 — and moving the deadline 0.5.0 -> 0.7.0.
// Under the old key that is not one site moving; it is one key VANISHING (read as a deletion,
// which is stricter, so allowed) and another APPEARING (read as a new escape, so allowed).
// A deadline moved two releases later and every control in the repository stayed green.
//
// The detail string closes that, and it closed the hole 0.5.0 documented as residual too:
// moving one deadline while adding a sibling at the old one no longer lines the lists up,
// because the sibling has its own name. check-ramp-ledger.mjs enforces the property that
// makes the key an id — every site parses a detail, and no two sites in a file share one.
//
// THE RESIDUAL HOLE, restated honestly. Rewording the detail in the same commit that moves
// the deadline still evades it: the old key vanishes, a new one appears. That is a smaller
// hole than the one it replaces — it takes rewriting the sentence a consumer reads in the
// NOTE, in a CODEOWNERS-covered gate script, rather than editing one version literal — and
// closing it properly needs an id that is not also documentation. Stated rather than implied.
/**
 * `file|detail` -> that group's sites, ascending by deadline. Sorting is what makes the
 * pointwise comparison meaningful in the residual case where a file carries two sites under
 * one detail; check-ramp-ledger.mjs reds on that in the CURRENT tree, but a PREVIOUS tag's
 * tree is read as it was and gets no vote.
 * @template {{file: string, minVersion: string|null, until: string|null, detail?: string|null}} S
 * @param {readonly S[]} sites
 * @returns {Map<string, S[]>}
 */
function groupDeadlines(sites) {
  const m = new Map()
  for (const s of sites) {
    if (s.minVersion === null || s.until === null) continue
    // NUL as the separator, written as the escape: a detail string is prose and may contain
    // any printable character, so a `|` or a space would let one site's file+detail collide
    // with another's. scripts/hygiene.mjs reds on a LITERAL NUL in a source file — it makes
    // the file `data` to grep — and caught this line when it was one.
    const k = `${s.file}\u0000${s.detail ?? ''}`
    m.set(k, [...(m.get(k) ?? []), s])
  }
  for (const list of m.values()) list.sort((a, b) => cmpDotted(a.until, b.until))
  return m
}

/**
 * Every (file, detail) slot whose deadline is later now than it was then.
 *
 * A group present THEN and absent NOW is skipped, not reported: deleting a rampNote
 * wrapper makes the check unconditional, which is stricter than the ramp it replaced.
 *
 * `minVersion` is reported from the CURRENT site, never matched on — a re-opened ramp
 * widens its population, and a key that moved with it would be no key at all.
 * @param {Map<string, any[]>} before @param {Map<string, any[]>} now
 * @returns {Array<{file: string, detail: string, minVersion: string, from: string, to: string}>}
 */
function findRegressions(before, now) {
  const out = []
  for (const [k, prevList] of before) {
    const nowList = now.get(k) ?? []
    for (let i = 0; i < Math.min(prevList.length, nowList.length); i += 1) {
      if (cmpDotted(nowList[i].until, prevList[i].until) > 0) {
        out.push({
          file: nowList[i].file,
          detail: nowList[i].detail ?? '',
          minVersion: nowList[i].minVersion,
          from: prevList[i].until,
          to: nowList[i].until,
        })
      }
    }
  }
  return out
}

/**
 * Deadlines that moved LATER since the previous release, minus the reviewed extensions.
 *
 * The excuse is matched on `(file, detail, from, to)` — the escape's identity plus the move,
 * and deliberately NOT on minVersion, which a re-opened ramp legitimately changes.
 *
 * @param {{
 *   previous: Array<{file: string, minVersion: string|null, until: string|null, detail?: string|null}>,
 *   current: Array<{file: string, minVersion: string|null, until: string|null, detail?: string|null}>,
 *   extensions?: Array<{file?: string, detail?: string, from?: string, to?: string, why?: string}>,
 * }} input
 * @returns {{ problems: string[], regressions: Array<{file: string, detail: string, minVersion: string, from: string, to: string}> }}
 */
export function deadlineRegressions({ previous, current, extensions = [] }) {
  const regressions = findRegressions(groupDeadlines(previous), groupDeadlines(current))
  const problems = []

  const matches = (e, r) =>
    e.file === r.file && e.detail === r.detail && e.from === r.from && e.to === r.to

  for (const r of regressions) {
    const excuse = extensions.find((e) => matches(e, r))
    if (excuse === undefined) {
      problems.push(
        `${r.file}: the ramp ${r.detail} moved its deadline from ${r.from} to ${r.to} (it now opens at minVersion ${r.minVersion}). docs/runbooks/harness-upgrade.md promises consumers "there is no flag that extends a deadline — extending one is a harness release, deliberately". If this release IS that deliberate act, record it as a \`rampExtensions\` entry under this version in template/migrations.json ({ file, detail, from, to, why }), copying \`detail\` BYTE-FOR-BYTE from the finding above; otherwise restore ${r.from} and sweep the finding.`,
      )
      continue
    }
    if (typeof excuse.why !== 'string' || excuse.why.length < 40) {
      problems.push(
        `${r.file}: the rampExtensions entry extending ${r.detail} from ${r.from} to ${r.to} has a \`why\` of ${String(excuse.why?.length ?? 0)} chars. It is the only thing a consumer reads to learn why a deadline they were told was fixed has moved — an empty reason is the flag this control exists to deny.`,
      )
    }
  }

  // The inverse. An extension naming no regression is either a typo (so the real
  // extension is unexcused and reds above) or a leftover from a previous release that now
  // pre-authorises a move nobody has reviewed.
  for (const e of extensions) {
    if (!regressions.some((r) => matches(e, r))) {
      problems.push(
        `template/migrations.json records a rampExtensions entry for ${String(e.file)} — ${String(e.detail)} (${String(e.from)} → ${String(e.to)}), but no such deadline move exists between the previous release and this tree — a stale extension is a standing permission slip. Remove it.`,
      )
    }
  }

  return { problems, regressions }
}

/**
 * The property that makes `detail` an ID rather than a comment: every site parses one, and
 * no two sites in a file share one.
 *
 * Without this the ratchet degrades silently. A site whose detail does not parse groups
 * under an empty key alongside every other unparseable one in the file, and two sites
 * sharing a detail fall back to the pointwise list comparison — which is exactly the
 * lists-line-up evasion the detail key was adopted to close.
 * @param {Array<{file: string, line: number, detail: string|null}>} sites
 * @returns {string[]} problems, empty when the ids are sound
 */
export function checkDetailIds(sites) {
  const problems = []
  const seen = new Map()
  for (const s of sites) {
    const where = `${s.file}:${String(s.line)}`
    if (s.detail === null || s.detail === '') {
      problems.push(
        `${where}: this rampNote call has no readable third argument. That argument is the escape's identity for the deadline ratchet (scripts/lib/ramp-sites.mjs) — a site without one cannot be tracked across a release, so its deadline could move unseen.`,
      )
      continue
    }
    const prior = seen.get(`${s.file} ${s.detail}`)
    if (prior !== undefined) {
      problems.push(
        `${where} and ${prior} share the detail string ${s.detail}. The ratchet uses (file, detail) as a per-site id, so two sites under one name are compared as a sorted LIST and a move inside the pair lines up with itself. Reword one to say which escape it is.`,
      )
      continue
    }
    seen.set(`${s.file} ${s.detail}`, where)
  }
  return problems
}
