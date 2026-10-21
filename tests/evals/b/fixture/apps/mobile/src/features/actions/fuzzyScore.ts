// Deterministic fuzzy ranking for the actions modal. A query matches a title
// when its characters appear IN ORDER (subsequence, case-insensitive); the
// score maximizes over all embeddings via a small dynamic program (a greedy
// left-to-right match would miss the best alignment — e.g. 'ma' inside
// 'a x matrix' should take the consecutive boundary run, not the first 'a').
// Rewards: +2 when a matched character starts a word (index 0 or preceded by a
// non-letter/digit), +2 when it extends a consecutive run, +1 base per char.
// Ranking is TOTAL and pure — score desc, then title asc, then id asc — so the
// same inputs produce the same order on every machine, in any input order.
// No Date, no randomness, no locale-sensitive comparisons.

const BASE = 1
const BOUNDARY_BONUS = 2
const RUN_BONUS = 2
const NO_MATCH = Number.NEGATIVE_INFINITY

const WORD_CHAR = /[\p{L}\p{N}]/u

/** True when a match at `index` starts a word: string start or after a non-word char. */
function isBoundary(text: string, index: number): boolean {
  return index === 0 || !WORD_CHAR.test(text.charAt(index - 1))
}

/**
 * Best score for matching query char `qc` exactly at text index `j`, given the
 * previous query char's DP rows (`prevEndAt`: matched exactly at an index;
 * `prevBest`: matched anywhere up to an index). NO_MATCH propagates through
 * the arithmetic (-Infinity + finite = -Infinity), so no branch is needed for
 * "the previous char never matched before j".
 */
function matchScore(
  qc: string,
  text: string,
  j: number,
  first: boolean,
  prevEndAt: readonly number[],
  prevBest: readonly number[],
): number {
  if (qc !== text.charAt(j)) return NO_MATCH
  const charScore = BASE + (isBoundary(text, j) ? BOUNDARY_BONUS : 0)
  if (first) return charScore
  const fresh = prevBest[j - 1] ?? NO_MATCH
  const run = (prevEndAt[j - 1] ?? NO_MATCH) + RUN_BONUS
  return Math.max(fresh, run) + charScore
}

/** Best-embedding subsequence score, or null when the query is not a subsequence. */
function fuzzyScore(query: string, title: string): number | null {
  const q = query.toLowerCase()
  const t = title.toLowerCase()
  if (q.length === 0) return 0
  if (q.length > t.length) return null
  let endAt: readonly number[] = []
  let best: readonly number[] = []
  for (let i = 0; i < q.length; i += 1) {
    const nextEndAt: number[] = []
    const nextBest: number[] = []
    for (let j = 0; j < t.length; j += 1) {
      nextEndAt.push(matchScore(q.charAt(i), t, j, i === 0, endAt, best))
      nextBest.push(Math.max(nextEndAt[j] ?? NO_MATCH, nextBest[j - 1] ?? NO_MATCH))
    }
    endAt = nextEndAt
    best = nextBest
  }
  const score = best[t.length - 1] ?? NO_MATCH
  return score === NO_MATCH ? null : score
}

/** Deterministic total tie-break — plain code-unit comparison, never localeCompare. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * The modal's ranking function: drop non-matches, order the rest by score
 * desc → title asc → id asc. An EMPTY query returns the commands untouched
 * (registration order), which is what the modal groups behind the pinned
 * Recents section before the user types.
 */
export function rankCommands<T extends { readonly id: string; readonly title: string }>(
  query: string,
  commands: readonly T[],
): readonly T[] {
  if (query === '') return commands
  const ranked: { readonly command: T; readonly score: number }[] = []
  for (const command of commands) {
    const score = fuzzyScore(query, command.title)
    if (score !== null) ranked.push({ command, score })
  }
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const byTitle = compareStrings(a.command.title, b.command.title)
    return byTitle === 0 ? compareStrings(a.command.id, b.command.id) : byTitle
  })
  return ranked.map((entry) => entry.command)
}
