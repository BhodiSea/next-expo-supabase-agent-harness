// `update` — pull the currently-fetched harness version into an installed
// project. Owned files upgrade when unmodified; local drift is preserved with
// the incoming version parked under .harness/pending/. Seeded files are never
// touched after init — EXCEPT on explicit request: `update --refresh-seeded
// <path>` pulls the current template version of one seeded file OR a whole
// subtree (overwrite when untouched since install, park-on-drift when locally
// modified), so template improvements to project-owned exemplars can reach
// existing installs deliberately instead of never.
// New seeded exemplars flagged seedOnInitOnly in template/migrations.json are
// the one class the plain sweep does NOT auto-plant when absent: an existing
// consumer's routes/App don't reference them, so silently planting them would
// red route-manifest + dead-code. The sweep notes them; --refresh-seeded is the
// deliberate channel to pull them in.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderEntry, toPosix, walkTemplate } from '../lib/copy.mjs'
import { RETIRED_MODULES } from '../lib/layout.mjs'
import {
  fileMode,
  installerVersion,
  readManifest,
  sha256,
  writeManifest,
} from '../lib/manifest.mjs'
import {
  applyConfigCommandUpdates,
  applyConfigSteps,
  applyFileMigrations,
  matchSeedOnInitOnly,
  readTemplateMigrations,
  seedOnInitOnlyPatterns,
  versionsBetween,
} from '../lib/migrations.mjs'
import { classifyDrift } from '../lib/reconcile.mjs'
import { printReport } from '../lib/report.mjs'
import { injectModuleProjectReferences, pruneMissingProjectReferences } from '../lib/tsconfig-references.mjs'
import { writeAgentsLock } from '../lib/agents-lock.mjs'
import { writeInstallFile } from '../lib/write-file.mjs'

// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export async function update(opts, { migrations = readTemplateMigrations() } = {}) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) {
    throw new Error('no .harness/manifest.json found — run `init` first')
  }

  // Heal manifests written by pre-0.1.3 Windows installs, which keyed files
  // with backslashes: without this, every incoming POSIX path misses its
  // recorded entry and locally-modified files lose drift protection.
  manifest.files = Object.fromEntries(
    Object.entries(manifest.files ?? {}).map(([k, v]) => [toPosix(k), v]),
  )

  const answers = manifest.answers
  const entries = [...walkTemplate('base')]
  for (const m of manifest.modules ?? []) {
    // A module retired by THIS update (promoted into base) has no template dir
    // anymore — its manifest entry is pruned by the promotedModules migration
    // below; planning it here would crash the very update that migrates it.
    if (RETIRED_MODULES.has(m)) continue
    const moduleEntries = walkTemplate(`modules/${m}`)
    for (const e of moduleEntries) e.module = m
    entries.push(...moduleEntries)
  }
  // Stack files are all seeded (project-owned after init) — but new stack
  // files introduced by a newer template version should still be offered.
  entries.push(...walkTemplate('stack'))

  // Focused mode: refresh the requested SEEDED path(s) from the current
  // template and stop — no version migrations, no owned-file sweep.
  if (opts.refreshSeeded?.length) {
    return refreshSeeded({ targetDir, manifest, entries, answers, paths: opts.refreshSeeded, opts })
  }

  const report = {
    conflicts: [],
    drift: [],
    notes: [],
    skipped: [],
    title: `harness update ${manifest.harnessVersion} → ${installerVersion()}`,
    written: [],
  }
  const files = { ...manifest.files }
  const modules = new Set(manifest.modules ?? [])

  // A newer template must never plan ZERO files — that is a packaging
  // regression (empty tarball, broken walker), and recording a version bump
  // over it would be a false-green update. Checked before anything mutates.
  if (entries.length === 0) {
    throw new Error('template plan is empty — refusing to record an update over a packaging regression')
  }
  const plan = entries.map((e) => ({ ...e, content: renderEntry(e, answers) }))
  // Same closure as init: an enabled module's workspace package must be in the root
  // solution file. `tsconfig.json` is an OWNED file, so update rewrites it from the
  // template on every run — without this the reference would be planted at init and
  // silently removed by the first `update`, redding `contracts` on a tree nobody touched.
  injectModuleProjectReferences(plan, report, 'kept')

  // Version migrations FIRST: removals/renames prune stale files before the
  // plan loop writes the current tree, and gate promotions must reach the
  // consumer's harness.config.mjs (the Stop hook), not only CI's --min-floor.
  const pendingVersions = versionsBetween(migrations, manifest.harnessVersion, installerVersion())
  const migrationEntries = pendingVersions.map((v) => migrations[v])
  if (migrationEntries.length > 0) {
    applyFileMigrations({ targetDir, files, modules, report, entries: migrationEntries, dryRun: opts.dryRun })
    applyConfigSteps({ targetDir, files, report, entries: migrationEntries, dryRun: opts.dryRun })
    applyConfigCommandUpdates({ targetDir, files, report, entries: migrationEntries, dryRun: opts.dryRun })
  }

  // Init-time-only exemplars: NEW seeded files a newer template ships as
  // starting content. Collected across ALL versions (timeless semantics), so a
  // consumer who skipped an intermediate release still has them withheld. The
  // note fires once per matched cluster — dedup by the matched pattern.
  const seededExemplars = seedOnInitOnlyPatterns(migrations)
  const notedExemplars = new Set()

  // And the mirror of the injection above: the root solution file must not NAME a project
  // this run is about to withhold. It runs here rather than beside the injection because
  // the answer depends on `seededExemplars` — plan membership is not the same question as
  // "will this file exist", and a reference to a withheld package kills `tsc -b` outright.
  pruneMissingProjectReferences(plan, targetDir, report, seededExemplars)

  for (const entry of plan) {
    const ip = entry.installPath
    if (ip === 'package.json') {
      // Merged only at init — never rewritten by update. Surface what a newer
      // template version would add or change so it isn't silently dropped.
      try {
        const incoming = JSON.parse(entry.content)
        const current = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
        for (const [name, cmd] of Object.entries(incoming.scripts ?? {})) {
          const existing = current.scripts?.[name] ?? current.scripts?.[`harness:${name}`]
          if (existing === undefined) report.notes.push(`new template script not installed: "${name}": ${JSON.stringify(cmd)} — add it manually`)
          else if (existing !== cmd) report.notes.push(`template script "${name}" changed upstream to ${JSON.stringify(cmd)} (yours kept)`)
        }
      } catch {
        report.notes.push('could not compare package.json scripts against the template')
      }
      continue
    }
    const dest = join(targetDir, ip)
    const recorded = manifest.files?.[ip]
    const mode = recorded?.mode ?? fileMode(ip)
    const incomingSha = sha256(entry.content)

    // Raw bytes, not utf8: hashing a lossy utf8 decode of a binary asset would
    // never match the manifest sha recorded over the true file content.
    const current = existsSync(dest) ? readFileSync(dest) : null

    // A NEW seeded exemplar that is ABSENT here: init-time-only starting content
    // (seedOnInitOnly). update must NOT auto-plant it — an existing consumer's
    // routes/App don't reference it, so planting reds route-manifest + dead-code.
    // Skip, and point once per cluster at the deliberate opt-in channel. Owned
    // files are never matched (only seeded/config), and an already-present file
    // falls through to the seeded-skip below untouched.
    if (current === null && mode !== 'owned') {
      const pattern = matchSeedOnInitOnly(ip, seededExemplars)
      if (pattern) {
        report.skipped.push(ip)
        if (!notedExemplars.has(pattern)) {
          notedExemplars.add(pattern)
          report.notes.push(
            `new exemplar available (not auto-planted): ${pattern} — pull with \`update --refresh-seeded ${pattern}\``,
          )
        }
        continue
      }
    }

    if (current !== null && mode !== 'owned') {
      report.skipped.push(ip)
      continue
    }
    const kind = classifyDrift({
      current,
      recordedSha: recorded?.sha256,
      incoming: entry.content,
      force: opts.force,
    })

    if (kind === 'create') {
      if (opts.dryRun) {
        report.written.push(ip)
        continue
      }
      writeInstallFile(dest, entry.content)
      files[ip] = { mode, sha256: incomingSha, ...(entry.module ? { module: entry.module } : {}) }
      report.written.push(ip)
      continue
    }
    if (kind === 'skip-same') {
      report.skipped.push(ip)
      continue
    }
    if (kind === 'update-clean') {
      if (opts.dryRun) {
        report.written.push(ip)
        continue
      }
      writeInstallFile(dest, entry.content)
      files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      report.written.push(ip)
      continue
    }
    if (kind === 'record-only') {
      if (!opts.dryRun) files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      report.skipped.push(ip)
      continue
    }
    // Local drift on an owned file: preserve it, park the incoming version —
    // unless --force deliberately overwrites.
    if (kind === 'force-overwrite') {
      if (!opts.dryRun) {
        writeInstallFile(dest, entry.content)
        files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      report.notes.push(`--force overwrote locally-modified ${ip}`)
      continue
    }
    const pending = join('.harness', 'pending', ip)
    if (!opts.dryRun) writeInstallFile(join(targetDir, pending), entry.content)
    report.drift.push({ path: ip, pending })
  }

  // ADOPT, never refresh: an install with no lock gets one written from its own current
  // files (fully-locked, zero drift, no ramp needed); an install that HAS one keeps it,
  // because rewriting it here would launder every edit made since — the exact act the
  // lock exists to make visible.
  writeAgentsLock(targetDir, report, 'adopt', { dryRun: opts.dryRun })

  if (!opts.dryRun) {
    writeManifest(targetDir, {
      ...manifest,
      files,
      modules: [...modules],
      harnessVersion: installerVersion(),
      // baseVersion records the release vintage of the SEEDED content this tree
      // still carries — update refreshes owned files but withholds new seeded
      // exemplars, so the vintage does NOT advance here. A pre-0.1.5 manifest
      // has no baseVersion: its seeded content dates from the version that
      // installed it, which is exactly its recorded harnessVersion. Graduating
      // to a newer baseVersion is a human edit (docs/runbooks/harness-upgrade.md).
      baseVersion: manifest.baseVersion ?? manifest.harnessVersion,
    })
  }
  return printReport(report, { json: opts.report === 'json' })
}

// `update --refresh-seeded <path>`: the deliberate channel for template
// improvements to SEEDED (project-owned) surfaces. Unmodified-since-install →
// overwrite + re-record; locally modified → park the template version under
// .harness/pending/ (never clobber project work); unknown path → error naming
// nearby candidates so a typo cannot silently no-op.
function refreshSeeded({ targetDir, manifest, entries, answers, paths, opts }) {
  const report = {
    conflicts: [],
    drift: [],
    notes: [],
    skipped: [],
    title: `refresh-seeded (template ${installerVersion()})`,
    written: [],
  }
  const files = { ...manifest.files }
  let failed = false

  // Refresh ONE resolved template entry into the install (overwrite when
  // untouched, park on drift). Keyed on the entry's own installPath so subtree
  // expansion below refreshes each member under its real path.
  const refreshOne = (entry) => {
    const ip = entry.installPath
    const dest = join(targetDir, ip)
    const content = renderEntry(entry, answers)
    const incomingSha = sha256(content)
    const recorded = files[ip]
    const mode = recorded?.mode ?? fileMode(ip)

    const current = existsSync(dest) ? readFileSync(dest) : null
    let kind = classifyDrift({ current, recordedSha: recorded?.sha256, incoming: content, force: opts.force })
    // Stricter than update's sweep: with no manifest record we cannot prove
    // the file untouched since install — park, never clobber project work.
    if (kind === 'update-clean' && !recorded && !opts.force) kind = 'park'

    if (kind === 'create') {
      // The deliberate opt-in for a seedOnInitOnly exemplar the plain sweep
      // withheld: an explicitly-requested absent seeded file IS planted here.
      if (!opts.dryRun) {
        writeInstallFile(dest, content)
        files[ip] = { ...(recorded ?? {}), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      return
    }
    if (kind === 'skip-same' || kind === 'record-only') {
      report.skipped.push(ip)
      report.notes.push(`${ip} already matches the current template`)
      return
    }
    // Untouched since install (or --force): safe to refresh.
    if (kind === 'update-clean' || kind === 'force-overwrite') {
      if (!opts.dryRun) {
        writeInstallFile(dest, content)
        files[ip] = { ...(recorded ?? {}), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      if (kind === 'force-overwrite') {
        report.notes.push(`--force overwrote locally-modified ${ip}`)
      }
      return
    }
    const pending = join('.harness', 'pending', ip)
    if (!opts.dryRun) writeInstallFile(join(targetDir, pending), content)
    report.drift.push({ path: ip, pending })
    report.notes.push(
      `${ip} has local changes — kept; the current template version is parked at ${pending} (merge by hand, or re-run with --force)`,
    )
  }

  for (const rawPath of paths) {
    const ip = toPosix(rawPath).replace(/^\.\//, '')
    // A subtree request (trailing '/' or a bare directory) pulls every template
    // entry under it — the channel the seedOnInitOnly note advertises, e.g.
    // `update --refresh-seeded apps/mobile/src/features/matrix/`. An exact-file
    // request still resolves to a single entry.
    const prefix = ip.endsWith('/') ? ip : `${ip}/`
    const matches = entries.filter((e) => e.installPath === ip || e.installPath.startsWith(prefix))
    if (matches.length === 0) {
      const base = ip.replace(/\/$/, '').split('/').at(-1)
      const near = entries
        .filter((e) => e.installPath.endsWith(`/${base}`) || e.installPath === base)
        .map((e) => e.installPath)
      report.notes.push(
        `no template file installs to ${ip}${near.length > 0 ? ` — did you mean: ${near.join(', ')}` : ''}`,
      )
      failed = true
      continue
    }
    for (const entry of matches.sort((a, b) => a.installPath.localeCompare(b.installPath))) {
      refreshOne(entry)
    }
  }

  if (!opts.dryRun) writeManifest(targetDir, { ...manifest, files })
  const code = printReport(report, { json: opts.report === 'json' })
  return failed ? 1 : code
}
