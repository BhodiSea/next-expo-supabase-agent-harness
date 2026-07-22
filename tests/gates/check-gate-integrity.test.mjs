// Can-fail proofs for the gate-integrity gate (template/base/tools/check-gate-integrity.mjs).
// Fixture = a REAL scaffold from `init` in tmpdir; the gate runs via spawnSync with
// cwd inside it (exactly how validate invokes it), env CI=true. Proves: a fresh
// install is green, a raw shell tamper on any harness-owned enforcement file reds
// the gate naming the file, human tuning of the mode-'config' gate config does NOT
// trip it, and a missing manifest fails CLOSED in CI (skipOrFail asymmetry).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

let scaffold

before(() => {
  scaffold = mkdtempSync(join(tmpdir(), 'epah-gateint-'))
  const res = spawnSync(
    'node',
    [
      CLI, 'init', '--dir', scaffold, '--yes',
      '--set', 'PROJECT_NAME=Integrity App',
      '--set', 'GITHUB_OWNER=fixture-owner',
      '--set', 'SECURITY_OWNERS=@fixture-owner/security',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
  assert.ok(
    existsSync(join(scaffold, 'tools/check-gate-integrity.mjs')),
    'init must install the gate-integrity script',
  )
})

function runGate(env = {}) {
  const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
    cwd: scaffold,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', ...env },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: a fresh scaffold passes (every owned enforcement file matches its recorded hash)', () => {
  const r = runGate()
  assert.equal(r.code, 0, r.out)
})

test('RED: a raw append to an owned gate script (shell tamper) fails naming the file', () => {
  const target = join(scaffold, 'tools/check-migrations.mjs')
  const original = readFileSync(target)
  try {
    appendFileSync(target, '\n// tampered via raw shell write, bypassing the write-guard\n')
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('tools/check-migrations.mjs'), r.out)
  } finally {
    writeFileSync(target, original)
  }
  assert.equal(runGate().code, 0, 'restoring the file must return the gate to green')
})

test('RED: deleting an owned enforcement file fails naming it', () => {
  const target = join(scaffold, 'tools/check-contract-drift.mjs')
  const original = readFileSync(target)
  try {
    rmSync(target)
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('tools/check-contract-drift.mjs'), r.out)
    assert.ok(r.out.includes('missing'), r.out)
  } finally {
    writeFileSync(target, original)
  }
})

test('GREEN: hand-tuning tools/harness.config.mjs (mode config) does not trip the gate', () => {
  const target = join(scaffold, 'tools/harness.config.mjs')
  const original = readFileSync(target, 'utf8')
  try {
    writeFileSync(target, `${original}\n// human-tuned: project-specific gate note\n`)
    const r = runGate()
    assert.equal(r.code, 0, r.out)
  } finally {
    writeFileSync(target, original)
  }
})

test('missing manifest: fails CLOSED in CI, skips LOUDLY locally', () => {
  const manifest = join(scaffold, '.harness/manifest.json')
  const parked = join(scaffold, '.harness/manifest.json.parked')
  renameSync(manifest, parked)
  try {
    const ci = runGate()
    assert.equal(ci.code, 1, ci.out)
    assert.ok(ci.out.includes('not an installed harness'), ci.out)
    // The same absence is a loud SKIP outside CI — never a silent pass.
    const local = runGate({ CI: '' })
    assert.equal(local.code, 0, local.out)
    assert.ok(local.out.includes('SKIPPED'), local.out)
  } finally {
    renameSync(parked, manifest)
  }
})
