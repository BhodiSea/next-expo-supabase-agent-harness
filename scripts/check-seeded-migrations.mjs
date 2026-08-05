#!/usr/bin/env node
// seedOnInitOnly completeness gate for the harness repo itself (selftest CI —
// never shipped to consumers). The hazard it closes: `update` auto-plants any
// ABSENT non-owned file it does not recognize as init-time-only, so a template
// file newly ADDED since the previous release that installs as SEEDED or CONFIG
// content and is NOT registered seedOnInitOnly in template/migrations.json gets
// silently planted into every existing install on their next `update` — and an
// exemplar the consumer's routes/App never reference reds route-manifest +
// dead-code (the hand-maintained-list gap the 0.1.4 release survived by luck).
// This script makes forgetting the registration a red PR instead of a red fleet.
//   usage: node scripts/check-seeded-migrations.mjs
//   env:   PREVIOUS_RELEASE_TAG — the release to diff against
//          (default: `git describe --tags --abbrev=0`)
// Path mapping REUSES the installer's own storageToInstall (the .tmpl strip +
// top-level dotless RENAMES walkTemplate routes every install through), and the
// classification reuses fileMode + seedOnInitOnlyPatterns/matchSeedOnInitOnly —
// zero duplicated rename or mode logic, so this gate cannot drift from `update`.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { storageToInstall, walkTemplate } from '../installer/lib/copy.mjs'
import { fileMode } from '../installer/lib/manifest.mjs'
import {
  matchSeedOnInitOnly,
  readTemplateMigrations,
  seedOnInitOnlyPatterns,
} from '../installer/lib/migrations.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Deliberate plants: rare seeded/config additions that SHOULD auto-plant into
// existing installs on `update` (nothing references them, or every install must
// carry them for a gate to keep working). Each entry needs the git path exactly
// as `git diff` prints it plus a written reason — an empty reason is a review
// reject. Example: { file: 'template/stack/tools/new-budget.json', reason: '…' }
const DELIBERATE_PLANT = [
  {
    file: 'template/base/tools/tenancy.json',
    reason:
      'check-tenancy.mjs FAILS CLOSED when the contract is missing, and that check runs before any ramp — an install with the `tenancy` step injected and no contract reds on its first validate. The file is a contract (the closed predicate-form set, the rank ladder, the two helper names), not project data: nothing in it names a consumer table. Planting it is what makes the injected step ramp instead of fail.',
  },
  {
    file: 'template/base/tools/db-limits.json',
    reason:
      'Identical reasoning to tenancy.json: check-db-limits.mjs fails closed on a missing ceiling list before it can ramp. The rows are role x knob ceilings and the quota trigger shape — universal, not project-specific.',
  },
  {
    file: 'template/base/tools/security-headers.json',
    reason:
      'The gate ramps on the absent MODULE (apps/web/lib/security-headers.ts, which IS withheld), so this file is never read by an un-adopted install. It is planted so that pulling the module later with `--refresh-seeded` yields a gate that judges the headers immediately, rather than one that fails closed on a missing policy. The policy is a web response posture; it names no consumer route.',
  },
  {
    file: 'template/base/tools/approved-tools.json',
    reason:
      'The registry pretool-mcp-guard.mjs reads, and the guard FAILS CLOSED without it: an absent registry is not an empty policy, it is no policy, so every mcp__ call in an updated install would be denied against a file that is not there. `update` wires the sixth hook into existing installs, so withholding its one input would ship the deny and hold back the policy. It is seeded rather than owned because the guard\'s own deny message asks the consumer to add a row, and sha-pinning a file you are told to edit calls that edit tampering; its integrity is the write-guard rule plus gate-integrity\'s escape-list dirty check. Same shape as tenancy.json above. Recorded in template/migrations.json under 0.3.0, and upgrade-lane.sh asserts the plant actually lands.',
  },
  {
    file: 'template/modules/eval-live/packages/eval/package.json.tmpl',
    reason:
      'The eval-live module shipped src/adapters/live.ts with NO package.json — `@app/eval` never resolved, so every install that enabled the module had a workspace package pnpm could not link. Planting completes it. There is nothing of the consumer\'s to clobber: the file has never existed in any install.',
  },
  {
    file: 'template/modules/eval-live/packages/eval/tsconfig.json',
    reason:
      'Same gap as the package.json above — the module had no project reference, so `tsc -b` never type-checked its one source file. Planting is the fix, not an exemplar.',
  },
  {
    file: 'template/modules/eval-live/packages/eval/src/providers.ts',
    reason:
      "adapters/live.ts imports `../providers.js` and that module did not exist: the module did not compile. This is a repair to a shipped package, so every install with eval-live enabled needs it — withholding it would leave the import dangling exactly as it is today.",
  },
]

// Every seedOnInitOnly pattern must name something the template ACTUALLY SHIPS.
//
// The field is a pure list read by a prefix/exact matcher, and both ways it can be
// wrong are silent. A typo or a path left behind by a rename withholds NOTHING while
// reading as protection, and `update` cheerfully plants the file the entry was meant to
// hold back. A comment string accidentally added to the array is the same bug wearing
// prose — and one ending in '/' would withhold an entire subtree, which is worse.
// Neither shows up in any other check, because both are perfectly valid JSON.
//
// `shipped` is derived from walkTemplate + storageToInstall — the installer's own
// mapping, so a .tmpl strip or a top-level dotless rename can never make this disagree
// with what `update` computes. Directory prefixes are included so a subtree pattern
// resolves against the tree it covers.
export function findUngroundedPatterns({ patterns, shippedInstallPaths }) {
  const dirs = new Set()
  for (const ip of shippedInstallPaths) {
    const parts = ip.split('/')
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  const files = new Set(shippedInstallPaths)
  return patterns.filter((p) => (p.endsWith('/') ? !dirs.has(p) : !files.has(p)))
}

// Pure core (unit-tested without git): given the template paths ADDED since the
// previous release, the parsed template/migrations.json, and an allowlist,
// return every addition that would be auto-planted as seeded/config content.
// Accepted path shapes: as git prints them ('template/base/…') or already
// template-relative ('base/…'); files directly under template/ (migrations.json
// itself) are packaging metadata and never install anywhere.
export function findUnregisteredSeededAdditions({ addedTemplatePaths, migrations, allowlist = [] }) {
  const patterns = seedOnInitOnlyPatterns(migrations)
  const allowed = new Set(allowlist.map((a) => a.file))
  const violations = []
  for (const raw of addedTemplatePaths) {
    const p = raw.replace(/^template\//, '')
    // Which storage tree? base/ and stack/ strip one segment; modules/<name>/
    // strips two (module files install for every consumer with the module
    // enabled — the auto-plant hazard is identical there).
    let treeRel = null
    if (p.startsWith('base/')) treeRel = p.slice('base/'.length)
    else if (p.startsWith('stack/')) treeRel = p.slice('stack/'.length)
    else if (p.startsWith('modules/')) treeRel = p.split('/').slice(2).join('/')
    if (!treeRel) continue
    const installPath = storageToInstall(treeRel)
    const mode = fileMode(installPath)
    if (mode === 'owned') continue // owned files are update's job to plant — that is the product
    if (matchSeedOnInitOnly(installPath, patterns)) continue // registered: update withholds it
    if (allowed.has(raw)) continue // reviewed deliberate plant
    violations.push({ templatePath: raw, installPath, mode })
  }
  return violations
}

// CLI wrapper — only when executed directly, so the tests can import the pure
// core without spawning git.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  // Grounding first — it needs no git, and a pattern that names nothing is wrong
  // whether or not there is a previous release to diff against.
  const migrations = readTemplateMigrations()
  const trees = ['base', 'stack']
  for (const name of readdirSync(join(ROOT, 'template', 'modules')).sort()) {
    trees.push(`modules/${name}`)
  }
  const shipped = trees.flatMap((t) => walkTemplate(t)).map((e) => e.installPath)
  const ungrounded = findUngroundedPatterns({
    patterns: seedOnInitOnlyPatterns(migrations),
    shippedInstallPaths: shipped,
  })
  if (ungrounded.length > 0) {
    console.error(
      `SEEDED-MIGRATIONS: FAIL (${ungrounded.length}) — seedOnInitOnly pattern(s) in template/migrations.json name nothing the template ships:`,
    )
    for (const p of ungrounded) {
      console.error(
        `  - ${JSON.stringify(p)} — ${p.endsWith('/') ? 'no shipped file installs under this directory' : 'no shipped file installs to this exact path'}`,
      )
    }
    console.error(
      '  why: the field is read by a prefix/exact matcher, so a typo, a path left behind by a rename, or a comment string added to the array withholds NOTHING while reading as protection — and `update` plants the file the entry was meant to hold back. Fix the pattern or delete it.',
    )
    process.exit(1)
  }

  let prev = process.env.PREVIOUS_RELEASE_TAG || null
  if (prev === null) {
    try {
      prev = git(['describe', '--tags', '--abbrev=0']).trim()
    } catch {
      // fall through to the reachability failure below with prev still null
    }
  }
  // No tag resolved. Two very different situations hide behind that, and only
  // one of them is safe to skip:
  //   - a COMPLETE clone carrying zero tags has genuinely never been released
  //     (this repo before its first tag; any fresh "Use this template" copy).
  //     There is no previous release to diff against, so the check is vacuous
  //     rather than failing — skip LOUDLY.
  //   - a SHALLOW clone cannot tell "no releases" from "tags not fetched", so
  //     it keeps failing closed. Diffing against nothing would pass vacuously,
  //     which is the exact false green this gate exists to prevent.
  if (prev === null) {
    const shallow = (() => {
      try {
        return git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
      } catch {
        return true // cannot establish completeness -> treat as shallow -> fail closed
      }
    })()
    let tagCount = 0
    try {
      tagCount = git(['tag', '--list']).split('\n').filter(Boolean).length
    } catch {
      /* leave at 0; the shallow branch below decides */
    }
    if (!shallow && tagCount === 0) {
      console.log(
        'SEEDED-MIGRATIONS: SKIP — this clone is complete and carries no tags, so there is no ' +
          'previous release to diff against. Expected before the first release and in a fresh ' +
          'template copy; the check engages on its own from the next release onward.',
      )
      process.exit(0)
    }
    console.error(
      'SEEDED-MIGRATIONS: FAIL — no previous release tag in this clone, and it is ' +
        `${shallow ? 'SHALLOW' : 'carrying tags that did not resolve'} — "no releases yet" cannot be ` +
        'distinguished from "tags were never fetched". Fetch tags first (`git fetch --tags`; in CI ' +
        'check out with fetch-depth: 0) or set PREVIOUS_RELEASE_TAG.',
    )
    process.exit(1)
  }
  try {
    git(['rev-parse', '--verify', `${prev}^{commit}`])
  } catch {
    console.error(
      `SEEDED-MIGRATIONS: FAIL — previous release tag '${prev}' is not reachable in this clone. ` +
        'Fetch tags first (`git fetch --tags`; in CI check out with fetch-depth: 0) or set PREVIOUS_RELEASE_TAG.',
    )
    process.exit(1)
  }

  const added = git(['diff', '--name-only', '--diff-filter=A', `${prev}..HEAD`, '--', 'template/'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const violations = findUnregisteredSeededAdditions({
    addedTemplatePaths: added,
    migrations,
    allowlist: DELIBERATE_PLANT,
  })

  if (violations.length > 0) {
    console.error(
      `SEEDED-MIGRATIONS: FAIL (${violations.length}) — template file(s) added since ${prev} install as seeded/config content but are not registered seedOnInitOnly:`,
    )
    for (const v of violations) {
      console.error(
        `  - ${v.templatePath} installs to ${v.installPath} (mode: ${v.mode}) — add "${v.installPath}" ` +
          '(or a covering "<dir>/" subtree pattern) to the CURRENT release version\'s seedOnInitOnly in template/migrations.json, ' +
          'or record it in DELIBERATE_PLANT (scripts/check-seeded-migrations.mjs) with a reason',
      )
    }
    console.error(
      '  why: `update` auto-plants unregistered absent seeded files into EXISTING installs, and an unreferenced exemplar reds route-manifest + dead-code on their next validate.',
    )
    process.exit(1)
  }
  console.log(
    `SEEDED-MIGRATIONS: CLEAN (${added.length} template file(s) added since ${prev}; every seeded/config addition is registered seedOnInitOnly or a reviewed deliberate plant)`,
  )
}
