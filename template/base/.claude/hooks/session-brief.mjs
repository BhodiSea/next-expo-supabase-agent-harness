#!/usr/bin/env node
// SessionStart hook — the harness brief, printed into the session's context (1.1.0).
//
// An agent that starts, resumes, clears or compacts a session learned the install's state by
// running into it. This hook prints it up front: the harness version, base and tier, the
// upgrades parked under .harness/pending/, how the last turn in this directory ended, and
// the reviewers the current diff owes. `node tools/harness-status.mjs` prints the same bytes
// for a human. Both are thin: tools/lib/harness-brief.mjs holds every rule, under the write
// guard and the gate-integrity hash.
//
// THE CONTRACT IS THE OPPOSITE OF A GUARD'S. A SessionStart hook blocks nothing: on exit 0
// its stdout is added to the context, and exit 2 only shows stderr to the user. So this hook
// exits 0 on EVERY path, prints nothing on stderr, and writes nothing (.harness/turn.lock
// included). Three consequences, each deliberate:
//   - It is invoked DIRECTLY (`node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-brief.mjs"`),
//     not through launch.mjs: the launcher reports a load failure as "failing closed, action
//     blocked" and exits 2, which would be false here. gate-integrity accepts the direct form.
//   - It does not import lib/hookio.mjs, whose handlers turn any throw into exit 2.
//   - It loads the lib with import() inside a try/catch, as the Stop hook loads
//     stop-chain.mjs, so a torn or missing lib prints one fixed line instead of a stack.
//
// IT NEVER READS STDIN. The payload's `source` and `session_id` change nothing the brief
// says: the last turn is read over every session's records, because a new session's id
// matches none of the earlier ones. Not reading it means no payload byte can reach the output.
// SOURCE: https://code.claude.com/docs/en/hooks (SessionStart: stdout on exit 0 is context)
// SOURCE: design/CONTROL-PLANE-FACTS.md (Fact 15, the SessionStart payload)
import process from 'node:process'

export const HARNESS_HOOK_VERSION = '2.0.0'

// Byte-identical to the CLI's line: the two must print the same brief on every tree.
const UNLOADABLE = 'harness brief: unavailable (tools/lib/harness-brief.mjs did not load)\n'

// Exit 0 whatever happens after this point, a failed write to a closed pipe included.
process.on('uncaughtException', () => process.exit(0))
process.on('unhandledRejection', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))

// The brief's paths are project-relative. A resume or a compaction can fire after the
// session's shell moved into a subdirectory, so read from the root every hook command names,
// which Claude Code sets for every hook subprocess.
try {
  if (process.env.CLAUDE_PROJECT_DIR) process.chdir(process.env.CLAUDE_PROJECT_DIR)
} catch {
  // A root that cannot be entered leaves the brief reading where it runs; a field it cannot
  // read there prints as unavailable.
}

let text = UNLOADABLE
try {
  const { collectBrief, renderBrief } = await import('../../tools/lib/harness-brief.mjs')
  text = renderBrief(await collectBrief())
} catch {
  // A lib that cannot load is one fixed line, never a stack trace and never a block.
}
process.stdout.write(text)
