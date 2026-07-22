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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { storageToInstall } from '../installer/lib/copy.mjs'
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
const DELIBERATE_PLANT = []

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

  let prev = process.env.PREVIOUS_RELEASE_TAG || null
  if (prev === null) {
    try {
      prev = git(['describe', '--tags', '--abbrev=0']).trim()
    } catch {
      // fall through to the reachability failure below with prev still null
    }
  }
  // Fail LOUD when no tag is reachable: diffing against nothing would pass
  // vacuously, which is exactly the false green this gate exists to prevent.
  try {
    if (prev === null) throw new Error('no tag')
    git(['rev-parse', '--verify', `${prev}^{commit}`])
  } catch {
    console.error(
      `SEEDED-MIGRATIONS: FAIL — previous release tag ${prev ? `'${prev}' is not reachable` : 'not found'} in this clone. ` +
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
    migrations: readTemplateMigrations(),
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
