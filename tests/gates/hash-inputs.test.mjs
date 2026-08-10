// Regression armor for hashInputs in template/base/tools/lib/gate.mjs: the stamp
// digest is one sha256 over the declared input paths (name+bytes, sorted walk,
// STAMP_EXCLUDES pruned, missing paths tokenized). Only the DECLARED path strings
// enter the hash — never the absolute fixture location — so a fixed relative tree
// pins an exact machine-independent digest. A silent change to walk order,
// separators, exclude semantics, or the missing token would flip the vector and
// go red here instead of stale-passing a gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashInputs } from '../../template/base/tools/lib/gate.mjs'

// The fixed vector tree: stable relative names and contents, including a
// binary file and a nested sibling pair that exercises the sorted walk.
const VECTOR_FILES = {
  'top.txt': 'top\n',
  'vec/a.txt': 'alpha\n',
  'vec/b/c.txt': 'gamma\n',
  'vec/b/d.txt': 'delta\n',
  'vec/z.bin': Buffer.from([0x00, 0x01, 0xfe, 0xff]),
}
// 'ghost.md' is deliberately never created: a declared-but-missing input.
const VECTOR_INPUTS = ['vec', 'top.txt', 'ghost.md']

// PINNED: sha256 over exactly this stream (inputs sorted; per file: POSIX path
// then bytes; missing path: `missing:<path>`). If this literal drifts without a
// deliberate contract change, every stamped gate risks a stale pass.
const VECTOR_DIGEST = 'd31eaa3c611db222ad6b0474f4ce798923d7842ec6d86340f1b54cc1c2d94de4'

function materialize(files) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-hashinputs-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

// hashInputs resolves declared paths against cwd, so every case runs chdir'd
// into its own fixture (node:test runs a file's tests serially by default).
function withFixture(files, fn) {
  const dir = materialize(files)
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return fn(dir)
  } finally {
    process.chdir(prev)
  }
}

test('pinned vector: fixed tree + file + missing input hashes to the exact digest', () => {
  withFixture(VECTOR_FILES, () => {
    assert.equal(hashInputs(VECTOR_INPUTS), VECTOR_DIGEST)
  })
})

test('the vector digest is the documented stream: sorted inputs, path-then-bytes per file', () => {
  // Independent oracle mirroring the contract, so a red pinned vector can be
  // triaged: literal drift vs deliberate stream change.
  const h = createHash('sha256')
  h.update('missing:ghost.md')
  h.update('top.txt')
  h.update(VECTOR_FILES['top.txt'])
  for (const rel of ['vec/a.txt', 'vec/b/c.txt', 'vec/b/d.txt', 'vec/z.bin']) {
    h.update(rel)
    h.update(VECTOR_FILES[rel])
  }
  assert.equal(h.digest('hex'), VECTOR_DIGEST)
})

test('a missing declared input contributes missing:<path>; appearing invalidates', () => {
  withFixture({}, (dir) => {
    const expected = createHash('sha256').update('missing:ghost.md').digest('hex')
    assert.equal(hashInputs(['ghost.md']), expected)
    // Deterministic: same missing set, same digest.
    assert.equal(hashInputs(['ghost.md']), hashInputs(['ghost.md']))
    // The path appearing — even as an EMPTY file — must flip the digest.
    writeFileSync(join(dir, 'ghost.md'), '')
    assert.notEqual(hashInputs(['ghost.md']), expected)
    // ...and disappearing again must restore the missing-token digest.
    rmSync(join(dir, 'ghost.md'))
    assert.equal(hashInputs(['ghost.md']), expected)
  })
})

test('STAMP_EXCLUDES dirs never affect the digest, at any depth', () => {
  withFixture(VECTOR_FILES, (dir) => {
    const base = hashInputs(VECTOR_INPUTS)
    for (const excluded of ['node_modules', 'target', 'dist', 'gen', 'test-results', '.next', '.expo', '.turbo', 'coverage', '.git']) {
      mkdirSync(join(dir, 'vec', excluded, 'deep'), { recursive: true })
      writeFileSync(join(dir, 'vec', excluded, 'deep', 'junk.txt'), 'churn\n')
    }
    // Excludes prune by directory NAME at every depth, not just the root.
    mkdirSync(join(dir, 'vec', 'b', 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'vec', 'b', 'node_modules', 'pkg.json'), '{}\n')
    assert.equal(hashInputs(VECTOR_INPUTS), base)
    // Control: the same churn in a NON-excluded dir must invalidate.
    mkdirSync(join(dir, 'vec', 'src'), { recursive: true })
    writeFileSync(join(dir, 'vec', 'src', 'junk.txt'), 'churn\n')
    assert.notEqual(hashInputs(VECTOR_INPUTS), base)
  })
})

test('declared input order does not matter: paths are sorted before hashing', () => {
  withFixture(VECTOR_FILES, () => {
    const permutations = [
      ['vec', 'top.txt', 'ghost.md'],
      ['ghost.md', 'vec', 'top.txt'],
      ['top.txt', 'ghost.md', 'vec'],
    ]
    for (const perm of permutations) {
      assert.equal(hashInputs(perm), VECTOR_DIGEST, `order ${perm.join(',')} must not change the digest`)
    }
  })
})

test('name+bytes contract: identical bytes at a different path is a different digest', () => {
  withFixture({ 'one.txt': 'same bytes\n', 'two.txt': 'same bytes\n' }, () => {
    assert.notEqual(hashInputs(['one.txt']), hashInputs(['two.txt']))
  })
})

test('empty input list is the empty-stream sha256 (degenerate but deterministic)', () => {
  withFixture({}, () => {
    assert.equal(hashInputs([]), createHash('sha256').digest('hex'))
  })
})
