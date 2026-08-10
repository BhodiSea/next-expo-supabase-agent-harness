// THE BLOCK CAP LEAVES A MARK (0.6.0).
//
// `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is the documented safety valve that stops a red Stop hook
// looping forever: after N CONSECUTIVE blocks, Claude Code ends the turn anyway. It is the
// right valve and it stays. But through 0.5.0 nothing recorded that it fired, so a turn that
// ended with the gate RED left exactly the trace a green turn leaves — none — while the
// harness's headline claim is "a turn cannot end on a red build".
//
// THE HEADLINE PROOF is the last test in this file: a turn ends at the cap, the NEXT turn is
// green, and the green turn still reports its predecessor. That is the whole point. A mark that
// only survives while the tree is still broken is not a mark; the tree being green again is
// precisely when the fact would otherwise be lost.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  capHitBlockEligible,
  consecutiveBlocks,
  DEFAULT_CAP,
  KEEP,
  nextLedger,
  parseLedger,
  priorCapHit,
  readCap,
  recordTurnOutcome,
  serialize,
} from '../../template/base/.claude/hooks/lib/turn-outcomes.mjs'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const LEDGER = '.harness/turn-outcomes.jsonl'

/**
 * A scaffold-shaped fixture whose single Stop step is green or red on demand.
 * @param {{ red?: boolean, ledger?: string }} spec
 */
function fixture({ red = false, ledger } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-turnlog-'))
  cpSync(join(TEMPLATE, '.claude/hooks'), join(dir, '.claude/hooks'), {
    recursive: true,
  })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'step.mjs'), red ? 'process.exit(3)\n' : '')
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    "export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['validate', 'node step.mjs']]\n",
  )
  writeFileSync(
    join(dir, 'tools/stop.floor.json'),
    `${JSON.stringify({ comment: 'fixture', steps: [['validate', 'node step.mjs']] }, null, 2)}\n`,
  )
  if (ledger !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, LEDGER), ledger)
  }
  return dir
}

/** @param {string} dir @param {{ promptId?: string, sessionId?: string, cap?: string }} opts */
function runStopHook(dir, { promptId = 'p1', sessionId = 's1', cap } = {}) {
  const res = spawnSync('node', [join(dir, '.claude/hooks/stop-validate-gate.mjs')], {
    cwd: dir,
    input: JSON.stringify({
      stop_hook_active: false,
      session_id: sessionId,
      prompt_id: promptId,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      CI: '',
      HARNESS_REQUIRE_TOOLCHAINS: '',
      ...(cap === undefined ? {} : { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: cap }),
    },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** @param {string} dir */
const readLedger = (dir) => parseLedger(readFileSync(join(dir, LEDGER), 'utf8')).records

const blockRec = (n, cap, capReached, promptId = 'p0') => ({
  kind: 'block',
  at: '2026-08-07T00:00:00.000Z',
  session_id: 's1',
  prompt_id: promptId,
  blocks: n,
  cap,
  capReached,
  gates: ['validate'],
})

// ---- the cap value itself -------------------------------------------------------

test('readCap: unset is the documented default of 8, and 0 means NO cap at all', () => {
  assert.deepEqual(readCap({}), { cap: DEFAULT_CAP, source: 'default' })
  assert.deepEqual(readCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '' }), {
    cap: DEFAULT_CAP,
    source: 'default',
  })
  assert.deepEqual(readCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '3' }), {
    cap: 3,
    source: 'env',
  })
  // `0` disables the cap — so no block is ever "the last one" and nothing may claim it is.
  assert.deepEqual(readCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '0' }), {
    cap: null,
    source: 'disabled',
  })
})

test('readCap: an unusable value reverts to 8 and SAYS SO — a silent revert is the defect', () => {
  for (const bad of ['eight', '-2', '3.5']) {
    const r = readCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: bad })
    assert.equal(r.cap, DEFAULT_CAP, bad)
    assert.equal(r.source, 'unparseable', bad)
  }
})

// ---- the count -----------------------------------------------------------------

test('the count is of CONSECUTIVE blocks, and a green outcome resets it', () => {
  // "Consecutive" is the word the cap is defined with, and a green turn is exactly what
  // Claude Code resets on. Keying the count on prompt_id instead would count a turn's blocks,
  // which is a different quantity whenever the payload carries no ids at all.
  assert.equal(consecutiveBlocks([]), 0)
  assert.equal(consecutiveBlocks([blockRec(1, 8, false), blockRec(2, 8, false)]), 2)
  assert.equal(
    consecutiveBlocks([blockRec(1, 8, false), { kind: 'green' }, blockRec(1, 8, false)]),
    1,
    'a green record between blocks must reset the run',
  )
  assert.equal(consecutiveBlocks([blockRec(1, 8, false), { kind: 'green' }]), 0)
})

test('nextLedger arms capReached exactly at the cap, never before', () => {
  const base = {
    sessionId: 's1',
    promptId: 'p1',
    gates: ['validate'],
    at: 'T',
  }
  let records = []
  for (let i = 1; i <= 3; i += 1) {
    const r = nextLedger(records, { ...base, blocked: true, cap: 3 })
    records = r.records
    assert.equal(r.blocks, i)
    assert.equal(r.capReached, i === 3, `block ${String(i)} of 3`)
  }
})

test('with the cap DISABLED, no block is ever the last one', () => {
  let records = []
  for (let i = 1; i <= 20; i += 1) {
    const r = nextLedger(records, {
      blocked: true,
      cap: null,
      sessionId: 's',
      promptId: 'p',
      gates: [],
      at: 'T',
    })
    records = r.records
    assert.equal(r.capReached, false)
  }
})

test('a green outcome records how many blocks it took to recover', () => {
  // Session-scoped since 0.9.0: the recovery count reads THIS session's blocks, so the
  // fixture records and the turn must agree about whose session it is ('s1', blockRec's).
  const r = nextLedger([blockRec(1, 8, false), blockRec(2, 8, false)], {
    blocked: false,
    cap: 8,
    sessionId: 's1',
    promptId: 'p',
    gates: [],
    at: 'T',
  })
  assert.equal(r.entry.kind, 'green')
  assert.equal(r.entry.recoveredAfter, 2)
  // …and a first-try green carries no such field, so the log reads as what happened.
  const clean = nextLedger([], {
    blocked: false,
    cap: 8,
    sessionId: 's',
    promptId: 'p',
    gates: [],
    at: 'T',
  })
  assert.ok(!('recoveredAfter' in clean.entry))
})

test('the ledger is trimmed to the tail — a turn log is a diagnostic, not an archive', () => {
  let records = Array.from({ length: KEEP + 50 }, (_, i) => ({
    kind: 'green',
    n: i,
  }))
  records = nextLedger(records, {
    blocked: false,
    cap: 8,
    sessionId: 's',
    promptId: 'p',
    gates: [],
    at: 'T',
  }).records
  assert.equal(records.length, KEEP)
  assert.equal(records.at(-1).kind, 'green')
  assert.equal(records[0].n, 51, 'the OLDEST records are the ones dropped')
})

test('nextLedger stamps `v` on block records — the field the one-time reader keys on (0.7.0)', () => {
  // The stamp is what makes the 0.7.0 tightening need NO ramp: only a mark carrying `v` may
  // convert the green-turn NOTE into a block, and nothing written before 0.7.0 carries one.
  const r = nextLedger([], {
    blocked: true,
    cap: 8,
    sessionId: 's',
    promptId: 'p',
    gates: ['validate'],
    at: 'T',
  })
  assert.equal(r.entry.v, '0.7.0')
  const g = nextLedger([], {
    blocked: false,
    cap: 8,
    sessionId: 's',
    promptId: 'p',
    gates: [],
    at: 'T',
  })
  assert.ok(!('v' in g.entry), 'green records carry no stamp — only block marks are ever read back')
})

// ---- reading it back ------------------------------------------------------------

test('parseLedger is TOLERANT — and its fail-closed sibling is the deliberate contrast', () => {
  // tools/lib/reviewer-verdicts.mjs fails CLOSED on a malformed line because that ledger
  // AUTHORIZES something: an unreadable one must not read as "no reviewer was owed". This one
  // authorizes nothing, so a corrupt line must not brick every turn on the machine.
  const raw = [
    '{"kind":"green"}',
    'not json at all',
    '',
    '"a string, not an object"',
    '{"kind":"block"}',
  ].join('\n')
  const { records, dropped } = parseLedger(raw)
  assert.equal(records.length, 2)
  assert.equal(dropped, 2)
})

test('capHitBlockEligible: a v-stamped mark may block; 0.6.0-written state stays a NOTE (0.7.0)', () => {
  // The versioned split IS the no-ramp argument: a mark written by a 0.6.0 hook has no `v`,
  // so no state that exists on an upgraded install can ever trigger the new one-time block.
  const stamped = { ...blockRec(8, 8, true, 'p0'), v: '0.7.0' }
  assert.equal(capHitBlockEligible(priorCapHit([stamped], 'p1')), true)
  assert.equal(
    capHitBlockEligible(priorCapHit([blockRec(8, 8, true, 'p0')], 'p1')),
    false,
    'a mark WITHOUT v is note-only',
  )
  assert.equal(capHitBlockEligible(null), false, 'no mark, no block')
})

test('priorCapHit reports a PREVIOUS turn only, and reports it once', () => {
  const capped = [blockRec(8, 8, true, 'p0')]
  assert.equal(priorCapHit(capped, 'p1')?.blocks, 8, 'a different turn must be reported')
  assert.equal(priorCapHit(capped, 'p0'), null, 'this turn is not its own predecessor')
  // Once anything else is appended the tail moves on, so the note stops without needing a
  // second piece of state to keep honest.
  assert.equal(priorCapHit([...capped, { kind: 'green' }], 'p1'), null)
  // A block that did NOT reach the cap is not a cap hit.
  assert.equal(priorCapHit([blockRec(2, 8, false, 'p0')], 'p1'), null)
})

// ---- the real hook --------------------------------------------------------------

test('a red turn writes a block record; a green turn writes a green one', () => {
  const red = fixture({ red: true })
  assert.equal(runStopHook(red).code, 2)
  const r = readLedger(red)
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'block')
  assert.equal(r[0].blocks, 1)
  assert.deepEqual(r[0].gates, ['validate'], 'the record must name WHICH gate was red')
  assert.equal(r[0].prompt_id, 'p1')

  const green = fixture({ red: false })
  assert.equal(runStopHook(green).code, 0)
  assert.equal(readLedger(green)[0].kind, 'green')
})

test('the LAST allowed block says so, in the only moment anything can still act on it', () => {
  const dir = fixture({
    red: true,
    ledger: serialize([blockRec(1, 2, false, 'p1')]),
  })
  const r = runStopHook(dir, { cap: '2' })
  assert.equal(r.code, 2)
  assert.match(r.out, /LAST CHANCE/)
  assert.match(r.out, /block 2 of 2/)
  assert.match(r.out, /will NOT block again/)
  assert.equal(readLedger(dir).at(-1).capReached, true)
})

test('a block below the cap does NOT claim to be the last one', () => {
  const dir = fixture({ red: true })
  const r = runStopHook(dir, { cap: '8' })
  assert.equal(r.code, 2)
  assert.ok(!r.out.includes('LAST CHANCE'), r.out)
  assert.equal(readLedger(dir).at(-1).capReached, false)
})

test('an unusable cap value is reported rather than silently reverting to 8', () => {
  const dir = fixture({ red: true })
  const r = runStopHook(dir, { cap: 'eight' })
  assert.match(r.out, /CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is set to an unusable value/)
})

test('a corrupt ledger does not brick the turn', () => {
  const dir = fixture({ red: false, ledger: '{ not json\n{"kind":"block"\n' })
  const r = runStopHook(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(existsSync(join(dir, LEDGER)))
})

test('recordTurnOutcome swallows its own I/O failure — bookkeeping never decides a turn', () => {
  // Three hooks share this function (the consumer Stop gate, the SubagentStop verdict hook,
  // and the factory's own Stop gate), so a throw here would brick every turn on the machine
  // rather than lose one record. An unwritable path must degrade to a reported error and an
  // otherwise-correct answer.
  const dir = mkdtempSync(join(tmpdir(), 'epah-turnlog-io-'))
  const unwritable = join(dir, 'not-a-dir.txt', 'ledger.jsonl')
  writeFileSync(join(dir, 'not-a-dir.txt'), 'this is a file, so it cannot be a parent directory')
  const r = recordTurnOutcome({
    blocked: true,
    gates: ['validate'],
    input: null,
    ledgerPath: unwritable,
  })
  assert.equal(r.blocks, 1, 'the count is still correct')
  assert.equal(r.capReached, false)
  assert.match(String(r.error), /could not write/)
})

test('recordTurnOutcome reads the cap from the ENV it is handed, not from a global', () => {
  // Observed 2026-08-07: settings.json's `env` block does reach a hook process, so the
  // scaffold's CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is a real input rather than a decoration.
  const dir = mkdtempSync(join(tmpdir(), 'epah-turnlog-env-'))
  const path = join(dir, 'ledger.jsonl')
  const r = recordTurnOutcome({
    blocked: true,
    input: null,
    ledgerPath: path,
    env: { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '1' },
  })
  assert.equal(r.cap, 1)
  assert.equal(r.capSource, 'env')
  assert.equal(r.capReached, true, 'with a cap of 1, the first block is already the last')
})

// ── SESSION SCOPING (0.9.0): two sessions in one directory ─────────────────────────
//
// THE DEFECT. readLedger/nextLedger treated the file TAIL as this session's history, so
// two concurrent sessions sharing a working tree (a) reset each other's consecutive-block
// count — session B's green at the tail zeroed session A's run mid-loop — and (b)
// CROSS-BLOCKED: B's first green Stop converted A's cap-hit mark into B's one-time block,
// forcing B to acknowledge gates it never abandoned, and consuming A's mark so A itself
// never saw it. Cap arithmetic is now computed over THIS session's records only, while the
// rewrite preserves every session's entries inside the one bounded global tail (KEEP).

test('SESSION SCOPING: another session\'s green does not reset this session\'s block run', () => {
  const a1 = nextLedger([], { blocked: true, cap: 3, sessionId: 'A', promptId: 'p', gates: ['validate'], at: 'T' })
  const a2 = nextLedger(a1.records, { blocked: true, cap: 3, sessionId: 'A', promptId: 'p', gates: ['validate'], at: 'T' })
  const b = nextLedger(a2.records, { blocked: false, cap: 3, sessionId: 'B', promptId: 'q', gates: [], at: 'T' })
  // Session B's green sits at the global tail — A's third block must still be its third.
  const a3 = nextLedger(b.records, { blocked: true, cap: 3, sessionId: 'A', promptId: 'p', gates: ['validate'], at: 'T' })
  assert.equal(a3.blocks, 3, "A's consecutive count survives B's interleaved green")
  assert.equal(a3.capReached, true, 'block 3 of 3 is the cap, whatever B did in between')
  // …and the rewrite preserved BOTH sessions' records.
  assert.equal(a3.records.filter((r) => r.session_id === 'B').length, 1)
  assert.equal(a3.records.filter((r) => r.session_id === 'A').length, 3)
})

test('SESSION SCOPING: a cap-hit mark blocks ITS OWN session\'s next green turn, not a stranger\'s', () => {
  const dir = fixture({
    red: false,
    ledger: serialize([{ ...blockRec(8, 8, true, 'p0'), v: '0.7.0', session_id: 'sA', gates: ['validate'] }]),
  })
  // Session B (green) must neither be blocked by nor consume A's evidence.
  const b = runStopHook(dir, { sessionId: 'sB', promptId: 'q1' })
  assert.equal(b.code, 0, `session B must not be cross-blocked by A's mark: ${b.out}`)
  assert.ok(!b.out.includes('THE PREVIOUS TURN ENDED RED'), b.out)
  // Session A comes back green: ITS mark is still there and converts into the one-time block.
  const a = runStopHook(dir, { sessionId: 'sA', promptId: 'p1' })
  assert.equal(a.code, 2, `A's own cap-hit evidence must have survived B's append: ${a.out}`)
  assert.match(a.out, /THE PREVIOUS TURN ENDED RED/)
  // Exactly once: A's own append moved A's tail.
  const again = runStopHook(dir, { sessionId: 'sA', promptId: 'p2' })
  assert.equal(again.code, 0, again.out)
})

// ── THE ADVISORY TURN LOCK (0.9.0) ──────────────────────────────────────────────────
// recordTurnOutcome writes .harness/turn.lock {session_id, pid, at} on every outcome and
// NOTEs — never blocks — when another LIVE session's FRESH lock is already there. The
// blocking half lives in `installer update` (tests/installer/update-turn-lock.test.mjs).

test('TURN LOCK: a fresh lock from another LIVE session is reported; the turn is never blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-turnlock-'))
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/turn.lock'),
    `${JSON.stringify({ session_id: 'other', pid: process.pid, at: new Date().toISOString() })}\n`,
  )
  const r = recordTurnOutcome({
    blocked: false,
    input: { session_id: 'mine', prompt_id: 'p' },
    ledgerPath: join(dir, '.harness/turn-outcomes.jsonl'),
  })
  assert.equal(r.error, null)
  assert.match(String(r.concurrentSession), /other/)
  // …and the lock now records THIS session — last writer wins, it is advisory.
  const lock = JSON.parse(readFileSync(join(dir, '.harness/turn.lock'), 'utf8'))
  assert.equal(lock.session_id, 'mine')
  assert.equal(lock.pid, process.pid)
})

test('TURN LOCK: same session, a stale lock, and a dead pid are all silent', () => {
  const cases = [
    { session_id: 'mine', pid: process.pid, at: new Date().toISOString() }, // own lock
    { session_id: 'other', pid: process.pid, at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }, // stale
    { session_id: 'other', pid: 2 ** 30, at: new Date().toISOString() }, // dead pid
  ]
  for (const lock of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'epah-turnlock-quiet-'))
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/turn.lock'), `${JSON.stringify(lock)}\n`)
    const r = recordTurnOutcome({
      blocked: false,
      input: { session_id: 'mine', prompt_id: 'p' },
      ledgerPath: join(dir, '.harness/turn-outcomes.jsonl'),
    })
    assert.equal(r.concurrentSession, null, JSON.stringify(lock))
  }
})

test('TURN LOCK: the Stop hook surfaces the concurrent session as a NOTE on a green turn', () => {
  const dir = fixture({ red: false })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/turn.lock'),
    `${JSON.stringify({ session_id: 'elsewhere', pid: process.pid, at: new Date().toISOString() })}\n`,
  )
  const r = runStopHook(dir)
  assert.equal(r.code, 0, `advisory means ADVISORY — the turn must not be blocked: ${r.out}`)
  assert.match(r.out, /another live session/i)
})

test('THE MARK SURVIVES: a turn that ended at the cap is reported by the next GREEN turn', () => {
  // The closure. Before 0.6.0 this fact was unrecoverable the moment the tree went green
  // again — which is exactly when someone would conclude the previous turn had finished
  // cleanly. `validate` being green NOW says nothing about whether the last turn ended on it.
  const dir = fixture({
    red: false,
    ledger: serialize([{ ...blockRec(8, 8, true, 'p0'), gates: ['validate', 'unit'] }]),
  })
  const r = runStopHook(dir, { promptId: 'p1' })
  assert.equal(r.code, 0, 'the tree is green, so this turn must not be blocked')
  assert.match(r.out, /THE PREVIOUS TURN ENDED RED/)
  assert.match(r.out, /blocked 8 time\(s\)/)
  assert.match(r.out, /validate, unit/, 'it must name the gates that were still failing')

  // …and it does not repeat forever: this turn's own green record moves the tail on.
  const second = runStopHook(dir, { promptId: 'p2' })
  assert.ok(!second.out.includes('THE PREVIOUS TURN ENDED RED'), second.out)
})
