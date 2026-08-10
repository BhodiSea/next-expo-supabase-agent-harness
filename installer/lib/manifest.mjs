// .harness/manifest.json — the machine record of what the harness owns.
// Hashes are computed over post-render content, so per-project placeholder
// values do not read as drift. SOURCE: docs/harness/README.md (tamper evidence)
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILES, SEEDED_FILES, SEEDED_PREFIXES } from './layout.mjs'
import { writeInstallFile } from './write-file.mjs'

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function fileMode(installPath) {
  if (CONFIG_FILES.has(installPath)) return 'config'
  if (SEEDED_FILES.has(installPath)) return 'seeded'
  if (SEEDED_PREFIXES.some((p) => installPath.startsWith(p))) return 'seeded'
  return 'owned'
}

// The recorded mode wins — an install's ownership state is its own — with ONE
// directional exception: when a release reclassifies a path the install recorded
// as `owned` into seeded/config territory, the new classification applies
// immediately. That direction only ever STOPS update from writing a file the
// consumer is now understood to own (0.7.0's action-inventory.json: generated
// from THEIR router, so the owned refresh planted a description of the template's
// router into every upgraded repo — leg E caught it as a contracts red on a tree
// nobody had touched). The reverse — seeded → owned, which would START clobbering
// a consumer file — never applies from classification alone; it would need a
// reviewed migration channel, and none exists on purpose.
export function effectiveMode(recordedMode, installPath) {
  const classified = fileMode(installPath)
  if (recordedMode === 'owned' && classified !== 'owned') return classified
  return recordedMode ?? classified
}

// Re-record a reclassified mode even though the bytes stay the consumer's — a
// manifest still calling the file `owned` would keep gate-integrity judging
// their edits as tampering with a file the harness no longer owns.
export function reRecordMode(files, installPath, recorded, mode, dryRun) {
  if (recorded && recorded.mode !== mode && !dryRun) files[installPath] = { ...recorded, mode }
}

export function manifestPath(targetDir) {
  return join(targetDir, '.harness', 'manifest.json')
}

export function readManifest(targetDir) {
  let raw
  try {
    raw = readFileSync(manifestPath(targetDir), 'utf8')
  } catch {
    return null // genuinely absent — "run `init` first" advice is correct
  }
  try {
    return JSON.parse(raw)
  } catch {
    // A CORRUPT manifest must never be advised into a re-init: init would
    // rebuild ownership records from scratch and clobber tuned files.
    throw new Error(
      '.harness/manifest.json exists but is not valid JSON — restore it from git history (do NOT re-run `init`)',
    )
  }
}

export function writeManifest(targetDir, manifest) {
  const path = manifestPath(targetDir)
  const ordered = {
    harnessVersion: manifest.harnessVersion,
    // baseVersion: the release vintage whose SEEDED starting content this tree
    // actually carries. init stamps it equal to harnessVersion; update preserves
    // it while harnessVersion advances — version-ramped gates (rampNote in
    // tools/lib/gate.mjs) compare against THIS field, and bumping it is a
    // deliberate human graduation (docs/runbooks/harness-upgrade.md), never an
    // installer side effect. Absent on pre-0.1.5 manifests (JSON.stringify
    // drops the undefined), where harnessVersion is the honest fallback.
    baseVersion: manifest.baseVersion,
    installedAt: manifest.installedAt,
    mode: manifest.mode,
    tier: manifest.tier,
    modules: [...manifest.modules].sort(),
    answers: manifest.answers,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))),
  }
  // The manifest is the update transaction's LAST write and the file every
  // drift/tamper verdict reads — the staging primitive keeps an interrupted
  // update from ever leaving it half-written.
  writeInstallFile(path, `${JSON.stringify(ordered, null, 2)}\n`)
}

export function installerVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  return pkg.version
}
