// Can-fail proofs for the process layer: the SubagentStop verdict hook
// (template/base/.claude/hooks/subagent-verdict.mjs) and Stop-chain step 10
// (template/base/tools/check-reviewer-verdicts.mjs).
//
// THE HEADLINE PROOF is `RED: last turn's PASS does not satisfy this turn`. The ledger is
// append-only across a session, so an entry keyed to a different prompt_id is exactly the
// shape that would make this whole control decorative — it would report coverage from work
// somebody did an hour ago. Every other finding here is recoverable by re-running a reviewer;
// that one would be silent.
//
// The second is `RED: a reviewer that ends without the mandated line is BLOCKED`. That
// contract — the body must end demanding exactly `VERDICT: PASS` or `VERDICT: BLOCK` — has
// been asserted about the reviewer FILE by check-docs-sync.mjs since 0.3.0 and enforced at
// runtime by nothing. Exit 2 on SubagentStop prevents the subagent from stopping, which is
// what turns a file-shape assertion into a behavioural one.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  globToRe,
  owedBy,
  readLedger,
  readVerdict,
} from '../../template/base/tools/lib/reviewer-verdicts.mjs'

const STEP = fileURLToPath(new URL('../../template/base/tools/check-reviewer-verdicts.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../../template/base/.claude/hooks/subagent-verdict.mjs', import.meta.url))
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const AGENTS = fileURLToPath(new URL('../../template/base/.claude/agents', import.meta.url))
const HOOKS = fileURLToPath(new URL('../../template/base/.claude/hooks', import.meta.url))
const TRIGGERS = JSON.parse(readFileSync(join(TOOLS, 'reviewer-triggers.json'), 'utf8'))

const SESSION = 'session-under-test'
const PROMPT = 'prompt-under-test'

/**
 * A git repo with a real changed file, the shipped triggers, and an optional ledger.
 * @param {{ changed?: string, ledger?: Array<object>|string|null, triggers?: any }} [opts]
 */
function fixture({ changed = 'supabase/migrations/29990101_x.sql', ledger = null, triggers } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-verdicts-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  writeFileSync(
    join(dir, 'tools/reviewer-triggers.json'),
    JSON.stringify(triggers ?? TRIGGERS, null, 2),
  )
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  mkdirSync(join(dir, changed.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, changed), '-- a change\n')
  git('add', '-A')

  if (ledger !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(
      join(dir, '.harness/reviewer-ledger.jsonl'),
      typeof ledger === 'string' ? ledger : `${ledger.map((e) => JSON.stringify(e)).join('\n')}\n`,
    )
  }
  return dir
}

const entry = (agent_type, verdict, over = {}) => ({
  session_id: SESSION,
  prompt_id: PROMPT,
  agent_type,
  agent_id: 'a1',
  verdict,
  ...over,
})

function runStep(dir, { session = SESSION, prompt = PROMPT } = {}) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  env.CI = 'true'
  if (session === null) delete env.HARNESS_SESSION_ID
  else env.HARNESS_SESSION_ID = session
  if (prompt === null) delete env.HARNESS_PROMPT_ID
  else env.HARNESS_PROMPT_ID = prompt
  const res = spawnSync(process.execPath, [STEP], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** The hook, against a real project tree carrying the shipped agent roster. */
function runHook(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-verdicthook-'))
  mkdirSync(join(dir, '.claude/hooks/lib'), { recursive: true })
  cpSync(join(AGENTS, '..', 'agents'), join(dir, '.claude/agents'), { recursive: true })
  cpSync(join(HOOKS, 'lib'), join(dir, '.claude/hooks/lib'), { recursive: true })
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  return {
    code: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    dir,
  }
}

// ── the hook ─────────────────────────────────────────────────────────────────────────

test('readVerdict reads the LAST non-empty line — reviewers write prose first', () => {
  // The observed shape: the probe subagent wrote three paragraphs, then the line.
  assert.equal(readVerdict('some reasoning\n\nand more\n\nVERDICT: PASS'), 'PASS')
  assert.equal(readVerdict('VERDICT: BLOCK\n\n'), 'BLOCK')
  assert.equal(readVerdict('VERDICT: PASS\nbut actually I am not sure'), null)
  assert.equal(readVerdict('I would say VERDICT: PASS inline'), null)
  assert.equal(readVerdict(undefined), null)
})

test('GREEN: a reviewer PASS is recorded, keyed to session and prompt', () => {
  const r = runHook({
    hook_event_name: 'SubagentStop',
    agent_type: 'security-reviewer',
    agent_id: 'a9',
    session_id: 's1',
    prompt_id: 'p1',
    last_assistant_message: 'checked the policies\n\nVERDICT: PASS',
  })
  assert.equal(r.code, 0, r.out)
  const line = JSON.parse(readFileSync(join(r.dir, '.harness/reviewer-ledger.jsonl'), 'utf8').trim())
  assert.deepEqual(line, {
    session_id: 's1',
    prompt_id: 'p1',
    agent_type: 'security-reviewer',
    agent_id: 'a9',
    verdict: 'PASS',
  })
})

test('CANARY — a reviewer that ends WITHOUT the mandated line is BLOCKED (exit 2)', () => {
  const r = runHook({
    hook_event_name: 'SubagentStop',
    agent_type: 'security-reviewer',
    session_id: 's1',
    prompt_id: 'p1',
    last_assistant_message: 'Looks fine to me, no concerns.',
  })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /ended without a verdict/)
  assert.match(r.out, /a review nobody can parse is a review that did not happen/)
})

test('CANARY — MALFORMED JSON fails closed in the shared plumbing, before this hook runs', () => {
  // The outcome is what matters and it is the right one (exit 2, action blocked). The
  // wording comes from lib/hookio.mjs's uncaughtException handler, not from this hook —
  // asserting the hook's own sentence here would be asserting that a layer it does not own
  // stays broken enough to reach it.
  const r = runHook('not json at all')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /failing closed, action blocked/)
})

test('CANARY — a payload that PARSES but is not an object fails closed in the hook itself', () => {
  // The branch this hook does own. `null` and a bare scalar are valid JSON, so hookio hands
  // them straight through — and a hook that cannot tell which agent ran must not record a
  // silence as a pass.
  for (const payload of ['null', '42', '"a string"']) {
    const r = runHook(payload)
    assert.equal(r.code, 2, `${payload}: ${r.out}`)
    assert.match(r.out, /fails CLOSED rather than recording a silence as a pass/)
  }
})

test('an AUTHOR agent is not a reviewer — the roster is derived, not listed', () => {
  // dal-author writes code and attests to nothing. It is distinguished by the property
  // check-docs-sync already enforces: reviewers carry `disallowedTools: Write, Edit`.
  const r = runHook({
    hook_event_name: 'SubagentStop',
    agent_type: 'dal-author',
    session_id: 's1',
    prompt_id: 'p1',
    last_assistant_message: 'wrote the data function',
  })
  assert.equal(r.code, 0, r.out)
})

// ── the trigger matcher ──────────────────────────────────────────────────────────────

test('globToRe: ** crosses segments and may match zero of them; * does not', () => {
  assert.ok(globToRe('supabase/migrations/**').test('supabase/migrations/20260101_x.sql'))
  assert.ok(globToRe('packages/verticals/*/src/data/**').test('packages/verticals/notes/src/data/q.ts'))
  assert.ok(!globToRe('packages/verticals/*/src/data/**').test('packages/verticals/a/b/src/data/q.ts'))
  assert.ok(globToRe('apps/web/app/**/page.tsx').test('apps/web/app/page.tsx'), 'zero segments')
  assert.ok(globToRe('apps/web/app/**/page.tsx').test('apps/web/app/(protected)/o/page.tsx'))
  assert.ok(!globToRe('apps/web/app/**/page.tsx').test('apps/web/app/o/page.meta.ts'))
})

test('an `except` pattern narrows the trigger — a test beside a policy is not a policy', () => {
  const reviewers = TRIGGERS.reviewers.filter((r) => r.agent === 'security-reviewer')
  assert.deepEqual(owedBy(['packages/api/src/routers/notes.test.ts'], reviewers), [])
  assert.deepEqual(
    owedBy(['packages/api/src/routers/notes.ts'], reviewers).map((o) => o.agent),
    ['security-reviewer'],
  )
})

test('the finding names the PATH that summoned the reviewer, not just the reviewer', () => {
  const owed = owedBy(['supabase/migrations/29990101_x.sql'], TRIGGERS.reviewers)
  assert.ok(owed.some((o) => o.agent === 'security-reviewer' && o.because.endsWith('_x.sql')))
})

// ── the step ─────────────────────────────────────────────────────────────────────────

test('GREEN: a diff that owes nobody passes without a ledger at all', () => {
  const r = runStep(fixture({ changed: 'docs/notes.md' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no reviewer is owed a verdict by this diff/)
})

test('GREEN: the owed reviewer ran and passed', () => {
  const r = runStep(fixture({ ledger: [entry('security-reviewer', 'PASS')] }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /returned PASS this turn/)
})

test('CANARY — the owed reviewer did NOT run: no ledger at all', () => {
  const r = runStep(fixture({ ledger: null }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /does not exist — no reviewer ran at all this turn/)
})

test('CANARY — the owed reviewer did not run, though another one did', () => {
  const r = runStep(fixture({ ledger: [entry('design-reviewer', 'PASS')] }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /security-reviewer did not run this turn/)
  assert.match(r.out, /29990101_x\.sql` is why/)
})

test('CANARY — LAST TURN’S PASS does not satisfy this turn', () => {
  // The one failure mode that would be silent. The ledger is append-only across a session,
  // so an entry from an earlier prompt is exactly what a naive reader would accept.
  const r = runStep(
    fixture({ ledger: [entry('security-reviewer', 'PASS', { prompt_id: 'an-earlier-turn' })] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /security-reviewer did not run this turn/)
})

test('CANARY — a PASS from a DIFFERENT SESSION does not count either', () => {
  const r = runStep(
    fixture({ ledger: [entry('security-reviewer', 'PASS', { session_id: 'another-session' })] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /did not run this turn/)
})

test('CANARY — a BLOCK verdict blocks the turn, and says that is the point', () => {
  const r = runStep(fixture({ ledger: [entry('security-reviewer', 'BLOCK')] }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /returned VERDICT: BLOCK/)
  assert.match(r.out, /A turn does not end on a BLOCK/)
})

test('CANARY — an unparseable ledger FAILS CLOSED', () => {
  const r = runStep(fixture({ ledger: '{"agent_type":"security-reviewer"\nnot json\n' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /fails CLOSED/)
})

test('CANARY — a ledger line missing its verdict is not a pass', () => {
  const r = runStep(fixture({ ledger: '{"session_id":"x","prompt_id":"y","agent_type":"z"}\n' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /missing agent_type or verdict/)
})

test('RED: a missing trigger table is a BROKEN control, not an empty policy', () => {
  const dir = fixture({ ledger: [entry('security-reviewer', 'PASS')] })
  writeFileSync(join(dir, 'tools/reviewer-triggers.json'), '')
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
})

test('no turn identity FAILS CLOSED in CI — the hook that supplies it must have changed', () => {
  const r = runStep(fixture({ ledger: [entry('security-reviewer', 'PASS')] }), { prompt: null })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /HARNESS_SESSION_ID\/HARNESS_PROMPT_ID/)
})

test('readLedger narrows to the turn and leaves everything else alone', () => {
  const raw = [
    JSON.stringify(entry('security-reviewer', 'PASS')),
    JSON.stringify(entry('design-reviewer', 'PASS', { prompt_id: 'other' })),
    '',
  ].join('\n')
  const r = readLedger(raw, SESSION, PROMPT)
  assert.equal(r.error, null)
  assert.deepEqual(
    r.entries.map((e) => e.agent_type),
    ['security-reviewer'],
  )
})
