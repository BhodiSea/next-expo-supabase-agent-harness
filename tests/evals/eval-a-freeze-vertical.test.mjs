// The blind-vertical freeze script (2.1.0, #188): `--check` validates a frozen vertical, and
// a freeze writes one that passes it. A dummy vertical stands in for the real ones, which
// the maintainer generates (#194).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { checkVertical, freezeVertical, main } from '../../scripts/eval-a-freeze-vertical.mjs'
import { writeManifest } from '../../scripts/lib/evals.mjs'

const made = []
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-eval-vertical-'))
  made.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

const DUMMY = {
  'packages/verticals/bookmarks/package.json': '{ "name": "@app/bookmarks" }\n',
  'packages/verticals/bookmarks/src/index.ts': 'export function bookmarkTitle(t: string): string {\n  return t.trim()\n}\n',
  'packages/verticals/bookmarks/src/index.test.ts': 'test\n',
  'supabase/migrations/20260901000000_bookmarks.sql': 'create table public.bookmarks (id uuid primary key);\n',
  '.dependency-cruiser.cjs': 'module.exports = { forbidden: [] }\n',
  'apps/web/postcss.config.mjs': 'export default {}\n',
}

test('--check: a dummy vertical frozen by the script passes', () => {
  const holdout = tree({})
  assert.deepEqual(freezeVertical(tree(DUMMY), 1, holdout), [])
  const frozen = join(holdout, 'vertical-1')
  assert.deepEqual(checkVertical(frozen), [])
  assert.equal(main(['--check', frozen]), 0)
})

test('--check: a changed file, a JavaScript file and a tree with no vertical each fail', () => {
  const holdout = tree({})
  freezeVertical(tree(DUMMY), 2, holdout)
  const frozen = join(holdout, 'vertical-2')
  writeFileSync(join(frozen, 'packages/verticals/bookmarks/src/index.ts'), 'export {}\n')
  assert.deepEqual(checkVertical(frozen), ['changed: packages/verticals/bookmarks/src/index.ts'])

  const js = tree({ ...DUMMY, 'packages/verticals/bookmarks/src/x.mjs': 'export {}\n' })
  writeManifest(js, `${js}.sha256`)
  made.push(`${js}.sha256`)
  assert.deepEqual(checkVertical(js), ['JavaScript in a frozen tree: .dependency-cruiser.cjs', 'JavaScript in a frozen tree: apps/web/postcss.config.mjs', 'JavaScript in a frozen tree: packages/verticals/bookmarks/src/x.mjs'])

  const none = tree({ 'packages/api/src/a.ts': 'export {}\n' })
  writeManifest(none, `${none}.sha256`)
  made.push(`${none}.sha256`)
  assert.match(checkVertical(none).join('\n'), /no vertical/)
  assert.equal(main(['--check', none]), 1)
})

test('a freeze keeps only what the sweep reads, stores the .cjs as .cjs.txt, and never refreezes', () => {
  const holdout = tree({})
  const from = tree(DUMMY)
  freezeVertical(from, 3, holdout)
  const frozen = join(holdout, 'vertical-3')
  assert.deepEqual(checkVertical(frozen), [])
  assert.match(freezeVertical(from, 3, holdout)[0], /exists/)
  assert.equal(main(['--from', from]), 1, 'usage')
})
