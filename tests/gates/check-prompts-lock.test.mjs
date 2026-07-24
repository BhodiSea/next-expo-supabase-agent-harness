// Can-fail proofs for the prompts gate (template/base/tools/check-prompts-lock.mjs).
// This lineage ships NO prompts (the eval package was dropped), so the fixtures SYNTHESIZE
// prompt files + locks rather than reading a shipped one: build a scaffold-shaped tree
// (prompts under packages/*/prompts/**, a tools/prompts.lock.json), run the real gate with
// cwd inside it, and assert the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-prompts-lock.mjs', import.meta.url),
)
const sha = (s) => createHash('sha256').update(s).digest('hex')

function run(dir) {
  return spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8' })
}

// { prompts?: {relPath: content}, lock?: {relPath: sha} }
function scaffold({ prompts = {}, lock = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/prompts.lock.json'), JSON.stringify(lock, null, 2))
  for (const [rel, content] of Object.entries(prompts)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const PROMPT = 'packages/notes/prompts/summarize.v1.md'
const BODY = '# summarize\nSummarize the note in one sentence.\n'

test('GREEN — no prompts, empty lock → passes (0 prompts)', () => {
  const r = run(scaffold())
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /0 prompt\(s\) hash-locked/)
})

test('GREEN — a versioned prompt whose lock hash matches passes', () => {
  const r = run(scaffold({ prompts: { [PROMPT]: BODY }, lock: { [PROMPT]: sha(BODY) } }))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /1 prompt\(s\) hash-locked and versioned/)
})

test('RED — a prompt not in the lock reds (every prompt must be hash-locked)', () => {
  const r = run(scaffold({ prompts: { [PROMPT]: BODY }, lock: {} }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, new RegExp(`${PROMPT.replace(/\./g, '\\.')} is not in`))
  assert.match(r.stderr, /every prompt must be hash-locked/)
})

test('RED — a changed prompt (hash mismatch) reds', () => {
  const r = run(
    scaffold({ prompts: { [PROMPT]: `${BODY}drifted` }, lock: { [PROMPT]: sha(BODY) } }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /hash mismatch/)
})

test('RED — a lock entry for a file that does not exist reds', () => {
  const r = run(scaffold({ lock: { 'packages/gone/prompts/x.v1.md': sha('x') } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /references missing file packages\/gone\/prompts\/x\.v1\.md/)
})

test('RED — an unversioned prompt filename reds (must carry an explicit vN)', () => {
  const UNVERSIONED = 'packages/notes/prompts/summarize.md'
  const r = run(
    scaffold({ prompts: { [UNVERSIONED]: BODY }, lock: { [UNVERSIONED]: sha(BODY) } }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /must carry an explicit version/)
})
