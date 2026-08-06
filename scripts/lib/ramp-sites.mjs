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
 * Every shipped ramp call site.
 * @param {string} [toolsDir]
 * @returns {Array<{file: string, gate: string, line: number, minVersion: string|null, until: string|null, consumed: boolean, args: string}>}
 */
export function shippedRampSites(toolsDir = TOOLS_DIR) {
  const out = []
  for (const f of readdirSync(toolsDir).sort()) {
    if (!f.endsWith('.mjs')) continue
    const src = readFileSync(join(toolsDir, f), 'utf8')
    if (!src.includes('rampNote(')) continue
    // The gate's OWN name, not the filename. The two differ often enough that deriving
    // one from the other is wrong rather than merely ugly: check-rls-manifest.mjs prints
    // `schema-rls`, check-prompts-lock.mjs prints `prompts`. Anything that greps a gate's
    // output — the upgrade lane's expectation set above all — needs the name the gate
    // actually writes, and the ledger printed the stripped filename for a release.
    const gate = src.match(/^const GATE = '([^']+)'/m)?.[1] ?? f.replace(/^check-|\.mjs$/g, '')
    for (const { args, at } of rampNoteCalls(src)) {
      // The second positional argument, textually: `GATE, <token>, …`.
      const second = args.split(',')[1]?.trim() ?? ''
      const untilMatch = args.match(/until\s*:\s*'([\d.]+)'/)
      out.push({
        file: f,
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
