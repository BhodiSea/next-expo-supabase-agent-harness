#!/usr/bin/env node
// check-claims (G12) — the harness's own quantitative claims must be TRUE and must not
// contradict each other. The README and CHANGELOG hand-author numbers ("21 gates",
// "cold ≈ 70 s"), and nothing recomputed them: the source harness's v0.1.5 shipped with
// the README claiming cold ≈70 s / warm ≈5 s while the CHANGELOG claimed ≈85 s / ≈6 s
// for the SAME release. A harness whose headline is "prove, don't claim" cannot ship
// unverified claims.
//
// Two classes of check:
//   1. DERIVABLE — recompute from the source of truth and assert the prose matches
//      (chain length, canary steps, guard-rule ids). A drifted count is a hard error.
//   2. CONSISTENT — wall-clock timings are hardware-dependent, so no gate can assert
//      they are true. What IS checkable is that the two documents describing the same
//      release do not CONTRADICT each other — which is exactly the defect found.
//
// Run by the repo's own CI (hygiene lane) and `pnpm test`.
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const readme = read('../README.md')
const changelog = read('../CHANGELOG.md')

const { VALIDATE_STEPS } = await import(
  new URL('../template/base/tools/harness.config.mjs', import.meta.url).href
)
const guards = await import(
  new URL('../template/base/.claude/hooks/lib/guard-rules.mjs', import.meta.url).href
)
// The canary registry ships with the W5b test wave — until it lands, the canary-count
// class is SKIPPED (loudly, below), never crashed on and never silently passed.
const injectionsPath = new URL('../tests/canary/injections.json', import.meta.url)
const injections = existsSync(injectionsPath)
  ? JSON.parse(readFileSync(injectionsPath, 'utf8'))
  : null

// DERIVED, not enumerated. A hardcoded table list is how the claim silently stops
// being a claim about all the rules: adding WRITE_SQL_CHECKS to the guard module and
// to the hooks left this file counting the old three tables, so the README's number
// stayed "true" while covering only part of the surface it named. Every array export
// whose entries carry a string `id` is a rule table by construction.
const ruleIds = Object.values(guards)
  .filter((v) => Array.isArray(v) && v.length > 0 && typeof v[0]?.id === 'string')
  .flatMap((table) => table.map((r) => r.id))

// ── DERIVED (0.3.0): the EXECUTED canary count, read off the selftest matrix ─────
// The README's "N can-fail canaries" was hand-authored, so it drifted the moment a leg
// was added or renamed — and it is the one number a reader uses to decide how much of
// this repo's enforcement has actually been watched going red. It is now counted from
// the workflow itself: every step whose title matches `Canary <n>: …`, across the
// selftest workflow AND every scripts/ci/* helper that workflow invokes (the emulator
// legs live in bash files, because the emulator-runner action execs its script under
// dash). A leg deleted from a helper drops the count exactly as a deleted workflow step
// would.
const selftestPath = new URL('../.github/workflows/selftest.yml', import.meta.url)
const selftestText = existsSync(selftestPath) ? readFileSync(selftestPath, 'utf8') : ''
const ciHelperText = [
  ...new Set([...selftestText.matchAll(/scripts\/ci\/[A-Za-z0-9._-]+/g)].map((m) => m[0])),
]
  .map((p) => {
    const url = new URL(`../${p}`, import.meta.url)
    return existsSync(url) ? readFileSync(url, 'utf8') : ''
  })
  .join('\n')
const canaryNumbers = new Set(
  [...`${selftestText}\n${ciHelperText}`.matchAll(/\bCanary (\d+):/g)].map((m) => m[1]),
)

// ── DERIVED (0.3.0): the gates-catalog's own opening chain count ─────────────────
// The catalog opened with "the 26-step VALIDATE_STEPS chain" against a 29-step chain,
// live, for two releases — in the very document whose job is to describe that chain, and
// the one place a reader goes to find out how long it is. docs-sync holds the catalog's
// SECTIONS in lockstep with the steps; nothing held its prose.
const catalogPath = new URL('../template/base/docs/harness/gates-catalog.md', import.meta.url)
const catalogText = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : ''

const truth = {
  chainSteps: VALIDATE_STEPS.length,
  canarySteps: injections === null ? null : Object.keys(injections.steps).length,
  guardRuleIds: ruleIds.length,
  canaryLegs: canaryNumbers.size,
}

const problems = []

// Both new derivations, judged the same way as every claim above them.
for (const [, n] of readme.matchAll(/(\d+) (?:executed |can-fail )?canar(?:y|ies)\b/gi)) {
  if (Number(n) !== truth.canaryLegs) {
    problems.push(
      `README claims ${n} canaries but the selftest matrix (plus its scripts/ci helpers) declares ${String(truth.canaryLegs)} numbered "Canary <n>:" legs — the workflow is the source of truth, because it is what actually runs`,
    )
  }
}
for (const [, n] of catalogText.matchAll(/(\d+)-step `VALIDATE_STEPS` chain/g)) {
  if (Number(n) !== truth.chainSteps) {
    problems.push(
      `docs/harness/gates-catalog.md opens with "the ${n}-step VALIDATE_STEPS chain" but VALIDATE_STEPS has ${String(truth.chainSteps)} — this is the document a reader consults to find out how long the chain is`,
    )
  }
}

// ── 1. DERIVABLE: every "<n> gates" / "<n> steps" claim about the chain ──────────
// Matches "21 gates", "21-step", "21 steps". PLURAL "gates" only, deliberately: the
// README also counts gate FILES ("gate scripts"), and a singular "gate" must not be
// read as a chain-length claim.
for (const [, n] of readme.matchAll(/\b(\d+)[ -](?:gates|steps?\b)/g)) {
  if (Number(n) !== truth.chainSteps) {
    problems.push(
      `README claims "${n} gates/steps" but VALIDATE_STEPS has ${String(truth.chainSteps)} — the chain is the source of truth (tools/harness.config.mjs)`,
    )
  }
}

// ── 1b. DERIVABLE: the canary registry + guard-rule counts, wherever claimed ─────
if (injections === null) {
  console.log(
    'CLAIMS: NOTE — tests/canary/injections.json does not exist yet (it ships with W5b); ' +
      'the canary-count class is SKIPPED, not passed. Any README canary-registry claim is ' +
      'unverified until the registry lands.',
  )
} else {
  for (const [, n] of readme.matchAll(/canary registry \d+ → (\d+) steps/g)) {
    if (Number(n) !== truth.canarySteps) {
      problems.push(
        `README claims a ${n}-step canary registry but tests/canary/injections.json has ${String(truth.canarySteps)}`,
      )
    }
  }
}
for (const [, n] of readme.matchAll(/(\d+) guard[- ]rule ids/g)) {
  if (Number(n) !== truth.guardRuleIds) {
    problems.push(
      `README claims ${n} guard-rule ids but guard-rules.mjs exports ${String(truth.guardRuleIds)}`,
    )
  }
}

// ── 2. CONSISTENT: README vs the LATEST CHANGELOG entry on wall-clock figures ────
// Nothing can assert a timing is TRUE on someone else's hardware — but two documents
// describing the same release must not disagree. Extract "cold ≈ N s" / "warm ≈ N s"
// from each and compare.
const latestEntry = (() => {
  const start = changelog.search(/^## \[/m)
  if (start === -1) return ''
  const rest = changelog.slice(start + 1)
  const next = rest.search(/^## \[/m)
  return next === -1 ? changelog.slice(start) : changelog.slice(start, start + 1 + next)
})()

const timings = (text) => {
  const out = {}
  for (const [, kind, n] of text.matchAll(/\b(cold|warm)\s*≈\s*(\d+)\s*s\b/g)) {
    // Record the FIRST figure per kind; later restatements should agree with it.
    out[kind] ??= Number(n)
  }
  return out
}
const rTimes = timings(readme)
const cTimes = timings(latestEntry)
for (const kind of ['cold', 'warm']) {
  const a = rTimes[kind]
  const b = cTimes[kind]
  if (a !== undefined && b !== undefined && a !== b) {
    problems.push(
      `README says ${kind} ≈ ${String(a)} s but the latest CHANGELOG entry says ${kind} ≈ ${String(b)} s — the same release cannot have two measured timings; make them agree (or drop the figure)`,
    )
  }
}

void root

if (problems.length > 0) {
  console.error(`CLAIMS: ${String(problems.length)} unverified/contradictory claim(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThe harness ships on "prove, don\'t claim" — recompute the numbers or fix the prose.',
  )
  process.exit(1)
}
console.log(
  `CLAIMS: CLEAN (chain ${String(truth.chainSteps)} steps, ` +
    (truth.canarySteps === null
      ? 'canary registry pending (W5b), '
      : `canary ${String(truth.canarySteps)} steps, `) +
    `${String(truth.guardRuleIds)} guard-rule ids, ${String(truth.canaryLegs)} executed canary legs, ` +
    'gates-catalog chain count in lockstep; README/CHANGELOG timings agree)',
)
