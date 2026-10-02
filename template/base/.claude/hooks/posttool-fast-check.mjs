#!/usr/bin/env node
// PostToolUse / matcher: Edit|Write|MultiEdit — tight-loop single-file feedback.
// NON-BLOCKING (exit 0): Biome --write on the single changed file only. Heavy checks
// (tsc -b, eslint, knip, depcruise, the test runners) live on the Stop gate / CI so
// the edit loop stays fast.
// SOURCE: docs/harness/README.md (PostToolUse fast single-file feedback)
import { execFileSync } from 'node:child_process'
import process from 'node:process'
// A NAMESPACE import (1.0.4): `recordHookEvent` is new, and an install may run this hook over
// a forked lib/hookio.mjs that `update` parked. A named import of an export that file lacks
// fails at link time, which launch.mjs turns into exit 2; through the namespace it is just
// undefined, and the guarded call below records nothing.
import * as hookio from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '1.1.0'

const input = await hookio.readHookInput()
const ti = input?.tool_input ?? {}
const file = String(ti.file_path ?? ti.path ?? '')

if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/.test(file)) process.exit(0)

try {
  execFileSync(
    'pnpm',
    ['exec', 'biome', 'check', '--write', '--no-errors-on-unmatched', '--colors=off', file],
    {
      stdio: 'pipe',
    },
  )
} catch (e) {
  // Surface Biome's notes but never block: the Stop gate is authoritative.
  process.stderr.write(`${(e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')}\n`)
  // Telemetry (1.0.4): only a run that EXITED non-zero is a warning. A spawn failure (no
  // pnpm, no biome) has no exit status and records nothing.
  if (typeof e.status === 'number' && e.status !== 0) {
    hookio.recordHookEvent?.({ hook: 'posttool-fast-check', rule: 'biome', input }, 'warn')
  }
}
process.exit(0)
