#!/usr/bin/env node
// Stop-chain step 10 — every reviewer the DIFF summoned actually ran, and said PASS.
//
// This is the second half of the process layer; .claude/hooks/subagent-verdict.mjs is the
// first. That hook records each reviewer's terminal verdict into a session-scoped ledger from
// the `last_assistant_message` field SubagentStop hands it. This step decides who was OWED a
// verdict, and refuses to let the turn end without one.
//
// WHY IT IS A STOP STEP AND NOT A CHAIN GATE. `pnpm validate` runs over a TREE and knows
// nothing about a session. "Did the security reviewer run for these changes" is a question
// about a session's turns, and the ledger is keyed by the session_id (since 2.0.0, with the
// entry's format stamp; through 1.1.x, with the prompt_id). A chain step asking it would
// either have to invent a session or answer about the wrong one.
//
// FAIL CLOSED, in every direction that matters:
//   - no ledger file, an unreadable one, or one whose lines do not parse -> BLOCK;
//   - the Stop hook did not pass down the session's identity -> BLOCK (an unkeyed ledger
//     would let another session's PASS satisfy this one's obligation, which is the one
//     failure mode that would make the whole control decorative);
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
// THE MODEL A VERDICT RAN ON (1.1.0, #62), behind a ramp of its own opened at 1.1.0, until
// 2.1.0. The hook records `model` (read from the subagent's own transcript; null when it
// cannot) and `pinned` beside each verdict, because a reviewer can run off its pin: a
// per-invocation model, CLAUDE_CODE_SUBAGENT_MODEL(_FORCE), an availableModels substitution,
// a fallbackModel chain (design/CONTROL-PLANE-FACTS.md, Fact 16). The step judges the model of
// the entry each owed reviewer's verdict rests on (the latest entry of the turn under the
// 1.0.x judgement, the one the stale class judges; the latest counted PASS under v2) against
// the reviewer's hash-locked agent file: its `model` pin, or an entry of its
// `harnessFallbackModels` list, an alias matching every model ID of its family
// (tools/lib/reviewer-verdicts.mjs modelMatches). A verdict on any other model is NAMED, on a
// `FALLBACK MODEL` line the Stop hook shows the user on a green run too. For the three
// security reviewers (SECURITY_REVIEWERS in tools/lib/agent-roster.mjs) a model off the list,
// or `model: null`, is also a finding: that PASS does not count. An entry with no `model`
// field, as every entry a pre-1.1.0 hook wrote is, is judged exactly as before. Below
// baseVersion 1.1.0 the findings print as NOTEs until 2.1.0: an install whose configuration
// already forces a model off the list would otherwise red on the first Stop after `update`,
// with a re-run that lands on the same model. And the list is how a reviewer whose pin
// cannot run still runs: that run never reaches SubagentStop (Fact 16, observed), so it
// writes no entry, and every "did not run" finding of both judgements, the one for a ledger
// that does not exist yet included, ends with fallbackHint(): dispatch the reviewer with the
// Agent tool's `model` set to a listed model.
// Nothing ramps that sentence; it changes no verdict.
//
// THE ROUND BUDGET (1.1.0, #71), behind a second ramp opened at 1.1.0, until 2.1.0 since the
// 2.0.0 cut, which extended it from 1.2.0 to the v2 deadline: the budget judges v2's change
// set and closes a loop by v2's rule, so an install still judged by the 1.0.x rule (every
// vintage below 1.1.0, until 2.1.0) must not meet it live before v2 is live. Nothing
// else bounds a fix-and-re-review loop: the turn-wide block cap counts every kind of block,
// and when it is spent the turn ends with the findings standing. The hook records each
// verdict's `round` and its `blocking` finding lines. This step counts each owed reviewer's
// rounds over the session's entries, the change set v2 judges, with tools/lib/
// reviewer-verdicts.mjs judgeRoundBudget: a BLOCK opens a review loop, each later verdict of
// that reviewer is its next round, and the loop closes when the same run passes over a tree
// that did not move under it. A loop still open after ROUND_BUDGET rounds is SPENT: a verdict
// past the budget never clears it, and the step reds with the recorded findings and says to
// stop and hand them to the human. That finding replaces the reviewer's own v1 or v2 finding,
// which would say to run it again. An entry an earlier or parked hook wrote counts as one
// round, with no recorded findings. With no merge base there is no change set, so the budget,
// like v2, does not judge, and the no-merge-base NOTE says so: its loops close only on the
// same run's PASS, the v2 rule, and under the 1.0.x judgement a later prompt's PASS from any
// run clears a BLOCK, so judging it there would red a loop the verdict calls closed. The hook
// cannot carry this ramp, because a hook has no NOTE channel, so the ramp lives here.
//
// THE LEDGER KEY (2.0.0, #87): the session and the format, not the prompt. Under v2 a PASS is
// current while its digest pair matches the tree, so prompt_id only forced re-runs, and it
// leaves v2's key. v2 reads the ledger with tools/lib/reviewer-verdicts.mjs readSessionEntries:
// this session's entries, split by the format stamp `v` the hook writes (LEDGER_FORMAT). An
// entry in another format never counts as a PASS, a BLOCK in any format still stands until
// the same run passes in this format, and a reviewer whose entries are all in another format
// gets a finding that names the format and asks for one re-run, never "did not run". The
// step's identity is HARNESS_SESSION_ID alone. HARNESS_PROMPT_ID is still read, and the Stop
// hook still passes it: the 1.0.x judgement keeps the prompt in its key (its path_state leaves
// deletions out and has no dispatch digest, so an earlier prompt's PASS is not provably about
// this tree), and the prompt dates a mis-shaped line of this session, whose error lasts until
// the prompt ends (decision 3, the lifetime it always had). Without a prompt id the 1.0.x
// judgement, where it decides, reds with a finding that says why: a skip outside CI would
// switch the check off. Nothing here is ramped: it is the 2.0.0 key, and its one tightening,
// the format finding, rides v2's own ramp like every v2 finding.
//
// WHAT IT DELIBERATELY DOES NOT DO: judge the CONTENT of a review. A PASS is an attestation by
// a read-only agent whose tools, pinned model, fallback list and body are hashed in
// tools/agents.lock.json (its `models` map records the pin alone), and since 1.1.0 the model it
// RAN on is recorded and judged as above. This step verifies the attestation exists, belongs to
// this turn and ran on a model its file names. Whether it was a GOOD review is not a property
// any file can hold, and pretending otherwise would be the same "reads as coverage" mistake this
// release has spent itself deleting.
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed SubagentStop payload)
// SOURCE: CHANGELOG 0.3.0 (process-verified reviewers, deferred with the reason)
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
// The roster as a NAMESPACE too (1.1.0, #62): SECURITY_REVIEWERS and modelPolicy are new.
import * as roster from './lib/agent-roster.mjs'
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

// THE SESSION'S IDENTITY, passed down by stop-validate-gate.mjs from the Stop payload, and
// since 2.0.0 (#87) the only variable this step requires. Without it the ledger cannot be
// narrowed to this session, and a PASS from another session would satisfy an obligation
// raised by this one. Outside the Stop hook there is no session to judge, so the step skips
// loudly rather than inventing one — and fails closed in CI, where a Stop-chain step running
// without its identity means the hook that supplies it has changed. HARNESS_PROMPT_ID is
// optional here (see THE LEDGER KEY above); the Stop hook keeps passing it, because a step
// from 1.1.x, a kept fork or the old copy mid-update, still requires it.
const sessionId = process.env.HARNESS_SESSION_ID ?? null
const promptId = process.env.HARNESS_PROMPT_ID ?? null
if (sessionId === null) {
  skipOrFail(
    GATE,
    'no HARNESS_SESSION_ID in the environment — this step is meaningful only inside the Stop hook, which passes the session identity down from the Stop payload',
  )
}

/** @param {string} p */
const readFileOrNull = (p) => (existsSync(p) ? readFileSync(p) : null)

// The ledger is read ONCE, under each judgement's key. Malformed lines are bounded to the LINE
// (0.9.0): a torn write from a crashed session is named and stepped over, never allowed to
// brick every later turn in the directory.
const rawLedger = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : null
// v2's key (2.0.0): the session and the format. Null with no ledger, or beside a lib that
// predates the reader (a parked fork, which judgeV2 names).
const sessionRead =
  rawLedger === null || typeof verdicts.readSessionEntries !== 'function'
    ? null
    : verdicts.readSessionEntries(rawLedger, sessionId, { promptId, label: LEDGER })
// The 1.0.x key: the session and the prompt. With no prompt id there is no turn to narrow to,
// and judgeV1 says so.
const turnRead =
  rawLedger === null || promptId === null ? null : readLedger(rawLedger, sessionId, promptId, LEDGER)
for (const s of (sessionRead ?? turnRead)?.skipped ?? []) console.log(`${GATE}: NOTE — ${s}`)

// ── THE MODEL A VERDICT RAN ON (1.1.0, #62) ──────────────────────────────────────────────

/** @type {Map<string, {pin: string|null, fallbacks: string[]}|null>} */
const policies = new Map()

/**
 * An agent's pin and fallback list, read from its hash-locked file once per run: one read
 * per owed reviewer. Null when the file or its frontmatter cannot be read.
 * @param {string} agent
 */
function policyOf(agent) {
  if (!policies.has(agent)) {
    let policy = null
    try {
      policy = roster.modelPolicy(readFileSync(`.claude/agents/${agent}.md`, 'utf8'))
    } catch {
      policy = null
    }
    policies.set(agent, policy)
  }
  return policies.get(agent) ?? null
}

const MODEL_LIB_STALE = (agent) =>
  `${agent}'s verdict carries the model it ran on, but tools/lib/reviewer-verdicts.mjs or tools/lib/agent-roster.mjs predates 1.1.0, so the model cannot be judged. It is an owned file you forked: \`update\` kept your copy and parked the 1.1.0 one under .harness/pending/. Merge the parked copy into yours, then re-record the sha (docs/runbooks/harness-upgrade.md, 1.0.2 section, "Forking an owned file").`

/**
 * The model half of one owed reviewer's verdict, on the entry the verdict rests on.
 * @param {string} agent @param {Record<string, unknown>|undefined} e
 * @returns {{ finding: string|null, line: string|null }}
 */
function modelOf(agent, e) {
  if (e === undefined || !Object.hasOwn(e, 'model')) return { finding: null, line: null }
  const ready =
    typeof verdicts.judgeModel === 'function' &&
    typeof roster.modelPolicy === 'function' &&
    Array.isArray(roster.SECURITY_REVIEWERS)
  if (!ready) return { finding: MODEL_LIB_STALE(agent), line: null }
  return verdicts.judgeModel(
    { agent, security: roster.SECURITY_REVIEWERS.includes(agent) },
    e,
    policyOf(agent),
  )
}

/**
 * Print the verdicts a non-pinned model produced, one tagged line each, and return the model
 * findings that red: all of them where the model check is live, none on an install below
 * 1.1.0 (the ramp prints them as NOTEs). The tag is what .claude/hooks/stop-validate-gate.mjs
 * collects and shows the user on a green run, so it goes to stdout, the channel a green step's
 * output is read from.
 * @param {{ findings: string[], lines: string[] }} m
 * @returns {string[]}
 */
function modelVerdict(m) {
  for (const line of m.lines) console.log(`${GATE}: FALLBACK MODEL — ${line}`)
  if (m.findings.length === 0) return []
  const noted = rampNote(
    GATE,
    '1.1.0',
    'the security-reviewer model check (a PASS from a security reviewer counts only on its pinned model or on a model its harnessFallbackModels list names)',
    { until: '2.1.0' },
  )
  if (!noted) return m.findings
  console.log(
    `${GATE}: NOTE — ${String(m.findings.length)} model finding(s) withheld by the 1.1.0 model ramp:`,
  )
  for (const f of m.findings) console.log(`  - ${f}`)
  return []
}

/**
 * Fold one reviewer's model judgement into the running lists.
 * @param {{ findings: string[], lines: string[] }} into
 * @param {{ finding: string|null, line: string|null }} one
 */
function collectModel(into, one) {
  if (one.finding !== null) into.findings.push(one.finding)
  if (one.line !== null) into.lines.push(one.line)
}

/**
 * The fallback-list sentence for a reviewer that never ran (1.1.0, #62), with its leading
 * space, or nothing when a parked pre-1.1.0 lib lacks the helper.
 * @param {string} agent
 */
const hintFor = (agent) =>
  typeof verdicts.fallbackHint === 'function' ? ` ${verdicts.fallbackHint(agent)}` : ''

// DECISION 3 (2.0.0, #87): a mis-shaped line of this session fails closed for the prompt it
// was written in, the lifetime it always had, and the remedy now says what clears it. Through
// 1.1.x it said a re-run would, and it never did: the reader stops at the line.
const TORN_REMEDY = `this prompt's own verdict lines must be readable, so it fails CLOSED until the prompt ends. Re-running the reviewer does not clear it: the ledger is append-only, the line stays where it is, and the step stops reading at it. It clears at the next prompt: end the turn and tell the user what this finding says. From their next message on, the step skips the line with a NOTE and judges the ledger as if it were absent, so then run any reviewer it names. (The file is write-guard-protected: removing the line by hand is a human act under HARNESS_ALLOW_SELF_EDIT=1.)${
  promptId === null
    ? ' With no HARNESS_PROMPT_ID, outside the Stop hook, the step cannot date such a line and every one of this session fails closed: run the step from the Stop hook, or set HARNESS_PROMPT_ID to the current prompt.'
    : ''
}`

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
 * @returns {{ err?: string, stale?: string, model?: { finding: string|null, line: string|null } }}
 */
function judgeOneV1(o, entries, files) {
  const mine = entries.filter((e) => e.agent_type === o.agent)
  if (mine.length === 0) {
    return {
      err: `${o.agent} did not run this turn, and \`${o.because}\` is why it is owed. ${o.why ?? ''} Run it, then end the turn.${hintFor(o.agent)}`,
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
  // THE MODEL (1.1.0, #62), on the same latest entry the binding above judged.
  return { model: modelOf(o.agent, latest) }
}

/**
 * The 1.0.x judgement with no prompt id (2.0.0, #87): it keys on the prompt, so it can bind no
 * verdict to this turn. A red that says so, never a skip: a skip outside CI would switch the
 * check off wherever this judgement decides.
 * @param {Array<{agent: string}>} owed
 */
const noPromptFinding = (owed) =>
  `${owed.length} reviewer(s) are owed a verdict by this diff (${owed.map((o) => o.agent).join(', ')}), and the 1.0.x judgement decides here and keys the ledger on the prompt: with no HARNESS_PROMPT_ID in the environment it can bind no verdict to this turn, so none counts. The Stop hook passes it from the Stop payload; outside the hook, set it to the current prompt. Where the reviewer ledger v2 decides, HARNESS_SESSION_ID alone is enough: that needs an upstream (\`git branch --set-upstream-to=origin/main\`, say) and a baseVersion of 1.1.0 or later.`

/**
 * @param {Array<{agent: string, because: string, why?: string}>} owed
 * @param {string[]} files
 * @returns {{ errs: string[], stale: string[], model: { findings: string[], lines: string[] } }}
 */
function judgeV1(owed, files) {
  const model = { findings: [], lines: [] }
  if (owed.length === 0) return { errs: [], stale: [], model }
  if (rawLedger === null) {
    return {
      errs: [
        `${owed.length} reviewer(s) are owed a verdict by this diff and ${LEDGER} does not exist — no reviewer ran at all this turn. The ledger is written by .claude/hooks/subagent-verdict.mjs on SubagentStop; if it is missing entirely, check that the hook is wired in .claude/settings.json.${owed.map((o) => hintFor(o.agent)).join('')}`,
      ],
      stale: [],
      model,
    }
  }
  if (turnRead === null) return { errs: [noPromptFinding(owed)], stale: [], model }
  if (turnRead.error !== null) {
    return { errs: [`${turnRead.error} — ${TORN_REMEDY}`], stale: [], model }
  }
  const errs = []
  const stale = []
  for (const o of owed) {
    const r = judgeOneV1(o, turnRead.entries, files)
    if (r.err !== undefined) errs.push(r.err)
    if (r.stale !== undefined) stale.push(r.stale)
    if (r.model !== undefined) collectModel(model, r.model)
  }
  return { errs, stale, model }
}

const files = changedFiles()
const owed = owedBy(files, cfg.reviewers ?? [])
const { errs, stale, model: v1Model } = judgeV1(owed, files)

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
  failures(
    GATE,
    [...budgetLive, ...withoutSpent([...v1Findings, ...modelVerdict(v1Model)])],
    V1_HINT,
  )
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
 * The v2 findings, and the model judgement of each SATISFIED reviewer's latest counted PASS
 * (1.1.0, #62): a reviewer with a v2 finding is already red, and its model adds nothing.
 * @param {Array<{agent: string, because: string, why?: string, wholeTurn?: boolean}>} owed2
 * @param {string[]} reviewFiles
 * @returns {{ findings: string[], model: { findings: string[], lines: string[] } }}
 */
function v2Findings(owed2, reviewFiles) {
  const model = { findings: [], lines: [] }
  const read = sessionRead ?? { entries: [], older: [], session: [], error: null }
  if (read.error !== null) return { findings: [`${read.error} — ${TORN_REMEDY}`], model }
  const findings = []
  for (const o of owed2) {
    const current = verdicts.reviewStateDigest(o.agent, cfg, reviewFiles, readFileOrNull)
    // The session in ledger order, and the entries in another format apart (2.0.0, #87).
    const finding = verdicts.judgeReviewerV2(o, read.session, current, read.older)
    if (finding !== null) findings.push(finding)
    else collectModel(model, modelOf(o.agent, countedPassOf(o.agent, read.entries, current)))
  }
  return { findings, model }
}

/**
 * The entry a satisfied v2 reviewer's verdict rests on: its latest counted PASS. A lib that
 * predates the helper falls back to the latest PASS, which modelOf then names as stale.
 * @param {string} agent @param {Array<Record<string, unknown>>} entries @param {string|null} current
 */
function countedPassOf(agent, entries, current) {
  return typeof verdicts.latestCountedPass === 'function'
    ? verdicts.latestCountedPass(agent, entries, current)
    : entries.filter((e) => e.agent_type === agent && e.verdict === 'PASS').at(-1)
}

/** A v2 judgement that could not run at all: one finding, subject to the ramp like any other. */
const v2Broken = (finding) => ({
  ran: true,
  base: null,
  owed: [],
  fileCount: 0,
  findings: [finding],
  model: { findings: [], lines: [] },
})

// What v2 needs from each lib, by file (readSessionEntries since 2.0.0, the rest since 1.1.0).
const V2_LIB = /** @type {Array<[string, Record<string, unknown>, string[]]>} */ ([
  ['tools/lib/git-diff.mjs', gitDiff, ['reviewChanges']],
  [
    'tools/lib/reviewer-verdicts.mjs',
    verdicts,
    ['owedByTurn', 'readSessionEntries', 'judgeReviewerV2', 'reviewStateDigest'],
  ],
])

/** What a parked fork of either lib lacks, one clause per file, or none. */
const v2LibGaps = () =>
  V2_LIB.flatMap(([file, lib, names]) => {
    const missing = names.filter((n) => typeof lib[n] !== 'function')
    return missing.length === 0 ? [] : [`${file} lacks ${missing.join(', ')}`]
  })

/**
 * The v2 judgement, or `{ ran: false }` when this branch has no merge base.
 * @returns {{ ran: boolean, base?: string|null, owed?: Array<{agent: string}>, fileCount?: number, findings?: string[], model?: { findings: string[], lines: string[] } }}
 */
function judgeV2() {
  const gaps = v2LibGaps()
  if (gaps.length > 0) {
    return v2Broken(
      `${gaps.join(' and ')}, so the reviewer ledger v2 cannot judge this branch. It is an owned file you forked: \`update\` kept your copy and parked the incoming one under .harness/pending/. Merge the parked copy into yours, then re-record the sha (docs/runbooks/harness-upgrade.md, 1.0.2 section, "Forking an owned file").`,
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
  const judged =
    owed2.length === 0
      ? { findings: [], model: { findings: [], lines: [] } }
      : v2Findings(owed2, review.files)
  return {
    ran: true,
    base: review.base,
    owed: owed2,
    fileCount: review.files.length,
    findings: judged.findings,
    model: judged.model,
  }
}

const v2 = judgeV2()
const v2Owed = v2.owed ?? []
const v2Found = v2.findings ?? []

// ── THE ROUND BUDGET (1.1.0, #71): judged over the session, behind its own ramp ─────────

/**
 * One finding per owed reviewer whose round budget is spent with a BLOCK standing, over this
 * session's entries, each with the reviewer it names. A lib without the judge (a parked fork)
 * is ONE finding naming the lib, never a pass: the budget cannot be judged, and saying so is
 * the ramp's business.
 * @param {string[]} agents the owed reviewers, from the judgement that decides the owed set
 * @returns {Array<{ agent: string|null, finding: string }>}
 */
function budgetFindings(agents) {
  if (agents.length === 0) return []
  if (typeof verdicts.judgeRoundBudget !== 'function') {
    return [
      {
        agent: null,
        finding:
          'tools/lib/reviewer-verdicts.mjs has no judgeRoundBudget export, so the per-reviewer round budget cannot be judged. It is an owned file you forked: `update` kept your copy and parked the 1.1.0 one under .harness/pending/. Merge the parked copy into yours, then re-record the sha (docs/runbooks/harness-upgrade.md, 1.0.2 section, "Forking an owned file").',
      },
    ]
  }
  // No ledger, nothing to count; a lib without the 2.0.0 reader is v2's finding already, and
  // a torn line of this prompt is already a finding of both judgements, failing closed there.
  if (sessionRead === null || sessionRead.error !== null) return []
  // Every entry of the session is a round, in any format (2.0.0): an older hook's verdicts
  // spent the budget when they were written, and a format change does not refund them.
  return agents
    .map((agent) => ({ agent, finding: verdicts.judgeRoundBudget({ agent }, sessionRead.session) }))
    .filter((b) => b.finding !== null)
}

// The change set is v2's owed set. With no merge base there is none, and the budget does not
// judge: it clears a loop by v2's rule, and the 1.0.x judgement that decides there does not.
const budgetFound = v2.ran ? budgetFindings(v2Owed.map((o) => o.agent)) : []
const budgetNoted =
  budgetFound.length > 0 &&
  rampNote(GATE, '1.1.0', 'the per-reviewer round budget', { until: '2.1.0' })
if (budgetNoted) {
  console.log(
    `${GATE}: NOTE — ${String(budgetFound.length)} round-budget finding(s) withheld by the 1.1.0 ramp:`,
  )
  for (const b of budgetFound) console.log(`  - ${b.finding}`)
}
const budgetSpent = budgetNoted ? [] : budgetFound
const budgetLive = budgetSpent.map((b) => b.finding)

/**
 * A finding list without the other findings of a reviewer whose budget is spent (its v1 or
 * v2 finding, and its model finding): they say to run it again, and a round past the budget
 * clears nothing. Every per-reviewer finding opens with the reviewer's name and a space,
 * which is what this matches.
 * @param {string[]} list
 */
const withoutSpent = (list) =>
  list.filter((f) => !budgetSpent.some((b) => b.agent !== null && f.startsWith(`${b.agent} `)))

// DECISION 1 (1.1.0): NO MERGE BASE, NO v2. A fresh `git init` with no remote, or a branch
// with no upstream configured, has nothing to key the owed set on, and the uncommitted-only
// set is the one v2 exists to replace. So v2 does not judge it, and says so on every run;
// the 1.0.x judgement decides exactly as before, and neither relaxation applies. Every
// clean-scaffold run in the harness's own CI takes this path: a fresh `git init`, and an
// untracked pnpm-lock.yaml the v2 set would owe both whole-turn reviewers for.
if (!v2.ran) {
  console.log(
    `${GATE}: NOTE — no merge base: this branch has no upstream and this is not a CI pull-request run, so the reviewer ledger v2 did not judge it, nor did the per-reviewer round budget, and the 1.0.x judgement below is the verdict (it owes reviewers on uncommitted changes only). Set the branch's upstream to the branch it will merge into (\`git branch --set-upstream-to=origin/main\`, say) and v2 judges everything since the merge base with it.`,
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
  [
    ...budgetLive,
    ...withoutSpent([...v2Found, ...modelVerdict(v2.model ?? { findings: [], lines: [] })]),
  ],
  `Each finding names a reviewer this branch's diff owes a verdict: the merge-base diff against ${String(v2.base)}, deletions included, and every non-empty diff for a whole-turn reviewer. A BLOCK stands until the same reviewer passes, and a PASS counts when the tree at its dispatch, at its verdict and now are the same. The triggers are reviewed data in ${TRIGGERS}; the ledger is written by .claude/hooks/subagent-verdict.mjs on SubagentStart and SubagentStop.`,
)
ok(
  GATE,
  v2Owed.length === 0
    ? `no reviewer is owed a verdict by this branch (${String(v2.fileCount)} changed file(s) against ${String(v2.base)})`
    : `${String(v2Owed.length)} owed reviewer(s) each have a counted PASS at the current tree (${v2Owed.map((o) => o.agent).join(', ')}), judged against ${String(v2.base)}`,
)
