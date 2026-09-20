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
//   4. --verify-tags: TAG ⊆ table[tag's version], judged by that tag's own installer.
//      Needs the tags, so it runs where the checkout has them: lint.yml machinery-lint
//      (fetch-depth: 0), on every pull request AND at the tag ref, where publish blocks on
//      it — so the tag being cut is verified too. A COMPLETE clone with zero tags — a fresh
//      template copy — skips this half loudly; a shallow one fails closed, because it
//      cannot tell "no releases" from "tags were never fetched" (the rule
//      check-seeded-migrations.mjs already applies).
//
// The remedy for (3) is one command: node scripts/generate-released-shas.mjs --current
// Pure judgements: scripts/lib/released-shas.mjs. Git + extraction:
// scripts/lib/released-shas-history.mjs. `--tables-dir <dir>` is the seam the red-proof
// (tests/gates/check-released-shas.test.mjs) uses to present doctored tables.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderEntry, templateRoot, walkTemplate } from '../installer/lib/copy.mjs'
import { fileMode, installerVersion } from '../installer/lib/manifest.mjs'
import { VINTAGES } from './lib/ramp-sites.mjs'
import { git, ownedMapOfTree, releaseTags, withExtracted } from './lib/released-shas-history.mjs'
import { lintTable, missingFrom, missingVersions, ownedMap, templateTrees } from './lib/released-shas.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const tablesDir = args.includes('--tables-dir') ? args[args.indexOf('--tables-dir') + 1] : join(templateRoot(), 'shas')
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

const live = ownedMap({ trees: templateTrees(templateRoot()), walkTemplate, renderEntry, fileMode })
const stale = tables.has(VERSION) ? missingFrom(live, tables.get(VERSION) ?? null, 'live tree') : []
if (stale.length > 0) {
  problems.push(
    ...stale,
    `→ an owned template file changed and template/shas/${VERSION}.json was not regenerated. Run \`node scripts/generate-released-shas.mjs --current\` and commit the result (it only adds variants).`,
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
    const map = await withExtracted(ROOT, commit, (dir) => ownedMapOfTree(dir, tag))
    problems.push(...missingFrom(map, tables.get(version) ?? null, `tag ${tag}`))
    verified += 1
  }
}

if (problems.length > 0) {
  console.error(`released-shas: FAIL (${String(problems.length)})`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `released-shas: OK — ${String(Object.keys(live).length)} live owned path(s) inside template/shas/${VERSION}.json; ${String(tables.size)} table(s) cover every released vintage${args.includes('--verify-tags') ? `; ${String(verified)} tag(s) verified against their own installer` : ''}`,
)
