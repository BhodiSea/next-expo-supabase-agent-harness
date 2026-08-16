#!/usr/bin/env node
// Gate: boundaries (part 1 of 2) — the `./client` census wall.
//
// tools/exports-walls.json is the SINGLE census of packages permitted a `./client`
// subpath export. `.` is the server barrel ("use server" leaves, service-role clients,
// Next-coupled imports); `./client` is the Metro-safe one. Metro does not tree-shake, so
// a `./client` added casually to a package holding elevated writes puts the server graph
// one import away from the native binary. This gate is the enforcement the census exists
// for: every package that ships a `./client` export key MUST carry a sanctioned entry
// (with a non-empty reason) in the census — and, two-way, every census entry must name a
// package that actually exists, so a stale sanction cannot quietly widen the wall.
//
// `sanctioned` is MAY, not MUST: a listed package that currently ships only `.` is fine
// (that is the pre-authorised case — @app/observability, @app/design-tokens). The failure
// runs the other way, and that is the only thing this gate reds on.
// SOURCE: docs/harness/README.md (boundaries gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'boundaries'
const CENSUS = 'tools/exports-walls.json'
const MODULES_FILE = 'tools/modules.json'
const PACKAGES_DIR = 'packages'

if (!existsSync(CENSUS)) skipOrFail(GATE, `${CENSUS} not found (no census surface yet)`)
if (!existsSync(PACKAGES_DIR)) skipOrFail(GATE, `${PACKAGES_DIR}/ not found (no workspace yet)`)

// The shipped module list (1.0.0) — OWNED, so it arrives in the same release as
// this line and its absence is a broken tree, not a consumer choice: fail closed
// naming the fix. A census entry's `module` value is closed against it below;
// until this file existed the value was validated only as a non-empty string, so
// a typo'd name parked the stale arm permanently dormant (the discharged
// register row exports-walls-module-name-validation).
let moduleRegister = null
try {
  moduleRegister = JSON.parse(readFileSync(MODULES_FILE, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${MODULES_FILE} is missing or not valid JSON (${e.message}) — it is harness-OWNED and ships with this release; restore it with \`npx next-expo-supabase-agent-harness update\` (or from git history), never by hand`,
  )
}
const isNameArray = (a) => Array.isArray(a) && a.every((m) => typeof m === 'string' && m !== '')
if (!isNameArray(moduleRegister.modules) || !isNameArray(moduleRegister.retired)) {
  fail(
    GATE,
    `${MODULES_FILE} must carry "modules" and "retired" arrays of non-empty strings — a malformed module list cannot close the census`,
  )
}
const knownModules = new Set(moduleRegister.modules)
const retiredModules = new Set(moduleRegister.retired)

// The census — the ONE file that can DISABLE this wall, so its parse fails LOUD.
let census
try {
  census = JSON.parse(readFileSync(CENSUS, 'utf8'))
} catch (e) {
  fail(GATE, `${CENSUS} is not valid JSON (${e.message}) — the census must be reviewable data`)
}
if (!Array.isArray(census.sanctioned)) {
  fail(GATE, `${CENSUS} must carry a "sanctioned" ARRAY of {package, reason} entries`)
}
const sanctioned = new Map()
for (const entry of census.sanctioned) {
  const okShape =
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.package === 'string' &&
    typeof entry.reason === 'string' &&
    entry.reason.trim().length > 0
  if (!okShape) {
    fail(
      GATE,
      `${CENSUS}: every sanction must be {"package": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
    )
  }
  // Optional `module` (0.9.5): names the opt-in module that provides the package.
  // Validated when present — an empty or non-string value would silently make the
  // stale arm dormant forever, which is the failure mode this whole file exists
  // to refuse.
  if (
    entry.module !== undefined &&
    (typeof entry.module !== 'string' || entry.module.trim() === '')
  ) {
    fail(
      GATE,
      `${CENSUS}: sanction for ${entry.package} carries a "module" that is not a non-empty string — it names the opt-in module providing the package, and a blank value would disable the stale check silently`,
    )
  }
  sanctioned.set(entry.package, entry)
}

// The module-name closure (1.0.0): a `module` value must name a module this
// release actually ships. The census is SEEDED, so a pre-1.0.0 tree may carry a
// typo'd name it was never told about — those findings ramp; a fresh or 1.0.0+
// tree reds hard.
const moduleNameProblems = []
for (const entry of census.sanctioned) {
  if (typeof entry.module !== 'string' || knownModules.has(entry.module)) continue
  moduleNameProblems.push(
    retiredModules.has(entry.module)
      ? `${CENSUS}: sanction for ${entry.package} names module '${entry.module}', which this release RETIRED — the module is gone, so the entry can never leave dormancy; remove the sanction or migrate the package`
      : `${CENSUS}: sanction for ${entry.package} names module '${entry.module}', which no release of this harness ships (${MODULES_FILE}) — a name the module-state check can never match parks the stale arm dormant forever, which is the silent widening it exists to prevent; fix the name or remove the sanction`,
  )
}

// Every package manifest under packages/, its name and whether it ships a `./client` key.
const declared = new Map() // package name -> { hasClient: boolean }
for (const rel of walkFiles(PACKAGES_DIR, { filter: (p) => /(^|\/)package\.json$/.test(p) })) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(`${PACKAGES_DIR}/${rel}`, 'utf8'))
  } catch {
    continue // a non-manifest package.json is not this gate's concern
  }
  if (typeof pkg.name !== 'string') continue
  const hasClient = Boolean(
    pkg.exports !== null && typeof pkg.exports === 'object' && pkg.exports['./client'],
  )
  declared.set(pkg.name, { hasClient })
}

const errs = []

if (moduleNameProblems.length > 0) {
  if (
    rampNote(GATE, '1.0.0', 'the census module-name closure over the shipped module list', {
      until: '1.1.0',
    })
  ) {
    for (const m of moduleNameProblems) console.log(`${GATE}: NOTE — ${m}`)
  } else {
    errs.push(...moduleNameProblems)
  }
}

// 1. Every package shipping `./client` must be sanctioned.
for (const [name, { hasClient }] of declared) {
  if (hasClient && !sanctioned.has(name)) {
    errs.push(
      `${name} exports a "./client" barrel but is NOT sanctioned in ${CENSUS} — a Metro-safe barrel on a package that may hold a server graph is how the service-role reaches the native bundle; add a reviewed {package, reason} entry, or remove the "./client" key`,
    )
  }
}

// 2. Two-way: a sanction naming a package that does not exist is stale — it silently
//    widens the wall for a future package of that name.
//
//    MODULE-PROVIDED PACKAGES (0.9.5). An entry may declare `"module": "<name>"`,
//    meaning the package it names ships with an OPT-IN module. The stale arm then
//    applies only when that module is ENABLED (read from .harness/manifest.json):
//    with the module off, its package is legitimately absent and the entry is
//    dormant, not stale. Without the declaration a module package could not be
//    censused at all — the entry would red every install that skipped the module,
//    which is a gate punishing a consumer for a choice the harness offered them.
//    Unknown module state (no manifest — the template dev tree, gate fixtures)
//    reads as DORMANT, and that is a deliberate, bounded fail-open: this arm is
//    hygiene, and the security-critical direction is arm 1 above (a `./client`
//    barrel with no sanction), which is unaffected by module state.
const enabledModules = new Set(
  (() => {
    try {
      const m = JSON.parse(readFileSync('.harness/manifest.json', 'utf8'))
      return Array.isArray(m.modules) ? m.modules : []
    } catch {
      return []
    }
  })(),
)
for (const [name, entry] of sanctioned) {
  if (declared.has(name)) continue
  const providedBy = typeof entry.module === 'string' ? entry.module : null
  if (providedBy !== null && !enabledModules.has(providedBy)) continue
  errs.push(
    providedBy === null
      ? `${name} is sanctioned in ${CENSUS} but no package under ${PACKAGES_DIR}/ declares that name — remove the stale sanction or add the package`
      : `${name} is sanctioned in ${CENSUS} as provided by the '${providedBy}' module, that module is ENABLED, and yet no package under ${PACKAGES_DIR}/ declares the name — the module's package is missing; re-enable the module or remove the sanction`,
  )
}

failures(
  GATE,
  errs,
  `The census is the single source the boundaries gate and the dependency-cruiser barrel rules derive from; edit ${CENSUS} ({{SECURITY_OWNERS}} review), never a per-consumer copy.`,
)
ok(
  GATE,
  `exports walls: ${declared.size} package(s), ${[...declared.values()].filter((d) => d.hasClient).length} with a sanctioned ./client barrel`,
)
