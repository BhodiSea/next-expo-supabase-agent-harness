// StrykerJS — the behavioural net over the critical surface (auth, the DAL, the error
// envelope, the route wiring, and the mobile client's auth/transport seam). Coverage says
// your tests RAN the code; mutation says they would NOTICE it breaking.
//
// CI-ONLY. Never `pnpm validate`, never the Stop hook: a full run is minutes and the warm
// validate budget is ~6s. Two lanes, both blocking, both ending in the SET-BASED ratchet
// (tools/check-mutation-ratchet.mjs) rather than a score threshold:
//   - per-PR   : diff-scoped — mutates only the CRITICAL files the PR touched
//                (tools/mutation-scope.mjs computes the list for `--mutate`)
//   - nightly  : `pnpm mutation` — the whole critical surface
//
// WHAT IS MUTATED lives in tools/lib/mutation-critical.mjs, shared with the diff-scoper so
// the two can never disagree about what "critical" means. The RUNNER is vitest — the pure
// half of the unit floor; the jest-expo half is a recorded honest loss there.
// SOURCE: docs/harness/gates-catalog.md (mutation-ratchet) [corpus: harness/doctrine]
import { MUTATE_GLOBS } from './tools/lib/mutation-critical.mjs'

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  // pnpm's isolated node_modules defeats Stryker's default '@stryker-mutator/*' plugin GLOB,
  // and the failure is silent-ish: "no TestRunner plugins were loaded". Name the runner.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts' },

  coverageAnalysis: 'perTest',
  mutate: MUTATE_GLOBS,

  // The ratchet is the gate; a score threshold is not. `break: null` keeps Stryker itself
  // from failing the run, so the ratchet always gets to speak (and can distinguish "a NEW
  // survivor appeared" from "the score dipped", which is the only distinction that matters).
  thresholds: { break: null },

  // Determinism: the ratchet compares SETS, so a mutant that flips status between runs would
  // red the lane at random. A timeout is scored as a KILL, so a mutant that merely runs slow
  // under parallel load must not be mistaken for one that hangs — give it real headroom.
  timeoutMS: 15_000,
  timeoutFactor: 3,

  reporters: ['progress', 'clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
}

export default config
