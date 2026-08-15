#!/usr/bin/env node
// PreToolUse / matcher: Bash|Monitor|PowerShell — deterministic block of dangerous shell +
// secret leaks. A high-value tripwire, NOT a complete sandbox: obfuscated commands can evade
// substring checks. The settings.json deny list + permission model are the primary
// control; ESLint + the write-guard enforce the same invariants in source.
//
// THE MATCHER IS THREE TOOLS (0.6.0), and each of the two additions closes a real hole:
//
//   Monitor  runs a command in the background and streams its output back. Permission RULES
//            written `Bash(...)` already cover it — "Bash(npm run *) → Bash, Monitor" — but
//            hook matchers are EXACT TOOL NAMES, not permission-rule namespaces. So through
//            0.5.0 every content check in this file was reachable-around by asking for the
//            same command under `Monitor`. Identical in kind to the `mcp__` gap 0.3.0 closed,
//            whose comment reads: "A missing entry is not a degraded posture — it is that
//            whole event unguarded."
//
//   PowerShell is worse than an alternative shell: on **Windows without Git Bash, Claude Code
//            does not register the Bash tool at all**, and the docs say so in as many words —
//            "A hook that matches only `Bash` never fires there." A `Bash`-only matcher did
//            not degrade on that platform; it was absent. PowerShell also has its OWN
//            permission-rule namespace (`PowerShell(...)`), so the settings deny list does
//            not reach it either — this hook is the only layer that does.
//
// All three deliver the command string in `tool_input.command`, so the plumbing below is
// unchanged; what changed is which tools reach it, and the rule table gained the canonical
// PowerShell verb spellings its bash-compatible aliases were already covering.
// SOURCE: https://code.claude.com/docs/en/hooks (matcher semantics; PowerShell on Windows)
// SOURCE: https://code.claude.com/docs/en/tools-reference (Bash rules apply to Bash and Monitor)
//
// The blocked-rule table lives in ./lib/guard-rules.mjs (pure data, importable in-process
// by tests) — this hook keeps only the I/O + decision plumbing. Every rule id there has a
// behavioral canary in tests/hooks/hook-contract.test.mjs (per-rule falsifiability closure).
// SOURCE: docs/harness/README.md (pretool-bash-guard)
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.11.0'

// Dynamic import AFTER hookio installed its fail-closed handlers: a missing, broken, or
// mis-shaped rules module must BLOCK (exit 2), not exit 1 as a non-blocking load error — a
// guard that cannot load its rules approves nothing.
let rules
try {
  rules = await import('./lib/guard-rules.mjs')
} catch (err) {
  process.stderr.write(
    `HOOK CRASHED (guard-rules import) — failing closed, action blocked: ${err?.stack ?? err}\n`,
  )
  process.exit(2)
}
const { BASH_RULES } = rules
if (!Array.isArray(BASH_RULES) || BASH_RULES.length === 0) {
  process.stderr.write(
    'HOOK CRASHED (guard-rules shape) — failing closed, action blocked: BASH_RULES missing or empty\n',
  )
  process.exit(2)
}

const input = await readHookInput()
const cmd = String(input?.tool_input?.command ?? '')
const selfEdit = process.env.HARNESS_ALLOW_SELF_EDIT === '1'

if (cmd) {
  // Deny on the FIRST matching rule (array order = message priority), unless the rule's
  // allowWhen predicate sanctions this specific command (e.g. a self-edit under
  // HARNESS_ALLOW_SELF_EDIT=1).
  for (const rule of BASH_RULES) {
    const hit =
      typeof rule.test === 'function'
        ? rule.test(cmd)
        : /** @type {{ re: RegExp }} */ (rule).re.test(cmd)
    if (!hit) continue
    if (rule.allowWhen?.(cmd, { selfEdit })) continue
    denyTool('PreToolUse', rule.message)
  }
}
pass()
