// .harness/manifest.json — the machine record of what the harness owns.
// Hashes are computed over post-render content, so per-project placeholder
// values do not read as drift. SOURCE: docs/harness/README.md (tamper evidence)
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_FILES, SEEDED_FILES, SEEDED_PREFIXES } from './layout.mjs'

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function fileMode(installPath) {
  if (CONFIG_FILES.has(installPath)) return 'config'
  if (SEEDED_FILES.has(installPath)) return 'seeded'
  if (SEEDED_PREFIXES.some((p) => installPath.startsWith(p))) return 'seeded'
  return 'owned'
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
  mkdirSync(dirname(path), { recursive: true })
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
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`)
}

export function installerVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  return pkg.version
}
