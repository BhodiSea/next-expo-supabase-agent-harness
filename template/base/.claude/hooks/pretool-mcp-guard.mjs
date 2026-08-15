#!/usr/bin/env node
// PreToolUse / matcher: mcp__.* — the containment for MCP tool calls.
//
// WHY THIS HOOK EXISTS. docs/security/approved-tools.md has said "Default deny. No MCP
// server or Skill runs on this codebase unless it is listed below" since 0.1.0. Until
// 0.3.0 that was prose with nothing behind it: the PreToolUse matchers were literally
// "Bash" and "Edit|Write|MultiEdit", so an `mcp__` tool call matched no hook at all. A
// Supabase MCP `apply_migration` or `execute_sql` reached the database with no guard in
// its path, no write-guard SQL content rule judging the statement, no migration file for
// check-migrations to see, and no line in the PR diff — three enforcement layers stepped
// over by one tool call, and every gate still green afterwards, because none of them was
// looking.
//
// The registry is DATA (tools/approved-tools.json), not prose, so the doc becomes the
// rendered view of the thing the machine reads. This hook fails closed on every
// ambiguity: no registry, unparseable registry, mis-shaped registry, unparseable tool
// name. A guard that cannot read its policy approves nothing.
//
// SOURCE: docs/security/approved-tools.md (default-deny registry; least privilege)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.11.1'

const REGISTRY = 'tools/approved-tools.json'
const DOC = 'docs/security/approved-tools.md'

// Dynamic import AFTER hookio installed its fail-closed handlers, for the same reason
// the other two guards do it: a missing or mis-shaped rules module must BLOCK.
let rules
try {
  rules = await import('./lib/guard-rules.mjs')
} catch (err) {
  process.stderr.write(
    `HOOK CRASHED (guard-rules import) — failing closed, action blocked: ${err?.stack ?? err}\n`,
  )
  process.exit(2)
}
const { MCP_RULES } = rules
if (!Array.isArray(MCP_RULES) || MCP_RULES.length === 0) {
  process.stderr.write(
    'HOOK CRASHED (guard-rules shape) — failing closed, action blocked: MCP_RULES missing or empty\n',
  )
  process.exit(2)
}

const input = await readHookInput()
const toolName = String(input?.tool_name ?? '')

// The matcher is `mcp__.*`, but a hook must never trust its own wiring: if this fires on
// something that is not an MCP tool call, there is nothing here to judge and no reason to
// block ordinary work.
if (!toolName.startsWith('mcp__')) pass()

// `mcp__<server>__<tool>`. The server segment cannot itself contain `__`, so split on the
// FIRST separator after the prefix and treat the remainder as the tool name — a tool named
// `get__thing` must not silently reparse into a different server.
const rest = toolName.slice('mcp__'.length)
const sep = rest.indexOf('__')
if (sep <= 0 || sep + 2 >= rest.length) {
  denyTool(
    'PreToolUse',
    `unparseable MCP tool name ${JSON.stringify(toolName)} — expected mcp__<server>__<tool>. The guard cannot decide which registry row governs this call, so it blocks: a containment that guesses is not a containment. SOURCE: ${DOC}`,
  )
}
const server = rest.slice(0, sep)
const tool = rest.slice(sep + 2)

// The registry lives at the project root. CLAUDE_PROJECT_DIR is guaranteed for hook
// subprocesses; cwd is the fallback for a direct invocation (the contract tests).
const root = (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()).replaceAll('\\', '/')
const registryPath = join(root, REGISTRY)

// A one-edit remedy, printed with the call's own values already filled in. Risk stated in
// the release plan and worth repeating here: a deny message that leaves the user guessing
// teaches HARNESS_ALLOW_SELF_EDIT habits, which is the worst thing a guard can teach.
const remedy = (why) =>
  `${why}

  The registry is ${REGISTRY} (write-guard-protected — a human edit, deliberately). To approve this call, add:

    { "server": ${JSON.stringify(server)}, "version": "<pin>", "readOnly": true,
      "reason": "<why this codebase needs it>", "tools": [${JSON.stringify(tool)}] }

  ("tools": ["*"] admits the whole server; readOnly stays in force either way.)
  Then add the matching row to ${DOC} — the docs-sync gate holds the two in lockstep.
  Vet before approving: MCP servers run with your privileges and can be steered by prompt
  injection, so read what it does, pin the version, and re-review on every bump.
  SOURCE: ${DOC} (default-deny; vet before approve; re-review on version bump)`

if (!existsSync(registryPath)) {
  denyTool(
    'PreToolUse',
    remedy(
      `${REGISTRY} is missing, so no MCP server is approved on this install and mcp__${server}__${tool} is denied by default. This gate FAILS CLOSED: an absent registry is not an empty policy, it is no policy.`,
    ),
  )
}

let registry
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'))
} catch (err) {
  denyTool(
    'PreToolUse',
    `${REGISTRY} is not valid JSON (${err?.message ?? err}) — it is write-guard-protected, so an unparseable registry is tampering, not a configuration state. Restore it from git history. SOURCE: ${DOC}`,
  )
}

const servers = registry?.servers
if (!Array.isArray(servers)) {
  denyTool(
    'PreToolUse',
    `${REGISTRY} has no \`servers\` array — the registry is mis-shaped and the guard cannot judge any call against it. Restore it from git history. SOURCE: ${DOC}`,
  )
}

const row = servers.find((s) => s?.server === server)
if (row === undefined) {
  denyTool(
    'PreToolUse',
    remedy(
      `MCP server ${JSON.stringify(server)} is not in the approved registry, so mcp__${server}__${tool} is denied (default-deny).`,
    ),
  )
}

// A row that admits nothing is a row that was half-written; treat it as unapproved rather
// than as a silent full grant.
const allowed = Array.isArray(row.tools) ? row.tools : []
if (allowed.length === 0) {
  denyTool(
    'PreToolUse',
    remedy(
      `${REGISTRY} registers server ${JSON.stringify(server)} but lists no tools for it, so nothing on it is approved.`,
    ),
  )
}
const wildcard = allowed.includes('*')
if (!wildcard && !allowed.includes(tool)) {
  denyTool(
    'PreToolUse',
    remedy(
      `server ${JSON.stringify(server)} is approved, but tool ${JSON.stringify(tool)} is not on its list (${allowed.map((t) => JSON.stringify(t)).join(', ')}).`,
    ),
  )
}

// readOnly is judged INDEPENDENTLY of the tools list, and deliberately so: a row that
// admits a write-shaped tool on a readOnly server contradicts itself, and a guard that
// picked a side would pick the permissive one.
if (row.readOnly !== false) {
  for (const rule of MCP_RULES) {
    if (rule.re.test(tool)) {
      denyTool('PreToolUse', `mcp__${server}__${tool}: ${rule.message} SOURCE: ${DOC}`)
    }
  }
}

pass()
