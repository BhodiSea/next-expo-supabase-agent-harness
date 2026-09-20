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
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderEntry, walkTemplate } from '../../installer/lib/copy.mjs'
import { fileMode } from '../../installer/lib/manifest.mjs'
import { VINTAGES } from '../../scripts/lib/ramp-sites.mjs'
import { lintTable, missingFrom, missingVersions, ownedMap, templateTrees, unionInto } from '../../scripts/lib/released-shas.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-released-shas.mjs', import.meta.url))
const TABLES = fileURLToPath(new URL('../../template/shas/', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

/** @param {string[]} args */
function run(args = []) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** A writable copy of the shipped tables, doctored by `mutate(dir)`. */
/** @param {(dir: string) => void} mutate */
function doctored(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-shas-'))
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
