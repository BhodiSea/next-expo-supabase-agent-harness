// Cross-version upgrade machinery. template/migrations.json records, per
// released version, what `update` must do beyond refreshing owned files:
//   {
//     "0.1.3": {
//       "removed":  ["tools/old-gate.mjs"],
//       "renamed":  { "tools/old.mjs": "tools/new.mjs" },
//       "promotedModules": ["gate-perf-budget"],
//       "configSteps": [{ "name": "e2e", "cmd": "node tools/check-e2e.mjs", "after": "build" }],
//       "configCommandUpdates": [{ "name": "lint", "from": "old cmd", "to": "new cmd" }],
//       "seedOnInitOnly": ["apps/mobile/src/features/matrix/", "apps/mobile/src/routes.ts"],
//       "catalogPinFloors": [{ "name": "vitest", "minVersion": "4.1.11", "advisory": "GHSA-…", "why": "…" }]
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
// catalogPinFloors (1.1.0) are reviewed security floors for SEEDED catalog pins: `update`
// names and parks each one the consumer's pnpm-workspace.yaml does not provably meet, and
// `doctor` warns on it (exit 2). Neither ever writes the catalog.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { templateRoot, toPosix } from './copy.mjs'
import { sha256 } from './manifest.mjs'
import { writeInstallFile } from './write-file.mjs'

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

// Why a file a removed/renamed record names stays on disk, or null when it may go.
// Deletion is sha-guarded: a locally-modified file is never deleted — it is reported and
// left in place (the human resolves it; doctor keeps naming it until then).
//
// …and since 1.0.2 "matches its recorded sha" is no longer enough to delete: a consumer
// who forked the file and re-recorded it matches by construction. …and since 1.0.4 "has
// no record" is not enough either: a project can hold its own file at a path a release
// retires (a release started shipping the path over it, `enable` kept it, or a record was
// dropped), so an unrecorded file goes only when a release shipped its bytes. A record
// with no sha keeps the pre-1.0.4 reading — locally modified — so nothing kept before is
// deleted now.
/**
 * @param {{ ip: string, recorded: { sha256?: string } | undefined, current: Buffer,
 *           isFork: (ip: string, recordedSha: string, current: Buffer) => boolean,
 *           isReleased: (ip: string, current: Buffer) => boolean }} args
 * @returns {string | null}
 */
function keptBecause({ ip, recorded, current, isFork, isReleased }) {
  if (!recorded) {
    return isReleased(ip, current)
      ? null
      : `${ip} has no manifest record and no release shipped its bytes — left in place; remove it manually`
  }
  if (sha256(current) !== recorded.sha256) return `${ip} is locally modified — left in place; remove it manually`
  if (isFork(ip, recorded.sha256, current)) {
    return `${ip} matches its recorded sha, but no release shipped those bytes — a local fork, left in place; remove it manually`
  }
  return null
}

// Apply removed/renamed/promotedModules records, deleting only what keptBecause clears.
// `isFork` and `isReleased` are update's provenance predicates (lib/provenance.mjs),
// INJECTED rather than imported — provenance imports cmpVersions from this file — and
// optional: a caller without the released-sha tables keeps the sha guard alone, and an
// unrecorded file is deleted as it was before 1.0.4.
/**
 * @param {{ targetDir: string, files: Record<string, any>, modules: Set<string>, report: { notes: string[] },
 *           entries: any[], dryRun?: boolean,
 *           isFork?: (ip: string, recordedSha: string, current: Buffer) => boolean,
 *           isReleased?: (ip: string, current: Buffer) => boolean }} args
 */
export function applyFileMigrations({
  targetDir,
  files,
  modules,
  report,
  entries,
  dryRun,
  isFork = () => false,
  isReleased = () => true,
}) {
  const removeOne = (ip, label) => {
    const recorded = files[ip]
    const dest = join(targetDir, ip)
    if (!existsSync(dest)) {
      if (recorded) delete files[ip]
      return
    }
    const kept = keptBecause({ ip, recorded, current: readFileSync(dest), isFork, isReleased })
    if (kept !== null) {
      report.notes.push(`${label}: ${kept}`)
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
    writeInstallFile(cfgPath, content)
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
    writeInstallFile(cfgPath, content)
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

// Deliberately a text probe rather than a YAML parse: the installer has no YAML
// dependency (CONTRIBUTING rule 3 — zero runtime dependencies in installer/), and
// parseSimpleYaml models only the subset it was written for. "Does the catalog mention
// this key" is the obligation check's question, and a false "already met" is the only
// dangerous answer — so the probe is anchored to a catalog-entry shape rather than a bare
// substring. Hoisted out of unmetDependencyObligations in 1.0.4 so `doctor`'s toolchain
// report reads the Supabase CLI's pin through the same anchor, and read by the pin floors
// (1.1.0), for which a present key read as ABSENT is the dangerous answer: an absent key is
// not judged. So the key may carry either YAML quote, as long as both sides match — a YAML
// formatter rewrites `'@vitest/coverage-v8':` as `"@vitest/coverage-v8":`, and before 1.1.0
// that line read as no entry at all.
/**
 * The value of an indented `name:` entry in a pnpm-workspace.yaml text, with a trailing
 * comment and surrounding quotes removed ('' for a key with no value), or null when no such
 * entry exists. The key may be bare, 'single-quoted' or "double-quoted".
 * @param {string} workspaceYaml
 * @param {string} name
 * @returns {string | null}
 */
export function catalogEntry(workspaceYaml, name) {
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^\\s{2,}(['"]?)${key}\\1\\s*:(.*)$`, 'm').exec(workspaceYaml)
  if (!m) return null
  return m[2]
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
}

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
  return all.filter((o) => {
    const catalogued = catalogEntry(tree.workspaceYaml, o.name) !== null
    const declared = o.devDependency === false || Object.hasOwn(devDeps, o.name)
    return !(catalogued && declared)
  })
}

/**
 * Write (or clear) the parked obligations file. Returns the unmet list.
 * `doctor` recomputes the obligations from the tree and reds while any is unmet; it never
 * trusts this file, and nothing in the installer edits a seeded manifest.
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
    writeInstallFile(
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

// ── seededSourceFixes runtime channel (0.7.0) ─────────────────────────────────────
// THE HOLE THIS CLOSES, in template/migrations.json's own 0.6.0 words: seededSourceFixes
// "IS AN INSTRUCTION TO A HUMAN, NOT AN ACTION: nothing copies these files into a real
// install." Through 0.6.0 that was the whole story at runtime, too — the record was read
// by the runbook and by the lane's sweep, and `update`, the one command every upgrading
// consumer actually runs, never mentioned it. An install carrying the sign-in loop 0.6.0
// corrected learned about it only from a ramped auth-posture NOTE, and those NOTEs expire.
//
// Same delivery decision as dependencyObligations above, for the same reasons: the files
// are SEEDED (the never-touched boundary is what makes `update` safe on a tuned tree), so
// the channel EMITS an obligation instead of writing source, parked where `doctor` already
// looks — and the logic lives here because update.mjs's complexity-ratchet row only moves
// DOWN.
//
// WHAT IS NEW IS THE PROBES. A dependency obligation is decidable from two manifests;
// "did the consumer apply a source fix" is not decidable in general — they may have applied
// it under different names. So each fix set records the HARNESS-AUTHORED broken shape
// (`probes: [{ path, brokenWhen: { contains } | { lacks } }]`) and is judged UNAPPLIED only
// while a probe file EXISTS and still matches it. An absent file is NOT broken — the
// consumer moved the surface, and the named gate stays the authority on the actual posture.
// The record's own '//' states the honesty limit; scripts/check-seeded-migrations.mjs makes
// a probe-less or fixed-shape-matching record unauthorable.
export const SOURCE_FIX_OBLIGATIONS_PATH = '.harness/pending/source-fixes.json'

// One probe's predicate over one file's text. Exported because check-seeded-migrations
// must evaluate the SAME predicate against the template copy (a probe that matches the
// FIXED template can never self-clear) — a second implementation is how the two drift.
// A malformed predicate reads as NOT broken: the checker rejects it at authoring time, and
// a runtime guess in the broken direction would park an obligation nobody can clear.
/** @param {string} text @param {{ contains?: string, lacks?: string } | undefined} brokenWhen */
export function probeMatchesBroken(text, brokenWhen) {
  if (typeof brokenWhen?.contains === 'string' && brokenWhen.contains !== '') {
    return text.includes(brokenWhen.contains)
  }
  if (typeof brokenWhen?.lacks === 'string' && brokenWhen.lacks !== '') {
    return !text.includes(brokenWhen.lacks)
  }
  return false
}

// The reader apply/doctor share for probe evaluation. Distinct from a read-or-'' helper on
// purpose: absent must stay distinguishable from empty — an EMPTY file exists and lacks
// every symbol (broken-shaped), while a MISSING one means the consumer moved the surface
// and is not broken. '' is the wrong answer for a missing file here.
/** @param {string} targetDir */
export const treeFileReader = (targetDir) => (/** @type {string} */ rel) => {
  try {
    return readFileSync(join(targetDir, rel), 'utf8')
  } catch {
    return null
  }
}

/**
 * Fix sets introduced at or before `version` whose recorded BROKEN shape still matches the
 * tree. PURE over `readFile` so it is testable without a scaffold.
 *
 * @param {object} migrations  parsed template/migrations.json
 * @param {string} version     the harness version being installed
 * @param {(rel: string) => string | null} readFile  file text, or null when absent
 */
export function unappliedSeededSourceFixes(migrations, version, readFile) {
  const all = Object.entries(migrations)
    .filter(([v]) => VERSION_KEY.test(v) && cmpVersions(v, version) <= 0)
    .flatMap(([v, entry]) => (entry.seededSourceFixes ?? []).map((f) => ({ ...f, since: v })))

  return all.filter((fix) =>
    (fix.probes ?? []).some((probe) => {
      const text = readFile(probe.path)
      return text !== null && probeMatchesBroken(text, probe.brokenWhen)
    }),
  )
}

/**
 * Write (or clear) the parked source-fix file. Returns the unapplied list. Mirrors
 * applyDependencyObligations: EMITS, never writes a seeded file, and self-clears — a fix
 * applied by hand must stop being reported, or the channel becomes a warning nobody reads.
 * The parked artifact carries (since, gate, why, paths) and deliberately NOT the probes:
 * the TREE is re-probed on every run, and nothing may treat this file as the verdict.
 */
export function applySeededSourceFixObligations({ targetDir, report, migrations, version, dryRun }) {
  const unapplied = unappliedSeededSourceFixes(migrations, version, treeFileReader(targetDir))

  const parked = join(targetDir, SOURCE_FIX_OBLIGATIONS_PATH)
  if (unapplied.length === 0) {
    if (!dryRun && existsSync(parked)) rmSync(parked, { force: true })
    return unapplied
  }

  if (!dryRun) {
    writeInstallFile(
      parked,
      `${JSON.stringify(
        {
          '//': 'Written by `installer update`. A release CORRECTED harness-authored content inside these SEEDED files, and `update` cannot deliver the correction — the consumer owns them. This is an instruction to a human, not an action: apply each set per its release section in docs/runbooks/harness-upgrade.md, then re-run `doctor` — the file clears itself once the tree no longer matches the recorded broken shape. The named gate is the authority on the finding; this file only keeps pointing at the runbook.',
          harnessVersion: version,
          fixes: unapplied.map(({ since, gate, why, paths }) => ({ since, gate, why, paths })),
        },
        null,
        2,
      )}\n`,
    )
  }

  for (const f of unapplied) {
    report.notes.push(
      `SEEDED SOURCE FIX (${f.since} · gate ${f.gate}): ${(f.paths ?? []).length} seeded file(s) still carry the harness-authored defect ${f.since} corrected. WHY: ${f.why} \`update\` cannot write them (they are YOURS) — apply the set per docs/runbooks/harness-upgrade.md (the ${f.since} section); \`${f.gate}\` reports the finding per file. Parked at ${SOURCE_FIX_OBLIGATIONS_PATH}; it self-clears once your tree no longer matches the recorded broken shape.`,
    )
  }
  return unapplied
}

// ── catalogPinFloors (1.1.0) ──────────────────────────────────────────────────────────
// THE HOLE THIS CLOSES. 1.0.3 raised the template's vitest and @vitest/coverage-v8 pins to
// 4.1.11 for GHSA-82fw-gwwq-j7x9, and nothing delivered the raise: pnpm-workspace.yaml is
// SEEDED, so `update` never rewrites it, no gate judges the pin, and dependencyObligations
// asks only whether a key is PRESENT, which a `vitest: 4.1.10` line answers yes.
//
// WHY A KIND OF ITS OWN, not a minVersion on dependencyObligations. An unmet obligation is a
// doctor ERROR, because a gate the harness installed cannot run without it; an old pin stops
// no gate, and the upgrade lane fails every leg whose doctor exits 1. The dependency-channel
// check also rejects an obligation no owned config references (vitest.config.ts selects
// coverage by the string 'v8'), and the lane's applier inserts a new catalog line, which
// would duplicate a key that is already there. So a floor is a WARNING (exit 2), judged by
// version, and it has its own parked file.
//
// Same delivery as the two channels above: EMIT, never write a seeded manifest, and
// self-clear once the tree meets every floor. Whether a raise gets a floor is a reviewed
// decision, like a tools/framework-floor.json row; scripts/check-dependency-channel.mjs
// holds the record's shape and the template's own pin to it, so a fresh scaffold never warns.
export const PIN_FLOORS_PATH = '.harness/pending/pin-floors.json'

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/

/**
 * The plain x.y.z a catalog value pins at its LOWER bound, or null when the value does not
 * prove one: one leading `^`, `~`, `>=` or `=` is stripped, and anything but an exact
 * x.y.z is left (a dist-tag, an `npm:` alias, a URL, `workspace:`, a prerelease, a space
 * after the operator). A range is judged by its lower bound, not by what the lockfile
 * resolved, so the error is always in the safe direction: a met floor can read as unmet,
 * never the reverse.
 * @param {string} value a catalogEntry() value (comment and quotes already removed)
 * @returns {string | null}
 */
export function pinnedLowerBound(value) {
  const bare = value.replace(/^(?:\^|~|>=|=)/, '')
  return PLAIN_VERSION.test(bare) ? bare : null
}

/**
 * One floor judged against a pnpm-workspace.yaml text: `absent` when the catalog has no
 * entry for the key (not judged: the consumer moved or dropped the package, as
 * framework-floor.mjs treats an unresolved one), `met` when the entry's lower bound is at or
 * above `minVersion`, `unmet` otherwise. The anchor is catalogEntry's, the one home of it.
 * @param {string} workspaceYaml
 * @param {{ name: string, minVersion: string }} floor
 * @returns {{ verdict: 'absent' | 'met' | 'unmet', found: string | null }}
 */
export function judgePinFloor(workspaceYaml, floor) {
  const found = catalogEntry(workspaceYaml, floor.name)
  if (found === null) return { verdict: 'absent', found }
  const lower = pinnedLowerBound(found)
  const met = lower !== null && cmpVersions(lower, floor.minVersion) >= 0
  return { verdict: met ? 'met' : 'unmet', found }
}

/**
 * Floors recorded at or before `version` that the tree does not provably meet, each tagged
 * with `since` and the catalog value it `found`. PURE over its inputs.
 *
 * @param {object} migrations  parsed template/migrations.json
 * @param {string} version     the harness version being installed
 * @param {{ workspaceYaml: string }} tree  the consumer's current pnpm-workspace.yaml text
 */
export function unmetCatalogPinFloors(migrations, version, { workspaceYaml }) {
  return Object.entries(migrations)
    .filter(([v]) => VERSION_KEY.test(v) && cmpVersions(v, version) <= 0)
    .flatMap(([v, entry]) => (entry.catalogPinFloors ?? []).map((f) => ({ ...f, since: v })))
    .flatMap((f) => {
      const { verdict, found } = judgePinFloor(workspaceYaml, f)
      return verdict === 'unmet' ? [{ ...f, found }] : []
    })
}

/**
 * Write (or clear) the parked pin-floor file. Returns the unmet list. Mirrors
 * applyDependencyObligations: EMITS, never writes a seeded manifest, self-clears once every
 * floor is met, writes nothing on a dry run, and never moves update's exit code. `doctor`
 * recomputes the floors from the tree and never trusts this file.
 */
export function applyCatalogPinFloors({ targetDir, report, migrations, version, dryRun }) {
  const workspaceYaml = treeFileReader(targetDir)('pnpm-workspace.yaml') ?? ''
  const unmet = unmetCatalogPinFloors(migrations, version, { workspaceYaml })

  const parked = join(targetDir, PIN_FLOORS_PATH)
  if (unmet.length === 0) {
    if (!dryRun && existsSync(parked)) rmSync(parked, { force: true })
    return unmet
  }

  if (!dryRun) {
    writeInstallFile(
      parked,
      `${JSON.stringify(
        {
          '//': 'Written by `installer update`. A release recorded a security floor for these catalog pins, and your pnpm-workspace.yaml does not provably meet it. `update` does NOT edit pnpm-workspace.yaml or package.json: both are SEEDED, and a tree whose lockfile no longer matches its manifests fails `pnpm install --frozen-lockfile`. Raise each pin to at least its minVersion, run `pnpm install`, commit pnpm-lock.yaml, then re-run `doctor`; it clears this file once every floor is met.',
          harnessVersion: version,
          floors: unmet.map(({ since, name, found, minVersion, advisory, why }) => ({
            since,
            name,
            found,
            minVersion,
            advisory,
            why,
          })),
        },
        null,
        2,
      )}\n`,
    )
  }

  for (const f of unmet) {
    const action =
      pinnedLowerBound(f.found) === null
        ? `\`${f.name}: ${f.found}\` cannot be proven at or above ${f.minVersion}; pin at least ${f.minVersion} in the pnpm-workspace.yaml catalog`
        : `raise \`${f.name}\` from ${f.found} to at least ${f.minVersion} in the pnpm-workspace.yaml catalog`
    // The advisory id is named once: the shipped `why` strings already carry it.
    const why = f.why.includes(f.advisory) ? f.why : `${f.why} (${f.advisory})`
    report.notes.push(
      `CATALOG PIN FLOOR (${f.since}): ${action}, then \`pnpm install\` and commit pnpm-lock.yaml. WHY: ${why} (parked at ${PIN_FLOORS_PATH})`,
    )
  }
  return unmet
}
