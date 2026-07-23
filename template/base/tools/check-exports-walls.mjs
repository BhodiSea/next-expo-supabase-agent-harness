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
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'boundaries'
const CENSUS = 'tools/exports-walls.json'
const PACKAGES_DIR = 'packages'

if (!existsSync(CENSUS)) skipOrFail(GATE, `${CENSUS} not found (no census surface yet)`)
if (!existsSync(PACKAGES_DIR)) skipOrFail(GATE, `${PACKAGES_DIR}/ not found (no workspace yet)`)

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
  sanctioned.set(entry.package, entry.reason)
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
for (const name of sanctioned.keys()) {
  if (!declared.has(name)) {
    errs.push(
      `${name} is sanctioned in ${CENSUS} but no package under ${PACKAGES_DIR}/ declares that name — remove the stale sanction or add the package`,
    )
  }
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
