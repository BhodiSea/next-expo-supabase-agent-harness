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
import { gzipSync } from 'node:zlib'
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
  assert.equal(first.snapshot.v, 2, 'a 1.0.4 snapshot records vacancy, so its blob says v: 2')

  // N=1: a second snapshot replaces the first.
  writeRollbackSnapshot({ targetDir: dir, manifest, plan, from: '0.8.0', to: '0.9.1' })
  assert.equal(readdirSync(rollbackDirFor(dir)).length, 1, 'exactly one blob is kept')
  assert.equal(readRollbackSnapshot(dir).snapshot.to, '0.9.1')
})

// The park channels `update` writes outside the rendered plan must round-trip too, or an
// update that fails partway leaves a phantom instruction behind (1.1.0, #83: pin-floors.json
// joins dependencies.json and source-fixes.json).
test('snapshot records every parked obligation file, present with its bytes and absent as absent', () => {
  const OBLIGATION_FILES = [
    '.harness/pending/dependencies.json',
    '.harness/pending/source-fixes.json',
    '.harness/pending/pin-floors.json',
  ]
  const manifest = { files: {} }

  const present = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeInstallFile(join(present, '.harness', 'manifest.json'), '{"files":{}}\n')
  for (const rel of OBLIGATION_FILES) writeInstallFile(join(present, rel), `{"parked":"${rel}"}\n`)
  writeRollbackSnapshot({ targetDir: present, manifest, plan: [], from: '1.0.4', to: '1.1.0' })
  const kept = readRollbackSnapshot(present).snapshot.files
  for (const rel of OBLIGATION_FILES) {
    assert.ok(kept[rel]?.existed, `${rel} must be a snapshot candidate`)
    assert.equal(Buffer.from(kept[rel].b64, 'base64').toString(), `{"parked":"${rel}"}\n`)
  }

  const absent = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeInstallFile(join(absent, '.harness', 'manifest.json'), '{"files":{}}\n')
  writeRollbackSnapshot({ targetDir: absent, manifest, plan: [], from: '1.0.4', to: '1.1.0' })
  const vacant = readRollbackSnapshot(absent).snapshot.files
  for (const rel of OBLIGATION_FILES) {
    assert.ok(vacant[rel] && !vacant[rel].existed, `${rel} must be recorded absent, so rollback deletes one the update parked`)
  }
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
  // Nothing can be at a path under a regular file (lstat: ENOTDIR), so it is recorded VACANT:
  // the positive evidence that lets rollback remove a directory the update put there.
  assert.deepEqual(files['tools/a.mjs/child'], { existed: false, vacant: true })
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
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  mkdirSync(join(dir, 'tools'))
  const server = createServer()
  const listenError = await new Promise((resolve) => {
    server.once('error', resolve)
    server.listen(join(dir, 'tools', 'sock'), () => resolve(null))
  })
  // A deep TMPDIR can push the socket path past sun_path (about 104 bytes on darwin, 108 on
  // Linux); that says nothing about the snapshot, so the case is skipped, never passed.
  if (listenError?.code === 'EINVAL' || listenError?.code === 'ENAMETOOLONG') {
    t.skip('the socket path exceeds sun_path under this TMPDIR')
    return
  }
  if (listenError) throw listenError
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
    // A path lstat cannot inspect (EACCES on its parent) is not provably empty: never vacant.
    const inside = snapshotOf(dir, ['tools/locked-dir/child'])['tools/locked-dir/child']
    assert.deepEqual(inside, { existed: false })
    chmodSync(lockedFile, 0o000)
    rmSync(rollbackDirFor(dir), { recursive: true, force: true })
    assert.throws(() => snapshotOf(dir, ['tools/locked.mjs']), { code: 'EACCES' })
    assert.equal(readRollbackSnapshot(dir), null, 'no blob when a present file cannot be read')
  } finally {
    chmodSync(lockedDir, 0o755)
    chmodSync(lockedFile, 0o644)
  }
})

// ── a directory where the snapshot recorded no file (#52) ────────────────────
// writeInstallFile creates every missing parent, so an update that replaces an owned file
// `P` with files under `P/` (a `removed` record plus new plan paths) leaves a DIRECTORY at a
// path the snapshot recorded as absent, or as a regular file. Through 1.0.3 rollback called
// `rmSync(dest, { force: true })` on it (or renamed a staged file onto it), which throws, so
// every entry sorted after it and the manifest kept their post-update state and a re-run
// threw at the same path. A directory is now removed only on POSITIVE evidence in the
// snapshot (`vacant: true`, or `existed: true`), and only inside the install.

/** Run `update --rollback --report json` in process; return the exit code and the report. */
function rollbackJson(dir) {
  const out = []
  const origLog = console.log
  console.log = (...args) => out.push(args.join(' '))
  let code
  try {
    code = rollbackUpdate({ dir, report: 'json' })
  } finally {
    console.log = origLog
  }
  return { code, report: JSON.parse(out.join('\n')) }
}

/** A snapshot blob exactly as 1.0.3 and earlier wrote it: `v: 1`, and no `vacant` field. */
function writeV1Blob(dir, files) {
  const snapshot = { v: 1, from: '1.0.2', to: '1.0.3', recordedAt: '2026-09-21T00:00:00.000Z', files }
  writeInstallFile(join(rollbackDirFor(dir), '1.0.2-1.0.3.json.gz'), gzipSync(JSON.stringify(snapshot)))
}

const recorded = (text, mode = 0o644) => ({
  existed: true,
  mode,
  b64: Buffer.from(text).toString('base64'),
})

test('rollback removes a directory the update created at a vacant path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeRollbackSnapshot({
    targetDir: dir,
    manifest: { files: {} },
    plan: [{ installPath: 'tools/new-gate' }],
    from: '0.8.0',
    to: '0.9.0',
  })
  // What update's writes leave: every missing parent created, so `tools/new-gate` is a tree.
  writeInstallFile(join(dir, 'tools', 'new-gate', 'nested', 'check.mjs'), 'export {}\n')

  assert.equal(rollbackUpdate({ dir }), 0, 'rollback completes instead of throwing')
  assert.equal(existsSync(join(dir, 'tools', 'new-gate')), false, 'the created directory is gone')
  assert.equal(rollbackUpdate({ dir }), 0, 'and a repeated rollback is a no-op')
  // The evidence that licensed the delete: nothing at all was at the path (lstat: ENOENT).
  assert.deepEqual(readRollbackSnapshot(dir).snapshot.files['tools/new-gate'], {
    existed: false,
    vacant: true,
  })
})

test('a file the update replaced with a directory is restored with its bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const gate = join(dir, 'tools', 'gate.mjs')
  const manifestPath = join(dir, '.harness', 'manifest.json')
  const gateBytes = '#!/usr/bin/env node\nexport const gate = 1\n'
  const manifestBytes = '{"files":{"tools/gate.mjs":{}}}\n'
  writeInstallFile(gate, gateBytes)
  writeInstallFile(manifestPath, manifestBytes)
  writeRollbackSnapshot({
    targetDir: dir,
    manifest: { files: { 'tools/gate.mjs': { mode: 'owned', sha256: 'x' } } },
    plan: [{ installPath: 'tools/gate.mjs/check.mjs' }],
    from: '0.8.0',
    to: '0.9.0',
  })
  // The update: a `removed` record deletes `tools/gate.mjs`, then the plan writes under it.
  rmSync(gate)
  writeInstallFile(join(gate, 'check.mjs'), 'export {}\n')
  writeFileSync(manifestPath, '{"files":{"tools/gate.mjs/check.mjs":{}}}\n')

  const { code, report } = rollbackJson(dir)
  assert.equal(code, 0, JSON.stringify(report))
  // Read first, then stat once: a read of a directory throws, and one stat answers both the
  // kind and the mode (a stat-then-read on one path is the check-then-use shape CodeQL flags).
  assert.equal(readFileSync(gate, 'utf8'), gateBytes, 'the file is back with its bytes')
  const restored = statSync(gate)
  assert.ok(restored.isFile(), 'the directory is gone')
  if (POSIX) assert.equal(restored.mode & 0o777, 0o755, 'with its recorded mode')
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBytes, 'and the manifest after it')
  const files = readRollbackSnapshot(dir).snapshot.files
  assert.equal(files['tools/gate.mjs'].existed, true)
  assert.deepEqual(files['tools/gate.mjs/check.mjs'], { existed: false, vacant: true })
})

test('a directory that was already at a candidate path survives, with a note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const mine = join(dir, 'tools', 'kept', 'mine.txt')
  const manifestPath = join(dir, '.harness', 'manifest.json')
  writeInstallFile(mine, 'mine\n')
  writeInstallFile(manifestPath, '{"files":{}}\n')
  writeRollbackSnapshot({
    targetDir: dir,
    manifest: { files: {} },
    plan: [{ installPath: 'tools/kept' }, { installPath: 'tools/later.mjs' }],
    from: '0.8.0',
    to: '0.9.0',
  })
  assert.deepEqual(readRollbackSnapshot(dir).snapshot.files['tools/kept'], { existed: false })
  writeInstallFile(join(dir, 'tools', 'later.mjs'), 'export {}\n')
  writeFileSync(manifestPath, '{"files":{"tools/later.mjs":{}}}\n')

  const { code, report } = rollbackJson(dir)
  assert.equal(code, 0, JSON.stringify(report))
  assert.equal(readFileSync(mine, 'utf8'), 'mine\n', "the consumer's directory keeps its contents")
  assert.deepEqual(report.conflicts, [])
  assert.ok(
    report.notes.some((n) => n.includes('tools/kept')),
    `the report names the directory it left: ${JSON.stringify(report.notes)}`,
  )
  assert.equal(existsSync(join(dir, 'tools', 'later.mjs')), false, 'entries after it still roll back')
  assert.equal(readFileSync(manifestPath, 'utf8'), '{"files":{}}\n', 'and so does the manifest')
})

test('under a v1 blob a directory at an absent path is a conflict, not a delete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const manifestPath = join(dir, '.harness', 'manifest.json')
  const created = join(dir, 'tools', 'new-gate', 'nested', 'check.mjs')
  const gate = join(dir, 'tools', 'gate.mjs')
  writeInstallFile(manifestPath, '{"files":{"tools/new-gate/nested/check.mjs":{}}}\n')
  writeInstallFile(created, 'export {}\n')
  writeInstallFile(join(gate, 'check.mjs'), 'export {}\n')
  writeV1Blob(dir, {
    '.harness/manifest.json': recorded('{"files":{"tools/gate.mjs":{}}}\n'),
    'tools/gate.mjs': recorded('export const gate = 1\n'),
    'tools/new-gate': { existed: false },
    // A v1 blob never carries `vacant`; one that does was not written by any release, and
    // the field licenses nothing under v1.
    'tools/forged': { existed: false, vacant: true },
  })
  mkdirSync(join(dir, 'tools', 'forged'))

  const { code, report } = rollbackJson(dir)
  assert.equal(code, 2, 'a conflict exits 2 through the report')
  assert.ok(existsSync(created), 'the directory survives: a v1 snapshot cannot say who made it')
  assert.ok(existsSync(join(dir, 'tools', 'forged')), '`vacant` is not read from a v1 blob')
  assert.deepEqual(
    report.conflicts.map((c) => c.path),
    ['tools/forged', 'tools/new-gate'],
  )
  assert.match(report.conflicts[1].detail, /cannot tell whether the update created/)
  assert.match(report.conflicts[1].detail, /remove it by hand/)
  // Positive evidence still works under v1: a path recorded as a regular file is restored.
  assert.equal(readFileSync(gate, 'utf8'), 'export const gate = 1\n')
  assert.equal(readFileSync(manifestPath, 'utf8'), '{"files":{"tools/gate.mjs":{}}}\n', 'manifest restored')
})

test('the CLI exits 2 and names the directory a v1 blob cannot account for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  writeInstallFile(join(dir, '.harness', 'manifest.json'), '{"files":{}}\n')
  writeInstallFile(join(dir, 'tools', 'new-gate', 'check.mjs'), 'export {}\n')
  writeV1Blob(dir, {
    '.harness/manifest.json': recorded('{"files":{}}\n'),
    'tools/new-gate': { existed: false },
  })
  const res = spawnSync('node', [CLI, 'update', '--rollback', '--dir', dir], { encoding: 'utf8' })
  assert.equal(res.status, 2, `${res.stdout}${res.stderr}`)
  assert.match(res.stdout, /CONFLICT tools\/new-gate: /)
  assert.doesNotMatch(res.stderr, /^error:/m)
})

test('a symlink inside a removed directory is unlinked, never followed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const outside = mkdtempSync(join(tmpdir(), 'tpah-rb-outside-'))
  writeFileSync(join(outside, 'keep.txt'), 'keep\n')
  writeRollbackSnapshot({
    targetDir: dir,
    manifest: { files: {} },
    plan: [{ installPath: 'tools/new-gate' }],
    from: '0.8.0',
    to: '0.9.0',
  })
  writeInstallFile(join(dir, 'tools', 'new-gate', 'nested', 'check.mjs'), 'export {}\n')
  if (!trySymlink(outside, join(dir, 'tools', 'new-gate', 'escape'))) {
    t.skip('this win32 runner has no symlink privilege')
    return
  }
  trySymlink(join(outside, 'keep.txt'), join(dir, 'tools', 'new-gate', 'nested', 'keep-link.txt'))

  assert.equal(rollbackUpdate({ dir }), 0)
  assert.equal(existsSync(join(dir, 'tools', 'new-gate')), false)
  assert.deepEqual(readdirSync(outside), ['keep.txt'], 'the link target directory is untouched')
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep\n')
})

test('a symlinked parent that leads outside the install: nothing outside is removed, exit 2', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-rb-'))
  const outside = mkdtempSync(join(tmpdir(), 'tpah-rb-outside-'))
  const manifestPath = join(dir, '.harness', 'manifest.json')
  writeFileSync(join(outside, 'gate.mjs'), 'export const gate = 1\n')
  mkdirSync(join(dir, 'tools'))
  if (!trySymlink(outside, join(dir, 'tools', 'linked'))) {
    t.skip('this win32 runner has no symlink privilege')
    return
  }
  writeInstallFile(manifestPath, '{"files":{}}\n')
  writeRollbackSnapshot({
    targetDir: dir,
    manifest: { files: { 'tools/linked/gate.mjs': { mode: 'owned', sha256: 'x' } } },
    plan: [{ installPath: 'tools/linked/new-gate' }],
    from: '0.8.0',
    to: '0.9.0',
  })
  // The update, through the link: both directories land OUTSIDE the install.
  rmSync(join(outside, 'gate.mjs'))
  writeInstallFile(join(dir, 'tools', 'linked', 'gate.mjs', 'check.mjs'), 'export {}\n')
  writeInstallFile(join(dir, 'tools', 'linked', 'new-gate', 'nested', 'check.mjs'), 'export {}\n')
  writeFileSync(manifestPath, '{"files":{"x":{}}}\n')

  const { code, report } = rollbackJson(dir)
  assert.equal(code, 2, JSON.stringify(report))
  assert.ok(existsSync(join(outside, 'gate.mjs', 'check.mjs')), 'outside the install: left alone')
  assert.ok(existsSync(join(outside, 'new-gate', 'nested', 'check.mjs')), 'outside the install: left alone')
  assert.deepEqual(
    report.conflicts.map((c) => c.path),
    ['tools/linked/gate.mjs', 'tools/linked/new-gate'],
  )
  assert.equal(readFileSync(manifestPath, 'utf8'), '{"files":{}}\n', 'the manifest is still restored')
  // Refused on containment alone: the snapshot held the evidence that would license both.
  const files = readRollbackSnapshot(dir).snapshot.files
  assert.equal(files['tools/linked/gate.mjs'].existed, true)
  assert.deepEqual(files['tools/linked/new-gate'], { existed: false, vacant: true })
})
