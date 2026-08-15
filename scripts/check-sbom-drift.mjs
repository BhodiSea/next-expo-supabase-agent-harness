#!/usr/bin/env node
// check-sbom-drift — the SBOM consumed as a RELEASE-OVER-RELEASE DIFF.
//
// THE AMBIGUITY THIS FILE EXISTS TO RESOLVE, stated first because the register row warned
// that a reader would close the wrong control. 0.10.0 shipped `tools/check-sbom.mjs`, which
// closes the emitted component set against `pnpm-lock.yaml` in BOTH directions — a resolved
// package with no component means the inventory under-reports the tree, a component no
// lockfile entry resolves means the artefact describes a DIFFERENT tree. That is a
// completeness check against the SAME tree, and it catches nothing about supply-chain drift.
//
// This is the other sense of "consumed": THIS tree's resolved component set against the
// PREVIOUS RELEASE TAG's, redding on an ADDED component that no reviewed row allows. A
// dependency nobody chose is how a supply chain moves, and a diff nobody reads is how it
// moves unobserved.
//
// WHY THE FACTORY'S OWN LOCKFILE. The subject is the machinery this repo ships — the
// installer runs on Node built-ins alone, but the tree carries a devDependency closure that
// every maintainer executes and every release is cut from. `check-dependency-channel.mjs`
// already diffs the template CATALOG (what a CONSUMER resolves) and asks a different
// question: does a gained key reach an existing install. Neither sees a TRANSITIVE addition,
// which is exactly the class a component diff catches and a key diff cannot.
//
// WHAT A FIRST RUN LOOKS LIKE, so nobody reads a clean line as a broken check: at the release
// that introduces this gate the previous tag's lockfile is read at v0.10.0 and the expected
// finding count is ZERO. A gate whose first run finds nothing is only meaningful if it CAN
// find something, which is what tests/gates/check-sbom-drift.test.mjs establishes.
//
//   usage: node scripts/check-sbom-drift.mjs [repo-root]
// SOURCE: template/base/tools/lib/sbom.mjs (lockPackageKeys, purlForLockKey)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { lockPackageKeys, purlForLockKey } from '../template/base/tools/lib/sbom.mjs'
import { highestReleaseBelow } from './lib/ramp-sites.mjs'

// With a repo-root argument it judges THAT tree — files AND git history, so the red-proof can
// present a tagged fixture repo.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const inCI = () => process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

const ALLOWLIST = 'scripts/sbom-additions.json'
// The fleet is never smaller than this. Every assertion below is a filter over the current
// component set, so a parse that yielded nothing would report a clean diff — the exact false
// green the whole file is about. Mirrors check-ramp-ledger's own anti-vacuity floor.
const VACUITY_FLOOR = 100

const version = JSON.parse(read('package.json')).version
const problems = []

/** The purl set a lockfile text resolves to. */
const purls = (lockText) => new Set(lockPackageKeys(lockText).map(purlForLockKey))

const current = purls(read('pnpm-lock.yaml'))
if (current.size < VACUITY_FLOOR) {
  problems.push(
    `only ${String(current.size)} component(s) resolved from pnpm-lock.yaml — the machinery closure is larger than that at every release, so the lockfile parse is broken and the diff below would pass vacuously`,
  )
}

let allow
try {
  allow = JSON.parse(read(ALLOWLIST))
} catch (e) {
  problems.push(`${ALLOWLIST} is unreadable (${String(e.message).slice(0, 160)}) — a diff with no reviewed allowlist fails closed rather than allowing everything`)
  allow = { additions: [] }
}
const rows = Array.isArray(allow?.additions) ? allow.additions : []
for (const [i, r] of rows.entries()) {
  const at = `${ALLOWLIST}#additions[${String(i)}]`
  if (typeof r?.purl !== 'string' || !r.purl.startsWith('pkg:npm/')) {
    problems.push(`${at}: 'purl' must be a pkg:npm/… string — the diff compares purls, so any other spelling silently allows nothing`)
  }
  if (typeof r?.reason !== 'string' || r.reason.length < 40) {
    problems.push(`${at}: needs a substantive 'reason' (>= 40 chars) saying WHY this component arriving is acceptable — an allowlist row with no argument is a mute button`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(r?.release ?? ''))) {
    problems.push(`${at}: needs the 'release' it was reviewed for (x.y.z) — rows are judged against the release that added them, so an undated row can never be retired`)
  }
}
const allowed = new Set(rows.filter((r) => typeof r?.purl === 'string').map((r) => r.purl))

const previousTag = (() => {
  try {
    return highestReleaseBelow(git(['tag', '--list', 'v*.*.*']).split('\n'), version)
  } catch {
    return null
  }
})()

let summary
if (previousTag === null) {
  const msg = `no v*.*.* tag strictly below ${version} is reachable, so there is no previous release to diff against. This needs full history (fetch-depth: 0).`
  if (inCI()) problems.push(`${msg} A skip is not allowed in CI.`)
  else summary = `SKIPPED — ${msg} (FAILS CLOSED in CI)`
} else {
  try {
    const before = purls(git(['show', `${previousTag}:pnpm-lock.yaml`]))
    if (before.size < VACUITY_FLOOR) {
      problems.push(
        `only ${String(before.size)} component(s) recovered from ${previousTag} — the closure was larger than that at every release, so the previous-tree read is broken and every component would read as ADDED (or none would)`,
      )
    }
    const added = [...current].filter((p) => !before.has(p)).sort()
    const removed = [...before].filter((p) => !current.has(p)).sort()
    for (const purl of added) {
      if (allowed.has(purl)) continue
      problems.push(
        `${purl} is in this tree's resolved components and was NOT in ${previousTag} — an ADDED component with no reviewed row in ${ALLOWLIST}. Add a row stating why it arrived (a direct bump, a transitive of a bump, a new tool), or remove it. A dependency nobody chose is how a supply chain moves.`,
      )
    }
    // The stale direction, scoped to THIS release's rows only: a row reviewed for an earlier
    // release describes a component that is now in BOTH trees and is no longer an addition,
    // which is correct rather than stale. A row claiming THIS release must match a real one.
    for (const r of rows.filter((x) => x?.release === version)) {
      if (!added.includes(r.purl)) {
        problems.push(
          `${ALLOWLIST}: '${String(r.purl)}' is reviewed for release ${version} but is not an addition in this diff vs ${previousTag} — either it was already present (the row allows nothing) or it is gone (the row outlived its subject). Retire it.`,
        )
      }
    }
    summary = `vs ${previousTag}: ${String(current.size)} component(s), ${String(added.length)} added, ${String(removed.length)} removed, ${String(rows.length)} reviewed row(s)`
  } catch (e) {
    const msg = `reading ${previousTag}:pnpm-lock.yaml failed (shallow clone, or the tag object is absent): ${String(e.message).slice(0, 160)}`
    if (inCI()) problems.push(`${msg} A skip is not allowed in CI.`)
    else summary = `SKIPPED — ${msg} (FAILS CLOSED in CI)`
  }
}

if (problems.length > 0) {
  console.error(`SBOM DRIFT: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nAn inventory that is only checked against its own tree proves the inventory is complete. Checking it against the PREVIOUS RELEASE is what makes it evidence about the supply chain.',
  )
  console.error('FIX[sbom-drift]: reproduce with `node scripts/check-sbom-drift.mjs`')
  process.exit(1)
}
console.log(`SBOM DRIFT: CLEAN (${summary ?? 'no diff computed'})`)
