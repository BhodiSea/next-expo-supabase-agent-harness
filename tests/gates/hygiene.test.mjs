// THE FACTORY GATE'S OWN TREE (0.6.0).
//
// scripts/hygiene.mjs is a factory-gate step, so it carries no entry in the canary
// registry — that registry closes over the shipped chain and the Stop chain, and this
// script ships to nobody. It had, in consequence, no red-proof at all, and its NUL sweep
// spent the whole release deciding which files to read from a hand-maintained exclude list
// that did not know about `.gitignore`.
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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

/** Plant a fixture, run the sweep, remove the fixture whatever happened. */
function withFixture(rel, run) {
  const abs = join(ROOT, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, WITH_NUL)
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
