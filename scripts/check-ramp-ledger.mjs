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
// SOURCE: docs/runbooks/harness-upgrade.md (ramps expire) · template/base/tools/lib/gate.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  classifyForInstall,
  cmpDotted,
  LINEAGE_FLOOR,
  neverArmed,
  shippedRampSites,
} from './lib/ramp-sites.mjs'

const version = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version

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
const VINTAGES = [LINEAGE_FLOOR, '0.2.0', '0.2.1', '0.3.0']
const ledger = VINTAGES.filter((v) => cmpDotted(v, version) < 0).map((base) => ({
  base,
  ...classifyForInstall(base, version, sites),
}))

if (problems.length > 0) {
  console.error(`RAMP LEDGER: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nA ramp is an escape with an expiry. One that cannot fire is not an escape, and one whose deadline nobody computed is not an expiry.',
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
const affected = ledger.filter((r) => r.expired.length > 0).map((r) => r.base)
console.log(
  affected.length === 0
    ? 'RAMP LEDGER: CLEAN — no released vintage meets a deadline in this version'
    : `RAMP LEDGER: CLEAN — the affected population is baseVersion ${affected.join(' / ')}; every later vintage is untouched`,
)
