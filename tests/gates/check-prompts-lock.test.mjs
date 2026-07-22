// Can-fail proofs for the prompts gate (template/base/tools/check-prompts-lock.mjs).
// Every LLM prompt must be a versioned, hash-locked artifact: tools/prompts.lock.json
// maps prompt path -> sha256, prompt filenames carry an explicit .vN version, and the
// lock has no dangling entries. Fixture-driven like the schema-rls / route-manifest
// suites: build a scaffold-shaped tree, run the real gate with cwd inside it, assert
// the exact red/green. The GREEN case writes the SHIPPED prompt + SHIPPED lock verbatim,
// so it also proves the shipped lock hash actually matches the shipped prompt bytes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-prompts-lock.mjs', import.meta.url),
)
const SHIPPED_PROMPT = readFileSync(
  fileURLToPath(new URL('../../template/stack/packages/eval/prompts/extract.v1.md', import.meta.url)),
  'utf8',
)
const SHIPPED_LOCK = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/prompts.lock.json', import.meta.url)),
  'utf8',
)
const SHIPPED_PROMPT_PATH = 'packages/eval/prompts/extract.v1.md'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// prompts: POSIX-relative path -> file content (dirs created as needed).
// lock: object (JSON.stringify'd), raw string (written verbatim — for the bad-JSON
// case), or null to omit the lock file entirely (the LOCK-absent branch).
function fixture({ prompts = {}, lock = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-promptsgate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  for (const [rel, content] of Object.entries(prompts)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  if (lock !== null) {
    const text = typeof lock === 'string' ? lock : JSON.stringify(lock, null, 2)
    writeFileSync(join(dir, 'tools/prompts.lock.json'), text)
  }
  return dir
}

function runGate(dir) {
  const res = spawnSync('node', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: shipped prompt + shipped lock verbatim (proves the shipped lock matches the prompt bytes)', () => {
  const r = runGate(fixture({ prompts: { [SHIPPED_PROMPT_PATH]: SHIPPED_PROMPT }, lock: SHIPPED_LOCK }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('1 prompt(s) hash-locked and versioned'), r.out)
})

test('RED: tampered prompt content fails with a hash mismatch, naming the file', () => {
  const r = runGate(
    fixture({ prompts: { [SHIPPED_PROMPT_PATH]: `${SHIPPED_PROMPT}\ndrifted` }, lock: SHIPPED_LOCK }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(SHIPPED_PROMPT_PATH), r.out)
  assert.ok(r.out.includes('hash mismatch'), r.out)
})

test('RED: a prompt file present but absent from the lock is an unlocked production input', () => {
  const r = runGate(fixture({ prompts: { [SHIPPED_PROMPT_PATH]: SHIPPED_PROMPT }, lock: {} }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${SHIPPED_PROMPT_PATH} is not in tools/prompts.lock.json`), r.out)
  assert.ok(r.out.includes('every prompt must be hash-locked'), r.out)
})

test('RED: a lock entry with no corresponding file is a dangling reference', () => {
  const r = runGate(fixture({ prompts: {}, lock: { [SHIPPED_PROMPT_PATH]: sha256(SHIPPED_PROMPT) } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`references missing file ${SHIPPED_PROMPT_PATH}`), r.out)
})

test('RED: an unversioned filename that IS locked fails the version rule (not the hash rule)', () => {
  const rel = 'packages/eval/prompts/extract.md'
  const content = 'extract the fields\n'
  const r = runGate(fixture({ prompts: { [rel]: content }, lock: { [rel]: sha256(content) } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must carry an explicit version'), r.out)
  // Hash matches, so the version rule is what fires — not a mismatch.
  assert.ok(!r.out.includes('hash mismatch'), r.out)
})

test('CURRENT BEHAVIOR: an unversioned filename NOT in the lock reds on not-locked only — the version message is suppressed by the continue', () => {
  const rel = 'packages/eval/prompts/extract.md'
  const r = runGate(fixture({ prompts: { [rel]: 'extract the fields\n' }, lock: {} }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${rel} is not in tools/prompts.lock.json`), r.out)
  // The `continue` after the not-in-lock error skips the version check for this file.
  assert.ok(!r.out.includes('must carry an explicit version'), r.out)
})

test('RED: a malformed lock file fails LOUD and closed (never fail-open) with a FIX hint', () => {
  const r = runGate(fixture({ prompts: { [SHIPPED_PROMPT_PATH]: SHIPPED_PROMPT }, lock: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/prompts.lock.json is not valid JSON'), r.out)
  assert.ok(r.out.includes('FIX[prompts]:'), r.out)
})

test('GREEN: no prompt surface and no lock file passes with a zero count', () => {
  const r = runGate(fixture({ prompts: {}, lock: null }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('0 prompt(s) hash-locked and versioned'), r.out)
})

test('GREEN: an apps/*/prompts prompt, properly versioned and locked, is discovered and passes (apps scope)', () => {
  const rel = 'apps/mobile/prompts/summarize.v2.md'
  const content = 'summarize the note\n'
  const r = runGate(fixture({ prompts: { [rel]: content }, lock: { [rel]: sha256(content) } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('1 prompt(s) hash-locked and versioned'), r.out)
})

test('RED: multiple independent violations aggregate into one counted failure list', () => {
  const r = runGate(
    fixture({
      prompts: {
        'packages/eval/prompts/a.v1.md': 'A',
        'packages/eval/prompts/b.v1.md': 'B',
      },
      // a: wrong hash (mismatch); b: unlocked; c: dangling entry with no file.
      lock: {
        'packages/eval/prompts/a.v1.md': sha256('not-A'),
        'packages/eval/prompts/c.v1.md': sha256('anything'),
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('prompts: FAIL (3)'), r.out)
  assert.ok(r.out.includes('hash mismatch'), r.out)
  assert.ok(r.out.includes('b.v1.md is not in'), r.out)
  assert.ok(r.out.includes('references missing file packages/eval/prompts/c.v1.md'), r.out)
})
