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
/**
 * The reviewed `[auth.mfa]` block a swept install appends to its own supabase/config.toml.
 *
 * A LITERAL HERE, and the two alternatives are both worse. Copying the template's
 * config.toml wholesale is the act §2 below already refuses by name; parsing the block out
 * of that file would make the sweep depend on locating a section inside a heavily commented
 * file of rendered placeholders. These are the ten keys, in the four sections,
 * tools/auth-posture.json reviews by value — and tests/gates/upgrade-sweep.test.mjs holds
 * this literal to that register in both directions, so the copy cannot drift into a posture
 * of its own.
 */
export const AUTH_MFA_BLOCK = `
[auth.mfa]
max_enrolled_factors = 10

[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true

[auth.mfa.phone]
enroll_enabled = false
verify_enabled = false
otp_length = 6
template = "Your code is {{ .Code }}"
max_frequency = "5s"

[auth.mfa.web_authn]
enroll_enabled = false
verify_enabled = false
`

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
  // 0.9.0 — reviewed-EMPTY: the safe-passage release withholds nothing, and its EXPIRIES
  // (the two 0.8.0-opened ramps falling due) need no sweep rows of their own because the
  // 0.8.0 entry above already describes what clears both — the docs-sync gate-list paste
  // is the sweep's own §3 AGENTS.md rewrite (derived from the install's chain, so it is
  // version-agnostic and already runs on every hop), and observability's gate, lib and
  // sink register are OWNED/planted, refreshed by `update` itself. The census move
  // (auth-posture's re-defer to 0.10.0) is harness-side: auth-posture.json is an OWNED,
  // sha-pinned file that `update` refreshes, so no consumer hand touches it. The 0.9.0
  // ramp pair (version-sync's lockfile floor, wiring's lefthook floor) opens quiet on any
  // install that has run `pnpm install` — nothing for a sweep to adopt there either.
  '0.9.0': {},
  // 0.9.5: reviewed-EMPTY of FILE ADOPTIONS, but not because the release asks nothing
  // of an upgraded install. It withholds only the e2ee module's package, which arrives
  // through `enable e2ee` — a deliberate consumer act, never an upgrade step — and the
  // env-register discharge corrected two seeded files that the migrations "//" narrative
  // records as explicitly NOT a seededSourceFixes case (an install that never applies it
  // keeps a working limiter and skew guard).
  //
  // The one thing a swept install MUST adopt is a prose edit, not a file: AGENTS.md is
  // seeded, docs-sync now holds its "Keep under ~N lines" sentence to the truth, and
  // every pre-0.9.5 install carries a number that its own grown file already exceeds.
  // That is covered by the sweep's own §3 AGENTS.md rewrite — derived from the install's
  // file, like the gate list beside it — which is why this entry needs no extraAdopt and
  // why it is NOT vacuous: leg E's graduate SUCCESS depends on that rewrite clearing the
  // NOTE, so the §3 code is this version's sweep.
  '0.9.5': {},
  // 0.9.9 — reviewed NOT to adopt its seedOnInitOnly set, and that is the whole decision.
  // The evidence release withholds two files, the MFA migration and its pgTAP proof, and
  // the record states why they are withheld: the migration creates a RESTRICTIVE policy on
  // `public.notes`, so an install that renamed or dropped that table takes a `db push`
  // failure from a file it never asked for. That reasoning does not stop applying because
  // a script is doing the copying instead of a human — the lane's scaffold happens to keep
  // public.notes, and adopting on that basis would make this leg prove the sweep is safe
  // for trees it is NOT safe for. The runbook's own instruction is to read the migration
  // and apply it deliberately, which is not a step a sweep can perform.
  //
  // WHAT THE SWEEP MUST STILL CLEAR IS THE OTHER RAMP, and it is the FIRST seededSourceFixes
  // path in this lineage that cannot be adopted by copying. `update` plants
  // tools/auth-posture.json (harness-owned) with ten new [auth.mfa] keys while
  // supabase/config.toml is SEEDED, so the keys are demanded and the section is not written
  // — the ambush the record's entry exists for. The derived pass would resolve that path
  // against template/stack/supabase/config.toml and copy it, which would replace the
  // consumer's project id, ports and every value the installer rendered with the template's
  // unrendered placeholders. That is a far larger act than the finding calls for, and it is
  // the same act §2 below already refuses by name for the section rename. So the path is
  // WITHDRAWN from the copy pass (`skipDerivedAdopt`, held to the record's own paths so a
  // stale exemption cannot silently retire a real fix) and the narrowest edit is made
  // instead: append the reviewed block, and only when the file lacks it.
  '0.9.9': {
    skipDerivedAdopt: ['supabase/config.toml'],
    tomlSectionAppends: [['[auth.mfa]', AUTH_MFA_BLOCK]],
  },
  // 0.10.0 — REVIEWED EMPTY, and the emptiness is the finding rather than a gap in the
  // review. The release withholds NOTHING: its only two new files (tools/check-sbom.mjs and
  // tools/lib/sbom.mjs) are harness-OWNED, so `update` delivers them and there is no
  // seedOnInitOnly set for `adoptSeedOnInitOnly` to adopt. Its six seeded corrections are
  // seededSourceFixes, which this module applies as DERIVED on every hop that crosses the
  // version — an entry here could only veto them, and a review record must not be able to
  // veto a fix.
  //
  // The SEVENTH seeded surface this release touches needs no entry either, and it is worth
  // saying why rather than leaving the asymmetry unexplained: AGENTS.md's Stop-chain
  // sentence is rewritten in §3 below, not adopted here, because the file carries
  // per-project rendering and a consumer's project memory must never be overwritten by a
  // sweep. Leg E is what established that the rewrite was missing — it was the single NOTE
  // the documented sweep could not clear.
  //
  // NO tomlSectionAppends, and that is worth saying out loud because 0.9.9 needed one and
  // this release has the larger expiry wave: 0.10.0's auth-posture failure is the EXPIRY of
  // the ramp over the [auth.mfa] keys 0.9.9 already appends, not a demand for a new section.
  // A swept leg that crossed 0.9.9 already has the block; adding a second append here would
  // write it twice.
  //
  // The entry exists at all because computeSweepSet() THROWS fail-closed on a crossed
  // version with no entry — an unreviewed hop must never sweep silently — so "nothing to do"
  // has to be said rather than left out.
  '0.10.0': {},
  // 0.11.0 withholds the web erase surface (seedOnInitOnly) and the tools/eol.json re-date
  // (seededSourceFixes, which the derived pass adopts unconditionally — the entry is the
  // review record, it cannot veto the fix). The sweep is REAL, and for the 0.6.0 reason
  // rather than a new one: the data-flow erase ramp NOTEs for as long as the surface is
  // missing, and §7d of the lane requires that NO ramp NOTE survive the documented sweep.
  // A `{}` posture here would model a runbook that does not clear what this release ramped
  // — which is exactly the claim §7d exists to refuse.
  //
  // extraAdopt carries the two files the withheld set cannot name. The button lives under
  // apps/web/app/(protected)/, a seedOnInitOnly subtree since 0.2.0, so 0.11.0's own list
  // does not repeat it. The LAYOUT that renders it has to travel with it: adopting a
  // component nothing imports is a dead-code red, the same trap 0.6.0's page-body entry
  // documents, and it is the trap 0.11.0's own seedOnInitOnlyWhy names as the reason the
  // three files travel together or not at all. Honest only because this lane's install is a
  // pristine scaffold with zero local drift — a real consumer edits their own layout, which
  // is why the runbook's 0.11.0 section describes that edit instead of promising a copy.
  '0.11.0': {
    adoptSeedOnInitOnly: true,
    extraAdopt: [
      'apps/web/app/(protected)/delete-account-button.tsx',
      'apps/web/app/(protected)/layout.tsx',
    ],
  },
}

/**
 * The sweep set for one upgrade hop: every install-relative path to adopt, every
 * config.toml section rename, and every reviewed section append, in the order the versions
 * were crossed. Per version: seedOnInitOnly adoption and the extra steps come from the
 * reviewed SWEEPS entry, while seededSourceFixes stay DERIVED — a correction to
 * harness-authored source is unconditional on every hop that crosses it (the entry is the
 * review record; it cannot veto the fix).
 *
 * ONE NARROW EXEMPTION, added at 0.9.9 and deliberately not a general escape.
 * `skipDerivedAdopt` withdraws a path from the copy pass, for the case a copy is the wrong
 * remedy rather than the case a maintainer would rather not make one: supabase/config.toml
 * carries per-project rendering, so adopting the template's copy would overwrite the
 * install's own configuration. It is held to the record's own seededSourceFixes paths, so
 * an exemption that outlives its fix throws instead of quietly cancelling a real
 * correction — the same fail-closed posture as the missing-entry check below.
 *
 * PURE over its inputs so tests drive it without a scaffold. Throws (fail-closed) when a
 * crossed version withholds files without a SWEEPS entry.
 *
 * @param {object} migrations   parsed template/migrations.json
 * @param {string} baseVersion  the scaffold's vintage (manifest baseVersion)
 * @param {string} headVersion  the version the install was upgraded to
 */
export function computeSweepSet(migrations, baseVersion, headVersion) {
  const adopt = []
  const tomlSectionRenames = []
  /** @type {[string, string][]} */
  const tomlSectionAppends = []
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
    const fixPaths = (record.seededSourceFixes ?? []).flatMap((/** @type {any} */ f) => f.paths ?? [])
    for (const skipped of sweep?.skipDerivedAdopt ?? []) {
      if (!fixPaths.includes(skipped)) {
        throw new Error(
          `upgrade-sweep: version ${v}'s SWEEPS entry withdraws '${skipped}' from the derived adoption pass, but that version's seededSourceFixes names no such path — an exemption for a fix that no longer exists cancels nothing and hides the next one. Remove it from skipDerivedAdopt in scripts/ci/upgrade-sweep.mjs.`,
        )
      }
    }
    const skip = new Set(sweep?.skipDerivedAdopt ?? [])
    adopt.push(...fixPaths.filter((/** @type {string} */ p) => !skip.has(p)))
    tomlSectionRenames.push(...(sweep?.tomlSectionRenames ?? []))
    tomlSectionAppends.push(...(sweep?.tomlSectionAppends ?? []))
  }
  return { adopt, tomlSectionRenames, tomlSectionAppends }
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
    // ── 2b. reviewed section APPENDS (0.9.9) ───────────────────────────────────────
    // Same file and the same argument one step further: a release can add a section the
    // consumer's config has never had, and the harness cannot write it for them because
    // the file is theirs. Appending the reviewed block is the runbook's own instruction
    // ("copy the [auth.mfa] block from the template"), and appending is safe TOML —
    // tables are order-independent, so a block at the end parses exactly as one in the
    // middle. GUARDED ON ABSENCE, in the same lacks-shape as the record's own probe:
    // appending a header the file already carries is a duplicate-table parse error, so
    // an install that has already applied the fix by hand must be left alone.
    for (const [header, block] of sweepSet.tomlSectionAppends) {
      const before = readFileSync(configPath, 'utf8')
      if (before.includes(header)) continue
      writeFileSync(configPath, `${before.trimEnd()}\n${block}`)
      done.push(`supabase/config.toml (${header} appended)`)
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
    const withChain = before
      .replace(/The \d+ gates, in order:[\s\S]*?\n {2}\(docs\/harness\/gates-catalog\.md/, () => {
        const wrapped = names.map((n) => `\`${n}\``).join(', ')
        return `The ${String(names.length)} gates, in order: ${wrapped}\n${'  '}(docs/harness/gates-catalog.md`
      })
      .replace(/the \d+-step chain/g, `the ${String(names.length)}-step chain`)
      .replace(/The \d+ gates,/, `The ${String(names.length)} gates,`)

    // 0.10.0: the STOP-CHAIN sentence, by the same discipline as the gate list above and
    // for the same reason. 0.10.0 arms a docs-sync check that AGENTS.md's "The N Stop-chain
    // steps, in order:" sentence matches tools/stop.floor.json — and AGENTS.md is SEEDED, so
    // every install predating the current wording meets it. The gate's failure text says
    // "paste the N floor names above into AGENTS.md's sentence, then graduate"; executing
    // that here is what proves the instruction sufficient rather than merely plausible.
    // FOUND BY LEG E: the ramp and its obligations row shipped without this, so the one NOTE
    // the documented sweep could not clear was the one this release had just created.
    // Derived from the install's OWN floor, never the template's, so it stays correct
    // whatever the hop injected — the discipline the gate list uses one block up.
    const floorPath = join(installDir, 'tools/stop.floor.json')
    let withStop = withChain
    if (existsSync(floorPath)) {
      const floor = JSON.parse(readFileSync(floorPath, 'utf8'))
      const stopNames = (Array.isArray(floor.steps) ? floor.steps : [])
        .map((s) => (Array.isArray(s) ? s[0] : null))
        .filter((n) => typeof n === 'string')
      if (stopNames.length > 0) {
        // `[^.]*` rather than a lazy any-run: a step name never contains a period, so the
        // first one terminates the list and every sentence after it survives untouched.
        withStop = withChain.replace(
          /The \d+ Stop-chain steps, in order:[^.]*\./,
          `The ${String(stopNames.length)} Stop-chain steps, in order: ${stopNames
            .map((n) => `\`${n}\``)
            .join(', ')}.`,
        )
      }
    }

    // 0.9.5: the SELF-BUDGET sentence, restated honestly. docs-sync now checks that
    // AGENTS.md's own "Keep under ~N lines" claim is TRUE, and AGENTS.md is seeded —
    // so every upgraded install carries whatever number the harness shipped when it
    // was scaffolded (0.1.x said ~200) against a file that has grown past it, and the
    // finding is the HARNESS's stale prose, not the consumer's writing. The gate's
    // failure text offers two remedies, "trim it, or restate the budget honestly";
    // a sweep cannot decide which 100 lines of someone's project memory to delete, so
    // it takes the second, and DERIVES the number from the file rather than pasting
    // the template's — the same discipline as the gate list above. Rounded up to the
    // next 50 so an ordinary edit does not immediately re-red it.
    const lineCount = withStop.trimEnd().split('\n').length
    const after = withStop.replace(/Keep under ~(\d+) lines/, (whole, claimed) =>
      lineCount > Number(claimed)
        ? `Keep under ~${String(Math.ceil(lineCount / 50) * 50)} lines`
        : whole,
    )
    if (after !== before) {
      writeFileSync(agentsPath, after)
      const budgetMoved = after !== withStop
      const stopMoved = withStop !== withChain
      done.push(
        `AGENTS.md (gate list + counts → ${String(names.length)}${stopMoved ? '; Stop-chain list' : ''}${budgetMoved ? '; self-budget restated' : ''})`,
      )
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
