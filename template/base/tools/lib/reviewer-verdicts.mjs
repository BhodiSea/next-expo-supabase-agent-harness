// tools/lib/reviewer-verdicts.mjs — the pure half of the process layer, shared by the hook
// that WRITES the verdict ledger (.claude/hooks/subagent-verdict.mjs) and the Stop step that
// READS it (tools/check-reviewer-verdicts.mjs).
//
// One module because the two ends must agree about three things and there is no second
// chance to notice they do not: what a verdict LINE looks like, what a ledger ENTRY looks
// like, and which turn an entry belongs to. Two copies of that agreement is the drift this
// release has spent itself deleting.
//
// Pure: no process exit, no I/O. Every consumer supplies its own failure vocabulary.
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed SubagentStop payload)

/** The mandated terminal line. `check-docs-sync.mjs` requires every reviewer body to demand it. */
const VERDICT_RE = /^VERDICT:\s*(PASS|BLOCK)\s*$/

/**
 * The verdict on the LAST non-empty line of a subagent's final message, or null.
 *
 * The last line, not a search of the whole text — and the difference is not pedantic. A
 * reviewer explaining its reasoning will write the words "VERDICT: PASS" inside a sentence
 * about what a pass would mean, and a scan that accepted that would read a hedge as an
 * attestation. The probe subagent wrote three paragraphs before its line; that is the shape.
 */
export function readVerdict(message) {
  if (typeof message !== 'string') return null
  const last =
    message
      .trimEnd()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .pop() ?? ''
  return VERDICT_RE.exec(last.trim())?.[1] ?? null
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

/**
 * The ledger, narrowed to ONE TURN.
 *
 * The narrowing is the control. The file is append-only across a whole session, so an entry
 * from an earlier prompt is exactly what a naive reader would accept — and accepting it would
 * report coverage from work somebody did an hour ago, silently, which is the one failure mode
 * here that no later check would catch.
 * ONE shape rather than a discriminated union: `error` is null on success. A union reads
 * better in the abstract and forces every call site through a narrowing dance that adds no
 * safety here — there are two consumers and both check `error` first.
 * @param {string} raw @param {string} sessionId @param {string} promptId @param {string} label
 * @returns {{ entries: object[], error: string|null }}
 */
export function readLedger(raw, sessionId, promptId, label = '.harness/reviewer-ledger.jsonl') {
  const entries = []
  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return { entries: [], error: `line ${String(i + 1)} of ${label} is not JSON` }
    }
    if (typeof parsed?.agent_type !== 'string' || typeof parsed?.verdict !== 'string') {
      return {
        entries: [],
        error: `line ${String(i + 1)} of ${label} is missing agent_type or verdict`,
      }
    }
    if (parsed.session_id === sessionId && parsed.prompt_id === promptId) entries.push(parsed)
  }
  return { entries, error: null }
}
