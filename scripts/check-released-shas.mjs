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
//   4. --verify-tags: TAG ⊆ table[tag's version], judged by that tag's own installer, for
//      the owned map and the planted map both.
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
// tables and a doctored evidence file.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderEntry, templateRoot, walkTemplate } from '../installer/lib/copy.mjs'
import { fileMode, installerVersion } from '../installer/lib/manifest.mjs'
import { ESCAPE_LISTS } from '../template/base/tools/lib/enforcement-surface.mjs'
import { VINTAGES } from './lib/ramp-sites.mjs'
import { git, mapsOfTree, releaseTags, withExtracted } from './lib/released-shas-history.mjs'
import {
  PLANTED_INSTALL_PATH,
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
const stale = tables.has(VERSION)
  ? [
      ...missingFrom(live, tables.get(VERSION) ?? null, 'live tree'),
      ...missingFrom(livePlanted, tables.get(VERSION) ?? null, 'live tree', 'planted'),
    ]
  : []
if (stale.length > 0) {
  problems.push(
    ...stale,
    `→ an owned template file or an escape list changed and template/shas/${VERSION}.json was not regenerated. Run \`node scripts/generate-released-shas.mjs --current\` and commit the result (it only adds variants).`,
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

/** "no tags" is only a safe skip in a COMPLETE clone — see the header. */
function tagsOrSkip() {
  const tags = releaseTags(ROOT)
  if (tags.length > 0) return tags
  let shallow = true
  try {
    shallow = git(ROOT, ['rev-parse', '--is-shallow-repository']).trim() === 'true'
  } catch {
    // cannot establish completeness -> treat as shallow -> fail closed
  }
  if (shallow) {
    problems.push('--verify-tags: no release tag in this clone and it is SHALLOW — "no releases yet" cannot be told from "tags were never fetched". Fetch tags (`git fetch --tags`; in CI, fetch-depth: 0).')
  } else {
    console.log('released-shas: SKIP (tags) — this clone is complete and carries no tags, so there is no release to verify a table against. Expected in a fresh template copy.')
  }
  return []
}

let verified = 0
if (args.includes('--verify-tags')) {
  for (const { tag, commit, version } of tagsOrSkip()) {
    const { owned, planted } = await withExtracted(ROOT, commit, (dir) => mapsOfTree(dir, tag))
    problems.push(...missingFrom(owned, tables.get(version) ?? null, `tag ${tag}`))
    problems.push(...missingFrom(planted, tables.get(version) ?? null, `tag ${tag}`, 'planted'))
    verified += 1
  }
}

if (problems.length > 0) {
  console.error(`released-shas: FAIL (${String(problems.length)})`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `released-shas: OK — ${String(Object.keys(live).length)} live owned path(s) and ${String(Object.keys(livePlanted).length)} planted escape list(s) inside template/shas/${VERSION}.json; ${PLANTED_INSTALL_PATH} is the union of the planted maps; ${String(tables.size)} table(s) cover every released vintage${args.includes('--verify-tags') ? `; ${String(verified)} tag(s) verified against their own installer` : ''}`,
)
