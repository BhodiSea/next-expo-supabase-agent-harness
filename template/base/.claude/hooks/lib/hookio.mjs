// Shared Node-only hook I/O. No jq, no bash. Reads the hook JSON from stdin.
// SOURCE: docs/harness/README.md (.claude/hooks/lib/hookio.mjs)
import process from 'node:process'

// Fail closed: a guard that crashes must BLOCK, not silently wave the action
// through. Without these handlers a thrown error exits 1, which Claude Code
// treats as a non-blocking hook error — i.e. a crashed write-guard would let
// the write proceed. Exit 2 is the documented blocking code for every hook
// event this harness uses (PreToolUse deny, PostToolUse feedback, Stop).
// SOURCE: docs/harness/README.md (hooks fail closed)
function failClosed(kind) {
  return (err) => {
    process.stderr.write(
      `HOOK CRASHED (${kind}) — failing closed, action blocked: ${err?.stack ?? err}\n`,
    )
    process.exit(2)
  }
}
process.on('uncaughtException', failClosed('uncaughtException'))
process.on('unhandledRejection', failClosed('unhandledRejection'))

export async function readHookInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  // Malformed (non-empty, unparseable) input is a broken harness or an
  // attempt to confuse a guard — throw so the fail-closed handler blocks.
  return JSON.parse(raw)
}

// Block the current action: stderr is fed back to the model, exit 2.
/**
 * @public hookio API surface — exercised via a generated fixture in
 * tests/hooks/hookio-failclosed.test.mjs (string-built dynamic import that
 * static dead-export analysis cannot see).
 */
export function block(reason) {
  process.stderr.write(`${String(reason)}\n`)
  process.exit(2)
}

// PreToolUse structured deny (exit 0 + JSON). Blocks the call and attaches a
// machine-readable reason the model can act on.
export function denyTool(event, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

// No decision; normal flow continues.
export function pass() {
  process.exit(0)
}
