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
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { renderEntry, toPosix, walkStack, walkTemplate } from '../lib/copy.mjs'
import { RETIRED_MODULES } from '../lib/layout.mjs'
import {
  effectiveMode,
  fileMode,
  installerVersion,
  readManifest,
  reRecordMode,
  sha256,
  writeManifest,
} from '../lib/manifest.mjs'
import {
  applyConfigCommandUpdates,
  applyDependencyObligations,
  applyConfigSteps,
  applyFileMigrations,
  applySeededSourceFixObligations,
  matchSeedOnInitOnly,
  readTemplateMigrations,
  seedOnInitOnlyPatterns,
  versionsBetween,
} from '../lib/migrations.mjs'
import { classifyDrift } from '../lib/reconcile.mjs'
import { printReport } from '../lib/report.mjs'
import { injectModuleProjectReferences, pruneMissingProjectReferences } from '../lib/tsconfig-references.mjs'
import { refreshAgentsLockEntries, writeAgentsLock } from '../lib/agents-lock.mjs'
import { writeRollbackSnapshot } from '../lib/rollback.mjs'
import { writeInstallFile } from '../lib/write-file.mjs'


// A RETROFIT CONFLICT resolves when the human deletes the SIDECAR.
//
// That is the protocol check-gate-integrity's failure text prescribes ("fold the harness
// rules in, delete the sidecar, re-run update"), and it is the only signal that works: a
// real merge produces a file that is neither theirs nor ours, so byte-equality with the
// template would refuse to recognise the correct outcome. While the sidecar is still
// there the conflict stands and theirs is preserved untouched.
/**
 * @param {{ targetDir: string, ip: string, recorded: { sidecar?: string } | undefined,
 *           current: Buffer | null, report: { skipped: string[], notes: string[] } }} args
 * @returns {{ mode: string, sha256: string } | null} the new manifest entry, or null to keep the record
 */
function resolveConflict({ targetDir, ip, recorded, current, report }) {
  const sidecar = recorded?.sidecar
  report.skipped.push(ip)
  if (typeof sidecar === 'string' && !existsSync(join(targetDir, sidecar)) && current !== null) {
    report.notes.push(
      `retrofit conflict RESOLVED: ${ip} — the sidecar (${sidecar}) is gone, so the merge is recorded and this file is tracked as ${fileMode(ip)} again.`,
    )
    return { mode: fileMode(ip), sha256: sha256(current) }
  }
  report.notes.push(
    `retrofit conflict still unresolved: ${ip} (harness version parked at ${sidecar ?? '(unrecorded)'}) — every gate reading this config judges the target's rules. Merge the two and delete the sidecar, or accept the divergence in tools/retrofit-accept.json.`,
  )
  return null
}


// package.json is merged only at INIT and never rewritten by update — a consumer's
// scripts are theirs. But a newer template's script additions must not vanish silently,
// so they are surfaced as notes for a human to adopt deliberately.
/**
 * @param {{ targetDir: string, incoming: string | Buffer, report: { notes: string[] } }} args
 */
function notePackageJsonDrift({ targetDir, incoming, report }) {
  try {
    const theirs = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
    for (const [name, cmd] of Object.entries(JSON.parse(String(incoming)).scripts ?? {})) {
      const existing = theirs.scripts?.[name] ?? theirs.scripts?.[`harness:${name}`]
      if (existing === undefined) {
        report.notes.push(`new template script not installed: "${name}": ${JSON.stringify(cmd)} — add it manually`)
      } else if (existing !== cmd) {
        report.notes.push(`template script "${name}" changed upstream to ${JSON.stringify(cmd)} (yours kept)`)
      }
    }
  } catch {
    report.notes.push('could not compare package.json scripts against the template')
  }
}

// The rollback point (0.9.0): recorded AFTER the plan is rendered — so the candidate set
// is the real one — and BEFORE the first disk mutation (applyFileMigrations deletes
// first). An interrupted or failed sweep is recoverable with `update --rollback`;
// `graduate` deletes the blob so a pre-graduation tree can never be silently restored.
// The note is phrased as the sweep's CONTRACT rather than a past-tense act, and pushed
// in both modes on purpose: the dry-run parity test holds the two reports byte-for-byte
// equal, and the sentence is true in both — the real run just performed it, the dry run
// describes what the real run will do. Hoisted out of `update` for the complexity
// ratchet, the same reason as resolveConflict above.
/**
 * @param {{ targetDir: string, manifest: { harnessVersion: string, files?: Record<string, unknown> },
 *           plan: Array<{ installPath: string }>, report: { notes: string[] }, dryRun: boolean }} args
 */
function recordRollbackPoint({ targetDir, manifest, plan, report, dryRun }) {
  if (!dryRun) {
    writeRollbackSnapshot({
      targetDir,
      manifest,
      plan,
      from: manifest.harnessVersion,
      to: installerVersion(),
    })
  }
  report.notes.push(
    `a pre-update snapshot (.harness/rollback/) precedes this sweep's first write — \`update --rollback\` restores the ${manifest.harnessVersion} state if it is interrupted`,
  )
}

// Stamp hygiene (0.9.0): a gate stamp (.harness/<gate>.ok) proves "these INPUTS were
// green under the check as it existed THEN" — and the sweep may have just rewritten the
// check. Deleting every stamp means the first validate after an update re-proves every
// gate instead of riding a warm green recorded by the previous version. Only *.ok files
// directly under .harness/ are stamps; manifest.json, pending/ and rollback/ are
// update's own state and stay. Hoisted out of `update` for the complexity ratchet.
/** @param {string} targetDir @param {{ notes: string[] }} report */
function invalidateStamps(targetDir, report) {
  const stamps = readdirSync(join(targetDir, '.harness'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ok'))
    .map((e) => e.name)
    .sort()
  for (const name of stamps) unlinkSync(join(targetDir, '.harness', name))
  if (stamps.length > 0) {
    report.notes.push('stamps invalidated — first validate after an update re-proves every gate')
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export async function update(opts, { migrations = readTemplateMigrations(), writeFile = writeInstallFile } = {}) {
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

  // Pre-0.2.1 manifests carry no DESIGN_TOKENS answer: those installs ARE
  // default-preset installs by definition. Backfill so (a) walkStack resolves,
  // (b) rendering a template file that carries the {{DESIGN_TOKENS}} provenance
  // line (the design-tokens README) can never write residue via --refresh-seeded.
  manifest.answers ??= {}
  manifest.answers.DESIGN_TOKENS ??= 'default'

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
  // Preset-aware: on a metal install, --refresh-seeded must pull the METAL
  // bytes of an overlaid path, never the default ones.
  entries.push(...walkStack(answers))

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

  recordRollbackPoint({ targetDir, manifest, plan, report, dryRun: opts.dryRun })
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

  // The dependency channel (0.5.0). Runs unconditionally rather than inside the
  // `migrationEntries.length > 0` branch above, and that is deliberate: an obligation is
  // satisfied by the CONSUMER, not by this run, so it must be re-evaluated on every
  // update — including one that has no new records — or an obligation left unmet by the
  // release that raised it would stop being reported by the next one.
  //
  // It EMITS, never writes: pnpm-workspace.yaml and package.json are SEEDED, and a tree
  // whose lockfile no longer matches its manifests fails the `pnpm install
  // --frozen-lockfile` the shipped workflows run twelve times.
  applyDependencyObligations({
    targetDir,
    report,
    migrations,
    version: installerVersion(),
    dryRun: opts.dryRun,
  })

  // The seeded-source channel (0.7.0): same unconditional re-evaluation as the dependency
  // channel above (the fix is applied by the CONSUMER, not by this run), same EMIT-never-
  // write boundary — the correction lives in SEEDED files only they can edit, so this
  // parks the instruction at .harness/pending/source-fixes.json and the record's probes
  // let it self-clear once their tree stops matching the broken shape. All logic lives in
  // installer/lib/migrations.mjs: this file's complexity-ratchet row only moves DOWN.
  applySeededSourceFixObligations({
    targetDir,
    report,
    migrations,
    version: installerVersion(),
    dryRun: opts.dryRun,
  })

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
      // Merged only at init — never rewritten by update. Surface what a newer template
      // version would add or change so it isn't silently dropped.
      notePackageJsonDrift({ targetDir, incoming: entry.content, report })
      continue
    }
    const dest = join(targetDir, ip)
    const recorded = manifest.files?.[ip]
    // Ownership only ever moves TOWARD the consumer without a record — see
    // effectiveMode's header for the 0.7.0 defect (leg E) that forced this.
    const mode = effectiveMode(recorded?.mode, ip)
    const incomingSha = sha256(entry.content)

    // Raw bytes, not utf8: hashing a lossy utf8 decode of a binary asset would
    // never match the manifest sha recorded over the true file content.
    const current = existsSync(dest) ? readFileSync(dest) : null

    if (mode === 'conflicted') {
      const resolved = resolveConflict({ targetDir, ip, recorded, current, report })
      if (resolved !== null && !opts.dryRun) files[ip] = resolved
      continue
    }

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
      reRecordMode(files, ip, recorded, mode, opts.dryRun)
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
      writeFile(dest, entry.content)
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
      writeFile(dest, entry.content)
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
        writeFile(dest, entry.content)
        files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      report.notes.push(`--force overwrote locally-modified ${ip}`)
      continue
    }
    const pending = join('.harness', 'pending', ip)
    if (!opts.dryRun) writeFile(join(targetDir, pending), entry.content)
    report.drift.push({ path: ip, pending })
  }

  // ADOPT, never refresh: an install with no lock gets one written from its own current
  // files (fully-locked, zero drift, no ramp needed); an install that HAS one keeps it,
  // because rewriting it here would launder every edit made since — the exact act the
  // lock exists to make visible.
  writeAgentsLock(targetDir, report, 'adopt', { dryRun: opts.dryRun })
  // …and, for an install that ALREADY had a lock, re-record only the entries this update
  // actually rewrote. See refreshAgentsLockEntries: adopt-never-rewrite is right about a
  // CONSUMER's edits and wrong about the harness's own, and the difference is decidable —
  // update writes an owned file only when its bytes still matched the recorded sha.
  refreshAgentsLockEntries(targetDir, report.written, report, { dryRun: opts.dryRun })

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
    invalidateStamps(targetDir, report)
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
