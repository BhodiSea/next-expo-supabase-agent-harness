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

/** A pattern that matches `path` literally. @param {string} path */
const pathRe = (path) => new RegExp(path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))

/** @param {string} day @param {number} n */
const plusDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/**
 * Each seed's last day under review, read from the seeds: the earliest `reviewedUntil`
 * across the floor's packages and across the support register's rows, the eol register's
 * `reviewedUntil`, and cc-floor.json's `checkedOn` plus the gate's fixed 45 days (2.0.8).
 * @returns {Record<string, string>}
 */
function lastDays() {
  /** @param {string} name */
  const seed = (name) => JSON.parse(readFileSync(join(ROOT, 'template/base/tools', name), 'utf8'))
  /** @param {any[]} rows */
  const earliest = (rows) => rows.map((r) => String(r.reviewedUntil)).sort()[0]
  const support = seed('support-register.json')
  return {
    'tools/framework-floor.json': earliest(Object.values(seed('framework-floor.json').packages)),
    'tools/cc-floor.json': plusDays(String(seed('cc-floor.json').checkedOn), 45),
    'tools/eol.json': String(seed('eol.json').reviewedUntil),
    'tools/support-register.json': earliest([...support.services, ...support.platforms]),
  }
}

test('the SHIPPED seeds carry a live review today — the green half', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /REGISTER FRESHNESS: CLEAN/)
  // Anti-vacuity read from the outside: a run that reached no register would also print
  // "CLEAN" if the count were not in the line, which is why it is.
  assert.match(r.out, /4 shipped register\(s\)/)
})

test('a lapsed review reds, and names EVERY register and the date', () => {
  const r = run(['--today=2099-01-01'])
  assert.equal(r.code, 1)
  for (const path of Object.keys(lastDays())) assert.match(r.out, pathRe(path))
  assert.match(r.out, /today is 2099-01-01/)
})

test('each seed reds on the day after its own last day, and not before', () => {
  // A check that only ever reported the registers together could be reading one and
  // attributing it to all. On a seed's own last day every seed whose window closed earlier
  // has lapsed and reds, and this one must not; the next day it must.
  // DERIVED, not typed (1.0.2): a typed date turned red on every honest re-review that
  // moved a window past it, for a reason that had nothing to do with isolation. The days
  // and their order are read from the seeds (2.0.0), and since 2.0.8 there are four.
  for (const [path, last] of Object.entries(lastDays())) {
    const re = pathRe(path)
    assert.doesNotMatch(run([`--today=${last}`]).out, re, `${path} reds on its last day, ${last}`)
    const after = run([`--today=${plusDays(last, 1)}`])
    assert.equal(after.code, 1, after.out)
    assert.match(after.out, re, `${path} does not red the day after ${last}`)
  }
})

test('the shipped windows do not all close on one day, as the test above assumes', () => {
  // Pins what the isolation test straddles. Were every window to close on the same day, no
  // seed would be read while another had lapsed, and that test would prove only that each
  // register reds at all.
  const days = lastDays()
  assert.ok(
    new Set(Object.values(days)).size > 1,
    `the four review windows close on one day: ${JSON.stringify(days)}`,
  )
})

test('a malformed --today is rejected rather than silently treated as "no lapse"', () => {
  const r = run(['--today=tomorrow'])
  assert.equal(r.code, 2)
  assert.match(r.out, /must be an ISO date/)
})
