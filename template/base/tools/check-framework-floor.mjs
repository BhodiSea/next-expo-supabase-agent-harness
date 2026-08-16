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
import { staleCcReview } from './lib/cc-floor.mjs'
import { staleEolReview } from './lib/eol.mjs'
import { staleReviews } from './lib/framework-floor.mjs'
import { fail, failures, ok } from './lib/gate.mjs'
import { staleSecurityTxt } from './lib/security-txt.mjs'

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

// THE CLAUDE CODE FLOOR RIDES THIS JOB TOO (0.6.0), because it decays the same way and
// faster. `tools/cc-floor.json` is a snapshot of an advisory query; left alone it becomes the
// assertion that nothing has been published since — and that database gained fifteen entries
// in the seven months before the floor was first written. Its CLOCKLESS half (the arithmetic)
// rides `version-sync` in the chain; only the freshness question belongs on a clock.
// Absent is a NOTE, not a red: the file ships with 0.6.0, and an install that predates it has
// no snapshot to have let lapse.
const ccPath = arg('cc-floor', 'tools/cc-floor.json')
const ccProblems = []
if (existsSync(ccPath)) {
  try {
    ccProblems.push(
      ...staleCcReview({ floor: JSON.parse(readFileSync(ccPath, 'utf8')), today, path: ccPath }),
    )
  } catch (e) {
    ccProblems.push(`${ccPath} is not valid JSON: ${e.message}`)
  }
} else {
  console.log(
    `${GATE}: NOTE — ${ccPath} is absent, so the Claude Code version floor is not being reviewed. It ships with 0.6.0; run \`npx next-expo-supabase-agent-harness update\` to get it.`,
  )
}

// THE END-OF-LIFE REGISTER RIDES THIS JOB TOO (0.9.9), and it decays by a mechanism the
// other two do not share. A deprecation flag reaches this tree only when the lockfile is
// RE-RESOLVED — pnpm copies it from the registry at resolve time — so a project that
// installs once and never reinstalls holds a census frozen at that moment while vendors go
// on abandoning packages. The clockless half in `version-sync` cannot see that: the census
// it judges agrees with the register perfectly, because both are equally old.
// Absent is a NOTE, not a red: the file ships with 0.9.9 and an install that predates it
// has no register to have let lapse.
const eolPath = arg('eol', 'tools/eol.json')
const eolProblems = []
if (existsSync(eolPath)) {
  try {
    eolProblems.push(
      ...staleEolReview({
        register: JSON.parse(readFileSync(eolPath, 'utf8')),
        path: eolPath,
        today,
      }),
    )
  } catch (e) {
    eolProblems.push(`${eolPath} is not valid JSON: ${e.message}`)
  }
} else {
  console.log(
    `${GATE}: NOTE — ${eolPath} is absent, so no dependency here is being reviewed for VENDOR SUPPORT, only for patch level. It ships with 0.9.9; run \`npx next-expo-supabase-agent-harness update\` to get it.`,
  )
}

// RFC 9116 security.txt RIDES THIS JOB TOO (1.0.0), because its mandatory `Expires`
// is exactly the kind of reviewer-supplied bound the other three riders age: a lapsed
// one leaves the PUBLISHED disclosure channel telling researchers not to trust it.
// The clockless half (present ⇒ parses) rides `security-headers` in the chain; only
// the calendar question — expired, or a bound past the RFC's one-year recommendation —
// belongs here. Absent is a NOTE, not a red: the file is seedOnInitOnly since 1.0.0
// (the bound must be the consumer's review, never a planted date nobody chose), so an
// existing install legitimately has no bound to have let lapse.
const stxtPath = arg('security-txt', 'apps/web/public/.well-known/security.txt')
const stxtProblems = []
if (existsSync(stxtPath)) {
  stxtProblems.push(
    ...staleSecurityTxt({ text: readFileSync(stxtPath, 'utf8'), today, path: stxtPath }),
  )
} else {
  console.log(
    `${GATE}: NOTE — ${stxtPath} is absent, so no machine-readable disclosure channel is being reviewed. It seeds at init since 1.0.0; adopt it by writing the file with a reviewed RFC 9116 Expires bound.`,
  )
}

failures(
  GATE,
  [...staleReviews({ floor, today }), ...ccProblems, ...eolProblems, ...stxtProblems].map(
    (p) => `as of ${today}: ${p}`,
  ),
  `\nRe-read each package's upstream security feed, update minPatchByMajor and the advisory rows to match, and move reviewedOn/reviewedUntil in the SAME commit. Bumping the dates alone is the one edit this control cannot distinguish from a real review — which is why the diff is reviewed by a human and ${floorPath} is sha-pinned by \`gate-integrity\`.`,
)

const names = Object.keys(floor.packages ?? {}).sort()
ok(
  GATE,
  `${String(names.length)} floored package(s) (${names.join(', ')})${existsSync(ccPath) ? ', the Claude Code advisory snapshot' : ''}${existsSync(eolPath) ? ', the end-of-life register' : ''}${existsSync(stxtPath) ? ' and the security.txt bound' : ''} carry an unlapsed review as of ${today}`,
)
