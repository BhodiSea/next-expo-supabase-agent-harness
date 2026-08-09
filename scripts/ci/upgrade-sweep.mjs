#!/usr/bin/env node
// THE SWEEP: adopt a release's new seams in an upgraded install, the way its runbook says to.
//
// WHY THIS EXISTS. `graduate` has two branches and only one has ever been executed. Every
// upgrade-lane leg ends with it REFUSING, because an upgraded install always has ramped
// findings outstanding — that is what a ramp is for. The SUCCESS branch is the one that moves
// `baseVersion` in .harness/manifest.json and arms every ramped check at once, and through
// 0.5.0 nothing anywhere had run it. A door nobody has opened is not a door you know opens.
//
// So this performs the sweep a consumer performs, and the lane then requires graduate to
// succeed. That makes the leg a proof of TWO things at once: that graduate opens, and that
// the sweep documented in docs/runbooks/harness-upgrade.md is sufficient — a runbook whose
// steps do not actually clear the findings is worse than no runbook, and nothing else in this
// repository would notice.
//
// WHAT IS DELIBERATELY NOT DONE HERE: re-running `init`, or copying the template wholesale.
// Either would clear the findings while proving nothing about which seams a release actually
// requires, and would make this leg vacuous the moment a release added a gate it did not also
// hand the consumer a file for.
//
// THE FILE LIST IS DERIVED PER CROSSED VERSION, NOT PER RELEASE. Through 0.6.0 this adopted
// only migrations[headVersion], which happened to BE the whole sweep because no in-range
// predecessor withheld anything a swept leg must adopt. At head 0.7.0 — the expiry release,
// whose record withholds no files — the same code would sweep nothing, the done-guard below
// would fire, and leg E would die on the release whose expiries most need its proof. So the
// sweep now iterates every version the upgrade crossed (versionsBetween — the same range
// `update` applies records for) and takes each version's posture from the reviewed SWEEPS
// table, because a blind union would be WRONG in both directions the records document:
// adopting 0.4.0's withheld set replants apps/web/lib/action-outcome.ts as an orphan (the
// exact dead-code defect the 0.4.0 record names), and adopting 0.2.0's puts unapplied DDL in
// front of the scaffold's applied history. Withholding was a per-version judgement on the way
// OUT, so adoption is a per-version judgement on the way back IN.
//   usage: node scripts/ci/upgrade-sweep.mjs <installDir> <repoRoot> <baseVersion> <headVersion>
// SOURCE: docs/runbooks/harness-upgrade.md (the sweep this executes)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { templateCandidates } from '../../installer/lib/layout.mjs'
import { versionsBetween } from '../../installer/lib/migrations.mjs'

// ── the reviewed per-version sweep table ─────────────────────────────────────────
// One entry per shipped version, answering one question: when a swept leg crosses this
// version, what must the consumer's hand adopt beyond the derived seededSourceFixes? An
// EMPTY entry is a DECISION, not an omission — computeSweepSet fails closed on any crossed
// version that withholds files (seedOnInitOnly or seededSourceFixes) and has no entry here,
// so a future release cannot silently skip the review that decides its sweep posture.
const SWEEPS = {
  // 0.2.0 withholds 32 paths and a swept leg must adopt NONE of them, per the record's own
  // classification: the DDL would sit unapplied in front of the scaffold's applied history
  // (check-migrations reads that as history out of order), the reviewed data names THIS
  // template's tables, and the generated artifacts (database.types.ts, query-shapes.json)
  // describe a database the scaffold does not have. The tenancy-adoption runbook is the
  // sanctioned path in, and the db-scale lane keys on baseVersion precisely so withholding
  // cannot switch its probe off.
  '0.2.0': {},
  // 0.2.1 withholds the design-system-native generator contract. Not adopted: the committed
  // tailwind-preset.cjs is rendered from the (seeded) token source, no ramp deadline requires
  // the files, and `update --refresh-seeded packages/design-system-native/` is the documented
  // opt-in.
  '0.2.1': {},
  // 0.3.0 withholds no files — its record is configSteps only, and its two tolerated-absent
  // acceptance files are created by review, never adopted.
  '0.3.0': {},
  // 0.4.0 withholds nine paths and a swept leg must adopt NONE of them: adopting
  // apps/web/lib/action-outcome.ts replants the orphan the record itself documents (its only
  // callers are the consumer's Server Actions, which no sweep may rewrite — RED dead-code,
  // the exact defect the upgrade lane exists to find), and the seed suites are a documented
  // `--refresh-seeded` pull, not an expiry remedy. 0.4.0's expiring seams are cleared by the
  // lane's dependency-obligation step (the jsx-a11y pin wiring reds on) or are Stop-side
  // (diff-coverage).
  '0.4.0': {},
  // 0.5.0 withholds no files — its record is dependencyObligations only, and the lane's
  // obligation step applies the pin before validate ever runs.
  '0.5.0': {},
  // 0.6.0 — the one shipped version whose sweep is real, verbatim from the runbook's 0.6.0
  // section: every withheld seam, plus the two steps a file list cannot carry.
  '0.6.0': {
    // Every seam the release withheld (its seedOnInitOnly set) — the same data that
    // withholds them names the sweep.
    adoptSeedOnInitOnly: true,
    // The page body that RENDERS what the adopted page.meta.ts declares. On a fresh
    // scaffold both ship together; on an upgrade only the meta file is delivered — the page
    // body is seeded (0.2.0) and belongs to the consumer — so adopting the seam without
    // touching the page leaves a finding the seam itself created. Copying HEAD's page
    // MODELS that edit, and is only honest because the lane's install is a pristine
    // scaffold with zero local drift; a real consumer edits their own page, which is why
    // this is an explicit list rather than a glob over app/.
    extraAdopt: ['apps/web/app/(protected)/o/page.tsx'],
    // The auth posture, renamed in place: the CLI RENAMED the section and warns rather
    // than erroring, which is how a deprecated section sat in the shipped config with
    // nothing reading the warning. The rename models the CLI deprecation that 0.6.0's
    // auth-posture ramp names, so it is 0.6.0's step.
    tomlSectionRenames: [['[inbucket]', '[local_smtp]']],
  },
  // 0.7.0 — the graduation release ships the DSR export surface and the toolchain pin, and
  // its sweep must adopt what it withholds: the three seedOnInitOnly files (the export
  // procedure, its colocated proof, the notes-export index) because the swept install's
  // refreshed data-flow.json says {kind: "procedure"} and check-data-flow requires the named
  // procedure file to EXIST — adopting the surface and refreshing the review file are one
  // move or neither. The two seededSourceFixes (the eas.json -xcode- pin, the data-flow.json
  // surface flip) need no entry here — the derived §1c pass adopts every correction the
  // record names, for every crossed version, unconditionally.
  '0.7.0': {
    adoptSeedOnInitOnly: true,
  },
  // 0.8.0 — the containment release withholds NOTHING: the observability gate and its lib
  // are owned (update plants them), the sink register is a DELIBERATE_PLANT (update plants
  // it too, per scripts/check-seeded-migrations.mjs), and there are no seededSourceFixes.
  // The empty object is the reviewed decision that the sweep set for this hop is empty —
  // computeSweepSet fails closed on ABSENCE, never on emptiness — and the injected 34th
  // step is covered by the sweep's own §3 AGENTS.md rewrite, which derives the gate list
  // from the install's post-injection chain rather than from any adopted file.
  '0.8.0': {},
}

/**
 * The sweep set for one upgrade hop: every install-relative path to adopt and every
 * config.toml section rename, in the order the versions were crossed. Per version:
 * seedOnInitOnly adoption and the extra steps come from the reviewed SWEEPS entry, while
 * seededSourceFixes stay FULLY DERIVED — a correction to harness-authored source is
 * unconditional on every hop that crosses it (the entry is the review record; it cannot
 * veto the fix). PURE over its inputs so tests drive it without a scaffold. Throws
 * (fail-closed) when a crossed version withholds files without a SWEEPS entry.
 *
 * @param {object} migrations   parsed template/migrations.json
 * @param {string} baseVersion  the scaffold's vintage (manifest baseVersion)
 * @param {string} headVersion  the version the install was upgraded to
 */
export function computeSweepSet(migrations, baseVersion, headVersion) {
  const adopt = []
  const tomlSectionRenames = []
  for (const v of versionsBetween(migrations, baseVersion, headVersion)) {
    const record = migrations[v]
    const sweep = SWEEPS[v]
    const withholds = (record.seedOnInitOnly ?? []).length > 0 || (record.seededSourceFixes ?? []).length > 0
    if (sweep === undefined && withholds) {
      throw new Error(
        `upgrade-sweep: version ${v} withholds files (seedOnInitOnly/seededSourceFixes) but has NO entry in the SWEEPS table — every crossed version's sweep posture must be a reviewed decision, even an empty one. Add '${v}' to SWEEPS in scripts/ci/upgrade-sweep.mjs with a written reason.`,
      )
    }
    if (sweep?.adoptSeedOnInitOnly === true) adopt.push(...(record.seedOnInitOnly ?? []))
    adopt.push(...(sweep?.extraAdopt ?? []))
    for (const fix of record.seededSourceFixes ?? []) adopt.push(...(fix.paths ?? []))
    tomlSectionRenames.push(...(sweep?.tomlSectionRenames ?? []))
  }
  return { adopt, tomlSectionRenames }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [installDir, repoRoot, baseVersion, headVersion] = process.argv.slice(2)
  if (installDir === undefined || repoRoot === undefined || baseVersion === undefined || headVersion === undefined) {
    process.stderr.write('usage: upgrade-sweep.mjs <installDir> <repoRoot> <baseVersion> <headVersion>\n')
    process.exit(2)
  }

  const done = []
  const TEMPLATE_ROOTS = ['template/stack', 'template/base']

  /**
   * Where in the template a given install-relative path lives, or null —
   * RENAMES-aware, because dotless storage ships '.gitignore' as 'gitignore'
   * and a direct join reads the whole entry as "the template does not ship it".
   */
  const sourceOf = (rel) => {
    for (const root of TEMPLATE_ROOTS) {
      for (const cand of templateCandidates(rel)) {
        const p = join(repoRoot, root, cand)
        if (existsSync(p)) return p
      }
    }
    return null
  }

  /** Copy one file, or every file under it when the pattern names a directory. */
  const adoptOne = (rel) => {
    const src = sourceOf(rel)
    if (src === null) return
    const isDir = rel.endsWith('/')
    if (!isDir) {
      const dest = join(installDir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      done.push(rel)
      return
    }
    const walk = (dir, prefix) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`)
        else adoptOne(`${prefix}${e.name}`)
      }
    }
    walk(src, rel)
  }

  const migrations = JSON.parse(readFileSync(join(repoRoot, 'template/migrations.json'), 'utf8'))
  let sweepSet
  try {
    sweepSet = computeSweepSet(migrations, baseVersion, headVersion)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }

  // ── 1. every seam the crossed versions oblige ────────────────────────────────────
  for (const rel of sweepSet.adopt) adoptOne(rel)

  // ── 2. section renames in place ──────────────────────────────────────────────────
  // NOT a copy of the template's config.toml: that file carries rendered placeholders, and
  // overwriting a consumer's Supabase configuration to satisfy a section-name check would be
  // a far larger act than the finding calls for. Renaming in place is the sweep, and it is
  // what the runbook tells a human to do.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const configPath = join(installDir, 'supabase/config.toml')
  if (existsSync(configPath)) {
    for (const [from, to] of sweepSet.tomlSectionRenames) {
      const before = readFileSync(configPath, 'utf8')
      const after = before.replace(new RegExp(`^${escapeRe(from)}$`, 'm'), to)
      if (after !== before) {
        writeFileSync(configPath, after)
        done.push(`supabase/config.toml (${from} → ${to})`)
      }
    }
  }

  // ── 3. AGENTS.md's gate list, from the install's OWN chain ───────────────────────
  // AGENTS.md is seeded and carries per-project rendering, so it is rewritten rather than
  // copied. The gate's own failure text prescribes exactly this — "paste the N names above
  // into AGENTS.md's gate-list sentence and the N-step chain line" — so executing it here is
  // what proves that instruction is sufficient rather than merely plausible. Version-agnostic
  // by design: it reads the install's own VALIDATE_STEPS, whatever the hop injected.
  const agentsPath = join(installDir, 'AGENTS.md')
  const configUrl = pathToFileURL(join(installDir, 'tools/harness.config.mjs')).href
  const { VALIDATE_STEPS } = await import(configUrl)
  const names = VALIDATE_STEPS.map(([n]) => n)
  if (existsSync(agentsPath)) {
    const before = readFileSync(agentsPath, 'utf8')
    const after = before
      .replace(/The \d+ gates, in order:[\s\S]*?\n {2}\(docs\/harness\/gates-catalog\.md/, () => {
        const wrapped = names.map((n) => `\`${n}\``).join(', ')
        return `The ${String(names.length)} gates, in order: ${wrapped}\n${'  '}(docs/harness/gates-catalog.md`
      })
      .replace(/the \d+-step chain/g, `the ${String(names.length)}-step chain`)
      .replace(/The \d+ gates,/, `The ${String(names.length)} gates,`)
    if (after !== before) {
      writeFileSync(agentsPath, after)
      done.push(`AGENTS.md (gate list + counts → ${String(names.length)})`)
    }
  }

  if (done.length === 0) {
    process.stderr.write(
      'upgrade-sweep: nothing to adopt. Either no version this hop crossed withheld a seam or changed a posture, or the sweep no longer matches what the ramps report — and a sweep that clears nothing cannot prove graduate opens.\n',
    )
    process.exit(1)
  }
  process.stdout.write(`upgrade-sweep: adopted ${String(done.length)} item(s)\n`)
  for (const d of done) process.stdout.write(`  ${d}\n`)
}
