// The ONE definition of "files this change touches", shared by every diff-scoped gate
// (check-diff-coverage.mjs, mutation-scope.mjs). Two copies would drift, and a diff-scoped
// gate that computes the wrong diff does not fail — it silently checks nothing.
//
// Two modes, deliberately different:
//   - CI with a PR base: the MERGE-BASE diff, so a long-running branch is judged on its own
//     changes rather than on everything main has moved on to.
//   - Local / agent-time: everything a commit-and-push would carry that HEAD does not —
//     worktree edits, staged-only edits, AND untracked files. An agent's brand-new module is
//     untracked, and that is precisely the file a diff-scoped gate must not miss.
// Deletions are filtered out (--diff-filter=d): a removed file has nothing to check.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export const firstLine = (e) => (e.stderr?.toString() ?? e.message).trim().split('\n')[0]

/**
 * @returns {string[]} repo-relative paths, deletions excluded.
 * @throws when git is unusable or (in CI) the PR base cannot be resolved — a diff-scoped
 *         gate must FAIL rather than silently check an empty set. A shallow checkout is the
 *         usual cause in CI; the fix is `fetch-depth: 0`.
 */
export function changedFiles() {
  if (process.env.CI === 'true' && process.env.GITHUB_BASE_REF) {
    const baseRef = `origin/${process.env.GITHUB_BASE_REF}`
    const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim()
    return git(['diff', '--name-only', '--diff-filter=d', mergeBase, 'HEAD'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }
  const out = new Set()
  for (const args of [
    ['diff', '--name-only', '--diff-filter=d', 'HEAD'],
    ['diff', '--name-only', '--diff-filter=d', '--cached'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const line of git(args).split('\n')) {
      if (line.trim()) out.add(line.trim())
    }
  }
  return [...out]
}
