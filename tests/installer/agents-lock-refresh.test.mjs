// THE AGENT-SURFACE LOCK ACROSS AN UPDATE (0.3.0).
//
// Found by the upgrade lane, not by reading the plan — which is the whole reason that lane
// exists. The lock's `adopt` rule (never rewrite an existing lock) is RIGHT about a
// consumer's edits and WRONG about the harness's own: when `update` overwrites an OWNED
// agent-surface file — the 0.3.0 doctrine repair rewrote ten of them — the lock still
// describes the old bytes, so `prompts` reds on every consumer for a change they did not
// make, cannot review, and could only clear by running the very generator three separate
// guards exist to keep them from running.
//
// The fix is per-entry and the distinction is decidable: `update` writes an owned file
// only when its on-disk bytes still matched the recorded sha, i.e. the consumer had not
// touched it. A locally-modified agent file drifts, is parked, is absent from `written`,
// and keeps redding — because that edit is exactly what the lock exists to surface.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { refreshAgentsLockEntries } from '../../installer/lib/agents-lock.mjs'

const sha = (s) => createHash('sha256').update(s).digest('hex')

/** An install-shaped tree with a lock recorded over the CURRENT bytes. */
function fixture({ files = {}, models = {}, lock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-lockrefresh-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  writeFileSync(
    join(dir, 'tools/agents.lock.json'),
    `${JSON.stringify(lock ?? { comment: 'x', models, files: {} }, null, 2)}\n`,
  )
  return dir
}

const readLock = (dir) => JSON.parse(readFileSync(join(dir, 'tools/agents.lock.json'), 'utf8'))

test('an agent file THIS update rewrote is re-recorded — the consumer never sees a mismatch', () => {
  const rel = '.claude/commands/new-action.md'
  const dir = fixture({ files: { [rel]: 'the NEW instructions\n' }, lock: { files: { [rel]: sha('the OLD instructions\n') } } })
  const report = { notes: [] }

  const n = refreshAgentsLockEntries(dir, [rel], report)
  assert.equal(n, 1)
  assert.equal(readLock(dir).files[rel], sha('the NEW instructions\n'))
  assert.match(report.notes[0], /re-recorded 1 entry/)
  assert.match(report.notes[0], /Locally-modified agent files were parked, not re-recorded/)
})

test('a file the update did NOT write keeps its old hash — a consumer edit stays visible', () => {
  // The load-bearing case. A locally-modified agent file drifts, gets parked, and is
  // absent from `written`. Re-recording it here would launder the edit, which is the exact
  // failure the whole lock exists to prevent.
  const rewritten = '.claude/commands/new-action.md'
  const edited = '.claude/agents/security-reviewer.md'
  const dir = fixture({
    files: { [rewritten]: 'new\n', [edited]: 'the consumer softened this\n' },
    lock: { files: { [rewritten]: sha('old\n'), [edited]: sha('the harness wrote this\n') } },
  })

  refreshAgentsLockEntries(dir, [rewritten], { notes: [] })
  const lock = readLock(dir)
  assert.equal(lock.files[rewritten], sha('new\n'), 'the rewritten file moves')
  assert.equal(
    lock.files[edited],
    sha('the harness wrote this\n'),
    'the consumer-edited file must KEEP its old hash so `prompts` still reds on it',
  )
})

test('the MODEL pin travels with the file it was recorded for', () => {
  // A roster entry repointed from a frontier model to a cheap one leaves every byte of the
  // instructions identical — which is why the model is locked alongside the hash.
  const rel = '.claude/agents/security-reviewer.md'
  const dir = fixture({
    files: { [rel]: '---\nname: security-reviewer\nmodel: opus\n---\n\nbody\n' },
    lock: { models: { 'security-reviewer': 'haiku' }, files: { [rel]: sha('old') } },
  })
  refreshAgentsLockEntries(dir, [rel], { notes: [] })
  assert.equal(readLock(dir).models['security-reviewer'], 'opus')
})

test('non-agent-surface writes are ignored entirely', () => {
  const dir = fixture({ files: { 'tools/check-x.mjs': 'x\n' }, lock: { files: {} } })
  const report = { notes: [] }
  assert.equal(refreshAgentsLockEntries(dir, ['tools/check-x.mjs', 'README.md'], report), 0)
  assert.deepEqual(report.notes, [])
})

test('a dry run writes nothing; a missing or corrupt lock is left to the `prompts` gate', () => {
  const rel = '.claude/commands/new-action.md'
  const dry = fixture({ files: { [rel]: 'new\n' }, lock: { files: { [rel]: sha('old\n') } } })
  assert.equal(refreshAgentsLockEntries(dry, [rel], { notes: [] }, { dryRun: true }), 0)
  assert.equal(readLock(dry).files[rel], sha('old\n'))

  const noLock = mkdtempSync(join(tmpdir(), 'epah-lockrefresh-'))
  assert.equal(refreshAgentsLockEntries(noLock, [rel], { notes: [] }), 0)

  const corrupt = mkdtempSync(join(tmpdir(), 'epah-lockrefresh-'))
  mkdirSync(join(corrupt, 'tools'), { recursive: true })
  writeFileSync(join(corrupt, 'tools/agents.lock.json'), '{ not json')
  assert.equal(refreshAgentsLockEntries(corrupt, [rel], { notes: [] }), 0)

  const shapeless = fixture({ files: { [rel]: 'new\n' }, lock: { comment: 'x' } })
  assert.equal(refreshAgentsLockEntries(shapeless, [rel], { notes: [] }), 0)
})
