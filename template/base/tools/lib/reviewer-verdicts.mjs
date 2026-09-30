// tools/lib/reviewer-verdicts.mjs — the pure half of the process layer, shared by the hook
// that WRITES the verdict ledger (.claude/hooks/subagent-verdict.mjs) and the Stop step that
// READS it (tools/check-reviewer-verdicts.mjs).
//
// One module because the two ends must agree about three things and there is no second
// chance to notice they do not: what a verdict LINE looks like, what a ledger ENTRY looks
// like, and which turn an entry belongs to. Two copies of that agreement is the drift this
// release has spent itself deleting. Since 1.1.0 (#62) there is a fourth: which model a
// verdict ran on, and when that model counts as the reviewer's pin.
//
// Pure: no process exit, no I/O (hashing is computation, not I/O — pathStateDigest takes a
// reader precisely so the file system stays the caller's business). Every consumer supplies
// its own failure vocabulary.
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed SubagentStop payload)
import { createHash } from 'node:crypto'

// THE VERDICT GRAMMAR (1.0.2) — asymmetric on purpose, because its two errors do not cost the
// same. Reading a hedge as a PASS lets an unreviewed turn end; reading a clumsy BLOCK as a
// BLOCK costs nothing. So:
//
//   PASS   only as the TERMINAL line, exact, and only when no BLOCK-form line exists anywhere
//          in the message. "Exact" tolerates a closed set of markdown habits around the line
//          (below) and nothing else: not trailing text, not `PASSED`, not another case.
//   BLOCK  wherever a LINE states it — terminal or not, with a reason after it, spelled FAIL —
//          provided no PASS-form line exists anywhere. A terminal exact BLOCK always wins, so
//          every message that read BLOCK before 1.0.2 still does.
//   null   everything else, including both forms in one message: the hook bounces the
//          reviewer, which re-states. A hedge can never read as a pass.
//
// Through 1.0.1 this was one regex over the LAST line, and two reviewer bodies instructed
// "End with exactly one final line … Follow it with the top 3 fixes". A reviewer that obeyed
// its own file was bounced every time, BLOCK or PASS. The bodies now put the verdict last;
// this grammar is what keeps a BLOCK followed by its fixes from being lost again.
//
// The wrappers, each one a habit models have for emphasising a conclusion, tolerated ONLY at
// the line's edges and around the key: backticks (every roster body shows the line in them,
// so a verbatim copy carries them), `**`/`__`/`*`/`_` emphasis (including the key-only
// `**VERDICT:** PASS`), a leading blockquote, list marker or heading, and ONE trailing
// period. A code fence is deliberately NOT a wrapper: a terminal fence delimiter is never a
// verdict, but a fenced line still counts in the anywhere-scans — the safe direction.
const LEAD = String.raw`(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:#{1,6}\s+)?`
const MARK = '[*_`]{0,3}'
const EXACT_RE = new RegExp(
  `^${LEAD}${MARK}VERDICT${MARK}:${MARK}\\s*(PASS|BLOCK|FAIL)${MARK}\\.?${MARK}$`,
)
// Line-anchored and classified by the FIRST word after the colon only — a BLOCK's reason
// routinely contains the word "pass", and a sentence that merely mentions the line
// ("…end with `VERDICT: PASS` or…") does not start with it.
const FORM_RE = new RegExp(`^${LEAD}${MARK}VERDICT${MARK}\\s*:\\s*${MARK}\\s*([A-Za-z]+)`, 'i')
const PASS_WORDS = new Set(['PASS', 'PASSED', 'PASSES'])
const BLOCK_WORDS = new Set(['BLOCK', 'BLOCKED', 'FAIL', 'FAILED'])

/** @param {string} line @returns {'pass' | 'block' | 'unknown' | null} */
function formOf(line) {
  const word = FORM_RE.exec(line)?.[1]?.toUpperCase()
  if (word === undefined) return null
  if (PASS_WORDS.has(word)) return 'pass'
  return BLOCK_WORDS.has(word) ? 'block' : 'unknown'
}

// WHY a message did not parse — a closed vocabulary, recorded by the hook on every bounce so
// a run of them can be read as data instead of reconstructed from a trimmed turn log.
/** @param {string[]} lines @param {Set<string | null>} forms */
function bounceShape(lines, forms) {
  if (forms.has('pass') && forms.has('block')) return 'both-forms'
  if (forms.has('pass')) {
    const exactAt = lines.findIndex((l) => EXACT_RE.exec(l)?.[1] === 'PASS')
    if (exactAt === -1) return 'pass-trailing-text'
    return /^(`{3,}|~{3,})/.test(lines.at(-1) ?? '') && exactAt === lines.length - 2
      ? 'pass-fenced'
      : 'pass-not-terminal'
  }
  if (forms.has('unknown')) return 'unknown-word'
  return lines.some((l) => /VERDICT\s*:/i.test(l)) ? 'verdict-inline' : 'no-verdict-line'
}

/**
 * A subagent's final message, judged: `{ verdict, shape }`. `verdict` is what the ledger
 * records (`FAIL` is recorded as `BLOCK`, so the vocabulary stays closed); `shape` says
 * which rule decided it, or why nothing did.
 *
 * @param {unknown} message
 * @returns {{ verdict: 'PASS' | 'BLOCK' | null, shape: string }}
 */
export function classifyVerdict(message) {
  if (typeof message !== 'string') return { verdict: null, shape: 'not-a-string' }
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const forms = new Set(lines.map(formOf))
  const terminal = EXACT_RE.exec(lines.at(-1) ?? '')?.[1]
  if (terminal === 'BLOCK' || terminal === 'FAIL')
    return { verdict: 'BLOCK', shape: 'terminal-block' }
  if (terminal === 'PASS' && !forms.has('block')) return { verdict: 'PASS', shape: 'terminal-pass' }
  if (forms.has('block') && !forms.has('pass')) return { verdict: 'BLOCK', shape: 'block-anywhere' }
  return { verdict: null, shape: bounceShape(lines, forms) }
}

/**
 * The verdict of a subagent's final message, or null — see the grammar above. Same name and
 * return domain as before 1.0.2, so a hook and a lib from different releases still agree on
 * the call (an install may have forked one of the two files and had the other refreshed).
 *
 * @param {unknown} message
 */
export function readVerdict(message) {
  return classifyVerdict(message).verdict
}

/**
 * A POSIX-ish glob over a repo-relative path. `**` crosses segments, `*` does not.
 *
 * Hand-rolled for the reason every matcher in this tree is: the gates run on `node` and a
 * checkout with no install, so a dependency here would make the first step of the chain an
 * install. `**` followed by `/` may match ZERO segments, so `apps/web/app/**` + `/page.tsx`
 * matches `apps/web/app/page.tsx` as well as a nested one — without that, the root route of
 * every App Router tree silently summons no reviewer.
 */
export function globToRe(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const matchesAny = (path, patterns) => (patterns ?? []).some((p) => globToRe(p).test(path))

/**
 * Which reviewers this diff owes a verdict, and WHICH PATH summoned each one.
 *
 * The summoning path is carried into the finding on purpose: "security-reviewer did not run"
 * is an instruction to re-run something; "security-reviewer did not run, and
 * supabase/migrations/20260204_x.sql is why" is an argument a person can check and act on.
 * @param {string[]} files @param {Array<{agent: string, paths: string[], except?: string[], why?: string}>} reviewers
 */
export function owedBy(files, reviewers) {
  const owed = []
  for (const r of reviewers ?? []) {
    const hit = files.find((f) => matchesAny(f, r.paths) && !matchesAny(f, r.except))
    if (hit !== undefined) owed.push({ agent: r.agent, because: hit, why: r.why })
  }
  return owed
}

/** @param {string|Uint8Array} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * The tree state a verdict binds to (0.7.0): sha256 over the SORTED (path, content-sha256)
 * pairs of the changed files matching this reviewer's trigger patterns — or null for an
 * agent the trigger table does not name.
 *
 * One implementation, in the lib both ends import, because the two ends must AGREE: the
 * hook records this digest beside the verdict at SubagentStop, and the Stop step recomputes
 * it and refuses a PASS whose binding no longer matches — "a reviewer ran" and "a reviewer
 * reviewed THIS" are different claims, and the difference is exactly the files that moved
 * after the PASS.
 *
 * The mechanics, each load-bearing:
 *   - PER-REVIEWER SCOPE: only files matching this reviewer's paths (minus its excepts)
 *     participate, so a post-PASS edit elsewhere does not send an unrelated verdict stale.
 *   - SORTED, DEDUPLICATED: git-diff local mode yields Set insertion order; a digest that
 *     moved with enumeration order would be nondeterministic noise wearing a hash's clothes.
 *   - POSIX-NORMALIZED: a Windows hook and a POSIX CI must compute the same digest for the
 *     same tree, so `\` becomes `/` before matching and before hashing.
 *   - PER-FILE INNER HASH, NUL-DELIMITED (the escape spelling — a literal NUL makes a
 *     source file binary to grep): hashing `(path, sha256(content))` pairs rather than
 *     concatenated bytes means no adjacent pair of files can collide by content reflow.
 *   - DELETED FILES HASH AS (path, "DELETED"): a changed path can be absent from disk at
 *     either end (staged-then-deleted), and a reader that threw would turn bookkeeping into
 *     the reason a verdict is not recorded. The caller signals deletion by returning null.
 * @param {string} agentType
 * @param {{reviewers?: Array<{agent: string, paths?: string[], except?: string[]}>}|null} triggers
 *   parsed tools/reviewer-triggers.json
 * @param {readonly string[]} files repo-relative changed paths (tools/lib/git-diff.mjs shape)
 * @param {(path: string) => string|Uint8Array|null} readFileLike the file's bytes, or null
 *   when the path no longer exists
 * @returns {string|null}
 */
export function pathStateDigest(agentType, triggers, files, readFileLike) {
  const reviewer = (triggers?.reviewers ?? []).find((r) => r?.agent === agentType)
  if (reviewer === undefined) return null
  const owned = posixSet(files).filter(
    (f) => matchesAny(f, reviewer.paths) && !matchesAny(f, reviewer.except),
  )
  return digestPaths(owned, readFileLike)
}

/** @param {readonly string[]} files sorted, deduplicated, POSIX-normalized */
function posixSet(files) {
  return [...new Set((files ?? []).map((f) => String(f).split('\\').join('/')))].sort()
}

/**
 * The hash both digests share: (path, content-sha256 | DELETED) pairs, NUL-delimited, over
 * an already sorted list.
 * @param {readonly string[]} paths @param {(path: string) => string|Uint8Array|null} readFileLike
 */
function digestPaths(paths, readFileLike) {
  const h = createHash('sha256')
  for (const path of paths) {
    const content = readFileLike(path)
    h.update(
      `${path}\u0000${content === null || content === undefined ? 'DELETED' : sha256(content)}\n`,
    )
  }
  return h.digest('hex')
}

// ── THE REVIEWER LEDGER v2 (1.1.0) ──────────────────────────────────────────────────────
// Pure helpers for the judgement tools/check-reviewer-verdicts.mjs runs behind its 1.1.0
// ramp, and for the two records .claude/hooks/subagent-verdict.mjs writes. Both ends reach
// them through a namespace import, so an install whose copy of this file predates them
// still loads (the 1.0.2 rule for this lib).

/** @param {{wholeTurn?: Array<{agent?: string}>}|null} triggers @param {string} agentType */
const isWholeTurn = (triggers, agentType) =>
  (triggers?.wholeTurn ?? []).some((w) => w?.agent === agentType)

/**
 * The v2 tree state a verdict binds to: pathStateDigest for a path-triggered reviewer, the
 * same hash over EVERY path in `files` for a reviewer in the `wholeTurn` class, and null for
 * an agent the table names nowhere. `files` is reviewChanges()'s list, which is what makes
 * this digest differ from `path_state` (v1, over changedFiles()): it keeps deletions and
 * keys on the merge base, so it goes in its own ledger fields and `path_state` keeps its v1
 * meaning for a pre-1.1.0 judge.
 * @param {string} agentType
 * @param {{reviewers?: Array<{agent: string, paths?: string[], except?: string[]}>, wholeTurn?: Array<{agent?: string}>}|null} triggers
 * @param {readonly string[]} files
 * @param {(path: string) => string|Uint8Array|null} readFileLike
 * @returns {string|null}
 */
export function reviewStateDigest(agentType, triggers, files, readFileLike) {
  if (isWholeTurn(triggers, agentType)) return digestPaths(posixSet(files), readFileLike)
  return pathStateDigest(agentType, triggers, files, readFileLike)
}

/**
 * owedBy, plus the `wholeTurn` class: a reviewer in it is owed whenever the owed diff is
 * non-empty, whatever the paths. An install whose seeded tools/reviewer-triggers.json
 * predates the class owes none of them, until it adds the class (the 1.1.0 runbook section).
 * @param {string[]} files
 * @param {{reviewers?: Array<{agent: string, paths: string[], except?: string[], why?: string}>, wholeTurn?: Array<{agent?: string, why?: string}>}|null} triggers
 */
export function owedByTurn(files, triggers) {
  const owed = owedBy(files, triggers?.reviewers ?? []).map((o) => ({ ...o, wholeTurn: false }))
  if (files.length === 0) return owed
  for (const w of triggers?.wholeTurn ?? []) {
    if (typeof w?.agent !== 'string' || owed.some((o) => o.agent === w.agent)) continue
    owed.push({ agent: w.agent, because: files[0], why: w.why, wholeTurn: true })
  }
  return owed
}

/** @param {string} line @returns {Record<string, unknown>|null} */
function parseObject(line) {
  try {
    const parsed = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The ledger, narrowed to ONE SESSION (v2), in ledger order. Malformed lines keep readLedger's
 * bounds exactly: a line that does not parse is skipped and named, and a mis-shaped line
 * that claims THIS turn (session + prompt) fails closed, so a torn line from an earlier
 * prompt still cannot brick the rest of the session. Session scoping stays because
 * concurrent sessions share the file; prompt_id stays in each entry.
 * @param {string} raw @param {string} sessionId @param {string} promptId @param {string} [label]
 * @returns {{ entries: object[], error: string|null, skipped: string[] }}
 */
export function readSessionLedger(
  raw,
  sessionId,
  promptId,
  label = '.harness/reviewer-ledger.jsonl',
) {
  const turn = readLedger(raw, sessionId, promptId, label)
  if (turn.error !== null) return turn
  const entries = raw
    .split('\n')
    .map(parseObject)
    .filter(
      (e) =>
        e !== null &&
        e.session_id === sessionId &&
        typeof e.agent_type === 'string' &&
        typeof e.verdict === 'string',
    )
  return { entries, error: null, skipped: turn.skipped }
}

/**
 * The digest the LATEST SubagentStart record for this (session_id, agent_id) holds, or null
 * when there is no such record, it carries no digest, or the id is not a string. The latest
 * one, because a resumed reviewer keeps its agent_id (design/CONTROL-PLANE-FACTS.md, Fact 14)
 * and its new run is the one being judged.
 * @param {string} raw .harness/reviewer-dispatch.jsonl
 * @param {unknown} sessionId @param {unknown} agentId
 * @returns {string|null}
 */
export function latestDispatchDigest(raw, sessionId, agentId) {
  if (typeof agentId !== 'string' || typeof sessionId !== 'string') return null
  const record = raw
    .split('\n')
    .map(parseObject)
    .filter((r) => r !== null && r.session_id === sessionId && r.agent_id === agentId)
    .at(-1)
  return typeof record?.path_state_start === 'string' ? record.path_state_start : null
}

/**
 * A PASS the v2 judgement COUNTS: the digest at dispatch, the digest at the verdict and the
 * digest now are one and the same. Anything else, a verdict outside the vocabulary included,
 * counts for nothing.
 * @param {Record<string, unknown>} e @param {string|null} current
 */
const isCountedPass = (e, current) =>
  e.verdict === 'PASS' &&
  typeof current === 'string' &&
  e.path_state_stop === current &&
  e.path_state_start === current

/**
 * The BLOCKs that still stand: a BLOCK is cleared only by a LATER counted PASS from the
 * SAME agent_id. A PASS from another run is a second opinion and retracts nothing, and a
 * BLOCK with no agent_id can never be cleared.
 * @param {Array<Record<string, unknown>>} mine this reviewer's session entries, in order
 * @param {string|null} current
 */
function standingBlocks(mine, current) {
  return mine.filter(
    (e, i) =>
      e.verdict === 'BLOCK' &&
      !mine
        .slice(i + 1)
        .some(
          (later) =>
            typeof e.agent_id === 'string' &&
            later.agent_id === e.agent_id &&
            isCountedPass(later, current),
        ),
  )
}

/** @param {{agent: string, because: string, why?: string, wholeTurn?: boolean}} owed */
function owedClause(owed) {
  return owed.wholeTurn === true
    ? `it is a whole-turn reviewer, owed on every non-empty diff (\`${owed.because}\` is one changed path)`
    : `\`${owed.because}\` is why it is owed`
}

/**
 * Why this reviewer's latest PASS does not count, one finding per cause.
 * @param {{agent: string, because: string, why?: string, wholeTurn?: boolean}} owed
 * @param {Record<string, unknown>|undefined} pass @param {string|null} current
 */
function uncountedFinding(owed, pass, current) {
  const a = owed.agent
  if (pass === undefined) {
    return `${a} has not returned a verdict in this session, and ${owedClause(owed)}. ${owed.why ?? ''} Run it, then end the turn. ${fallbackHint(a)}`
  }
  if (typeof pass.path_state_stop !== 'string') {
    return `${a} returned PASS with no ledger v2 binding: a hook from before 1.1.0 wrote the entry, or the hook could not compute the digest. An unverifiable attestation fails toward re-review: run ${a} again.`
  }
  if (typeof pass.path_state_start !== 'string') {
    return `${a} returned PASS with no dispatch record, so nothing recorded the tree it started on, and a verdict with no start record is not counted. The SubagentStart block in .claude/settings.json must run .claude/hooks/subagent-verdict.mjs, the same command as the SubagentStop block: add it (the 1.1.0 section of docs/runbooks/harness-upgrade.md has the block), then run ${a} again.`
  }
  if (pass.path_state_start !== pass.path_state_stop) {
    return `${a} reviewed a moving tree: the paths it was owed for changed between its dispatch and its verdict, so its PASS is not counted. Run ${a} again, and let it finish before editing those paths.`
  }
  if (typeof current !== 'string') {
    return `${a} is owed a verdict, but the current digest for it cannot be computed from tools/reviewer-triggers.json, so no PASS can be matched to this tree.`
  }
  return `${a} returned PASS for a different tree than the one this branch is shipping: the paths that summoned it (\`${owed.because}\` among them) changed after its PASS was recorded. Run ${a} again, then end the turn.`
}

/**
 * The v2 verdict for ONE owed reviewer, over this session's entries: null when it is
 * satisfied, else the finding. A standing BLOCK comes first; then any counted PASS
 * satisfies it, from this prompt or an earlier one (a SETTLED PASS: its digests still match);
 * otherwise the latest PASS says why it does not count.
 * @param {{agent: string, because: string, why?: string, wholeTurn?: boolean}} owed
 * @param {Array<Record<string, unknown>>} entries readSessionLedger's entries
 * @param {string|null} current reviewStateDigest for this reviewer, now
 * @returns {string|null}
 */
export function judgeReviewerV2(owed, entries, current) {
  const mine = entries.filter((e) => e.agent_type === owed.agent)
  const standing = standingBlocks(mine, current)
  if (standing.length > 0) {
    const ids = [
      ...new Set(
        standing.map((e) => (typeof e.agent_id === 'string' ? e.agent_id : 'none recorded')),
      ),
    ]
    return `${owed.agent} returned VERDICT: BLOCK (agent_id ${ids.join(', ')}) in this session, and that reviewer has not returned PASS at the current tree since. A BLOCK stands across prompts until the SAME reviewer passes: fix what it named, then resume that reviewer (SendMessage to its agent_id) so it re-reviews. A fresh run of ${owed.agent} is a second opinion and retracts nothing.`
  }
  if (mine.some((e) => isCountedPass(e, current))) return null
  return uncountedFinding(owed, mine.filter((e) => e.verdict === 'PASS').at(-1), current)
}

/**
 * The latest PASS the v2 judgement COUNTS for this agent (its three digests agree with the
 * tree now), or undefined. It is the entry a satisfied reviewer's verdict rests on, so it is
 * the one whose model the step judges (1.1.0, #62).
 * @param {string} agent @param {Array<Record<string, unknown>>} entries readSessionLedger's entries
 * @param {string|null} current
 * @returns {Record<string, unknown>|undefined}
 */
export function latestCountedPass(agent, entries, current) {
  return entries.filter((e) => e.agent_type === agent && isCountedPass(e, current)).at(-1)
}

// ── THE MODEL A VERDICT RAN ON (1.1.0, #62) ─────────────────────────────────────────────
// The hook records `model` (read from the subagent's own transcript) and `pinned` beside
// every verdict, and the Stop step judges the model of the entry an owed reviewer's verdict
// rests on against the reviewer's hash-locked agent file: its `model` pin, and its
// `harnessFallbackModels` list (tools/lib/agent-roster.mjs). What each Claude Code mechanism
// does to a subagent's model, and what the transcript was observed to hold, is
// design/CONTROL-PLANE-FACTS.md Fact 16. Pure, like the rest of this file: the caller reads.

// THE ALIAS RULE, as data, never looked up live. A family alias resolves to the latest model
// of its family, or to the main conversation's own model when that is in the family (so any
// version, and a `[1m]` suffix, can come back), and the version differs by provider. So an
// alias entry matches ANY model ID naming one of its families as a whole word, and a plain
// string comparison would read every PASS as off the pin. `best` and `opusplan` name two
// families each, as the model-config page defines them. `inherit` and `default` name no
// model, so they match nothing but themselves.
const ALIAS_FAMILIES = new Map([
  ['opus', ['opus']],
  ['sonnet', ['sonnet']],
  ['haiku', ['haiku']],
  ['fable', ['fable']],
  ['best', ['fable', 'opus']],
  ['opusplan', ['opus', 'sonnet']],
])

/** Lower-cased, trimmed, and without a trailing context-window suffix such as `[1m]`. */
const normalizeModel = (m) =>
  String(m)
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')

/**
 * Does a recorded model satisfy one pin or list entry? An alias entry matches the alias itself
 * and any model ID naming one of its families as a whole word: `opus` matches a bare Opus ID,
 * one with a `[1m]` suffix, a provider-prefixed one and an older `claude-3-opus-…` one. Any
 * other entry is a full ID and matches only itself, case-insensitively and without a
 * context-window suffix: a provider-prefixed variant of a full ID must be listed as itself.
 * @param {unknown} spec a pin or a list entry @param {unknown} model the recorded model
 */
export function modelMatches(spec, model) {
  if (typeof spec !== 'string' || typeof model !== 'string') return false
  const s = normalizeModel(spec)
  const m = normalizeModel(model)
  if (s === '' || m === '') return false
  if (s === m) return true
  const families = ALIAS_FAMILIES.get(s) ?? []
  return families.some((f) => new RegExp(`(?:^|[^a-z])${f}(?:[^a-z]|$)`).test(m))
}

/**
 * The sentence a reviewer that never returned a verdict gets (1.1.0, #62). A reviewer whose
 * pinned model cannot run never reaches SubagentStop (CONTROL-PLANE-FACTS Fact 16, point 5,
 * observed): no entry is written, and this red is the one place the agent can learn that
 * the reviewer may run on a model its hash-locked file lists. Claude Code picks no model
 * from the list; the per-invocation `model` parameter does.
 * @param {string} agent
 * @returns {string}
 */
export function fallbackHint(agent) {
  return `If ${agent} cannot run on its pinned model, dispatch it with the Agent tool's \`model\` parameter set to a model the harnessFallbackModels line of .claude/agents/${agent}.md names: a verdict on a listed model counts, and is named at Stop.`
}

/**
 * Where a recorded model stands against an agent's pin and its fallback list.
 * @param {unknown} model @param {string|null} pin @param {readonly string[]|undefined} fallbacks
 * @returns {'pinned' | 'listed' | 'off-list' | 'unknown'}
 */
export function classifyModel(model, pin, fallbacks) {
  if (typeof model !== 'string' || model.trim() === '') return 'unknown'
  if (modelMatches(pin, model)) return 'pinned'
  return (fallbacks ?? []).some((f) => modelMatches(f, model)) ? 'listed' : 'off-list'
}

/**
 * The model that wrote a subagent's LAST assistant message, read from its transcript (the
 * JSONL at the SubagentStop payload's `agent_transcript_path`), or null. The shape is
 * Fact 16's, observed at Claude Code 2.1.285: every `assistant` line carries the model that
 * produced it at `message.model`, as a full ID; `attachment` lines carry none, and the
 * `model` attachment names the REQUESTED model, which after a failover is not the one that
 * ran, so it is never read. `<synthetic>` there would mark a line Claude Code wrote itself
 * (not observed, skipped defensively), which is never a model. A line that does not parse
 * is skipped, so a torn tail cannot hide the lines before it. The last model, because that
 * is the one that wrote the verdict.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function transcriptModel(raw) {
  let model = null
  for (const line of String(raw ?? '').split('\n')) {
    const found = assistantModel(parseObject(line))
    if (found !== null) model = found
  }
  return model
}

/** @param {Record<string, any>|null} line @returns {string|null} */
function assistantModel(line) {
  const message = line?.message
  if (line?.type !== 'assistant' && message?.role !== 'assistant') return null
  const model = typeof message?.model === 'string' ? message.model.trim() : ''
  return model === '' || model === '<synthetic>' ? null : model
}

/** @param {{pin: string|null, fallbacks: string[]}} p */
const listText = (p) => (p.fallbacks.length === 0 ? 'none listed' : p.fallbacks.join(', '))

/**
 * The `FALLBACK MODEL` line for a verdict that did not run on its pin, without the gate prefix.
 * @param {string} agent @param {string|null} model @param {{pin: string|null, fallbacks: string[]}} p
 * @param {'listed' | 'off-list' | 'unknown'} cls @param {string} why
 */
function fallbackLine(agent, model, p, cls, why) {
  if (cls === 'unknown') {
    return `${agent}'s PASS carries model: null: the hook could not read which model it ran on${why}.`
  }
  const where =
    cls === 'listed'
      ? `a listed fallback (harnessFallbackModels: ${listText(p)})`
      : `NOT on its harnessFallbackModels list (${listText(p)})`
  return `${agent}'s PASS ran on ${String(model)}, not its pin (${p.pin ?? 'none readable'}): ${where}${why}.`
}

/**
 * The finding for a security reviewer whose PASS does not count on the model it ran on.
 * @param {string} agent @param {string|null} model @param {{pin: string|null, fallbacks: string[]}} p
 * @param {string} why
 */
function modelFinding(agent, model, p, why) {
  const file = `.claude/agents/${agent}.md`
  if (model === null) {
    return `${agent} returned PASS, but the hook could not read the model it ran on (model: null)${why}. A security reviewer's PASS counts only on a model its agent file names, and an unverifiable model fails toward re-review: run ${agent} again. If every run records null, your Claude Code no longer writes the model where the hook reads it (message.model on the transcript's assistant lines, the harness repository's design/CONTROL-PLANE-FACTS.md Fact 16): that is a harness defect, so report it with your Claude Code version.`
  }
  return `${agent} returned PASS on ${model}, which is neither its pinned model (${p.pin ?? 'none readable'}) nor on its harnessFallbackModels list (${listText(p)})${why}. A security reviewer's PASS counts only on a model its hash-locked agent file names. Run ${agent} again on its pin or a listed model (the per-invocation model parameter selects one); a configuration that forces this model (CLAUDE_CODE_SUBAGENT_MODEL_FORCE, an availableModels allowlist, a fallbackModel chain) lands a re-run on the same model, so lift it, or, if this model is one you accept for security review, add it to harnessFallbackModels in ${file} in a reviewed diff (the file is write-guarded and hashed in tools/agents.lock.json, so that is a human act).`
}

/**
 * The model half of one owed reviewer's verdict, judged on the entry that verdict rests on:
 * `{ finding, line }`, each a sentence or null. An entry with no `model` field (written by a
 * hook from before 1.1.0) is judged exactly as before: nothing. A model that matches the pin
 * is silent. Any other model is NAMED on a line, and for a security reviewer a model off the
 * list, or one the hook could not read, is also a finding: that PASS does not count.
 * @param {{agent: string, security: boolean}} who
 * @param {Record<string, unknown>|undefined} entry
 * @param {{pin: string|null, fallbacks: string[]}|null} policy the agent file's, or null when
 *   it could not be read
 * @returns {{ finding: string|null, line: string|null }}
 */
export function judgeModel(who, entry, policy) {
  if (entry === undefined || entry === null || !Object.hasOwn(entry, 'model')) {
    return { finding: null, line: null }
  }
  const p = policy ?? { pin: null, fallbacks: [] }
  const why =
    policy === null
      ? ` (.claude/agents/${who.agent}.md could not be read, so no pin or list is known)`
      : ''
  const model =
    typeof entry.model === 'string' && entry.model.trim() !== '' ? entry.model.trim() : null
  const cls = classifyModel(model, p.pin, p.fallbacks)
  if (cls === 'pinned') return { finding: null, line: null }
  const line = fallbackLine(who.agent, model, p, cls, why)
  if (!who.security || cls === 'listed') return { finding: null, line }
  return { finding: modelFinding(who.agent, model, p, why), line }
}

/**
 * The ledger, narrowed to ONE TURN.
 *
 * The narrowing is the control. The file is append-only across a whole session, so an entry
 * from an earlier prompt is exactly what a naive reader would accept — and accepting it would
 * report coverage from work somebody did an hour ago, silently, which is the one failure mode
 * here that no later check would catch.
 *
 * MALFORMED LINES ARE BOUNDED TO THE LINE (0.9.0). This used to fail closed on ANY bad
 * line, forever — and the failure text prescribed deleting the ledger, a remedy the
 * write-guard denies (`.harness/` is a protected surface). Two sessions share one file, so
 * a torn write from a session that got killed mid-append bricked every later turn in the
 * directory with no exit the consumer could take. The posture now:
 *   - a line that does not parse, or parses to a non-object → SKIPPED, reported in
 *     `skipped` with its line number and content class (it cannot even be attributed to a
 *     turn, so it can authorize nothing and can be owed nothing);
 *   - a parsed entry MISSING agent_type/verdict that claims THIS turn's session+prompt →
 *     `error` (fail closed: the current turn's own verdict lines must be readable, or a
 *     torn PASS would read as "no reviewer was owed");
 *   - the same mis-shape from ANOTHER turn → SKIPPED with its class named.
 * ONE shape rather than a discriminated union: `error` is null on success. A union reads
 * better in the abstract and forces every call site through a narrowing dance that adds no
 * safety here — there are two consumers and both check `error` first.
 * @param {string} raw @param {string} sessionId @param {string} promptId @param {string} label
 * @returns {{ entries: object[], error: string|null, skipped: string[] }}
 */
export function readLedger(raw, sessionId, promptId, label = '.harness/reviewer-ledger.jsonl') {
  const entries = []
  const skipped = []
  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped.push(
        `line ${String(i + 1)} of ${label} is not JSON — skipped (unattributable, so it can authorize nothing)`,
      )
      continue
    }
    if (parsed === null || typeof parsed !== 'object') {
      skipped.push(
        `line ${String(i + 1)} of ${label} is not an object — skipped (unattributable, so it can authorize nothing)`,
      )
      continue
    }
    const mine = parsed.session_id === sessionId && parsed.prompt_id === promptId
    if (typeof parsed.agent_type !== 'string' || typeof parsed.verdict !== 'string') {
      if (mine) {
        return {
          entries: [],
          error: `line ${String(i + 1)} of ${label} belongs to THIS turn and is missing agent_type or verdict`,
          skipped,
        }
      }
      skipped.push(
        `line ${String(i + 1)} of ${label} is missing agent_type or verdict (another session/turn's entry) — skipped`,
      )
      continue
    }
    if (mine) entries.push(parsed)
  }
  return { entries, error: null, skipped }
}
