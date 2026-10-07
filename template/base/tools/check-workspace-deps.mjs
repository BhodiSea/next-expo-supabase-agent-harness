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
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { applyAnatomyAllow, scanVerticalAnatomy } from './lib/vertical-anatomy.mjs'
import { mayDepend, sanctionedOf, tierOf } from './lib/workspace-tiers.mjs'

const GATE = 'boundaries'
const CENSUS = 'tools/exports-walls.json'
const PACKAGES_DIR = 'packages'

// The tiers, the mobile wall's universally-importable kernel and the law ids live in
// lib/workspace-tiers.mjs (2.1.0), which the duplication gate's sweep reads too: one copy of
// the walls, so a home the sweep prints is one this gate admits.

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
const sanctioned = sanctionedOf(census)
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
const target = (dep) => ({ name: dep, tier: pkgs.get(dep)?.tier ?? 'other' })

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
    const law = mayDepend({ name: 'apps/mobile', kind: 'mobile' }, target(dep), sanctioned)
    if (law === 'mobile-api-runtime') {
      errs.push(
        '@app/api is a RUNTIME dependency of apps/mobile — it must be a devDependency imported `import type` only; Metro does not tree-shake, so a value import pulls the server graph into the native binary',
      )
    } else if (law === 'mobile-web-only') {
      errs.push(
        `${dep} is web-only (DOM) but is a dependency of apps/mobile — remove it; the mobile design system is @app/design-system-native`,
      )
    } else if (law === 'mobile-unsanctioned') {
      errs.push(
        `${dep} is a dependency of apps/mobile but is neither sanctioned in ${CENSUS} nor universally-importable — a package absent from the census is one the mobile bundle may not carry; route the call through the API, or (if it has a Metro-safe ./client) hand a human the reviewed {package, reason} entry: the census is harness-owned and hash-pinned, so an agent does not edit it, and the human adds the entry under the security owners' review (CODEOWNERS) and re-records the file's sha256 in .harness/manifest.json in the same reviewed commit (docs/runbooks/harness-upgrade.md, "Forking an owned file")`,
      )
    }
  }
}

// 4. apps/web must not carry the mobile-only design system.
const web = readApp('web')
if (web !== null) {
  for (const dep of web.deps) {
    if (mayDepend({ name: 'apps/web', kind: 'web' }, target(dep), sanctioned) === 'web-native-ds') {
      errs.push(
        `@app/design-system-native is RN-only but is a dependency of apps/web — a DOM tree renders nothing from it; web uses @app/design-system`,
      )
    }
  }
}

// 2 & 3. verticals ⊥ verticals; shared ↛ verticals.
for (const [name, { tier, deps }] of pkgs) {
  for (const dep of deps) {
    const law = mayDepend({ name, kind: tier }, target(dep), sanctioned)
    if (law === 'vertical-vertical') {
      errs.push(
        `${name} (a vertical) depends on ${dep} (another vertical) — verticals never import each other; lift shared code into packages/shared or call through the API`,
      )
    } else if (law === 'shared-vertical') {
      errs.push(
        `${name} (shared) depends on ${dep} (a vertical) — shared code is importable BY verticals, never the reverse`,
      )
    }
  }
}

// 5. (0.9.5; behavior-keyed since 1.0.0) Vertical anatomy + intra-vertical layering —
// the worked pattern as law. The laws and their rationale live in
// lib/vertical-anatomy.mjs; the escape is the reviewed tools/vertical-anatomy-allow.json
// (seeded, closed both ways — a stale entry reds). TWO ramps, partitioned by the
// finding's vintage: what the 0.9.5 directory keying already produced stays on the
// armed 0.9.5 ramp (register row boundaries-vertical-anatomy-ramp-expiry — expired, so
// hard for every real install), and what only the 1.0.0 behavior keying sees rides its
// own ramp until 1.1.0 (register row boundaries-anatomy-widening-ramp-expiry — expired
// at 1.1.0, so hard for every real install too) — a vertical that satisfied the
// directory keying got one release of dated NOTEs on the widened demand, never a hard
// red on the update that delivered it. The allow-file shape/staleness problems and the
// anti-vacuity floor are NEVER ramped — a broken reviewed file or an empty scan is not a
// debt an old install grows out of.
const ANATOMY_ALLOW = 'tools/vertical-anatomy-allow.json'
const anatomy = scanVerticalAnatomy()
if (anatomy.verticals === 0) {
  console.log(
    `${GATE}: NOTE — no packages/verticals/* yet; the anatomy laws arm with the first vertical`,
  )
} else if (anatomy.filesScanned === 0) {
  fail(
    GATE,
    `vertical anatomy scanned ZERO files across ${anatomy.verticals} vertical(s) — a scan that sees nothing proves nothing (anti-vacuity); every vertical needs at least its two barrels`,
  )
}
let allowDoc = null
if (existsSync(ANATOMY_ALLOW)) {
  try {
    allowDoc = JSON.parse(readFileSync(ANATOMY_ALLOW, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ANATOMY_ALLOW} is not valid JSON (${e.message}) — the escape must be reviewable data`,
    )
  }
}
const anatomyVerdict = applyAnatomyAllow(anatomy.findings, allowDoc)
errs.push(...anatomyVerdict.problems)
for (const e of anatomyVerdict.stale) {
  errs.push(
    `${ANATOMY_ALLOW} entry (${e.package} ${e.law}${e.path ? ` ${e.path}` : ''}) matches NO live finding — a stale escape is a standing hole nobody reviews; delete the entry`,
  )
}
const anatomyMsg = (f) => `anatomy: ${f.package} [${f.law}] ${f.path} — ${f.detail}`
const legacyFindings = anatomyVerdict.remaining.filter((f) => f.vintage !== '1.0.0')
const widenedFindings = anatomyVerdict.remaining.filter((f) => f.vintage === '1.0.0')
if (legacyFindings.length > 0) {
  const msgs = legacyFindings.map(anatomyMsg)
  if (
    rampNote(GATE, '0.9.5', `${String(msgs.length)} vertical-anatomy finding(s)`, {
      until: '0.10.0',
    })
  ) {
    for (const m of msgs) console.log(`${GATE}: NOTE — ${m}`)
  } else {
    errs.push(...msgs)
  }
}
if (widenedFindings.length > 0) {
  if (
    rampNote(GATE, '1.0.0', 'the behavior-keyed widening of the vertical-anatomy DAL laws', {
      until: '1.1.0',
    })
  ) {
    for (const f of widenedFindings) console.log(`${GATE}: NOTE — ${anatomyMsg(f)}`)
  } else {
    errs.push(...widenedFindings.map(anatomyMsg))
  }
}

failures(
  GATE,
  errs,
  `The allow-matrix derives from ${CENSUS} + the universally-importable kernel; fix the mis-tiered dependency, don't widen the matrix.`,
)
ok(
  GATE,
  `workspace deps: ${pkgs.size} package(s) tiered clean${mobile ? `; apps/mobile carries ${mobile.deps.length} sanctioned @app dep(s)` : ''}${anatomy.verticals > 0 ? `; ${anatomy.verticals} vertical(s) anatomy-clean (${anatomy.filesScanned} file(s))` : ''}`,
)
