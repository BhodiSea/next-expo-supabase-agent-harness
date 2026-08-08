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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

// migrations.json also carries a "//" doc key — and nested records carry their own.
// Exported because every reader of this file has to make the same distinction, and a
// second copy is how one of them ends up walking a prose string as if it were a record.
export const VERSION_KEY = /^\d+\.\d+\.\d+/

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
  // Injecting a step makes the chain longer than the project's OWN docs say it is, and
  // AGENTS.md is seeded — `update` must not rewrite a project's memory file, so it
  // cannot fix this itself. The `docs-sync` gate WILL red on the next validate ("says
  // The N gates but VALIDATE_STEPS has M"), and a red nobody was warned about reads as
  // the upgrade being broken. Name it here, with the count, so it arrives as an
  // instruction instead of a surprise.
  if (added.length > 0) {
    report.notes.push(
      `AGENTS.md lists the chain by NAME and COUNT and is seeded (yours) — \`update\` cannot edit it, so \`docs-sync\` will red until you add ${added.join(', ')} to its gate list and correct the count. This is the one manual step of the upgrade.`,
    )
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

// ── dependencyObligations (0.5.0) ─────────────────────────────────────────────────
// THE HOLE THIS CLOSES, in template/migrations.json's own 0.4.0 words: "eslint.config.mjs
// is harness-OWNED so `update` refreshes it, but package.json and pnpm-workspace.yaml are
// SEEDED and mergeWorkspaceYaml runs only under `init`: a new plugin dependency has NO
// channel to an existing install." A static `import 'eslint-plugin-jsx-a11y'` therefore
// resolved to nothing on every upgraded install and eslint died before linting a file —
// not one rule lost, the whole `lint` step.
//
// WHY THIS EMITS RATHER THAN WRITES. `update` could merge the pin into pnpm-workspace.yaml
// and package.json directly, and that was the first design. Three things killed it:
//   1. Those two files are in SEEDED_FILES precisely so `update` never touches them —
//      writing them is the first breach of that boundary, and the boundary is what makes
//      `update` safe to run on a tree the consumer has tuned.
//   2. It would grow installer/commands/update.mjs, already at cognitive complexity 61
//      against a limit of 15, past a ratchet scripts/complexity-ratchet.json only lets
//      move DOWN — a blocking factory gate.
//   3. It leaves a tree whose pnpm-lock.yaml no longer matches its manifests, and the
//      shipped workflows run `pnpm install --frozen-lockfile` twelve times. The update
//      that "fixed" the dependency would break every one of those runs until a human
//      reinstalled — a fix that hands you a red CI is not a fix.
// So the channel delivers an OBLIGATION: machine-readable, parked where `doctor` already
// looks, and satisfied by two commands the consumer runs deliberately.
export const DEPENDENCY_OBLIGATIONS_PATH = '.harness/pending/dependencies.json'

/**
 * Obligations introduced at or before `version`, minus the ones the tree already meets.
 * PURE over its inputs (the two manifest texts) so it is testable without a scaffold.
 *
 * @param {object} migrations       parsed template/migrations.json
 * @param {string} version          the harness version being installed
 * @param {{ workspaceYaml: string, packageJson: string }} tree  the consumer's current files
 */
export function unmetDependencyObligations(migrations, version, tree) {
  const all = Object.entries(migrations)
    .filter(([v]) => VERSION_KEY.test(v) && cmpVersions(v, version) <= 0)
    .flatMap(([v, entry]) => (entry.dependencyObligations ?? []).map((o) => ({ ...o, since: v })))

  let devDeps = {}
  try {
    devDeps = JSON.parse(tree.packageJson)?.devDependencies ?? {}
  } catch {
    // An unparseable package.json is the consumer's problem and `doctor` says so
    // elsewhere; here it simply means we cannot prove the obligation is met.
  }
  // Deliberately a text probe rather than a YAML parse: the installer has no YAML
  // dependency (CONTRIBUTING rule 3 — zero runtime dependencies in installer/), and
  // parseSimpleYaml models only the subset it was written for. "Does the catalog mention
  // this key" is the question, and a false "already met" is the only dangerous answer —
  // so the probe is anchored to a catalog-entry shape rather than a bare substring.
  const inCatalog = (name) =>
    new RegExp(`^\\s{2,}'?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?\\s*:`, 'm').test(
      tree.workspaceYaml,
    )

  return all.filter((o) => {
    const catalogued = inCatalog(o.name)
    const declared = o.devDependency === false || Object.hasOwn(devDeps, o.name)
    return !(catalogued && declared)
  })
}

/**
 * Write (or clear) the parked obligations file. Returns the unmet list.
 * `doctor` reds on this file's presence; nothing else consumes it, and nothing in the
 * installer edits a seeded manifest.
 */
export function applyDependencyObligations({ targetDir, report, migrations, version, dryRun }) {
  const read = (rel) => {
    try {
      return readFileSync(join(targetDir, rel), 'utf8')
    } catch {
      return ''
    }
  }
  const unmet = unmetDependencyObligations(migrations, version, {
    workspaceYaml: read('pnpm-workspace.yaml'),
    packageJson: read('package.json'),
  })

  const parked = join(targetDir, DEPENDENCY_OBLIGATIONS_PATH)
  if (unmet.length === 0) {
    // Self-clearing: an obligation met by hand must stop being reported, or the channel
    // becomes a permanent warning nobody reads.
    if (!dryRun && existsSync(parked)) rmSync(parked, { force: true })
    return unmet
  }

  if (!dryRun) {
    mkdirSync(dirname(parked), { recursive: true })
    writeFileSync(
      parked,
      `${JSON.stringify(
        {
          '//': 'Written by `installer update`. The harness needs these pins to exist before the gates that depend on them can run. `update` does NOT edit pnpm-workspace.yaml or package.json — both are SEEDED, and a tree whose lockfile no longer matches its manifests fails `pnpm install --frozen-lockfile`, which the shipped workflows run twelve times. Apply the entries, run `pnpm install`, commit pnpm-lock.yaml, then re-run `doctor` — it clears this file when the tree meets every obligation.',
          harnessVersion: version,
          obligations: unmet,
        },
        null,
        2,
      )}\n`,
    )
  }

  for (const o of unmet) {
    report.notes.push(
      `DEPENDENCY OBLIGATION (${o.since}): add \`${o.name}: ${o.catalog}\` to the pnpm-workspace.yaml catalog${o.devDependency === false ? '' : ` and \`"${o.name}": "catalog:"\` to root devDependencies`}, then \`pnpm install\` and commit pnpm-lock.yaml. WHY: ${o.why} — until then this install is INCOMPLETE and \`doctor\` reds. (parked at ${DEPENDENCY_OBLIGATIONS_PATH})`,
    )
  }
  return unmet
}
