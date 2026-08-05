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
