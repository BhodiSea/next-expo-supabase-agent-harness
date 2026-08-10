// tools/lib/reviewer-verdicts.mjs — the pure half of the process layer, shared by the hook
// that WRITES the verdict ledger (.claude/hooks/subagent-verdict.mjs) and the Stop step that
// READS it (tools/check-reviewer-verdicts.mjs).
//
// One module because the two ends must agree about three things and there is no second
// chance to notice they do not: what a verdict LINE looks like, what a ledger ENTRY looks
// like, and which turn an entry belongs to. Two copies of that agreement is the drift this
// release has spent itself deleting.
//
// Pure: no process exit, no I/O (hashing is computation, not I/O — pathStateDigest takes a
// reader precisely so the file system stays the caller's business). Every consumer supplies
// its own failure vocabulary.
// SOURCE: design/CONTROL-PLANE-FACTS.md (the observed SubagentStop payload)
import { createHash } from 'node:crypto'

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
  const owned = [...new Set((files ?? []).map((f) => String(f).split('\\').join('/')))]
    .filter((f) => matchesAny(f, reviewer.paths) && !matchesAny(f, reviewer.except))
    .sort()
  const h = createHash('sha256')
  for (const path of owned) {
    const content = readFileLike(path)
    h.update(
      `${path}\u0000${content === null || content === undefined ? 'DELETED' : sha256(content)}\n`,
    )
  }
  return h.digest('hex')
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
