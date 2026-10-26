// Did any gate SKIP that a laptop without Docker should run? — the macOS scaffold lane's
// one assertion (#168), kept out of inline shell so it can be proven without a runner.
//
// THE POSTURE. The lane runs `validate` with CI unset, so a gate whose prerequisite is
// absent skips loudly instead of failing closed (inCI(), template/base/tools/lib/gate.mjs).
// That is what a developer's Mac gets. A skip is never a pass, so the lane then reds on
// every skip except the database-backed gates, which need the local Supabase stack and so
// Docker, which a macOS runner does not have. A macOS defect cannot hide behind a skip, and
// no new escape switch enters the harness: the allowance lives here, in the factory, and
// names the gates it covers.
// SOURCE: .github/workflows/selftest.yml (macos-scaffold) · template/base/tools/lib/gate.mjs

/**
 * The validate steps allowed to skip on a runner without Docker. Each needs a live database:
 * types-drift diffs the generated types against `supabase gen types` from the local stack.
 * Adding a name here widens what the lane lets through, so it needs a reason as good.
 */
export const DATABASE_STEPS = Object.freeze(['types-drift'])

/**
 * Every skip a validate log records, attributed to the step whose `=== <step>: <cmd>`
 * header it printed under. A skip is a line that starts `<gate>: SKIPPED` (skipOrFail and
 * the gates that print their own), or a `<gate>: NOTE` line that says part of the gate was
 * SKIPPED (styleguide's regen-diff without node_modules). Anchored at line start, so prose
 * that merely names the word is not a skip.
 * @param {string} validateLog
 * @returns {{ step: string, line: string }[]}
 */
export function skipsByStep(validateLog) {
  const skips = []
  let step = '(before any step)'
  for (const line of String(validateLog).split(/\r?\n/)) {
    const header = /^=== ([a-z0-9-]+): /.exec(line)
    if (header !== null) {
      step = header[1]
      continue
    }
    if (/^[\w.-]+: (?:SKIPPED\b|NOTE\b.*\bSKIPPED\b)/.test(line)) skips.push({ step, line })
  }
  return skips
}

/**
 * The lane's verdict. Problems: a skip in any step not in `allowed`; a log with no
 * `validate summary:` (the run died before it finished, so its silence proves nothing);
 * and a non-zero validate exit, reported here so the lane names it beside the skips.
 * @param {{ validateLog: string, validateCode: number, allowed?: readonly string[] }} input
 * @returns {{ problems: string[], allowedSkips: { step: string, line: string }[] }}
 */
export function judgeSkips({ validateLog, validateCode, allowed = DATABASE_STEPS }) {
  const problems = []
  const allowedSkips = []
  for (const skip of skipsByStep(validateLog)) {
    if (allowed.includes(skip.step)) allowedSkips.push(skip)
    else
      problems.push(
        `step '${skip.step}' skipped and it does not need a database: ${skip.line.trim()}`,
      )
  }
  if (!/^validate summary:$/m.test(String(validateLog))) {
    problems.push('the log has no `validate summary:` line, so the run did not finish')
  }
  if (validateCode !== 0) problems.push(`validate exited ${String(validateCode)}`)
  return { problems, allowedSkips }
}
