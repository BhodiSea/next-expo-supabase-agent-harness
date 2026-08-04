#!/usr/bin/env node
// FACTORY dogfood: write-protect the harness's OWN enforcement surface.
//
// The shipped write-guard cannot be shimmed the way the bash guard is, because its whole
// subject is PATHS and in this repo the paths are different: a consumer's `tools/` is this
// repo's `template/base/tools/`, and a consumer has no `scripts/` or `installer/` at all.
// So this file reuses the shipped I/O plumbing (hookio's fail-closed contract, the same
// deny shape) and supplies the one thing that legitimately differs — the path table.
//
// WHAT IT PROTECTS, and why each entry earns its place:
//
//   template/base/tools/**            the gate scripts every consumer runs
//   template/base/.claude/hooks/**    the guards themselves, including the rule table
//   scripts/**                        the factory's own closure checks (canary coverage,
//                                     claims, rule integrity) — the checks that catch a
//                                     weakened gate are exactly what a weakened gate
//                                     would want edited first
//   installer/lib/**                  what actually lands in a consumer's repo
//   .github/workflows/**              the CI backstop the tamper-evidence story leans on
//   tests/canary/injections.json      the red-proof registry. Deleting a row here is how
//                                     a gate stops being falsifiable while every count
//                                     still adds up
//
// It is DELIBERATELY NOT a copy of the shipped content rules (the SQL checks, the secret
// shapes, the WITH RECURSIVE ban). Those judge application code; this repo has none. What
// it judges is "am I about to edit the thing that does the judging", and the answer being
// yes is not a refusal — it is a request for `HARNESS_ALLOW_SELF_EDIT=1`, which is how
// every other layer spells human-in-the-loop.
//
// THIS FILE BLOCKS MAINTENANCE TURNS THE MOMENT IT LANDS. That is the feature, not a side
// effect: a blocked maintainer turn means a consumer would have been blocked too, so a bug
// in the shipped guard shows up here first, on the machine of the person who can fix it.
// SOURCE: docs/harness/README.md (tamper evidence; the factory eats its own dog food)
import { denyTool, pass, readHookInput } from '../../template/base/.claude/hooks/lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.3'

const PROTECTED = [
  /^template\/base\/tools\//,
  /^template\/base\/\.claude\/hooks\//,
  /^scripts\//,
  /^installer\/lib\//,
  /^\.github\/workflows\//,
  /^tests\/canary\/injections\.json$/,
  // This directory: the shim, this guard, the Stop chain, and the settings file that
  // wires all three. An agent that could edit `.claude/settings.json` could remove its
  // own Stop gate — the shipped guard protects a consumer's copy for exactly that reason,
  // and the factory's copy has strictly more to lose because it also configures the
  // dogfood. Editing it is possible and expected; it just has to be deliberate.
  /^\.claude\//,
]

const input = await readHookInput()
const raw = String(input?.tool_input?.file_path ?? '')
if (raw === '') pass()

// Repo-relative, POSIX. An absolute path from the tool is normalized against the project
// dir so `/Users/…/scripts/hygiene.mjs` and `scripts/hygiene.mjs` are the same subject.
const root = (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()).split('\\').join('/')
const posix = raw.split('\\').join('/')
const rel = posix.startsWith(root) ? posix.slice(root.length).replace(/^\/+/, '') : posix

if (process.env.HARNESS_ALLOW_SELF_EDIT !== '1' && PROTECTED.some((re) => re.test(rel))) {
  denyTool(
    'PreToolUse',
    `Blocked: ${rel} is the harness's own enforcement surface (gate scripts, guard hooks, factory closure checks, installer library, CI workflows, the canary registry). Editing it is a human-in-the-loop act — re-run with HARNESS_ALLOW_SELF_EDIT=1 so the change is deliberate and lands in the PR diff. This is the same rule the harness ships to consumers, applied to the harness.`,
  )
}
pass()
