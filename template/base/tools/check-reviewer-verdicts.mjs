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
// a turn, and the ledger is keyed by the turn's session_id and prompt_id. A chain step asking
// it would either have to invent a turn boundary or answer about the wrong one.
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
// THE REVIEWER LEDGER v2 (1.1.0), behind ONE ramp opened at 1.1.0, until 2.1.0. The 1.0.x
// judgement owed reviewers on the diff against HEAD and judged one prompt, so a commit made
// before Stop emptied the owed set, a deletion owed nobody, a BLOCK was forgotten when the
// user next spoke, and a reviewer could not clear its own BLOCK. v2 judges the branch:
//   - the owed set is reviewChanges(), the merge-base diff with deletions
//     (tools/lib/git-diff.mjs); with no merge base (no upstream, and not a CI pull-request
//     run) v2 does not judge, and says so;
//   - the ledger is read for the whole SESSION: a BLOCK stands until the SAME agent_id
//     returns PASS at the current digest, and a counted PASS whose digest still matches
//     stands for a later prompt (settled);
//   - a PASS counts only when the digest the hook took at SubagentStart (path_state_start),
//     the one it took at the verdict (path_state_stop) and the one now are the same;
//   - the `wholeTurn` class of the trigger table is owed on every non-empty diff.
// On an install whose baseVersion predates 1.1.0 the 1.0.x judgement stays ENFORCING and v2
// prints as NOTEs. The two relaxations (a cleared BLOCK, a settled PASS) apply only where v2
// is live, so no install gets them without the tightening. `path_state` keeps its v1 meaning
// and v2's digests live in fields of their own, so a pre-1.1.0 judge never meets a digest it
// cannot reproduce.
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
// NAMESPACE imports for the 1.1.0 surface, the hook's 1.0.2 rule applied to the step: an
// install may carry a forked copy of either lib that `update` parked rather than refreshed,
// and a named import of an export that copy lacks fails at LINK time, before this step can
// say anything. Through the namespace a missing export is `undefined`, and v2 names the
// parked fork as its finding instead. The named imports are the ones every copy since
// 0.7.0 exports.
import * as gitDiff from './lib/git-diff.mjs'
import { changedFiles } from './lib/git-diff.mjs'
import * as verdicts from './lib/reviewer-verdicts.mjs'
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

/** @param {string} p */
const readFileOrNull = (p) => (existsSync(p) ? readFileSync(p) : null)

// The ledger is read ONCE, for both judgements. Malformed lines are bounded to the LINE
// (0.9.0): a torn write from a crashed session is named and stepped over, never allowed to
// brick every later turn in the directory.
const rawLedger = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : null
const turnRead = rawLedger === null ? null : readLedger(rawLedger, sessionId, promptId, LEDGER)
for (const s of turnRead?.skipped ?? []) console.log(`${GATE}: NOTE — ${s}`)

const TORN_REMEDY =
  "this turn's own verdict lines must be readable, so it fails CLOSED. Run the reviewer again: the ledger is append-only and the LATEST entry is the one judged, so a fresh well-formed PASS supersedes the torn line. (The file is write-guard-protected — clearing it wholesale is a human act under HARNESS_ALLOW_SELF_EDIT=1, and re-running the reviewer makes that unnecessary.)"

// ── THE 1.0.x JUDGEMENT: the diff against HEAD, this prompt ─────────────────────────────

/**
 * One owed reviewer against THIS TURN's entries. `err` is the absent and BLOCK class;
 * `stale` is the third finding class (0.7.0), kept apart because it rides its own ramp: a
 * PASS that exists, belongs to this turn, and still proves nothing — the paths that summoned
 * the reviewer moved after the verdict was recorded, or the entry carries no binding to
 * check. Both fail TOWARD RE-REVIEW: re-running the reviewer is always the remedy, and it
 * appends a fresh, correctly bound entry.
 * @param {{agent: string, because: string, why?: string}} o
 * @param {Array<Record<string, unknown>>} entries
 * @param {string[]} files
 * @returns {{ err?: string, stale?: string }}
 */
function judgeOneV1(o, entries, files) {
  const mine = entries.filter((e) => e.agent_type === o.agent)
  if (mine.length === 0) {
    return {
      err: `${o.agent} did not run this turn, and \`${o.because}\` is why it is owed. ${o.why ?? ''} Run it, then end the turn.`,
    }
  }
  if (mine.some((e) => e.verdict === 'BLOCK')) {
    // ANY entry, not the latest: a BLOCK is sticky for the turn under this judgement, and
    // the message says so (1.0.2). Letting a same-turn PASS by the same agent clear it is a
    // semantics change, and it shipped in 1.1.0 as the reviewer ledger v2, behind its own
    // ramp: where v2 is live it decides, and this finding is superseded.
    return {
      err: `${o.agent} returned VERDICT: BLOCK. That is the finding it exists to produce — fix what it named. A turn does not end on a BLOCK, and this one stands for the rest of THIS turn: the ledger keeps every entry, so re-running the reviewer now and getting a PASS does not clear it. On the next turn ${o.agent} is owed again for as long as the diff still touches its paths, and its PASS there is what clears this.`,
    }
  }
  // THE DIFF BINDING. Judge the LATEST entry — the ledger is append-only and chronological,
  // so re-running the reviewer after a fix appends the entry that clears the very finding
  // this raises. The digest is recomputed by the same shared pathStateDigest the hook called
  // at record time; `owed` implies the agent is in the trigger table, so the recomputation is
  // never null.
  const latest = mine.at(-1) ?? {}
  const recorded = typeof latest.path_state === 'string' ? latest.path_state : null
  if (recorded === null) {
    return {
      stale: `${o.agent} returned PASS with no path_state binding — the entry predates the 0.7.0 hook, or the hook could not compute one, so nothing proves the PASS post-dates the last edit to the paths that summoned it. An unverifiable attestation fails toward re-review: run ${o.agent} again, then end the turn.`,
    }
  }
  if (recorded !== pathStateDigest(o.agent, cfg, files, readFileOrNull)) {
    return {
      stale: `${o.agent} returned PASS for a different tree than the one this turn is shipping — the paths that summoned it (\`${o.because}\` among them) changed after its PASS was recorded. A stale verdict attests to nothing: run ${o.agent} again, then end the turn.`,
    }
  }
  return {}
}

/**
 * @param {Array<{agent: string, because: string, why?: string}>} owed
 * @param {string[]} files
 * @returns {{ errs: string[], stale: string[] }}
 */
function judgeV1(owed, files) {
  if (owed.length === 0) return { errs: [], stale: [] }
  if (turnRead === null) {
    return {
      errs: [
        `${owed.length} reviewer(s) are owed a verdict by this diff and ${LEDGER} does not exist — no reviewer ran at all this turn. The ledger is written by .claude/hooks/subagent-verdict.mjs on SubagentStop; if it is missing entirely, check that the hook is wired in .claude/settings.json.`,
      ],
      stale: [],
    }
  }
  if (turnRead.error !== null) return { errs: [`${turnRead.error} — ${TORN_REMEDY}`], stale: [] }
  const errs = []
  const stale = []
  for (const o of owed) {
    const r = judgeOneV1(o, turnRead.entries, files)
    if (r.err !== undefined) errs.push(r.err)
    if (r.stale !== undefined) stale.push(r.stale)
  }
  return { errs, stale }
}

const files = changedFiles()
const owed = owedBy(files, cfg.reviewers ?? [])
const { errs, stale } = judgeV1(owed, files)

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

const v1Findings = [...(rosterNoted ? [] : errs), ...(bindingNoted ? [] : stale)]
const V1_HINT = `Each finding names a reviewer whose own definition says it MUST BE USED for the paths this turn touched. The trigger patterns are reviewed data in ${TRIGGERS} — if one over-matches, narrow it in a reviewed diff rather than skipping the review.`

/** The 1.0.x verdict, when it is the one that decides. @returns {never} */
function v1Verdict() {
  failures(GATE, v1Findings, V1_HINT)
  if (rosterNoted || bindingNoted) {
    ok(GATE, 'NOTE-only on this pre-ramp install (each ramp names its deadline above)')
  }
  if (owed.length === 0) {
    ok(GATE, `no reviewer is owed a verdict by this diff (${String(files.length)} changed file(s))`)
  }
  ok(
    GATE,
    `${String(owed.length)} owed reviewer(s) all returned PASS this turn (${owed.map((o) => o.agent).join(', ')})`,
  )
}

// ── THE REVIEWER LEDGER v2 (1.1.0): the merge-base diff, the whole session ──────────────

/** @param {unknown} e */
const firstLineOf = (e) => String(e instanceof Error ? e.message : e).split('\n')[0]

/**
 * @param {Array<{agent: string, because: string, why?: string, wholeTurn?: boolean}>} owed2
 * @param {string[]} reviewFiles
 * @returns {string[]}
 */
function v2Findings(owed2, reviewFiles) {
  const read =
    rawLedger === null
      ? { entries: [], error: null }
      : verdicts.readSessionLedger(rawLedger, sessionId, promptId, LEDGER)
  if (read.error !== null) return [`${read.error} — ${TORN_REMEDY}`]
  const findings = []
  for (const o of owed2) {
    const current = verdicts.reviewStateDigest(o.agent, cfg, reviewFiles, readFileOrNull)
    const finding = verdicts.judgeReviewerV2(o, read.entries, current)
    if (finding !== null) findings.push(finding)
  }
  return findings
}

/** A v2 judgement that could not run at all: one finding, subject to the ramp like any other. */
const v2Broken = (finding) => ({
  ran: true,
  base: null,
  owed: [],
  fileCount: 0,
  findings: [finding],
})

/**
 * The v2 judgement, or `{ ran: false }` when this branch has no merge base.
 * @returns {{ ran: boolean, base?: string|null, owed?: Array<{agent: string}>, fileCount?: number, findings?: string[] }}
 */
function judgeV2() {
  const lib = [
    gitDiff.reviewChanges,
    verdicts.owedByTurn,
    verdicts.readSessionLedger,
    verdicts.judgeReviewerV2,
    verdicts.reviewStateDigest,
  ]
  if (lib.some((f) => typeof f !== 'function')) {
    return v2Broken(
      'tools/lib/git-diff.mjs or tools/lib/reviewer-verdicts.mjs predates 1.1.0, so the reviewer ledger v2 cannot judge this branch. It is an owned file you forked: `update` kept your copy and parked the 1.1.0 one under .harness/pending/. Merge the parked copy into yours, then re-record the sha (docs/runbooks/harness-upgrade.md, 1.0.2 section, "Forking an owned file").',
    )
  }
  let review
  try {
    review = gitDiff.reviewChanges()
  } catch (e) {
    return v2Broken(
      `the reviewer ledger v2 could not compute the owed set (${firstLineOf(e)}). A diff it cannot compute is not an empty one. In CI the usual cause is a shallow checkout, and \`fetch-depth: 0\` is the fix.`,
    )
  }
  if (review.base === null) return { ran: false }
  const owed2 = verdicts.owedByTurn(review.files, cfg)
  return {
    ran: true,
    base: review.base,
    owed: owed2,
    fileCount: review.files.length,
    findings: owed2.length === 0 ? [] : v2Findings(owed2, review.files),
  }
}

const v2 = judgeV2()
const v2Owed = v2.owed ?? []
const v2Found = v2.findings ?? []

// DECISION 1 (1.1.0): NO MERGE BASE, NO v2. A fresh `git init` with no remote, or a branch
// with no upstream configured, has nothing to key the owed set on, and the uncommitted-only
// set is the one v2 exists to replace. So v2 does not judge it, and says so on every run;
// the 1.0.x judgement decides exactly as before, and neither relaxation applies. Every
// clean-scaffold run in the harness's own CI takes this path: a fresh `git init`, and an
// untracked pnpm-lock.yaml the v2 set would owe both whole-turn reviewers for.
if (!v2.ran) {
  console.log(
    `${GATE}: NOTE — no merge base: this branch has no upstream and this is not a CI pull-request run, so the reviewer ledger v2 did not judge it, and the 1.0.x judgement below is the verdict (it owes reviewers on uncommitted changes only). Set the branch's upstream to the branch it will merge into (\`git branch --set-upstream-to=origin/main\`, say) and v2 judges everything since the merge base with it.`,
  )
  v1Verdict()
}

// THE 1.1.0 RAMP, the one call site for the whole of v2. It is consulted only when either
// judgement has something to say, because only then does it matter which one decides.
const v2Ramped =
  (v1Findings.length > 0 || v2Found.length > 0) &&
  rampNote(
    GATE,
    '1.1.0',
    'the reviewer ledger v2 judgement (a merge-base owed set with deletions, standing BLOCKs, dispatch-bound verdicts and whole-turn reviewers)',
    { until: '2.1.0' },
  )
if (v2Ramped) {
  if (v2Found.length > 0) {
    console.log(
      `${GATE}: NOTE — ${String(v2Found.length)} reviewer ledger v2 finding(s) withheld by the 1.1.0 ramp; the 1.0.x judgement still decides on this install:`,
    )
    for (const f of v2Found) console.log(`  - ${f}`)
  }
  v1Verdict()
}

// v2 IS LIVE: it decides, and the 1.0.x findings are superseded. This is where the two
// relaxations land, and the only place they do.
if (v1Findings.length > 0) {
  console.log(
    `${GATE}: NOTE — the 1.0.x judgement had ${String(v1Findings.length)} finding(s), and the reviewer ledger v2 supersedes them on this install; its verdict follows.`,
  )
}
failures(
  GATE,
  v2Found,
  `Each finding names a reviewer this branch's diff owes a verdict: the merge-base diff against ${String(v2.base)}, deletions included, and every non-empty diff for a whole-turn reviewer. A BLOCK stands until the same reviewer passes, and a PASS counts when the tree at its dispatch, at its verdict and now are the same. The triggers are reviewed data in ${TRIGGERS}; the ledger is written by .claude/hooks/subagent-verdict.mjs on SubagentStart and SubagentStop.`,
)
ok(
  GATE,
  v2Owed.length === 0
    ? `no reviewer is owed a verdict by this branch (${String(v2.fileCount)} changed file(s) against ${String(v2.base)})`
    : `${String(v2Owed.length)} owed reviewer(s) each have a counted PASS at the current tree (${v2Owed.map((o) => o.agent).join(', ')}), judged against ${String(v2.base)}`,
)
