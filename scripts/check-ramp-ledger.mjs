#!/usr/bin/env node
// check-ramp-ledger — the deadlines a release is RESPONSIBLE for, computed rather than
// remembered.
//
// 0.3.0 made `until` mandatory and tests/gates/ramp-expiry.test.mjs proved every shipped
// call site carries one. What nothing did was ask the two questions a release actually has
// to answer about that fleet:
//
//   1. Can this escape ever fire? A ramp whose `minVersion` sits below the oldest release
//      this lineage ever tagged is unreachable on every install that has ever existed —
//      gate.mjs returns false at its FIRST guard, before the deadline is even read. It is a
//      check shipped unconditional wearing a ramp's clothes, and its advertised deadline is
//      decoration. Six of the eighteen 0.4.0-dated sites were in exactly this state and
//      three surveys of the release described them as "expiring".
//   2. Who does this release actually red? Not a number somebody typed into a changelog —
//      the POPULATION, derived from the shipped call sites and stated as a baseVersion
//      range, with the count computed from it.
//
// This is check-claims.mjs's move applied to the ramp fleet: the release note states the
// population, and the machine computes the number. A hand-authored "18 ramps expire" is
// precisely the class of claim this repository exists to delete.
//
// 0.5.0 adds the two questions this could not answer, and both are about TIME rather than
// about the current tree:
//
//   3. Did a deadline MOVE? Nothing compared this release's `until` values against the
//      previous release's, so editing 0.5.0 to 0.6.0 in a gate script bought a green
//      release and contradicted a promise the runbook makes to consumers in writing.
//   4. Does the release SAY who it reds, in data? The population was computed and printed
//      here and separately prose-described in template/migrations.json, and nothing
//      compared the two — which is the shape of every claim this repository deletes.
// SOURCE: docs/runbooks/harness-upgrade.md (ramps expire) · template/base/tools/lib/gate.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  classifyForInstall,
  cmpDotted,
  deadlineRegressions,
  LINEAGE_FLOOR,
  neverArmed,
  rampSitesFromSources,
  shippedRampSites,
} from './lib/ramp-sites.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const inCI = () => process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

const version = JSON.parse(read('../package.json')).version
const migrations = JSON.parse(read('../template/migrations.json'))

const sites = shippedRampSites()
const problems = []

// Anti-vacuity, first. Every other assertion here is a filter over `sites`, so a scan that
// found nothing would report a clean ledger — the exact failure shape this release is about.
if (sites.length < 15) {
  problems.push(
    `the scan found only ${String(sites.length)} rampNote() call site(s) — the fleet is larger than that, so the scanner is not seeing the calls and every check below is vacuous`,
  )
}

// A site the scanner cannot read is a site this closure does not cover. Fail closed rather
// than skip it: an unparseable `minVersion` is how a never-armed ramp hides.
for (const s of sites.filter((x) => x.minVersion === null || x.until === null)) {
  problems.push(
    `${s.file}: could not resolve ${s.minVersion === null ? 'minVersion' : 'until'} from the call site — this gate fails closed rather than exempt what it cannot read. Use a string literal, or a MODULE-SCOPE \`const NAME = 'x.y.z'\` the scanner resolves.`,
  )
}

// The other way a deadline is decoration: the call fires and nobody reads the answer.
// `rampNote` signals expiry by printing RAMP EXPIRED and returning FALSE — the same value
// it returns when the check is simply live — so a site that discards it takes the identical
// path before and after the deadline. check-rate-limits.mjs did exactly that for three
// releases: the expiry line printed to stderr and the gate then called ok() and exited 0.
// That is the worst of the three states, because a release NOTES it as expiring.
for (const s of sites.filter((x) => !x.consumed)) {
  problems.push(
    `${s.file}:${String(s.line)}: the rampNote() result is discarded, so this ramp gates nothing. Expiry and "already live" are the SAME return value (false) — an unconsumed call prints RAMP EXPIRED and then continues down the ramped path, which usually ends in ok(). Consume it: \`if (rampNote(…)) { ok(…) }\` followed by the strict path, or \`const ramped = rampNote(…)\`.`,
  )
}

for (const s of neverArmed(sites)) {
  problems.push(
    `${s.file}: minVersion ${s.minVersion} is BELOW this lineage's oldest release (${LINEAGE_FLOOR}), so the escape has never been reachable — gate.mjs returns false at \`base >= minVersion\` for every install that has ever existed. Its \`until: ${s.until}\` deadline can never arrive. Delete the rampNote() wrapper and let the check run unconditionally; do not "expire" a ramp that never armed.`,
  )
}

// The ledger itself. For each released vintage a consumer could still be carrying, what does
// an upgrade TO this version do? The population is what the release notes state.
// Every released vintage below the version being cut. 0.4.0 joined in 0.5.0 — its absence
// was not cosmetic: a ramp opened at minVersion '0.5.0' is aimed squarely at 0.4.0-vintage
// installs, and with 0.4.0 missing from this list the ledger reported that population as
// unaffected. The list must grow with every release, which is what the test below pins.
const VINTAGES = [LINEAGE_FLOOR, '0.2.0', '0.2.1', '0.3.0', '0.4.0']
const ledger = VINTAGES.filter((v) => cmpDotted(v, version) < 0).map((base) => ({
  base,
  ...classifyForInstall(base, version, sites),
}))
const affected = ledger.filter((r) => r.expired.length > 0).map((r) => r.base)

// ── 3. THE DEADLINE RATCHET (0.5.0) ──────────────────────────────────────────────────
// Against the previous release TAG's tree, because that is the one artifact in the repo a
// working-tree commit cannot rewrite in lockstep with the thing it guards.
//
// SKIP-LOUDLY / FAIL-CLOSED, the same asymmetry the gates use for toolchains, applied to
// git history: without the tag this SKIPS and says so; in CI it FAILS. `machinery-lint`
// checks out with fetch-depth: 0 for exactly this reason.
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** The highest v*.*.* tag. Not `git describe`: on a release commit that resolves to itself. */
function previousTag() {
  try {
    return (
      git(['tag', '--list', 'v*.*.*'])
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
        .sort((a, b) => cmpDotted(a.slice(1), b.slice(1)))
        .at(-1) ?? null
    )
  } catch {
    return null
  }
}

const tag = previousTag()
let ratchetSummary
if (tag === null) {
  const msg =
    'no v*.*.* tag is reachable, so no previous deadline set exists to ratchet against. This needs full history (fetch-depth: 0).'
  if (inCI()) {
    problems.push(`${msg} A skip is not allowed in CI.`)
  } else {
    ratchetSummary = `deadline ratchet SKIPPED — ${msg} (FAILS CLOSED in CI)`
  }
} else {
  try {
    const files = git(['ls-tree', '--name-only', `${tag}:template/base/tools`])
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.mjs'))
    const previous = rampSitesFromSources(
      files.map((f) => ({ file: f, src: git(['show', `${tag}:template/base/tools/${f}`]) })),
    )
    // Anti-vacuity in the one direction that matters: an empty previous set makes every
    // comparison below vacuously clean, which is indistinguishable from "no deadline moved".
    if (previous.length < 15) {
      problems.push(
        `only ${String(previous.length)} ramp site(s) recovered from ${tag} — the fleet was larger than that at every release, so the previous-tree read is broken and the deadline ratchet would pass vacuously.`,
      )
    }
    const extensions = (migrations[version]?.rampExtensions ?? []).map((e) => ({ ...e }))
    const { problems: moved, regressions } = deadlineRegressions({
      previous,
      current: sites,
      extensions,
    })
    problems.push(...moved)
    ratchetSummary = `deadline ratchet vs ${tag}: ${String(previous.length)} prior site(s), ${String(regressions.length)} deadline move(s), ${String(extensions.length)} reviewed extension(s)`
  } catch (e) {
    const msg = `reading ${tag}'s tools tree failed (shallow clone, or the tag object is absent): ${String(e.message).slice(0, 200)}`
    if (inCI()) problems.push(`${msg} A skip is not allowed in CI.`)
    else ratchetSummary = `deadline ratchet SKIPPED — ${msg} (FAILS CLOSED in CI)`
  }
}

// ── 4. THE POPULATION, AS DATA RATHER THAN PROSE (0.5.0) ─────────────────────────────
// The ledger has always COMPUTED who a release reds and printed it. template/migrations.json
// and the upgrade runbook have always STATED it in prose. Nothing compared them, so the
// number a consumer reads before upgrading and the number the machine derives were two
// independent claims that happened to agree. Only the CURRENT version's record is judged:
// an older record describes the fleet as it stood at that release, and the fleet has moved.
const record = migrations[version]?.rampExpiry
if (affected.length > 0 && record === undefined) {
  problems.push(
    `this release closes escapes on baseVersion ${affected.join(' / ')}, but template/migrations.json has no \`rampExpiry\` record under "${version}". A release that reds an existing install must say WHICH installs, in data a machine can compare — add { "affects": ${JSON.stringify(affected)}, "why": "…" }.`,
  )
} else if (affected.length === 0 && record !== undefined) {
  problems.push(
    `template/migrations.json carries a \`rampExpiry\` record under "${version}" but no released vintage meets a deadline in this version — a stale record tells consumers to prepare for a sweep that will not happen.`,
  )
} else if (record !== undefined) {
  const stated = [...(record.affects ?? [])]
  if (JSON.stringify(stated) !== JSON.stringify(affected)) {
    problems.push(
      `template/migrations.json "${version}".rampExpiry.affects is ${JSON.stringify(stated)} but the shipped call sites compute ${JSON.stringify(affected)}. The record is what an upgrading consumer reads to decide whether this release touches them; the call sites are what actually reds. Reconcile them — and if the computed set is the surprise, that is the finding.`,
    )
  }
  if (typeof record.why !== 'string' || record.why.length < 40) {
    problems.push(
      `template/migrations.json "${version}".rampExpiry needs a \`why\` explaining what the affected installs must sweep — it is the pointer a consumer follows into docs/runbooks/harness-upgrade.md.`,
    )
  }
}

if (problems.length > 0) {
  console.error(`RAMP LEDGER: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nA ramp is an escape with an expiry. One that cannot fire is not an escape, one whose deadline nobody computed is not an expiry, and one whose deadline can be moved in the commit that meets it is not a deadline.',
  )
  process.exit(1)
}

console.log(`RAMP LEDGER for v${version} — ${String(sites.length)} shipped ramp site(s):`)
for (const row of ledger) {
  const detail =
    row.expired.length === 0
      ? 'nothing expires'
      : `${String(row.expired.length)} EXPIRE: ${[...new Set(row.expired.map((s) => s.gate))].sort().join(', ')}`
  console.log(
    `  baseVersion ${row.base} → ${detail}; ${String(row.noting.length)} still advisory; ${String(row.inert.length)} already live`,
  )
}
if (ratchetSummary !== undefined) console.log(`  ${ratchetSummary}`)
console.log(
  affected.length === 0
    ? 'RAMP LEDGER: CLEAN — no released vintage meets a deadline in this version'
    : `RAMP LEDGER: CLEAN — the affected population is baseVersion ${affected.join(' / ')}, stated in template/migrations.json and computed here; every later vintage is untouched`,
)
