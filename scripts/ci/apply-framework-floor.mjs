#!/usr/bin/env node
// Do to a scaffold's catalog exactly what `version-sync`'s FIX line tells a consumer to do:
// raise any pin that sits below the reviewed security floor for its major line.
//
// WHY THE UPGRADE LANE NEEDS THIS, and why it is not a new consumer mechanism. 0.5.0 ships
// tools/framework-floor.json OWNED, so `update` refreshes it into every existing install —
// that is the point, a new advisory has to reach trees that already exist. But
// pnpm-workspace.yaml is SEEDED, so `update` cannot raise the pin the floor now demands.
// The consumer therefore upgrades and finds step 11 red, holding a precise instruction:
// package, resolved version, floor, the CVE ids, and "bump the catalog pin and commit the
// lockfile". That is the correct consumer experience — a security gate reporting a real
// vulnerability is not a defect to be smoothed over.
//
// It does break something, though, and that is what this script is for. Leg A of
// scripts/ci/upgrade-lane.sh asserts the PREVIOUS release upgrades to a GREEN chain, and it
// is the only leg that reaches `graduate`'s success branch. Left alone, every floor bump
// from now on reds leg A — so the one leg proving the unbroken path would be permanently
// red for the most ordinary reason there is, and the release after that would start reading
// its red as normal. The lane applies the documented remedy instead, exactly as it already
// applies parked dependency obligations, and the chain then judges the remedied tree.
//
// NOT a `dependencyObligations` record. That mechanism asks "is this pin PRESENT", which is
// the wrong question for a bump — `next` is already in the catalog at a vulnerable version,
// so the obligation would read as met. Teaching it version comparison would also mean a
// hand-written migrations record for every future advisory, which is a floor that only
// moves when somebody remembers to write it down twice.
//
// Usage: node scripts/ci/apply-framework-floor.mjs <scaffold-dir>
// SOURCE: template/base/tools/lib/framework-floor.mjs · scripts/ci/upgrade-lane.sh
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '../../template/base/tools/lib/framework-floor.mjs'

const scaffold = process.argv[2]
if (scaffold === undefined || scaffold === '') {
  console.error('usage: node scripts/ci/apply-framework-floor.mjs <scaffold-dir>')
  process.exit(2)
}

const floorPath = join(scaffold, 'tools/framework-floor.json')
const yamlPath = join(scaffold, 'pnpm-workspace.yaml')
if (!existsSync(floorPath) || !existsSync(yamlPath)) {
  // A baseline older than the floor legitimately has neither. Say so and change nothing —
  // inventing a file here would make the lane test a tree no consumer will ever have.
  console.log('  framework floor: not present on this baseline — nothing to apply')
  process.exit(0)
}

const floor = JSON.parse(readFileSync(floorPath, 'utf8'))
let yaml = readFileSync(yamlPath, 'utf8')
const raised = []

for (const [name, entry] of Object.entries(floor.packages ?? {})) {
  // The catalog line for this package, capturing the pin so the comment after it survives.
  const line = new RegExp(`^(\\s{2,}'?${name}'?\\s*:\\s*)([^\\s#]+)(.*)$`, 'm')
  const m = line.exec(yaml)
  if (m === null) continue
  const pinned = m[2]
  const bare = pinned.replace(/^[\^~>=<\s]+/, '')
  const major = bare.split('.')[0]
  const min = entry.minPatchByMajor?.[major]
  // No floor for THIS major line is a deliberate state, not an omission to paper over:
  // the floor is keyed by major precisely so a consumer on a patched older line is left
  // alone. Raising them onto a line nobody reviewed would be the opposite of the point.
  if (min === undefined || compareVersions(bare, min) >= 0) continue
  yaml = yaml.replace(line, `$1${min}$3`)
  raised.push(`${name} ${bare} -> ${min}`)
}

if (raised.length === 0) {
  console.log('  framework floor: every pin already at or above the reviewed floor')
  process.exit(0)
}

writeFileSync(yamlPath, yaml)
for (const r of raised) console.log(`  raised to the security floor: ${r}`)
