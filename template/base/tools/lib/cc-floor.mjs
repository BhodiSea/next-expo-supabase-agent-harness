// cc-floor.mjs — the pure half of the CLAUDE CODE version floor.
//
// The harness's enforcement layer IS `.claude/settings.json` plus hooks, which makes Claude
// Code the one dependency whose compromise compromises every other control — and through
// 0.5.0 it was the one dependency with no floor at all. Every framework the scaffold ships
// is held to a cited minimum; the tool doing the holding was held to nothing.
//
// TWO HALVES, SPLIT ON THE CLOCK — the same split `framework-floor.mjs` argues for, because
// the argument is the same. `pnpm validate` must be deterministic: same tree, same verdict,
// forever. So the CLOCKLESS half (does the file's own arithmetic hold?) rides `version-sync`
// in the chain, and the CLOCKFUL half (has anyone looked lately?) rides the scheduled
// `floor-review` job.
//
// WHAT THE CLOCKLESS HALF CANNOT DO, stated here so nothing downstream implies otherwise: it
// has no network, so it cannot know whether an advisory was published this morning. It proves
// the file is INTERNALLY HONEST — that the scalar floor equals the evidence beside it, that
// every advisory carries a citation somebody can open, and that `setBy` names exactly the
// advisories that actually set the number. Completeness is the scheduled job's business, and
// conflating the two would let "the arithmetic checks out" read as "the floor is current".
// SOURCE: design/CONTROL-PLANE-FACTS.md (Fact 10 — the queried advisory surface)

const SEMVER = /^\d+\.\d+\.\d+$/

/** Numeric semver compare over the `x.y.z` shape this file requires. */
export function cmpVersion(a, b) {
  const A = String(a).split('.').map(Number)
  const B = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (A[i] !== B[i]) return A[i] - B[i]
  }
  return 0
}

/** The advisory host whose pages carry a machine-readable, permanently-addressed record. */
const ADVISORY_HOST = 'https://github.com/advisories/'

const REQUIRED_FIELDS = ['id', 'ghsa', 'severity', 'published', 'patched', 'summary', 'url']

/** Every row must be a citation somebody can open, and must say why it is in THIS file. */
function rowProblems(list, path) {
  const problems = []
  for (const [i, a] of list.entries()) {
    const at = `${path} advisory ${String(i + 1)} (${a?.id ?? a?.ghsa ?? 'unidentified'})`
    for (const field of REQUIRED_FIELDS) {
      if (typeof a?.[field] !== 'string' || a[field].trim() === '') {
        problems.push(`${at}: \`${field}\` is missing or empty.`)
      }
    }
    if (!SEMVER.test(String(a?.patched))) {
      problems.push(
        `${at}: \`patched\` is ${JSON.stringify(a?.patched)}, not an x.y.z version — the floor is derived from these, so an unparseable one silently drops out of the arithmetic.`,
      )
    }
    if (typeof a?.url === 'string' && !a.url.startsWith(ADVISORY_HOST)) {
      problems.push(
        `${at}: \`url\` is ${JSON.stringify(a.url)}. Cite ${ADVISORY_HOST}<GHSA-id> — a permanent, machine-readable record. A blog post about an advisory is not the advisory.`,
      )
    }
    // Without this the list is a copy of a database, and a copy of a database goes stale
    // silently; with it, each row is an argument a reviewer can disagree with.
    if (typeof a?.whyItMattersHere !== 'string' || a.whyItMattersHere.trim().length < 40) {
      problems.push(
        `${at}: \`whyItMattersHere\` is missing or too short. Every row must say what it does to THIS harness — otherwise this file is a stale copy of a vulnerability database rather than a reviewed floor.`,
      )
    }
  }
  return problems
}

/** The scalar floor must equal the newest `patched` beside it — in either direction. */
function scalarProblems(required, derived, path) {
  if (!SEMVER.test(String(required))) {
    return [`${path}: \`required.version\` is ${JSON.stringify(required)}, not an x.y.z version.`]
  }
  if (derived === null || cmpVersion(required, derived) === 0) return []
  const direction =
    cmpVersion(required, derived) < 0
      ? 'The floor is BELOW its own evidence — a consumer meeting it still runs a version with a published escape in the tool that enforces everything else.'
      : 'The floor is ABOVE its own evidence with nothing in the file to justify the gap. Raise it deliberately (add the advisory or a featureFloors entry that requires it), never silently.'
  return [
    `${path}: \`required.version\` is ${required} but the listed advisories are only all patched at ${derived}. ${direction}`,
  ]
}

/**
 * `setBy` and the evidence must agree in BOTH directions.
 *
 * One direction alone is the usual half-check: naming an advisory that sets the floor is easy
 * to keep true, while an advisory that QUIETLY starts setting it — because a later one was
 * added at the same patched version — is the case a one-way check never notices.
 */
function setByProblems(list, setBy, derived, path) {
  if (derived === null) return []
  const problems = []
  const actual = new Set(
    list.filter((a) => String(a.patched) === derived).map((a) => String(a.id ?? a.ghsa)),
  )
  const claimed = new Set((setBy ?? []).map(String))
  for (const id of actual) {
    if (!claimed.has(id)) {
      problems.push(
        `${path}: ${id} is patched at ${derived}, which is the floor, but \`required.setBy\` does not name it.`,
      )
    }
  }
  for (const id of claimed) {
    if (!actual.has(id)) {
      problems.push(
        `${path}: \`required.setBy\` names ${id}, but no listed advisory with that id is patched at the floor (${derived}). A setBy entry that no longer sets the floor makes the file read as reviewed when it is stale.`,
      )
    }
  }
  return problems
}

/** A recommendation must be reachable from the requirement, and cover the features it lists. */
function recommendedProblems(recommended, required, path) {
  const version = recommended?.version
  if (version === undefined) return []
  if (!SEMVER.test(String(version))) {
    return [`${path}: \`recommended.version\` is ${JSON.stringify(version)}, not an x.y.z version.`]
  }
  const problems = []
  if (SEMVER.test(String(required)) && cmpVersion(version, required) < 0) {
    problems.push(
      `${path}: \`recommended.version\` (${version}) is BELOW \`required.version\` (${required}) — a recommendation weaker than the requirement is a contradiction, not a recommendation.`,
    )
  }
  const top = (recommended.featureFloors ?? [])
    .map((f) => String(f?.version))
    .filter((v) => SEMVER.test(v))
    .sort(cmpVersion)
    .at(-1)
  if (top !== undefined && cmpVersion(version, top) < 0) {
    problems.push(
      `${path}: \`recommended.version\` is ${version} but a featureFloors entry needs ${top}. The recommendation must cover every feature it lists, or the list is describing a version nobody is being told to run.`,
    )
  }
  return problems
}

/**
 * The clockless judgement.
 * @param {{ floor: object, path?: string }} input
 * @returns {{ problems: string[], judged: number, derived: string|null }}
 */
export function judgeCcFloor({ floor, path = 'tools/cc-floor.json' }) {
  const list = Array.isArray(floor?.surfaceAdvisories) ? floor.surfaceAdvisories : []
  if (list.length === 0) {
    return {
      problems: [
        `${path} lists no advisories. The floor's entire value is that every digit is attached to a published advisory — a bare version number is one a maintainer lowers the first time a teammate's CLI is old, because nothing in the file says what it costs.`,
      ],
      judged: 0,
      derived: null,
    }
  }

  const patched = list.map((a) => String(a?.patched)).filter((v) => SEMVER.test(v))
  const derived = patched.length === 0 ? null : patched.sort(cmpVersion).at(-1)
  const required = floor?.required?.version

  const problems = [
    ...rowProblems(list, path),
    ...scalarProblems(required, derived, path),
    ...(SEMVER.test(String(required))
      ? setByProblems(list, floor?.required?.setBy, derived, path)
      : []),
    ...recommendedProblems(floor?.recommended, required, path),
  ]

  // A count below the number listed means the snapshot was edited without re-querying.
  const count = floor?.advisoryCount
  if (typeof count === 'number' && count < list.length) {
    problems.push(
      `${path}: \`advisoryCount\` is ${String(count)} but ${String(list.length)} advisories are listed. The count is the size of the QUERY result; listing more than were found means one of the two was edited without the other.`,
    )
  }

  return { problems, judged: list.length, derived }
}

/**
 * The clockful half: has anyone re-queried the advisory database lately?
 *
 * A floor is a snapshot of what a human knew on `checkedOn`. Left alone it decays into the
 * assertion that nothing has been published since — the same decay `staleReviews` exists for,
 * and a sharper one here, because this database gained fifteen entries in the seven months
 * before the floor was first written.
 * @param {{ floor: object, today: string, maxAgeDays?: number, path?: string }} input
 */
export function staleCcReview({ floor, today, maxAgeDays = 45, path = 'tools/cc-floor.json' }) {
  const checkedOn = String(floor?.checkedOn ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedOn)) {
    return [
      `${path}: \`checkedOn\` is ${JSON.stringify(floor?.checkedOn)} — it must be an ISO date (YYYY-MM-DD), or the freshness of this floor cannot be judged at all.`,
    ]
  }
  const days = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${checkedOn}T00:00:00Z`)) / 86_400_000,
  )
  if (days > maxAgeDays) {
    return [
      `${path}: the advisory snapshot was taken on ${checkedOn}, ${String(days)} days ago (today is ${today}; the window is ${String(maxAgeDays)} days). Re-run \`${floor?.advisorySource ?? 'the advisory query'}\`, update every advisory patched above the current floor, and move \`checkedOn\` in the SAME commit — moving the date alone is the one edit this control cannot tell from a real review.`,
    ]
  }
  return []
}
