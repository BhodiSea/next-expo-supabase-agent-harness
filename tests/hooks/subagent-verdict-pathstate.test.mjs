// The RECORD half of the 0.7.0 diff binding: .claude/hooks/subagent-verdict.mjs appends
// `path_state` — sha256 over the sorted (path, content-sha256) pairs of the changed files
// matching the reviewer's trigger patterns — beside every verdict it records.
//
// This file exists apart from tests/gates/check-reviewer-verdicts.test.mjs because the
// binding needs what that file's hook fixture deliberately lacks: a real git repository and
// a trigger table, so `changedFiles()` resolves and the digest is computable. The proof that
// matters is the SECOND one: the digest MOVES when the owed file moves, because a binding
// that never changes is a timestamp wearing a hash's clothes. The judge half — a PASS whose
// binding is stale, null, or missing fails toward re-review — lives with the Stop step's
// suite; this file proves the writer records what that judge reads.
//
// 1.1.0 (#70) adds the DISPATCH half of the ledger v2 binding. SubagentStart is wired to the
// same hook, which appends the reviewer's v2 digest (reviewStateDigest over reviewChanges())
// to .harness/reviewer-dispatch.jsonl, keyed by session_id and agent_id and never into the
// ledger. At SubagentStop the hook copies the latest matching record's digest into the entry
// as `path_state_start`, beside `path_state_stop`, the same digest taken at the verdict. The
// judge counts a verdict only when the two are equal, so a review of a moving tree does not
// count, and a verdict with no start record does not either.
//
// 2.0.0 (#87) adds the FORMAT STAMP. Every entry carries `v`, the lib's LEDGER_FORMAT, which
// the step keys on beside session_id now that prompt_id has left the key. The stamp comes
// from the lib both ends import, so a hook running against a parked pre-2.0.0 fork of the lib
// writes no stamp, and the step names that entry's format instead of counting it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as gitDiff from '../../template/base/tools/lib/git-diff.mjs'
import * as verdicts from '../../template/base/tools/lib/reviewer-verdicts.mjs'
import { pathStateDigest } from '../../template/base/tools/lib/reviewer-verdicts.mjs'

const HOOK = fileURLToPath(
  new URL('../../template/base/.claude/hooks/subagent-verdict.mjs', import.meta.url),
)
const TEMPLATE = fileURLToPath(new URL('../../template/base', import.meta.url))
const TRIGGERS = JSON.parse(readFileSync(join(TEMPLATE, 'tools/reviewer-triggers.json'), 'utf8'))
const CHANGED = 'supabase/migrations/29990101_x.sql'

/** A git repo carrying the shipped roster + triggers and one staged reviewer-owned file. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-verdict-ps-'))
  cpSync(join(TEMPLATE, '.claude/agents'), join(dir, '.claude/agents'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/reviewer-triggers.json'), JSON.stringify(TRIGGERS, null, 2))
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
  writeFileSync(join(dir, CHANGED), '-- a change\n')
  git('add', '-A')
  return dir
}

/** The hook (run from its REAL path, so its ../../tools/lib imports resolve), cwd'd into dir. */
function runHook(dir, payload) {
  const env = { ...process.env }
  // The lane-env doctrine: the fixture is a different repository, so a leaked
  // GITHUB_BASE_REF would flip changedFiles() into merge-base mode against a base branch
  // that does not exist there; and a consumer has no HARNESS_ALLOW_SELF_EDIT.
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_ALLOW_SELF_EDIT
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    env,
    input: JSON.stringify(payload),
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const payload = (agent_type, over = {}) => ({
  hook_event_name: 'SubagentStop',
  agent_type,
  agent_id: 'a1',
  session_id: 's1',
  prompt_id: 'p1',
  last_assistant_message: 'checked it\n\nVERDICT: PASS',
  ...over,
})

const ledgerLines = (dir) =>
  readFileSync(join(dir, '.harness/reviewer-ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

test('the recorded entry carries path_state, and it is the digest the judge will recompute', () => {
  const dir = fixture()
  const r = runHook(dir, payload('security-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  const expected = pathStateDigest('security-reviewer', TRIGGERS, [CHANGED], (p) =>
    readFileSync(join(dir, p)),
  )
  assert.equal(typeof line.path_state, 'string')
  assert.equal(line.path_state, expected)
})

test('the recorded entry carries the ledger format stamp the step keys on (2.0.0), and still its prompt_id', () => {
  const dir = fixture()
  const r = runHook(dir, payload('security-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.v, '2.0.0')
  assert.equal(line.v, verdicts.LEDGER_FORMAT)
  // prompt_id stays as a diagnostic outside the v2 key (decision 6): the 1.0.x judgement
  // still keys on it, and it dates a mis-shaped line.
  assert.equal(line.prompt_id, 'p1')
  // The dispatch record is keyed by session_id and agent_id, and carries no stamp.
  runHook(dir, startPayload('security-reviewer'))
  assert.equal(Object.hasOwn(dispatchLines(dir)[0], 'v'), false)
})

test('a hook beside a parked lib without LEDGER_FORMAT writes NO stamp, never a format that lib cannot read (2.0.0)', () => {
  // The install shape: the hook and the lib copied into a project, the lib a fork `update`
  // kept. The hook reaches the constant through its namespace import, so the fork loads and
  // the entry is written without `v`, which the 2.0.0 step reads as another format.
  const root = fixture()
  cpSync(join(TEMPLATE, '.claude/hooks'), join(root, '.claude/hooks'), { recursive: true })
  cpSync(join(TEMPLATE, 'tools/lib'), join(root, 'tools/lib'), { recursive: true })
  const lib = join(root, 'tools/lib/reviewer-verdicts.mjs')
  const text = readFileSync(lib, 'utf8')
  const fork = text.replace(/^export const LEDGER_FORMAT = .*$/m, '')
  assert.notEqual(fork, text, 'the fixture must actually drop the export')
  writeFileSync(lib, fork)
  const env = { ...process.env }
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_ALLOW_SELF_EDIT
  const res = spawnSync(process.execPath, [join(root, '.claude/hooks/subagent-verdict.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: JSON.stringify(payload('security-reviewer')),
  })
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`)
  const [line] = ledgerLines(root)
  assert.equal(line.verdict, 'PASS')
  assert.equal(Object.hasOwn(line, 'v'), false, JSON.stringify(line))
})

test('the binding MOVES when the owed file moves — it is a tree state, not a timestamp', () => {
  const dir = fixture()
  runHook(dir, payload('security-reviewer'))
  writeFileSync(join(dir, CHANGED), '-- a change\n-- edited between the two reviews\n')
  const r = runHook(dir, payload('security-reviewer', { agent_id: 'a2' }))
  assert.equal(r.code, 0, r.out)
  const [first, second] = ledgerLines(dir)
  assert.notEqual(second.path_state, first.path_state)
  assert.equal(
    second.path_state,
    pathStateDigest('security-reviewer', TRIGGERS, [CHANGED], (p) => readFileSync(join(dir, p))),
  )
})

test('a reviewer the trigger table does not name records path_state NULL, not a guess', () => {
  // A roster reviewer (disallowedTools: Write, Edit) that reviewer-triggers.json names
  // nowhere. Through 1.0.4 this case used torvalds-reviewer; 1.1.0 names it in the
  // wholeTurn class. The verdict is still recorded; both bindings are null, which the judge
  // reads as "unverifiable", and an agent no table names is never owed.
  const dir = fixture()
  writeFileSync(
    join(dir, '.claude/agents/unnamed-reviewer.md'),
    '---\nname: unnamed-reviewer\ndescription: a reviewer no trigger names\ntools: Read\ndisallowedTools: Write, Edit\n---\n\nEnd with exactly one final line: `VERDICT: PASS` or `VERDICT: BLOCK`.\n',
  )
  const r = runHook(dir, payload('unnamed-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.agent_type, 'unnamed-reviewer')
  assert.equal(line.path_state, null)
  assert.equal(line.path_state_stop, null)
})

test('a missing trigger table records NULL rather than crashing the verdict write', () => {
  // Bookkeeping never decides a turn: the binding is computed on a best-effort basis and
  // fails toward re-review AT THE JUDGE, so the hook must record the verdict either way.
  const dir = fixture()
  writeFileSync(join(dir, 'tools/reviewer-triggers.json'), '{ not json')
  const r = runHook(dir, payload('security-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.verdict, 'PASS')
  assert.equal(line.path_state, null)
})

// ── the dispatch record (1.1.0, #70) ─────────────────────────────────────────────────

const startPayload = (agent_type, over = {}) => ({
  hook_event_name: 'SubagentStart',
  agent_type,
  agent_id: 'a1',
  session_id: 's1',
  prompt_id: 'p1',
  ...over,
})

const dispatchLines = (dir) =>
  readFileSync(join(dir, '.harness/reviewer-dispatch.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

/** The v2 digest the hook takes, by the same two lib calls, over the tree as it is now. */
function v2Digest(dir, agent) {
  const { files } = gitDiff.reviewChanges({ cwd: dir, env: {} })
  return verdicts.reviewStateDigest(agent, TRIGGERS, files, (p) =>
    existsSync(join(dir, p)) ? readFileSync(join(dir, p)) : null,
  )
}

test('SubagentStart records the dispatch digest, and SubagentStop copies it into path_state_start', () => {
  const dir = fixture()
  const start = runHook(dir, startPayload('security-reviewer'))
  assert.equal(start.code, 0, start.out)
  assert.equal(existsSync(join(dir, '.harness/reviewer-ledger.jsonl')), false, 'no ledger line at dispatch')
  const [record] = dispatchLines(dir)
  const expected = v2Digest(dir, 'security-reviewer')
  assert.equal(typeof expected, 'string')
  assert.deepEqual(record, {
    session_id: 's1',
    prompt_id: 'p1',
    agent_type: 'security-reviewer',
    agent_id: 'a1',
    path_state_start: expected,
  })
  const stop = runHook(dir, payload('security-reviewer'))
  assert.equal(stop.code, 0, stop.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.path_state_start, expected)
  assert.equal(line.path_state_stop, expected)
})

test('a tree that moves between dispatch and verdict records two different digests', () => {
  const dir = fixture()
  runHook(dir, startPayload('security-reviewer'))
  writeFileSync(join(dir, CHANGED), '-- a change\n-- edited while the reviewer was reading\n')
  const r = runHook(dir, payload('security-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(typeof line.path_state_start, 'string')
  assert.notEqual(line.path_state_start, line.path_state_stop)
  assert.equal(line.path_state_stop, v2Digest(dir, 'security-reviewer'))
})

test('no start record: path_state_start is NULL, and the verdict is still recorded', () => {
  const dir = fixture()
  // Another session's and another agent's dispatch records must not stand in for this one.
  runHook(dir, startPayload('security-reviewer', { session_id: 's2' }))
  runHook(dir, startPayload('security-reviewer', { agent_id: 'a2' }))
  const r = runHook(dir, payload('security-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.verdict, 'PASS')
  assert.equal(line.path_state_start, null)
  assert.equal(typeof line.path_state_stop, 'string')
})

test('the LATEST dispatch record for the session and agent_id is the one copied (a resumed reviewer)', () => {
  const dir = fixture()
  runHook(dir, startPayload('security-reviewer'))
  writeFileSync(join(dir, CHANGED), '-- a change\n-- the fix a BLOCK asked for\n')
  runHook(dir, startPayload('security-reviewer'))
  const r = runHook(dir, payload('security-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.path_state_start, line.path_state_stop)
  assert.equal(dispatchLines(dir).length, 2)
})

test('a whole-turn reviewer records a v2 digest over the whole diff; its v1 path_state stays NULL', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'notes.md'), 'a change no path trigger owns\n')
  runHook(dir, startPayload('torvalds-reviewer'))
  const r = runHook(dir, payload('torvalds-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.path_state, null, 'path_state keeps its v1 meaning')
  assert.equal(typeof line.path_state_stop, 'string')
  assert.equal(line.path_state_start, line.path_state_stop)
  assert.equal(line.path_state_stop, v2Digest(dir, 'torvalds-reviewer'))
})

test('a non-reviewer SubagentStart is not this hook’s business: no dispatch record', () => {
  const dir = fixture()
  const r = runHook(dir, startPayload('dal-author'))
  assert.equal(r.code, 0, r.out)
  assert.equal(existsSync(join(dir, '.harness/reviewer-dispatch.jsonl')), false)
})
