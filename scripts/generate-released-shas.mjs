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
// Both modes also fold each tree's PLANTED map (1.1.0, #84) into the table's `planted`: per
// path in today's ESCAPE_LISTS, what that tree's template ships. Then they rewrite
// template/base/tools/lib/planted-shas.json, the union of every table's `planted` map, which
// gate-integrity reads in an install to ask whether a release planted an untracked escape
// list. That file is OWNED, so its sha belongs in the current table's `files`: --current
// writes it BEFORE it takes the owned map, and after --all you run --current (with --out,
// the file goes into <dir> beside the tables and the template is left alone).
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
// makes that carve-out list complete by construction rather than by inspection — and every
// escape list it records must be explained by the planted map, whatever its mode.
//
// Pure judgements: scripts/lib/released-shas.mjs. Git + extraction: scripts/lib/
// released-shas-history.mjs. The installer-side reader: installer/lib/provenance.mjs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderEntry, templateRoot, walkTemplate } from '../installer/lib/copy.mjs'
import { fileMode, installerVersion } from '../installer/lib/manifest.mjs'
import { DERIVED_AT_INSTALL, explains } from '../installer/lib/provenance.mjs'
import { ESCAPE_LISTS } from '../template/base/tools/lib/enforcement-surface.mjs'
import { LINEAGE_FLOOR, cmpDotted } from './lib/ramp-sites.mjs'
import { git, mapsOfTree, releaseCommits, withExtracted } from './lib/released-shas-history.mjs'
import {
  PLANTED_INSTALL_PATH,
  ownedMap,
  plantedFileText,
  plantedMap,
  plantedUnion,
  templateTrees,
  unionInto,
} from './lib/released-shas.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(templateRoot(), 'shas')
const plantedOut = args.includes('--out') ? join(outDir, 'planted-shas.json') : join(templateRoot(), 'base', PLANTED_INSTALL_PATH)

/** @typedef {{ owned: import('./lib/released-shas.mjs').OwnedMap, planted: import('./lib/released-shas.mjs').OwnedMap }} Maps */

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

/** Every table on disk, keyed by version. @returns {Map<string, import('./lib/released-shas.mjs').Table>} */
function readAllTables() {
  const tables = new Map()
  let names = []
  try {
    // Version tables only: with --out, planted-shas.json is written into the same directory.
    names = readdirSync(outDir)
      .filter((n) => /^\d+\.\d+\.\d+\.json$/.test(n))
      .sort()
  } catch {
    return tables
  }
  for (const name of names) {
    const table = readTable(name.slice(0, -'.json'.length))
    if (table !== null) tables.set(table.version, table)
  }
  return tables
}

/**
 * Rewrite tools/lib/planted-shas.json from the tables: every table on disk, with `pending`
 * standing in for the one of its version that has not been written yet.
 *
 * @param {import('./lib/released-shas.mjs').Table} [pending]
 */
function writePlanted(pending) {
  const tables = readAllTables()
  if (pending !== undefined) tables.set(pending.version, pending)
  const evidence = plantedUnion(tables.values())
  writeFileSync(plantedOut, plantedFileText(evidence))
  return Object.keys(evidence.files).length
}

/**
 * --prove: run the commit's OWN `init` (strict tier, non-default answers, a two-handle
 * owners value), then return every owned path whose recorded sha the owned map does not
 * explain, and every escape list whose recorded sha the planted map does not (1.1.0, #84).
 *
 * @param {string} dir @param {Maps} maps
 */
function unexplainedAfterInit(dir, { owned, planted }) {
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
    /** @param {string} ip @param {{ sha256: string }} meta @param {import('./lib/released-shas.mjs').OwnedMap} map */
    const unexplained = (ip, meta, map) =>
      !explains(map[ip] ?? [], { recordedSha: meta.sha256, current: readFileSync(join(scaffold, ip)), answers: manifest.answers ?? {} })
    /** @type {Array<[string, { mode: string, sha256: string }]>} */
    const entries = Object.entries(manifest.files)
    const ownedMisses = entries
      .filter(([ip, meta]) => meta.mode === 'owned' && !DERIVED_AT_INSTALL.has(ip))
      .filter(([ip, meta]) => unexplained(ip, meta, owned))
      .map(([ip]) => ip)
    const plantedMisses = entries
      .filter(([ip, meta]) => ESCAPE_LISTS.includes(ip) && typeof meta.sha256 === 'string')
      .filter(([ip, meta]) => unexplained(ip, meta, planted))
      .map(([ip]) => `${ip} (planted)`)
    return [...ownedMisses, ...plantedMisses].sort()
  } finally {
    rmSync(scaffold, { recursive: true, force: true })
  }
}

/** @param {string} commit @param {string} version @returns {Promise<Maps>} */
async function provedMapsOf(commit, version) {
  const label = `${commit.slice(0, 7)} (${version})`
  return withExtracted(ROOT, commit, async (dir) => {
    const maps = await mapsOfTree(dir, label)
    const unexplained = args.includes('--prove') ? unexplainedAfterInit(dir, maps) : []
    if (unexplained.length > 0) {
      throw new Error(`${label}: its own init records shas the maps do not explain: ${unexplained.join(', ')}`)
    }
    return maps
  })
}

async function generateAll() {
  /** @type {Map<string, import('./lib/released-shas.mjs').Table>} */
  const tables = new Map()
  // Most commits do not touch installer/ or template/: one extraction per distinct pair of
  // tree ids, not per commit.
  /** @type {Map<string, Maps>} */
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
    const maps = byTrees.get(trees) ?? (await provedMapsOf(commit, version))
    byTrees.set(trees, maps)
    tables.set(version, unionInto(tables.get(version) ?? readTable(version), version, maps.owned, maps.planted))
  }
  for (const table of tables.values()) writeTable(table)
  const plantedPaths = writePlanted()
  console.log(
    `generate-released-shas: ${String(tables.size)} table(s) from ${String(byTrees.size)} distinct tree(s): ${[...tables.keys()].join(' ')}; ${relative(ROOT, plantedOut)} lists ${String(plantedPaths)} planted path(s) — run --current next, so the current table lists its bytes`,
  )
  for (const s of skipped) console.log(`  skipped ${s}`)
  if (belowFloor > 0) console.log(`  skipped ${String(belowFloor)} commit(s) below the lineage floor ${LINEAGE_FLOOR}`)
}

/** @param {import('./lib/released-shas.mjs').Table | null} table */
const variantCount = (table) =>
  [table?.files, table?.planted].reduce((n, map) => n + Object.values(map ?? {}).reduce((m, variants) => m + variants.length, 0), 0)

function generateCurrent() {
  const version = installerVersion()
  const trees = templateTrees(templateRoot())
  const before = readTable(version)
  // The planted map and the evidence file FIRST: tools/lib/planted-shas.json is itself an
  // owned file, so its bytes must be final before the owned map hashes it.
  const planted = unionInto(before, version, {}, plantedMap({ trees, walkTemplate, renderEntry, paths: ESCAPE_LISTS }))
  const plantedPaths = writePlanted(planted)
  const table = unionInto(planted, version, ownedMap({ trees, walkTemplate, renderEntry, fileMode }))
  writeTable(table)
  console.log(
    `generate-released-shas: template/shas/${version}.json — ${String(Object.keys(table.files).length)} owned path(s), ${String(variantCount(table) - variantCount(before))} new variant(s); ${String(Object.keys(table.planted).length)} planted path(s); ${PLANTED_INSTALL_PATH} lists ${String(plantedPaths)}`,
  )
}

if (args.includes('--all')) await generateAll()
else if (args.includes('--current')) generateCurrent()
else {
  console.error('usage: generate-released-shas.mjs --current | --all [--prove] [--out <dir>]')
  process.exit(2)
}
