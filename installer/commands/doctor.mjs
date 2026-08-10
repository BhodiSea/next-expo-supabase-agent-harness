// `doctor` — integrity + wiring check for an installed harness. Read-only;
// CI-friendly exit codes (0 clean, 1 broken, 2 drift/attention). Seeded-surface
// divergence is reported as info only — project-owned files are EXPECTED to
// evolve; the advisory exists so template improvements are discoverable.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderEntry, walkStack, walkTemplate } from '../lib/copy.mjs'
import { walkFiles } from '../lib/fs-walk.mjs'
import { RETIRED_MODULES } from '../lib/layout.mjs'
import { installerVersion, readManifest, sha256 } from '../lib/manifest.mjs'
import {
  readTemplateMigrations,
  requiredConfigSteps,
  treeFileReader,
  unappliedSeededSourceFixes,
  unmetDependencyObligations,
} from '../lib/migrations.mjs'


// One manifest record, classified. Hoisted out of `doctor` so the command stays under the
// complexity ratchet the harness enforces on every consumer — the same bar, applied to the
// tool that reports whether the bar is wired.
/**
 * @param {{ targetDir: string, ip: string, meta: Record<string, unknown>,
 *           manifest: Record<string, unknown>, errors: string[], warnings: string[] }} args
 */
function classifyManifestFile({ targetDir, ip, meta, manifest, errors, warnings }) {
  const dest = join(targetDir, ip)
  if (!existsSync(dest)) {
    ;(meta.mode === 'owned' || meta.mode === 'config' ? errors : warnings).push(
      `missing: ${ip} (${meta.mode})`,
    )
    return
  }
  // A retrofit conflict is a KNOWN divergence with a recorded sidecar, not drift: the
  // install deliberately kept the target's file. Reported as a warning (exit 2, the
  // attention code) naming both halves — never as "locally modified", which would send a
  // reader looking for an edit nobody made. check-gate-integrity is the enforcing half.
  if (meta.mode === 'conflicted') {
    warnings.push(
      `retrofit conflict unresolved: ${ip} is the TARGET's file; the harness version is parked at ${meta.sidecar ?? '(unrecorded)'}. Every gate reading this config is judging their rules, not the harness's — merge the two, or accept the divergence in tools/retrofit-accept.json with a reason.`,
    )
    return
  }
  if (meta.mode === 'seeded') return
  // Hash raw bytes (manifest hashes are computed over the written content — Buffers for
  // binary assets); decode to text only for the hook-stamp probe.
  const raw = readFileSync(dest)
  if (sha256(raw) === meta.sha256) return
  if (meta.mode === 'config') {
    warnings.push(`config tuned since install: ${ip} (expected — verify the change was human-approved)`)
    return
  }
  if (!ip.startsWith('.claude/hooks/')) {
    warnings.push(`drift on harness-owned file: ${ip} (run \`update\` to reconcile, or restore it — or an update did not complete: re-run \`update\`, or \`update --rollback\` to restore the pre-update tree)`)
    return
  }
  // Distinguish "stale hook from an older harness" from "locally modified": hooks carry a
  // HARNESS_HOOK_VERSION stamp the installer rewrites on update.
  const stamp = raw.toString('utf8').match(/HARNESS_HOOK_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
  warnings.push(
    stamp && stamp !== manifest.harnessVersion
      ? `stale hook: ${ip} carries v${stamp}, manifest is v${manifest.harnessVersion} (run \`update\`)`
      : `locally modified hook: ${ip} (restore it or run \`update\` — hooks are harness-owned)`,
  )
}

// Everything under .harness/pending/, classified. Hoisted out of `doctor` for the same
// reason classifyManifestFile was: the command is at the top of scripts/complexity-ratchet.json
// and that record may only move DOWN. Inlining this block took it 55 -> 62, which the
// ratchet caught — the harness holding itself to the bar it holds consumers to.
/**
 * @param {{ targetDir: string, errors: string[], warnings: string[], infos: string[] }} args
 */
function classifyPending({ targetDir, errors, warnings, infos }) {
  // A parked upgrade is a deferred DECISION (update/enable kept local work and parked the
  // incoming version). Keep naming them until reconciled — parked forever is how upgrades
  // silently stop reaching a project.
  const pendingRoot = join(targetDir, '.harness', 'pending')
  for (const rel of walkFiles(pendingRoot)) {
    // dependencies.json and source-fixes.json are not parked FILES awaiting a merge into a
    // same-named path — they are obligations, classified below (an ERROR and a warning
    // respectively, and the asymmetry is deliberate).
    if (rel === 'dependencies.json' || rel === 'source-fixes.json') continue
    warnings.push(
      `parked upgrade awaiting merge: .harness/pending/${rel} — reconcile it into ${rel}, then delete the parked copy`,
    )
  }

  // Unmet dependency obligations (0.5.0). An ERROR, and the distinction from the warning
  // above is the point: a parked upgrade is a decision the human has not made yet, while
  // an unmet obligation means a gate the harness just installed CANNOT RUN — eslint dying
  // before it lints a file is exactly what this channel exists to stop. Recomputed from
  // the tree rather than trusted from the parked file, so applying the pins and re-running
  // `doctor` clears it without another `update`.
  const migrations = readTemplateMigrations()
  const obligations = unmetDependencyObligations(migrations, installerVersion(), {
    workspaceYaml: readIfPresent(join(targetDir, 'pnpm-workspace.yaml')),
    packageJson: readIfPresent(join(targetDir, 'package.json')),
  })
  for (const o of obligations) {
    errors.push(
      `unmet dependency obligation (since ${o.since}): \`${o.name}: ${o.catalog}\` is not in the pnpm-workspace.yaml catalog${o.devDependency === false ? '' : ' / root devDependencies'}. WHY: ${o.why} Add it, run \`pnpm install\`, commit pnpm-lock.yaml, then re-run \`doctor\`.`,
    )
  }
  if (obligations.length === 0 && existsSync(join(pendingRoot, 'dependencies.json'))) {
    infos.push('every dependency obligation is met — removing the stale .harness/pending/dependencies.json')
    rmSync(join(pendingRoot, 'dependencies.json'), { force: true })
  }

  // Unapplied seeded source fixes (0.7.0). A WARNING, never an error, and the severity is
  // load-bearing twice over: (a) doctor's stated asymmetry — an ERROR means an installed
  // gate cannot RUN, while this is a finding the named gate itself reports per file, and
  // two reds for one act is double-billing; (b) mechanically, the upgrade lane runs
  // `doctor` BEFORE its sweep and permits only exit 0/2, so an error here would kill every
  // pre-0.6.0 baseline leg at that step. Recomputed from the TREE like the obligations
  // above — never trusted from the parked file — so applying the fix by hand and
  // re-running `doctor` clears it without another `update`.
  const fixes = unappliedSeededSourceFixes(migrations, installerVersion(), treeFileReader(targetDir))
  for (const f of fixes) {
    warnings.push(
      `unapplied seeded source fix (since ${f.since}, gate ${f.gate}): ${(f.paths ?? []).length} seeded file(s) still match the broken shape ${f.since} corrected. WHY: ${f.why} Apply the set per docs/runbooks/harness-upgrade.md (the ${f.since} section) — \`update\` cannot write seeded files, and \`${f.gate}\` reports the finding per file.`,
    )
  }
  if (fixes.length === 0 && existsSync(join(pendingRoot, 'source-fixes.json'))) {
    infos.push('every seeded source fix is applied — removing the stale .harness/pending/source-fixes.json')
    rmSync(join(pendingRoot, 'source-fixes.json'), { force: true })
  }
}

// Absent is not an error here: the obligation check treats an unreadable manifest as
// "cannot prove it is met", which is the safe direction.
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export async function doctor(opts) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  const errors = []
  const warnings = []
  const infos = []

  if (!manifest) {
    console.error('doctor: no .harness/manifest.json — run `init` first')
    return 1
  }

  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) errors.push(`node ${process.versions.node} < required 22`)

  // Manifests written by pre-0.1.3 Windows installs keyed files with
  // backslashes, which broke every prefix-based mode rule. Hard-error as a
  // migration tripwire — `update` rewrites the keys to POSIX.
  const backslashKeys = Object.keys(manifest.files ?? {}).filter((k) => k.includes('\\'))
  if (backslashKeys.length > 0) {
    errors.push(
      `manifest has ${backslashKeys.length} Windows-separator file key(s) (e.g. ${backslashKeys[0]}) — run \`update\` to migrate them to POSIX paths`,
    )
  }

  for (const [ip, meta] of Object.entries(manifest.files ?? {})) {
    classifyManifestFile({ targetDir, ip, meta, manifest, errors, warnings })
  }

  // Gate wiring.
  try {
    const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
    const v = pkg.scripts?.validate ?? pkg.scripts?.['harness:validate']
    if (!v || !v.includes('tools/validate.mjs')) errors.push('package.json validate script no longer runs tools/validate.mjs')
  } catch {
    errors.push('unreadable package.json')
  }
  try {
    const settings = JSON.parse(readFileSync(join(targetDir, '.claude/settings.json'), 'utf8'))
    const hookText = JSON.stringify(settings.hooks ?? {})
    for (const h of [
      'pretool-bash-guard',
      'pretool-write-guard',
      // 0.3.0: an `mcp__` call matched no hook at all before this one existed, so its
      // absence is not a degraded posture — it is the whole MCP surface unguarded.
      'pretool-mcp-guard',
      'posttool-source-check',
      'stop-validate-gate',
    ]) {
      if (!hookText.includes(h)) errors.push(`.claude/settings.json no longer wires ${h}`)
    }
  } catch {
    errors.push('unreadable .claude/settings.json')
  }
  try {
    const cfg = await import(pathToFileURL(join(targetDir, 'tools/harness.config.mjs')).href)
    if (!Array.isArray(cfg.VALIDATE_STEPS) || cfg.VALIDATE_STEPS.length === 0) errors.push('tools/harness.config.mjs exports no VALIDATE_STEPS')
    if (!Array.isArray(cfg.STOP_HOOK_STEPS) || cfg.STOP_HOOK_STEPS.length === 0) errors.push('tools/harness.config.mjs exports no STOP_HOOK_STEPS')
    // Every default gate introduced at or before this install's version must be present
    // locally — otherwise CI (--min-floor) runs steps the Stop hook never does, and the
    // FLOOR <-> VALIDATE_STEPS lockstep is silently broken. A step declares which array it
    // belongs to: the floor chain (VALIDATE_STEPS) or the non-floor turn-fatal chain
    // (STOP_HOOK_STEPS, where duplication / i18n / test-quality live).
    for (const step of requiredConfigSteps(readTemplateMigrations(), manifest.harnessVersion)) {
      const arrayName = step.array ?? 'VALIDATE_STEPS'
      const steps = cfg[arrayName]
      if (!Array.isArray(steps)) continue
      if (!steps.some(([name]) => name === step.name)) {
        errors.push(
          `tools/harness.config.mjs is missing the '${step.name}' gate required since v${step.since ?? manifest.harnessVersion} — add ['${step.name}', '${step.cmd}'] to ${arrayName} (or re-run \`update\`)`,
        )
      }
    }
  } catch (err) {
    errors.push(`tools/harness.config.mjs failed to import: ${err.message}`)
  }
  // AGENTS.md is canonical project memory; CLAUDE.md must stay a pure
  // `@AGENTS.md` include so the two can never diverge (CI asserts equality).
  try {
    const claudeMd = readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8').trim()
    if (claudeMd !== '@AGENTS.md') {
      warnings.push('CLAUDE.md is no longer a pure `@AGENTS.md` include — content belongs in AGENTS.md')
    }
  } catch {
    // absent files are reported via the manifest loop
  }
  for (const probe of ['AGENTS.md', '.github/CODEOWNERS']) {
    try {
      if (/\{\{[A-Z0-9_]+\}\}/.test(readFileSync(join(targetDir, probe), 'utf8')))
        warnings.push(`${probe} still contains unrendered {{placeholders}}`)
    } catch {
      // absent files are reported via the manifest loop
    }
  }

  classifyPending({ targetDir, errors, warnings, infos })

  // Commit-time layer: lefthook must actually be INSTALLED into .git/hooks —
  // a committed lefthook.yml with uninstalled hooks is a silently dormant gate.
  if (existsSync(join(targetDir, '.git')) && existsSync(join(targetDir, 'lefthook.yml'))) {
    const preCommit = join(targetDir, '.git', 'hooks', 'pre-commit')
    const installed = existsSync(preCommit) && readFileSync(preCommit, 'utf8').includes('lefthook')
    if (!installed) {
      warnings.push(
        'lefthook hooks are not installed into .git/hooks — commit-time gates are dormant; run `pnpm install` (prepare) or `pnpm exec lefthook install`',
      )
    }
  }

  // Dependency-resolution pin: the lockfile must be COMMITTED, not merely
  // present — an ignored or absent pnpm-lock.yaml is unpinned resolution and a
  // hard-failed `--frozen-lockfile` on the shipped workflows' first CI run.
  if (existsSync(join(targetDir, '.git'))) {
    if (!existsSync(join(targetDir, 'pnpm-lock.yaml'))) {
      warnings.push(
        'pnpm-lock.yaml is absent — dependency resolution is unpinned and the shipped workflows\' `pnpm install --frozen-lockfile` entry step hard-fails without it; run `pnpm install` and commit the lockfile',
      )
    } else {
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'pnpm-lock.yaml'], {
        cwd: targetDir,
        stdio: 'ignore',
      })
      if (tracked.status !== 0) {
        warnings.push(
          'pnpm-lock.yaml exists but is not committed — CI resolves a different tree than the one you reviewed; `git add pnpm-lock.yaml` and commit it',
        )
      }
    }
  }

  // Seeded-surface advisory: which project-owned files diverge from the
  // CURRENT template (info-level; never flips the exit code). A newer template
  // improving a seeded exemplar is invisible otherwise — `update` deliberately
  // never touches these; `update --refresh-seeded <path>` is the pull channel.
  try {
    // Preset-aware with a default backfill (pre-0.2.1 manifests carry no
    // DESIGN_TOKENS answer): the divergence advisory must compare a metal
    // install against metal bytes, or it would advertise a --refresh-seeded
    // that plants default content. A garbage hand-edited preset value throws
    // inside this try and degrades to no advisory — update is where it fails loud.
    const answers = manifest.answers
    const entries = [...walkTemplate('base'), ...walkStack({ DESIGN_TOKENS: 'default', ...answers })]
    for (const m of manifest.modules ?? []) {
      if (RETIRED_MODULES.has(m)) continue
      entries.push(...walkTemplate(`modules/${m}`))
    }
    const diverged = []
    for (const entry of entries) {
      const meta = manifest.files?.[entry.installPath]
      if (meta?.mode !== 'seeded') continue
      const dest = join(targetDir, entry.installPath)
      if (!existsSync(dest)) continue // missing files are reported above
      // Rendered lazily: only seeded entries pay the render cost.
      const content = renderEntry(entry, answers)
      const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content)
      if (!readFileSync(dest).equals(incoming)) diverged.push(entry.installPath)
    }
    if (diverged.length > 0) {
      infos.push(
        `${diverged.length} seeded (project-owned) file(s) differ from the current template — expected; pull a template improvement deliberately with \`update --refresh-seeded <path>\`:\n${diverged.map((p) => `          ${p}`).join('\n')}`,
      )
    }
  } catch (err) {
    // Was a bare `catch {}` until 0.3.0, which is the shape of an advisory that can
    // vanish without anyone noticing: a preset value the walker cannot resolve, a
    // template tree missing from a packaged install, a render throwing on a bad
    // placeholder — every one of them silently produced "no divergence to report",
    // which reads exactly like "your tree matches the template". Say what happened.
    warnings.push(
      `seeded-divergence advisory could not run (${err instanceof Error ? err.message : String(err)}) — this is NOT a report of "no divergence". Nothing was compared against the current template on this run.`,
    )
  }

  for (const e of errors) console.error(`  ERROR ${e}`)
  for (const w of warnings) console.warn(`  warn  ${w}`)
  for (const i of infos) console.log(`  info  ${i}`)
  if (errors.length === 0 && warnings.length === 0) console.log('doctor: CLEAN')
  return errors.length ? 1 : warnings.length ? 2 : 0
}
