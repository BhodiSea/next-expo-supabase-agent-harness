// Can-fail proofs for the fan-in check an enterprise marks required
// (template/base/tools/ci/summarize-gate.mjs).
//
// This is the check whose FAILURE MODE is the reason it exists. `if: always()` makes a
// skipped need indistinguishable from a passed one in a naive YAML expression, so the
// obvious implementation reproduces the silent-skip problem inside the one status a
// reviewer trusts most. The green case below is therefore the load-bearing one: it must
// exit 0 AND name every lane that did not run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(
  new URL('../../template/base/tools/ci/summarize-gate.mjs', import.meta.url),
)

/** @param {unknown} needs @param {{ raw?: string }} [opts] */
function run(needs, { raw } = {}) {
  const res = spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, NEEDS_JSON: raw ?? JSON.stringify(needs) },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const r = (result) => ({ result, outputs: {} })

test('GREEN: every lane succeeded → exit 0', () => {
  const res = run({ static: r('success'), unit: r('success'), 'web-e2e': r('success') })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /gate-summary: OK/)
  assert.match(res.out, /3 lane\(s\)/)
})

test('GREEN-WITH-SKIPS: exit 0, and EVERY skipped lane is named (a skip is never a pass)', () => {
  const res = run({
    static: r('success'),
    unit: r('success'),
    native: r('skipped'),
    'mobile-e2e': r('skipped'),
    'perf-lane': r('skipped'),
  })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /gate-summary: OK/)
  assert.match(res.out, /SKIPPED \(did NOT run/)
  for (const lane of ['native', 'mobile-e2e', 'perf-lane']) {
    assert.ok(res.out.includes(`- ${lane}`), `skipped lane '${lane}' must be named:\n${res.out}`)
  }
  // …and the passing lanes are not misreported as skipped.
  assert.ok(!res.out.includes('- static'), res.out)
})

test('GREEN-WITH-REUSE (1.1.0, #57): exit 0, and every reused lane is named with the run it relied on', () => {
  // A post-merge push whose lane found its pull request's green result on the identical
  // tree concludes success without re-running its steps. That IS a pass (it cites a pass),
  // but a reader of the one required check must see which lanes it was and where the proof
  // lives, the same way a skip is named.
  const url = 'https://github.com/o/r/actions/runs/101'
  const res = run({
    static: { result: 'success', outputs: { 'reused-from': url } },
    unit: { result: 'success', outputs: { 'reused-from': '' } },
    'integration-lane': { result: 'success', outputs: { 'reused-from': url } },
    native: r('skipped'),
  })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /gate-summary: OK/)
  assert.match(res.out, /REUSED \(passed on this exact tree/)
  for (const lane of ['static', 'integration-lane']) {
    assert.ok(res.out.includes(`- ${lane} <- ${url}`), `reused lane '${lane}' must be named with its run:\n${res.out}`)
  }
  // A lane that ran is not reported as reused, and the skip accounting is untouched.
  assert.ok(!res.out.includes('- unit <-'), res.out)
  assert.ok(res.out.includes('- native'), res.out)
})

test('RED WITH REUSE: a failed lane still exits 1 beside reused ones, and a failure is never listed as reused', () => {
  const url = 'https://github.com/o/r/actions/runs/101'
  const res = run({
    static: { result: 'success', outputs: { 'reused-from': url } },
    unit: { result: 'failure', outputs: { 'reused-from': url } },
  })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /unit: FAILED/)
  assert.ok(!res.out.includes('- unit <-'), `a failed lane must never read as reused:\n${res.out}`)
  assert.ok(res.out.includes(`- static <- ${url}`), res.out)
})

test('RED: a failed lane exits 1 and names it', () => {
  const res = run({ static: r('success'), unit: r('failure'), native: r('skipped') })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /unit: FAILED/)
  // The skip accounting still happens on the red path — a reviewer reading a red summary
  // needs to know what did not run just as much.
  assert.ok(res.out.includes('- native'), res.out)
})

test('RED: a CANCELLED lane exits 1 — a cancelled lane proved nothing', () => {
  const res = run({ static: r('success'), 'db-scale': r('cancelled') })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /db-scale: CANCELLED/)
})

test('RED: an EMPTY needs context exits 1 — a summary over nothing is not a pass', () => {
  const res = run({})
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /EMPTY/)
  assert.match(res.out, /`needs:` list/)
})

test('RED: unreadable or mis-shaped input exits 1 (it can never report success blind)', () => {
  for (const raw of ['', 'not json', 'null', '"success"', '[]']) {
    const res = run(undefined, { raw })
    assert.equal(res.code, 1, `${JSON.stringify(raw)} → ${res.out}`)
  }
})

test('RED: a result string the runner may add later is treated as NOT a pass', () => {
  // Fail-closed on the unknown, the same rule every gate in this repo follows: a new
  // GitHub result value must not silently count as success.
  const res = run({ static: r('success'), unit: r('neutral') })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /unrecognized result/)
  assert.match(res.out, /"neutral"/)
})

// ── 1.1.0 (#56): a deferred device lane is named WITH its reason ──────────────────────
// The `changes` job publishes `mobile-deferred` and `mobile-deferral` (`<until>: <reason>`)
// from tools/ci/surface-deferral.mjs. The summary prints that reason beside the two lanes a
// deferral can skip, and only when `changes` reported BOTH a mobile change and a live
// deferral — any other skip of those lanes is a path-filter skip and must not borrow a
// reason it does not have. The verdict never reads the deferral.
const DEFERRAL = '2999-12-31: the web surface ships first'
const changes = (/** @type {Record<string, string>} */ outputs) => ({ result: 'success', outputs })
const deferredNeeds = (/** @type {Record<string, string>} */ outputs, extra = {}) => ({
  static: r('success'),
  unit: r('success'),
  changes: changes(outputs),
  native: r('skipped'),
  'mobile-e2e': r('skipped'),
  'perf-lane': r('skipped'),
  ...extra,
})
const DEFERRED = { mobile: 'true', 'mobile-deferred': 'true', 'mobile-deferral': DEFERRAL }

test('DEFERRED: the reason prints beside mobile-e2e and perf-lane when changes reported mobile=true AND mobile-deferred=true', () => {
  const res = run(deferredNeeds(DEFERRED))
  assert.equal(res.code, 0, res.out)
  for (const lane of ['mobile-e2e', 'perf-lane']) {
    assert.ok(
      res.out.includes(`- ${lane} — deferred in tools/surfaces.json until ${DEFERRAL}`),
      `${lane} must carry the deferral's reason:\n${res.out}`,
    )
  }
  // native reads no deferral, so it is named as a plain skip.
  assert.match(res.out, /^ {2}- native$/m)
})

test('NOT DEFERRED: no reason prints unless changes reported both mobile=true and mobile-deferred=true', () => {
  for (const outputs of [
    { mobile: 'true', 'mobile-deferred': 'false', 'mobile-deferral': '' },
    // A deferral with no mobile change: the lanes skipped on the path filter, not the row.
    { mobile: 'false', 'mobile-deferred': 'true', 'mobile-deferral': DEFERRAL },
    // Outputs that never arrived (the step failed, or an older workflow) mean nothing.
    { mobile: 'true' },
    {},
  ]) {
    const res = run(deferredNeeds(outputs))
    assert.equal(res.code, 0, res.out)
    assert.doesNotMatch(res.out, /deferred in tools\/surfaces\.json/, JSON.stringify(outputs))
    assert.match(res.out, /^ {2}- mobile-e2e$/m)
    assert.match(res.out, /^ {2}- perf-lane$/m)
  }
  // No changes need at all (a push or schedule run's needs context).
  const res = run({ static: r('success'), 'mobile-e2e': r('skipped') })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /^ {2}- mobile-e2e$/m)
})

test('DEFERRED: a lane that RAN is never annotated, and the exit rules do not change', () => {
  // The deferral is display only: a failed lane still reds the summary with a live row,
  // and a lane that ran and passed is not listed as skipped at all.
  const red = run(deferredNeeds(DEFERRED, { unit: r('failure') }))
  assert.equal(red.code, 1, red.out)
  assert.match(red.out, /unit: FAILED/)
  assert.ok(red.out.includes(`- mobile-e2e — deferred in tools/surfaces.json until ${DEFERRAL}`), red.out)

  const ran = run(deferredNeeds(DEFERRED, { 'mobile-e2e': r('success'), 'perf-lane': r('failure') }))
  assert.equal(ran.code, 1, ran.out)
  assert.match(ran.out, /perf-lane: FAILED/)
  assert.doesNotMatch(ran.out, /deferred in tools\/surfaces\.json/)

  const cancelled = run(deferredNeeds(DEFERRED, { 'mobile-e2e': r('cancelled') }))
  assert.equal(cancelled.code, 1, cancelled.out)

  // A live deferral with no reason line still names the lane, and says the reason is missing.
  const bare = run(deferredNeeds({ mobile: 'true', 'mobile-deferred': 'true' }))
  assert.equal(bare.code, 0, bare.out)
  assert.match(bare.out, /- mobile-e2e — deferred in tools\/surfaces\.json \(no reason reached this job\)/)
})

test('the shipped workflow wires gate-summary over EVERY other job, both ways', async () => {
  const { readFileSync } = await import('node:fs')
  const wf = readFileSync(
    fileURLToPath(new URL('../../template/base/github/workflows/quality-gate.yml', import.meta.url)),
    'utf8',
  )
  const jobsAt = wf.indexOf('\njobs:')
  const jobs = [...wf.slice(jobsAt).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
  assert.ok(jobs.includes('gate-summary'), 'quality-gate.yml must define the fan-in job')

  // The `needs:` block of gate-summary, parsed as the list it is.
  const block = wf.slice(wf.indexOf('\n  gate-summary:'))
  const needsAt = block.indexOf('\n    needs:')
  assert.notEqual(needsAt, -1, 'gate-summary must declare needs:')
  const needs = [...block.slice(needsAt).matchAll(/^ {6}- ([a-z][a-z0-9-]*)$/gm)].map((m) => m[1])
  const others = jobs.filter((j) => j !== 'gate-summary')
  // Both directions: a job added to the workflow and forgotten here is a lane the
  // required check does not cover, which is exactly the stale-list failure this job
  // exists to delete.
  assert.deepEqual(
    [...needs].sort(),
    [...others].sort(),
    'gate-summary#needs must name every other job in quality-gate.yml — a lane missing from it is a lane the required status check does not cover',
  )
  assert.match(block.slice(0, needsAt), /if: always\(\)/)
})
