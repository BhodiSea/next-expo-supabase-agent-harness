// Did the deadlines this leg meets actually RING? — the upgrade lane's sharpest assertion,
// moved out of inline shell so it can be proven without a CI runner.
//
// WHY IT MOVED. This logic lived as ~15 lines of `grep | cut | sort` and `case` inside
// scripts/ci/upgrade-lane.sh. It is the only thing standing between "an expiry fired" and
// "an expiry was supposed to fire and silently did not", which is the precise defect
// v0.4.0 shipped to fix (check-rate-limits.mjs printed RAMP EXPIRED and then called ok()).
// A control that important should not be reachable only by a 45-minute CI job on a
// throwaway scaffold — nobody can run it while writing the code it guards, so nobody does.
// This is the same move 0.5.0 made on the selftest's inline `[ "$elapsed" -gt 120 ]`.
//
// THE EXPECTATION IS AN UPPER BOUND, and that is a property of the gate scripts rather
// than a weakness here. Most call sites invoke rampNote only when the gate HAS a finding
// to withhold (`if (errs.length > 0) { rampNote(...) }`), so a deadline this install meets
// fires only if the finding also exists on this tree. Demanding one line per expiring gate
// would assert something the harness never promised, and the only way to make it pass
// would be to weaken it. Expected-but-silent gates are therefore REPORTED, never asserted
// — and never hidden, which is the half that matters. That rule is stated here because
// 0.5.0 shipped a draft of this file that broke it (see the note in judgeExpiries), and
// the first execution of the lane is what caught it.
// SOURCE: scripts/ci/upgrade-lane.sh (§7a) · template/base/tools/lib/gate.mjs

/**
 * The gate names that printed a `RAMP EXPIRED` line.
 *
 * Anchored at line start on `<gate>: RAMP EXPIRED`, which is exactly what gate.mjs writes.
 * A looser match would count the runbook text a gate sometimes echoes back, and a gate that
 * merely NAMES the phrase would read as one that fired.
 * @param {string} validateLog
 * @returns {string[]}
 */
export function firedExpiries(validateLog) {
  return [
    ...new Set(
      [...String(validateLog).matchAll(/^([a-z0-9-]+): RAMP EXPIRED/gm)].map((m) => m[1]),
    ),
  ].sort()
}

/**
 * Judge one leg's expiry run.
 *
 * @param {{
 *   expected: string[],   // gates the classifier says meet a deadline, narrowed to this chain
 *   validateLog: string,
 *   validateCode: number,
 *   baseVersion: string,
 * }} input
 * @returns {{ problems: string[], fired: string[], silent: string[] }}
 */
export function judgeExpiries({ expected, validateLog, validateCode, baseVersion }) {
  const problems = []
  const fired = firedExpiries(validateLog)
  const silent = expected.filter((g) => !fired.includes(g))

  if (expected.length === 0) {
    // No deadline is met, so a red chain is a real regression rather than an expiry — the
    // lane must not let "the upgrade broke the install" pass as "a ramp closed".
    if (validateCode !== 0) {
      problems.push(
        `validate is RED on the upgraded install (exit ${String(validateCode)}) and NO ramp deadline is met at baseVersion ${baseVersion} — this is a regression, not an expiry.`,
      )
    }
    // A gate that expired without being predicted is still a disagreement between the
    // classifier and gate.mjs, and it is checked here too rather than only in the branch
    // below: an unpredicted expiry on a leg that expects none is the loudest version of it.
    for (const g of fired) {
      problems.push(
        `gate \`${g}\` printed RAMP EXPIRED but the classifier predicted NO expiry at all for baseVersion ${baseVersion}. scripts/lib/ramp-sites.mjs mirrors gate.mjs deliberately so the two cannot disagree — one of them is now wrong.`,
      )
    }
    return { problems, fired, silent }
  }

  // THE CANARY TARGET, and the one assertion here that is actually sound: an expiry that
  // FIRED must have reddened the chain. rampNote returning false means the gate stops
  // withholding, so its findings surface and it fails — unless the call site throws the
  // result away, prints RAMP EXPIRED and calls ok() anyway, which is verbatim what
  // check-rate-limits.mjs did for three releases and what v0.4.0 shipped to fix.
  if (fired.length > 0 && validateCode === 0) {
    problems.push(
      `expiries FIRED (${fired.join(' ')}) and yet validate exited 0. An alarm ringing into a green run is the exact defect v0.4.0 shipped to fix: the call site printed RAMP EXPIRED and then discarded rampNote's result. See scripts/lib/ramp-sites.mjs (\`consumesResult\`).`,
    )
  }

  // AND THE ASSERTION THAT USED TO BE HERE AND WAS NOT SOUND. This branch demanded that at
  // least one expiry fire whenever a deadline was met, and called that the canary. Running
  // the lane for the first time showed it is wrong in exactly the way this file's own
  // header warns about four paragraphs up: the expectation is an UPPER BOUND, because most
  // call sites invoke rampNote only when the gate has a finding to withhold.
  //
  // Leg D is the worked example. Its single expectation is `wiring`, whose expiring site is
  // guarded by `if (!declared)` on eslint-plugin-jsx-a11y — and §"dependency obligations"
  // earlier in this same lane APPLIES that pin. The lane remedies the condition and then
  // demanded an alarm about it. Two correct features, and their interaction was only
  // visible by executing them.
  //
  // Nothing replaces it, because nothing needs to: "a call site discards rampNote's result"
  // is decided STATICALLY and exhaustively by scripts/check-ramp-ledger.mjs over every
  // shipped site, on every commit, with no scaffold. A dynamic re-check that cannot tell
  // that case from "this tree has no finding" is not a weaker version of that control, it
  // is a false alarm generator. All-silent is reported by the caller and asserted by
  // no one.

  for (const g of fired) {
    if (!expected.includes(g)) {
      problems.push(
        `gate \`${g}\` printed RAMP EXPIRED but the classifier did not predict it for baseVersion ${baseVersion}. scripts/lib/ramp-sites.mjs mirrors gate.mjs deliberately so the two cannot disagree — one of them is now wrong.`,
      )
    }
  }

  return { problems, fired, silent }
}
