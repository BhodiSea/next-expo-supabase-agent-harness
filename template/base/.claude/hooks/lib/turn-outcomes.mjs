// turn-outcomes.mjs — the pure half of the turn ledger: how many times a harness hook has
// blocked in a row, and whether the PREVIOUS turn ended because Claude Code stopped listening.
//
// THE HOLE THIS CLOSES. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is the documented safety valve that
// keeps a red gate from looping forever:
//
//   "Maximum number of consecutive times a Stop or SubagentStop hook may block the turn from
//    ending before Claude Code overrides it and ends the turn anyway (default: 8). Set to 0 to
//    disable the cap."
//
// The valve is RIGHT and stays — a hook that can block forever is a bricked machine, and the
// release note that introduced it says so plainly ("Fixed stop hooks that block repeatedly
// looping forever — the turn now ends with a warning after 8 consecutive blocks"). But through
// 0.5.0 nothing on this side recorded that it fired, so a turn that ended with the gate RED
// left exactly the same trace in the repository as one that ended green: none. The harness's
// whole claim is "a turn cannot end on a red build", and this is the one documented way it can.
//
// THE COUNT IS OF CONSECUTIVE BLOCKS AT THE TAIL, not of blocks keyed by prompt_id, because
// "consecutive" is the word the cap is defined with and a green record is exactly what resets
// it — the same reset condition Claude Code uses. That also makes the count work when the Stop
// payload carries no ids at all.
//
// STOP AND SUBAGENTSTOP BLOCKS SHARE ONE LEDGER, because the documented cap names both events
// in one sentence and does not say whether it counts them jointly or separately. Counting them
// together can only over-estimate, and over-estimating makes the warning arrive EARLY. Early is
// the safe direction for a warning whose subject is "you are about to lose the ability to
// block"; the alternative — under-counting SubagentStop blocks and staying silent through the
// last one — fails in the direction that leaves no mark, which is the defect being fixed.
//
// SHAPE: every decision below is pure and independently testable; `recordTurnOutcome` at the
// bottom is the ONE function that touches the disk, and it is here rather than in a hook
// because THREE hooks now write this ledger — the consumer Stop gate, the SubagentStop verdict
// hook, and the factory's own Stop gate. Three copies of "how many times have we blocked" is
// the drift this release has spent itself deleting.
// SOURCE: https://code.claude.com/docs/en/env-vars (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP)
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed Stop payload; settings `env` reaches hooks)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** Where the mark lives. `.harness/*` is gitignored (bar the manifest) — this is local turn state. */
export const TURN_LOG = '.harness/turn-outcomes.jsonl'

/**
 * The advisory single-flight lock (0.9.0), written beside the ledger on every outcome:
 * {session_id, pid, at}. ADVISORY — recordTurnOutcome only ever NOTEs about it (two live
 * sessions in one tree is a state to name, not a turn to brick); the one consumer that
 * REFUSES on a fresh live lock is `installer update` (refuseWhileTurnRuns, which mirrors
 * these semantics with a pointer back here — installer code never imports template
 * modules). Module-local, not exported: nothing imports them, and exporting an unimported
 * constant is exactly the dead API `knip --strict` reds a consumer for.
 */
const TURN_LOCK_FILE = 'turn.lock'

/** A lock older than this is stale and ignored — a crashed session must not haunt the tree. */
const TURN_LOCK_FRESH_MS = 10 * 60 * 1000

/** Claude Code's documented default when the env var is unset. */
export const DEFAULT_CAP = 8

/** Records kept. A turn log is a diagnostic, not an archive; the tail is the part anyone reads. */
export const KEEP = 200

/**
 * The cap in force, and WHY it has that value — the reason travels because the three cases
 * read identically in a message and mean very different things.
 *
 * `0` disables the cap entirely (documented), which is returned as `cap: null`: no number of
 * blocks is ever "the last one", so nothing should claim otherwise.
 * @param {Record<string, string|undefined>} env
 * @returns {{ cap: number|null, source: 'env'|'default'|'disabled'|'unparseable' }}
 */
export function readCap(env) {
  const raw = env?.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  if (raw === undefined || String(raw).trim() === '') return { cap: DEFAULT_CAP, source: 'default' }
  const n = Number(String(raw).trim())
  if (!Number.isInteger(n) || n < 0) return { cap: DEFAULT_CAP, source: 'unparseable' }
  if (n === 0) return { cap: null, source: 'disabled' }
  return { cap: n, source: 'env' }
}

/**
 * Parse the ledger, TOLERANTLY — and the contrast with its sibling is deliberate.
 *
 * `tools/lib/reviewer-verdicts.mjs` fails CLOSED on a malformed ledger line, because that
 * ledger is a control: an unreadable one must not be read as "no reviewer was owed". This
 * ledger is a DIAGNOSTIC — it records what already happened and gates nothing — so a corrupt
 * line here must not brick every turn on the machine. Same shape, opposite posture, and the
 * difference is whether anything downstream is authorized by the answer.
 * @param {string} raw
 * @returns {{ records: object[], dropped: number }}
 */
export function parseLedger(raw) {
  const records = []
  let dropped = 0
  for (const line of String(raw ?? '').split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      dropped += 1
      continue
    }
    if (parsed !== null && typeof parsed === 'object') records.push(parsed)
    else dropped += 1
  }
  return { records, dropped }
}

/**
 * Consecutive blocks ending at the tail — the same quantity the cap counts.
 * @param {object[]} records
 */
export function consecutiveBlocks(records) {
  let n = 0
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i]?.kind !== 'block') break
    n += 1
  }
  return n
}

/**
 * The mark that has to SURVIVE: a previous turn that ran out of blocks and ended red.
 *
 * Returns the record only when the ledger's last entry is a cap-reaching block from some OTHER
 * turn. Once this turn appends anything the tail moves on, so the note reports once and stops
 * — no acknowledgement flag, no second piece of state to keep honest.
 * @param {object[]} records @param {string|null} promptId
 */
export function priorCapHit(records, promptId) {
  const last = records[records.length - 1]
  if (last?.kind !== 'block' || last.capReached !== true) return null
  if (promptId !== null && last.prompt_id === promptId) return null
  return last
}

/**
 * Whether a prior cap-hit mark may convert into the ONE-TIME BLOCK (0.7.0), shared by both
 * Stop hooks so the consumer gate and the factory gate can never disagree about eligibility.
 *
 * Presence, not equality: any `v` means a 0.7.0-or-later hook wrote the mark, and a future
 * format bump must not quietly demote its own marks back to notes. A mark WITHOUT `v` was
 * written by a 0.6.0 hook and stays a NOTE forever — the versioned split that makes the
 * tightening need no ramp.
 * @param {object|null} mark
 */
export const capHitBlockEligible = (mark) => typeof mark?.v === 'string'

/**
 * THIS session's records (0.9.0). Cap arithmetic must never read another session's rows:
 * the ledger is shared by every session in the directory, and before this filter existed
 * two concurrent sessions reset each other's consecutive-block count and cross-consumed
 * each other's cap-hit marks.
 *
 * A record is FOREIGN only when BOTH sides carry a session id and they differ. Identity
 * can be missing on either side — a Stop payload with no ids at all (documented above as
 * a case the count must survive), or a record written before ids were recorded — and an
 * unattributable record reads as OURS, deliberately: this feeds a warning, and the
 * module's own doctrine is that over-counting makes the warning arrive EARLY, which is
 * the safe direction, while scoping-away a mark nobody can attribute fails in the
 * direction that leaves no mark — the defect the ledger exists to fix.
 * Module-local: only nextLedger and recordTurnOutcome consume it, and both live here.
 * @param {object[]} records @param {string|null} sessionId
 */
const sessionRecords = (records, sessionId) =>
  records.filter((r) => {
    const owner = typeof r?.session_id === 'string' ? r.session_id : null
    return sessionId === null || owner === null || owner === sessionId
  })

/**
 * The next ledger state after this Stop invocation, and what the hook should SAY about it.
 *
 * One function returns both because the two must agree: a banner claiming "this is the last
 * block" while the record says otherwise is a worse artifact than either alone.
 *
 * SESSION-SCOPED, GLOBALLY TRIMMED (0.9.0): `blocks`/`capReached` are computed over THIS
 * session's records only, while the rewrite appends into the one shared list and keeps the
 * bounded global tail (KEEP) — so another session's entries are PRESERVED, never rewritten
 * away by this one's trim. The bound stays global on purpose: the file is a diagnostic,
 * and one chatty session aging another's ancient records out of a 200-record tail is the
 * documented cost of keeping it one.
 * @param {object[]} records existing records, oldest first — ALL sessions'
 * @param {{ blocked: boolean, cap: number|null, sessionId: string|null, promptId: string|null,
 *           gates: string[], at: string }} turn
 * @returns {{ records: object[], entry: object, blocks: number, capReached: boolean }}
 */
export function nextLedger(records, turn) {
  const prior = consecutiveBlocks(sessionRecords(records, turn.sessionId))
  const blocks = turn.blocked ? prior + 1 : prior
  const capReached = turn.blocked && turn.cap !== null && blocks >= turn.cap
  const entry = turn.blocked
    ? {
        kind: 'block',
        // The format stamp the one-time reader keys on (0.7.0). Only a mark carrying `v` may
        // convert the next green turn's NOTE into a block — nothing written before 0.7.0
        // carries one, which is the versioned split that lets the tightening ship rampless:
        // no pre-existing ledger state can ever trigger the new behavior.
        v: '0.7.0',
        at: turn.at,
        session_id: turn.sessionId,
        prompt_id: turn.promptId,
        blocks,
        cap: turn.cap,
        capReached,
        gates: turn.gates,
      }
    : {
        kind: 'green',
        at: turn.at,
        session_id: turn.sessionId,
        prompt_id: turn.promptId,
        ...(prior > 0 ? { recoveredAfter: prior } : {}),
      }
  return { records: [...records, entry].slice(-KEEP), entry, blocks, capReached }
}

/** @param {object[]} records */
export const serialize = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'

/** Alive when signal 0 lands or is refused for PERMISSIONS — ESRCH is the only "dead". */
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * Read the sibling turn.lock and report ANOTHER live session's fresh claim, or null.
 * Module-local (recordTurnOutcome is its one caller): `installer update`'s refusal
 * helper mirrors these semantics rather than importing them — installer code never
 * imports template modules — and each side carries a pointer at the other.
 * @param {string} raw the lock file's content
 * @param {string|null} sessionId THIS session (null matches a lock with none)
 * @param {{ now?: number, isPidAlive?: (pid: number) => boolean }} [opts]
 * @returns {{ sessionId: string|null, pid: number, ageMs: number }|null}
 */
function liveForeignLock(raw, sessionId, { now = Date.now(), isPidAlive = pidAlive } = {}) {
  let lock
  try {
    lock = JSON.parse(raw)
  } catch {
    return null // an unreadable advisory lock advises nothing
  }
  if (lock === null || typeof lock !== 'object') return null
  if ((lock.session_id ?? null) === sessionId) return null
  const ageMs = now - Date.parse(lock.at ?? '')
  if (!Number.isFinite(ageMs) || ageMs >= TURN_LOCK_FRESH_MS) return null
  if (!isPidAlive(lock.pid)) return null
  return { sessionId: lock.session_id ?? null, pid: lock.pid, ageMs }
}

/**
 * Read the ledger, append this turn's outcome, write it back — the one impure function here,
 * and the only one three hooks share.
 *
 * BOOKKEEPING NEVER DECIDES A TURN. Every failure path is swallowed into `error` and the
 * caller's block decision is untouched: a ledger that cannot be written is a lost record,
 * which is bad; a turn that cannot end because of it would be worse, and a machine bricked by
 * its own diagnostics is how a control gets deleted rather than fixed.
 *
 * @param {{ blocked: boolean, gates?: string[], input?: object|null, ledgerPath?: string,
 *           env?: Record<string, string|undefined> }} spec
 * @returns {{ blocks: number, cap: number|null, capSource: string, capReached: boolean,
 *             priorCapHit: object|null, concurrentSession: string|null, error: string|null }}
 */
export function recordTurnOutcome({
  blocked,
  gates = [],
  input = null,
  ledgerPath = TURN_LOG,
  env = process.env,
}) {
  const { cap, source: capSource } = readCap(env)
  const promptId = typeof input?.prompt_id === 'string' ? input.prompt_id : null
  const sessionId = typeof input?.session_id === 'string' ? input.session_id : null

  let existing = []
  try {
    existing = parseLedger(readFileSync(ledgerPath, 'utf8')).records
  } catch {
    existing = [] // no ledger yet is the ordinary first-turn state, not a fault
  }

  // SESSION-SCOPED (0.9.0): the prior mark is judged against THIS session's tail. Before
  // this, session B's first green Stop consumed session A's cap-hit mark — B was blocked
  // for gates it never abandoned, and A never learned it ended red.
  const prior = priorCapHit(sessionRecords(existing, sessionId), promptId)
  const next = nextLedger(existing, {
    blocked,
    cap,
    sessionId,
    promptId,
    gates,
    at: new Date().toISOString(),
  })

  // The advisory turn lock (0.9.0): report another live session's fresh claim, then take
  // the lock for this one. Every failure here is swallowed — the lock is a courtesy, and
  // bookkeeping never decides a turn.
  let concurrentSession = null
  const lockPath = join(dirname(ledgerPath), TURN_LOCK_FILE)
  try {
    const foreign = liveForeignLock(readFileSync(lockPath, 'utf8'), sessionId)
    if (foreign !== null) {
      concurrentSession = `another live session (${foreign.sessionId ?? 'unknown session'}, pid ${String(foreign.pid)}) wrote ${lockPath} ${String(Math.round(foreign.ageMs / 1000))}s ago`
    }
  } catch {
    // no lock yet — the ordinary state
  }

  let error = null
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true })
    writeFileSync(ledgerPath, serialize(next.records))
  } catch (e) {
    error = `could not write ${ledgerPath} (${e?.message ?? e})`
  }
  try {
    writeFileSync(
      lockPath,
      `${JSON.stringify({ session_id: sessionId, pid: process.pid, at: new Date().toISOString() })}\n`,
    )
  } catch {
    // an unwritable advisory lock is not even worth an error field — the ledger is the record
  }

  return {
    blocks: next.blocks,
    cap,
    capSource,
    capReached: next.capReached,
    priorCapHit: prior,
    concurrentSession,
    error,
  }
}
