// The REFUSAL half of the subagent-verdict hook's canary — the deny/block coverage the
// 0.11.0 registry split named as its remainder (canary-registry-hook-subagent-verdict).
//
// The hook's subject is the TURN, so its refusal mechanism is EXIT 2 on SubagentStop
// (which prevents the subagent from stopping), never denyTool() — the registry pins
// denyToolCallSites at 0, and this suite is the executed proof behind the pin. The exit
// code is asserted EXACTLY 2 on both refusal paths, because under Claude Code's
// exit-code contract any OTHER nonzero is non-blocking: a refusal that exits 1 is a
// refusal that did not happen (the fail-open hazard design/CONTROL-PLANE-FACTS.md
// Fact 12 documents, re-probed 2026-08-15). Both paths must also write blocked:true
// into the shared turn ledger, so the consecutive-block cap counts hook blocks and
// Stop blocks as ONE budget.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(
  new URL('../../template/base/.claude/hooks/subagent-verdict.mjs', import.meta.url),
)
const TEMPLATE = fileURLToPath(new URL('../../template/base', import.meta.url))

/** The shipped roster, no git needed — the refusal paths fire before any tree read. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-verdict-refusal-'))
  cpSync(join(TEMPLATE, '.claude/agents'), join(dir, '.claude/agents'), { recursive: true })
  return dir
}

function runHook(dir, input) {
  const env = { ...process.env }
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_ALLOW_SELF_EDIT
  const res = spawnSync(process.execPath, [HOOK], { cwd: dir, encoding: 'utf8', env, input })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const turnOutcomes = (dir) =>
  readFileSync(join(dir, '.harness/turn-outcomes.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

const payload = (over = {}) =>
  JSON.stringify({
    hook_event_name: 'SubagentStop',
    agent_type: 'security-reviewer',
    agent_id: 'a1',
    session_id: 's1',
    prompt_id: 'p1',
    last_assistant_message: 'checked it\n\nVERDICT: PASS',
    ...over,
  })

test('REFUSAL: malformed stdin exits EXACTLY 2 through the installed fail-closed handler', () => {
  // Non-empty unparseable input THROWS in readHookInput by design, and hookio's
  // uncaughtException handler converts the crash into a block — the route Fact 12's
  // torn-hook matrix proves is the ONLY fail-closed one (a load failure exits 1).
  const dir = fixture()
  const r = runHook(dir, 'not-json{{')
  assert.equal(r.code, 2, `exit must be exactly 2 — any other nonzero is non-blocking: ${r.out}`)
  assert.match(r.out, /failing closed, action blocked/)
})

test('REFUSAL: a non-object payload exits EXACTLY 2 via the in-hook branch and records the block', () => {
  // JSON `null` parses cleanly, so it reaches the hook's own unrecognizable-payload
  // branch — the one that records into the shared turn ledger before blocking.
  const dir = fixture()
  const r = runHook(dir, 'null')
  assert.equal(r.code, 2, `exit must be exactly 2 — any other nonzero is non-blocking: ${r.out}`)
  assert.match(r.out, /fails CLOSED/)
  const [block] = turnOutcomes(dir)
  assert.equal(block.kind, 'block')
  assert.ok(
    block.gates.includes('subagent-verdict/unparseable-payload'),
    JSON.stringify(block.gates),
  )
})

test('REFUSAL: a reviewer ending without a verdict exits EXACTLY 2 and records the block', () => {
  const dir = fixture()
  const r = runHook(dir, payload({ last_assistant_message: 'looks broadly fine to me' }))
  assert.equal(r.code, 2, `exit must be exactly 2 — any other nonzero is non-blocking: ${r.out}`)
  assert.match(r.out, /ended without a verdict/)
  assert.match(r.out, /VERDICT: PASS/)
  const [block] = turnOutcomes(dir)
  assert.equal(block.kind, 'block')
  assert.ok(block.gates.includes('subagent-verdict/security-reviewer'), JSON.stringify(block.gates))
})

test('CONTROL: a verdict-carrying reviewer passes through with exit 0 (the refusals are not the default)', () => {
  const dir = fixture()
  const r = runHook(dir, payload())
  assert.equal(r.code, 0, r.out)
})

test('CONTROL: a non-reviewer agent is not the hook’s business — exit 0, nothing recorded', () => {
  const dir = fixture()
  const r = runHook(dir, payload({ agent_type: 'dal-author', last_assistant_message: 'done' }))
  assert.equal(r.code, 0, r.out)
})
