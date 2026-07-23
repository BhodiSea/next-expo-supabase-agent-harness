#!/usr/bin/env node
// Orchestrator behind `pnpm test:rls` and the Stop hook's `rls-isolation` step. It runs
// BOTH runtime RLS proofs against a local `supabase start` stack:
//   1. supabase/tests/*.sql (pgTAP) via `supabase test db` — the DB boundary, read back
//      from pg_catalog and exercised through request.jwt.claims + SET LOCAL ROLE.
//   2. tests/rls/*.test.ts (supabase-js) via vitest — the SAME boundary as reached
//      through PostgREST + a real GoTrue JWT, the client transport both surfaces use.
//
// Posture, matching the toolchain-asymmetry doctrine (a skip is never a pass):
//   - No supabase CLI, or the stack is down: SKIP LOUDLY on a manual/local run; FAIL
//     CLOSED under CI or the Stop hook once supabase/migrations exists — the headline
//     promise is that a turn cannot end with cross-tenant isolation UNPROVEN.
//   - Stack up: run both; either failing fails the run.
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const haveMigrations = existsSync(path.join(repoRoot, 'supabase', 'migrations'))
const underStopGate = process.env['HARNESS_STOP_GATE'] === '1'
const inCI = Boolean(process.env['CI'])

function available(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

const haveCli = available('supabase', ['--version'])
// `supabase status` exits non-zero when the local stack is not running.
const stackUp = haveCli && available('supabase', ['status'])

if (!stackUp) {
  const reason = haveCli ? 'no running supabase stack (`pnpm db:up`)' : 'supabase CLI not installed'
  if (haveMigrations && (inCI || underStopGate)) {
    console.error(
      inCI
        ? `[rls] CI with migrations present but ${reason} — failing closed`
        : `[rls] FAIL: the RLS surface exists but ${reason}, so cross-tenant isolation is UNPROVEN and the turn cannot end.\n[rls] Fix: \`pnpm db:up\` (supabase start), then re-run.`,
    )
    process.exit(1)
  }
  console.log(
    `[rls] SKIPPED — ${reason}; both runtime layers self-skip. This layer FAILS CLOSED in CI and under the Stop hook.`,
  )
  process.exit(0)
}

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, { cwd: repoRoot, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
}

// The local keys, read from `supabase status` at RUNTIME — never committed (they are
// JWT-shaped, and the hygiene gate reds a literal one).
function statusEnv() {
  const out = execFileSync('supabase', ['status', '-o', 'env'], { cwd: repoRoot, encoding: 'utf8' })
  const env = {}
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

try {
  console.log('[rls] supabase stack up — running the pgTAP suite (`supabase test db`)')
  run('supabase', ['test', 'db'])
} catch {
  console.error('[rls] pgTAP isolation suite FAILED')
  process.exit(1)
}

const s = statusEnv()
try {
  console.log('[rls] running the supabase-js client suite (vitest)')
  run('pnpm', ['exec', 'vitest', 'run', 'tests/rls'], {
    RLS_SUITE_READY: '1',
    SUPABASE_URL: s['API_URL'] ?? '',
    SUPABASE_ANON_KEY: s['ANON_KEY'] ?? '',
    SUPABASE_SERVICE_ROLE_KEY: s['SERVICE_ROLE_KEY'] ?? '',
  })
} catch {
  console.error('[rls] client isolation suite FAILED')
  process.exit(1)
}

console.log('[rls] OK — both runtime layers green')
process.exit(0)
