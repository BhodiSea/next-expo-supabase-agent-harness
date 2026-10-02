// The pre-update snapshot and its restore path (0.9.0). `update` is the one
// operation every release's ramp expiries force the whole installed base
// through, and before 0.9.0 an interruption mid-sweep left manifest ⊥ disk
// with no revert story — and a torn file under .claude/hooks/ fails OPEN.
// The snapshot records every path the sweep COULD touch (the manifest's own
// keys, the rendered plan, the park destinations, and the manifest itself) as
// one gzipped blob; `update --rollback` restores them byte-for-byte, files
// first, manifest LAST — the same commit ordering update uses, so an
// interrupted rollback re-runs cleanly.
//
// A path the snapshot recorded as absent can come back as a DIRECTORY: writeInstallFile
// creates every missing parent, so a release that replaces an owned file `P` with files
// under `P/` leaves one. Rollback removes that directory only on positive evidence in the
// snapshot (1.0.4, blob `v: 2`): `vacant: true`, recorded when nothing at all was at the
// path, or `existed: true`, recorded for a regular file. A directory at any other absent
// path may be the consumer's, so it stays, and nothing outside the install is ever removed.
//
// N=1 by design: one blob, replaced on every real update, deleted by
// `graduate` — a snapshot that predates a baseVersion graduation would
// silently regress it, which is worse than having no snapshot at all.
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { printReport } from './report.mjs'
import { writeInstallFile } from './write-file.mjs'

export function rollbackDirFor(targetDir) {
  return join(targetDir, '.harness', 'rollback')
}

// O_NONBLOCK: a FIFO at a candidate path must not hang the snapshot (fstat rejects it below).
// O_NOCTTY: a terminal device at a candidate path must not become the controlling terminal.
// win32 defines neither and has no FIFOs or ttys, so there this is plain 'r'.
const SNAPSHOT_OPEN =
  constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0)

// What the old `existsSync(p) && statSync(p).isFile()` called present: a regular file
// reachable by name. Any stat failure is absent, exactly as existsSync swallowed it.
function isRegularFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// The blob format. 2 (1.0.4) adds `vacant` to absent entries; 1 (0.9.0 through 1.0.3) never
// carried it. Only the formats listed here are read for `vacant`: a blob that says anything
// else (1, none, or a format this CLI does not know) licenses no recursive delete through it.
const SNAPSHOT_FORMAT = 2
const VACANCY_FORMATS = new Set([2])

// Absent, and provably EMPTY: lstat (which does not follow a final symlink) found nothing at
// the path (ENOENT), or a parent that is not a directory, so nothing could be there
// (ENOTDIR). Anything else that is not a regular file (a directory, FIFO, socket, dangling
// link, or a path lstat could not inspect) stays plain `{ existed: false }`, as through 1.0.3.
function absentEntry(dest) {
  try {
    lstatSync(dest)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { existed: false, vacant: true }
  }
  return { existed: false }
}

// One open per candidate: the mode AND the bytes come from the same descriptor, so from one
// inode, instead of three separate resolutions of a name that could change in between.
function snapshotEntry(dest) {
  let fd
  try {
    // The 0o600 is inert without O_CREAT (nothing is ever created here); it only keeps this
    // read-only open from looking like a file creation with a default mode.
    fd = openSync(dest, SNAPSHOT_OPEN, 0o600)
  } catch (err) {
    // Missing, a directory we cannot open, a socket (ENXIO, or darwin's unmapped -102), win32
    // EPERM (delete-pending), ENAMETOOLONG: absent, as before. A REGULAR file we cannot open
    // (EACCES, EBUSY) still throws, as the old read did, before update's first mutation.
    if (!isRegularFile(dest)) return absentEntry(dest)
    throw err
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { existed: false }
    return { existed: true, mode: st.mode & 0o777, b64: readFileSync(fd).toString('base64') }
  } finally {
    closeSync(fd)
  }
}

// The park channels update writes outside the rendered plan: version-keyed
// obligations parked for a human. Their pre-update state (usually "absent")
// must round-trip too, or a faulted update leaves phantom instructions.
const FIXED_CANDIDATES = [
  '.harness/manifest.json',
  '.harness/pending/dependencies.json',
  '.harness/pending/source-fixes.json',
  '.harness/pending/pin-floors.json',
]

/**
 * Record the pre-update state of every path this sweep could touch. Called by
 * `update` after the plan is rendered and BEFORE the first disk mutation.
 * @param {{ targetDir: string, manifest: { files?: Record<string, unknown> },
 *           plan: Array<{ installPath: string }>, from: string, to: string }} args
 * @returns {string} the blob path
 */
export function writeRollbackSnapshot({ targetDir, manifest, plan, from, to }) {
  const candidates = new Set(FIXED_CANDIDATES)
  for (const ip of Object.keys(manifest.files ?? {})) candidates.add(ip)
  for (const e of plan) {
    candidates.add(e.installPath)
    // Drift parks land beside the plan path under .harness/pending/.
    candidates.add(`.harness/pending/${e.installPath}`)
  }

  const files = {}
  for (const ip of [...candidates].sort()) files[ip] = snapshotEntry(join(targetDir, ip))

  const blob = gzipSync(
    JSON.stringify({
      '//':
        'Written by `installer update` BEFORE its first disk mutation. `update --rollback` restores every entry byte-for-byte (files first, manifest last). `vacant: true` records that nothing at all was at a path, the one evidence besides `existed: true` that lets rollback remove a directory the update left there. Replaced on every update, deleted by `graduate` — restoring a pre-graduation tree would silently regress baseVersion.',
      v: SNAPSHOT_FORMAT,
      from,
      to,
      recordedAt: new Date().toISOString(),
      files,
    }),
  )

  const dir = rollbackDirFor(targetDir)
  rmSync(dir, { recursive: true, force: true })
  const blobPath = join(dir, `${from}-${to}.json.gz`)
  writeInstallFile(blobPath, blob)
  return blobPath
}

/**
 * One recorded path. `vacant` appears only in a `v: 2` blob, only beside `existed: false`,
 * and only when nothing at all was at the path.
 * @typedef {{ existed: boolean, vacant?: boolean, mode?: number, b64?: string }} SnapshotEntry
 */

/** @returns {{ blobPath: string, snapshot: { v?: number, from: string, to: string, recordedAt?: string, files: Record<string, SnapshotEntry> } } | null} */
export function readRollbackSnapshot(targetDir) {
  const dir = rollbackDirFor(targetDir)
  if (!existsSync(dir)) return null
  const blobs = readdirSync(dir)
    .filter((f) => f.endsWith('.json.gz'))
    .sort()
  if (blobs.length === 0) return null
  const blobPath = join(dir, blobs.at(-1))
  return { blobPath, snapshot: JSON.parse(gunzipSync(readFileSync(blobPath)).toString('utf8')) }
}

// A real directory, by lstat: a symlink to one is not, and keeps the 1.0.3 file handling.
function isRealDirectory(p) {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

// A recursive delete stays inside the install: the directory's PARENT must resolve, through
// every symlink, to the install or below it. relative() across win32 drives returns an
// absolute path with no `..` in it, hence the isAbsolute test.
function insideInstall(targetDir, dest) {
  let rel
  try {
    rel = relative(realpathSync(targetDir), realpathSync(dirname(dest)))
  } catch {
    return false
  }
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

// rmSync's recursive walk lstats each entry and unlinks a symlink instead of descending
// through it, so nothing a link inside the directory points at is touched.
function removeDirectory(targetDir, ip, dest, report) {
  if (insideInstall(targetDir, dest)) {
    rmSync(dest, { recursive: true, force: true })
    return true
  }
  report.conflicts.push({
    path: ip,
    detail:
      'a directory is here, and its parent resolves outside the install (through a symlink), so rollback removed nothing and left the path as it is. If the update created that directory, remove it by hand.',
  })
  return false
}

function restoreFile(targetDir, ip, state, report) {
  const dest = join(targetDir, ip)
  // The snapshot recorded a regular file: a directory here now is the update's (a `removed`
  // record, then writes under the path), and a staged rename onto it would fail.
  const overDirectory = isRealDirectory(dest)
  if (overDirectory && !removeDirectory(targetDir, ip, dest, report)) return
  const bytes = Buffer.from(state.b64 ?? '', 'base64')
  writeInstallFile(dest, bytes)
  // writeInstallFile derives the bit from shebang STRINGS; the snapshot
  // restores binary-safe Buffers, so re-assert the recorded mode instead.
  if (typeof state.mode === 'number') chmodSync(dest, state.mode)
  report.written.push(overDirectory ? `${ip} (restored in place of a directory)` : ip)
}

// A directory at an absent path the snapshot cannot vouch was empty: it may be the
// consumer's, so it stays and every later entry and the manifest still roll back.
function leaveDirectory(ip, recordsVacancy, report) {
  if (recordsVacancy) {
    report.notes.push(
      `${ip}: a directory is here and was left in place — when the snapshot was taken, something other than a regular file was at this path, or the path could not be inspected`,
    )
    return
  }
  report.conflicts.push({
    path: ip,
    detail:
      'a directory is here, and this snapshot cannot tell whether the update created it: a snapshot written by 1.0.3 or earlier does not record which absent paths were empty. Rollback left it in place. If the update created it, remove it by hand.',
  })
}

function clearAbsent(targetDir, ip, state, recordsVacancy, report) {
  const dest = join(targetDir, ip)
  if (!isRealDirectory(dest)) {
    if (existsSync(dest)) {
      rmSync(dest, { force: true })
      report.written.push(`${ip} (removed — did not exist before the update)`)
    }
    return
  }
  // A missing or false `vacant` never licenses the recursive delete; neither does a blob
  // format that does not record it.
  if (!(recordsVacancy && state.vacant === true)) {
    leaveDirectory(ip, recordsVacancy, report)
    return
  }
  if (removeDirectory(targetDir, ip, dest, report)) {
    report.written.push(`${ip} (directory removed — nothing was there before the update)`)
  }
}

// Files first, the manifest LAST: the manifest is the record every drift and
// tamper verdict reads, so it flips back only once the tree it describes is
// already in place — an interruption here re-runs cleanly.
function restoreOrder(files) {
  return Object.entries(files).sort(([a], [b]) => {
    if (a === '.harness/manifest.json') return 1
    if (b === '.harness/manifest.json') return -1
    return a.localeCompare(b)
  })
}

/**
 * `update --rollback`: restore the tree the last snapshot recorded.
 * @param {{ dir: string, report?: string }} opts
 * @returns {number} exit code
 */
export function rollbackUpdate(opts) {
  const targetDir = opts.dir
  const found = readRollbackSnapshot(targetDir)
  if (!found) {
    console.error(
      'no rollback snapshot recorded under .harness/rollback/ — nothing to roll back. (A snapshot is written by every real `update`; `graduate` deletes it deliberately.)',
    )
    return 1
  }
  const { snapshot } = found
  const report = {
    conflicts: [],
    drift: [],
    notes: [
      `restored the pre-update state recorded before ${snapshot.from} → ${snapshot.to}${snapshot.recordedAt ? ` (${snapshot.recordedAt})` : ''}`,
      'the snapshot is kept — a repeated rollback is a no-op; the next `update` replaces it',
    ],
    skipped: [],
    title: `harness rollback ${snapshot.to} → ${snapshot.from}`,
    written: [],
  }

  // A conflict below (a directory rollback could not account for, or one outside the
  // install) leaves that path alone and exits 2 through the report; every other entry and
  // the manifest are still restored.
  const recordsVacancy = VACANCY_FORMATS.has(snapshot.v)
  for (const [ip, state] of restoreOrder(snapshot.files)) {
    if (state.existed) restoreFile(targetDir, ip, state, report)
    else clearAbsent(targetDir, ip, state, recordsVacancy, report)
  }
  return printReport(report, { json: opts.report === 'json' })
}
