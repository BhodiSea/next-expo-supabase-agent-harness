// In-process proofs for template/base/tools/lib/sql-fold-ramp.mjs (1.1.0, #75): the replay
// that tells a finding only the SQL history fold produces from one both readings produce.
//
// The gate fixtures (check-rls-manifest, check-tenancy, check-data-flow, check-db-limits,
// check-query-shapes) drive the whole path through real gates; these cases pin the lib's own
// contract in-process, where the lib coverage floor can see it, with a stand-in gate script
// whose twin reports a fixed list.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  foldOnlyFindings,
  foldTouches,
  historyFor,
  isTwin,
  withhold,
} from '../../template/base/tools/lib/sql-fold-ramp.mjs'

// A file: URL, never a path: a bare Windows path is not an import specifier.
const LIB = new URL('../../template/base/tools/lib/sql-fold-ramp.mjs', import.meta.url).href
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/**
 * A stand-in gate: in its twin it reports `twinFindings` through the lib; run as the gate it
 * would print, which these cases never do. `preamble` runs first in both.
 * @param {string[]} twinFindings @param {string} [preamble]
 */
function standInGate(twinFindings, preamble = '') {
  const dir = mkdtempSync(join(tmpdir(), 'epah-foldramp-'))
  made.push(dir)
  const file = join(dir, 'check-standin.mjs')
  writeFileSync(
    file,
    `import { foldOnlyFindings, isTwin } from ${JSON.stringify(LIB)}
${preamble}
console.log('twin output is drained, never shown')
if (isTwin()) await foldOnlyFindings(import.meta.url, [${JSON.stringify(twinFindings)}], true)
`,
  )
  return pathToFileURL(file).href
}

test('outside a worker nothing is the twin, and the history is judged as written', () => {
  assert.equal(isTwin(), false)
  const s = ['CREATE TABLE a (id int)', 'DROP TABLE a']
  assert.equal(historyFor(s), s)
})

test('foldTouches: only a DROP TABLE or an ALTER POLICY counts', () => {
  assert.equal(foldTouches(['CREATE TABLE a (id int)', 'DROP POLICY p ON a']), false)
  assert.equal(foldTouches(['CREATE TABLE a (id int)', 'DROP TABLE a']), true)
  assert.equal(foldTouches(['ALTER POLICY p ON a USING (true)']), true)
})

test('no replay when the history holds nothing the fold reads, or the gate found nothing', async () => {
  // A gate URL that does not exist: reaching the replay would report replayed: false.
  const nowhere = pathToFileURL(join(tmpdir(), 'epah-no-such-gate.mjs')).href
  assert.deepEqual(await foldOnlyFindings(nowhere, [['a finding']], false), {
    foldOnly: [],
    replayed: true,
  })
  assert.deepEqual(await foldOnlyFindings(nowhere, [[], []], true), {
    foldOnly: [],
    replayed: true,
  })
})

test('the replay splits: both readings → hard, fold only → lifted, numbers masked', async () => {
  const gate = standInGate(['t: 3 policies enforce aal2', 'old: a dropped policy is vacuous'])
  const r = await foldOnlyFindings(
    gate,
    [['t: 2 policies enforce aal2', 'new: a rewritten policy is vacuous'], ['new: a rewritten policy is vacuous']],
    true,
  )
  assert.equal(r.replayed, true)
  // Deduplicated, in the gate's order; the count moved with the fold and still matches.
  assert.deepEqual(r.foldOnly, ['new: a rewritten policy is vacuous'])
})

test('a twin that ends without reporting lifts nothing (fail closed)', async () => {
  const gate = standInGate(['never sent'], 'process.exit(1)')
  const r = await foldOnlyFindings(gate, [['x: a finding']], true)
  assert.deepEqual(r, { foldOnly: [], replayed: false })
  const thrown = standInGate(['never sent'], "throw new Error('the twin died')")
  assert.deepEqual(await foldOnlyFindings(thrown, [['x: a finding']], true), {
    foldOnly: [],
    replayed: false,
  })
})

test('withhold removes each withheld finding from every list, in place', () => {
  const errs = ['a', 'b', 'c']
  const ramped = ['b', 'd']
  withhold([errs, ramped], ['b', 'c'])
  assert.deepEqual(errs, ['a'])
  assert.deepEqual(ramped, ['d'])
})
