#!/usr/bin/env node
// The PR mutation lane's diff scoper: prints the CRITICAL source files this change touches,
// comma-separated, for `stryker run --mutate <list>`. Prints nothing when the change touches
// none — the lane then skips, and a PR that only edits docs or a React component pays zero
// mutation time.
//
// StrykerJS has NO git-diff scoping of its own (the diff flags other ecosystems' mutation
// tools ship do not exist here), and
// Stryker's `--incremental` is a RESULT CACHE (it reuses a stored report), not a diff scope —
// depending on it in CI would mean depending on a cache that misses. So the scope is computed
// here, explicitly, and handed to `--mutate`. That is also what keeps the ratchet honest: the
// report's file set is exactly the set we chose, so the ratchet's file-scoped comparison
// (tools/check-mutation-ratchet.mjs) knows precisely which baseline entries are in play.
//
// FILE granularity, not line ranges. Stryker can mutate `file.ts:10-25`, which would be even
// cheaper — but then a partially-mutated file's OTHER baseline survivors would be absent from
// the report and the ratchet would read them as "killed" and offer to erase them. Whole-file
// scoping keeps the report a complete statement about every file in it.
// SOURCE: docs/harness/gates-catalog.md (mutation-ratchet) [corpus: harness/doctrine]
import { existsSync } from 'node:fs'
import process from 'node:process'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail } from './lib/gate.mjs'
import { changedFiles, firstLine } from './lib/git-diff.mjs'
import { FLOOR_ROOTS, isCritical, loadExtraRoots, rootMatches } from './lib/mutation-critical.mjs'

const GATE = 'mutation-scope'

// The additive half (1.0.0) — seeded {root, why} rows union'd onto the floor.
// Loading fails closed: a scoper that shrugged off a missing register would
// report "nothing extra to mutate" in exactly the tone of an honest empty file.
let extraRoots
try {
  extraRoots = loadExtraRoots()
} catch (e) {
  fail(GATE, firstLine(e))
}

// The zero-match drift alarm (1.0.0, the mutation-scope-seeded-split discharge).
// Anti-vacuity, never ramped: every CONCRETE floor root must match at least one
// .ts file in the tree — a tree whose structure diverged from the exemplar paths
// used to silently mutate less than the lane claimed, and silence is the defect.
// Starred floor roots are exempt with the reason stated (a tree may legitimately
// hold zero verticals; the boundaries gate owns that story). Every EXTRA root
// must match too — the both-ways register discipline: a root matching nothing is
// a stale claim of coverage.
const WALK_EXCLUDES = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
const rootHasFiles = (root) => {
  const dir = root.split('*')[0].replace(/\/$/, '')
  if (!existsSync(dir)) return false
  return walkFiles(dir, { excludeDirs: WALK_EXCLUDES }).some(
    (rel) => rel.endsWith('.ts') && rootMatches(`${dir}/${rel}`, root),
  )
}
const drift = []
for (const root of FLOOR_ROOTS) {
  if (root.includes('*')) continue
  if (!rootHasFiles(root)) {
    drift.push(
      `floor root ${root} matches ZERO .ts files — the mutation floor assumes the scaffold structure, and a tree that moved it mutates less than the lane claims; restore the path or record the move as a reviewed tools/mutation-scope-extra.json root alongside a harness issue`,
    )
  }
}
for (const e of extraRoots) {
  if (!rootHasFiles(e.root)) {
    drift.push(
      `extra root ${e.root} matches ZERO .ts files — a stale row claims coverage the lane does not deliver; fix the path or delete the row`,
    )
  }
}
if (drift.length > 0) fail(GATE, drift.join('\n'))

let changed
try {
  changed = changedFiles()
} catch (e) {
  // Fail closed. A scoper that cannot see the diff would print an empty list, and an empty
  // list looks exactly like "this PR touched nothing critical" — a silent, permanent pass.
  fail(
    GATE,
    `cannot enumerate changed files (${firstLine(e)}) — the mutation lane refuses to run against an unknown diff. In CI this is usually a shallow checkout: set fetch-depth: 0.`,
  )
}

const critical = changed.filter((f) => isCritical(f, extraRoots)).sort()
if (critical.length > 0) process.stdout.write(critical.join(','))
