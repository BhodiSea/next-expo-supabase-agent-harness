#!/usr/bin/env node
// check-ci-preconditions — the shipped consumer CI's entry path stays satisfiable, statically.
//
// The consumer-CI execution lane (scripts/ci/consumer-ci-static.sh, 0.9.0) EXECUTED the
// shipped quality-gate static job for the first time and proved both directions of its
// entry path: a scaffold whose first commit includes pnpm-lock.yaml completes it, and one
// that committed before installing dies at `pnpm install --frozen-lockfile` — exactly as
// the 0.9.0 init guidance predicts. That lane runs on a schedule; this gate is the
// per-commit static closure over the same claims, so the three parties that make the
// entry path work can never silently diverge:
//   1. every `pnpm install` in a shipped workflow spells its lockfile posture explicitly
//      (--frozen-lockfile, or a declared --no-frozen-lockfile — never the CI-env default);
//   2. any job leaning on setup-node's `cache: pnpm` (or a frozen install) is backed by
//      init's next-steps note naming pnpm-lock.yaml — the cross-file half, because the
//      guidance is prose and prose regresses silently;
//   3. every `uses:` reference is SHA-pinned (40-hex) with a version comment.
// The judgement lives in scripts/lib/ci-preconditions.mjs so it can be proven red as a
// pure function (tests/gates/ci-preconditions.test.mjs).
//
//   node scripts/check-ci-preconditions.mjs    # the gate (machinery-lint, blocking)
// SOURCE: scripts/ci/consumer-ci-static.sh (the executed proof this closes over)
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ciPreconditionProblems } from './lib/ci-preconditions.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// The template stores workflows dotless (template/base/github/, never .github/) so they
// can never execute in THIS repo — the same fact lint.yml's fixture-staging step records.
const WORKFLOW_DIR = join(ROOT, 'template/base/github/workflows')
const INIT = join(ROOT, 'installer/commands/init.mjs')

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((f) => ({ file: f, text: readFileSync(join(WORKFLOW_DIR, f), 'utf8') }))

const problems = ciPreconditionProblems({
  workflows,
  initSource: readFileSync(INIT, 'utf8'),
})

if (problems.length > 0) {
  console.error(`CI PRECONDITIONS: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThese are the preconditions of the shipped CI\'s entry path — the first thing a ' +
      'consumer\'s very first push executes. scripts/ci/consumer-ci-static.sh is the lane ' +
      'that proved them by running them; this gate keeps them true between runs.',
  )
  process.exit(1)
}

console.log(
  `CI PRECONDITIONS: CLEAN (${String(workflows.length)} shipped workflow(s): every pnpm install ` +
    'spells its lockfile posture, the cache: pnpm demand is backed by init\'s committed-lockfile ' +
    'guidance, every action reference SHA-pinned with a version comment)',
)
