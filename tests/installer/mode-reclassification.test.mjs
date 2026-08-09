// Ownership may only move TOWARD the consumer without a record.
//
// `update` trusts the install's manifest-recorded mode — an install's ownership
// state is its own — with one directional exception this file pins: when a
// release reclassifies a path the install recorded as `owned` into seeded or
// config territory, the new classification applies immediately, because that
// direction only ever STOPS update from writing a file the consumer is now
// understood to own. Leg E found the defect this closes at 0.7.0:
// tools/generated/action-inventory.json is generated from the CONSUMER's tRPC
// router, and while it was `owned` every upgraded install had the template's
// router description planted over its own — `contracts` redded on trees nobody
// had touched, whichever legitimate move the consumer intended.
//
// The reverse direction — a recorded seeded file whose HEAD classification says
// owned — must NEVER start clobbering from classification alone; it would need
// a reviewed migration channel, and none exists on purpose.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const INVENTORY = 'tools/generated/action-inventory.json'
const OWNED_GATE = 'tools/check-data-flow.mjs'

/** @param {string[]} args */
function run(args) {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function scaffold() {
  const dir = join(mkdtempSync(join(tmpdir(), 'remode-')), 'app')
  mkdirSync(dir, { recursive: true })
  const init = run(['init', '--dir', dir, '--yes',
    '--set', 'PROJECT_NAME=Fixture App',
    '--set', 'GITHUB_OWNER=fixture-owner',
    '--set', 'SECURITY_OWNERS=@fixture-owner/security'])
  assert.equal(init.code, 0, init.out)
  return dir
}

test('owned → seeded reclassification: update stops writing and re-records the mode', () => {
  const dir = scaffold()
  const manifestPath = join(dir, '.harness', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.files[INVENTORY].mode, 'seeded', 'the 0.7.0 template records the inventory seeded at init')

  // Simulate a pre-0.7.0 vintage: the install recorded the inventory `owned`,
  // and its bytes are the CONSUMER's (their router differs from the template's).
  manifest.files[INVENTORY].mode = 'owned'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const theirs = '[{"action":"their.procedure","type":"query"}]\n'
  writeFileSync(join(dir, INVENTORY), theirs)

  const updated = run(['update', '--dir', dir])
  assert.equal(updated.code, 0, updated.out)

  assert.equal(readFileSync(join(dir, INVENTORY), 'utf8'), theirs,
    'update must NOT plant the template router description over the consumer inventory')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.files[INVENTORY].mode, 'seeded',
    'the manifest re-records the reclassified mode, or gate-integrity keeps judging consumer edits as tampering')
})

test('the reverse direction never applies: a recorded-seeded file stays the consumer’s even when classification says owned', () => {
  const dir = scaffold()
  const manifestPath = join(dir, '.harness', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.files[OWNED_GATE].mode, 'owned', 'precondition: the gate ships owned')

  manifest.files[OWNED_GATE].mode = 'seeded'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const theirs = '// the consumer took this file over; only a reviewed channel may take it back\n'
  writeFileSync(join(dir, OWNED_GATE), theirs)

  const updated = run(['update', '--dir', dir])
  assert.equal(updated.code, 0, updated.out)

  assert.equal(readFileSync(join(dir, OWNED_GATE), 'utf8'), theirs,
    'seeded → owned from classification alone would START clobbering a consumer file — it must never happen')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.files[OWNED_GATE].mode, 'seeded', 'the recorded mode stands')
})
