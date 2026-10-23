// tools/lib/workspace-tiers.mjs — the workspace tiers and the dependency walls, in one copy
// (2.1.0, #186).
//
// Until 2.1.0 these lived inside tools/check-workspace-deps.mjs (the `boundaries` gate), the
// only reader. The duplication gate's sweep (tools/lib/homes.mjs) now asks the same question
// of a class of copied bodies: may this member's workspace depend on the package a move would
// put the body in? Two copies of the walls would drift, and the weaker copy would print a home
// the gate itself reds, so both callers import this module and the gate's messages and
// verdicts do not change.
//
// The laws, all derived from the ONE census plus the universally importable kernel below.
// The census is two files since #160: the owned tools/exports-walls.json and the seeded
// tools/exports-walls.project.json, where a project sanctions its own verticals. Their union is
// read here and nowhere else, so no consumer can see a different list:
//   1. The mobile wall. apps/mobile may take a runtime @app/* dependency only if the census
//      sanctions it or it is in MOBILE_UNIVERSAL. @app/api is import-type-only, and the web
//      design system is DOM-only.
//   2. Web's design-system wall. apps/web never carries the RN-only design system.
//   3. verticals ⊥ verticals.
//   4. shared ↛ verticals.
// SOURCE: docs/harness/README.md (boundaries gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'

// The pure packages the census OMITS on purpose (no server half to gate), yet which
// apps/mobile legitimately imports as a VALUE. Not a second copy of the census — the
// complement of it. Each carries the reason it is universally safe.
const MOBILE_UNIVERSAL = new Map([
  [
    '@app/errors',
    'the error kernel — imports nothing, the single ActionOutcome envelope both surfaces speak',
  ],
  ['@app/events', 'the event-registry kernel — imports nothing, both surfaces'],
  ['@app/contracts', 'pure zod wire DTOs — the shared contract, no runtime beyond zod'],
  [
    '@app/design-system-native',
    'the MOBILE design system (NativeWind over the tokens) — RN-only, so web is walled from it, not mobile',
  ],
])
const WEB_ONLY = new Set(['@app/design-system']) // DOM/Radix — mobile is walled from it

// The ONE census, in two files (#160). The owned half is the harness's; the project half is
// seeded, starts empty, and may sanction only a package under packages/verticals/ that the owned
// half does not already list (projectCensusProblems below). Absent reads as empty.
export const CENSUS = 'tools/exports-walls.json'
export const PROJECT_CENSUS = 'tools/exports-walls.project.json'

/**
 * The tier of a workspace package, from its directory under packages/:
 * packages/verticals/* / shared/* / platform/* / everything else.
 * @param {string} rel the package directory relative to packages/, POSIX
 * @returns {'vertical' | 'shared' | 'platform' | 'other'}
 */
export function tierOf(rel) {
  if (/^verticals\//.test(rel)) return 'vertical'
  if (/^shared\//.test(rel)) return 'shared'
  if (/^platform\//.test(rel)) return 'platform'
  return 'other'
}

/**
 * The kind of a workspace by its repository-relative POSIX directory: the two apps by name,
 * a package by its tier, anything else `other`.
 * @param {string} dir e.g. `apps/mobile`, `packages/verticals/notes`
 * @returns {'mobile' | 'web' | 'vertical' | 'shared' | 'platform' | 'other'}
 */
export function workspaceKind(dir) {
  if (dir === 'apps/mobile') return 'mobile'
  if (dir === 'apps/web') return 'web'
  if (dir.startsWith('packages/')) return tierOf(dir.slice('packages/'.length))
  return 'other'
}

/**
 * The sanctioned package names of a parsed census document.
 * @param {any} census the parsed tools/exports-walls.json
 * @returns {Set<string>}
 */
export function sanctionedOf(census) {
  const list = Array.isArray(census?.sanctioned) ? census.sanctioned : []
  return new Set(list.map((e) => e?.package).filter((p) => typeof p === 'string'))
}

/**
 * The project census's entries (#160). Absent is EMPTY, as the corpus's project.json is: a
 * register nobody has written sanctions nothing. A file that does not parse, or carries no
 * `entries` array, is an `error`, which the boundaries gate prints and reds on: the file can
 * widen the mobile wall, so it never fails open into a silent empty list.
 * @returns {{ entries: unknown[], error: string | null }}
 */
export function readProjectCensus() {
  if (!existsSync(PROJECT_CENSUS)) return { entries: [], error: null }
  let doc
  try {
    doc = JSON.parse(readFileSync(PROJECT_CENSUS, 'utf8'))
  } catch (e) {
    return {
      entries: [],
      error: `${PROJECT_CENSUS} is not valid JSON (${e.message}) — the census must be reviewable data`,
    }
  }
  if (!Array.isArray(doc?.entries)) {
    return {
      entries: [],
      error: `${PROJECT_CENSUS} must carry an "entries" ARRAY of {package, reason} entries`,
    }
  }
  return { entries: doc.entries, error: null }
}

/** @param {unknown} entry @returns {entry is { package: string, reason: string }} */
const wellShaped = (entry) =>
  entry !== null &&
  typeof entry === 'object' &&
  typeof (/** @type {any} */ (entry).package) === 'string' &&
  typeof (/** @type {any} */ (entry).reason) === 'string' &&
  /** @type {any} */ (entry).reason.trim().length > 0

/**
 * The package names the project census sanctions: its well-shaped entries only. An entry the
 * gate reds for its scope (not a vertical, a repeat) still counts here, because the gate reds
 * it in the same step and a red tree is no tree a home is printed for.
 * @param {unknown[]} entries readProjectCensus().entries
 * @returns {Set<string>}
 */
export function projectSanctionedOf(entries) {
  return new Set(entries.filter(wellShaped).map((e) => e.package))
}

/**
 * The closed shape of the project census (#160), one finding per violation: every entry is
 * {package, reason} with a non-empty reason, names a package under packages/verticals/, is
 * not already in the owned census, and appears once.
 * @param {unknown[]} entries readProjectCensus().entries
 * @param {Set<string>} owned the owned census's sanctioned names (sanctionedOf)
 * @param {Set<string>} verticals the names declared by packages under packages/verticals/
 * @returns {string[]}
 */
export function projectCensusProblems(entries, owned, verticals) {
  const problems = []
  const seen = new Set()
  for (const entry of entries) {
    if (!wellShaped(entry)) {
      problems.push(
        `${PROJECT_CENSUS}: every entry must be {"package": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
      continue
    }
    const name = entry.package
    if (seen.has(name)) {
      problems.push(
        `${PROJECT_CENSUS} lists ${name} more than once — one entry per package, so one reason is the one reviewed`,
      )
      continue
    }
    seen.add(name)
    if (owned.has(name)) {
      problems.push(
        `${PROJECT_CENSUS} sanctions ${name}, which ${CENSUS} already sanctions — the owned census holds the harness's own packages, so delete the project entry; two entries are two reasons, and only one of them is reviewed with the harness`,
      )
    } else if (!verticals.has(name)) {
      problems.push(
        `${PROJECT_CENSUS} sanctions ${name}, but no package under packages/verticals/ declares that name — only packages/verticals/* may be sanctioned here; a platform or shared package's ./client is a security review of the harness's own wall, made in ${CENSUS}. Remove the entry, or fix its name`,
      )
    }
  }
  return problems
}

/**
 * The census as the sweep reads it: the owned half unioned with the project half's well-shaped
 * entries. Absent or unreadable is EMPTY, which can only make a home less legal (the
 * boundaries gate is what reds a broken census, in its own words).
 * @returns {Set<string>}
 */
export function readCensus() {
  let owned = new Set()
  if (existsSync(CENSUS)) {
    try {
      owned = sanctionedOf(JSON.parse(readFileSync(CENSUS, 'utf8')))
    } catch {
      // unreadable: empty, as above
    }
  }
  return new Set([...owned, ...projectSanctionedOf(readProjectCensus().entries)])
}

/**
 * Whether a workspace may take a runtime dependency on a package. Returns null when it may,
 * or the id of the law that forbids it:
 *   `mobile-api-runtime`  apps/mobile → @app/api (type-only, a devDependency)
 *   `mobile-web-only`     apps/mobile → the DOM design system
 *   `mobile-unsanctioned` apps/mobile → a package neither in the census nor universal
 *   `web-native-ds`       apps/web → @app/design-system-native
 *   `vertical-vertical`   a vertical → another vertical
 *   `shared-vertical`     a shared package → a vertical
 * A dependency on itself is never forbidden.
 * @param {{ name: string, kind: string }} from the depending workspace
 * @param {{ name: string, tier: string }} to the package depended on
 * @param {Set<string>} census sanctioned package names (sanctionedOf, readCensus)
 * @returns {string | null}
 */
export function mayDepend(from, to, census) {
  if (from.name === to.name) return null
  if (from.kind === 'mobile') {
    if (to.name === '@app/api') return 'mobile-api-runtime'
    if (WEB_ONLY.has(to.name)) return 'mobile-web-only'
    if (!census.has(to.name) && !MOBILE_UNIVERSAL.has(to.name)) return 'mobile-unsanctioned'
    return null
  }
  if (from.kind === 'web' && to.name === '@app/design-system-native') return 'web-native-ds'
  if (to.tier === 'vertical' && from.kind === 'vertical') return 'vertical-vertical'
  if (to.tier === 'vertical' && from.kind === 'shared') return 'shared-vertical'
  return null
}
