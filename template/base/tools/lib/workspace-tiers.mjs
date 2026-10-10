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
// The laws, all derived from the ONE census (tools/exports-walls.json) plus the universally
// importable kernel below:
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

// The ONE census. When #160 splits it, this is where its project half joins the union.
const CENSUS = 'tools/exports-walls.json'

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
 * The census as the sweep reads it: absent or unreadable is EMPTY, which can only make a
 * home less legal (the boundaries gate is what reds a broken census, in its own words).
 * @returns {Set<string>}
 */
export function readCensus() {
  if (!existsSync(CENSUS)) return new Set()
  try {
    return sanctionedOf(JSON.parse(readFileSync(CENSUS, 'utf8')))
  } catch {
    return new Set()
  }
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
