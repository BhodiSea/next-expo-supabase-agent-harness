#!/usr/bin/env node
// Stop-chain step 10 — every reviewer the DIFF summoned actually ran, and said PASS.
//
// This is the second half of the process layer; .claude/hooks/subagent-verdict.mjs is the
// first. That hook records each reviewer's terminal verdict into a session-scoped ledger from
// the `last_assistant_message` field SubagentStop hands it. This step decides who was OWED a
// verdict this turn, and refuses to let the turn end without one.
//
// WHY IT IS A STOP STEP AND NOT A CHAIN GATE. `pnpm validate` runs over a TREE and knows
// nothing about a turn. "Did the security reviewer run for these changes" is a question about
// a turn, and the ledger is keyed by the turn's prompt_id. A chain step asking it would either
// have to invent a turn boundary or answer about the wrong one.
//
// FAIL CLOSED, in every direction that matters:
//   - no ledger file, an unreadable one, or one whose lines do not parse -> BLOCK;
//   - the Stop hook did not pass down this turn's identity -> BLOCK (an unkeyed ledger would
//     let last turn's PASS satisfy this turn's obligation, which is the one failure mode that
//     would make the whole control decorative);
//   - a reviewer that was owed and is absent -> BLOCK;
//   - a reviewer that ran and said BLOCK -> BLOCK, loudly, because that is the case the
//     reviewer exists for and the one most likely to be argued with;
//   - a PASS whose path_state binding does not match the tree at Stop time — or carries
//     none at all (a pre-0.7.0 hook wrote it, or the hook could not compute one) -> BLOCK
//     toward re-review, because "a reviewer ran" and "a reviewer reviewed THIS" are
//     different claims and the difference is exactly the files that moved after the PASS.
//     This class alone rides a fresh 0.7.0 ramp (until 0.8.0) — see THE FRESH RAMP below.
//
// WHAT IT DELIBERATELY DOES NOT DO: judge the CONTENT of a review. A PASS is an attestation by
// a read-only agent whose tools, model and body are locked in tools/agents.lock.json. This
// step verifies the attestation exists and belongs to this turn. Whether it was a GOOD review
// is not a property any file can hold, and pretending otherwise would be the same "reads as
// coverage" mistake this release has spent itself deleting.
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed SubagentStop payload)
// SOURCE: CHANGELOG 0.3.0 (process-verified reviewers, deferred with the reason)
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { changedFiles } from './lib/git-diff.mjs'
import { owedBy, pathStateDigest, readLedger } from './lib/reviewer-verdicts.mjs'

const GATE = 'reviewer-verdicts'
const TRIGGERS = 'tools/reviewer-triggers.json'
const LEDGER = '.harness/reviewer-ledger.jsonl'
const RAMP = '0.6.0'
const BINDING_RAMP = '0.7.0'

if (!existsSync(TRIGGERS)) {
  fail(
    GATE,
    `${TRIGGERS} is missing — it is this step's entire subject, so its absence is a broken control rather than an empty policy. Restore it from git history, or re-run \`npx next-expo-supabase-agent-harness update\`.`,
  )
}
const cfg = JSON.parse(readFileSync(TRIGGERS, 'utf8'))

// THE TURN'S IDENTITY, passed down by stop-validate-gate.mjs from the Stop payload. Without
// it the ledger cannot be narrowed to this turn, and a PASS from an earlier turn would satisfy
// an obligation raised by this one. Outside the Stop hook there is no turn to judge, so the
// step skips loudly rather than inventing one — and fails closed in CI, where a Stop-chain
// step running without its identity means the hook that supplies it has changed.
const sessionId = process.env.HARNESS_SESSION_ID ?? null
const promptId = process.env.HARNESS_PROMPT_ID ?? null
if (sessionId === null || promptId === null) {
  skipOrFail(
    GATE,
    'no HARNESS_SESSION_ID/HARNESS_PROMPT_ID in the environment — this step is meaningful only inside the Stop hook, which passes the turn identity down from the SubagentStop payload',
  )
}

const files = changedFiles()
const owed = owedBy(files, cfg.reviewers ?? [])

if (owed.length === 0) {
  ok(GATE, `no reviewer is owed a verdict by this diff (${String(files.length)} changed file(s))`)
}

const errs = []
// THE THIRD FINDING CLASS (0.7.0), kept apart from `errs` because it rides its own ramp: a
// PASS that exists, belongs to this turn, and still proves nothing — the paths that summoned
// the reviewer moved after the verdict was recorded, or the entry carries no binding to
// check. Both fail TOWARD RE-REVIEW: re-running the reviewer is always the remedy, and it
// appends a fresh, correctly bound entry.
const stale = []
/** @param {string} p */
const readFileOrNull = (p) => (existsSync(p) ? readFileSync(p) : null)
if (!existsSync(LEDGER)) {
  errs.push(
    `${owed.length} reviewer(s) are owed a verdict by this diff and ${LEDGER} does not exist — no reviewer ran at all this turn. The ledger is written by .claude/hooks/subagent-verdict.mjs on SubagentStop; if it is missing entirely, check that the hook is wired in .claude/settings.json.`,
  )
} else {
  const read = readLedger(readFileSync(LEDGER, 'utf8'), sessionId, promptId, LEDGER)
  if (read.error !== null) {
    errs.push(
      `${read.error} — an unreadable ledger fails CLOSED. It is append-only machine output; if it has been hand-edited, delete it and re-run the reviewers.`,
    )
  } else {
    for (const o of owed) {
      const mine = read.entries.filter((e) => e.agent_type === o.agent)
      if (mine.length === 0) {
        errs.push(
          `${o.agent} did not run this turn, and \`${o.because}\` is why it is owed. ${o.why ?? ''} Run it, then end the turn.`,
        )
      } else if (mine.some((e) => e.verdict === 'BLOCK')) {
        errs.push(
          `${o.agent} returned VERDICT: BLOCK. That is the finding it exists to produce — fix what it named and run it again. A turn does not end on a BLOCK.`,
        )
      } else {
        // THE DIFF BINDING. Judge the LATEST entry — the ledger is append-only and
        // chronological, so re-running the reviewer after a fix appends the entry that
        // clears the very finding this raises. The digest is recomputed by the same shared
        // pathStateDigest the hook called at record time; `owed` implies the agent is in the
        // trigger table, so the recomputation is never null.
        const latest = mine.at(-1)
        const recorded = typeof latest.path_state === 'string' ? latest.path_state : null
        if (recorded === null) {
          stale.push(
            `${o.agent} returned PASS with no path_state binding — the entry predates the 0.7.0 hook, or the hook could not compute one, so nothing proves the PASS post-dates the last edit to the paths that summoned it. An unverifiable attestation fails toward re-review: run ${o.agent} again, then end the turn.`,
          )
        } else if (recorded !== pathStateDigest(o.agent, cfg, files, readFileOrNull)) {
          stale.push(
            `${o.agent} returned PASS for a different tree than the one this turn is shipping — the paths that summoned it (\`${o.because}\` among them) changed after its PASS was recorded. A stale verdict attests to nothing: run ${o.agent} again, then end the turn.`,
          )
        }
      }
    }
  }
}

// THE RAMP. An install that predates 0.6.0 has no ledger, no wired SubagentStop hook, and a
// turn already in progress when the step arrives. Every finding above would land at once on an
// upgrade nobody asked for. Projects grow into gates.
const rosterNoted =
  errs.length > 0 &&
  rampNote(GATE, RAMP, `the ${GATE} closure over the reviewer roster`, { until: '0.7.0' })
if (rosterNoted) {
  console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) withheld by the ${RAMP} ramp:`)
  for (const e of errs) console.log(`  - ${e}`)
}

// THE FRESH RAMP (0.7.0), covering ONLY the stale-binding class. The 0.6.0 ramp above
// covered this gate's EXISTENCE; the diff binding changes the verdict of turns that
// previously PASSED on existing installs — a mid-session upgrade delivers the new hook and
// gate into a turn already in flight, where every earlier PASS lacks path_state. That is
// the ambush shape the ramp doctrine exists for, so it gets its own deadline rather than
// inheriting an expired one.
const bindingNoted =
  stale.length > 0 &&
  rampNote(
    GATE,
    BINDING_RAMP,
    'the verdict-to-diff binding (a PASS must post-date the last edit to the paths that summoned it)',
    { until: '0.8.0' },
  )
if (bindingNoted) {
  console.log(
    `${GATE}: NOTE — ${String(stale.length)} stale-binding finding(s) withheld by the ${BINDING_RAMP} ramp:`,
  )
  for (const e of stale) console.log(`  - ${e}`)
}

failures(
  GATE,
  [...(rosterNoted ? [] : errs), ...(bindingNoted ? [] : stale)],
  `Each finding names a reviewer whose own definition says it MUST BE USED for the paths this turn touched. The trigger patterns are reviewed data in ${TRIGGERS} — if one over-matches, narrow it in a reviewed diff rather than skipping the review.`,
)
if (rosterNoted || bindingNoted) {
  ok(GATE, 'NOTE-only on this pre-ramp install (each ramp names its deadline above)')
}
ok(
  GATE,
  `${String(owed.length)} owed reviewer(s) all returned PASS this turn (${owed.map((o) => o.agent).join(', ')})`,
)
