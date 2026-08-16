#!/usr/bin/env node
// launch.mjs — the fail-closed hook LAUNCHER, and deliberately almost nothing else.
//
// THE HOLE THIS CLOSES (CONTROL-PLANE-FACTS Fact 12, probed 2026-08-10 and re-probed
// 2026-08-15, identical): the fail-closed guarantee lives inside lib/hookio.mjs — its
// uncaughtException/unhandledRejection -> exit(2) handlers — and those install only
// after the module LOADS. Damage that prevents the load (a torn file, a 0-byte file, a
// deletion) exits 1, which Claude Code's exit-code contract reads as NON-BLOCKING: one
// torn library file disarmed all three PreToolUse guards, both PostToolUse hooks and
// the Stop chain at once, silently. This wrapper is the load-side twin of hookio's
// handlers: it import()s the real hook, and a hook that cannot LOAD becomes exit 2.
//
// IMPORTS NOTHING and never touches stdin — the wrapped hook reads process.stdin
// itself, in-process, exactly as before; a launcher that consumed the payload would
// starve every hook it wraps. The one argument is validated as a sibling hook filename
// (never a path), so this cannot be steered into importing arbitrary code.
//
// THE HONEST RESIDUAL, stated where the fix lives: a torn launch.mjs ITSELF still
// fails open — the class cannot be closed from inside the process it disarms. What
// this ships is a shrink of the fail-open surface from every hook and library file to
// ONE tiny file with no imports, no parse-fragile content, under the write-guard deny
// and the gate-integrity hash like its siblings, re-probed at every Claude Code pin
// bump per CONTROL-PLANE-FACTS.
export const HARNESS_HOOK_VERSION = '1.0.0'

const name = process.argv[2] ?? ''
if (!/^[a-z][a-z-]*\.mjs$/.test(name) || name === 'launch.mjs') {
  process.stderr.write(
    `launch.mjs: refusing to launch ${JSON.stringify(name)} — the argument must be a sibling hook filename (a bare <name>.mjs, never a path). A launcher that can be pointed anywhere is an arbitrary-import primitive, so this fails CLOSED.\n`,
  )
  process.exit(2)
}

try {
  await import(new URL(name, import.meta.url).href)
} catch (e) {
  process.stderr.write(
    `launch.mjs: the hook ${name} FAILED TO LOAD (${e instanceof Error ? e.message : String(e)}) — failing closed, action blocked. A hook that cannot load is a guard that is not there: restore .claude/hooks/ from git history or run \`npx next-expo-supabase-agent-harness update --rollback\`; see docs/runbooks/harness-upgrade.md (RECOVERY).\n`,
  )
  process.exit(2)
}
