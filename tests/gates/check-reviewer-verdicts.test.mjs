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
//
// The third (0.7.0): the 0.6.0 ramp's RAMP EXPIRED branch, EXECUTED rather than inferred.
// This step runs only in the Stop chain, which no upgrade-lane leg executes, so its expiry
// fires in no lane at all — scripts/ci/stop-side-expiries.json registers THIS file as the
// compensating proof (upgrade-lane.sh §7e refuses to drop a met deadline that has no
// registered proof), and the sibling case pins that a 0.6.0-vintage install reds plainly,
// without the banner: the ramp is inert there, not expired.
//
// The fourth (0.7.0): THE DIFF BINDING. Until now a PASS was a fact about the TURN —
// recorded once, satisfied forever within the prompt — so a reviewer could PASS and the
// agent could then keep editing the very paths that summoned it, shipping code no reviewer
// ever saw. The hook now records `path_state` beside each verdict (sha256 over the sorted
// (path, content-sha256) pairs of the reviewer-owned changed files), the step recomputes it
// at Stop time, and a PASS whose binding is missing or mismatched fails TOWARD RE-REVIEW.
// That class alone rides a fresh 0.7.0 ramp (until 0.8.0): a mid-session upgrade delivers
// the new gate into a turn whose earlier PASSes lack the binding, which is the ambush shape
// the ramp doctrine exists for — so its NOTE and its RAMP EXPIRED branches are both
// executed below, the same way the 0.6.0 ramp's are above.
//
// The fifth (1.1.0, #70): THE REVIEWER LEDGER v2, and its headline is `commit-then-Stop still
// owes security-reviewer`. Through 1.0.4 the owed set was the diff against HEAD, so an agent
// that committed its migration before the turn ended owed nobody, and an empty owed set is
// green. v2 keys the owed set on the merge base with the branch's upstream and keeps
// deletions, judges the whole session's ledger (a BLOCK stands until the SAME agent_id
// passes at the current digest; a counted PASS at the current digest stands for later
// prompts), counts a verdict only when the tree it was dispatched on is the tree it passed
// (the SubagentStart record), and owes the two whole-turn reviewers on every non-empty diff.
// It rides one ramp opened at 1.1.0, until 2.1.0: every v2 red below is executed three ways,
// a NOTE on a 1.0.3 manifest, a plain red on a 1.1.0 one, and RAMP EXPIRED at harness 2.1.0,
// and on a 1.0.3 manifest the two relaxations do not apply.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  globToRe,
  owedBy,
  classifyVerdict,
  pathStateDigest,
  readLedger,
  readVerdict,
} from '../../template/base/tools/lib/reviewer-verdicts.mjs'
import { REVIEWER_AGENTS } from '../../template/base/tools/lib/agent-roster.mjs'
// NAMESPACE imports for the 1.1.0 surface: a test that reaches a missing export gets a
// TypeError in ITS case, while every older case in this file still runs.
import * as gitDiff from '../../template/base/tools/lib/git-diff.mjs'
import * as ledgerLib from '../../template/base/tools/lib/reviewer-verdicts.mjs'

const STEP = fileURLToPath(new URL('../../template/base/tools/check-reviewer-verdicts.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../../template/base/.claude/hooks/subagent-verdict.mjs', import.meta.url))
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const AGENTS = fileURLToPath(new URL('../../template/base/.claude/agents', import.meta.url))
const HOOKS = fileURLToPath(new URL('../../template/base/.claude/hooks', import.meta.url))
const TRIGGERS = JSON.parse(readFileSync(join(TOOLS, 'reviewer-triggers.json'), 'utf8'))

const SESSION = 'session-under-test'
const PROMPT = 'prompt-under-test'
const CHANGED = 'supabase/migrations/29990101_x.sql'

/**
 * A git repo with a real changed file, the shipped triggers, and an optional ledger.
 * @param {{ changed?: string, ledger?: Array<object>|string|null, triggers?: any }} [opts]
 */
function fixture({ changed = CHANGED, ledger = null, triggers } = {}) {
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

/** Write the fixture's ledger AFTER its tree state is known — the diff-binding tests need it. */
function writeLedger(dir, entries) {
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/reviewer-ledger.jsonl'),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
  )
}

/**
 * The binding the hook would have recorded at this moment: the digest over the fixture's
 * reviewer-owned files AS THEY ARE NOW. Computed by the same shared function the hook and
 * the step call, which is the point — one implementation, no second chance to disagree.
 */
const digestFor = (dir, agent, files = [CHANGED]) =>
  pathStateDigest(agent, TRIGGERS, files, (p) => readFileSync(join(dir, p)))

function runStep(dir, { session = SESSION, prompt = PROMPT } = {}) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  // THE FIXTURE IS A DIFFERENT REPOSITORY, and this is the fourth time that has had to be
  // said in this codebase. `fixture()` builds a throwaway git repo with one commit and no
  // remote. On a `pull_request` run GITHUB_BASE_REF names the base branch of the PR against
  // THIS repo, so leaking it inward makes the gate resolve a diff base of `origin/main` that
  // does not exist there — and it fails CLOSED under CI, correctly, because it genuinely
  // cannot compute a diff. Nine of this file's twenty-one tests then get the fail-closed
  // verdict instead of the one they asserted, and ONLY on a PR: green in every maintainer's
  // shell, red the moment it matters. Eighteen sibling test files already delete this; the
  // one written in the release that added the gate did not.
  delete env.GITHUB_BASE_REF
  // And the maintainer's own escape hatch stays out for the same reason: the fixture
  // plays a CONSUMER, and a consumer does not have HARNESS_ALLOW_SELF_EDIT set
  // (upgrade-lane.sh unsets it script-wide with the full argument).
  delete env.HARNESS_ALLOW_SELF_EDIT
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
  // path_state is NULL here by design, not omitted: this fixture has no trigger table and no
  // git repo, and a hook that cannot compute the binding must still record the verdict —
  // null is safe in exactly one direction (the step fails an unbound PASS toward re-review).
  // The bound case, with a real repo underneath, lives in
  // tests/hooks/subagent-verdict-pathstate.test.mjs. The two ledger v2 fields (1.1.0) are
  // null here for the same reason: no dispatch record exists, and no digest is computable.
  assert.deepEqual(line, {
    session_id: 's1',
    prompt_id: 'p1',
    agent_type: 'security-reviewer',
    agent_id: 'a9',
    verdict: 'PASS',
    path_state: null,
    path_state_start: null,
    path_state_stop: null,
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

test('a structural packages/** path owes the architecture-reviewer; tests and apps do not (0.9.5)', () => {
  const reviewers = TRIGGERS.reviewers.filter((r) => r.agent === 'architecture-reviewer')
  assert.equal(reviewers.length, 1, 'the architecture-reviewer trigger row must exist')
  // Both package depths: packages/<name>/src and packages/<group>/<name>/src.
  assert.deepEqual(
    owedBy(['packages/contracts/src/notes.ts'], reviewers).map((o) => o.agent),
    ['architecture-reviewer'],
  )
  assert.deepEqual(
    owedBy(['packages/verticals/notes/src/domain/note.ts'], reviewers).map((o) => o.agent),
    ['architecture-reviewer'],
  )
  // The two structural registers summon it too.
  assert.deepEqual(
    owedBy(['tools/vertical-anatomy-allow.json'], reviewers).map((o) => o.agent),
    ['architecture-reviewer'],
  )
  // Tests are excepted; apps/** is deliberately outside the trigger (narrowness first —
  // the widening decision is the architecture-reviewer-apps-widening register row).
  assert.deepEqual(owedBy(['packages/verticals/notes/src/data/notes.test.ts'], reviewers), [])
  assert.deepEqual(owedBy(['apps/web/lib/rate-limit.ts'], reviewers), [])
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

test('GREEN: the owed reviewer ran and passed, its PASS bound to this tree', () => {
  // The edit exists FIRST (fixture() writes and stages it), the PASS is recorded after —
  // which is the ordering the binding demands: a verdict post-dating the last edit to the
  // paths that summoned it.
  const dir = fixture()
  writeLedger(dir, [
    entry('security-reviewer', 'PASS', { path_state: digestFor(dir, 'security-reviewer') }),
  ])
  const r = runStep(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /returned PASS this turn/)
})

test('CANARY — the owed reviewer did NOT run: no ledger at all', () => {
  const r = runStep(fixture({ ledger: null }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /does not exist — no reviewer ran at all this turn/)
})

// Stamp an install vintage onto a fixture: rampNote reads .harness/manifest.json from the
// gate's cwd, comparing baseVersion against the ramp and harnessVersion against the deadline.
function withManifest(dir, baseVersion, harnessVersion) {
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion, harnessVersion }, null, 2),
  )
  return dir
}

test('CANARY — the 0.6.0 ramp EXPIRES at harness 0.7.0: the banner fires and the red is hard', () => {
  // A pre-0.6.0 vintage running 0.7.0 code: baseVersion is below the ramp, harnessVersion
  // has reached the deadline. The findings must NOT be withheld as a NOTE — the banner
  // names the expiry and the exit is the same hard 1 a fresh install gets.
  const dir = withManifest(fixture({ ledger: null }), '0.3.0', '0.7.0')
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /reviewer-verdicts: RAMP EXPIRED/)
  // The banner names ITS ramp — the roster closure, not the 0.7.0 path_state binding —
  // per the per-detail keying in scripts/ci/stop-side-expiries.json.
  assert.match(r.out, /closure over the reviewer roster/)
  assert.match(r.out, /deadline of 0\.7\.0/)
  assert.match(r.out, /does not exist — no reviewer ran at all this turn/)
})

test('CANARY — a 0.6.0-vintage install reds WITHOUT the banner: the ramp is inert, not expired', () => {
  // baseVersion at the ramp's minVersion: rampNote's first guard makes the check plainly
  // live. The same finding, the same exit — but an expiry banner here would tell a consumer
  // who was never inside the escape that a deadline they never had has passed.
  const dir = withManifest(fixture({ ledger: null }), '0.6.0', '0.7.0')
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(!r.out.includes('RAMP EXPIRED'), r.out)
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

// ── the diff binding (0.7.0) ─────────────────────────────────────────────────────────

test('CANARY — a PASS recorded, then the owed file EDITED: the verdict is stale', () => {
  // The gap the binding closes: nothing above stops an agent from summoning the reviewer,
  // collecting its PASS, and then editing the very file that summoned it. The recorded
  // digest is honest — it covers the tree the reviewer saw — and the tree moved.
  const dir = fixture()
  writeLedger(dir, [
    entry('security-reviewer', 'PASS', { path_state: digestFor(dir, 'security-reviewer') }),
  ])
  writeFileSync(join(dir, CHANGED), '-- a change\n-- and a post-PASS edit the reviewer never saw\n')
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /security-reviewer returned PASS for a different tree/)
  assert.match(r.out, /changed after its PASS/)
  assert.match(r.out, /29990101_x\.sql/)
})

test('GREEN: edit, re-run, PASS again — the LATEST entry is the one that binds', () => {
  // The recovery path the stale finding prescribes. The first PASS is genuinely stale; the
  // re-run appends a fresh one, and the step judges the newest entry — otherwise re-running
  // the reviewer could never clear the finding it raised.
  const dir = fixture()
  const staleDigest = digestFor(dir, 'security-reviewer')
  writeFileSync(join(dir, CHANGED), '-- a change\n-- edited between the two reviews\n')
  writeLedger(dir, [
    entry('security-reviewer', 'PASS', { path_state: staleDigest }),
    entry('security-reviewer', 'PASS', { path_state: digestFor(dir, 'security-reviewer') }),
  ])
  const r = runStep(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /returned PASS this turn/)
})

test('CANARY — a PASS with NO binding (a pre-0.7.0 hook entry) fails toward re-review', () => {
  // The mid-session-upgrade shape, and the direction the failure must point: an entry the
  // old hook wrote — or one whose digest the hook could not compute — proves nothing about
  // WHICH tree was reviewed, so it is treated as un-reviewed, never as reviewed-enough.
  for (const over of [{}, { path_state: null }]) {
    const dir = fixture()
    writeLedger(dir, [entry('security-reviewer', 'PASS', over)])
    const r = runStep(dir)
    assert.equal(r.code, 1, `${JSON.stringify(over)}: ${r.out}`)
    assert.match(r.out, /no path_state binding/)
    assert.match(r.out, /fails toward re-review/)
  }
})

test('GREEN: a post-PASS edit to a NON-owed path does not invalidate the verdict', () => {
  // Per-reviewer scoping is what keeps the binding from being a whole-tree freeze: the
  // digest covers only the paths that reviewer's triggers own, so ordinary follow-up work
  // elsewhere (docs, tests, unrelated packages) does not send every verdict stale.
  const dir = fixture()
  writeLedger(dir, [
    entry('security-reviewer', 'PASS', { path_state: digestFor(dir, 'security-reviewer') }),
  ])
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs/notes.md'), 'a post-PASS edit outside the reviewer paths\n')
  const r = runStep(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /returned PASS this turn/)
})

test('pathStateDigest: order-independent, POSIX-normalized, per-reviewer scoped, deletion-aware', () => {
  const read = (m) => (p) => m[p] ?? null
  const files = ['supabase/migrations/b.sql', 'supabase/migrations/a.sql']
  const m = { 'supabase/migrations/a.sql': 'A', 'supabase/migrations/b.sql': 'B' }
  const d1 = pathStateDigest('security-reviewer', TRIGGERS, files, read(m))
  // Enumeration order must not matter — git-diff local mode returns a Set's insertion order.
  assert.equal(pathStateDigest('security-reviewer', TRIGGERS, [...files].reverse(), read(m)), d1)
  // Windows separators normalize to the POSIX spelling before matching and hashing.
  assert.equal(
    pathStateDigest(
      'security-reviewer',
      TRIGGERS,
      ['supabase\\migrations\\a.sql', 'supabase\\migrations\\b.sql'],
      read(m),
    ),
    d1,
  )
  // Content moves the digest; so does a deletion (readFileLike returning null).
  assert.notEqual(
    pathStateDigest('security-reviewer', TRIGGERS, files, read({ ...m, 'supabase/migrations/a.sql': 'A2' })),
    d1,
  )
  assert.notEqual(
    pathStateDigest('security-reviewer', TRIGGERS, files, read({ 'supabase/migrations/b.sql': 'B' })),
    d1,
  )
  // A changed file OUTSIDE the reviewer's patterns does not participate — the scoping half.
  assert.equal(
    pathStateDigest('security-reviewer', TRIGGERS, [...files, 'docs/x.md'], read({ ...m, 'docs/x.md': 'D' })),
    d1,
  )
})

test('pathStateDigest: an agent the trigger table does not name digests to NULL', () => {
  // An agent the table names nowhere. (Through 1.0.4 this case used torvalds-reviewer, which
  // had no path trigger; 1.1.0 names it in the wholeTurn class.) Null — not the empty-set
  // digest — because "no patterns own this diff" and "nobody knows what this agent owns"
  // must not collide.
  assert.equal(
    pathStateDigest('unnamed-reviewer', TRIGGERS, ['supabase/migrations/a.sql'], () => 'x'),
    null,
  )
  // path_state keeps its v1 meaning: a whole-turn reviewer has no PATH trigger, so its v1
  // binding stays null. Its v2 digest is reviewStateDigest's, pinned below.
  assert.equal(
    pathStateDigest('torvalds-reviewer', TRIGGERS, ['supabase/migrations/a.sql'], () => 'x'),
    null,
  )
})

test('the 0.7.0 binding ramp: a pre-0.7.0 vintage sees the stale finding as a NOTE', () => {
  // The install the ramp exists for: a 0.6.0-vintage consumer mid-upgrade, whose earlier
  // PASSes were written by the old hook and cannot carry a binding. Advisory, with the
  // deadline named — while the ABSENT class on the same vintage still reds hard (its 0.6.0
  // ramp is inert there; the sibling case above pins that).
  const dir = withManifest(fixture(), '0.6.0', '0.7.0')
  writeLedger(dir, [entry('security-reviewer', 'PASS')])
  const r = runStep(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NOTE — the verdict-to-diff binding/)
  assert.match(r.out, /expires in 0\.8\.0/)
  assert.match(r.out, /no path_state binding/)
})

test('the 0.7.0 binding ramp EXPIRES at harness 0.8.0 — the branch EXECUTED, like the 0.6.0 one', () => {
  // The registered stop-side-expiries proof for the NEXT release, written the release the
  // ramp opens: no lane runs the Stop chain, so this is where the 0.8.0 deadline fires.
  const dir = withManifest(fixture(), '0.6.0', '0.8.0')
  writeLedger(dir, [entry('security-reviewer', 'PASS')])
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /reviewer-verdicts: RAMP EXPIRED/)
  assert.match(r.out, /deadline of 0\.8\.0/)
  assert.match(r.out, /no path_state binding/)
})

// ── MALFORMED LINES ARE BOUNDED TO THE LINE (0.9.0) ─────────────────────────────────
// The old readLedger failed closed FOREVER on ANY malformed line, and its remedy was one
// the write-guard denies (deleting the ledger — `.harness/` is a protected surface). One
// crashed session's torn write then bricked every later turn in the directory with no exit
// the consumer could take. The failure is now bounded to the LINE: skipped with a named
// NOTE (line number + content class), while a mis-shaped line that claims THIS turn's
// session+prompt still fails closed — the current turn's own verdicts must be readable.

test('CANARY (0.9.0) — a fully-corrupt ledger reds for the reviewer it cannot show, naming each skipped line', () => {
  const r = runStep(fixture({ ledger: '{"agent_type":"security-reviewer"\nnot json\n' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /line 1 .* not JSON/)
  assert.match(r.out, /line 2 .* not JSON/)
  assert.match(r.out, /did not run this turn/)
})

test('CANARY (0.9.0) — another turn\'s mis-shaped line is skipped with a NOTE, not a permanent fail-closed', () => {
  const r = runStep(fixture({ ledger: '{"session_id":"x","prompt_id":"y","agent_type":"z"}\n' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /NOTE/)
  assert.match(r.out, /line 1/)
  assert.match(r.out, /missing agent_type or verdict/)
  // The red is the OWED reviewer's absence, not the stranger's torn line.
  assert.match(r.out, /did not run this turn/)
})

test('GREEN (0.9.0) — a torn line from a crashed session does not unbind this turn\'s own PASS', () => {
  const dir = fixture()
  writeLedger(dir, [
    entry('security-reviewer', 'PASS', { path_state: digestFor(dir, 'security-reviewer') }),
  ])
  // Append the torn line a killed process leaves — half a JSON object, no newline discipline.
  appendFileSync(join(dir, '.harness/reviewer-ledger.jsonl'), '{"session_id":"cra\n')
  const r = runStep(dir)
  assert.equal(r.code, 0, `a stranger's torn line must not consume this turn's PASS: ${r.out}`)
  assert.match(r.out, /NOTE/)
  assert.match(r.out, /line 2/)
})

test('CANARY (0.9.0) — THIS turn\'s own mis-shaped verdict line still FAILS CLOSED, with a performable remedy', () => {
  const dir = fixture({
    ledger: `${JSON.stringify({ session_id: SESSION, prompt_id: PROMPT, agent_type: 'security-reviewer' })}\n`,
  })
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /missing agent_type or verdict/)
  // The remedy must be one the consumer can actually perform: the ledger is write-guard
  // protected, so "delete it" is not — re-running the reviewer (a fresh appended entry) is.
  assert.match(r.out, /run (the|each named) reviewer again/i)
  assert.doesNotMatch(r.out, /delete it and re-run/)
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

// ── the verdict grammar (1.0.2) ──────────────────────────────────────────────────────
//
// Two reviewer bodies said "End with exactly one final line: VERDICT: … Follow it with the
// top 3 fixes", the parser read only the LAST line, and the hook bounced every reviewer
// that obeyed its own file. The bodies are fixed (verdict last). The parser is also made
// ASYMMETRIC, because its two errors do not cost the same: reading a hedge as a PASS lets
// an unreviewed turn end, while reading a clumsy BLOCK as a BLOCK costs nothing. So PASS
// stays as strict as it was (exact, terminal, and now only when no BLOCK line exists
// anywhere), and BLOCK is accepted wherever a line states it.

const VERDICT_TABLE = /** @type {Array<[string, unknown, 'PASS' | 'BLOCK' | null, string]>} */ ([
  // [ name, message, verdict, shape ]                      — the rows main already pinned
  ['prose, then the line', 'some reasoning\n\nand more\n\nVERDICT: PASS', 'PASS', 'terminal-pass'],
  ['terminal BLOCK, trailing blanks', 'VERDICT: BLOCK\n\n', 'BLOCK', 'terminal-block'],
  ['PASS then a hedge', 'VERDICT: PASS\nbut actually I am not sure', null, 'pass-not-terminal'],
  ['PASS inside a sentence', 'I would say VERDICT: PASS inline', null, 'verdict-inline'],
  ['undefined', undefined, null, 'not-a-string'],
  ['a number', 42, null, 'not-a-string'],
  ['empty', '', null, 'no-verdict-line'],
  ['no verdict at all', 'Looks fine to me, no concerns.', null, 'no-verdict-line'],
  // whitespace and line endings
  ['CRLF', 'all good\r\n\r\nVERDICT: PASS\r\n', 'PASS', 'terminal-pass'],
  ['trailing spaces and tabs', 'VERDICT: PASS \t ', 'PASS', 'terminal-pass'],
  ['no space after the colon', 'VERDICT:PASS', 'PASS', 'terminal-pass'],
  // the closed set of markdown wrappers a model puts around a conclusion
  ['one trailing period', 'VERDICT: PASS.', 'PASS', 'terminal-pass'],
  ['bold', '**VERDICT: PASS**', 'PASS', 'terminal-pass'],
  ['bold key only', '**VERDICT:** PASS', 'PASS', 'terminal-pass'],
  ['bold key, colon outside', '**VERDICT**: PASS', 'PASS', 'terminal-pass'],
  ['backticks', '`VERDICT: PASS`', 'PASS', 'terminal-pass'],
  ['underscore emphasis', '_VERDICT: PASS_', 'PASS', 'terminal-pass'],
  ['bold with the period inside', '**VERDICT: PASS.**', 'PASS', 'terminal-pass'],
  ['blockquote', '> VERDICT: PASS', 'PASS', 'terminal-pass'],
  ['list item', '- VERDICT: PASS', 'PASS', 'terminal-pass'],
  ['numbered item', '3. VERDICT: PASS', 'PASS', 'terminal-pass'],
  ['heading', '## VERDICT: PASS', 'PASS', 'terminal-pass'],
  // PASS is never relaxed beyond those wrappers
  ['PASS with trailing text', 'VERDICT: PASS — ship it', null, 'pass-trailing-text'],
  ['PASSED', 'VERDICT: PASSED', null, 'pass-trailing-text'],
  ['lower-case pass', 'verdict: pass', null, 'pass-trailing-text'],
  ['mixed-case key', 'Verdict: PASS', null, 'pass-trailing-text'],
  ['PASS, then the top 3 fixes — the shape the two bodies demanded', 'VERDICT: PASS\n1. a\n2. b\n3. c', null, 'pass-not-terminal'],
  ['a fenced PASS is not a PASS', 'summary\n```\nVERDICT: PASS\n```', null, 'pass-fenced'],
  ['two periods', 'VERDICT: PASS..', null, 'pass-trailing-text'],
  // BLOCK is accepted wherever a line states it
  ['BLOCK, then the top 3 fixes', 'VERDICT: BLOCK\n1. a\n2. b\n3. c', 'BLOCK', 'block-anywhere'],
  ['a fenced BLOCK', 'summary\n```\nVERDICT: BLOCK\n```', 'BLOCK', 'block-anywhere'],
  ['FAIL is a BLOCK', 'VERDICT: FAIL', 'BLOCK', 'terminal-block'],
  ['FAILED with a reason, then more', 'VERDICT: FAILED — policy missing\nsee above', 'BLOCK', 'block-anywhere'],
  ['BLOCK mid-message', 'findings\nVERDICT: BLOCK\nthat is all I have', 'BLOCK', 'block-anywhere'],
  ['a BLOCK reason that contains the word pass', 'VERDICT: BLOCK — tests pass but RLS is missing', 'BLOCK', 'block-anywhere'],
  ['bold BLOCK with a reason', '**VERDICT: BLOCK** — missing index', 'BLOCK', 'block-anywhere'],
  ['lower-case block', 'verdict: block', 'BLOCK', 'block-anywhere'],
  // both forms in one message: a hedge never reads as a pass
  ['BLOCK, a retraction, terminal PASS', 'VERDICT: BLOCK\nI was wrong.\nVERDICT: PASS', null, 'both-forms'],
  ['PASS, a retraction, terminal BLOCK', 'VERDICT: PASS\nActually no.\nVERDICT: BLOCK', 'BLOCK', 'terminal-block'],
  ['a legend quoting both forms, then PASS', '- `VERDICT: PASS` — clean\n- `VERDICT: BLOCK` — findings\n\nVERDICT: PASS', null, 'both-forms'],
  ['the instruction quoted mid-sentence, then PASS', 'I must end with `VERDICT: PASS` or `VERDICT: BLOCK`.\n\nVERDICT: PASS', 'PASS', 'terminal-pass'],
  ['a line naming both, then BLOCK', 'VERDICT: PASS or VERDICT: BLOCK\nVERDICT: BLOCK', 'BLOCK', 'terminal-block'],
  // words that are neither
  ['SHIP', 'VERDICT: SHIP', null, 'unknown-word'],
  ['BLOCKER', 'VERDICT: BLOCKER', null, 'unknown-word'],
  // the citation-verifier's two lines, in both orders
  ['CITATIONS then VERDICT', 'CITATIONS: CLEAN\nVERDICT: PASS', 'PASS', 'terminal-pass'],
  ['VERDICT then CITATIONS', 'VERDICT: PASS\nCITATIONS: CLEAN', null, 'pass-not-terminal'],
  ['BLOCK then CITATIONS', 'VERDICT: BLOCK\nCITATIONS: REJECTED', 'BLOCK', 'block-anywhere'],
  // other prefixed verdict lines are not this one
  ['a bare PASS', 'PASS', null, 'no-verdict-line'],
  ['INVARIANTS: PASS', 'INVARIANTS: PASS', null, 'no-verdict-line'],
])

test('the verdict grammar — every accepted and rejected shape, and readVerdict agrees', () => {
  assert.ok(VERDICT_TABLE.length >= 45)
  for (const [name, message, verdict, shape] of VERDICT_TABLE) {
    assert.deepEqual(classifyVerdict(message), { verdict, shape }, name)
    assert.equal(readVerdict(message), verdict, `readVerdict: ${name}`)
  }
})

test('ASYMMETRY: no message with a BLOCK-form line anywhere reads as PASS, and the ledger vocabulary stays closed', () => {
  for (const [name, message, verdict] of VERDICT_TABLE) {
    // An independent, deliberately cruder reading of "a LINE that states a block".
    if (typeof message === 'string' && /^[\s>*_`#+\-\d.)]*verdict[*_`]*\s*:[\s*_`]*(block|fail)/im.test(message)) {
      assert.notEqual(verdict, 'PASS', name)
    }
    assert.ok(verdict === null || verdict === 'PASS' || verdict === 'BLOCK', name)
  }
})

test('the hook records a BLOCK that is followed by fixes — it used to bounce the obedient reviewer', () => {
  const r = runHook({
    hook_event_name: 'SubagentStop',
    agent_type: 'torvalds-reviewer',
    agent_id: 'a1',
    session_id: 's1',
    prompt_id: 'p1',
    last_assistant_message: 'findings above\n\nVERDICT: BLOCK\n1. fix the index\n2. bound the query\n3. delete the wrapper',
  })
  assert.equal(r.code, 0, r.out)
  const line = JSON.parse(readFileSync(join(r.dir, '.harness/reviewer-ledger.jsonl'), 'utf8').trim())
  assert.equal(line.verdict, 'BLOCK')
})

test('CANARY — a bounce leaves a RECORD: what the last line was and why it did not parse', () => {
  const r = runHook({
    hook_event_name: 'SubagentStop',
    agent_type: 'security-reviewer',
    session_id: 's1',
    prompt_id: 'p1',
    last_assistant_message: `VERDICT: BLOCK\nOn reflection that was wrong.\n${'x'.repeat(400)}\nVERDICT: PASS`,
  })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /ended without a verdict/)
  assert.match(r.out, /states both a PASS and a BLOCK verdict line/)
  const rows = readFileSync(join(r.dir, '.harness/verdict-bounces.jsonl'), 'utf8').trim().split('\n')
  assert.equal(rows.length, 1)
  const row = JSON.parse(rows[0])
  assert.equal(row.agent_type, 'security-reviewer')
  assert.equal(row.session_id, 's1')
  assert.equal(row.shape, 'both-forms')
  assert.equal(row.last_line, 'VERDICT: PASS')
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/)

  // The record is capped — a reviewer's last line is prose from a model, not a log format.
  const long = runHook({
    hook_event_name: 'SubagentStop',
    agent_type: 'security-reviewer',
    session_id: 's1',
    last_assistant_message: 'y'.repeat(5000),
  })
  assert.equal(long.code, 2)
  const capped = JSON.parse(readFileSync(join(long.dir, '.harness/verdict-bounces.jsonl'), 'utf8').trim())
  assert.equal(capped.last_line.length, 200)
  assert.equal(capped.shape, 'no-verdict-line')
})

test('every reviewer body ENDS with the verdict demand — nothing may follow the line it asks for', () => {
  // A test, not a gate: check-docs-sync asserts the phrase APPEARS, and two bodies carried
  // it while instructing the opposite ("Follow it with the top 3 fixes").
  for (const agent of REVIEWER_AGENTS) {
    const body = readFileSync(join(AGENTS, `${agent}.md`), 'utf8').trimEnd()
    const lastParagraph = body.split(/\n\s*\n/).at(-1)?.replace(/\s+/g, ' ') ?? ''
    assert.match(
      lastParagraph,
      /^End with exactly one final line: `VERDICT: PASS` or `VERDICT: BLOCK`\./,
      `${agent}: the LAST paragraph must be the verdict demand`,
    )
    assert.ok(!/follow it with/i.test(body), `${agent}: asks for text AFTER the verdict line`)
  }
})


// ── THE REVIEWER LEDGER v2 (1.1.0, #70) ─────────────────────────────────────────────
//
// Every fixture below except the no-upstream ones is a clone whose `feature` branch tracks
// origin/main, so the merge base resolves the way it does in a real checkout. The v2 reds
// are built so the 1.0.x judgement is GREEN on the same tree (the owed change is committed,
// or the current prompt carries a bound PASS), which is what makes each one a pure NOTE on
// a 1.0.3 manifest. The digests come from the same two lib calls the hook and the step
// make: reviewChanges() for the file list and reviewStateDigest() over it.

const WHOLE_TURN = ['torvalds-reviewer', 'citation-verifier']
const MIGRATION = 'supabase/migrations/20260101_base.sql'

/** git in a fixture; throws, so a broken fixture never reads as a gate verdict. */
function gitIn(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

/** @param {string} dir @param {string} path @param {string} body */
function put(dir, path, body) {
  const parent = path.split('/').slice(0, -1).join('/')
  if (parent !== '') mkdirSync(join(dir, parent), { recursive: true })
  writeFileSync(join(dir, path), body)
}

/** @param {string} dir @param {string} message */
function commitAll(dir, message) {
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-qm', message)
}

/**
 * A clone whose `feature` branch tracks origin/main: the resolvable base the v2 owed set
 * keys on. git and node only, because installer-unit runs this file on Windows too. The
 * "remote" is a plain repository cloned over the local transport, so nothing is pushed.
 * @param {{ base?: Record<string, string> }} [opts]
 */
function branchFixture({ base = {} } = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'epah-verdicts-origin-'))
  gitIn(origin, 'init', '-q')
  gitIn(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  gitIn(origin, 'config', 'user.email', 't@example.com')
  gitIn(origin, 'config', 'user.name', 'T')
  put(origin, 'tools/reviewer-triggers.json', JSON.stringify(TRIGGERS, null, 2))
  put(origin, 'seed.txt', 'seed\n')
  for (const [path, body] of Object.entries(base)) put(origin, path, body)
  commitAll(origin, 'base')
  const dir = join(mkdtempSync(join(tmpdir(), 'epah-verdicts-v2-')), 'repo')
  gitIn(origin, 'clone', '-q', origin, dir)
  gitIn(dir, 'config', 'user.email', 't@example.com')
  gitIn(dir, 'config', 'user.name', 'T')
  gitIn(dir, 'checkout', '-q', '-b', 'feature', '--track', 'origin/main')
  return dir
}

/** A branch fixture whose one owed change is COMMITTED: the 1.0.x owed set is empty. */
function committedChange(opts) {
  const dir = branchFixture(opts)
  put(dir, CHANGED, '-- a change\n')
  commitAll(dir, 'the migration, committed before Stop')
  return dir
}

/** @param {string} dir */
const readOrNull = (dir) => (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p)) : null)

/** The v2 digest for `agent` over the tree as it is NOW, by the hook's and the step's calls. */
function v2Digest(dir, agent) {
  const { files } = gitDiff.reviewChanges({ cwd: dir, env: {} })
  return ledgerLib.reviewStateDigest(agent, TRIGGERS, files, readOrNull(dir))
}

/** The entry the 1.1.0 hook writes for a review dispatched and finished on the tree as it is now. */
function bound(dir, agent, verdict, over = {}) {
  const d = v2Digest(dir, agent)
  return entry(agent, verdict, { path_state_start: d, path_state_stop: d, ...over })
}

const wholeTurnPasses = (dir, over = {}) =>
  WHOLE_TURN.map((agent, i) => bound(dir, agent, 'PASS', { agent_id: `w${String(i)}`, ...over }))

// The ramp distinguishes three install vintages, and a fixture with no manifest is the
// template tree's case: live, like a fresh 1.1.0 install.
const V2_VINTAGES = /** @type {Array<[string, [string, string] | null]>} */ ([
  ['no manifest', null],
  ['a 1.1.0 manifest', ['1.1.0', '1.1.0']],
  ['a 1.0.3 manifest', ['1.0.3', '1.1.0']],
  ['a 1.0.3 manifest at harness 2.1.0', ['1.0.3', '2.1.0']],
])

/** @param {string} dir @param {[string, string] | null} vintage */
function setVintage(dir, vintage) {
  if (vintage === null) rmSync(join(dir, '.harness/manifest.json'), { force: true })
  else withManifest(dir, ...vintage)
}

/**
 * One v2 red, run on every vintage the reviewer ledger v2 ramp distinguishes: a plain red
 * with no banner where v2 is live, a NOTE (exit 0) on a 1.0.3 manifest, and RAMP EXPIRED at
 * the 2.1.0 deadline. `patterns` must appear in every run.
 * @param {string} dir @param {RegExp[]} patterns
 */
function assertV2Red(dir, patterns) {
  for (const [label, vintage] of V2_VINTAGES) {
    setVintage(dir, vintage)
    const r = runStep(dir)
    for (const p of patterns) assert.match(r.out, p, `${label}: ${r.out}`)
    if (vintage === null || vintage[0] === '1.1.0') {
      assert.equal(r.code, 1, `${label}: a plain red: ${r.out}`)
      assert.match(r.out, /reviewer-verdicts: FAIL/, label)
      assert.doesNotMatch(r.out, /RAMP EXPIRED|NOTE — the reviewer ledger v2/, `${label}: ${r.out}`)
    } else if (vintage[1] === '1.1.0') {
      assert.equal(r.code, 0, `${label}: NOTE-only: ${r.out}`)
      assert.match(r.out, /reviewer-verdicts: NOTE — the reviewer ledger v2/, label)
      assert.match(r.out, /expires in 2\.1\.0/, label)
    } else {
      assert.equal(r.code, 1, `${label}: the expiry is a hard red: ${r.out}`)
      assert.match(r.out, /reviewer-verdicts: RAMP EXPIRED — the reviewer ledger v2/, label)
      assert.match(r.out, /deadline of 2\.1\.0/, label)
    }
  }
}

test('HEADLINE (v2) — commit-then-Stop still owes security-reviewer, and the FAIL names the path', () => {
  // The gate proposal's anti-vacuity case: an upstream, no manifest, no ledger. The agent
  // edits a migration, commits, and ends the turn. The 1.0.x owed set, the diff against
  // HEAD, is empty here, and an empty owed set printed "no reviewer is owed".
  const r = runStep(committedChange())
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /reviewer-verdicts: FAIL/)
  assert.match(r.out, /security-reviewer has not returned a verdict in this session/)
  assert.match(r.out, /29990101_x\.sql/)
  assert.doesNotMatch(r.out, /no reviewer is owed/)
})

test('v2 ramp — commit-then-Stop: NOTE on 1.0.3, plain red on 1.1.0, RAMP EXPIRED at 2.1.0', () => {
  assertV2Red(committedChange(), [
    /security-reviewer has not returned a verdict in this session/,
    /29990101_x\.sql/,
  ])
})

test('v2 — a DELETED migration owes security-reviewer', () => {
  // Through 1.0.4 both diff modes ran --diff-filter=d, so deleting a policy summoned nobody.
  const dir = branchFixture({ base: { [MIGRATION]: '-- the policy this branch deletes\n' } })
  rmSync(join(dir, MIGRATION))
  commitAll(dir, 'delete a migration')
  writeLedger(dir, wholeTurnPasses(dir))
  assertV2Red(dir, [
    /security-reviewer has not returned a verdict in this session/,
    /20260101_base\.sql/,
  ])
})

test('v2 — a BLOCK from an EARLIER prompt reds, and a PASS from another agent_id does not clear it', () => {
  const dir = committedChange()
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'BLOCK', { agent_id: 'a1', prompt_id: 'an-earlier-prompt' }),
    bound(dir, 'security-reviewer', 'PASS', { agent_id: 'a2' }),
    ...wholeTurnPasses(dir),
  ])
  assertV2Red(dir, [
    /security-reviewer returned VERDICT: BLOCK \(agent_id a1\)/,
    /second opinion/,
  ])
})

test('GREEN (v2) — the SAME agent_id passing at the current digest clears its standing BLOCK', () => {
  const dir = committedChange()
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'BLOCK', { agent_id: 'a1', prompt_id: 'an-earlier-prompt' }),
    bound(dir, 'security-reviewer', 'PASS', { agent_id: 'a1' }),
    ...wholeTurnPasses(dir),
  ])
  for (const vintage of [null, /** @type {[string, string]} */ (['1.1.0', '1.1.0'])]) {
    setVintage(dir, vintage)
    const r = runStep(dir)
    assert.equal(r.code, 0, `${JSON.stringify(vintage)}: ${r.out}`)
  }
})

test('v2 — differing start and stop digests red: a review of a moving tree does not count', () => {
  const dir = committedChange()
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'PASS', { path_state_start: 'f'.repeat(64) }),
    ...wholeTurnPasses(dir),
  ])
  assertV2Red(dir, [/security-reviewer reviewed a moving tree/])
})

test('v2 — a verdict with NO start record reds, and the finding names the SubagentStart wiring', () => {
  const dir = committedChange()
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'PASS', { path_state_start: null }),
    ...wholeTurnPasses(dir),
  ])
  assertV2Red(dir, [/security-reviewer returned PASS with no dispatch record/, /SubagentStart/])
})

test('v2 — a PASS for a tree that moved since reds as stale', () => {
  const dir = committedChange()
  const earlier = bound(dir, 'security-reviewer', 'PASS')
  put(dir, CHANGED, '-- a change\n-- and a later commit the reviewer never saw\n')
  commitAll(dir, 'a post-PASS commit')
  writeLedger(dir, [earlier, ...wholeTurnPasses(dir)])
  assertV2Red(dir, [/security-reviewer returned PASS for a different tree/])
})

test('v2 — a non-empty diff with no torvalds-reviewer verdict reds: the whole-turn class is judged', () => {
  const dir = branchFixture()
  put(dir, 'docs/notes.md', 'a docs change no path trigger owns\n')
  commitAll(dir, 'docs')
  writeLedger(dir, [bound(dir, 'citation-verifier', 'PASS')])
  assertV2Red(dir, [/torvalds-reviewer has not returned a verdict in this session/, /whole-turn/])
})

test('v2 — a PASS from ANOTHER SESSION still counts for nothing', () => {
  const dir = committedChange()
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'PASS', { session_id: 'another-session' }),
    ...wholeTurnPasses(dir, { session_id: 'another-session' }),
  ])
  assertV2Red(dir, [
    /security-reviewer has not returned a verdict in this session/,
    /torvalds-reviewer has not returned a verdict in this session/,
  ])
})

test('GREEN (v2) — a SETTLED PASS stands for a later prompt; on 1.0.3 the relaxation does not apply', () => {
  // The owed change is uncommitted, so the 1.0.x judgement owes the reviewer too, and on a
  // 1.0.3 manifest it still reds "did not run this turn": an install never gets the
  // relaxation without the tightening.
  const dir = branchFixture()
  put(dir, CHANGED, '-- a change\n')
  const earlier = { prompt_id: 'an-earlier-prompt' }
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'PASS', {
      ...earlier,
      path_state: digestFor(dir, 'security-reviewer'),
    }),
    ...wholeTurnPasses(dir, earlier),
  ])
  for (const vintage of [null, /** @type {[string, string]} */ (['1.1.0', '1.1.0'])]) {
    setVintage(dir, vintage)
    const r = runStep(dir)
    assert.equal(r.code, 0, `${JSON.stringify(vintage)}: ${r.out}`)
  }
  setVintage(dir, ['1.0.3', '1.1.0'])
  const r = runStep(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /security-reviewer did not run this turn/)
})

test('1.0.3 manifest — a same-prompt BLOCK then a PASS from the same agent_id still reds; on 1.1.0 it clears', () => {
  const dir = branchFixture()
  put(dir, CHANGED, '-- a change\n')
  const v1 = { path_state: digestFor(dir, 'security-reviewer') }
  writeLedger(dir, [
    bound(dir, 'security-reviewer', 'BLOCK', { ...v1, agent_id: 'a1' }),
    bound(dir, 'security-reviewer', 'PASS', { ...v1, agent_id: 'a1' }),
    ...wholeTurnPasses(dir),
  ])
  setVintage(dir, ['1.0.3', '1.1.0'])
  const pre = runStep(dir)
  assert.equal(pre.code, 1, pre.out)
  assert.match(pre.out, /returned VERDICT: BLOCK/)
  assert.match(pre.out, /A turn does not end on a BLOCK/)
  for (const vintage of [null, /** @type {[string, string]} */ (['1.1.0', '1.1.0'])]) {
    setVintage(dir, vintage)
    const r = runStep(dir)
    assert.equal(r.code, 0, `${JSON.stringify(vintage)}: ${r.out}`)
  }
})

test('DECISION 1 — no upstream: v2 does not judge, says so, and the 1.0.x judgement stands', () => {
  // The three clean-scaffold runs take this path (a fresh `git init`, no remote), and each
  // carries an untracked pnpm-lock.yaml after `pnpm install`, which the v2 owed set would
  // owe both whole-turn reviewers for.
  const dir = fixture({ changed: 'pnpm-lock.yaml' })
  for (const vintage of [null, /** @type {[string, string]} */ (['1.1.0', '1.1.0'])]) {
    setVintage(dir, vintage)
    const r = runStep(dir)
    assert.equal(r.code, 0, `${JSON.stringify(vintage)}: ${r.out}`)
    assert.match(r.out, /reviewer-verdicts: NOTE — no merge base/)
    assert.match(r.out, /no reviewer is owed a verdict by this diff/)
  }
})

// ── reviewChanges(), in-process (the lib coverage floor reads tests/gates only) ─────

test('reviewChanges: the merge-base diff, committed or not, with deletions and untracked files', () => {
  const dir = branchFixture({ base: { [MIGRATION]: 'a\n', 'docs/keep.md': 'k\n' } })
  put(dir, CHANGED, 'x\n')
  commitAll(dir, 'committed')
  rmSync(join(dir, MIGRATION))
  put(dir, 'docs/new.md', 'n\n')
  const r = gitDiff.reviewChanges({ cwd: dir, env: {} })
  assert.equal(r.base, 'origin/main')
  assert.deepEqual(r.files, ['docs/new.md', MIGRATION, CHANGED])
})

test('reviewChanges: a rename is both of its paths, and .harness/ is never part of the owed set', () => {
  const dir = branchFixture({ base: { [MIGRATION]: '-- moved away\n' } })
  mkdirSync(join(dir, 'supabase/archive'), { recursive: true })
  gitIn(dir, 'mv', MIGRATION, 'supabase/archive/old.sql')
  commitAll(dir, 'move a migration out of the triggered directory')
  put(dir, '.harness/reviewer-ledger.jsonl', '{}\n')
  put(dir, '.harness/manifest.json', '{}\n')
  const r = gitDiff.reviewChanges({ cwd: dir, env: {} })
  assert.deepEqual(r.files, ['supabase/archive/old.sql', MIGRATION])
})

test('reviewChanges: with no upstream the base is null and the set is the working tree, deletions kept', () => {
  const dir = fixture()
  rmSync(join(dir, 'seed.txt'))
  const r = gitDiff.reviewChanges({ cwd: dir, env: {} })
  assert.equal(r.base, null)
  assert.ok(r.files.includes(CHANGED), JSON.stringify(r.files))
  assert.ok(r.files.includes('seed.txt'), `the deletion is owed: ${JSON.stringify(r.files)}`)
})

test('reviewChanges: the local stack’s own runtime state is not a change — the seeded .gitignore keeps it out', () => {
  // `supabase start` (pnpm db:up) writes supabase/.temp/ (credentialed, ignored since 0.7.0)
  // and supabase/.branches/_current_branch. An untracked file is part of the owed set, so
  // unless the scaffold ignores both, bringing the stack up on a clean tree makes the diff
  // non-empty and owes both whole-turn reviewers for a turn that changed nothing.
  const dir = branchFixture({
    base: { '.gitignore': readFileSync(join(TOOLS, '..', 'gitignore'), 'utf8') },
  })
  put(dir, 'supabase/.temp/docker.env', 'written by supabase start\n')
  put(dir, 'supabase/.branches/_current_branch', 'main')
  const r = gitDiff.reviewChanges({ cwd: dir, env: {} })
  assert.equal(r.base, 'origin/main')
  assert.deepEqual(r.files, [], `a clean scaffold with the stack up owes nothing: ${JSON.stringify(r.files)}`)
  assert.deepEqual(ledgerLib.owedByTurn(r.files, TRIGGERS), [])
})

test('reviewChanges: CI with a PR base keys on origin/<base>, and fails CLOSED when it cannot resolve', () => {
  const dir = committedChange()
  const r = gitDiff.reviewChanges({ cwd: dir, env: { CI: 'true', GITHUB_BASE_REF: 'main' } })
  assert.equal(r.base, 'origin/main')
  assert.deepEqual(r.files, [CHANGED])
  assert.throws(() =>
    gitDiff.reviewChanges({ cwd: dir, env: { CI: 'true', GITHUB_BASE_REF: 'no-such-base' } }),
  )
})

// ── the pure v2 helpers, in-process ─────────────────────────────────────────────────

test('the shipped trigger table names both whole-turn reviewers, and every roster reviewer exactly once', () => {
  assert.deepEqual(
    (TRIGGERS.wholeTurn ?? []).map((w) => w.agent),
    WHOLE_TURN,
  )
  const named = [...TRIGGERS.reviewers, ...(TRIGGERS.wholeTurn ?? [])].map((r) => r.agent)
  for (const agent of REVIEWER_AGENTS) {
    assert.equal(named.filter((n) => n === agent).length, 1, agent)
  }
  assert.ok(!(TRIGGERS.notTriggered ?? []).some((n) => WHOLE_TURN.includes(n.agent)))
})

test('reviewStateDigest: path reviewers digest their paths, whole-turn reviewers the whole diff, others NULL', () => {
  const read = (p) => `content of ${p}`
  const files = ['docs/a.md', 'supabase/migrations/a.sql']
  assert.equal(
    ledgerLib.reviewStateDigest('security-reviewer', TRIGGERS, files, read),
    pathStateDigest('security-reviewer', TRIGGERS, files, read),
  )
  const whole = ledgerLib.reviewStateDigest('torvalds-reviewer', TRIGGERS, files, read)
  assert.equal(typeof whole, 'string')
  assert.equal(
    ledgerLib.reviewStateDigest('torvalds-reviewer', TRIGGERS, [...files].reverse(), read),
    whole,
  )
  assert.notEqual(
    ledgerLib.reviewStateDigest('torvalds-reviewer', TRIGGERS, ['supabase/migrations/a.sql'], read),
    whole,
    'a docs path moves a whole-turn digest',
  )
  assert.equal(ledgerLib.reviewStateDigest('unnamed-reviewer', TRIGGERS, files, read), null)
})

test('owedByTurn: whole-turn reviewers are owed on any non-empty diff and on nothing else', () => {
  assert.deepEqual(ledgerLib.owedByTurn([], TRIGGERS), [])
  const docs = ledgerLib.owedByTurn(['docs/a.md'], TRIGGERS)
  assert.deepEqual(
    docs.map((o) => o.agent),
    WHOLE_TURN,
  )
  assert.ok(docs.every((o) => o.wholeTurn === true && o.because === 'docs/a.md'))
  assert.deepEqual(
    ledgerLib.owedByTurn([CHANGED], TRIGGERS).map((o) => o.agent),
    ['security-reviewer', ...WHOLE_TURN],
  )
  // A seeded trigger table from before 1.1.0 has no class, and owes no whole-turn reviewer.
  assert.deepEqual(ledgerLib.owedByTurn(['docs/a.md'], { reviewers: TRIGGERS.reviewers }), [])
})

test('readSessionLedger: the whole session in ledger order; this turn’s mis-shaped line still fails closed', () => {
  const raw = [
    JSON.stringify(entry('security-reviewer', 'BLOCK', { prompt_id: 'earlier' })),
    'not json',
    JSON.stringify(entry('security-reviewer', 'PASS', { session_id: 'other' })),
    JSON.stringify(entry('design-reviewer', 'PASS')),
    '',
  ].join('\n')
  const r = ledgerLib.readSessionLedger(raw, SESSION, PROMPT)
  assert.equal(r.error, null)
  assert.deepEqual(
    r.entries.map((e) => `${e.agent_type}/${e.verdict}`),
    ['security-reviewer/BLOCK', 'design-reviewer/PASS'],
  )
  assert.equal(r.skipped.length, 1)
  const torn = ledgerLib.readSessionLedger(
    `${JSON.stringify({ session_id: SESSION, prompt_id: PROMPT })}\n`,
    SESSION,
    PROMPT,
  )
  assert.match(String(torn.error), /missing agent_type or verdict/)
  assert.deepEqual(torn.entries, [])
})

test('latestDispatchDigest: the LATEST record for the same session and agent_id, or null', () => {
  const rec = (over) => JSON.stringify({ session_id: 's1', agent_id: 'a1', path_state_start: 'd1', ...over })
  const raw = [
    rec({}),
    rec({ path_state_start: 'd2' }),
    rec({ agent_id: 'a2', path_state_start: 'other-agent' }),
    rec({ session_id: 's2', path_state_start: 'other-session' }),
    '{ torn',
    '',
  ].join('\n')
  assert.equal(ledgerLib.latestDispatchDigest(raw, 's1', 'a1'), 'd2')
  assert.equal(ledgerLib.latestDispatchDigest(raw, 's1', 'a3'), null)
  assert.equal(ledgerLib.latestDispatchDigest(raw, 's1', null), null)
  assert.equal(ledgerLib.latestDispatchDigest(rec({ path_state_start: null }), 's1', 'a1'), null)
})

test('judgeReviewerV2: every branch of the per-reviewer verdict', () => {
  const cur = 'c'.repeat(64)
  const owed = { agent: 'security-reviewer', because: CHANGED, why: 'why' }
  const e = (verdict, over = {}) => ({
    ...entry('security-reviewer', verdict),
    path_state_start: cur,
    path_state_stop: cur,
    ...over,
  })
  /**
   * @param {object[]} entries @param {string|null} [current]
   * @param {{agent: string, because: string, why?: string, wholeTurn?: boolean}} [o]
   */
  const judge = (entries, current = cur, o = owed) => ledgerLib.judgeReviewerV2(o, entries, current)
  const cases = /** @type {Array<[string, object[], RegExp | null]>} */ ([
    ['no entry', [], /has not returned a verdict in this session.*29990101_x\.sql/],
    ['a counted PASS', [e('PASS')], null],
    ['a PASS from a pre-1.1.0 hook', [e('PASS', { path_state_stop: undefined })], /no ledger v2 binding/],
    ['a PASS with no dispatch record', [e('PASS', { path_state_start: null })], /no dispatch record/],
    ['a moving tree', [e('PASS', { path_state_start: 'd'.repeat(64) })], /reviewed a moving tree/],
    ['a stale PASS', [e('PASS', { path_state_start: 'd', path_state_stop: 'd' })], /different tree/],
    ['BLOCK, then a second opinion', [e('BLOCK'), e('PASS', { agent_id: 'a2' })], /BLOCK \(agent_id a1\)/],
    ['BLOCK, then the same agent passes', [e('BLOCK'), e('PASS')], null],
    ['BLOCK, then the same agent passes a stale tree', [e('BLOCK'), e('PASS', { path_state_stop: 'd', path_state_start: 'd' })], /BLOCK \(agent_id a1\)/],
    ['PASS, then BLOCK', [e('PASS'), e('BLOCK')], /BLOCK \(agent_id a1\)/],
    ['a BLOCK with no agent_id', [e('BLOCK', { agent_id: null }), e('PASS', { agent_id: null })], /BLOCK/],
    ['a verdict outside the vocabulary', [e('MAYBE')], /has not returned a verdict/],
  ])
  for (const [name, entries, want] of cases) {
    const got = judge(entries)
    if (want === null) assert.equal(got, null, name)
    else assert.match(String(got), want, name)
  }
  assert.match(String(judge([e('PASS')], null)), /cannot be computed/)
  assert.match(
    String(judge([], cur, { agent: 'torvalds-reviewer', because: 'docs/a.md', wholeTurn: true })),
    /whole-turn/,
  )
})
