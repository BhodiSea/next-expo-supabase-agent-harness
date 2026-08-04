#!/usr/bin/env node
// Stop hook — the unbreakable gate. Runs the full validate gate and exits 2 with errors
// on stderr until green, so the turn cannot end on a red build. Loop-guarded by
// stop_hook_active; bounded by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (settings env).
// SOURCE: docs/harness/README.md (stop-validate-gate)
import { execSync } from 'node:child_process'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.2.0'

const input = await readHookInput()
const looping = input?.stop_hook_active === true

// Gate steps live in the project's harness config (tools/harness.config.mjs exports
// STOP_HOOK_STEPS: Array<[name, command]>), so projects extend the gate — e.g. add a
// perf-budget check — without editing this hook (which is itself a harness-protected
// file). Resolved relative to this hook: ../../ is the project root.
//
// If the config cannot be loaded, the fallback is the HARDCODED direct-invocation
// list — NEVER `pnpm validate`: package.json is not write-guard-protected, so a
// script-name fallback would be exactly the script-indirection tamper hole the
// config documents. A broken config additionally BLOCKS the turn even when the
// fallback chain is green — the config is write-guard-protected, so a human must
// restore it; an agent must not keep working on top of a mangled gate.
// SOURCE: docs/harness/README.md (stop-validate-gate; tamper evidence)
const FALLBACK_STEPS = [
  ['validate', 'node tools/validate.mjs --report-all'],
  ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  ['unit', 'pnpm exec vitest run --coverage --silent'],
  ['mobile-unit', 'pnpm --filter mobile exec jest --coverage --silent'],
]
let STEPS = FALLBACK_STEPS
let configBroken = null
try {
  const { STOP_HOOK_STEPS } = await import(
    new URL('../../tools/harness.config.mjs', import.meta.url).href
  )
  if (Array.isArray(STOP_HOOK_STEPS) && STOP_HOOK_STEPS.length > 0) {
    STEPS = STOP_HOOK_STEPS
  } else {
    configBroken = 'tools/harness.config.mjs did not export a non-empty STOP_HOOK_STEPS array'
  }
} catch (e) {
  configBroken = `could not load tools/harness.config.mjs (${e?.message ?? e})`
}

const failures = []
const skips = []
for (const [name, cmd] of STEPS) {
  try {
    // 64 MB: bundler export output + tsc diagnostics + docker compose logs can
    // exceed the 1 MB default and make execSync throw ENOBUFS on an otherwise-green
    // step (false FAIL). HARNESS_STOP_GATE=1 tells fail-closed-capable runners
    // (tests/rls/run-rls.mjs) that THIS run is the proof — a skip is not acceptable.
    const out = execSync(cmd, {
      env: { ...process.env, HARNESS_STOP_GATE: '1' },
      maxBuffer: 64 * 1024 * 1024,
      stdio: 'pipe',
    })
    for (const line of out.toString().split('\n')) {
      if (/\bSKIPPED\b/.test(line)) skips.push(`[${name}] ${line.trim()}`)
    }
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    failures.push(`### ${name} FAILED (${cmd})\n${out.slice(-4000)}`)
  }
}

if (configBroken) {
  failures.push(
    `### gate-config BROKEN\n${configBroken}\nThe fallback chain ran (direct invocation), but the turn is blocked until tools/harness.config.mjs is restored — it is write-guard-protected, so restore it from git (a human sets HARNESS_ALLOW_SELF_EDIT=1 if needed).`,
  )
}

if (failures.length === 0) {
  // Green — but never let a loud skip masquerade as silence: surface any
  // skipped layers so the transcript records what did NOT run.
  if (skips.length > 0) {
    process.stderr.write(`stop-validate-gate: green with skipped layers:\n${skips.join('\n')}\n`)
  }
  process.exit(0)
}

const header = looping
  ? 'The validate gate is STILL red after a prior continuation. Fix the root cause below; do not stop until `pnpm validate` is green.\n\n'
  : 'Done means GREEN GATE. The turn cannot end with a red build. Fix every failure below, then the gate re-runs automatically.\n\n'
const skipNote = skips.length > 0 ? `\n\nSkipped layers (did NOT run):\n${skips.join('\n')}\n` : ''
process.stderr.write(header + failures.join('\n\n') + skipNote)
process.exit(2)
