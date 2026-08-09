#!/usr/bin/env node
// SubagentStop hook — record every reviewer's terminal verdict, and refuse a reviewer that
// did not give one.
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
// the mandated verdict line is read directly. There is no transcript scraping, no jsonl
// parsing, no guessing at a format that changes between releases.
//
// TWO THINGS IT DOES, IN ORDER:
//   1. BLOCKS a reviewer whose final message does not end in the mandated form (exit 2,
//      which "prevents the subagent from stopping"). That enforces at RUNTIME the contract
//      check-docs-sync.mjs has only ever checked in the FILE.
//   2. Appends the verdict to a session-scoped ledger, which tools/check-reviewer-verdicts.mjs
//      reads as Stop-chain step 10. Since 0.7.0 the entry also carries `path_state` — the
//      shared pathStateDigest over the changed files this reviewer's triggers own, computed
//      AT RECORD TIME — which is what lets the Stop step refuse a PASS that predates the
//      last edit to the paths that summoned it.
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
import { pathStateDigest, readVerdict } from '../../tools/lib/reviewer-verdicts.mjs'
import { readHookInput } from './lib/hookio.mjs'
import { TURN_LOG, recordTurnOutcome } from './lib/turn-outcomes.mjs'

export const HARNESS_HOOK_VERSION = '0.7.0'

const AGENTS_DIR = '.claude/agents'
const LEDGER = '.harness/reviewer-ledger.jsonl'
const TRIGGERS = 'tools/reviewer-triggers.json'

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
    return pathStateDigest(agentType, cfg, changedFiles(), (p) =>
      existsSync(p) ? readFileSync(p) : null,
    )
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

const input = await readHookInput()

// FAIL CLOSED ON AN UNRECOGNIZABLE PAYLOAD — 0.3.0's stated requirement for this feature,
// and the same posture pretool-mcp-guard takes. A hook that cannot tell what happened must
// not report that nothing did.
if (input === null || typeof input !== 'object') {
  recordBlock('subagent-verdict/unparseable-payload', null)
  process.stderr.write(
    'subagent-verdict: the SubagentStop payload was empty or unparseable, so this hook cannot tell which agent ran or what it concluded. It fails CLOSED rather than recording a silence as a pass. If Claude Code changed the payload shape, re-probe it and update design/CONTROL-PLANE-FACTS.md.\n',
  )
  process.exit(2)
}

const agentType = typeof input.agent_type === 'string' ? input.agent_type : null
if (agentType === null || !reviewerTypes().has(agentType)) process.exit(0)

const verdict = readVerdict(input.last_assistant_message)
if (verdict === null) {
  // BLOCKING THE SUBAGENT, not the turn. Exit 2 on SubagentStop prevents the subagent from
  // stopping, so it gets another chance to say the thing its own file promises it will say.
  // This is the contract check-docs-sync.mjs asserts about the reviewer's BODY, enforced at
  // the moment it matters.
  recordBlock(`subagent-verdict/${agentType}`, input)
  process.stderr.write(
    `subagent-verdict: ${agentType} ended without a verdict. Its own definition requires the reply to end with exactly one line reading "VERDICT: PASS" or "VERDICT: BLOCK", and nothing after it. Re-state your conclusion in that form — a review nobody can parse is a review that did not happen.\n`,
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
  })}\n`,
)
process.exit(0)
