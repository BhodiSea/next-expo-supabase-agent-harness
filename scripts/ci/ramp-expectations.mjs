#!/usr/bin/env node
// What the upgrade lane should SEE, computed from HEAD's own shipped call sites.
//
// Usage: node scripts/ci/ramp-expectations.mjs <baseVersion> <harnessVersion>
// Prints three shell-assignable lines:
//   EXPIRED='<gate> …'   deadlines this leg meets — validate must be RED and each gate
//                        must appear on a `RAMP EXPIRED` line
//   NOTING='<gate> …'    escapes still open — each gate must appear on a dated NOTE
//   INERT=<n>            already-live sites, reported for the log only
//
// WHY THIS EXISTS. The lane used to `die` when the upgraded install produced no ramp NOTE
// at all. Read as a rule that says every release must ship a ramp at `minVersion ==
// itself` or fail — a requirement nobody chose, satisfiable only by inventing an escape
// for a check that does not need one. The honest assertion is not "at least one"; it is
// "exactly these", and the empty set is a legitimate answer with its own consequence:
// nothing is outstanding, so `graduate` must SUCCEED.
//
// Deliberately shares scripts/lib/ramp-sites.mjs with check-ramp-ledger.mjs and
// tests/gates/ramp-ledger.test.mjs. The classification mirrors gate.mjs in its order
// (inert BEFORE expired), so the lane's expectation and the gate's behaviour cannot
// disagree — a second hand-maintained copy would drift, and the drift would show up as a
// green lane.
// SOURCE: template/base/tools/lib/gate.mjs (rampNote's three states)
import { classifyForInstall, shippedRampSites } from '../lib/ramp-sites.mjs'

const [base, harness] = process.argv.slice(2)
if (!base || !harness) {
  console.error('usage: ramp-expectations.mjs <baseVersion> <harnessVersion>')
  process.exit(2)
}

const sites = shippedRampSites()
if (sites.length === 0) {
  // Anti-vacuity: an empty scan would print three empty expectations, and a lane that
  // expects nothing passes against anything.
  console.error(
    'ramp-expectations: the scan found ZERO rampNote() call sites — the harness ships a ramp fleet, so the scanner is broken and every expectation below would be vacuous',
  )
  process.exit(1)
}

const { expired, noting, inert } = classifyForInstall(base, harness, sites)
const names = (rows) => [...new Set(rows.map((s) => s.gate))].sort().join(' ')
console.log(`EXPIRED='${names(expired)}'`)
console.log(`NOTING='${names(noting)}'`)
console.log(`INERT=${String(inert.length)}`)
