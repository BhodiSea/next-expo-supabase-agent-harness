#!/usr/bin/env node
// Factory gate: released-shas — template/shas/ still describes what this harness ships.
//
// `update` overwrites an owned file only when a release shipped the bytes it finds
// (installer/lib/provenance.mjs reads these tables). A table that has drifted from the
// template fails in the QUIET direction: it parks files nobody touched, on every install,
// at the next update. So the closure runs on every pull request:
//
//   1. every table is well-formed — generated, sorted, bare token names only;
//   2. a table exists for every released vintage (scripts/lib/ramp-sites.mjs VINTAGES) and
//      for the version being built — so a version bump cannot forget to start the next one;
//   3. LIVE ⊆ table[package.json version] — every owned file this tree ships is listed.
//      Subset, not equality: tables only grow, because the documented install command has
//      no tag and every `main` commit that carried a version is a release to somebody;
//   3a. the escape lists (1.1.0, #84): every table carries a `planted` map, LIVE's planted
//      escape lists ⊆ table[package.json version].planted, and the shipped evidence file
//      template/base/tools/lib/planted-shas.json is EXACTLY the generated union of every
//      table's `planted` map — gate-integrity reads it in an install to ask whether a harness
//      release planted an untracked escape list, so a hand edit there is a forged witness;
//   3b. the worked example (2.0.4): every table carries a `demo` map, and LIVE's demo tree
//      ⊆ table[package.json version].demo — `eject` reads it to know an earlier release's
//      untouched demo file, so a stale one turns those files into forks again;
//   4. --verify-tags: TAG ⊆ table[tag's version], judged by that tag's own installer, for
//      the owned map, the planted map and the demo map.
//   4a. (2.0.4, #259) and the same for every first-parent `main` commit, judged by its own
//      installer against the table of the version its own package.json carries. The install
//      command has no tag, and a merge commit on `main` can carry bytes no pull request's CI
//      checked (a stack merged bottom to top, a conflict resolved in the web editor): an
//      untouched install from such a commit had its owned files parked as forks on `update`.
//      One extraction per distinct installer/template pair; commits below the lineage floor
//      are skipped as the generator skips them. With no `main` to walk, a complete clone
//      skips this half loudly and a shallow one fails closed, as for the tags.
//      Needs the tags, so it runs where the checkout has them: lint.yml machinery-lint
//      (fetch-depth: 0), on every pull request AND at the tag ref, where publish blocks on
//      it — so the tag being cut is verified too. A COMPLETE clone with zero tags — a fresh
//      template copy — skips this half loudly; a shallow one fails closed, because it
//      cannot tell "no releases" from "tags were never fetched" (the rule
//      check-seeded-migrations.mjs already applies).
//
// The remedy for (3) is one command: node scripts/generate-released-shas.mjs --current
// Pure judgements: scripts/lib/released-shas.mjs. Git + extraction:
// scripts/lib/released-shas-history.mjs. `--tables-dir <dir>` and `--planted-file <path>` are
// the seams the red-proof (tests/gates/check-released-shas.test.mjs) uses to present doctored
// tables and a doctored evidence file. `--only-version <v>` narrows (4) and (4a) to the
// commits of one version, so tests/gates/released-shas-history.test.mjs stays quick.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderEntry, templateRoot, walkTemplate } from '../installer/lib/copy.mjs'
import { fileMode, installerVersion } from '../installer/lib/manifest.mjs'
import { ESCAPE_LISTS } from '../template/base/tools/lib/enforcement-surface.mjs'
import { LINEAGE_FLOOR, VINTAGES, cmpDotted } from './lib/ramp-sites.mjs'
import { git, mainCommits, mapsOfTree, releaseTags, withExtracted } from './lib/released-shas-history.mjs'
import {
  PLANTED_INSTALL_PATH,
  demoMap,
  lintTable,
  missingFrom,
  missingVersions,
  ownedMap,
  plantedFileText,
  plantedMap,
  plantedUnion,
  templateTrees,
} from './lib/released-shas.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const tablesDir = args.includes('--tables-dir') ? args[args.indexOf('--tables-dir') + 1] : join(templateRoot(), 'shas')
const plantedFile = args.includes('--planted-file')
  ? args[args.indexOf('--planted-file') + 1]
  : join(templateRoot(), 'base', PLANTED_INSTALL_PATH)
const VERSION = installerVersion()
const onlyVersion = args.includes('--only-version') ? args[args.indexOf('--only-version') + 1] : null

/** @type {string[]} */
const problems = []
/** @type {Map<string, import('./lib/released-shas.mjs').Table>} */
const tables = new Map()

let names = []
try {
  names = readdirSync(tablesDir)
    .filter((n) => n.endsWith('.json'))
    .sort()
} catch {
  problems.push(`${tablesDir} does not exist — run \`node scripts/generate-released-shas.mjs --all\``)
}
for (const name of names) {
  const raw = readFileSync(join(tablesDir, name), 'utf8')
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    problems.push(`${name}: not valid JSON`)
    continue
  }
  const lint = lintTable(name, parsed, raw)
  problems.push(...lint)
  if (lint.length === 0) tables.set(parsed.version, parsed)
}

for (const version of missingVersions(VINTAGES, VERSION, [...tables.keys()])) {
  problems.push(
    `${version} has no released-sha table — an install at ${version} would lose fork protection on update. Run \`node scripts/generate-released-shas.mjs --all\` (needs the tags), or \`--current\` when ${version} is the version being built.`,
  )
}

const walker = { trees: templateTrees(templateRoot()), walkTemplate, renderEntry }
const live = ownedMap({ ...walker, fileMode })
const livePlanted = plantedMap({ ...walker, paths: ESCAPE_LISTS })
const liveDemo = demoMap(walker)
const stale = tables.has(VERSION)
  ? [
      ...missingFrom(live, tables.get(VERSION) ?? null, 'live tree'),
      ...missingFrom(livePlanted, tables.get(VERSION) ?? null, 'live tree', 'planted'),
      ...missingFrom(liveDemo, tables.get(VERSION) ?? null, 'live tree', 'demo'),
    ]
  : []
if (stale.length > 0) {
  problems.push(
    ...stale,
    `→ an owned template file, an escape list or a worked-example file changed and template/shas/${VERSION}.json was not regenerated. Run \`node scripts/generate-released-shas.mjs --current\` and commit the result (it only adds variants).`,
  )
}

// 3a. The evidence an install reads must be exactly what the tables say. Compared as the
// generator's own bytes, so a reordered, hand-widened or stale copy reds alike.
let plantedText = null
try {
  plantedText = readFileSync(plantedFile, 'utf8')
} catch {
  problems.push(`${PLANTED_INSTALL_PATH} does not exist — gate-integrity would call every untracked escape list a widening. Run \`node scripts/generate-released-shas.mjs --current\``)
}
if (plantedText !== null && plantedText !== plantedFileText(plantedUnion(tables.values()))) {
  problems.push(
    `${PLANTED_INSTALL_PATH} is not the union of the tables' planted maps. It is generated, never edited: gate-integrity trusts it to say which escape-list bytes a harness release planted, so a hand-added variant is a forged witness. Run \`node scripts/generate-released-shas.mjs --current\` and commit the result.`,
  )
}

function isShallow() {
  try {
    return git(ROOT, ['rev-parse', '--is-shallow-repository']).trim() === 'true'
  } catch {
    // cannot establish completeness -> treat as shallow -> fail closed
    return true
  }
}

/** "no tags" is only a safe skip in a COMPLETE clone — see the header. */
function tagsOrSkip() {
  const tags = releaseTags(ROOT)
  if (tags.length > 0) return tags
  if (isShallow()) {
    problems.push('--verify-tags: no release tag in this clone and it is SHALLOW — "no releases yet" cannot be told from "tags were never fetched". Fetch tags (`git fetch --tags`; in CI, fetch-depth: 0).')
  } else {
    console.log('released-shas: SKIP (tags) — this clone is complete and carries no tags, so there is no release to verify a table against. Expected in a fresh template copy.')
  }
  return []
}

/** 4a: first-parent `main`, or a loud skip (complete clone) / a failure (shallow one). */
function mainOrSkip() {
  const commits = mainCommits(ROOT)
  if (commits !== null && !isShallow()) return commits
  if (isShallow()) {
    problems.push('--verify-tags: this clone is SHALLOW, so the untagged `main` commits an install can come from cannot be walked. Fetch the full history (`git fetch --unshallow`; in CI, fetch-depth: 0).')
  } else {
    console.log('released-shas: SKIP (main) — neither main nor origin/main resolves, so there is no untagged release commit to verify a table against.')
  }
  return []
}

/** @param {string} commit @param {string} label @param {string} version */
async function verifyCommit(commit, label, version) {
  const { owned, planted, demo } = await withExtracted(ROOT, commit, (dir) => mapsOfTree(dir, label))
  return [
    ...missingFrom(owned, tables.get(version) ?? null, label),
    ...missingFrom(planted, tables.get(version) ?? null, label, 'planted'),
    ...missingFrom(demo, tables.get(version) ?? null, label, 'demo'),
  ]
}

let verified = 0
let verifiedMain = 0
if (args.includes('--verify-tags')) {
  for (const { tag, commit, version } of tagsOrSkip()) {
    if (onlyVersion !== null && version !== onlyVersion) continue
    problems.push(...(await verifyCommit(commit, `tag ${tag}`, version)))
    verified += 1
  }
  /** @type {Set<string>} installer/template tree pair + version, judged once */
  const seen = new Set()
  const history = []
  for (const commit of mainOrSkip()) {
    let trees
    try {
      trees = `${git(ROOT, ['rev-parse', `${commit}:installer`]).trim()} ${git(ROOT, ['rev-parse', `${commit}:template`]).trim()}`
    } catch {
      continue // no installer/ or template/ yet
    }
    const version = JSON.parse(git(ROOT, ['show', `${commit}:package.json`])).version
    if (cmpDotted(version, LINEAGE_FLOOR) < 0 || (onlyVersion !== null && version !== onlyVersion)) continue
    if (seen.has(`${trees} ${version}`)) continue
    seen.add(`${trees} ${version}`)
    history.push(...(await verifyCommit(commit, `main ${commit.slice(0, 9)}`, version)))
    verifiedMain += 1
  }
  if (history.length > 0) {
    problems.push(
      ...history,
      '→ an untagged `main` commit shipped bytes its version\'s table does not list, so an untouched install made from it has those files parked as forks on `update`. Run `node scripts/generate-released-shas.mjs --all` (it only adds variants), then `--current`, and commit the result.',
    )
  }
}

if (problems.length > 0) {
  console.error(`released-shas: FAIL (${String(problems.length)})`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `released-shas: OK — ${String(Object.keys(live).length)} live owned path(s), ${String(Object.keys(livePlanted).length)} planted escape list(s) and ${String(Object.keys(liveDemo).length)} demo path(s) inside template/shas/${VERSION}.json; ${PLANTED_INSTALL_PATH} is the union of the planted maps; ${String(tables.size)} table(s) cover every released vintage${args.includes('--verify-tags') ? `; ${String(verified)} tag(s) and ${String(verifiedMain)} main commit(s) verified against their own installer` : ''}`,
)
