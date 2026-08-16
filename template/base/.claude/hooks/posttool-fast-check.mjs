#!/usr/bin/env node
// PostToolUse / matcher: Edit|Write|MultiEdit — tight-loop single-file feedback.
// NON-BLOCKING (exit 0): Biome --write on the single changed file only. Heavy checks
// (tsc -b, eslint, knip, depcruise, the test runners) live on the Stop gate / CI so
// the edit loop stays fast.
// SOURCE: docs/harness/README.md (PostToolUse fast single-file feedback)
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '1.0.0'

const input = await readHookInput()
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
}
process.exit(0)
