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

const truth = {
  chainSteps: VALIDATE_STEPS.length,
  canarySteps: injections === null ? null : Object.keys(injections.steps).length,
  guardRuleIds: ruleIds.length,
}

const problems = []

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
    `${String(truth.guardRuleIds)} guard-rule ids; README/CHANGELOG timings agree)`,
)
