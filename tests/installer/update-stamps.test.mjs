// 0.9.0 stamp hygiene: `update` must invalidate every content-addressed gate
// stamp (.harness/<gate>.ok) once the new manifest is recorded — before this,
// a gate rewritten by the very update that shipped it could ride the warm stamp
// its previous version recorded, and the first local validate would "pass" the
// old check. Only *.ok files go: manifest.json, pending/ and rollback/ are
// update's own state, not stamps, and must survive the sweep untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { update } from '../../installer/commands/update.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

const SETS = [
  '--set', 'PROJECT_NAME=Stamp Fixture',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-stamps-'))
  const res = spawnSync('node', [CLI, 'init', '--dir', dir, '--yes', ...SETS], { encoding: 'utf8' })
  assert.equal(res.status, 0, `init must succeed: ${res.stdout}${res.stderr}`)
  return dir
}

// stampGate trusts any .harness/<gate>.ok whose digest matches its inputs, so a
// plain file IS the real artifact — no validate run needed to arm the hazard.
function plantStamps(dir) {
  writeFileSync(join(dir, '.harness', 'contracts.ok'), 'deadbeef')
  writeFileSync(join(dir, '.harness', 'version-sync.ok'), 'deadbeef')
}

/** Run the REAL update() capturing its report as JSON. */
async function runUpdate(dir, opts = {}) {
  const out = []
  const origLog = console.log
  console.log = (...args) => out.push(args.join(' '))
  let code
  try {
    code = await update({ dir, dryRun: false, report: 'json', ...opts })
  } finally {
    console.log = origLog
  }
  return { code, report: JSON.parse(out.join('\n')) }
}

test('update deletes every .harness/*.ok stamp and reports the invalidation', async () => {
  const dir = initFixture()
  plantStamps(dir)
  // Neighbors that must survive: a parked pending file and the manifest itself.
  mkdirSync(join(dir, '.harness', 'pending'), { recursive: true })
  writeFileSync(join(dir, '.harness', 'pending', 'parked.ok'), 'not a stamp — pending is off-limits')

  const { code, report } = await runUpdate(dir)
  assert.equal(code, 0, JSON.stringify(report))

  assert.ok(!existsSync(join(dir, '.harness', 'contracts.ok')), 'contracts stamp must be deleted')
  assert.ok(!existsSync(join(dir, '.harness', 'version-sync.ok')), 'version-sync stamp must be deleted')
  assert.ok(
    report.notes.some((n) => n.includes('stamps invalidated')),
    `the report must say why the next validate is cold: ${JSON.stringify(report.notes)}`,
  )

  // Only *.ok FILES directly under .harness/ — never its bookkeeping.
  const manifest = JSON.parse(readFileSync(join(dir, '.harness', 'manifest.json'), 'utf8'))
  assert.ok(manifest.harnessVersion, 'manifest survives and still parses')
  assert.ok(
    existsSync(join(dir, '.harness', 'pending', 'parked.ok')),
    'files under pending/ are not stamps and must survive',
  )
  assert.ok(existsSync(join(dir, '.harness', 'rollback')), 'the rollback snapshot survives')
})

test('dry-run keeps stamps; a stampless update does not claim it invalidated any', async () => {
  const dir = initFixture()
  plantStamps(dir)

  const dry = await runUpdate(dir, { dryRun: true })
  assert.equal(dry.code, 0)
  assert.ok(existsSync(join(dir, '.harness', 'contracts.ok')), 'dry-run must not delete stamps')
  assert.ok(
    !dry.report.notes.some((n) => n.includes('stamps invalidated')),
    'dry-run must not claim an invalidation it did not perform',
  )

  const real = await runUpdate(dir)
  assert.equal(real.code, 0)
  assert.ok(!existsSync(join(dir, '.harness', 'contracts.ok')), 'the real run deletes them')

  // Second sweep: no stamps left, so no vacuous invalidation note.
  const again = await runUpdate(dir)
  assert.ok(
    !again.report.notes.some((n) => n.includes('stamps invalidated')),
    'an update that deleted nothing must not report an invalidation',
  )
})
