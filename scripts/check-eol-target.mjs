#!/usr/bin/env node
// check-eol-target — the SHIPPED end-of-life register may not carry a date this release has
// already reached.
//
// WHY THIS EXISTS, and it is a defect that shipped twice before anything looked for it.
// `template/base/tools/eol.json` is a SEEDED file: `init` plants it and `update` may never
// rewrite it, because every row in it is a decision about the consumer's dependencies. A
// `production`-scope row additionally carries `removalTarget`, a RELEASE at which somebody
// looks again — and that date is written by the HARNESS, into a file the harness cannot
// later correct. `arrivedAcceptances` (template/base/tools/lib/eol.mjs) reds the consumer's
// `version-sync` step the moment their installed harness version reaches it.
//
// So a `removalTarget` equal to the version being cut is a red the FACTORY hands every
// install, and hands its own fresh scaffolds, on the first validate after the bump:
//   - 0.10.0 shipped `removalTarget: "0.10.0"`. The upgrade lane found it AFTER 23 green
//     factory Stop steps; the 0.10.0 record calls it "the sharpest example of why
//     seededSourceFixes exists".
//   - 0.11.0 was then dated `"0.11.0"` by that same fix, and a release-planning pass found
//     it again. Twice is a pattern, and nothing in scripts/ was asking the question.
//
// WHAT THIS DOES AND DOES NOT BUY, stated plainly because the honest limit is narrow. It
// does NOT predict the next release: at 0.10.0 a target of 0.11.0 is legitimately in the
// future and nothing here can object. What it does is move the discovery from "a consumer's
// fresh scaffold reds after the tag" to "the version-bump commit reds in its own PR" — the
// bump is the LAST commit before merge (CONTRIBUTING's Releases section), so this fires
// while the release is still a diff somebody is reading, which is the only moment the date
// can still be re-argued.
//
// Closure 2 is the half that reaches EXISTING installs. Re-dating the template fixes fresh
// scaffolds and reaches nobody who already ran `update` — the seeded/owned asymmetry — so a
// moved target owes a `seededSourceFixes` probe in the current release's migrations record.
// Without it the correction is delivered to precisely the population that did not need it.
//
//   usage: node scripts/check-eol-target.mjs [repo-root]
// SOURCE: template/base/tools/lib/eol.mjs (arrivedAcceptances) · CONTRIBUTING.md (Releases)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cmpDotted, highestReleaseBelow } from './lib/ramp-sites.mjs'

// With a repo-root argument it judges THAT tree — files AND git history, so the red-proof
// (tests/gates/check-eol-target.test.mjs) can present a tagged fixture repo.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const inCI = () => process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

const REGISTER = 'template/base/tools/eol.json'
const RELEASE_RE = /^\d+\.\d+\.\d+$/

const version = JSON.parse(read('package.json')).version
const problems = []

/** Every production-scope row carrying a parseable removalTarget, as {package, target}. */
const datedRows = (register) =>
  (Array.isArray(register?.deprecated) ? register.deprecated : [])
    .filter((r) => r?.scope === 'production' && RELEASE_RE.test(String(r?.removalTarget ?? '')))
    .map((r) => ({ package: String(r.package), target: String(r.removalTarget) }))

let register
try {
  register = JSON.parse(read(REGISTER))
} catch (e) {
  console.error(`EOL TARGET: FAIL — ${REGISTER} is unreadable (${String(e.message).slice(0, 160)})`)
  process.exit(1)
}

// Anti-vacuity, first. Every assertion below is a filter over the register's rows, so an
// empty or renamed `deprecated` array would report a clean gate — the failure shape this
// whole file is about. A register with no rows at all is a scan that proves nothing.
const rows = Array.isArray(register?.deprecated) ? register.deprecated : []
if (rows.length === 0) {
  problems.push(
    `${REGISTER} carries no \`deprecated\` rows at all — either the array was renamed or the register was emptied, and both make every check below pass vacuously. The register is never empty in this lineage.`,
  )
}

const dated = datedRows(register)

// ── 1. ARRIVAL ───────────────────────────────────────────────────────────────────────
// The same predicate `arrivedAcceptances` applies consumer-side, applied here against
// package.json instead of .harness/manifest.json. A target at or below this version has
// arrived, and the register is SEEDED, so the harness cannot fix it after the tag.
for (const row of dated) {
  if (cmpDotted(version, row.target) >= 0) {
    problems.push(
      `${REGISTER}: the ${row.package} acceptance carries removalTarget ${row.target} and package.json is ${version} — it has ARRIVED in the release being cut. This file is SEEDED: every fresh scaffold reds on \`version-sync\` at its first validate, and \`update\` cannot correct an install that already holds the value. Re-affirm the acceptance and move removalTarget to a release you actually mean (recording the re-review in the diff), or remove the dependency.`,
    )
  }
}

// ── 2. THE SEEDED REACH OF A MOVED TARGET ────────────────────────────────────────────
// Re-dating the template buys fresh scaffolds and reaches ZERO existing installs. The
// channel that reaches them is the migrations record's seededSourceFixes — so a target that
// MOVED since the previous release must be paired with a probe naming this register.
// SKIP LOUDLY without history, FAIL CLOSED in CI: the same asymmetry the gates use for
// toolchains, and the reason machinery-lint checks out with fetch-depth: 0.
const previousTag = (() => {
  try {
    return highestReleaseBelow(git(['tag', '--list', 'v*.*.*']).split('\n'), version)
  } catch {
    return null
  }
})()

let reachSummary
if (previousTag === null) {
  const msg = `no v*.*.* tag strictly below ${version} is reachable, so no previous register exists to diff against. This needs full history (fetch-depth: 0).`
  if (inCI()) problems.push(`${msg} A skip is not allowed in CI.`)
  else reachSummary = `seeded-reach closure SKIPPED — ${msg} (FAILS CLOSED in CI)`
} else {
  let moved = []
  try {
    const before = datedRows(JSON.parse(git(['show', `${previousTag}:${REGISTER}`])))
    const wasByPackage = new Map(before.map((r) => [r.package, r.target]))
    moved = dated.filter((r) => wasByPackage.has(r.package) && wasByPackage.get(r.package) !== r.target)
  } catch (e) {
    const msg = `reading ${previousTag}:${REGISTER} failed (shallow clone, or the tag object is absent): ${String(e.message).slice(0, 160)}`
    if (inCI()) problems.push(`${msg} A skip is not allowed in CI.`)
    else reachSummary = `seeded-reach closure SKIPPED — ${msg} (FAILS CLOSED in CI)`
    moved = null
  }

  if (moved !== null) {
    if (moved.length > 0) {
      const migrations = JSON.parse(read('template/migrations.json'))
      const entries = migrations?.[version]?.seededSourceFixes
      const covered =
        Array.isArray(entries) &&
        entries.some((e) =>
          (Array.isArray(e?.probes) ? e.probes : []).some((p) => String(p?.path ?? '').endsWith('tools/eol.json')),
        )
      if (!covered) {
        problems.push(
          `${REGISTER}: removalTarget moved for ${moved.map((r) => `${r.package} -> ${r.target}`).join(', ')} since ${previousTag}, but template/migrations.json "${version}" carries no seededSourceFixes probe on tools/eol.json. Re-dating the template reaches FRESH SCAFFOLDS ONLY — the register is seeded, so an existing install still holds the old value and meets it as a hard red with no instruction attached. Add the probe, or the correction is delivered to exactly the population that did not need it.`,
        )
      }
    }
    reachSummary = `seeded-reach vs ${previousTag}: ${String(moved.length)} moved target(s)`
  }
}

if (problems.length > 0) {
  console.error(`EOL TARGET: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nA removalTarget is a date the harness writes into a file it may never rewrite. One that arrives in the release being cut is a red the factory hands every install; one that moves with no channel to existing installs is a fix delivered only to the trees that did not need it.',
  )
  console.error(`FIX[eol-target]: reproduce with \`node scripts/check-eol-target.mjs\``)
  process.exit(1)
}

console.log(
  `EOL TARGET: CLEAN (${String(dated.length)} production-scope removalTarget(s) at v${version}, none arrived` +
    `${reachSummary === undefined ? '' : `; ${reachSummary}`})`,
)
