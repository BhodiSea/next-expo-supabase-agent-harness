// Contract for `graduate` — the cheap, validate-free paths. The full clean-bump
// path (run validate → advance baseVersion when zero ramp NOTEs remain) is exercised
// end-to-end against a real scaffold in the selftest CI matrix; here we lock the guards
// that must hold without spawning a whole gate chain.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
