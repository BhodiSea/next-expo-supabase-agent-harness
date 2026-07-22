// Unit tests for the installer's shared recursive walker
// (installer/lib/fs-walk.mjs): deterministic depth-first output with
// code-unit-sorted siblings, excludeDirs pruning by entry name at every
// depth, POSIX-relative paths on every OS, filter over relative paths,
// and [] for a missing/unreadable root.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { walkFiles } from '../../installer/lib/fs-walk.mjs'

// Build a fixture tree from POSIX-relative file specs, in the given order —
// creation order is the variable under test for determinism.
function makeTree(prefix, relFiles) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const rel of relFiles) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `// ${rel}\n`)
  }
  return root
}

test('depth-first with per-directory code-unit sort: dirs recurse at their sorted slot, uppercase before lowercase', () => {
  const root = makeTree('tpah-walk-order-', [
    'c.txt',
    'd/x.txt',
    'B.txt',
    'a/z.txt',
    'a/k/deep.txt',
  ])
  // Root siblings sort as B.txt < a < c.txt < d (UTF-16 code units), and each
  // directory's contents are emitted in full before the next sibling.
  assert.deepEqual(walkFiles(root), [
    'B.txt',
    'a/k/deep.txt',
    'a/z.txt',
    'c.txt',
    'd/x.txt',
  ])
})

test('output is identical across differing creation orders', () => {
  const files = [
    'zeta.mjs',
    'pkg/inner/leaf.txt',
    'pkg/alpha.txt',
    'alpha.txt',
    'pkg/inner/aardvark.txt',
  ]
  const forward = makeTree('tpah-walk-fwd-', files)
  const reverse = makeTree('tpah-walk-rev-', [...files].reverse())
  const expected = [
    'alpha.txt',
    'pkg/alpha.txt',
    'pkg/inner/aardvark.txt',
    'pkg/inner/leaf.txt',
    'zeta.mjs',
  ]
  assert.deepEqual(walkFiles(forward), expected)
  assert.deepEqual(walkFiles(reverse), expected)
})

test('excludeDirs prunes matching directory names at every depth', () => {
  const root = makeTree('tpah-walk-excl-', [
    'keep.txt',
    'node_modules/dep/index.js',
    'apps/web/src/main.ts',
    'apps/web/node_modules/nested-dep/index.js',
    'apps/web/dist/bundle.js',
  ])
  const expected = [
    'apps/web/src/main.ts',
    'keep.txt',
  ]
  assert.deepEqual(walkFiles(root, { excludeDirs: ['node_modules', 'dist'] }), expected)
  // Any iterable works — the walker builds its own Set.
  assert.deepEqual(walkFiles(root, { excludeDirs: new Set(['node_modules', 'dist']) }), expected)
})

test('excludeDirs prunes DIRECTORIES only — a plain FILE with an excluded name is kept', () => {
  // Unified semantics with template/base/tools/lib/fs-walk.mjs: exclusion is
  // directory pruning, never file filtering (that is what `filter` is for).
  const root = makeTree('tpah-walk-exclfile-', [
    'docs/node_modules',
    'docs/readme.md',
  ])
  assert.deepEqual(walkFiles(root, { excludeDirs: ['node_modules'] }), [
    'docs/node_modules',
    'docs/readme.md',
  ])
})

test('returned paths are POSIX-relative: no backslashes, no root prefix, on every OS', () => {
  const root = makeTree('tpah-walk-posix-', [
    'a/b/c/deep.txt',
    'a/top.txt',
    'solo.txt',
  ])
  const paths = walkFiles(root)
  assert.deepEqual(paths, ['a/b/c/deep.txt', 'a/top.txt', 'solo.txt'])
  for (const p of paths) {
    assert.ok(!p.includes('\\'), `backslash leaked into walker output: ${p}`)
    assert.ok(!p.startsWith('/') && !/^[A-Za-z]:/.test(p), `path is not relative: ${p}`)
  }
})

test('filter sees the POSIX relative path of every file and gates output', () => {
  const root = makeTree('tpah-walk-filter-', [
    'gate.mjs',
    'notes.md',
    'sub/dir/tool.mjs',
    'sub/dir/data.json',
  ])
  const seen = []
  const out = walkFiles(root, {
    filter: (rel) => {
      seen.push(rel)
      return rel.endsWith('.mjs')
    },
  })
  assert.deepEqual(out, ['gate.mjs', 'sub/dir/tool.mjs'])
  // The filter is consulted for every file (never for directories), with the
  // same POSIX-relative form the walker returns.
  assert.deepEqual(seen, ['gate.mjs', 'notes.md', 'sub/dir/data.json', 'sub/dir/tool.mjs'])
})

test('missing root returns [] (surface-absence policy belongs to the caller)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpah-walk-missing-'))
  assert.deepEqual(walkFiles(join(root, 'does-not-exist')), [])
})

test('a root that is a file (not a directory) also returns []', () => {
  const root = makeTree('tpah-walk-fileroot-', ['plain.txt'])
  assert.deepEqual(walkFiles(join(root, 'plain.txt')), [])
})
