#!/usr/bin/env node
// tools/harness-status.mjs — print the harness brief: the install's version, base and tier,
// the upgrades parked under .harness/pending/, how the last turn in this directory ended,
// and the reviewers the current diff owes. The SessionStart hook
// (.claude/hooks/session-brief.mjs) prints the same bytes into a session's context.
//
// A THIN WRAPPER, AND IT MUST STAY ONE. Every rule lives in tools/lib/harness-brief.mjs,
// which the write guard covers (`tools-lib`); this file matches no guard rule, which is
// acceptable only while it holds no logic. It reads, prints and always exits 0. Run it from
// the project root, like every tool here.
// SOURCE: docs/harness/README.md (the session-start brief)
import process from 'node:process'

// Byte-identical to the hook's line: the two must print the same brief on every tree.
const UNLOADABLE = 'harness brief: unavailable (tools/lib/harness-brief.mjs did not load)\n'

let text = UNLOADABLE
try {
  const { collectBrief, renderBrief } = await import('./lib/harness-brief.mjs')
  text = renderBrief(await collectBrief())
} catch {
  // A lib that cannot load is one fixed line, never a stack trace.
}
process.stdout.write(text)
