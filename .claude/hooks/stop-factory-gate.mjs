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
// scaffold, installing it, running its 29 gates, the live-Supabase canaries — stay in the
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

export const HARNESS_HOOK_VERSION = '0.2.1'

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
  // The harness holds itself to the cognitive-complexity bar it reds consumers for.
  ['complexity', ['scripts/check-complexity-ratchet.mjs']],
  // Every shipped module parses and every shipped JSON is valid — including .tmpl files,
  // which no other check in this repo ever executes.
  ['syntax', ['scripts/check-syntax.mjs']],
]

await readHookInput()

const failures = []
for (const [name, argv] of STEPS) {
  const res = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  if (res.status !== 0) {
    failures.push(`=== ${name}: node ${argv.join(' ')}\n${(res.stdout ?? '') + (res.stderr ?? '')}`)
  }
}

if (failures.length > 0) {
  // Every failure at once, not the first: serial one-red-per-turn discovery would burn
  // the block budget, which is the same reason the consumer Stop gate passes
  // --report-all.
  block(
    `Harness factory gate FAILED (${String(failures.length)} of ${String(STEPS.length)} step(s)). The machinery that enforces quality for consumers is itself inconsistent — fix these before ending the turn.\n\n${failures.join('\n')}`,
  )
}
pass()
