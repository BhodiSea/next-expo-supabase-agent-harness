#!/usr/bin/env node
// Stop hook — the unbreakable gate. Runs the full validate gate and exits 2 with errors
// on stderr until green, so the turn cannot end on a red build. Loop-guarded by
// stop_hook_active; bounded by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (settings env).
// SOURCE: docs/harness/README.md (stop-validate-gate)
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.5.0'

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

// ---- THE FROZEN FLOOR (0.3.0): the chain is a UNION, not a copy ----------------
// harness.config.mjs is manifest mode `config` and check-gate-integrity skips non-`owned`
// entries, so until 0.3.0 NOTHING hashed STOP_HOOK_STEPS: deleting `test-quality` or
// `diff-coverage` from the array mid-turn ended the turn green, with gate-integrity
// reporting OK because a `config` file is human-tunable by design.
//
// tools/stop.floor.json is the frozen snapshot. A step in the floor but missing from the
// config STILL RUNS. Projects may APPEND (a project-specific check is legitimate and this
// preserves it); they may not subtract.
//
// A missing or corrupt floor is a loud NOTE on stderr and the config chain runs alone —
// NOT a blocked turn. That is the deliberate trade: a corrupt floor bricking every turn on
// the machine is a worse failure than a turn whose floor could not be read, and the file
// is inside gate-integrity's hashed surface and the write-guard table, so the tamper is
// evidenced on the very next validate rather than depending on this hook to notice.
let floorNote = null
let injected = []
try {
  const floorUrl = new URL('../../tools/stop.floor.json', import.meta.url)
  const floor = JSON.parse(readFileSync(floorUrl, 'utf8'))?.steps
  const wellFormed =
    Array.isArray(floor) &&
    floor.length > 0 &&
    floor.every((s) => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'string')
  if (!wellFormed) {
    floorNote = 'tools/stop.floor.json has no well-formed `steps` array'
  } else {
    const present = new Set(STEPS.map(([name]) => name))
    injected = floor.filter(([name]) => !present.has(name))
    // Floor order first, then the config's own steps: a floor step that a weakened config
    // dropped must run where the floor puts it, and appended project steps stay last.
    if (injected.length > 0) STEPS = [...floor, ...STEPS.filter(([n]) => !floor.some(([f]) => f === n))]
  }
} catch (e) {
  floorNote = `could not read tools/stop.floor.json (${e?.message ?? e})`
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

// Floor evidence, on every run: a chain that had to be topped up from the floor, or a
// floor that could not be read, is a fact about THIS turn and belongs in the transcript
// whether the turn is green or red.
const notes = []
if (injected.length > 0) {
  notes.push(
    `stop-validate-gate: ${String(injected.length)} floor step(s) were MISSING from tools/harness.config.mjs and were run from tools/stop.floor.json anyway: ${injected.map(([n]) => n).join(', ')}. Restore them in the config — the floor is not a place to park a deleted check.`,
  )
}
if (floorNote) {
  notes.push(
    `stop-validate-gate: ${floorNote} — the config chain ran alone this turn. The floor is write-guard-protected and inside gate-integrity's hashed surface, so restore it from git; the next validate will red on it regardless.`,
  )
}
if (notes.length > 0) process.stderr.write(`${notes.join('\n')}\n`)

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
