// Shared Node-only hook I/O. No jq, no bash. Reads the hook JSON from stdin.
// SOURCE: docs/harness/README.md (.claude/hooks/lib/hookio.mjs)
import { appendFileSync, existsSync } from 'node:fs'
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

// ---- THE TELEMETRY LOG (1.0.4) ------------------------------------------------------
// `.harness/telemetry.jsonl`: append-only and NEVER trimmed, one JSON record per Stop step
// and per in-turn hook event (a guard deny, a source-check block, a source-check advisory
// finding per class since 1.1.0, a fast-check warning, a SubagentStop bounce). The turn
// ledger keeps its last 200 rows and records only THAT a turn blocked; this records what
// each step cost and which rule fired, so a red that was fixed inside the same turn still
// leaves a trace.
//
// CWD-RELATIVE, like everything else under `.harness/` (stop-validate-gate.mjs states the
// rule), and written ONLY when `.harness/manifest.json` is present there — the one file every
// install has. The factory runs these hooks from its own root and with `template/base/` as
// cwd; neither has a manifest, and a file written under `template/base/` would ship.
//
// BOOKKEEPING NEVER DECIDES AN OUTCOME. Every error is swallowed and nothing is printed: a
// PreToolUse deny's JSON IS this process's stdout, and the fail-closed handlers above turn any
// escaping error into exit 2. A record that cannot be written changes no exit code and no
// stdout byte. Records hold enumerated values, ids, timestamps and counts — never file
// content, command text, paths or messages — and no gate reads the file.
// SOURCE: docs/harness/README.md (stop-validate-gate; the telemetry log)
const TELEMETRY_LOG = '.harness/telemetry.jsonl'
const INSTALL_MANIFEST = '.harness/manifest.json'

/**
 * Append records to the telemetry log, inside an install only. Never throws, never prints.
 *
 * Hooks reach this (and recordHookEvent) through a NAMESPACE import and a guarded call:
 * `update` parks rather than replaces a forked hookio.mjs, and a static named import of an
 * export the older file lacks fails at LINK time, which launch.mjs turns into exit 2 for
 * every hook.
 * @param {object[]} records
 */
export function appendTelemetry(records) {
  try {
    if (!Array.isArray(records) || records.length === 0) return
    if (!existsSync(INSTALL_MANIFEST)) return
    appendFileSync(TELEMETRY_LOG, records.map((r) => `${JSON.stringify(r)}\n`).join(''))
  } catch {
    // a log that cannot be written changes nothing about the outcome
  }
}

/** A payload field copied only when it is a string, else null. @param {unknown} v */
const idOrNull = (v) => (typeof v === 'string' ? v : null)

/**
 * One in-turn hook event. From the payload it takes ONLY `session_id`, `prompt_id` and
 * `tool_name`, and each only when it is a string.
 * @param {{ hook: string, rule: string, input?: unknown }} meta
 * @param {'deny' | 'block' | 'warn' | 'bounce' | 'advisory'} outcome
 */
export function recordHookEvent(meta, outcome) {
  try {
    const raw = meta?.input
    /** @type {Record<string, unknown>} */
    const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
    appendTelemetry([
      {
        v: 1,
        kind: 'hook-event',
        at: new Date().toISOString(),
        session_id: idOrNull(input.session_id),
        prompt_id: idOrNull(input.prompt_id),
        hook: idOrNull(meta?.hook),
        tool: idOrNull(input.tool_name),
        rule: idOrNull(meta?.rule),
        outcome,
      },
    ])
  } catch {
    // same contract as appendTelemetry: bookkeeping never decides the outcome
  }
}

// PreToolUse structured deny (exit 0 + JSON). Blocks the call and attaches a
// machine-readable reason the model can act on. The optional `meta` ({hook, rule, input},
// 1.0.4) records the deny in the telemetry log BEFORE the deny is written; without it
// nothing is recorded. An older hookio that predates it ignores a third argument, which is
// why this is an argument and not a new export.
export function denyTool(event, reason, meta) {
  if (meta !== undefined) recordHookEvent(meta, 'deny')
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
