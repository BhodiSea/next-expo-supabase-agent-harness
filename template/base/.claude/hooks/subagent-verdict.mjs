#!/usr/bin/env node
// SubagentStop hook — record every reviewer's terminal verdict, and refuse a reviewer that
// did not give one. Since 1.1.0 it is the SubagentStart hook too: it records the tree each
// reviewer was dispatched on.
//
// THE GAP THIS CLOSES, stated plainly. Ten subagents, seven slash commands and two skills are
// the layer that is supposed to make Claude Code's behaviour deterministic. Eight of them
// carry `MUST BE USED` declarations. Through 0.5.0, NOTHING anywhere read a transcript, hooked
// SubagentStop, or otherwise observed that any of them ran. What was enforced about the roster
// is real but orthogonal: the files must exist, their frontmatter must parse under a pinned
// grammar, their tools must be a read-only subset, they must carry `disallowedTools:
// Write, Edit`, their bodies must end demanding exactly `VERDICT: PASS` or `VERDICT: BLOCK`,
// and the whole surface is sha-locked in tools/agents.lock.json. Every one of those properties
// is about WHAT THE FILE SAYS. None is about whether it ran.
//
// The project scoped this fix itself and deferred it — CHANGELOG 0.3.0, "Deferred, with the
// reason": "process-verified reviewers (which must fail closed on an unrecognizable
// transcript, and must not move the Stop chain 9 -> 10 in the same release that first freezes
// it)". Both conditions are now met: 0.3.0 was the release that froze the Stop chain, and this
// is three releases later.
//
// WHY THIS IS CHEAP RATHER THAN CLEVER, and it is the whole reason the design changed. The
// payload was probed against a real invocation before a line of this was written (see
// design/CONTROL-PLANE-FACTS.md, observed 2026-08-07): `SubagentStop` carries
// `last_assistant_message` as a FIRST-CLASS FIELD holding the subagent's full final text. So
// the mandated verdict line is read directly, and the VERDICT never comes from a transcript.
//
// ONE THING DOES, SINCE 1.1.0 (#62): the model the verdict ran on. No Subagent* payload names
// a model (CONTROL-PLANE-FACTS, Fact 16), and a reviewer can run off its pin through a
// per-invocation model, an override, an allowlist substitution or a fallback chain. So the
// hook reads the subagent's OWN transcript, the JSONL at `agent_transcript_path`, for the
// model of its last assistant line (tools/lib/reviewer-verdicts.mjs transcriptModel), and
// records it as `model` beside `pinned`, whether that model matches the agent file's pin.
// That transcript's shape is documented only thinly and is NOT yet probed, so the read is
// bookkeeping in the strict sense: anything it cannot read is `model: null`, and neither the
// verdict nor the exit code ever depends on it. The Stop step decides what a null means.
//
// TWO THINGS IT DOES, IN ORDER:
//   1. BLOCKS a reviewer whose final message carries no readable verdict (exit 2, which
//      "prevents the subagent from stopping"). That enforces at RUNTIME the contract
//      check-docs-sync.mjs has only ever checked in the FILE. What counts as readable is
//      tools/lib/reviewer-verdicts.mjs's grammar, asymmetric since 1.0.2: a PASS must be
//      the exact terminal line, a BLOCK is taken wherever a line states it, and a message
//      stating both is bounced. Every bounce is appended to .harness/verdict-bounces.jsonl.
//   2. Appends the verdict to a session-scoped ledger, which tools/check-reviewer-verdicts.mjs
//      reads as Stop-chain step 10. Since 0.7.0 the entry also carries `path_state` — the
//      shared pathStateDigest over the changed files this reviewer's triggers own, computed
//      AT RECORD TIME — which is what lets the Stop step refuse a PASS that predates the
//      last edit to the paths that summoned it.
//
// AND, SINCE 1.1.0, THE DISPATCH RECORD (the reviewer ledger v2). On SubagentStart, whose
// payload carries the same session_id and agent_id and no message (CONTROL-PLANE-FACTS,
// Fact 3), it appends the reviewer's v2 digest to .harness/reviewer-dispatch.jsonl and exits
// 0. Never into the ledger: an older lib fails closed on a line from this turn that has no
// `verdict`. On SubagentStop it copies the latest matching record's digest into the entry as
// `path_state_start`, beside `path_state_stop`, the same digest taken now. The Stop step
// counts a PASS only when the two agree with the tree at Stop, so a review of a tree that
// moved underneath it does not count, and neither does a verdict with no start record.
// Both digests are reviewStateDigest over reviewChanges(), the list the Stop step digests.
// The branch on hook_event_name is what makes the wiring safe: a 1.0.x copy of this hook
// read a SubagentStart payload as a reviewer that ended without a verdict and exited 2.
//
// IT IS SILENT FOR NON-REVIEWERS. The roster is read from .claude/agents/, not duplicated into
// a settings.json matcher — a matcher string would be a second copy of the roster, and the one
// thing this release has learned repeatedly is that two copies of a list drift.
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed SubagentStop payload)
// SOURCE: docs/harness/README.md (hooks are the enforcement; memory files are advisory)
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { changedFiles } from '../../tools/lib/git-diff.mjs'
// And git-diff as a NAMESPACE (1.1.0): `reviewChanges` is new, and a parked fork of the lib
// without it must still load. The v2 digests are then null, which the judge never counts.
import * as gitDiff from '../../tools/lib/git-diff.mjs'
// A NAMESPACE import, deliberately (1.0.2). `classifyVerdict` is new in this release, and an
// install may carry a FORKED tools/lib/reviewer-verdicts.mjs that `update` parked rather than
// refreshed. A static named import of an export that lib lacks fails at LINK time, before a
// line of this hook runs — and then every SubagentStop, reviewer or not, dies on a load
// error instead of being judged. Through the namespace a missing export is `undefined`, and
// the hook falls back to `readVerdict`, whose name and return domain did not change.
import * as verdicts from '../../tools/lib/reviewer-verdicts.mjs'
// hookio as a NAMESPACE too (1.0.4), for the same reason: `recordHookEvent` is new, and a
// forked lib/hookio.mjs that `update` parked must still load. The guarded call is a no-op there.
import * as hookio from './lib/hookio.mjs'
// And the roster grammar as a NAMESPACE (1.1.0, #62): `modelPolicy` is new, and a parked fork
// of tools/lib/agent-roster.mjs without it must still load. `pinned` is then null.
import * as roster from '../../tools/lib/agent-roster.mjs'
import { TURN_LOG, recordTurnOutcome } from './lib/turn-outcomes.mjs'

export const HARNESS_HOOK_VERSION = '1.1.0'

const AGENTS_DIR = '.claude/agents'
const LEDGER = '.harness/reviewer-ledger.jsonl'
// Every bounce, kept (1.0.2). The turn log records only THAT this hook blocked and is
// trimmed to its last 200 rows, so a run of bounces — two reviewer bodies caused one on
// every review — left nothing to diagnose it from. Append-only, never trimmed, a diagnostic
// and nothing else: no gate reads it, and .harness/* is already git-ignored.
const BOUNCES = '.harness/verdict-bounces.jsonl'
const TRIGGERS = 'tools/reviewer-triggers.json'
// The v2 dispatch records (1.1.0): one line per reviewer SubagentStart, keyed by session_id
// and agent_id. Append-only, like the ledger, and like it under the write-guarded .harness/.
const DISPATCH = '.harness/reviewer-dispatch.jsonl'

/**
 * The tree state this verdict attests to (0.7.0): pathStateDigest over the changed files
 * this reviewer's triggers own, computed at RECORD time so the Stop step can prove the PASS
 * post-dates the last edit to the paths that summoned it.
 *
 * Null on ANY failure — a missing or corrupt trigger table, an agent it does not name, a
 * git it cannot ask — and the swallow is safe in exactly one direction, the same direction
 * `recordTurnOutcome` swallows: bookkeeping must never be the reason a verdict is not
 * recorded, and check-reviewer-verdicts.mjs reads a null binding as "re-review", never as a
 * pass. Failing OPEN here would require the judge to fail closed anyway; failing the WRITE
 * would eat the verdict itself.
 * @param {string} agentType
 */
function pathState(agentType) {
  try {
    const cfg = JSON.parse(readFileSync(TRIGGERS, 'utf8'))
    return verdicts.pathStateDigest(agentType, cfg, changedFiles(), (p) =>
      existsSync(p) ? readFileSync(p) : null,
    )
  } catch {
    return null
  }
}

/**
 * The v2 tree state (1.1.0): reviewStateDigest over reviewChanges(), the same two calls the
 * Stop step makes, so the hook and the step digest the same file list. Null on ANY failure,
 * for pathState's reason: bookkeeping never decides whether a verdict is recorded, and the
 * judge never counts a null.
 * @param {string} agentType
 */
function reviewState(agentType) {
  try {
    if (typeof gitDiff.reviewChanges !== 'function' || typeof verdicts.reviewStateDigest !== 'function') {
      return null
    }
    const cfg = JSON.parse(readFileSync(TRIGGERS, 'utf8'))
    return verdicts.reviewStateDigest(agentType, cfg, gitDiff.reviewChanges().files, (p) =>
      existsSync(p) ? readFileSync(p) : null,
    )
  } catch {
    return null
  }
}

/**
 * The digest this reviewer's LATEST dispatch record holds, or null (no record, no digest, an
 * unreadable file, or a lib without the reader).
 * @param {unknown} sessionId @param {unknown} agentId
 */
function dispatchDigest(sessionId, agentId) {
  try {
    if (!existsSync(DISPATCH) || typeof verdicts.latestDispatchDigest !== 'function') return null
    return verdicts.latestDispatchDigest(readFileSync(DISPATCH, 'utf8'), sessionId, agentId)
  } catch {
    return null
  }
}

/**
 * The model this verdict ran on, and whether it is the agent's pin (1.1.0, #62): the model of
 * the last assistant line of the subagent's own transcript, matched against the `model` of
 * its agent file by the shared alias rule. `{ model: null, pinned: null }` on ANY failure (no
 * transcript path, an unreadable file, no model in it, a lib without the readers), and
 * `pinned` alone is null when the pin cannot be read. pathState's reason again: bookkeeping
 * never decides whether a verdict is recorded.
 * @param {string} agentType
 * @returns {{ model: string|null, pinned: boolean|null }}
 */
function ranOn(agentType) {
  const none = { model: null, pinned: null }
  try {
    const path = input.agent_transcript_path
    if (typeof path !== 'string' || typeof verdicts.transcriptModel !== 'function') return none
    const model = verdicts.transcriptModel(readFileSync(path, 'utf8'))
    if (model === null) return none
    return { model, pinned: isPinned(agentType, model) }
  } catch {
    return none
  }
}

/** @param {string} agentType @param {string} model @returns {boolean|null} */
function isPinned(agentType, model) {
  try {
    if (typeof roster.modelPolicy !== 'function' || typeof verdicts.modelMatches !== 'function') {
      return null
    }
    const pin = roster.modelPolicy(readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8'))?.pin
    return typeof pin === 'string' ? verdicts.modelMatches(pin, model) : null
  } catch {
    return null
  }
}

/**
 * Record a block into the SHARED turn ledger before exiting 2.
 *
 * Shared with stop-validate-gate.mjs because the cap it feeds is documented over both events
 * in one sentence — "the maximum number of consecutive times a Stop or SubagentStop hook may
 * block" — and a count that saw only half of them would go quiet on exactly the turns that
 * needed the warning. `recordTurnOutcome` swallows its own I/O failures, so this can never be
 * the reason a block does not happen.
 * @param {string} gate @param {object|null} payload
 */
const recordBlock = (gate, payload) =>
  recordTurnOutcome({ blocked: true, gates: [gate], input: payload, ledgerPath: TURN_LOG })

/**
 * The reviewer roster, read from the shipped agent files.
 *
 * A REVIEWER is an agent that declares `disallowedTools` including Write and Edit — the
 * property check-docs-sync.mjs already enforces and the one that actually distinguishes a
 * reviewer from an author. Deriving it beats listing it: `dal-author` and `test-author`
 * produce diffs and attest to nothing, and a hand-kept list of which is which is one rename
 * away from summoning the wrong set.
 */
function reviewerTypes() {
  if (!existsSync(AGENTS_DIR)) return new Set()
  const out = new Set()
  for (const f of readdirSync(AGENTS_DIR).sort()) {
    if (!f.endsWith('.md')) continue
    const src = readFileSync(join(AGENTS_DIR, f), 'utf8')
    const name = src.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1]
    const disallowed = src.match(/^disallowedTools:\s*(.+)$/m)?.[1] ?? ''
    if (name !== undefined && /\bWrite\b/.test(disallowed) && /\bEdit\b/.test(disallowed)) {
      out.add(name)
    }
  }
  return out
}

const input = await hookio.readHookInput()

// FAIL CLOSED ON AN UNRECOGNIZABLE PAYLOAD — 0.3.0's stated requirement for this feature,
// and the same posture pretool-mcp-guard takes. A hook that cannot tell what happened must
// not report that nothing did.
if (input === null || typeof input !== 'object') {
  recordBlock('subagent-verdict/unparseable-payload', null)
  hookio.recordHookEvent?.({ hook: 'subagent-verdict', rule: 'unparseable-payload', input: null }, 'bounce')
  process.stderr.write(
    'subagent-verdict: the SubagentStop payload was empty or unparseable, so this hook cannot tell which agent ran or what it concluded. It fails CLOSED rather than recording a silence as a pass. If Claude Code changed the payload shape, re-probe it and update design/CONTROL-PLANE-FACTS.md.\n',
  )
  process.exit(2)
}

const agentType = typeof input.agent_type === 'string' ? input.agent_type : null
if (agentType === null || !reviewerTypes().has(agentType)) process.exit(0)

// SubagentStart (1.1.0): record the tree this reviewer was dispatched on, and nothing else.
// Exit 0 whatever happens: SubagentStart cannot block (exit 2 only shows stderr), and a
// dispatch that could not be recorded surfaces at Stop as a verdict with no start record.
if (input.hook_event_name === 'SubagentStart') {
  try {
    mkdirSync(dirname(DISPATCH), { recursive: true })
    appendFileSync(
      DISPATCH,
      `${JSON.stringify({
        session_id: input.session_id ?? null,
        prompt_id: input.prompt_id ?? null,
        agent_type: agentType,
        agent_id: input.agent_id ?? null,
        path_state_start: reviewState(agentType),
      })}\n`,
    )
  } catch {
    // the missing record is named at Stop; a dispatch is never blocked on bookkeeping
  }
  process.exit(0)
}

const { verdict, shape } =
  typeof verdicts.classifyVerdict === 'function'
    ? verdicts.classifyVerdict(input.last_assistant_message)
    : { verdict: verdicts.readVerdict(input.last_assistant_message), shape: 'unclassified' }

/**
 * What the reviewer's last line was and why it did not parse. BOOKKEEPING NEVER DECIDES THE
 * OUTCOME: the exit 2 below happens whether or not this write does.
 */
function recordBounce() {
  try {
    const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
    const lastLine = message.trimEnd().split('\n').at(-1)?.trim() ?? ''
    mkdirSync(dirname(BOUNCES), { recursive: true })
    appendFileSync(
      BOUNCES,
      `${JSON.stringify({
        at: new Date().toISOString(),
        session_id: input.session_id ?? null,
        agent_type: agentType,
        shape,
        last_line: lastLine.slice(0, 200),
      })}\n`,
    )
  } catch {
    // a diagnostic that cannot be written changes nothing about the verdict
  }
}

// The one shape worth its own sentence: the reviewer DID give a verdict — two of them.
const SHAPE_HINT =
  shape === 'both-forms'
    ? ' Your message states both a PASS and a BLOCK verdict line — state exactly one.'
    : ''

if (verdict === null) {
  // BLOCKING THE SUBAGENT, not the turn. Exit 2 on SubagentStop prevents the subagent from
  // stopping, so it gets another chance to say the thing its own file promises it will say.
  // This is the contract check-docs-sync.mjs asserts about the reviewer's BODY, enforced at
  // the moment it matters.
  recordBlock(`subagent-verdict/${agentType}`, input)
  recordBounce()
  // Telemetry (1.0.4): the bounce and its verdict SHAPE — never the message.
  hookio.recordHookEvent?.({ hook: 'subagent-verdict', rule: shape, input }, 'bounce')
  process.stderr.write(
    `subagent-verdict: ${agentType} ended without a verdict. Its own definition requires the reply to end with exactly one line reading "VERDICT: PASS" or "VERDICT: BLOCK", and nothing after it.${SHAPE_HINT} Re-state your conclusion in that form — a review nobody can parse is a review that did not happen.\n`,
  )
  process.exit(2)
}

mkdirSync(dirname(LEDGER), { recursive: true })
appendFileSync(
  LEDGER,
  `${JSON.stringify({
    session_id: input.session_id ?? null,
    prompt_id: input.prompt_id ?? null,
    agent_type: agentType,
    agent_id: input.agent_id ?? null,
    verdict,
    path_state: pathState(agentType),
    // The reviewer ledger v2 pair (1.1.0): the tree at dispatch and the tree now.
    path_state_start: dispatchDigest(input.session_id, input.agent_id),
    path_state_stop: reviewState(agentType),
    // The model the verdict ran on (1.1.0, #62), and whether it is the agent's pin.
    ...ranOn(agentType),
  })}\n`,
)
process.exit(0)
