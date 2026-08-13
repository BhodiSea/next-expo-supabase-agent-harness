// THE FACTORY GATE'S OWN TREE (0.6.0).
//
// scripts/hygiene.mjs is a factory-gate step, and when this file was written the canary
// registry closed over only the shipped chain and the Stop chain — this script ships to
// nobody, so it carried no entry and, in consequence, no red-proof at all; its NUL sweep
// spent the whole release deciding which files to read from a hand-maintained exclude list
// that did not know about `.gitignore`. 0.7.0's #factoryGates closure ended that class:
// every factory gate now needs a registered proof, and hygiene.mjs's entry points at THIS
// file (tests/canary/injections.json#factoryGates).
//
// The failure that produced this file is worth stating exactly, because it is the release's
// own subject turned on the release's own tooling: running the upgrade lane — acceptance
// rung 4, which the release process REQUIRES — plants a git worktree at an OLD release tag
// under `.selftest/`, and the factory gate then reddened on two v0.1.3 files that predate
// the sweep. Nobody can fix a file in history. The maintainer's available moves were
// "delete the lane output" or "stop running the lane".
//
// So the two directions asserted here are not symmetric decoration. One is "the sweep still
// bites"; the other is "the sweep does not bite the proof". Each carries an explicit
// vacuity assertion against `git check-ignore`, because both halves have a silent-green
// failure mode: a fixture git ignores makes the RED test pass for the wrong reason, and a
// fixture git tracks makes the GREEN test pass for the wrong reason.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { maturityClaims } from '../../scripts/lib/maturity-claim.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/hygiene.mjs')

// The byte, built rather than typed: this suite must not become the thing it tests. The
// sweep would catch it — that is exactly how the NUL that fixing this bug introduced was
// found — but a test file that cannot be grepped is a poor way to learn the lesson twice.
const WITH_NUL = Buffer.concat([Buffer.from('a NUL lives here ->'), Buffer.from([0]), Buffer.from('<- and grep goes silent\n')])

/** @returns {{ code: number | null, out: string }} */
function hygiene() {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

/** Whether git's ignore rules cover this path — the vacuity question for both fixtures. */
function ignored(rel) {
  return spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '--', rel], { encoding: 'utf8' }).status === 0
}

/**
 * Plant a fixture, run the sweep, remove the fixture whatever happened.
 * @template T
 * @param {string} rel
 * @param {() => T} run
 * @param {string | Buffer} [content] what to plant — the NUL byte by default, prose for
 *   the maturity-claim cases below.
 * @returns {T}
 */
function withFixture(rel, run, content = WITH_NUL) {
  const abs = join(ROOT, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  try {
    return run()
  } finally {
    rmSync(abs, { force: true })
  }
}

test('GREEN: the repo as it stands, and the sweep read the REPOSITORY', () => {
  const { code, out } = hygiene()
  assert.equal(code, 0, `hygiene is red on the working tree:\n${out}`)
  const scanned = Number(/(\d+) text file\(s\) free of NUL bytes/.exec(out)?.[1] ?? '0')
  // A floor, not a pin. The script already fails at zero; this says the sweep read the
  // repository rather than some corner of it — the shape a scoping change can break
  // without turning anything red.
  assert.ok(scanned > 100, `the NUL sweep scanned only ${String(scanned)} file(s) — that is not this repository:\n${out}`)
})

test('RED: a NUL in an untracked, non-ignored file — the sweep still bites', () => {
  const rel = 'hygiene-nul-fixture.tmp.md'
  withFixture(rel, () => {
    assert.equal(
      ignored(rel),
      false,
      `${rel} is covered by .gitignore, so this test would go green without the sweep ever reading it`,
    )
    const { code, out } = hygiene()
    assert.equal(code, 1, `the sweep passed a file carrying a literal NUL:\n${out}`)
    assert.match(out, /hygiene-nul-fixture\.tmp\.md:1 contains a literal NUL byte/)
  })
})

test('GREEN: the SAME NUL under .selftest/ — running acceptance rung 4 must not red the factory gate', () => {
  const rel = '.selftest/hygiene-nul-fixture/from-an-old-release-tag.md'
  withFixture(rel, () => {
    assert.equal(
      ignored(rel),
      true,
      `${rel} is NOT covered by .gitignore, so this test would go green without proving any scoping`,
    )
    const { code, out } = hygiene()
    assert.equal(
      code,
      0,
      `the factory gate reddened on scratch output from the upgrade lane — a maintainer cannot fix a file in an old release tag, so the only remedies are deleting the lane output or not running the lane:\n${out}`,
    )
  })
})

// ── THE MATURITY-CLAIM SWEEP (0.9.9) ──────────────────────────────────────────────
// The register shipped in 0.9.9 grades all 149 requirements of ASD's Maturity Level
// Three, and the sentence it must never become — "achieves ML3" — is wrong in the
// direction that sells. The whole difficulty of the rule is that the SAME words are
// legitimate on nearly every page of the map's own documentation, which describes the
// model, quotes requirements, and denies the claim in so many words. So both directions
// are asserted: the claim reds, and the denial does not.
//
// This file is one of the two the sweep exempts (scripts/hygiene.mjs's
// CLAIM_SWEEP_EXEMPT), because a red-proof that may not plant the violation cannot prove
// the red — the same carve-out the leak scan makes for gitleaks.toml. The last test here
// holds that exemption to being load-bearing rather than decorative.
const CLAIM_FIXTURE = 'hygiene-maturity-claim-fixture.tmp.md'

test('RED: an affirmative maturity claim reds, naming the file and line', () => {
  withFixture(
    CLAIM_FIXTURE,
    () => {
      assert.equal(
        ignored(CLAIM_FIXTURE),
        false,
        `${CLAIM_FIXTURE} is covered by .gitignore, so this test would go green without the sweep ever reading it`,
      )
      const { code, out } = hygiene()
      assert.equal(code, 1, `the sweep passed a maturity claim:\n${out}`)
      assert.match(out, /hygiene-maturity-claim-fixture\.tmp\.md:3 claims "achieves ML3"/)
      assert.match(out, /maturity attaches to an organisation's SYSTEM/)
    },
    '# Pitch\n\nThis harness achieves ML3 out of the box.\n',
  )
})

test('GREEN: the DENIAL of the same claim is legal — a rule that cannot read its own documentation is not usable', () => {
  withFixture(
    CLAIM_FIXTURE,
    () => {
      const { code, out } = hygiene()
      assert.equal(
        code,
        0,
        `the sweep reddened on prose that DENIES the claim — every page of docs/compliance/essential-eight.md reads like this, so a rule that bites here forces the material explaining the rule to be deleted or exempted:\n${out}`,
      )
    },
    [
      '# Scope',
      '',
      'This application is not "Essential Eight Maturity Level Three", and no application',
      'can be. Nothing here achieves ML3; the gate cannot tell you the application IS',
      'Maturity Level Three, and it never claims the application IS ML3.',
      '',
      'The map carries all 149 cumulative requirements of ASD’s Maturity Level Three,',
      'and risk-accepting a whole strategy forces Maturity Level Zero overall.',
      '',
      "INDEFENSIBLE CLAIM: 'achieves ML3'.",
      '',
    ].join('\n'),
  )
})

test("the rule module's exemption is load-bearing, not decorative — it really does trip its own rule", () => {
  // Written as an assertion because the alternative is a comment nobody re-checks. If
  // scripts/lib/maturity-claim.mjs stopped carrying a claim shape, its exemption would be
  // a path the sweep skips for a reason no longer visible in the file — a silent widening.
  //
  // The OTHER exemption, this file, is deliberately defensive rather than load-bearing:
  // the claim string the RED test plants lives here, and whether the file as a whole reads
  // as an assertion depends on how the surrounding prose happens to be worded within the
  // rule's negation window. Exempting it keeps the red-proof stable instead of making it
  // hostage to comment edits. (This test was written asserting BOTH files trip, and the
  // test-file half failed on its first run — which is how the distinction was found rather
  // than assumed.)
  const rel = 'scripts/lib/maturity-claim.mjs'
  assert.ok(
    maturityClaims(readFileSync(join(ROOT, rel), 'utf8')).length > 0,
    `${rel} is exempt from the maturity-claim sweep but no longer contains a claim shape — the exemption now hides nothing, so it should be removed rather than left standing`,
  )
})
