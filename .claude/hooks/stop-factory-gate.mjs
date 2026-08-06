#!/usr/bin/env node
// FACTORY dogfood: the Stop gate for work ON the harness.
//
// A consumer's turn cannot end until `pnpm validate` is green. Until now a MAINTAINER's
// turn could end having broken the thing that enforces that — a gate whose canary no
// longer covers it, a README number that stopped matching the chain, a floor snapshot out
// of lockstep with the config it mirrors. The harness's own closure checks existed and
// ran only when somebody remembered, or in CI after the fact.
//
// The steps below are the factory's equivalent of the consumer chain, and they are chosen
// on the same rule: everything here is pure node, read-only, and fast, because a Stop gate
// that takes a minute is a Stop gate people disable. The expensive proofs — rendering a
// scaffold, installing it, running its 31 gates, the live-Supabase canaries — stay in the
// selftest matrix where they belong.
//
// WHAT IS DELIBERATELY ABSENT: `node --test tests/**`. It is ~30s, which is four times the
// budget of everything else here combined, and its failures are ordinary test failures the
// maintainer is already looking at. The checks below are different in kind — they are the
// ones nobody thinks to run, because their subject is the machinery's own consistency.
// SOURCE: docs/harness/README.md (the factory eats its own dog food)
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { block, pass, readHookInput } from '../../template/base/.claude/hooks/lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.3.0'

const STEPS = [
  // The shipped artifact stays generic, and every directory listing in the enforcement
  // surface is sorted (the determinism sweep — the rule the harness ships to consumers,
  // applied to the gate scripts ESLint deliberately does not lint).
  ['hygiene', ['scripts/hygiene.mjs']],
  // Every chain step and CI lane carries a registered red-proof, and every guard-rule id a
  // behavioral canary. --no-spawn: the executing half needs the test runner and is CI's.
  ['canary-coverage', ['scripts/check-canary-coverage.mjs', '--no-spawn']],
  // The custom lint rules and depcruise boundaries cannot be silently narrowed.
  ['rule-integrity', ['scripts/check-rule-integrity.mjs']],
  // Every number in the README/CHANGELOG is recomputed from the real chain.
  ['claims', ['scripts/check-claims.mjs']],
  // The frozen CI floor still mirrors harness.config.mjs — a locally weakened config
  // cannot weaken CI, but only if the two are in lockstep.
  ['floor-sync', ['scripts/generate-floor.mjs', '--check']],
  // A ramp whose minVersion predates the lineage's oldest release can never fire, and the
  // deadlines a release is responsible for are COMPUTED here rather than typed into a
  // changelog. Six never-armed ramps shipped for three releases before anything counted.
  ['ramp-ledger', ['scripts/check-ramp-ledger.mjs']],
  // Every one-surface gate declares its surface in enforcement-tiers.md. Five layers were
  // undeclared when this first ran — the state that file's opening line calls illegitimate.
  ['tier-coverage', ['scripts/check-tier-coverage.mjs']],
  // The harness holds itself to the cognitive-complexity bar it reds consumers for.
  ['complexity', ['scripts/check-complexity-ratchet.mjs']],
  // Every shipped module parses and every shipped JSON is valid — including .tmpl files,
  // which no other check in this repo ever executes.
  ['syntax', ['scripts/check-syntax.mjs']],
]

// THE THREE MACHINERY CHECKS THAT WERE CI-ONLY (0.3.0). eslint, tsc and knip run over the
// factory's own sources in the `lint` workflow and nowhere else, so a maintainer could end
// a turn having introduced a type error, a lint violation or a dead export into the
// installer or the gate scripts — and find out on a PR, after the fact. That is precisely
// the asymmetry the dogfood exists to delete: a consumer's turn cannot end red, and until
// this release a maintainer's could.
//
// They run through the package manager and need node_modules, so unlike the pure-node
// steps above they SKIP LOUDLY when the toolchain is absent rather than blocking a turn on
// a machine that has not installed yet. A skip is never a pass: the skipped names are
// printed, and the `lint` workflow is the fail-closed backstop.
const TOOLCHAIN_STEPS = [
  ['eslint', ['exec', 'eslint', '.', '--max-warnings', '0']],
  ['types', ['exec', 'tsc', '--noEmit']],
  ['dead-code', ['exec', 'knip']],
]

await readHookInput()

const failures = []
const skipped = []
for (const [name, argv] of STEPS) {
  const res = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  if (res.status !== 0) {
    failures.push(`=== ${name}: node ${argv.join(' ')}\n${(res.stdout ?? '') + (res.stderr ?? '')}`)
  }
}
for (const [name, argv] of TOOLCHAIN_STEPS) {
  const res = spawnSync('pnpm', argv, { encoding: 'utf8', shell: process.platform === 'win32' })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  // No node_modules, no pnpm on PATH: the toolchain is absent, not the code broken.
  if (res.error !== undefined || /command not found|Command "[a-z]+" not found|ERR_PNPM_NO_SCRIPT/i.test(out)) {
    skipped.push(`${name} (pnpm ${argv.join(' ')}) — toolchain absent; the \`lint\` workflow is the fail-closed backstop`)
    continue
  }
  if (res.status !== 0) failures.push(`=== ${name}: pnpm ${argv.join(' ')}\n${out}`)
}
if (skipped.length > 0) {
  process.stderr.write(`stop-factory-gate: SKIPPED (did NOT run):\n  ${skipped.join('\n  ')}\n`)
}

if (failures.length > 0) {
  // Every failure at once, not the first: serial one-red-per-turn discovery would burn
  // the block budget, which is the same reason the consumer Stop gate passes
  // --report-all.
  block(
    `Harness factory gate FAILED (${String(failures.length)} of ${String(STEPS.length + TOOLCHAIN_STEPS.length)} step(s)). The machinery that enforces quality for consumers is itself inconsistent — fix these before ending the turn.\n\n${failures.join('\n')}`,
  )
}
pass()
