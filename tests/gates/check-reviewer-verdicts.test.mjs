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
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  globToRe,
  owedBy,
  pathStateDigest,
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
  // tests/hooks/subagent-verdict-pathstate.test.mjs.
  assert.deepEqual(line, {
    session_id: 's1',
    prompt_id: 'p1',
    agent_type: 'security-reviewer',
    agent_id: 'a9',
    verdict: 'PASS',
    path_state: null,
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
  // torvalds-reviewer is a real reviewer with no path trigger (whole-turn obligation, see
  // reviewer-triggers.json#notTriggered). Null — not the empty-set digest — because "no
  // patterns own this diff" and "nobody knows what this agent owns" must not collide.
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
