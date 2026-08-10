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
// scaffold, installing it, running its full gate chain, the live-Supabase canaries — stay in the
// selftest matrix where they belong.
//
// WHAT IS DELIBERATELY ABSENT (0.7.0 — the honest residual, each with its reason):
//   - check-corpus-fidelity: its own header bans agent-time runs — it reaches the
//     network, and network flake must never red a turn. The hygiene.yml nightly is its
//     home.
//   - check-chain-budget: it judges a validate timing log that no factory turn produces —
//     the log exists where the chain runs, so the selftest lane is where it is judged.
//   - tests/installer: the scaffold-lifecycle suite is the slow tail (minutes), and its
//     subject is the installer — a turn that touched installer/ sees the installer-unit
//     lane red within minutes. tests/gates and tests/hooks DO run here (the `tests` step
//     below): they are the enforcement-of-enforcement corpus, the proofs that every gate
//     can actually fail, and "the checks nobody thinks to run" describes them exactly.
//   - spawn-mode canary-coverage: the executing half needs the test runner and long-tail
//     proofs; the --no-spawn closure runs here and CI runs the rest.
// The `lint` and `selftest` workflows are the fail-closed backstop for all four.
// SOURCE: docs/harness/README.md (the factory eats its own dog food)
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { block, pass, readHookInput } from '../../template/base/.claude/hooks/lib/hookio.mjs'
import {
  capHitBlockEligible,
  recordTurnOutcome,
} from '../../template/base/.claude/hooks/lib/turn-outcomes.mjs'

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
  // THE SIX THAT WERE CI-ONLY (0.7.0). Same rule as everything above — pure node, fast,
  // read-only — they were simply never wired here, so a maintainer's turn could end having
  // widened an escape list or skewed the release surface and find out on a PR, after the
  // fact. Measured: all six together add ~0.3s.
  //
  // Every escape hatch (SEEDED ∩ tools/** ∪ ESCAPE_LISTS, plus the write-guard rules) is a
  // registered, reviewed member — a quietly widened list reds the turn, not the fleet.
  ['escape-registry', ['scripts/check-escape-registry.mjs']],
  // A template file added since the previous release that `update` would auto-plant into
  // every existing install must be registered seedOnInitOnly or reviewed as a deliberate
  // plant. Skips loudly when the previous tag is unreachable (shallow clone); red in CI —
  // the script's own posture.
  ['seeded-migrations', ['scripts/check-seeded-migrations.mjs']],
  // A dependency a harness-OWNED config gained needs a channel to EXISTING installs, not
  // only to fresh scaffolds. Safe at any ref since 0.7.0: its baseline comes from
  // highestReleaseBelow(), so at a tag SHA it resolves the true predecessor, never the tag
  // being cut. Same skip-loudly/fail-closed posture on shallow history as the step above.
  ['dependency-channel', ['scripts/check-dependency-channel.mjs']],
  // The offline REUSE mirror: every file covered by an annotation, every referenced
  // license present and allowlisted, README/CITATION/package.json license in agreement.
  ['reuse', ['scripts/check-reuse.mjs']],
  // The plugin manifests are structurally valid — a dangling agents/commands/skills path
  // is dead on install — and the shipped reviewer roster is validated at its source.
  ['plugin-manifest', ['scripts/check-plugin-manifest.mjs']],
  // One version everywhere: package.json == plugin.json == every shipped hook stamp.
  ['release-lockstep', ['scripts/check-release-lockstep.mjs']],
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
  // THE RED-PROOF CORPUS ITSELF (0.7.0), scoped. tests/gates and tests/hooks are the
  // enforcement-of-enforcement suite — the proofs that every gate and hook can actually
  // fail. They ran only in CI: the same asymmetry this block names for eslint/tsc/knip
  // (0.3.0) and format (0.6.0), applied to the one corpus whose whole subject is the
  // machinery above. tests/installer is deliberately NOT here (see the header).
  //
  // CI-shaped via per-step env — the lane-env doctrine: a local run with the workstation's
  // env leaked in checks LESS than CI. GITHUB_BASE_REF=main and CI=true so diff-scoped and
  // CI-strict branches run their CI halves; HARNESS_ALLOW_SELF_EDIT scrubbed (undefined
  // deletes the key at spawn) because guard tests consult it and a maintainer's turn
  // usually carries it — an inherited escape hatch must not weaken the proofs.
  //
  // GLOBS, not directory paths: node --test does not expand a bare directory argument
  // (MODULE_NOT_FOUND, watched red through this very hook) but expands glob patterns
  // itself, no shell involved.
  //
  // MEASURED (2026-08-08, the 16-core reference machine): the hook walled 13.2s before
  // this release; the six 0.7.0 gates add ~0.3s; this step adds ~31s for a ~46s total
  // against the Stop hook's 300s budget in .claude/settings.json. The reviewed fallback —
  // drop to tests/gates only if gates+tests exceeded ~30s — was measured and REJECTED:
  // tests/gates ALONE walls the same ~33s, because it contains the suite's long tail and
  // node --test spreads files across every core, so tests/hooks' ~16s of work rides on
  // otherwise-idle workers. Dropping it would shed 419 proofs and save nothing.
  [
    'tests',
    ['--test', 'tests/gates/*.test.mjs', 'tests/hooks/*.test.mjs'],
    {
      command: process.execPath,
      env: { GITHUB_BASE_REF: 'main', CI: 'true', HARNESS_ALLOW_SELF_EDIT: undefined },
    },
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
// The optional third element overrides how a step is launched: `command` swaps the pnpm
// launcher for a real binary (`format` runs biome from template/base so that tree's
// biome.jsonc — the one consumers get — is the root config; `tests` runs this same node),
// `cwd` moves it, and `env` overlays process.env — an entry whose value is undefined
// DELETES the key (spawn drops undefined-valued entries), which is how `tests` scrubs the
// escape hatch. Every step without a `command` is `pnpm <argv>` from here.
for (const [name, argv, opts] of TOOLCHAIN_STEPS) {
  const command = opts?.command ?? 'pnpm'
  const res = spawnSync(command, argv, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    // A red `tests` run prints every failing assertion's diff; the 1MB default would
    // ENOBUFS, and an ENOBUFS surfaces as res.error — which the absence branch below
    // would misread as a missing toolchain. Roomy enough that it can never trip.
    maxBuffer: 64 * 1024 * 1024,
    ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
  })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  // No node_modules, no pnpm on PATH: the toolchain is absent, not the code broken. The
  // output TEXT sniff applies only to pnpm-launched steps — a step naming its own binary
  // signals absence as a spawn ENOENT (res.error), and its output may LEGITIMATELY contain
  // "command not found" (the `tests` suite exercises toolchain-absent branches and prints
  // their messages), which must never demote a red suite to a loud skip.
  const toolchainAbsent =
    res.error !== undefined ||
    (opts?.command === undefined &&
      /command not found|Command "[a-z]+" not found|ERR_PNPM_NO_SCRIPT/i.test(out))
  if (toolchainAbsent) {
    skipped.push(`${name} (${command} ${argv.join(' ')}) — toolchain absent; the \`lint\` workflow is the fail-closed backstop`)
    continue
  }
  if (res.status !== 0) {
    failures.push(`=== ${name}: ${command} ${argv.join(' ')}\n${out}`)
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
// THE ONE-TIME BLOCK (0.7.0), factory parity: a `v`-stamped mark (written by a 0.7.0+ hook —
// 0.6.0-written state has no `v` and stays a NOTE, so this ships rampless) converts the note
// below into ONE exit 2 when this run is otherwise green: the maintainer must state which
// steps the previous turn abandoned red before this turn may end. Exactly once, by
// construction — this run's own ledger append already moved the tail, so the next Stop
// passes; the append IS the acknowledgment. A red run is unchanged (the reds already block),
// and a ledger that could not be written must not block either: the tail never moved, so the
// block would repeat every Stop, and bookkeeping never decides a turn.
const capBlock =
  failures.length === 0 && turn.error === null && capHitBlockEligible(turn.priorCapHit)
if (turn.priorCapHit !== null && !capBlock) {
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
if (capBlock) {
  const prior = turn.priorCapHit
  const gates = prior.gates?.length > 0 ? prior.gates.join(', ') : 'the factory gate'
  block(
    `stop-factory-gate: THE PREVIOUS TURN ENDED RED — blocked ${String(prior.blocks)} time(s) (the cap), with ${gates} still failing when Claude Code ended it anyway. This run is green NOW, which is exactly when that fact would otherwise vanish. ONE-TIME BLOCK: state plainly in the transcript which steps that turn abandoned red (${gates}) and whether this green run settles them or work is still outstanding, then end the turn again. This run's own ledger append has already moved the mark, so the next Stop passes.`,
  )
}
pass()
