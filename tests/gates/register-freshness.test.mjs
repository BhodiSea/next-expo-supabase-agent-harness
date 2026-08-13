// The factory's own clockful freshness job (0.9.9) — the red-proof for
// hygiene.yml#registers-clockful, and for scripts/check-register-freshness.mjs as a
// factory gate.
//
// WHAT IT GUARDS, restated so the tests below read as claims rather than as exercise. The
// shipped registers under template/base/tools/ are SEEDS: every future scaffold is
// rendered from them. The consumer's `floor-review` cron asks whether their copies have
// lapsed, but that job only exists inside an install — so a review that expires in the
// factory is invisible here until somebody scaffolds a project that reds on its first
// weekly cron for research this repository never re-read.
//
// The clock is a `--today=` parameter for the same reason tools/check-framework-floor.mjs
// takes one: a red-proof that has to wait for a calendar is a red-proof nobody runs. The
// green half runs against the SHIPPED seeds with the real date, so the red is the
// backdating and not a broken script.
// SOURCE: scripts/check-register-freshness.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = join(ROOT, 'scripts/check-register-freshness.mjs')

/** @param {string[]} args */
const run = (args = []) => {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('the SHIPPED seeds carry a live review today — the green half', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /REGISTER FRESHNESS: CLEAN/)
  // Anti-vacuity read from the outside: a run that reached no register would also print
  // "CLEAN" if the count were not in the line, which is why it is.
  assert.match(r.out, /2 shipped register\(s\)/)
})

test('a lapsed review reds, and names BOTH registers and the date', () => {
  const r = run(['--today=2099-01-01'])
  assert.equal(r.code, 1)
  assert.match(r.out, /tools\/framework-floor\.json/)
  assert.match(r.out, /tools\/eol\.json/)
  assert.match(r.out, /today is 2099-01-01/)
})

test('each seed reds INDEPENDENTLY — one lapse is not masked by the other', () => {
  // The two windows are 2026-09-06 (floor) and 2026-09-12 (eol), so a date between them
  // catches exactly one. A check that only ever reported them together could be reading
  // one register and attributing it to both.
  const r = run(['--today=2026-09-10'])
  assert.equal(r.code, 1)
  assert.match(r.out, /tools\/framework-floor\.json/)
  assert.doesNotMatch(r.out, /tools\/eol\.json/)
})

test('the shipped windows really are the ones the test above assumes', () => {
  // Pins the two dates the isolation test straddles. Without this, moving a review window
  // in a maintenance commit would silently turn that test into a duplicate of the one
  // above it — still green, still passing, proving half as much.
  const floor = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/framework-floor.json'), 'utf8'))
  const eol = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/eol.json'), 'utf8'))
  const floorUntil = Object.values(floor.packages).map((/** @type {any} */ p) => p.reviewedUntil)
  assert.ok(
    floorUntil.every((/** @type {string} */ u) => u < eol.reviewedUntil),
    `every framework-floor window must close before tools/eol.json's for the isolation test to isolate anything; got floor ${floorUntil.join(',')} vs eol ${eol.reviewedUntil}`,
  )
})

test('a malformed --today is rejected rather than silently treated as "no lapse"', () => {
  const r = run(['--today=tomorrow'])
  assert.equal(r.code, 2)
  assert.match(r.out, /must be an ISO date/)
})
