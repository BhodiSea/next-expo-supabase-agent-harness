// Byte-identical on two machines (2.1.0, #188; SINGLE-HOME §12 row 4): the sha256 of #186's
// `--sweep --json` over eval B's frozen fixture, and of eval A's development record without
// its date, match the committed digests. lint.yml runs this file twice, on ubuntu
// (machinery-lint's machinery-evals step) and on Windows (the eval-digest-windows job), so a
// path separator, a line ending or a locale-dependent sort that reaches either output reds
// one leg and not the other.
//
// Each digest file is `<sha256> x=<extractor digest>`. A change to the extractor's modules
// or to the `typescript` version moves `x`, and with it the output: regenerate with
// `node scripts/eval-b.mjs --write-digest` and `node scripts/eval-a.mjs --write-digest`,
// and say why in the PR.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { A_DIR, devDigestLine, recordOf, runA } from '../../scripts/eval-a.mjs'
import { B_DIR, digestLine, sweepFixture } from '../../scripts/eval-b.mjs'
import { treeTest, ts } from '../gates/helpers/single-home.mjs'

const committed = (file) => readFileSync(file, 'utf8')

/** The two lines' `x` first, so a moved extractor says so before the bytes do. */
function assertDigest(actual, file, regen) {
  const want = committed(file)
  const x = (line) => / x=(\S+)/.exec(line)?.[1]
  assert.equal(x(actual), x(want), `the extractor digest moved (a tools/lib edit or a typescript bump): run \`${regen}\``)
  assert.equal(actual, want, `the output differs on this machine with the same extractor: a determinism bug, not a stale digest (${file})`)
}

treeTest("tests/evals/b/sweep.sha256: the sweep's bytes over the frozen fixture", () => {
  assertDigest(digestLine(sweepFixture(B_DIR, ts)), join(B_DIR, 'sweep.sha256'), 'node scripts/eval-b.mjs --write-digest')
})

treeTest("tests/evals/a/dev.sha256: eval A's development record, its date left out", () => {
  const record = recordOf(A_DIR, runA(ts, A_DIR, 'dev'))
  assertDigest(devDigestLine(record), join(A_DIR, 'dev.sha256'), 'node scripts/eval-a.mjs --write-digest')
})
