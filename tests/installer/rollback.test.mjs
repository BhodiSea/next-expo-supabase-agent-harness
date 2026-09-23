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
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
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
import { liveOwned, tablesWith } from './helpers/provenance-fixture.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const ROLLBACK_URL = new URL('../../installer/lib/rollback.mjs', import.meta.url).href

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
//
// …and, since 1.0.2, ALSO the exact shape of a consumer's re-recorded fork, which `update`
// now refuses to overwrite. What makes this a vintage and not a fork is that a release
// shipped the stale bytes — so the fixture says so, in the released-sha tables every
// `update` below is handed (`AGED_TABLES`).
function ageFixture(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, '.harness', 'manifest.json'), 'utf8'))
  const owned = Object.entries(manifest.files)
    .filter(([ip, meta]) => meta.mode === 'owned' && ip.startsWith('tools/') && ip.endsWith('.mjs'))
    .slice(0, 3)
    .map(([ip]) => ip)
  assert.equal(owned.length, 3, 'fixture precondition: three owned tools files')
  for (const ip of owned) {
    const stale = staleBytes(ip)
    writeFileSync(join(dir, ip), stale)
    manifest.files[ip].sha256 = sha256(stale)
  }
  writeFileSync(join(dir, '.harness', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return owned
}

/** @param {string} ip */
const staleBytes = (ip) => `// stale ${ip} from the previous vintage\n`

// The live owned surface, plus "this version also shipped the stale bytes" for every
// tools/*.mjs path — a superset of whichever three ageFixture picks.
const AGED_TABLES = (() => {
  const live = liveOwned()
  const aged = Object.fromEntries(
    Object.keys(live)
      .filter((ip) => ip.startsWith('tools/') && ip.endsWith('.mjs'))
      .map((ip) => [ip, [{ sha256: sha256(staleBytes(ip)) }]]),
  )
  return tablesWith(aged)
})()

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
    () => update({ dir, dryRun: false }, { writeFile: failing, releasedShas: AGED_TABLES }),
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
  const code = await update({ dir, dryRun: false }, { releasedShas: AGED_TABLES })
  assert.equal(code, 0, 'a re-run update after rollback completes green')
  for (const ip of aged) {
    assert.doesNotMatch(readFileSync(join(dir, ip), 'utf8'), /^\/\/ stale /, `${ip} upgraded by the re-run`)
  }
})

test('a clean update records a snapshot and a second update is idempotent (written==0)', async () => {
  const dir = initFixture()
  ageFixture(dir)
  const code = await update({ dir, dryRun: false, report: 'json' }, { releasedShas: AGED_TABLES })
  assert.equal(code, 0)
  assert.ok(readRollbackSnapshot(dir), 'every real update leaves a rollback point')

  // Idempotence: the second sweep writes nothing (the lane asserts the same).
  const out = []
  const origLog = console.log
  console.log = (...args) => out.push(args.join(' '))
  try {
    await update({ dir, dryRun: false, report: 'json' }, { releasedShas: AGED_TABLES })
  } finally {
    console.log = origLog
  }
  const parsed = JSON.parse(out.join('\n'))
  assert.deepEqual(parsed.written, [], 'second update writes zero files')
})

test('dry-run records no snapshot', async () => {
  const dir = initFixture()
  ageFixture(dir)
  await update({ dir, dryRun: true }, { releasedShas: AGED_TABLES })
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

// ── the snapshot reads each candidate through ONE descriptor ─────────────────
// writeRollbackSnapshot used to resolve a candidate's name three times (exists + stat, stat
// for the mode, read for the bytes), so a file replaced in between was recorded with one
// inode's mode and another's bytes. It now opens once and takes both from the descriptor.
// What it records as present or absent must not move: every case below is what the old
// `existsSync(p) && statSync(p).isFile()` answered.

const POSIX = process.platform !== 'win32'
const NONROOT = POSIX && typeof process.getuid === 'function' && process.getuid() !== 0

/** Snapshot `paths` (install-relative) under `dir` and return the recorded entries. */
function snapshotOf(dir, paths) {
  const files = Object.fromEntries(paths.map((p) => [p, { mode: 'owned', sha256: 'x' }]))
  const args = { targetDir: dir, manifest: { files }, plan: [], from: '0.8.0', to: '0.9.0' }
  writeRollbackSnapshot(args)
  return readRollbackSnapshot(dir).snapshot.files
}

// Windows runners may lack the symlink privilege (no Developer Mode); the caller skips there.
function trySymlink(target, path) {
  try {
    symlinkSync(target, path)
    return true
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return false
    }
    throw err
  }
}

test('snapshot takes the mode and the bytes from ONE inode while the file is replaced underneath', {
  skip: !POSIX && 'mode bits are the observable here, and win32 has no 0o600/0o700 distinction',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  mkdirSync(join(dir, 'tools'))
  const dest = join(dir, 'tools', 'churn.mjs')
  // Version n: bytes `v<n>`, mode 0o600 when n is even and 0o700 when odd, swapped in by
  // rename, so every version is a new inode.
  const modeOf = (n) => (n % 2 === 0 ? 0o600 : 0o700)
  const plant = (n) => {
    const staged = `${dest}.${String(n)}`
    writeFileSync(staged, `v${String(n)}\n`)
    chmodSync(staged, modeOf(n))
    renameSync(staged, dest)
  }
  plant(0)
  // A concurrent writer at the worst moments: every call that resolves `dest` BY NAME swaps
  // the next version in as soon as it returns. A read through a descriptor is untouched.
  let version = 0
  const originals = {}
  for (const name of ['existsSync', 'statSync', 'openSync', 'readFileSync']) {
    const original = fs[name]
    originals[name] = original
    fs[name] = (p, ...rest) => {
      const out = original(p, ...rest)
      if (p === dest) {
        version += 1
        plant(version)
      }
      return out
    }
  }
  syncBuiltinESMExports()
  let entry
  try {
    entry = snapshotOf(dir, ['tools/churn.mjs'])['tools/churn.mjs']
  } finally {
    Object.assign(fs, originals)
    syncBuiltinESMExports()
  }
  assert.ok(entry.existed, JSON.stringify(entry))
  const bytes = Buffer.from(entry.b64, 'base64').toString()
  const recorded = Number(/^v(\d+)\n$/.exec(bytes)?.[1])
  assert.equal(entry.mode, modeOf(recorded), `the mode is not the mode of ${bytes.trim()}`)
  assert.equal(recorded, 0, 'and both are the file that was there when the name was resolved once')
})

test('snapshot records a directory and a path under a regular file as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeInstallFile(join(dir, 'tools', 'a.mjs'), 'export const a = 1\n')
  mkdirSync(join(dir, 'tools', 'a-dir'))
  const files = snapshotOf(dir, ['tools/a-dir', 'tools/a.mjs/child', 'tools/a.mjs'])
  assert.deepEqual(files['tools/a-dir'], { existed: false })
  assert.deepEqual(files['tools/a.mjs/child'], { existed: false })
  assert.equal(Buffer.from(files['tools/a.mjs'].b64, 'base64').toString(), 'export const a = 1\n')
})

test('snapshot follows a symlink as statSync did; a dangling link is absent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const target = join(dir, 'tools', 'real.mjs')
  writeInstallFile(target, 'export const real = 1\n')
  if (POSIX) chmodSync(target, 0o600)
  if (!trySymlink(target, join(dir, 'tools', 'link.mjs'))) {
    t.skip('this win32 runner has no symlink privilege')
    return
  }
  trySymlink(join(dir, 'tools', 'gone.mjs'), join(dir, 'tools', 'dangling.mjs'))
  const files = snapshotOf(dir, ['tools/link.mjs', 'tools/dangling.mjs'])
  const link = files['tools/link.mjs']
  assert.ok(link.existed, JSON.stringify(link))
  assert.equal(Buffer.from(link.b64, 'base64').toString(), 'export const real = 1\n')
  if (POSIX) assert.equal(link.mode, 0o600, "the target's mode, not the link's")
  assert.deepEqual(files['tools/dangling.mjs'], { existed: false })
})

test('a FIFO candidate is recorded absent without blocking', {
  skip: !POSIX && 'win32 has no FIFOs',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  mkdirSync(join(dir, 'tools'))
  if (spawnSync('mkfifo', [join(dir, 'tools', 'pipe')]).status !== 0) {
    t.skip('mkfifo is unavailable on this runner')
    return
  }
  // In a CHILD with a timeout: a blocking open(2) on a FIFO stalls the whole event loop, so
  // an in-process timer could never fire and a regression would hang the job, not fail it.
  const script = [
    `import { readRollbackSnapshot, writeRollbackSnapshot } from ${JSON.stringify(ROLLBACK_URL)}`,
    'const targetDir = process.argv[1]',
    "const manifest = { files: { 'tools/pipe': {} } }",
    "writeRollbackSnapshot({ targetDir, manifest, plan: [], from: '0.8.0', to: '0.9.0' })",
    "console.log(JSON.stringify(readRollbackSnapshot(targetDir).snapshot.files['tools/pipe']))",
  ].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(r.signal, null, 'the snapshot blocked on the FIFO and was killed')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { existed: false })
})

test('a UNIX socket candidate is recorded absent', {
  skip: !POSIX && 'a path-bound socket is POSIX-only',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  mkdirSync(join(dir, 'tools'))
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(join(dir, 'tools', 'sock'), resolve)
  })
  let files
  try {
    // open(2) on a socket fails (ENXIO on Linux, an errno libuv does not map on darwin); the
    // old existsSync answered false for it, and so must the snapshot.
    files = snapshotOf(dir, ['tools/sock'])
  } finally {
    server.close()
  }
  assert.deepEqual(files['tools/sock'], { existed: false })
})

test('an unreadable directory is absent; an unreadable FILE throws before any blob', {
  skip: !NONROOT && 'needs POSIX permissions and a non-root user',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const lockedDir = join(dir, 'tools', 'locked-dir')
  const lockedFile = join(dir, 'tools', 'locked.mjs')
  mkdirSync(lockedDir, { recursive: true })
  writeInstallFile(lockedFile, 'export const locked = 1\n')
  chmodSync(lockedDir, 0o000)
  try {
    assert.deepEqual(snapshotOf(dir, ['tools/locked-dir'])['tools/locked-dir'], { existed: false })
    chmodSync(lockedFile, 0o000)
    rmSync(rollbackDirFor(dir), { recursive: true, force: true })
    assert.throws(() => snapshotOf(dir, ['tools/locked.mjs']), { code: 'EACCES' })
    assert.equal(readRollbackSnapshot(dir), null, 'no blob when a present file cannot be read')
  } finally {
    chmodSync(lockedDir, 0o755)
    chmodSync(lockedFile, 0o644)
  }
})
