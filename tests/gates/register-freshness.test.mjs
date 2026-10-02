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

/**
 * The two shipped review windows, read from the seeds: the earliest and latest
 * `reviewedUntil` across the floor's packages, and the eol register's.
 */
function shippedWindows() {
  const floor = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/framework-floor.json'), 'utf8'))
  const eol = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/eol.json'), 'utf8'))
  const floorUntil = Object.values(floor.packages)
    .map((/** @type {any} */ p) => String(p.reviewedUntil))
    .sort()
  return { floorFirst: floorUntil[0], floorLast: floorUntil[floorUntil.length - 1], eol: String(eol.reviewedUntil), floorUntil }
}

test('each seed reds INDEPENDENTLY — one lapse is not masked by the other', () => {
  // The two windows close on different days (the next test pins that), so the last day of
  // the later one catches exactly the earlier one. A check that only ever reported them
  // together could be reading one register and attributing it to both.
  // DERIVED, not typed (1.0.2): this read `--today=2026-09-10` against the 0.9.9 windows,
  // so every honest re-review moved both dates past it and turned the test red for a
  // reason that had nothing to do with isolation. A review lapses when reviewedUntil is
  // BEFORE today, so on the later register's own last day the earlier one has lapsed and it
  // has not. WHICH REGISTER CLOSES FIRST IS DERIVED TOO (2.0.0): the test used to assume the
  // floor did, so the 2.0.0 floor review, whose window runs past the eol register's, turned
  // it red for the same unrelated reason.
  const w = shippedWindows()
  const floorFirst = w.floorLast < w.eol
  const r = run([`--today=${floorFirst ? w.eol : w.floorFirst}`])
  assert.equal(r.code, 1)
  const [lapsed, live] = floorFirst
    ? [/tools\/framework-floor\.json/, /tools\/eol\.json/]
    : [/tools\/eol\.json/, /tools\/framework-floor\.json/]
  assert.match(r.out, lapsed)
  assert.doesNotMatch(r.out, live)
})

test('the shipped windows really do close on different days, as the test above assumes', () => {
  // Pins what the isolation test straddles. Without this, two windows ending on the same
  // day (or a floor package on each side of the eol register) would silently turn that test
  // into a duplicate of the one above it — still green, still passing, proving half as much.
  const w = shippedWindows()
  assert.ok(
    w.floorLast < w.eol || w.eol < w.floorFirst,
    `every framework-floor window must close on one side of tools/eol.json's for the isolation test to isolate anything; got floor ${w.floorUntil.join(',')} vs eol ${w.eol}`,
  )
})

test('a malformed --today is rejected rather than silently treated as "no lapse"', () => {
  const r = run(['--today=tomorrow'])
  assert.equal(r.code, 2)
  assert.match(r.out, /must be an ISO date/)
})
