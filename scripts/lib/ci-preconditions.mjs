// The judgement behind check-ci-preconditions.mjs, split from the script that reads the
// tree so it can be proven red as a pure function (tests/gates/ci-preconditions.test.mjs):
// shipped workflow text + the init command's source in, problems out.
//
// WHAT IT CLOSES. The first execution of the shipped quality-gate static job
// (scripts/ci/consumer-ci-static.sh, 0.9.0) established that the consumer CI's entry
// path is `pnpm install --frozen-lockfile` — an invocation that hard-fails on a scaffold
// whose first commit omitted pnpm-lock.yaml, with most jobs dying even earlier at
// setup-node's `cache: pnpm` step. Three parties have to keep agreeing for that entry
// path to stay satisfiable, and no single file shows all three:
//   1. every shipped `pnpm install` spells its lockfile posture EXPLICITLY — a bare
//      `pnpm install` resolves its default from the CI env var, so the same line is
//      frozen on a runner and floating on a laptop, and nobody decided either;
//   2. any workflow leaning on `cache: pnpm` (or a frozen install) is backed by init's
//      next-steps note naming pnpm-lock.yaml — the cross-file half, because the 0.9.0
//      guidance ("the first commit must include pnpm-lock.yaml") is the only thing that
//      makes the entry path completable, and prose regressions are silent;
//   3. every `uses:` reference is SHA-pinned (40-hex) with a version comment — the
//      consumer executes these actions on their own repo's credentials, and a movable
//      tag is a supply-chain writeback the shipped template would be handing them.
// SOURCE: scripts/ci/consumer-ci-static.sh (the executed entry path) ·
//         template/base/github/workflows/quality-gate.yml (the static job)

const FROZEN = /(^|\s)--frozen-lockfile(\s|$)/
const NO_FROZEN = /(^|\s)--no-frozen-lockfile(\s|$)/
// A `uses:` value is judged only when it is the YAML key at the start of a (possibly
// list-item) line — a `uses:`-shaped string inside a run-block's shell (actions-lint.yml
// greps for reusable-workflow calls) is shell text, not an action reference.
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/
const PINNED_REF = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/

/**
 * Every non-comment line of every workflow, tagged with its `file:line` address.
 * YAML comments and shell comments inside run blocks both start their trimmed line
 * with '#', so one skip covers both.
 * @param {Array<{ file: string, text: string }>} workflows
 * @returns {Array<{ at: string, line: string }>}
 */
function codeLines(workflows) {
  const out = []
  for (const { file, text } of workflows) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trimStart().startsWith('#')) continue
      out.push({ at: `${file}:${String(i + 1)}`, line: lines[i] })
    }
  }
  return out
}

/**
 * ── 1. every `pnpm install` spells its lockfile posture ────────────────────────────
 * @param {Array<{ at: string, line: string }>} lines
 * @returns {{ problems: string[], count: number, anyFrozen: boolean }}
 */
function judgeInstalls(lines) {
  const problems = []
  let count = 0
  let anyFrozen = false
  for (const { at, line } of lines) {
    const install = /\bpnpm install\b(?<flags>[^\n]*)/.exec(line)
    if (install === null) continue
    count += 1
    const flags = install.groups?.flags ?? ''
    if (NO_FROZEN.test(flags)) continue // a DECLARED divergence — visible in review
    if (FROZEN.test(flags)) {
      anyFrozen = true
    } else {
      problems.push(
        `${at}: \`pnpm install\` carries neither --frozen-lockfile nor --no-frozen-lockfile — pnpm resolves the default from the CI env var, so this line is frozen on a runner and floating on a laptop. Spell the posture: the shipped entry path is --frozen-lockfile; a deliberate divergence declares --no-frozen-lockfile.`,
      )
    }
  }
  return { problems, count, anyFrozen }
}

/**
 * ── 3. every action reference is SHA-pinned with a version comment ─────────────────
 * @param {Array<{ at: string, line: string }>} lines
 * @returns {{ problems: string[], count: number }}
 */
function judgeUses(lines) {
  const problems = []
  let count = 0
  for (const { at, line } of lines) {
    const uses = USES_LINE.exec(line)
    if (uses === null) continue
    count += 1
    const [ref, ...comment] = uses[1].split('#')
    if (!PINNED_REF.test(ref.trim())) {
      problems.push(
        `${at}: \`uses: ${ref.trim()}\` is not SHA-pinned — a consumer executes this action with their own repo's credentials, and a movable tag or branch ref is a writable supply-chain edge the template would be shipping. Pin the full 40-hex commit.`,
      )
    } else if (comment.join('#').trim() === '') {
      problems.push(
        `${at}: \`uses: ${ref.trim()}\` is pinned but carries no version comment — a bare SHA is unreviewable (nobody can see what version it claims to be), and it is what lets a pin bump ride an unrelated diff. Append \`# v<version>\`.`,
      )
    }
  }
  return { problems, count }
}

/**
 * ── 2. the cross-file closure: the demand and the guidance must agree ──────────────
 * @param {string} initSource
 * @returns {string[]}
 */
function judgeInitNote(initSource) {
  const note = /'next:[^']*'/.exec(initSource)
  if (note === null) {
    return [
      "installer/commands/init.mjs has no 'next:' note at all — the shipped workflows demand a committed lockfile (cache: pnpm / --frozen-lockfile) and the init contract's next-steps note is the one place a consumer is told, so the closure cannot find its anchor",
    ]
  }
  if (!note[0].includes('pnpm-lock.yaml')) {
    return [
      "installer/commands/init.mjs's next-steps note no longer names pnpm-lock.yaml — the shipped workflows' entry path (`pnpm install --frozen-lockfile`, setup-node `cache: pnpm`) hard-fails unless the first commit includes the lockfile, and this note is the only place the consumer is told. Restore the committed-lockfile instruction.",
    ]
  }
  return []
}

/**
 * @param {{ workflows: Array<{ file: string, text: string }>, initSource: string }} input
 * @returns {string[]} problems — empty means the shipped CI's entry path is coherent
 */
export function ciPreconditionProblems({ workflows, initSource }) {
  if (workflows.length === 0) {
    // Fail closed: an empty universe is what a broken glob produces, and a closure that
    // cannot see its subject must never report it clean.
    return ['no shipped workflows to judge — the scan found ZERO files, so every closure below would be vacuous']
  }

  const lines = codeLines(workflows)
  const installs = judgeInstalls(lines)
  const uses = judgeUses(lines)
  const problems = [...installs.problems, ...uses.problems]

  // Anti-vacuity for the two per-feature universes: the shipped set carries both today,
  // so a zero count means the parser broke, not that the surface went away.
  if (installs.count === 0) {
    problems.push(
      'the scan found no `pnpm install` invocation in any shipped workflow — the entry path this gate closes over is that invocation, so an empty scan asserts nothing',
    )
  }
  if (uses.count === 0) {
    problems.push(
      'the scan found no `uses:` reference in any shipped workflow — every shipped job starts with actions, so an empty scan means the parser broke',
    )
  }

  const wantsLockfile =
    installs.anyFrozen || lines.some(({ line }) => /^\s*cache:\s*['"]?pnpm['"]?\s*$/.test(line))
  if (wantsLockfile) problems.push(...judgeInitNote(initSource))

  return problems
}
