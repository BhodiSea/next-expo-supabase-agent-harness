#!/usr/bin/env node
// PostToolUse / matcher: Edit|Write|MultiEdit — flag non-trivial decision sites that
// lack a // SOURCE: (or -- SOURCE: in SQL) provenance comment. Blocking (exit 2):
// stderr is fed to the model. Only scans files edited this turn; skips tests,
// generated modules, JSON (cannot carry comments — config/installer decisions are
// documented in ADRs instead), and harness tooling.
//
// The heuristic (decision patterns, file scoping, 3-line SOURCE window) is imported
// from tools/lib/provenance-rules.mjs — the SAME module tools/check-sources.mjs runs
// tree-wide, so per-edit and CI can never disagree. This hook stays presence-only and
// fast; resolvability rigor (corpus ids, URL/path existence) lives in the gate.
// DELIBERATE ASYMMETRY: the gate's semantic checks — corpus decision-group match and
// the bare-URL host allowlist (tools/lib/citation-domains.mjs) — do NOT run here.
// Both may be version-RAMPED via rampNote on older installs, and a hook can only
// block (exit 2) or pass — it has no NOTE channel, so enforcing them per edit would
// hard-block installs the gate deliberately keeps green. The group-match additionally
// needs the corpus loaded, which a per-edit hook never does.
// SOURCE: docs/harness/README.md (posttool-source-check; provenance)
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.7.0'

// Dynamic import AFTER hookio has installed its fail-closed handlers: a missing or
// broken rules module must BLOCK (exit 2), not exit 1 as a non-blocking load error.
let rules
try {
  rules = await import('../../tools/lib/provenance-rules.mjs')
} catch (err) {
  process.stderr.write(
    `HOOK CRASHED (provenance-rules import) — failing closed, action blocked: ${err?.stack ?? err}\n`,
  )
  process.exit(2)
}
const { findUncitedDecisionSites, hookScansFile } = rules

const input = await readHookInput()
const file = String(input?.tool_input?.file_path ?? input?.tool_input?.path ?? '')
if (!hookScansFile(file)) process.exit(0)

let src = ''
try {
  src = readFileSync(file, 'utf8')
} catch {
  process.exit(0)
}

const flagged = findUncitedDecisionSites(src).map((f) => `${file}:${f.line}  ${f.excerpt}`)
if (flagged.length) {
  process.stderr.write(
    `Provenance gate: the following decision sites lack an inline \`// SOURCE:\` (\`-- SOURCE:\` in SQL) citation.\nAdd \`SOURCE: <authoritative URL or doc id>\` on/above each, then re-run /verify-citations:\n${flagged.join('\n')}\n`,
  )
  process.exit(2)
}
process.exit(0)
