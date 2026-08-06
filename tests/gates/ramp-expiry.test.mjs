// The ramp CLOCK (0.3.0). Before this release `rampNote()` had no deadline, so
// "shipped ramped" meant "shipped disabled, indefinitely": the check printed an
// advisory NOTE — in CI too — and the only thing that ever re-armed it was a human
// running `graduate`, which nothing nagged.
//
// Three properties, and the first one is the load-bearing one: a runtime throw only
// fires on the code path that reaches the ramp, so on its own it would discover a
// deadline-less ramp the day a consumer hit it. The STATIC closure over every shipped
// call site is what makes the mandate real at authoring time.
// SOURCE: docs/runbooks/harness-upgrade.md (ramps expire)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
// The scanner moved to scripts/lib/ramp-sites.mjs in 0.4.0 so three consumers share ONE
// implementation: this suite, scripts/check-ramp-ledger.mjs (the factory closure) and the
// upgrade lane, which derives the NOTEs a given baseline should produce. A second copy here
// would be a clone of the thing that computes the release's headline number.
import { shippedRampSites, TOOLS_DIR } from '../../scripts/lib/ramp-sites.mjs'

const GATE_LIB = pathToFileURL(join(TOOLS_DIR, 'lib/gate.mjs')).href

/** @returns {Array<[string, string]>} [file, argText] for every shipped call site */
function shippedCallSites() {
  return shippedRampSites().map((s) => [s.file, s.args])
}

test('every shipped rampNote() call site carries an `until` deadline', () => {
  const sites = shippedCallSites()
  // A count floor: if a refactor made this scan find nothing, the closure would pass
  // vacuously — which is the exact failure shape this whole release is about.
  assert.ok(
    sites.length >= 15,
    `expected the ramp fleet (>=15 call sites), found ${String(sites.length)} — the scan is not seeing the calls`,
  )
  const missing = sites.filter(([, args]) => !/\buntil\s*:/.test(args))
  assert.deepEqual(
    missing.map(([f]) => f),
    [],
    'a rampNote() without { until } is a check shipped disabled indefinitely',
  )
})

test('every shipped `until` is a plain x.y.z AFTER the ramp version it opens', () => {
  for (const [file, args] of shippedCallSites()) {
    const until = /\buntil\s*:\s*'([^']+)'/.exec(args)?.[1]
    assert.ok(until, `${file}: until must be a literal string, not an expression`)
    assert.match(until, /^\d+\.\d+\.\d+$/, `${file}: until must be a plain x.y.z`)
  }
})

// ── behaviour ────────────────────────────────────────────────────────────────
// A fixture gate that has one finding and asks the ramp whether to withhold it —
// the shape of every real call site.
const FIXTURE = `
import { failures, ok, rampNote } from '${GATE_LIB}'
const errs = ['one finding']
if (rampNote('fake', '0.2.0', 'the ramped check', UNTIL)) ok('fake', 'held as a NOTE')
failures('fake', errs)
ok('fake', 'clean')
`

/**
 * @param {string} untilArg literal source for rampNote's 4th argument
 * @param {{ harnessVersion?: string, baseVersion?: string } | null} manifest
 */
function runFixture(untilArg, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-rampclock-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (manifest !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'manifest.json'), JSON.stringify(manifest))
  }
  const file = join(dir, 'tools', 'check-fake.mjs')
  writeFileSync(file, FIXTURE.replace('UNTIL', untilArg))
  const res = spawnSync('node', [file], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('rampNote without `until` throws — and names the call site, not the consumer', () => {
  const r = runFixture('undefined', { harnessVersion: '0.3.0', baseVersion: '0.1.0' })
  assert.notEqual(r.code, 0, r.out)
  assert.ok(r.out.includes('without a valid `until` deadline'), r.out)
  // A consumer-facing FIX line would send the wrong person to the wrong place.
  assert.ok(!r.out.includes('FIX[fake]:'), `a harness authoring bug must not print a FIX line:\n${r.out}`)
})

test('rampNote with `until` <= the ramp version throws (it would expire as it opens)', () => {
  const r = runFixture("{ until: '0.2.0' }", { harnessVersion: '0.3.0', baseVersion: '0.1.0' })
  assert.notEqual(r.code, 0, r.out)
  assert.ok(r.out.includes('not AFTER the ramp version'), r.out)
})

test('one version below the deadline: still a NOTE, and the NOTE names the deadline', () => {
  const r = runFixture("{ until: '0.4.0' }", { harnessVersion: '0.3.0', baseVersion: '0.1.0' })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('fake: NOTE — the ramped check'), r.out)
  assert.ok(r.out.includes('expires in 0.4.0'), `the NOTE must carry its deadline:\n${r.out}`)
  assert.ok(!r.out.includes('one finding'), `the finding is still withheld:\n${r.out}`)
})

test('at the deadline: the NOTE becomes a FAIL that names the deadline', () => {
  const r = runFixture("{ until: '0.4.0' }", { harnessVersion: '0.4.0', baseVersion: '0.1.0' })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RAMP EXPIRED'), r.out)
  assert.ok(r.out.includes('deadline of 0.4.0'), r.out)
  assert.ok(r.out.includes('this install runs harness 0.4.0'), r.out)
  assert.ok(r.out.includes('one finding'), `the withheld finding must surface:\n${r.out}`)
})

test('past the deadline: expired, and expiry is measured against harnessVersion not baseVersion', () => {
  const r = runFixture("{ until: '0.4.0' }", { harnessVersion: '0.5.0', baseVersion: '0.1.0' })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RAMP EXPIRED'), r.out)
  // baseVersion is still 0.1.0 — far below the ramp. If the deadline were measured
  // against it, this install would hold its escape open forever by simply never
  // graduating, which is the deadline its own beneficiary controls.
  assert.ok(r.out.includes('this install runs harness 0.5.0'), r.out)
})

test('no manifest (template tree / gate fixtures) stays live, deadline or not', () => {
  const r = runFixture("{ until: '0.4.0' }", null)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('one finding'), r.out)
  assert.ok(!r.out.includes('RAMP EXPIRED'), `there is no install to expire:\n${r.out}`)
})

test('a graduated install is live without ever printing an expiry line', () => {
  const r = runFixture("{ until: '0.4.0' }", { harnessVersion: '0.5.0', baseVersion: '0.2.0' })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('one finding'), r.out)
  assert.ok(!r.out.includes('RAMP EXPIRED'), `graduation is not expiry:\n${r.out}`)
  assert.ok(!r.out.includes('NOTE'), r.out)
})
