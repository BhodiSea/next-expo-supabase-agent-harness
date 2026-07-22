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
import process from 'node:process'
import { fail } from './lib/gate.mjs'
import { changedFiles, firstLine } from './lib/git-diff.mjs'
import { isCritical } from './lib/mutation-critical.mjs'

const GATE = 'mutation-scope'

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

const critical = changed.filter(isCritical).sort()
if (critical.length > 0) process.stdout.write(critical.join(','))
