// `init` — bootstrap a new project or retrofit an existing one.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { planTree } from '../lib/copy.mjs'
import { detect, detectContext } from '../lib/detect.mjs'
import { CONFLICTABLE, MODULES, RETROFIT_ADDITIVE, TIERS } from '../lib/layout.mjs'
import { fileMode, installerVersion, readManifest, sha256, writeManifest } from '../lib/manifest.mjs'
import { mergeClaudeSettings } from '../lib/merge-claude-settings.mjs'
import { mergeGitignore } from '../lib/merge-gitignore.mjs'
import { mergePackageJson } from '../lib/merge-package-json.mjs'
import { mergeWorkspaceYaml } from '../lib/merge-workspace-yaml.mjs'
import { printReport } from '../lib/report.mjs'
import { injectModuleProjectReferences, pruneMissingProjectReferences } from '../lib/tsconfig-references.mjs'
import { writeAgentsLock } from '../lib/agents-lock.mjs'
import { collectAnswers, parseSets } from '../lib/prompts.mjs'
import { writeInstallFile } from '../lib/write-file.mjs'

// Plan every requested module's tree, tagging each entry with its module name.
// Fail loud, never fail open (mirror of `enable`): a tier/module list entry
// resolving to zero files would still be recorded in manifest.modules — a
// false-green "enabled" module with nothing installed (the pre-W7 oddity).
function planModules(modules, answers) {
  const out = []
  for (const m of modules) {
    const entries = planTree(`modules/${m}`, answers)
    if (entries.length === 0) {
      throw new Error(`module '${m}' resolved to zero files — installer packaging is broken`)
    }
    for (const e of entries) e.module = m
    out.push(...entries)
  }
  return out
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export async function init(opts) {
  const targetDir = opts.dir
  mkdirSync(targetDir, { recursive: true })

  // Idempotency guard: re-running init on an installed project would rebuild
  // the manifest from scratch — modules dropped, modes rewritten, and every
  // locally-tuned owned file clobbered with no drift protection. readManifest
  // throws its own restore-from-git error when the manifest is corrupt.
  const priorManifest = readManifest(targetDir)
  if (priorManifest && !opts.force) {
    console.error(
      `error: this project already has a harness (v${priorManifest.harnessVersion}) — ` +
        'run `update` to pull fixes, or `init --force` to deliberately re-render (answers/modules carry over).',
    )
    return 1
  }

  if (opts.consume) {
    // Template-repo path: consume the local checkout into a project in place.
    rmSync(join(targetDir, '.github'), { recursive: true, force: true })
  }

  // A --force re-render keeps the prior install's mode: detect() would now see
  // the previously-scaffolded tree and misclassify (a bootstrap looks like a
  // retrofit once package.json exists).
  const det = opts.consume
    ? { mode: 'bootstrap' }
    : priorManifest
      ? { mode: priorManifest.mode }
      : detect(targetDir)
  const ctx = detectContext(targetDir)
  // `init --force` on an installed project carries the prior answers forward
  // as defaults; explicit --set flags still win.
  const sets = { ...(priorManifest?.answers ?? {}), ...parseSets(opts.set) }
  const answers = await collectAnswers({ yes: opts.yes, sets, ctx })

  // An unknown --tier silently installing ZERO modules would be a false-green
  // install for someone who asked for `--tier strict`.
  if (opts.modules === undefined && !priorManifest && !(opts.tier in TIERS)) {
    throw new Error(`unknown tier: ${opts.tier} (known: ${Object.keys(TIERS).join(', ')})`)
  }
  const modules = opts.modules ?? (priorManifest ? (priorManifest.modules ?? []) : TIERS[opts.tier])
  for (const m of modules) {
    if (!MODULES.includes(m)) throw new Error(`unknown module: ${m} (known: ${MODULES.join(', ')})`)
  }

  const plan = [...planTree('base', answers), ...planTree('stack', answers)]
  // Fail loud, never fail open: an unreadable template tree must be an error,
  // not a 0-file "successful" install (Windows URL.pathname regression class).
  if (plan.length === 0) {
    throw new Error('template tree resolved to zero files — installer packaging is broken')
  }
  plan.push(...planModules(modules, answers))

  const report = { title: `harness init (${det.mode})`, written: [], skipped: [], conflicts: [], drift: [], notes: [] }
  // A module that plants a workspace package must appear in the root solution file, or
  // `contracts` reds on a scaffold that was never edited. It cannot be listed in the
  // template — a core-tier install has no such directory and `tsc -b` fails on a
  // reference to a project that does not exist — so it is derived from the plan.
  injectModuleProjectReferences(plan, report, 'added')
  pruneMissingProjectReferences(plan, targetDir, report)
  const files = {}

  // package.json first: on retrofit we merge without clobbering (a colliding "validate"
  // stays the project's; ours lands at harness:validate). The Stop hook is unaffected —
  // it invokes `node tools/validate.mjs` directly, not the package.json script name.
  const pkgEntry = plan.find((e) => e.installPath === 'package.json')
  const wsEntry = plan.find((e) => e.installPath === 'pnpm-workspace.yaml')
  const rest = plan.filter(
    (e) =>
      e.installPath !== 'package.json' &&
      e.installPath !== 'pnpm-workspace.yaml' &&
      !e.installPath.startsWith('.harness/'),
  )

  if (pkgEntry) {
    // package.json is a rendered text template, never a verbatim Buffer.
    const incoming = JSON.parse(/** @type {string} */ (pkgEntry.content))
    if (det.mode === 'retrofit') {
      const existing = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
      const { merged, report: mergeReport } = mergePackageJson(existing, incoming)
      pkgEntry.content = `${JSON.stringify(merged, null, 2)}\n`
      for (const r of mergeReport) {
        if (r.kind === 'script-conflict')
          report.conflicts.push({ name: `package.json#scripts.${r.name}`, detail: `kept yours; harness version at scripts.harness:${r.name}` })
        if (r.kind === 'dep-mismatch')
          report.notes.push(`dependency ${r.name}: project has ${r.existing}, harness tested with ${r.tested}`)
      }
    }
  }

  // pnpm-workspace.yaml is MERGED on retrofit (globs unioned, catalog pins
  // added-when-missing) because a .harness.yaml sibling would be inert — the
  // gates need our globs/pins active. Exotic YAML falls back to the sibling
  // path with a manual-merge conflict, never a clobber.
  if (wsEntry && det.mode === 'retrofit' && existsSync(join(targetDir, 'pnpm-workspace.yaml'))) {
    const existingText = readFileSync(join(targetDir, 'pnpm-workspace.yaml'), 'utf8')
    const res = mergeWorkspaceYaml(existingText, wsEntry.content)
    if (res === null) {
      const sibling = 'pnpm-workspace.harness.yaml'
      if (!opts.dryRun) writeInstallFile(join(targetDir, sibling), wsEntry.content)
      report.conflicts.push({ path: 'pnpm-workspace.yaml', detail: `could not auto-merge (exotic YAML); harness version at ${sibling} — merge manually` })
      report.written.push(sibling)
      wsEntry.content = null // handled; skip in main loop
    } else {
      wsEntry.content = res.merged
      for (const r of res.report) {
        if (r.kind === 'catalog-mismatch')
          report.notes.push(`catalog pin ${r.name}: project has ${r.existing}, harness tested with ${r.tested} (kept yours)`)
      }
    }
  }

  for (const entry of [
    ...(pkgEntry ? [pkgEntry] : []),
    ...(wsEntry && wsEntry.content !== null ? [wsEntry] : []),
    ...rest,
  ]) {
    const ip = entry.installPath
    const dest = join(targetDir, ip)
    const isStack = entry.storagePath.startsWith('stack/')

    if (det.mode === 'retrofit' && isStack && ip !== 'package.json') {
      if (!RETROFIT_ADDITIVE.has(ip)) {
        report.skipped.push(ip)
        continue
      }
      if (existsSync(dest)) {
        report.skipped.push(ip)
        continue
      }
    }

    // Retrofit non-clobber is UNIVERSAL: any existing file with different
    // content is merged (known types), parked as a .harness sibling (root
    // configs), or parked under .harness/conflicts/ — never overwritten.
    // package.json / pnpm-workspace.yaml were already content-merged above.
    // (--force re-renders skip this: the prior install owns those files.)
    if (
      det.mode === 'retrofit' &&
      !priorManifest &&
      ip !== 'package.json' &&
      ip !== 'pnpm-workspace.yaml' &&
      existsSync(dest)
    ) {
      const currentRaw = readFileSync(dest)
      const incomingRaw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content)
      if (!currentRaw.equals(incomingRaw)) {
        const current = currentRaw.toString('utf8')

        if (ip === '.gitignore') {
          const { merged, added } = mergeGitignore(current, String(entry.content))
          if (added.length > 0) {
            if (!opts.dryRun) writeInstallFile(dest, merged)
            report.written.push(ip)
            report.notes.push(`.gitignore: kept yours, appended ${added.length} harness pattern(s)`)
          } else {
            report.skipped.push(ip)
          }
          continue
        }

        if (ip === '.claude/settings.json') {
          const res = mergeClaudeSettings(current, String(entry.content))
          if (res !== null) {
            if (!opts.dryRun) writeInstallFile(dest, res.merged)
            report.written.push(ip)
            files[ip] = { mode: fileMode(ip), sha256: sha256(res.merged) }
            report.notes.push(
              '.claude/settings.json: merged — harness hooks/permissions added, your settings kept (review the diff)',
            )
            for (const r of res.report) {
              if (r.kind === 'scalar-kept') report.notes.push(`settings ${r.name}: kept yours (${String(r.existing)}); harness default is ${String(r.harness)}`)
            }
            continue
          }
          // fall through to conflict parking when unparseable
        }

        const conflictable = CONFLICTABLE.find((c) => c.installed === ip)
        if (conflictable) {
          const sibling = ip.replace(/(\.[a-z]+)$/, '.harness$1')
          if (!opts.dryRun) writeInstallFile(join(targetDir, sibling), entry.content)
          report.conflicts.push({ path: ip, detail: `existing config kept; harness version at ${sibling} — merge manually` })
          report.written.push(sibling)
          continue
        }

        // Everything else (AGENTS.md, docker-compose.yml, workflows, docs, …):
        // theirs stays byte-identical; ours parks OUTSIDE active paths — a
        // sibling inside .github/workflows/ would itself execute as a workflow.
        const parked = join('.harness', 'conflicts', ip)
        if (!opts.dryRun) writeInstallFile(join(targetDir, parked), entry.content)
        report.conflicts.push({ path: ip, detail: `existing file kept; harness version at ${parked} — merge manually` })
        continue
      }
    }

    if (opts.dryRun) {
      report.written.push(ip)
      continue
    }
    writeInstallFile(dest, entry.content)
    report.written.push(ip)
    files[ip] = { mode: fileMode(ip), sha256: sha256(entry.content) }
    if (entry.module) files[ip].module = entry.module
  }

  // The agent-surface lock is written from the files just planted, never shipped in the
  // template: two roster files carry placeholders, so a template-side lock would mismatch
  // in every scaffold on the first validate. See installer/lib/agents-lock.mjs.
  writeAgentsLock(targetDir, report, 'always', { dryRun: opts.dryRun })

  if (!opts.dryRun) {
    writeManifest(targetDir, {
      harnessVersion: installerVersion(),
      // A fresh install's seeded content IS the current release — version-ramped
      // gates (rampNote) therefore run live from day one; only updated installs
      // carry an older baseVersion until a human graduates it.
      baseVersion: installerVersion(),
      installedAt: opts.now ?? new Date().toISOString(),
      mode: det.mode,
      tier: opts.tier ?? 'standard',
      modules,
      answers,
      files,
    })
  }

  if (opts.consume) {
    for (const d of ['installer', 'template', 'scripts', 'tests', '.claude-plugin']) {
      rmSync(join(targetDir, d), { recursive: true, force: true })
    }
    report.notes.push('consumed template checkout in place — installer/template trees removed')
  }

  report.notes.push(
    'next: pnpm install && git init (if new) — then `pnpm validate` must be green before any agent turn ends',
  )
  if (det.mode === 'retrofit') {
    report.notes.push('review .harness sibling configs and merge them into your existing configs')
  }
  return printReport(report, { json: opts.report === 'json' })
}
