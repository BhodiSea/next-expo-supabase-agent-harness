// Contract tests for template/base/tools/lib/gate.mjs: the FIX[gate] feedback
// line on every failure path (an agent reading a red Stop block gets the exact
// reproduce command), and the content-addressed stamp machinery (stale-pass
// prevention is the whole risk of stamping, so invalidation is asserted per
// declared input class in tools/lib/stamp-inputs.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Static for the in-process uses (0.8.0 — knip opacity + the Windows workaround,
// check-query-shapes precedent). GATE_LIB stays: it is interpolated into a GENERATED
// fixture script below, where a static specifier is impossible and the file:// href is
// the correct cross-platform form (the ramp-expiry.test.mjs pattern).
import { hashInputs, rampNote } from '../../template/base/tools/lib/gate.mjs'
import { STAMP_INPUTS } from '../../template/base/tools/lib/stamp-inputs.mjs'

const GATE_LIB = pathToFileURL(
  fileURLToPath(new URL('../../template/base/tools/lib/gate.mjs', import.meta.url)),
).href

/** @param {string} script @param {{ env?: Record<string, string>, cwd?: string }} [opts] */
function runInFixture(script, { env = {}, cwd } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'epah-gatelib-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  const file = join(dir, 'tools', 'check-fake.mjs')
  writeFileSync(file, `import { fail, failures, ok, rampNote, skipOrFail, stampGate } from '${GATE_LIB}'\n${script}`)
  const res = spawnSync('node', [file], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '', GITHUB_BASE_REF: '', ...env },
  })
  return { dir, code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('fail() emits the FIX[gate] line with the exact reproduce command', () => {
  const r = runInFixture(`fail('fake', 'boom')`)
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('fake: FAIL — boom'), r.out)
  assert.ok(r.out.includes('FIX[fake]: reproduce with `node tools/check-fake.mjs`'), r.out)
  assert.ok(r.out.includes('docs/harness/gates-catalog.md ("fake")'), r.out)
})

test('failures() and CI-mode skipOrFail() emit the FIX line; local skip does not', () => {
  const lists = runInFixture(`failures('fake', ['a', 'b'], 'hint line')`)
  assert.equal(lists.code, 1)
  assert.ok(lists.out.includes('hint line'), lists.out)
  assert.ok(lists.out.includes('FIX[fake]:'), lists.out)

  const ciSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`, { env: { CI: 'true' } })
  assert.equal(ciSkip.code, 1)
  assert.ok(ciSkip.out.includes('FIX[fake]:'), ciSkip.out)

  const localSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`)
  assert.equal(localSkip.code, 0)
  assert.ok(localSkip.out.includes('SKIPPED'), localSkip.out)
  assert.ok(!localSkip.out.includes('FIX['), localSkip.out)
})

test('every shipped gate script routes failures through lib/gate.mjs (the FIX contract)', async () => {
  const toolsDir = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
  // build-check.mjs is the one gate whose name does not start with check- here.
  const gateScripts = readdirSync(toolsDir).filter((f) => /^(check-.*|build-check)\.mjs$/.test(f))
  assert.ok(gateScripts.length >= 12, `expected the gate fleet, got ${gateScripts.length}`)
  for (const f of gateScripts) {
    const src = readFileSync(join(toolsDir, f), 'utf8')
    assert.match(src, /from '\.\/lib\/gate\.mjs'/, `${f} must use lib/gate.mjs so every failure carries the FIX[gate] line`)
    assert.ok(!/process\.exit\(1\)/.test(src), `${f} must not exit(1) directly — use fail()/failures()/skipOrFail()`)
  }
})

const STAMP_SCRIPT = `
const recordGreen = stampGate('fake', ['input.txt'])
recordGreen()
ok('fake', 'ran the real check')
`

test('stampGate: green run stamps; unchanged inputs skip; mutation re-runs; CI ignores stamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-stamp-'))
  writeFileSync(join(dir, 'input.txt'), 'v1\n')

  const first = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.equal(first.code, 0)
  assert.ok(first.out.includes('ran the real check'), first.out)

  const second = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.equal(second.code, 0)
  assert.ok(second.out.includes('inputs unchanged since last green run'), second.out)

  writeFileSync(join(dir, 'input.txt'), 'v2\n')
  const third = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.ok(third.out.includes('ran the real check'), third.out)

  const inCi = runInFixture(STAMP_SCRIPT, { cwd: dir, env: { CI: 'true' } })
  assert.ok(inCi.out.includes('ran the real check'), `CI must never trust a stamp: ${inCi.out}`)
})

// ── rampNote: the shared version ramp — NOTE-only on installs whose baseVersion
// predates a check, live everywhere else, fail-closed on tampering. ──────────

// In-process: rampNote reads .harness/manifest.json from process.cwd() and
// RETURNS (no exit) on every non-tampered path, so the live/ramped matrix is
// directly assertable.
// `until` defaults far enough out that these cases exercise the ramp, never the
// clock — expiry has its own suite (tests/gates/ramp-expiry.test.mjs).
async function rampInDir(manifest, { min = '0.1.5', until = '0.4.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-ramp-'))
  if (manifest !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'manifest.json'), manifest)
  }
  const prev = process.cwd()
  const logged = []
  const origLog = console.log
  process.chdir(dir)
  console.log = (...a) => logged.push(a.map(String).join(' '))
  try {
    return { ramped: rampNote('fake', min, 'new-check details', { until }), out: logged.join('\n') }
  } finally {
    console.log = origLog
    process.chdir(prev)
  }
}

test('rampNote: no manifest (template dev tree / gate fixtures) → live, no NOTE', async () => {
  const r = await rampInDir(null)
  assert.equal(r.ramped, false)
  assert.equal(r.out, '')
})

test('rampNote: baseVersion below the ramp → NOTE naming check, ramp, and runbook; returns true', async () => {
  const r = await rampInDir(JSON.stringify({ harnessVersion: '0.1.5', baseVersion: '0.1.4' }))
  assert.equal(r.ramped, true)
  assert.ok(r.out.includes('fake: NOTE — new-check details'), r.out)
  assert.ok(r.out.includes('live from baseVersion 0.1.5'), r.out)
  assert.ok(r.out.includes("this install's baseVersion is 0.1.4"), r.out)
  assert.ok(r.out.includes('docs/runbooks/harness-upgrade.md'), r.out)
})

test('rampNote: baseVersion at/above the ramp → live; compare is numeric, not lexical', async () => {
  const atMin = await rampInDir(JSON.stringify({ harnessVersion: '0.1.5', baseVersion: '0.1.5' }))
  assert.equal(atMin.ramped, false)
  assert.equal(atMin.out, '')
  const above = await rampInDir(JSON.stringify({ harnessVersion: '0.2.0', baseVersion: '0.2.0' }))
  assert.equal(above.ramped, false)
  // 0.1.10 > 0.1.5 numerically (a lexical compare would call it ramped)
  const tenth = await rampInDir(JSON.stringify({ baseVersion: '0.1.10', harnessVersion: '0.1.10' }))
  assert.equal(tenth.ramped, false)
})

test('rampNote: a manifest without baseVersion falls back to harnessVersion', async () => {
  const old = await rampInDir(JSON.stringify({ harnessVersion: '0.1.4', files: {} }))
  assert.equal(old.ramped, true)
  assert.ok(old.out.includes("baseVersion is 0.1.4"), old.out)
  const current = await rampInDir(JSON.stringify({ harnessVersion: '0.1.5', files: {} }))
  assert.equal(current.ramped, false)
})

test('rampNote: corrupt or version-less manifest FAILS CLOSED with the FIX line (tampering, not a ramp)', () => {
  const script = `if (!rampNote('fake', '0.1.5', 'x', { until: '0.4.0' })) ok('fake', 'live')`

  const corrupt = mkdtempSync(join(tmpdir(), 'epah-rampbad-'))
  mkdirSync(join(corrupt, '.harness'), { recursive: true })
  writeFileSync(join(corrupt, '.harness', 'manifest.json'), '{ not json')
  const r1 = runInFixture(script, { cwd: corrupt })
  assert.equal(r1.code, 1, r1.out)
  assert.ok(r1.out.includes('not valid JSON'), r1.out)
  assert.ok(r1.out.includes('FIX[fake]:'), r1.out)

  const versionless = mkdtempSync(join(tmpdir(), 'epah-rampbad-'))
  mkdirSync(join(versionless, '.harness'), { recursive: true })
  writeFileSync(join(versionless, '.harness', 'manifest.json'), '{"files":{}}')
  const r2 = runInFixture(script, { cwd: versionless })
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes('no usable baseVersion'), r2.out)
})

// ── the stamp register: MEMBERSHIP proofs, not a re-proof of hashInputs ─────────
// The predecessor of these tests materialized every declared input and mutated each
// in turn — which only re-proved that hashInputs hashes what it is given (any listed
// file invalidates when edited, tautologically) and could never fail on an input
// class MISSING from a list. Stale-pass prevention lives in membership: the paths
// whose edits must re-arm a stamp are IN the register, and the churn the Stop chain
// itself writes (coverage maps, build output) is NOT hashed.

const STAMP_MACHINERY = ['.harness/manifest.json', 'tools/lib/gate.mjs', 'tools/lib/stamp-inputs.mjs']

test('every stamped gate declares the manifest, its own script, and the stamp machinery', () => {
  for (const [gate, inputs] of Object.entries(STAMP_INPUTS)) {
    for (const p of STAMP_MACHINERY) {
      assert.ok(inputs.includes(p), `${gate}: ${p} must be a declared input — an update or graduation (manifest), or a rewritten check (script/machinery), must re-arm the stamp`)
    }
    assert.ok(
      inputs.some((p) => /^tools\/(check-[\w-]+|build-check)\.mjs$/.test(p)),
      `${gate}: the gate's own script must be a declared input`,
    )
  }
})

test('contracts stamp: declared inputs and the manifest invalidate; excluded churn dirs do not', () => {
  const inputs = STAMP_INPUTS.contracts
  const dir = mkdtempSync(join(tmpdir(), 'epah-stampreg-'))
  const prev = process.cwd()
  process.chdir(dir)
  try {
    // materialize a representative file for each declared input path
    for (const p of inputs) {
      if (/\.[a-z0-9]+$/i.test(p)) {
        mkdirSync(join(dir, p, '..'), { recursive: true })
        writeFileSync(join(dir, p), 'seed\n')
      } else {
        mkdirSync(join(dir, p), { recursive: true })
        writeFileSync(join(dir, p, 'file.txt'), 'seed\n')
      }
    }
    const base = hashInputs(inputs)

    // (i) a declared input file: mutation invalidates, restoration restores.
    writeFileSync(join(dir, 'tsconfig.json'), 'mutated\n')
    assert.notEqual(hashInputs(inputs), base, 'editing a declared input must flip the digest')
    writeFileSync(join(dir, 'tsconfig.json'), 'seed\n')
    assert.equal(hashInputs(inputs), base, 'restoring it must restore the digest')

    // (ii) the manifest IS a member, so an `update` or a graduation — which changes
    // rampNote verdicts over unchanged sources — re-arms the stamp.
    writeFileSync(join(dir, '.harness', 'manifest.json'), '{"baseVersion":"9.9.9"}\n')
    assert.notEqual(hashInputs(inputs), base, 'a manifest edit must flip the digest')
    writeFileSync(join(dir, '.harness', 'manifest.json'), 'seed\n')
    assert.equal(hashInputs(inputs), base)

    // (iii) churn under STAMP_EXCLUDES dirs — the Stop chain's own coverage output,
    // a web/mobile build — must NOT self-invalidate the bare apps/packages roots.
    for (const excluded of ['coverage', '.next', '.expo', '.turbo']) {
      mkdirSync(join(dir, 'apps', 'web', excluded, 'deep'), { recursive: true })
      writeFileSync(join(dir, 'apps', 'web', excluded, 'deep', 'churn.txt'), 'churn\n')
    }
    assert.equal(hashInputs(inputs), base, 'excluded churn dirs must never flip the digest')

    // control: real source churn under the same root still invalidates.
    writeFileSync(join(dir, 'apps', 'web', 'new-file.ts'), 'export {}\n')
    assert.notEqual(hashInputs(inputs), base, 'non-excluded churn under apps/ must still invalidate')
  } finally {
    process.chdir(prev)
  }
})
