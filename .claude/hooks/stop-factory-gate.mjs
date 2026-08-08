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
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { block, pass, readHookInput } from '../../template/base/.claude/hooks/lib/hookio.mjs'
import { recordTurnOutcome } from '../../template/base/.claude/hooks/lib/turn-outcomes.mjs'

// The repository root. The pure-node steps below are spawned with the hook's own cwd (the
// project root, which is where Claude Code runs a hook), but `format` runs from a
// subdirectory and still needs the root's node_modules.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

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
  // THE FOURTH, AND THE LAST ASYMMETRY OF ITS KIND (0.6.0). `format` is step ONE of every
  // consumer's chain and it runs over the files the HARNESS ships — every gate script in
  // template/base/tools, every source file in template/stack. Nothing on this side ever ran
  // it. So a formatting break in a shipped gate script was invisible to a maintainer's turn
  // and red on step one for every consumer who upgraded, which is the exact shape the
  // paragraph above describes for eslint/tsc/knip and the reason those three moved here.
  //
  // The 0.6.0 upgrade lane is what found it: check-auth-posture.mjs shipped one line over
  // the width, `pnpm validate` died at `format` on the upgraded scaffold, and the lane
  // correctly reported it as a REGRESSION rather than an expiry.
  //
  // It runs from template/base so that TREE's biome.jsonc is the root config — the one
  // consumers actually get, never a factory copy that could drift from it — and reaches the
  // sibling trees by path, because a scaffold merges them under that single root. Biome 2.x
  // refuses a nested root config, so pointing at it from here is not an option.
  // `--vcs-enabled=false` because the ignore file it wants is `gitignore` in dotless storage
  // and only exists as `.gitignore` after a render; nothing under template/ is build output.
  //
  // The BINARY, not `pnpm exec`: template/base holds no package.json, so pnpm dies there
  // with ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE before biome ever runs. An absent binary is an
  // ENOENT on spawn, which the skip branch below already reads as a missing toolchain.
  [
    'format',
    ['ci', '--vcs-enabled=false', '.', '../stack', '../modules', '../presets'],
    { cwd: 'template/base', command: join(ROOT, 'node_modules/.bin/biome') },
  ],
]

const input = await readHookInput()

const failures = []
const failedGates = []
const skipped = []
for (const [name, argv] of STEPS) {
  const res = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  if (res.status !== 0) {
    failures.push(`=== ${name}: node ${argv.join(' ')}\n${(res.stdout ?? '') + (res.stderr ?? '')}`)
    failedGates.push(name)
  }
}
// The optional third element overrides how a step is launched: `format` runs a binary
// directly, from template/base, so that tree's biome.jsonc — the one consumers get — is the
// root config. Every other step is `pnpm <argv>` from here.
for (const [name, argv, opts] of TOOLCHAIN_STEPS) {
  const command = opts?.command ?? 'pnpm'
  const res = spawnSync(command, argv, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
  })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  // No node_modules, no pnpm on PATH: the toolchain is absent, not the code broken.
  if (res.error !== undefined || /command not found|Command "[a-z]+" not found|ERR_PNPM_NO_SCRIPT/i.test(out)) {
    skipped.push(`${name} (pnpm ${argv.join(' ')}) — toolchain absent; the \`lint\` workflow is the fail-closed backstop`)
    continue
  }
  if (res.status !== 0) {
    failures.push(`=== ${name}: pnpm ${argv.join(' ')}\n${out}`)
    failedGates.push(name)
  }
}
if (skipped.length > 0) {
  process.stderr.write(`stop-factory-gate: SKIPPED (did NOT run):\n  ${skipped.join('\n  ')}\n`)
}

// ---- THE TURN LEDGER, dogfooded (0.6.0) ---------------------------------------
// 0.6.0 gave consumers a record of the one documented way a turn CAN end red: after
// CLAUDE_CODE_STOP_HOOK_BLOCK_CAP consecutive blocks, Claude Code ends the turn anyway. The
// factory had the identical hole, and this is the machine where it is cheapest to notice — a
// maintainer whose turn ran out of blocks left the machinery inconsistent with no trace, on
// the one machine where a bug in this code can actually be fixed.
//
// The SHIPPED module, never a second copy: two implementations of "how many times have we
// blocked" would drift, and this file's whole purpose is to be a live test of the exact bytes
// consumers get. ROOT-relative rather than cwd-relative because a hook's cwd is the project
// root here and the ledger must land in the repo either way.
const turn = recordTurnOutcome({
  blocked: failures.length > 0,
  gates: failedGates,
  input,
  ledgerPath: join(ROOT, '.harness/turn-outcomes.jsonl'),
})
if (turn.priorCapHit !== null) {
  process.stderr.write(
    `stop-factory-gate: THE PREVIOUS TURN ENDED RED — blocked ${String(turn.priorCapHit.blocks)} time(s) (the cap), with ${turn.priorCapHit.gates?.join(', ') || 'the factory gate'} still failing. Treat those as outstanding, not as history.\n`,
  )
}

if (failures.length > 0) {
  if (turn.capReached) {
    process.stderr.write(
      `stop-factory-gate: LAST CHANCE — this is block ${String(turn.blocks)} of ${String(turn.cap)}. Claude Code will NOT block again: the next time this turn tries to end, it ends with the machinery inconsistent. Fix the failures below, or say plainly which are still red.\n`,
    )
  }
  // Every failure at once, not the first: serial one-red-per-turn discovery would burn
  // the block budget, which is the same reason the consumer Stop gate passes
  // --report-all.
  block(
    `Harness factory gate FAILED (${String(failures.length)} of ${String(STEPS.length + TOOLCHAIN_STEPS.length)} step(s)). The machinery that enforces quality for consumers is itself inconsistent — fix these before ending the turn.\n\n${failures.join('\n')}`,
  )
}
pass()
