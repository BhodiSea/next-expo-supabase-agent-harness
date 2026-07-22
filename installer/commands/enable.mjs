// `enable <module>` / `disable <module>` — flip an opt-in module's files.
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { planTree } from '../lib/copy.mjs'
import { MODULES, RETIRED_MODULES } from '../lib/layout.mjs'
import { fileMode, readManifest, sha256, writeManifest } from '../lib/manifest.mjs'
import { writeInstallFile } from '../lib/write-file.mjs'

// Modules whose gate ships dormant until a config line is activated (none today —
// the styleguide/perf-budget gates were promoted to defaults in 0.1.3; the pattern
// stays for future gate modules).
const GATE_MODULES_NEEDING_CONFIG = new Map([])

// After a module's files are removed, its now-empty directory skeleton
// (docs/modules/<name>/…, apps/mobile/src/crash/, …) is git-invisible litter.
// Prune each removed file's parent chain upward, stopping at the first
// non-empty directory or the scaffold root. Only truly empty directories are
// removed, so drift-kept files and neighbours are never touched.
function pruneEmptyDirs(targetDir, removedPaths, dryRun) {
  if (dryRun) return
  const root = resolve(targetDir)
  for (const ip of removedPaths) {
    let dir = resolve(targetDir, dirname(ip))
    while (dir !== root && dir.startsWith(root) && existsSync(dir) && readdirSync(dir).length === 0) {
      rmdirSync(dir)
      dir = dirname(dir)
    }
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export async function enable(opts, moduleName, on) {
  if (RETIRED_MODULES.has(moduleName)) {
    throw new Error(`module '${moduleName}' was ${RETIRED_MODULES.get(moduleName)}`)
  }
  if (!MODULES.includes(moduleName)) {
    throw new Error(`unknown module: ${moduleName} (known: ${MODULES.join(', ')})`)
  }
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) throw new Error('no .harness/manifest.json — run `init` first')

  const modules = new Set(manifest.modules ?? [])
  const files = { ...manifest.files }

  if (on) {
    const plan = planTree(`modules/${moduleName}`, manifest.answers)
    // Fail loud, never fail open: a module resolving to zero files is a
    // packaging regression, and "enabled" with nothing installed would be a
    // false-green manifest entry.
    if (plan.length === 0) {
      throw new Error(`module '${moduleName}' resolved to zero files — installer packaging is broken`)
    }
    for (const entry of plan) {
      const dest = join(targetDir, entry.installPath)
      // Never clobber local changes: if the file exists with different content
      // that also differs from what we recorded, park ours like `update` does.
      if (existsSync(dest)) {
        const currentRaw = readFileSync(dest)
        const incomingRaw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content)
        const recorded = files[entry.installPath]
        if (!currentRaw.equals(incomingRaw) && (!recorded || sha256(currentRaw) !== recorded.sha256)) {
          const pending = join('.harness', 'pending', entry.installPath)
          if (!opts.dryRun) writeInstallFile(join(targetDir, pending), entry.content)
          console.warn(`  DRIFT ${entry.installPath}: local file kept; module version parked at ${pending}`)
          continue
        }
      }
      if (!opts.dryRun) writeInstallFile(dest, entry.content)
      files[entry.installPath] = { mode: fileMode(entry.installPath), sha256: sha256(entry.content), module: moduleName }
      console.log(`  + ${entry.installPath}${opts.dryRun ? ' (dry-run)' : ''}`)
    }
    modules.add(moduleName)
    const hint = GATE_MODULES_NEEDING_CONFIG.get(moduleName)
    if (hint) console.log(`\nTo activate the gate: ${hint} (harness-protected — a human sets HARNESS_ALLOW_SELF_EDIT=1 or edits outside an agent session).`)
  } else {
    const removed = []
    for (const [ip, meta] of Object.entries(files)) {
      if (meta.module !== moduleName) continue
      const dest = join(targetDir, ip)
      if (existsSync(dest)) {
        // Raw bytes: a utf8-lossy decode would never hash-match binary assets,
        // misreading every icon/font as "locally modified".
        const current = sha256(readFileSync(dest))
        if (current !== meta.sha256) {
          console.warn(`  kept locally-modified ${ip} (remove manually if intended)`)
          delete files[ip]
          continue
        }
        if (!opts.dryRun) {
          rmSync(dest)
          removed.push(ip)
        }
      }
      delete files[ip]
      console.log(`  - ${ip}${opts.dryRun ? ' (dry-run)' : ''}`)
    }
    pruneEmptyDirs(targetDir, removed, opts.dryRun)
    modules.delete(moduleName)
  }

  if (!opts.dryRun) {
    writeManifest(targetDir, { ...manifest, modules: [...modules], files })
  }
  return 0
}
