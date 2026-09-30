// Can-fail proofs for scripts/check-released-shas.mjs and the pure judgements under it
// (scripts/lib/released-shas.mjs).
//
// The released-sha tables are what lets `update` tell a file a release shipped from a fork
// whose sha was re-recorded (installer/lib/provenance.mjs). A table that has drifted from
// the template fails in the quiet direction — it PARKS files nobody touched, on every
// install, at the next update — so the closure has to be able to go red on a pull request:
// the live tree inside the current version's table, a table for every released vintage,
// and a shape nothing hand-edited.
//
// No git, no tar, no tags: the canary closure executes this file on the Windows leg too.
// The tag half of the gate (--verify-tags) is proved where tags exist — lint.yml.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderEntry, walkTemplate } from '../../installer/lib/copy.mjs'
import { fileMode } from '../../installer/lib/manifest.mjs'
import { VINTAGES } from '../../scripts/lib/ramp-sites.mjs'
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
  unionInto,
} from '../../scripts/lib/released-shas.mjs'
import { ESCAPE_LISTS } from '../../template/base/tools/lib/enforcement-surface.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-released-shas.mjs', import.meta.url))
const TABLES = fileURLToPath(new URL('../../template/shas/', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

/** @param {string[]} args */
function run(args = []) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// Every scratch directory this file makes, removed once the file is done.
/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A writable copy of the shipped tables, doctored by `mutate(dir)`. */
/** @param {(dir: string) => void} mutate */
function doctored(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-shas-'))
  made.push(dir)
  cpSync(TABLES, dir, { recursive: true })
  mutate(dir)
  return dir
}

/** @param {string} dir @param {string} version @param {(table: any) => any} edit */
function editTable(dir, version, edit) {
  const path = join(dir, `${version}.json`)
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8'))), null, 2)}\n`)
}

const live = () => ownedMap({ trees: templateTrees(TEMPLATE), walkTemplate, renderEntry, fileMode })
const livePlanted = () => plantedMap({ trees: templateTrees(TEMPLATE), walkTemplate, renderEntry, paths: ESCAPE_LISTS })
const PLANTED = fileURLToPath(new URL(`../../template/base/${PLANTED_INSTALL_PATH}`, import.meta.url))

/** Every shipped table, parsed. */
const shippedTables = () =>
  readdirSync(TABLES)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(TABLES, n), 'utf8')))

/** A writable copy of the shipped tools/lib/planted-shas.json, doctored by `edit`. */
/** @param {(evidence: any) => any} edit */
function doctoredPlanted(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-planted-'))
  made.push(dir)
  const path = join(dir, 'planted-shas.json')
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(PLANTED, 'utf8'))), null, 2)}\n`)
  return path
}

test('GREEN: the shipped tables close over the live template and every released vintage', () => {
  const res = run()
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /released-shas: OK/)
})

test('the walk is not vacuous: hundreds of owned paths, and the placeholder-bearing ones carry sites', () => {
  const map = live()
  const paths = Object.keys(map)
  assert.ok(paths.length >= 250, `only ${String(paths.length)} owned path(s) — the walker is broken`)
  assert.ok(paths.filter((p) => map[p][0].sites).length >= 20)
  assert.ok(map['tools/exports-walls.json'], 'the one owned file under stack/ must be walked')
})

test('RED: a live file whose sha the current table does not list — the table went stale', () => {
  const dir = doctored((d) =>
    editTable(d, VERSION, (table) => {
      table.files['tools/validate.mjs'] = [{ sha256: 'f'.repeat(64) }]
      return table
    }),
  )
  const res = run(['--tables-dir', dir])
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /tools\/validate\.mjs ships sha256/)
  assert.match(res.out, /generate-released-shas\.mjs --current/, 'the failure must name the remedy')
})

test('RED: a released vintage with no table', () => {
  const victim = VINTAGES.at(-1)
  const dir = doctored((d) => rmSync(join(d, `${victim}.json`)))
  const res = run(['--tables-dir', dir])
  assert.equal(res.code, 1, res.out)
  assert.ok(res.out.includes(`${victim}`) && /no released-sha table/.test(res.out), res.out)
})

test('RED: a hand-edited table — unsorted paths, or a token in its braced form', () => {
  const unsorted = doctored((d) =>
    editTable(d, VERSION, (table) => ({ ...table, files: Object.fromEntries(Object.entries(table.files).reverse()) })),
  )
  const a = run(['--tables-dir', unsorted])
  assert.equal(a.code, 1, a.out)
  assert.match(a.out, /paths are not sorted/)

  const braced = doctored((d) =>
    editTable(d, VERSION, (table) => {
      const path = Object.keys(table.files).find((p) => table.files[p][0].sites)
      table.files[path][0].sites[0][1] = '{{DEFAULT_BRANCH}}'
      return table
    }),
  )
  const b = run(['--tables-dir', braced])
  assert.equal(b.code, 1, b.out)
  assert.match(b.out, /braced token/)
})

test('unionInto only ever GROWS a table, and its output is sorted and stable', () => {
  const first = unionInto(null, '9.9.9', { 'b.mjs': [{ sha256: 'b'.repeat(64) }], 'a.mjs': [{ sha256: 'c'.repeat(64) }] })
  assert.deepEqual(Object.keys(first.files), ['a.mjs', 'b.mjs'])
  const second = unionInto(first, '9.9.9', { 'a.mjs': [{ sha256: 'a'.repeat(64) }, { sha256: 'c'.repeat(64) }] })
  assert.deepEqual(
    second.files['a.mjs'].map((v) => v.sha256[0]),
    ['a', 'c'],
    'a new variant is added, a known one is not duplicated, and variants sort by sha',
  )
  assert.deepEqual(second.files['b.mjs'], first.files['b.mjs'], 'a path the new tree dropped keeps its variants')
  assert.deepEqual(unionInto(second, '9.9.9', {}), second, 'folding nothing in changes nothing')
  assert.deepEqual(lintTable('9.9.9.json', second, JSON.stringify(second)), [])
})

test('missingFrom / missingVersions / lintTable name exactly what is wrong', () => {
  const table = unionInto(null, '9.9.9', { 'a.mjs': [{ sha256: 'a'.repeat(64) }] })
  assert.deepEqual(missingFrom({ 'a.mjs': [{ sha256: 'a'.repeat(64) }] }, table, 'live tree'), [])
  assert.match(missingFrom({ 'a.mjs': [{ sha256: 'd'.repeat(64) }] }, table, 'live tree')[0], /live tree: a\.mjs ships sha256 dddddddddddd…/)
  assert.match(missingFrom({}, null, 'tag v9.9.9')[0], /no released-sha table exists/)
  assert.deepEqual(missingVersions(['1.0.0', '1.0.1'], '1.0.2', ['1.0.0', '1.0.2']), ['1.0.1'])
  assert.match(lintTable('9.9.8.json', table, '')[0], /"version" field says 9\.9\.9/)
  assert.match(lintTable('x.json', { version: 'x', files: { 'a.mjs': [] } }, '')[0], /has no variants/)
  assert.match(lintTable('x.json', null, '')[0], /not a \{ version, files \} table/)
})

// ── the planted map (1.1.0, #84) ─────────────────────────────────────────────────
// gate-integrity's escape-list plant rule asks tools/lib/planted-shas.json whether a harness
// release planted the bytes of an untracked escape list. That file is the union of every
// table's `planted` map, and each map is what a commit's own template ships for every path in
// today's ESCAPE_LISTS. The closure must be able to go red in both directions: the shipped
// evidence file drifts from the tables, or the live tree ships an escape-list variant the
// current table's `planted` map does not list.

test('the planted walk is not vacuous: every shipped escape list, the placeholder-bearing ones with sites', () => {
  const map = livePlanted()
  const paths = Object.keys(map)
  assert.ok(paths.length >= 30, `only ${String(paths.length)} planted path(s) — the walker is broken`)
  for (const p of paths) assert.ok(ESCAPE_LISTS.includes(p), `${p} is not an escape list`)
  assert.ok(map['tools/rls-exempt.json']?.[0]?.sites, 'rls-exempt.json carries SECURITY_OWNERS, so its variant has sites')
  assert.ok(map['tools/backup-posture.json']?.[0]?.sites, 'backup-posture.json carries SECURITY_OWNERS, so its variant has sites')
  assert.equal(map['tools/secret-scan-allow.json'], undefined, 'a tolerated-absent list the template never ships is never planted')
})

test('every shipped table carries a planted map, and the current one lists every live escape-list variant', () => {
  const current = JSON.parse(readFileSync(join(TABLES, `${VERSION}.json`), 'utf8'))
  assert.deepEqual(missingFrom(livePlanted(), current, 'live tree', 'planted'), [])
  for (const table of shippedTables()) {
    assert.equal(typeof table.planted, 'object', `${table.version}.json has no planted map`)
  }
})

test('the shipped tools/lib/planted-shas.json is exactly the generated union of the tables', () => {
  assert.equal(readFileSync(PLANTED, 'utf8'), plantedFileText(plantedUnion(shippedTables())))
  assert.ok(!readFileSync(PLANTED, 'utf8').includes('{{'), 'the evidence file carries bare token names only')
})

test('RED: a doctored copy of tools/lib/planted-shas.json — a widened variant, or a dropped path', () => {
  const widened = doctoredPlanted((evidence) => {
    evidence.files['tools/approved-tools.json'].push({ sha256: 'e'.repeat(64) })
    return evidence
  })
  const a = run(['--planted-file', widened])
  assert.equal(a.code, 1, a.out)
  assert.match(a.out, /planted-shas\.json is not the union of the tables' planted maps/)
  assert.match(a.out, /generate-released-shas\.mjs --current/, 'the failure must name the remedy')

  const dropped = doctoredPlanted((evidence) => {
    delete evidence.files['tools/rls-exempt.json']
    return evidence
  })
  const b = run(['--planted-file', dropped])
  assert.equal(b.code, 1, b.out)
  assert.match(b.out, /planted-shas\.json is not the union/)
})

test('RED: a live escape-list variant the current table does not list under planted', () => {
  const dir = doctored((d) =>
    editTable(d, VERSION, (table) => {
      table.planted['tools/rls-exempt.json'] = [{ sha256: 'f'.repeat(64) }]
      return table
    }),
  )
  const res = run(['--tables-dir', dir])
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /live tree: tools\/rls-exempt\.json plants sha256 [0-9a-f]{12}… and template\/shas\/[\d.]+\.json does not list it under planted/)
})

test('RED: a table with no planted map, or an unsorted one', () => {
  const missing = doctored((d) =>
    editTable(d, VERSION, (table) => {
      delete table.planted
      return table
    }),
  )
  const a = run(['--tables-dir', missing])
  assert.equal(a.code, 1, a.out)
  assert.match(a.out, /has no planted map/)

  const unsorted = doctored((d) =>
    editTable(d, VERSION, (table) => ({ ...table, planted: Object.fromEntries(Object.entries(table.planted).reverse()) })),
  )
  const b = run(['--tables-dir', unsorted])
  assert.equal(b.code, 1, b.out)
  assert.match(b.out, /planted paths are not sorted/)
})

test('unionInto folds a planted map beside files, additively, and plantedUnion merges every table', () => {
  const first = unionInto(null, '9.9.9', { 'a.mjs': [{ sha256: 'a'.repeat(64) }] }, { 'tools/x.json': [{ sha256: 'c'.repeat(64) }] })
  assert.deepEqual(Object.keys(first), ['//', 'version', 'files', 'planted'])
  const second = unionInto(first, '9.9.9', {}, { 'tools/x.json': [{ sha256: 'b'.repeat(64) }] })
  assert.deepEqual(second.files, first.files, 'folding only a planted map leaves files alone')
  assert.deepEqual(
    second.planted['tools/x.json'].map((v) => v.sha256[0]),
    ['b', 'c'],
  )
  assert.deepEqual(unionInto(second, '9.9.9', {}), second, 'folding nothing in changes nothing')
  assert.deepEqual(lintTable('9.9.9.json', second, JSON.stringify(second)), [])
  const older = unionInto(null, '9.9.8', {}, { 'tools/y.json': [{ sha256: 'd'.repeat(64), sites: [[3, 'SECURITY_OWNERS']] }] })
  const union = plantedUnion([second, older])
  assert.deepEqual(Object.keys(union.files), ['tools/x.json', 'tools/y.json'])
  assert.deepEqual(union.files['tools/y.json'], [{ sha256: 'd'.repeat(64), sites: [[3, 'SECURITY_OWNERS']] }])
  assert.match(plantedFileText(union), /"sites": \[\[3, "SECURITY_OWNERS"\]\]/, 'sites stay on one line, the way the formatter writes them')
  assert.deepEqual(JSON.parse(plantedFileText(union)), union)
  assert.match(missingFrom({ 'tools/x.json': [{ sha256: 'e'.repeat(64) }] }, second, 'live tree', 'planted')[0], /does not list it under planted/)
})
