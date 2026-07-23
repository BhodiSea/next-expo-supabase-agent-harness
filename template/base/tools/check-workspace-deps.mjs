#!/usr/bin/env node
// Gate: boundaries (part 2 of 2) — the declared-dependency allow-matrix.
//
// The tsc `exports` walls and the dependency-cruiser fitness function work at the
// import graph; this one works at the package.json DEPENDENCY level, which catches a
// mis-tiered dependency BEFORE a single import is written (and a declared-but-unused
// dependency the import graph never sees). Four laws, all derived from the ONE census
// (tools/exports-walls.json) plus the universally-importable kernel:
//
//   1. The mobile import wall. apps/mobile may take a runtime @app/* dependency only if
//      it is sanctioned in the census (a Metro-safe surface) OR is one of the pure
//      universally-importable packages the census deliberately omits (the error/event
//      kernel and the wire contracts, which have no server half to protect, plus the
//      mobile-only design system). @app/api is import-type-only: it must be a
//      devDependency, never a runtime one, or its server graph rides the native binary.
//   2. verticals ⊥ verticals — a feature domain never depends on another; shared code
//      goes in packages/shared, cross-feature calls go through the API.
//   3. shared ↛ verticals — shared code is importable BY verticals, never the reverse.
//   4. apps/web ↛ the mobile-only design system (@app/design-system-native paints RN
//      views; a DOM tree renders nothing from it).
// SOURCE: docs/harness/README.md (boundaries gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'boundaries'
const CENSUS = 'tools/exports-walls.json'
const PACKAGES_DIR = 'packages'

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

if (!existsSync(CENSUS)) skipOrFail(GATE, `${CENSUS} not found (no census surface yet)`)
if (!existsSync(PACKAGES_DIR)) skipOrFail(GATE, `${PACKAGES_DIR}/ not found (no workspace yet)`)

let census
try {
  census = JSON.parse(readFileSync(CENSUS, 'utf8'))
} catch (e) {
  fail(GATE, `${CENSUS} is not valid JSON (${e.message}) — the census must be reviewable data`)
}
if (!Array.isArray(census.sanctioned)) {
  fail(GATE, `${CENSUS} must carry a "sanctioned" ARRAY of {package, reason} entries`)
}
const sanctioned = new Set(
  census.sanctioned.map((e) => e?.package).filter((p) => typeof p === 'string'),
)

// tier from the manifest's directory: packages/verticals/* / shared/* / platform/* / …
function tierOf(rel) {
  if (/^verticals\//.test(rel)) return 'vertical'
  if (/^shared\//.test(rel)) return 'shared'
  if (/^platform\//.test(rel)) return 'platform'
  return 'other'
}
const appDeps = (pkg, key) => Object.keys(pkg[key] ?? {}).filter((k) => k.startsWith('@app/'))

// Inventory every workspace package: name -> { tier, deps, devDeps }.
const pkgs = new Map()
for (const rel of walkFiles(PACKAGES_DIR, { filter: (p) => /(^|\/)package\.json$/.test(p) })) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(`${PACKAGES_DIR}/${rel}`, 'utf8'))
  } catch {
    continue
  }
  if (typeof pkg.name !== 'string') continue
  pkgs.set(pkg.name, {
    tier: tierOf(rel),
    deps: appDeps(pkg, 'dependencies'),
    devDeps: appDeps(pkg, 'devDependencies'),
  })
}
const verticalNames = new Set([...pkgs].filter(([, m]) => m.tier === 'vertical').map(([n]) => n))

function readApp(dir) {
  const p = `apps/${dir}/package.json`
  if (!existsSync(p)) return null
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf8'))
    return { deps: appDeps(pkg, 'dependencies'), devDeps: appDeps(pkg, 'devDependencies') }
  } catch {
    return null
  }
}

const errs = []

// 1. The mobile import wall.
const mobile = readApp('mobile')
if (mobile !== null) {
  for (const dep of mobile.deps) {
    if (dep === '@app/api') {
      errs.push(
        '@app/api is a RUNTIME dependency of apps/mobile — it must be a devDependency imported `import type` only; Metro does not tree-shake, so a value import pulls the server graph into the native binary',
      )
    } else if (WEB_ONLY.has(dep)) {
      errs.push(
        `${dep} is web-only (DOM) but is a dependency of apps/mobile — remove it; the mobile design system is @app/design-system-native`,
      )
    } else if (!sanctioned.has(dep) && !MOBILE_UNIVERSAL.has(dep)) {
      errs.push(
        `${dep} is a dependency of apps/mobile but is neither sanctioned in ${CENSUS} nor universally-importable — a package absent from the census is one the mobile bundle may not carry; add a reviewed census entry (if it has a Metro-safe ./client) or route the call through the API`,
      )
    }
  }
}

// 4. apps/web must not carry the mobile-only design system.
const web = readApp('web')
if (web !== null) {
  for (const dep of web.deps) {
    if (MOBILE_UNIVERSAL.has(dep) && dep === '@app/design-system-native') {
      errs.push(
        `@app/design-system-native is RN-only but is a dependency of apps/web — a DOM tree renders nothing from it; web uses @app/design-system`,
      )
    }
  }
}

// 2 & 3. verticals ⊥ verticals; shared ↛ verticals.
for (const [name, { tier, deps }] of pkgs) {
  if (tier === 'vertical') {
    for (const dep of deps) {
      if (dep !== name && verticalNames.has(dep)) {
        errs.push(
          `${name} (a vertical) depends on ${dep} (another vertical) — verticals never import each other; lift shared code into packages/shared or call through the API`,
        )
      }
    }
  }
  if (tier === 'shared') {
    for (const dep of deps) {
      if (verticalNames.has(dep)) {
        errs.push(
          `${name} (shared) depends on ${dep} (a vertical) — shared code is importable BY verticals, never the reverse`,
        )
      }
    }
  }
}

failures(
  GATE,
  errs,
  `The allow-matrix derives from ${CENSUS} + the universally-importable kernel; fix the mis-tiered dependency, don't widen the matrix.`,
)
ok(
  GATE,
  `workspace deps: ${pkgs.size} package(s) tiered clean${mobile ? `; apps/mobile carries ${mobile.deps.length} sanctioned @app dep(s)` : ''}`,
)
