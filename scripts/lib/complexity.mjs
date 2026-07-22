// The arithmetic behind the machinery complexity ratchet (G16), split from the script that
// shells out to ESLint so it can be tested as a pure function: records in, problems out. The
// gate itself (scripts/check-complexity-ratchet.mjs) only supplies the measurements.

/**
 * A position-independent name for the function ESLint flagged, read off its declaration line.
 *
 * NOT a line number. An inserted import must not invalidate every entry below it — that defect
 * cost a rewrite when the mutation ratchet shipped with `file:line:column` identity.
 *
 * Anonymous callbacks (`entries.forEach((entry, i) => {`) have no name to take, so they fall
 * back to their normalized declaration text: stable across line shifts, and it changes exactly
 * when the code changes, which is when a human should look again.
 */
export function identify(line) {
  const text = String(line).trim()
  const named =
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text) ??
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text) ??
    /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(text)
  if (named !== null) return named[1]
  return `anon(${text.replace(/\s+/g, ' ').slice(0, 60)})`
}

/**
 * Build the measured Map from `{ base, score }` entries, FAILING LOUD on any collision.
 *
 * `identify()` yields a bare name, and two OVER-LIMIT functions in one file can share it (a
 * `handle(x)` method beside a `handle(y)` method; two same-named nested helpers). A plain Map
 * would keep only the last (last-write-wins), silently dropping the other so it could grow
 * unwatched.
 *
 * The first fix here numbered collisions by occurrence (`#1`, `#2`). An adversarial review broke
 * it: ESLint only reports the functions that are ALREADY over the limit, so the occurrence index
 * is computed over an UNSTABLE population. When a same-named sibling crosses the limit (a refactor
 * pushes one under, or pushes another over), the indices renumber and a real regression can slide
 * into a vacated slot and read as "improved". No stable position-independent identity exists from
 * a bare name plus an unstable population.
 *
 * So collisions are not guessed — they are REFUSED. Two over-limit functions the ratchet cannot
 * tell apart is an identity failure, and the honest response is to say so and have the human give
 * them distinct names (or extract one). The harness's own 11 grandfathered functions have no
 * collisions, so this never fires in practice; a consumer who hits it has two same-named
 * over-limit functions in one file, which is a smell worth surfacing anyway.
 * @param {{ base: string, score: number }[]} entries
 * @returns {{ measured: Map<string, number>, collisions: string[] }}
 */
export function keyScores(entries) {
  const counts = new Map()
  for (const { base } of entries) counts.set(base, (counts.get(base) ?? 0) + 1)
  const measured = new Map()
  for (const { base, score } of entries) if (counts.get(base) === 1) measured.set(base, score)
  const collisions = [...counts.entries()].filter(([, n]) => n > 1).map(([base]) => base)
  return { measured, collisions }
}

/** "…reduce its Cognitive Complexity from 133 to the 15 allowed." */
const SCORE_RE = /Cognitive Complexity from (\d+) to the (\d+) allowed/

/** The measured score in an ESLint message, or null if it is not a complexity report. */
export function scoreOf(message) {
  const hit = SCORE_RE.exec(String(message))
  return hit === null ? null : Number(hit[1])
}

/**
 * Compare measured scores against the committed record.
 *
 * Three ways to red, and each closes a different hole:
 *  - GREW — the promise the CHANGELOG made ("may not grow") and nothing kept. A disable
 *    directive suppresses the rule outright, so init() could go 133 -> 500 with `eslint .`
 *    still green.
 *  - NEW — an over-limit function with no record. Without this, the ratchet only ever guards
 *    the eleven functions that happened to be over the bar in v0.1.5, and the twelfth is free.
 *  - STALE — a record whose function is no longer over the limit (or is gone). Budget nobody
 *    is using is budget everybody could spend, so the win gets banked, not banked-and-forgotten.
 *
 * Improvements are NOT a failure — they are reported so they can be banked deliberately.
 */
export function compareComplexity(measured, record) {
  const limit = record.limit ?? 15
  const recorded = record.functions ?? {}
  const problems = []
  const improved = []

  for (const [key, score] of measured) {
    const was = recorded[key]
    if (was === undefined) {
      problems.push(
        `${key}: NEW over-limit function at ${String(score)} (the bar is ${String(limit)}). ` +
          'The harness reds a CONSUMER for exactly this. Refactor it, or — if it is genuinely ' +
          'irreducible — record it in a reviewed commit and add the eslint-disable.',
      )
    } else if (score > was) {
      problems.push(
        `${key}: GREW to ${String(score)} from a recorded ${String(was)}. A ratcheted function ` +
          `may not grow. Bring it back to ${String(was)} or below — raising the record ` +
          're-baselines the very regression this exists to catch, so that is a human act.',
      )
    } else if (score < was) {
      improved.push([key, score, was])
    }
  }

  for (const [key, was] of Object.entries(recorded)) {
    if (!measured.has(key)) {
      problems.push(
        `${key}: recorded at ${String(was)} but no longer over the limit (or no longer exists). ` +
          'Bank the win — drop the entry and its eslint-disable comment (`--write`). A record ' +
          'that outlives its function is headroom the next change could quietly respend.',
      )
    }
  }

  return { problems, improved }
}
