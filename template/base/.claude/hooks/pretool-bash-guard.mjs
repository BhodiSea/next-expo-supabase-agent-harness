#!/usr/bin/env node
// PreToolUse / matcher: Bash — deterministic block of dangerous shell + secret leaks.
// A high-value tripwire, NOT a complete sandbox: obfuscated commands can evade
// substring checks. The settings.json deny list + permission model are the primary
// control; ESLint + the write-guard enforce the same invariants in source.
//
// The blocked-rule table lives in ./lib/guard-rules.mjs (pure data, importable in-process
// by tests) — this hook keeps only the I/O + decision plumbing. Every rule id there has a
// behavioral canary in tests/hooks/hook-contract.test.mjs (per-rule falsifiability closure).
// SOURCE: docs/harness/README.md (pretool-bash-guard)
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.2.0'

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
