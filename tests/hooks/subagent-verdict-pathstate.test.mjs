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
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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
  // torvalds-reviewer is on the roster (disallowedTools: Write, Edit) but deliberately
  // absent from reviewer-triggers.json — a whole-turn obligation no path glob expresses.
  // Its verdict is still recorded; its binding is null, which the judge reads as
  // "unverifiable" — and it owes nothing path-triggered, so null never blocks it.
  const dir = fixture()
  const r = runHook(dir, payload('torvalds-reviewer'))
  assert.equal(r.code, 0, r.out)
  const [line] = ledgerLines(dir)
  assert.equal(line.agent_type, 'torvalds-reviewer')
  assert.equal(line.path_state, null)
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
