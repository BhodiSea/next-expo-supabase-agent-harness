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
// N=1 by design: one blob, replaced on every real update, deleted by
// `graduate` — a snapshot that predates a baseVersion graduation would
// silently regress it, which is worse than having no snapshot at all.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { printReport } from './report.mjs'
import { writeInstallFile } from './write-file.mjs'

export function rollbackDirFor(targetDir) {
  return join(targetDir, '.harness', 'rollback')
}

// The park channels update writes outside the rendered plan: version-keyed
// obligations parked for a human. Their pre-update state (usually "absent")
// must round-trip too, or a faulted update leaves phantom instructions.
const FIXED_CANDIDATES = [
  '.harness/manifest.json',
  '.harness/pending/dependencies.json',
  '.harness/pending/source-fixes.json',
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
  for (const ip of [...candidates].sort()) {
    const dest = join(targetDir, ip)
    if (existsSync(dest) && statSync(dest).isFile()) {
      files[ip] = {
        existed: true,
        mode: statSync(dest).mode & 0o777,
        b64: readFileSync(dest).toString('base64'),
      }
    } else {
      files[ip] = { existed: false }
    }
  }

  const blob = gzipSync(
    JSON.stringify({
      '//':
        'Written by `installer update` BEFORE its first disk mutation. `update --rollback` restores every entry byte-for-byte (files first, manifest last). Replaced on every update, deleted by `graduate` — restoring a pre-graduation tree would silently regress baseVersion.',
      v: 1,
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

/** @returns {{ blobPath: string, snapshot: { from: string, to: string, recordedAt?: string, files: Record<string, { existed: boolean, mode?: number, b64?: string }> } } | null} */
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

  // Files first, the manifest LAST: the manifest is the record every drift and
  // tamper verdict reads, so it flips back only once the tree it describes is
  // already in place — an interruption here re-runs cleanly.
  const entries = Object.entries(snapshot.files).sort(([a], [b]) => {
    if (a === '.harness/manifest.json') return 1
    if (b === '.harness/manifest.json') return -1
    return a.localeCompare(b)
  })
  for (const [ip, state] of entries) {
    const dest = join(targetDir, ip)
    if (state.existed) {
      const bytes = Buffer.from(state.b64 ?? '', 'base64')
      writeInstallFile(dest, bytes)
      // writeInstallFile derives the bit from shebang STRINGS; the snapshot
      // restores binary-safe Buffers, so re-assert the recorded mode instead.
      if (typeof state.mode === 'number') chmodSync(dest, state.mode)
      report.written.push(ip)
    } else if (existsSync(dest)) {
      rmSync(dest, { force: true })
      report.written.push(`${ip} (removed — did not exist before the update)`)
    }
  }
  return printReport(report, { json: opts.report === 'json' })
}
