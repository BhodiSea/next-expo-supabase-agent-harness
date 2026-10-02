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
//
// reviewChanges() (1.1.0) is a SECOND definition with a different subject, and it lives here
// so the two stay side by side: "files a reviewer is owed a verdict on". Its only callers are
// the reviewer ledger v2 ends (.claude/hooks/subagent-verdict.mjs and
// tools/check-reviewer-verdicts.mjs), which must digest the SAME list. It differs from
// changedFiles() on purpose, and changedFiles() stays byte-identical because diff-coverage
// and mutation-scope rely on it:
//   - it keys on the MERGE BASE in both modes: in CI the PR base, locally the branch's
//     configured upstream. A commit made before the turn ends is still owed;
//   - it KEEPS deletions and splits renames (--no-renames), because deleting a policy or
//     moving a migration out of a triggered directory is a change a reviewer is owed;
//   - it never includes .harness/, the harness's own write-guarded state: a digest over the
//     ledger it guards would move with every verdict it records.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { commandFailureOutput } from './gate.mjs'

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export const firstLine = (e) => commandFailureOutput(e).split('\n')[0]

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

/** @param {string} cwd @param {string[]} args */
const gitIn = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** @param {string} out */
const lines = (out) =>
  out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * The base the owed set keys on, or null. In CI with a PR base it is `origin/<base>`, and
 * failing to resolve it THROWS, as changedFiles() does. Locally it is the branch's
 * configured upstream; a branch with none (a fresh `git init`, a branch created without
 * one), or whose upstream is gone, has no base. On a branch whose upstream is its own
 * remote branch (what `git push -u` sets), the merge base moves with each push.
 * @param {string} cwd @param {Record<string, string | undefined>} env
 */
function reviewBase(cwd, env) {
  if (env.CI === 'true' && env.GITHUB_BASE_REF) {
    const ref = `origin/${env.GITHUB_BASE_REF}`
    return { ref, mergeBase: gitIn(cwd, ['merge-base', ref, 'HEAD']).trim() }
  }
  try {
    const ref = gitIn(cwd, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]).trim()
    return { ref, mergeBase: gitIn(cwd, ['merge-base', ref, 'HEAD']).trim() }
  } catch {
    return null
  }
}

/**
 * The files a reviewer is owed a verdict on (1.1.0), sorted: everything that differs from
 * the merge base, committed or not, plus the working tree's own changes against HEAD, staged
 * changes and untracked files, deletions and both sides of a rename included, .harness/
 * excluded. `base` names the ref the merge base came from, and is null when there is none:
 * the set is then the working tree's changes only, and the reviewer ledger v2 does not judge
 * it (check-reviewer-verdicts.mjs says so).
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ files: string[], base: string | null }}
 * @throws when git is unusable, or in CI when the PR base cannot be resolved
 */
export function reviewChanges({ cwd = process.cwd(), env = process.env } = {}) {
  const base = reviewBase(cwd, env)
  const out = new Set()
  const sources = [
    ['diff', '--name-only', '--no-renames', 'HEAD'],
    ['diff', '--name-only', '--no-renames', '--cached'],
    ['ls-files', '--others', '--exclude-standard'],
  ]
  if (base !== null) sources.unshift(['diff', '--name-only', '--no-renames', base.mergeBase])
  for (const args of sources) {
    for (const line of lines(gitIn(cwd, args))) out.add(line)
  }
  const files = [...out].filter((f) => f !== '.harness' && !f.startsWith('.harness/')).sort()
  return { files, base: base?.ref ?? null }
}
