#!/usr/bin/env node
// Generate the released-sha tables (template/shas/<version>.json).
//
//   node scripts/generate-released-shas.mjs --current
//       Union what the LIVE tree ships into the table of package.json's version. This is
//       the one a pull request runs when it touches an owned template file; it only ever
//       ADDS variants, so two pull requests regenerating the same table merge as a union.
//
//   node scripts/generate-released-shas.mjs --all [--prove] [--out <dir>]
//       Rebuild from history: every first-parent commit of `main` plus every release tag,
//       grouped by the version that commit's own package.json carries. The documented
//       install command has no tag, so an install can come from ANY of those commits, and
//       a table that knew only the tags would call its untouched files forks.
//
// A historical commit is judged by ITS OWN installer — walkTemplate, renderEntry and
// fileMode are imported from the extracted commit — because the seeded lists and the
// dotless renames moved between releases (the upgrade lane runs the old tag's own `init`
// for the same reason).
//
// Every map is SELF-PROVED before it is folded in: the commit's own `render` must
// `derender` back to the source for every placeholder-bearing owned file (always), and
// with --prove the commit's own `init` runs into a temp dir and every owned sha its
// manifest records must be explained by the map (DERIVED_AT_INSTALL aside) — which is what
// makes that carve-out list complete by construction rather than by inspection.
//
// Pure judgements: scripts/lib/released-shas.mjs. Git + extraction: scripts/lib/
// released-shas-history.mjs. The installer-side reader: installer/lib/provenance.mjs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderEntry, templateRoot, walkTemplate } from '../installer/lib/copy.mjs'
import { fileMode, installerVersion } from '../installer/lib/manifest.mjs'
import { DERIVED_AT_INSTALL, explains } from '../installer/lib/provenance.mjs'
import { LINEAGE_FLOOR, cmpDotted } from './lib/ramp-sites.mjs'
import { git, ownedMapOfTree, releaseCommits, withExtracted } from './lib/released-shas-history.mjs'
import { ownedMap, templateTrees, unionInto } from './lib/released-shas.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(templateRoot(), 'shas')

/** @param {string} version @returns {import('./lib/released-shas.mjs').Table | null} */
function readTable(version) {
  try {
    return JSON.parse(readFileSync(join(outDir, `${version}.json`), 'utf8'))
  } catch {
    return null
  }
}

/** @param {import('./lib/released-shas.mjs').Table} table */
function writeTable(table) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${table.version}.json`), `${JSON.stringify(table, null, 2)}\n`)
}

/**
 * --prove: run the commit's OWN `init` (strict tier, non-default answers, a two-handle
 * owners value), then return every owned path whose recorded sha the map does not explain.
 *
 * @param {string} dir @param {import('./lib/released-shas.mjs').OwnedMap} map
 */
function unexplainedAfterInit(dir, map) {
  const scaffold = mkdtempSync(join(tmpdir(), 'released-shas-init-'))
  try {
    const sets = ['PROJECT_NAME=Proof App', 'GITHUB_OWNER=proof-owner', 'SECURITY_OWNERS=@proof-owner/one @proof-owner/two', 'DEFAULT_BRANCH=trunk']
    const run = spawnSync(
      process.execPath,
      [join(dir, 'installer/cli.mjs'), 'init', '--dir', scaffold, '--tier', 'strict', '--yes', ...sets.flatMap((s) => ['--set', s])],
      { encoding: 'utf8' },
    )
    if (run.status !== 0 && run.status !== 2) {
      return [`(its own init exited ${String(run.status)}: ${(run.stderr ?? '').trim().split('\n')[0]})`]
    }
    const manifest = JSON.parse(readFileSync(join(scaffold, '.harness/manifest.json'), 'utf8'))
    return Object.entries(manifest.files)
      .filter(([ip, meta]) => meta.mode === 'owned' && !DERIVED_AT_INSTALL.has(ip))
      .filter(([ip, meta]) => {
        const current = readFileSync(join(scaffold, ip))
        return !explains(map[ip] ?? [], { recordedSha: meta.sha256, current, answers: manifest.answers ?? {} })
      })
      .map(([ip]) => ip)
      .sort()
  } finally {
    rmSync(scaffold, { recursive: true, force: true })
  }
}

/** @param {string} commit @param {string} version */
async function provedMapOf(commit, version) {
  const label = `${commit.slice(0, 7)} (${version})`
  return withExtracted(ROOT, commit, async (dir) => {
    const map = await ownedMapOfTree(dir, label)
    const unexplained = args.includes('--prove') ? unexplainedAfterInit(dir, map) : []
    if (unexplained.length > 0) {
      throw new Error(`${label}: its own init records owned shas the map does not explain: ${unexplained.join(', ')}`)
    }
    return map
  })
}

async function generateAll() {
  /** @type {Map<string, import('./lib/released-shas.mjs').Table>} */
  const tables = new Map()
  // Most commits do not touch installer/ or template/: one extraction per distinct pair of
  // tree ids, not per commit.
  /** @type {Map<string, import('./lib/released-shas.mjs').OwnedMap>} */
  const byTrees = new Map()
  const skipped = []
  let belowFloor = 0
  for (const commit of releaseCommits(ROOT)) {
    let trees
    try {
      trees = `${git(ROOT, ['rev-parse', `${commit}:installer`]).trim()} ${git(ROOT, ['rev-parse', `${commit}:template`]).trim()}`
    } catch {
      skipped.push(`${commit.slice(0, 7)}: no installer/ or template/ yet`)
      continue
    }
    const version = JSON.parse(git(ROOT, ['show', `${commit}:package.json`])).version
    // Below the lineage floor the commits are the ANCESTOR's port (scripts/lib/ramp-sites.mjs:
    // "a vintage no install of this harness has ever carried"), and their paths still carry
    // the ancestor's stack vocabulary, which hygiene bans everywhere under template/. No
    // table is the documented fallback: `update` keeps the pre-1.0.2 behaviour and says so.
    if (cmpDotted(version, LINEAGE_FLOOR) < 0) {
      belowFloor += 1
      continue
    }
    const map = byTrees.get(trees) ?? (await provedMapOf(commit, version))
    byTrees.set(trees, map)
    tables.set(version, unionInto(tables.get(version) ?? readTable(version), version, map))
  }
  for (const table of tables.values()) writeTable(table)
  console.log(
    `generate-released-shas: ${String(tables.size)} table(s) from ${String(byTrees.size)} distinct tree(s): ${[...tables.keys()].join(' ')}`,
  )
  for (const s of skipped) console.log(`  skipped ${s}`)
  if (belowFloor > 0) console.log(`  skipped ${String(belowFloor)} commit(s) below the lineage floor ${LINEAGE_FLOOR}`)
}

/** @param {import('./lib/released-shas.mjs').Table | null} table */
const variantCount = (table) => Object.values(table?.files ?? {}).reduce((n, variants) => n + variants.length, 0)

function generateCurrent() {
  const version = installerVersion()
  const map = ownedMap({ trees: templateTrees(templateRoot()), walkTemplate, renderEntry, fileMode })
  const before = readTable(version)
  const table = unionInto(before, version, map)
  writeTable(table)
  console.log(
    `generate-released-shas: template/shas/${version}.json — ${String(Object.keys(table.files).length)} owned path(s), ${String(variantCount(table) - variantCount(before))} new variant(s)`,
  )
}

if (args.includes('--all')) await generateAll()
else if (args.includes('--current')) generateCurrent()
else {
  console.error('usage: generate-released-shas.mjs --current | --all [--prove] [--out <dir>]')
  process.exit(2)
}
