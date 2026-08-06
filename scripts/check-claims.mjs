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

// The SHIPPED doctrine and the runner's own header. Both state the chain length in prose a
// consumer reads, and until 0.4.0 both said "21" while the chain was 31 — for three
// releases, in files installed into every project. Nothing looked: this script scanned the
// factory's README/CHANGELOG and the gates-catalog opener, and check-docs-sync.mjs covers
// AGENTS.md's sentence and the catalog SECTIONS. The gap was the doctrine itself.
const doctrinePath = new URL('../template/base/docs/harness/README.md', import.meta.url)
const doctrineText = existsSync(doctrinePath) ? readFileSync(doctrinePath, 'utf8') : ''
const runnerPath = new URL('../template/base/tools/validate.mjs', import.meta.url)
const runnerText = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : ''

const truth = {
  chainSteps: VALIDATE_STEPS.length,
  canarySteps: injections === null ? null : Object.keys(injections.steps).length,
  guardRuleIds: ruleIds.length,
  canaryLegs: canaryNumbers.size,
}

const problems = []

// The status line. It read "pre-release (0.1.x)" at version 0.3.0 — the first thing a
// reader sees, three minors stale, and derivable in one line.
//
// Read package.json only when there is a status line to judge, and guard the read. Every
// other input above is `existsSync`-guarded for the same reason: this script takes no
// positional overrides, so its own fixture tests run a byte-identical COPY inside a
// mirrored tree, and an unguarded read of a file the fixture does not model does not fail
// the claim — it CRASHES the script, which reads as six unrelated red tests.
const pkgPath = new URL('../package.json', import.meta.url)
for (const [, claimed] of readme.matchAll(/\*\*Status: pre-release \((\d+\.\d+)\.x\)/g)) {
  if (!existsSync(pkgPath)) {
    problems.push(
      `README claims "pre-release (${claimed}.x)" but there is no package.json to check it against — an unverifiable claim is not a passing one`,
    )
    continue
  }
  const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  const majorMinor = pkgVersion.split('.').slice(0, 2).join('.')
  if (claimed !== majorMinor) {
    problems.push(
      `README's status line says "pre-release (${claimed}.x)" but package.json is ${pkgVersion} — the first line a reader trusts`,
    )
  }
}

// Both new derivations, judged the same way as every claim above them.
for (const [, n] of readme.matchAll(/(\d+) (?:executed |can-fail )?canar(?:y|ies)\b/gi)) {
  if (Number(n) !== truth.canaryLegs) {
    problems.push(
      `README claims ${n} canaries but the selftest matrix (plus its scripts/ci helpers) declares ${String(truth.canaryLegs)} numbered "Canary <n>:" legs — the workflow is the source of truth, because it is what actually runs`,
    )
  }
}
for (const [file, text] of [
  ['template/base/docs/harness/README.md', doctrineText],
  ['template/base/tools/validate.mjs', runnerText],
]) {
  for (const [, n] of text.matchAll(/~?(\d+)[ -](?:step|canonical steps|gates)\b/g)) {
    if (Number(n) !== truth.chainSteps) {
      problems.push(
        `${file} claims a ${n}-step chain but VALIDATE_STEPS has ${String(truth.chainSteps)} — this file SHIPS into every consumer, so a stale count there is a wrong number in every installed project`,
      )
    }
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
