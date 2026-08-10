// The 0.9.0 rollback story: `update` records a pre-update snapshot of every
// path it could touch (one gzipped blob, N=1, .harness/rollback/), and
// `update --rollback` restores the tree byte-for-byte — files first, manifest
// LAST, mirroring update's own commit ordering so an interrupted rollback
// re-runs cleanly. The fault-injection test below is the proof the release
// notes point at: a mid-sweep write failure leaves a damaged tree, and
// rollback returns it to the exact pre-update state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { update } from '../../installer/commands/update.mjs'
import {
  readRollbackSnapshot,
  rollbackDirFor,
  rollbackUpdate,
  writeRollbackSnapshot,
} from '../../installer/lib/rollback.mjs'
import { readManifest, sha256 } from '../../installer/lib/manifest.mjs'
import { writeInstallFile } from '../../installer/lib/write-file.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

const SETS = [
  '--set', 'PROJECT_NAME=Rollback Fixture',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const res = spawnSync('node', [CLI, 'init', '--dir', dir, '--yes', ...SETS], { encoding: 'utf8' })
  assert.equal(res.status, 0, `init must succeed: ${res.stdout}${res.stderr}`)
  return dir
}

// Full-tree digest (path → sha) EXCLUDING .harness/rollback — the blob is new
// state by design; everything else must round-trip exactly.
function treeDigest(dir) {
  const digest = new Map()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const rel = path.slice(dir.length + 1).replaceAll('\\', '/')
    if (rel.startsWith('.harness/rollback/')) continue
    if (rel.startsWith('node_modules/')) continue
    digest.set(rel, createHash('sha256').update(readFileSync(path)).digest('hex'))
  }
  return digest
}

function diffDigests(before, after) {
  const changed = []
  for (const [rel, sha] of before) {
    if (after.get(rel) !== sha) changed.push(rel)
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) changed.push(rel)
  }
  return changed.sort()
}

// Make an install look one vintage old: rewrite three OWNED tool files on disk
// AND re-record their manifest shas so update classifies them update-clean —
// the exact shape of a real version sweep (recorded == current ≠ incoming).
function ageFixture(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, '.harness', 'manifest.json'), 'utf8'))
  const owned = Object.entries(manifest.files)
    .filter(([ip, meta]) => meta.mode === 'owned' && ip.startsWith('tools/') && ip.endsWith('.mjs'))
    .slice(0, 3)
    .map(([ip]) => ip)
  assert.equal(owned.length, 3, 'fixture precondition: three owned tools files')
  for (const ip of owned) {
    const stale = `// stale ${ip} from the previous vintage\n`
    writeFileSync(join(dir, ip), stale)
    manifest.files[ip].sha256 = sha256(stale)
  }
  writeFileSync(join(dir, '.harness', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return owned
}

test('snapshot blob: N=1, round-trips, and records absent candidates as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeInstallFile(join(dir, 'tools', 'a.mjs'), 'export const a = 1\n')
  writeInstallFile(join(dir, '.harness', 'manifest.json'), '{"files":{}}\n')

  const manifest = { files: { 'tools/a.mjs': { mode: 'owned', sha256: sha256('x') } } }
  const plan = [{ installPath: 'tools/a.mjs' }, { installPath: 'tools/new-gate.mjs' }]
  writeRollbackSnapshot({ targetDir: dir, manifest, plan, from: '0.8.0', to: '0.9.0' })

  const first = readRollbackSnapshot(dir)
  assert.ok(first, 'snapshot must be readable back')
  assert.equal(first.snapshot.from, '0.8.0')
  assert.equal(first.snapshot.to, '0.9.0')
  const a = first.snapshot.files['tools/a.mjs']
  assert.ok(a.existed, 'present file recorded with bytes')
  assert.equal(Buffer.from(a.b64, 'base64').toString(), 'export const a = 1\n')
  const missing = first.snapshot.files['tools/new-gate.mjs']
  assert.ok(missing && !missing.existed, 'absent candidate recorded as absent — rollback deletes it')
  assert.ok(first.snapshot.files['.harness/manifest.json']?.existed, 'the manifest itself is a candidate')

  // N=1: a second snapshot replaces the first.
  writeRollbackSnapshot({ targetDir: dir, manifest, plan, from: '0.8.0', to: '0.9.1' })
  assert.equal(readdirSync(rollbackDirFor(dir)).length, 1, 'exactly one blob is kept')
  assert.equal(readRollbackSnapshot(dir).snapshot.to, '0.9.1')
})

test('rollback with no snapshot refuses loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeInstallFile(join(dir, '.harness', 'manifest.json'), '{"files":{}}\n')
  assert.notEqual(rollbackUpdate({ dir }), 0, 'nothing to roll back is an error, not a green no-op')
})

test('FAULT INJECTION: a mid-sweep write failure is fully reverted by rollback', async () => {
  const dir = initFixture()
  const aged = ageFixture(dir)
  const before = treeDigest(dir)

  // A writeFile that dies after two writes — the interrupted upgrade.
  let writes = 0
  const failing = (dest, content) => {
    writes += 1
    if (writes > 2) throw new Error('ENOSPC: fault injection')
    writeInstallFile(dest, content)
  }
  await assert.rejects(
    () => update({ dir, dryRun: false }, { writeFile: failing }),
    /fault injection/,
    'the injected failure must surface, never be swallowed',
  )

  const damaged = treeDigest(dir)
  assert.ok(diffDigests(before, damaged).length > 0, 'the faulted update must have mutated the tree')
  assert.ok(existsSync(rollbackDirFor(dir)), 'the snapshot was recorded before any mutation')

  assert.equal(rollbackUpdate({ dir }), 0, 'rollback must succeed')
  const restored = treeDigest(dir)
  assert.deepEqual(diffDigests(before, restored), [], 'rollback restores the tree byte-for-byte')

  // The manifest still reads and still records the PRE-update version state.
  const manifest = readManifest(dir)
  assert.ok(manifest, 'manifest must parse after rollback')
  for (const ip of aged) {
    assert.match(readFileSync(join(dir, ip), 'utf8'), /^\/\/ stale /, `${ip} back at its pre-update bytes`)
  }

  // And the recovered tree upgrades cleanly on the next attempt.
  const code = await update({ dir, dryRun: false })
  assert.equal(code, 0, 'a re-run update after rollback completes green')
  for (const ip of aged) {
    assert.doesNotMatch(readFileSync(join(dir, ip), 'utf8'), /^\/\/ stale /, `${ip} upgraded by the re-run`)
  }
})

test('a clean update records a snapshot and a second update is idempotent (written==0)', async () => {
  const dir = initFixture()
  ageFixture(dir)
  const code = await update({ dir, dryRun: false, report: 'json' })
  assert.equal(code, 0)
  assert.ok(readRollbackSnapshot(dir), 'every real update leaves a rollback point')

  // Idempotence: the second sweep writes nothing (the lane asserts the same).
  const out = []
  const origLog = console.log
  console.log = (...args) => out.push(args.join(' '))
  try {
    await update({ dir, dryRun: false, report: 'json' })
  } finally {
    console.log = origLog
  }
  const parsed = JSON.parse(out.join('\n'))
  assert.deepEqual(parsed.written, [], 'second update writes zero files')
})

test('dry-run records no snapshot', async () => {
  const dir = initFixture()
  ageFixture(dir)
  await update({ dir, dryRun: true })
  assert.equal(readRollbackSnapshot(dir), null, 'dry-run must not mutate .harness/rollback')
})

test('rollback restores the executable bit with the bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const hook = join(dir, '.claude', 'hooks', 'guard.mjs')
  writeInstallFile(hook, '#!/usr/bin/env node\nexport {}\n')
  writeInstallFile(join(dir, '.harness', 'manifest.json'), '{"files":{}}\n')
  const manifest = { files: { '.claude/hooks/guard.mjs': { mode: 'owned', sha256: 'x' } } }
  writeRollbackSnapshot({ targetDir: dir, manifest, plan: [], from: '0.8.0', to: '0.9.0' })

  // The disarm scenario: the hook is torn to nothing.
  writeFileSync(hook, '')
  assert.equal(rollbackUpdate({ dir }), 0)
  assert.equal(readFileSync(hook, 'utf8'), '#!/usr/bin/env node\nexport {}\n')
  if (process.platform !== 'win32') {
    assert.equal(statSync(hook).mode & 0o777, 0o755, 'executable bit restored with the bytes')
  }
})
