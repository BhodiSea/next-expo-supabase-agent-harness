// Contract for `graduate` — the cheap, validate-free paths. The full clean-bump
// path (run validate → advance baseVersion when zero ramp NOTEs remain) is exercised
// end-to-end against a real scaffold in the selftest CI matrix; here we lock the guards
// that must hold without spawning a whole gate chain.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { graduate } from '../../installer/commands/graduate.mjs'
import { installerVersion } from '../../installer/lib/manifest.mjs'

function tempDir(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-graduate-'))
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest, null, 2))
  }
  return dir
}

test('graduate: no manifest → exits 1 ("run init first")', async () => {
  const dir = tempDir()
  assert.equal(await graduate({ dir }), 1)
  rmSync(dir, { recursive: true, force: true })
})

test('graduate: already at/above the installed version → no-op exit 0, manifest untouched', async () => {
  const dir = tempDir({ harnessVersion: installerVersion(), baseVersion: installerVersion() })
  const before = readFileSync(join(dir, '.harness/manifest.json'), 'utf8')
  assert.equal(await graduate({ dir }), 0)
  assert.equal(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'), before)
  rmSync(dir, { recursive: true, force: true })
})

test('graduate: a RED validate is refused NAMING the gate, not as one unattributed sentence', async () => {
  // The upgrade lane hit this dead end: graduate refused with "validate is RED" and
  // nothing else, on a red that reproduced only in CI, so the failing gate could not be
  // read off the CI log at all. A refusal that does not say what to fix is a refusal the
  // reader has to reproduce by hand.
  const dir = tempDir({ harnessVersion: installerVersion(), baseVersion: '0.0.1' })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(
    join(dir, 'tools/validate.mjs'),
    ['console.log("format: OK")', 'console.log("migrations: FAIL — append-only check cannot run")', 'console.log("  - supabase/migrations/0001_init.sql was edited")', 'process.exit(1)'].join('\n'),
  )
  const errs = []
  const real = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    assert.equal(await graduate({ dir }), 1)
  } finally {
    console.error = real
  }
  const said = errs.join('\n')
  assert.match(said, /validate is RED/)
  assert.match(said, /migrations: FAIL/)
  assert.match(said, /0001_init\.sql/, 'the failing gate’s detail bullets travel with it')
  assert.ok(!said.includes('format: OK'), 'a passing step is not a finding')
  assert.equal(JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8')).baseVersion, '0.0.1')
  rmSync(dir, { recursive: true, force: true })
})

test('graduate: a STAMPED gate cannot hide a ramp NOTE — the .ok cache is invalidated first', async () => {
  // THE 0.10.0 DEFECT, and the worst shape a graduate bug can take: it advanced baseVersion
  // over findings it had been told to check for, which is the exact act that makes those
  // findings turn-fatal. tools/lib/gate.mjs#stampGate short-circuits a gate to
  // `ok(… inputs unchanged since last green run …)` when its declared inputs are unchanged
  // and we are not in CI — the gate body never runs, so its rampNote never prints, so
  // graduate's "zero ramp NOTEs" test passes over a withheld finding.
  //
  // Upgrade-lane leg A caught it live: graduate advanced 0.9.9 → 0.10.0 with two NOTEs
  // outstanding and the very next validate came back RED on both. The stub below reproduces
  // the short-circuit exactly — NOTE when the stamp is absent, the cached OK line when it is
  // present — so this test FAILS against the pre-fix graduate (it would return 0 and write
  // 0.10.0) and passes only because the stamps are invalidated before validate runs.
  const dir = tempDir({ harnessVersion: installerVersion(), baseVersion: '0.9.9' })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(
    join(dir, 'tools/validate.mjs'),
    [
      'import { existsSync } from "node:fs"',
      'if (existsSync(".harness/version-sync.ok")) {',
      '  console.log("version-sync: OK — inputs unchanged since last green run (.harness/version-sync.ok; CI always re-runs)")',
      '} else {',
      '  console.log("version-sync: NOTE — the arrival of tools/eol.json removalTarget dates (ramp: live from baseVersion 0.10.0; expires in 0.11.0)")',
      '}',
      'process.exit(0)',
    ].join('\n'),
  )
  writeFileSync(join(dir, '.harness/version-sync.ok'), 'a-digest-that-would-match')
  const errs = []
  const real = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    assert.equal(await graduate({ dir }), 1, 'a withheld finding must refuse the graduation')
  } finally {
    console.error = real
  }
  assert.match(errs.join('\n'), /ramped finding\(s\) still outstanding/)
  assert.equal(
    JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8')).baseVersion,
    '0.9.9',
    'baseVersion must NOT advance while a ramp NOTE stands',
  )
  assert.ok(
    !existsSync(join(dir, '.harness/version-sync.ok')),
    'the stamp is invalidated, so the next run re-asks the gate rather than re-reading the cache',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('graduate: a behind manifest but no tools/validate.mjs → exits 1 (not an installed harness)', async () => {
  // baseVersion 0.0.1 is behind any real version, so we reach the validate step — but with
  // no tools/validate.mjs the command refuses rather than spawning nothing and bumping.
  const dir = tempDir({ harnessVersion: installerVersion(), baseVersion: '0.0.1' })
  assert.equal(await graduate({ dir }), 1)
  // baseVersion must NOT have advanced.
  const m = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(m.baseVersion, '0.0.1')
  rmSync(dir, { recursive: true, force: true })
})
