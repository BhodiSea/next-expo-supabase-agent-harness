// Cross-version upgrade machinery. template/migrations.json records, per
// released version, what `update` must do beyond refreshing owned files:
//   {
//     "0.1.3": {
//       "removed":  ["tools/old-gate.mjs"],
//       "renamed":  { "tools/old.mjs": "tools/new.mjs" },
//       "promotedModules": ["gate-perf-budget"],
//       "configSteps": [{ "name": "e2e", "cmd": "node tools/check-e2e.mjs", "after": "build" }],
//       "configCommandUpdates": [{ "name": "lint", "from": "old cmd", "to": "new cmd" }],
//       "seedOnInitOnly": ["apps/mobile/src/features/matrix/", "apps/mobile/src/routes.ts"]
//     }
//   }
// Without this, a newer template can only ADD files to installed projects:
// removals/renames leave stale gate scripts forever, and new default gates
// reach CI (--min-floor) but never the consumer's Stop hook — silently
// breaking the FLOOR ↔ VALIDATE_STEPS lockstep on every updated install.
// seedOnInitOnly is the inverse guard: NEW seeded exemplars a newer template
// ships as init-time-only starting content, which `update` must NOT auto-plant
// into an existing install — the consumer's routes/app never reference them, so
// planting would red route-manifest + knip. They stay pullable on demand via
// `update --refresh-seeded <path>` (the documented opt-in channel).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { templateRoot, toPosix } from './copy.mjs'
import { sha256 } from './manifest.mjs'

export function readTemplateMigrations() {
  try {
    return JSON.parse(readFileSync(join(templateRoot(), 'migrations.json'), 'utf8'))
  } catch {
    return {}
  }
}

// Numeric semver compare (prerelease tags compare as plain strings after the
// numeric fields — the harness releases plain x.y.z tags).
export function cmpVersions(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if ((pa[i] ?? '') !== (pb[i] ?? '')) return (pa[i] ?? '') < (pb[i] ?? '') ? -1 : 1
      continue
    }
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

const VERSION_KEY = /^\d+\.\d+\.\d+/ // migrations.json also carries a "//" doc key

// Versions v with from < v <= to, ascending — the records update must apply.
export function versionsBetween(migrations, from, to) {
  return Object.keys(migrations)
    .filter((v) => VERSION_KEY.test(v) && cmpVersions(v, from) > 0 && cmpVersions(v, to) <= 0)
    .sort(cmpVersions)
}

// Every seedOnInitOnly pattern across ALL versions in the file — NOT just the
// pending ones. These paths are init-time exemplars forever: their semantics are
// timeless, so an 0.1.3→0.1.4→0.1.5 chain must withhold the same paths as a
// direct 0.1.3→0.1.5 hop (a consumer who skipped 0.1.4 and never opted into its
// exemplars must not have them silently auto-planted by a later update). Order-
// and dedup-preserving; POSIX-normalized at the boundary so a Windows-authored
// record still matches POSIX manifest keys.
export function seedOnInitOnlyPatterns(migrations) {
  const seen = new Set()
  const out = []
  for (const [v, entry] of Object.entries(migrations)) {
    if (!VERSION_KEY.test(v)) continue
    for (const pattern of entry.seedOnInitOnly ?? []) {
      const norm = toPosix(pattern)
      if (!seen.has(norm)) {
        seen.add(norm)
        out.push(norm)
      }
    }
  }
  return out
}

// Return the seedOnInitOnly pattern an installPath falls under, or null. A
// trailing '/' matches the whole subtree (prefix); no slash matches an exact
// file. The installPath is POSIX-normalized first, so a Windows-supplied
// backslash path (`apps\mobile\src\routes.ts`) still matches. Callers key the
// "not auto-planted" report note off the returned pattern so the note fires once
// per matched cluster, not once per file.
export function matchSeedOnInitOnly(installPath, patterns) {
  const ip = toPosix(installPath)
  for (const pattern of patterns) {
    if (pattern.endsWith('/') ? ip.startsWith(pattern) : ip === pattern) return pattern
  }
  return null
}

// A module promoted into base: drop it from the module list and clear the
// stale per-file module attribution so a later `disable` of a retired module
// cannot delete default gates (the files moved into base).
function promoteModule(mod, { files, modules, report }) {
  if (modules.has(mod)) {
    modules.delete(mod)
    report.notes.push(`module '${mod}' is now part of the default harness — removed from the module list`)
  }
  for (const meta of Object.values(files)) {
    if (meta.module === mod) delete meta.module
  }
}

// Apply removed/renamed/promotedModules records. Deletion is sha-guarded:
// a locally-modified file is never deleted — it is reported and left in place
// (the human resolves it; doctor keeps naming it until then).
export function applyFileMigrations({ targetDir, files, modules, report, entries, dryRun }) {
  const removeOne = (ip, label) => {
    const recorded = files[ip]
    const dest = join(targetDir, ip)
    if (!existsSync(dest)) {
      if (recorded) delete files[ip]
      return
    }
    const currentSha = sha256(readFileSync(dest))
    if (recorded && currentSha !== recorded.sha256) {
      report.notes.push(`${label}: ${ip} is locally modified — left in place; remove it manually`)
      return
    }
    if (!dryRun) rmSync(dest)
    delete files[ip]
    report.notes.push(`${label}: ${ip}`)
  }

  for (const entry of entries) {
    for (const ip of entry.removed ?? []) removeOne(ip, 'removed by template migration')
    for (const [oldIp, newIp] of Object.entries(entry.renamed ?? {})) {
      removeOne(oldIp, `renamed by template migration (now ${newIp})`)
    }
    for (const mod of entry.promotedModules ?? []) promoteModule(mod, { files, modules, report })
  }
}

// Inject one step into the consumer's tools/harness.config.mjs — into VALIDATE_STEPS (the
// 22-gate floor chain) or into STOP_HOOK_STEPS (`array: 'STOP_HOOK_STEPS'`), which is where
// the non-floor turn-fatal checks live. Both matter: harness.config.mjs is SEEDED (a project
// tunes it, so `update` must never overwrite it), which means a new Stop-chain step reaches
// an existing install ONLY through this injection. Without it, an upgraded consumer would get
// the new checks in CI but never at turn-end — the agent would lose the fast feedback loop
// that is the whole point of the Stop chain.
//
// The config is human-tunable, so this is line-anchored, not a rewrite: uncomment a matching
// opt-in line when present, else insert after the `after` step (or before the array close).
// Returns the new content, or null when the anchors are gone (doctor then reports the missing
// step — fail loud, never guess at a mangled config).
/** @param {string} content @param {{ name: string, cmd: string, after?: string, array?: string }} step */
export function injectConfigStep(content, { name, cmd, after, array = 'VALIDATE_STEPS' }) {
  const lines = content.split('\n')
  const declIdx = lines.findIndex((l) => l.includes(array) && l.includes('['))
  if (declIdx === -1) return null
  let closeIdx = -1
  for (let i = declIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\]/.test(lines[i])) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return null

  const body = lines.slice(declIdx + 1, closeIdx)
  const entryRe = new RegExp(`^\\s*\\['${name}'\\s*,`)
  if (body.some((l) => entryRe.test(l))) return content // already active

  const commentedRe = new RegExp(`^(\\s*)//\\s*(\\['${name}'\\s*,.*)$`)
  for (let i = declIdx + 1; i < closeIdx; i += 1) {
    const m = lines[i].match(commentedRe)
    if (m) {
      lines[i] = `${m[1]}${m[2]}`
      return lines.join('\n')
    }
  }

  const stepLine = `  ['${name}', '${cmd}'],`
  if (after) {
    const afterRe = new RegExp(`^\\s*\\['${after}'\\s*,`)
    for (let i = declIdx + 1; i < closeIdx; i += 1) {
      if (afterRe.test(lines[i])) {
        lines.splice(i + 1, 0, stepLine)
        return lines.join('\n')
      }
    }
  }
  lines.splice(closeIdx, 0, stepLine)
  return lines.join('\n')
}

// Inject every configStep for the given records; re-hash the config in the
// manifest afterwards so doctor does not read the sanctioned injection as
// unexplained drift. Failed anchors are notes + a doctor error (see
// requiredConfigSteps), never a silent skip.
export function applyConfigSteps({ targetDir, files, report, entries, dryRun }) {
  const steps = entries.flatMap((e) => e.configSteps ?? [])
  if (steps.length === 0) return
  const cfgRel = 'tools/harness.config.mjs'
  const cfgPath = join(targetDir, cfgRel)
  if (!existsSync(cfgPath)) {
    report.notes.push(`cannot add gate step(s) ${steps.map((s) => s.name).join(', ')}: ${cfgRel} is missing`)
    return
  }
  let content = readFileSync(cfgPath, 'utf8')
  const added = []
  for (const step of steps) {
    const next = injectConfigStep(content, step)
    if (next === null) {
      report.notes.push(
        `could not add gate step '${step.name}' to ${cfgRel} (${step.array ?? 'VALIDATE_STEPS'} anchor not found) — add ['${step.name}', '${step.cmd}'] manually; doctor will flag it until then`,
      )
      continue
    }
    if (next !== content) added.push(step.name)
    content = next
  }
  if (added.length > 0 && !dryRun) {
    writeFileSync(cfgPath, content)
    if (files[cfgRel]) files[cfgRel] = { ...files[cfgRel], sha256: sha256(content) }
    report.notes.push(`gate step(s) added to ${cfgRel}: ${added.join(', ')}`)
  } else if (added.length > 0) {
    report.notes.push(`gate step(s) that would be added to ${cfgRel}: ${added.join(', ')}`)
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Canonical-command evolution, from-guarded: rewrite `['name', 'from']` to
// `['name', 'to']` ONLY while the consumer's line still carries the old
// canonical command — a deliberately customized command is theirs and stays.
// Applies across the whole config (VALIDATE_STEPS and STOP_HOOK_STEPS both live
// there). Without this, a released command change (e.g. adding --report-all to
// the Stop hook's validate) would reach CI's --min-floor but never an installed
// harness, and the update-skew parity check (`--list` vs `--min-floor --list`)
// would break on every updated install.
export function updateConfigCommand(content, { name, from, to }) {
  const re = new RegExp(`(\\[\\s*'${escapeRe(name)}'\\s*,\\s*')${escapeRe(from)}('\\s*\\])`, 'g')
  return content.replace(re, `$1${to}$2`)
}

export function applyConfigCommandUpdates({ targetDir, files, report, entries, dryRun }) {
  const updates = entries.flatMap((e) => e.configCommandUpdates ?? [])
  if (updates.length === 0) return
  const cfgRel = 'tools/harness.config.mjs'
  const cfgPath = join(targetDir, cfgRel)
  if (!existsSync(cfgPath)) return
  let content = readFileSync(cfgPath, 'utf8')
  const changed = []
  for (const u of updates) {
    const next = updateConfigCommand(content, u)
    if (next !== content) changed.push(u.name)
    content = next
  }
  if (changed.length === 0) return
  if (!dryRun) {
    writeFileSync(cfgPath, content)
    if (files[cfgRel]) files[cfgRel] = { ...files[cfgRel], sha256: sha256(content) }
  }
  report.notes.push(
    `gate command(s) updated to the new canonical form in ${cfgRel}: ${changed.join(', ')}${dryRun ? ' (dry-run)' : ''}`,
  )
}

// For doctor: every configStep introduced at or before `version` must be
// present in the consumer's VALIDATE_STEPS — catches failed/skipped injection.
export function requiredConfigSteps(migrations, version) {
  return Object.entries(migrations)
    .filter(([v]) => VERSION_KEY.test(v) && cmpVersions(v, version) <= 0)
    .flatMap(([v, entry]) => (entry.configSteps ?? []).map((s) => ({ ...s, since: v })))
}
