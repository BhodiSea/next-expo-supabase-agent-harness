#!/usr/bin/env node
// Scheduled control: is the framework security floor still a REVIEWED floor, or has it
// decayed into a claim that nothing has been published since somebody last looked?
//
// WHY THIS IS NOT A CHAIN STEP, and why saying so matters. `pnpm validate` must be
// deterministic: the same tree, the same verdict, forever. A wall-clock comparison reds an
// unchanged tree on a date nobody chose, which is precisely the reasoning that kept
// `pnpm audit` out of the chain (docs/harness/gates-catalog.md). So the chain judges the
// VERSIONS (clockless, offline, in `version-sync`) and this judges the REVIEW (clockful,
// scheduled). Splitting them is what lets both be strict.
//
// It runs on `schedule` and `workflow_dispatch` only — deliberately NOT on push or PR. A
// lapsed review is a maintenance signal, not a reason a contributor's unrelated patch
// cannot merge, and a control that blocks the wrong person is a control that gets removed.
//   usage: node tools/check-framework-floor.mjs [--today=YYYY-MM-DD] [--floor=<path>]
// SOURCE: docs/harness/gates-catalog.md (the determinism rule that excluded `pnpm audit`)
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { staleReviews } from './lib/framework-floor.mjs'
import { fail, failures, ok } from './lib/gate.mjs'

const GATE = 'floor-review'
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const floorPath = arg('floor', 'tools/framework-floor.json')
// The clock is a PARAMETER, so the red-proof can backdate a review without waiting for a
// calendar and without this script ever being the thing that decides what "now" is.
const today = arg('today', new Date().toISOString().slice(0, 10))

// Not skipOrFail: an absent floor is not a missing toolchain, it is the control itself
// gone. `version-sync`'s framework-floor half silently judges nothing without this file,
// so "it isn't there" must never read as "there was nothing to check".
if (!existsSync(floorPath)) {
  fail(
    GATE,
    `${floorPath} does not exist. The scheduled review has nothing to review, and \`version-sync\`'s framework-floor half silently judges nothing without it.`,
  )
}

let floor
try {
  floor = JSON.parse(readFileSync(floorPath, 'utf8'))
} catch (e) {
  fail(GATE, `${floorPath} is not valid JSON: ${e.message}`)
}

failures(
  GATE,
  staleReviews({ floor, today }).map((p) => `as of ${today}: ${p}`),
  `\nRe-read each package's upstream security feed, update minPatchByMajor and the advisory rows to match, and move reviewedOn/reviewedUntil in the SAME commit. Bumping the dates alone is the one edit this control cannot distinguish from a real review — which is why the diff is reviewed by a human and ${floorPath} is sha-pinned by \`gate-integrity\`.`,
)

const names = Object.keys(floor.packages ?? {}).sort()
ok(
  GATE,
  `${String(names.length)} floored package(s) (${names.join(', ')}) carry an unlapsed review as of ${today}`,
)
