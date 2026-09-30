#!/usr/bin/env node
// PostToolUse / matcher: Edit|Write|MultiEdit — flag non-trivial decision sites that
// lack a // SOURCE: (or -- SOURCE: in SQL) provenance comment. Only scans files edited
// this turn; skips tests, generated modules, JSON (cannot carry comments —
// config/installer decisions are documented in ADRs instead), and harness tooling.
//
// TWO ANSWERS (1.1.0, #69), by the classes of the uncited sites in the file:
//   - any site in a MANDATORY class: exit 2, and stderr is fed to the model. The same
//     message lists the file's uncited ADVISORY-class sites, marked as advisory.
//   - only ADVISORY-class sites (tools/lib/provenance-rules.mjs ADVISORY_DECISION_GROUPS,
//     less any seeded promotion): exit 0 with one JSON object on stdout,
//     {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}, which
//     Claude Code adds to the model's context beside the tool result, and nothing else
//     (observed at Claude Code 2.1.285, and in the hook-output schema since 2.0.0, below
//     the required floor: design/CONTROL-PLANE-FACTS.md, Fact 18).
// A fork of the rules lib that predates the split has no isMandatorySite, and every site
// then blocks, as before.
//
// The heuristic (decision patterns, file scoping, 3-line SOURCE window) is imported
// from tools/lib/provenance-rules.mjs — the SAME module tools/check-sources.mjs runs
// tree-wide, so per-edit and CI can never disagree. This hook stays presence-only and
// fast; resolvability rigor (corpus ids, URL/path existence) lives in the gate.
// DELIBERATE ASYMMETRY: the gate's semantic checks — corpus decision-group match and
// the bare-URL host allowlist (tools/lib/citation-domains.mjs) — do NOT run here. They
// need the corpus and the tree, which a per-edit hook never loads; the gate owns them.
// SOURCE: docs/harness/README.md (posttool-source-check; provenance)
import { readFileSync } from 'node:fs'
import process from 'node:process'
// A NAMESPACE import (1.0.4): `recordHookEvent` is new, and an install may run this hook over
// a forked lib/hookio.mjs that `update` parked. A named import of an export that file lacks
// fails at link time; through the namespace it is undefined and the guarded call is a no-op.
import * as hookio from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '1.1.0'

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
const isMandatorySite =
  typeof rules.isMandatorySite === 'function' ? rules.isMandatorySite : () => true

const HOOK = 'posttool-source-check'
// Claude Code keeps an additionalContext string whole up to 10,000 characters; the list is
// capped well inside that.
const ADVISORY_LIST_MAX = 20

/** @param {string} file @param {{ line: number, excerpt: string, groups?: string[] }} f */
const advisoryLine = (file, f) => `${file}:${f.line} [${(f.groups ?? []).join(', ')}]  ${f.excerpt}`

/** @param {string} file @param {Array<{ line: number, excerpt: string, groups?: string[] }>} list */
function advisoryList(file, list) {
  const shown = list.slice(0, ADVISORY_LIST_MAX).map((f) => advisoryLine(file, f))
  if (list.length > shown.length) shown.push(`… and ${String(list.length - shown.length)} more`)
  return shown.join('\n')
}

const input = await hookio.readHookInput()
const file = String(input?.tool_input?.file_path ?? input?.tool_input?.path ?? '')
if (!hookScansFile(file)) process.exit(0)

let src = ''
try {
  src = readFileSync(file, 'utf8')
} catch {
  process.exit(0)
}

const found = findUncitedDecisionSites(src)
const mandatory = found.filter((f) => isMandatorySite(f.groups))
const advisory = found.filter((f) => !isMandatorySite(f.groups))

// Telemetry: one `advisory` event per class of each advisory finding (1.1.0), then the
// block (1.0.4) — never the file or the flagged lines.
for (const f of advisory) {
  for (const g of f.groups ?? []) {
    hookio.recordHookEvent?.({ hook: HOOK, rule: `provenance/${g}`, input }, 'advisory')
  }
}

if (mandatory.length) {
  hookio.recordHookEvent?.({ hook: HOOK, rule: 'provenance', input }, 'block')
  const flagged = mandatory.map((f) => `${file}:${f.line}  ${f.excerpt}`)
  const also = advisory.length
    ? `\nAlso uncited, in an ADVISORY class (reported, never a block on its own — cite them too):\n${advisoryList(file, advisory)}\n`
    : ''
  process.stderr.write(
    `Provenance gate: the following decision sites lack an inline \`// SOURCE:\` (\`-- SOURCE:\` in SQL) citation.\nAdd \`SOURCE: <authoritative URL or doc id>\` on/above each, then re-run /verify-citations:\n${flagged.join('\n')}\n${also}`,
  )
  process.exit(2)
}

if (advisory.length) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `Provenance (ADVISORY, not a block): ${String(advisory.length)} decision site(s) in an advisory class lack an inline \`// SOURCE:\` (\`-- SOURCE:\` in SQL) citation. ` +
          'Cite each with `SOURCE: <authoritative URL or doc id>` on/above it; the `provenance` gate reports them as ADVISORY and does not red on them:\n' +
          advisoryList(file, advisory),
      },
    }),
  )
}
process.exit(0)
