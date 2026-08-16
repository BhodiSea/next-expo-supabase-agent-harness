// The vendor-support register's judgements — the eol/cc-floor CLOCK SPLIT, applied
// to the two Essential Eight rows (PA-11 online services, POS-16 platforms) that ask
// whether the things this stack RUNS ON are still vendor-supported. The register
// (tools/support-register.json) is reviewed data; these functions are pure so both
// consumers can prove them red without a filesystem:
//   * CLOCKLESS — supportRegisterProblems(): shape, the services/platforms split,
//     and the PLATFORM-FACT CLOSURE (a register row must name the platform the tree
//     actually pins, or the register describes a stack this repository no longer
//     ships). Rides the `version-sync` chain step beside the eol half.
//   * CLOCKFUL — staleSupportReviews(): reviewedUntil lapse, riding the scheduled
//     `floor-review` job as its fifth register.
//
// WHY A REGISTER AND NOT A PROBE. None of the online services publishes a support
// flag in any artefact this tree contains, and asking their APIs is refused by the
// hermeticity rule (a gate resolving expectations from a live endpoint reds an
// untouched commit overnight). So supported-ness is REVIEWED: each row carries the
// vendor's own statement (url + quote + fetchedOn) and a window after which the
// review must be redone. A row may also be an HONEST PERMANENT CEILING
// (status "ceiling"): the fact that a vendor publishes no support lifecycle is
// itself the finding, recorded so it cannot be mistaken for an omission.
// SOURCE: docs/harness/gates-catalog.md (version-sync; the clock split) [corpus: harness/doctrine]

const DATE = /^\d{4}-\d{2}-\d{2}$/

function rowProblems(row, i, kind) {
  const at = `${kind}[${i}]`
  const out = []
  if (typeof row?.subject !== 'string' || row.subject.trim() === '') {
    out.push(`${at}: needs a "subject" — a support claim about nothing covers nothing`)
    return out
  }
  if (row.status !== 'supported' && row.status !== 'ceiling') {
    out.push(
      `${at} (${row.subject}): "status" must be 'supported' (a reviewed vendor statement says so) or 'ceiling' (the vendor publishes no support lifecycle, recorded as a fact) — got ${JSON.stringify(row.status)}`,
    )
  }
  const v = row.vendorStatement
  if (
    v === null ||
    typeof v !== 'object' ||
    typeof v.url !== 'string' ||
    !v.url.startsWith('https://') ||
    typeof v.quote !== 'string' ||
    v.quote.trim().length < 20 ||
    typeof v.fetchedOn !== 'string' ||
    !DATE.test(v.fetchedOn)
  ) {
    out.push(
      `${at} (${row.subject}): needs a "vendorStatement" of {url: https…, quote: >= 20 chars, fetchedOn: YYYY-MM-DD} — the review IS the vendor's words, dated, or it is an opinion`,
    )
  }
  if (typeof row.reviewedUntil !== 'string' || !DATE.test(row.reviewedUntil)) {
    out.push(
      `${at} (${row.subject}): needs a "reviewedUntil" date (YYYY-MM-DD) — a support review without an expiry becomes the standing claim that nothing has changed since somebody last looked`,
    )
  }
  return out
}

/**
 * The clockless half: shape + the platform-fact closure.
 * @param {any} register parsed tools/support-register.json
 * @param {{ postgresMajor?: string | null, nodeFloor?: string | null }} facts
 *   the TREE's own pins (config.toml [db].major_version; package.json engines.node),
 *   null when a fact is unreadable — the closure then says so instead of guessing.
 * @returns {string[]}
 */
export function supportRegisterProblems(register, facts = {}) {
  if (
    register === null ||
    typeof register !== 'object' ||
    !Array.isArray(register.services) ||
    !Array.isArray(register.platforms)
  ) {
    return [
      'tools/support-register.json must carry "services" and "platforms" ARRAYS — the two Essential Eight subjects (PA-11, POS-16) are graded on their own halves and must not blur',
    ]
  }
  const problems = []
  for (const [i, row] of register.services.entries())
    problems.push(...rowProblems(row, i, 'services'))
  for (const [i, row] of register.platforms.entries())
    problems.push(...rowProblems(row, i, 'platforms'))

  const subjects = [...register.services, ...register.platforms].map((r) => r?.subject)
  const dupes = subjects.filter((s, i) => typeof s === 'string' && subjects.indexOf(s) !== i)
  for (const d of new Set(dupes)) {
    problems.push(
      `subject '${d}' appears more than once — one subject, one reviewed disposition; a duplicate is two reviews disagreeing in silence`,
    )
  }
  if (register.services.length === 0 || register.platforms.length === 0) {
    problems.push(
      'an EMPTY services or platforms array is a vacuous register — the stack demonstrably runs on online services and platforms, so a register listing none reviews nothing (anti-vacuity)',
    )
  }

  // THE PLATFORM-FACT CLOSURE — what keeps the register tied to the tree instead of
  // to the release it was written for. The tree pins its Postgres major and its Node
  // floor; the register must carry a row for EXACTLY those, so bumping a platform
  // without re-reviewing its support is a red, not a drift.
  const platformSubjects = new Set(register.platforms.map((r) => r?.subject))
  if (facts.postgresMajor !== undefined) {
    if (facts.postgresMajor === null) {
      problems.push(
        "supabase/config.toml carries no readable [db].major_version — the platform closure cannot bind, and an unbound register describes somebody else's stack",
      )
    } else if (!platformSubjects.has(`postgres-${facts.postgresMajor}`)) {
      problems.push(
        `the tree pins Postgres major ${facts.postgresMajor} (supabase/config.toml) but the register has no 'postgres-${facts.postgresMajor}' platform row — the database under every policy in this repo has no reviewed support disposition`,
      )
    }
  }
  if (facts.nodeFloor !== undefined) {
    if (facts.nodeFloor === null) {
      problems.push(
        'package.json carries no readable engines.node floor — the platform closure cannot bind for the runtime',
      )
    } else if (!platformSubjects.has(`node-${facts.nodeFloor}`)) {
      problems.push(
        `the tree's engines.node floor is ${facts.nodeFloor} (package.json) but the register has no 'node-${facts.nodeFloor}' platform row — the runtime everything executes on has no reviewed support disposition`,
      )
    }
  }
  return problems
}

/**
 * The clockful half, for the scheduled floor-review job only.
 * @param {{ register: any, today: string, path: string }} input
 * @returns {string[]}
 */
export function staleSupportReviews({ register, today, path }) {
  const rows = [
    ...(Array.isArray(register?.services) ? register.services : []),
    ...(Array.isArray(register?.platforms) ? register.platforms : []),
  ]
  const out = []
  for (const row of rows) {
    if (typeof row?.reviewedUntil !== 'string' || !DATE.test(row.reviewedUntil)) continue
    if (row.reviewedUntil < today) {
      out.push(
        `${path}: the support review for '${row.subject}' lapsed on ${row.reviewedUntil} — re-read the vendor's statement and move the quote, fetchedOn and reviewedUntil in ONE commit (a date-only bump is the edit this control cannot distinguish from a review, which is why the diff is human-reviewed)`,
      )
    }
  }
  return out
}
