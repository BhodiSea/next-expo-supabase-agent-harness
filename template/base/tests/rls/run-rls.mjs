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
//   - Stack up and nothing either suite reads has changed since the last green run: print
//     `rls-isolation: STAMPED — …` and run neither (1.0.4, below). Never in CI.
//
// WHICH CLI (1.0.4). The Stop hook starts this file with plain `node` and the session's
// PATH, so through 1.0.3 a bare `supabase` here was whichever one the machine had first, or
// none, while `pnpm test:rls` and CI ran the catalog-pinned copy in node_modules/.bin.
// tools/lib/supabase-cli.mjs puts that copy first when it is installed (never on Windows,
// where .bin holds .cmd shims), every spawn below uses its environment, and the run names
// the CLI it used. The rule above, for when to skip and when to fail, is unchanged.
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { inCI as requiresToolchains, stampGate } from '../../tools/lib/gate.mjs'
import { STAMP_INPUTS } from '../../tools/lib/stamp-inputs.mjs'
import { supabaseCli } from '../../tools/lib/supabase-cli.mjs'

const GATE = 'rls-isolation'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const haveMigrations = existsSync(path.join(repoRoot, 'supabase', 'migrations'))
const underStopGate = process.env['HARNESS_STOP_GATE'] === '1'
const inCI = Boolean(process.env['CI'])
const cli = supabaseCli(repoRoot, process.env, process.platform)

function available(cmd, args) {
  try {
    execFileSync(cmd, args, { env: cli.env, stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

// The version doubles as the "is there a CLI" probe, and it salts the stamp below. null
// means no CLI answered.
function cliVersion() {
  try {
    const out = execFileSync('supabase', ['--version'], {
      env: cli.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    })
    return out.trim().split('\n')[0] ?? ''
  } catch {
    return null
  }
}

const version = cliVersion()
const haveCli = version !== null
if (haveCli) {
  // Never the word the Stop hook collects skip lines by: this line is printed on every run.
  const where =
    cli.source === 'workspace'
      ? `${path.relative(repoRoot, cli.bin).split(path.sep).join('/')} (the workspace copy)`
      : '`supabase` from PATH (no workspace copy in node_modules/.bin)'
  console.log(`[rls] Supabase CLI ${version}: ${where}`)
}
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

// ---- THE STAMP (1.0.4) ---------------------------------------------------------------
// This runner is a Stop step, not a validate gate, so through 1.0.3 nothing stamped it and
// every turn end with the stack up ran both suites. It now rides the stamp every gate uses
// (lib/gate.mjs stampGate, inputs in lib/stamp-inputs.mjs), checked HERE, after `supabase
// status` succeeded, because the database's identity can only be read from a running stack.
//
// What the tree cannot show goes into the digest as a salt:
//   - the `supabase --version` output: a CLI float has changed this suite's verdict on an
//     unchanged tree before (CHANGELOG 1.0.2: 2.115.0 to 2.117.0 turned a pgTAP assertion red);
//   - the database's identity, two parts. The runner applies no migration and restarts
//     nothing: migrations reach the database on the first `pnpm db:up` or on `pnpm db:reset`,
//     a stopped stack keeps its data, and none of that edits a file. The server's start time
//     moves on a reset and on a restart; the applied migration versions move when a migration
//     is applied without one. Neither is enough alone: a reset re-applies an edited migration
//     under its old version, so the list stays the same.
// The stamp is honoured only when CI is empty or unset (this runner's own rule above, which
// counts CI=false as CI) AND lib/gate.mjs's inCI() is false, and it is recorded only after
// `[rls] OK`, never on a skip or a failure. An identity that cannot be read means no stamp:
// both suites run and nothing is recorded. What it cannot see is SQL someone runs by hand
// against the running database; CI never rides it.
const IDENTITY_SQL =
  "select pg_postmaster_start_time()::text as started, coalesce((select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations), '') as versions"

/** The running database's identity, or null when it cannot be read. */
function dbIdentity() {
  try {
    const out = execFileSync(
      'supabase',
      ['db', 'query', '--local', '--output-format', 'json', IDENTITY_SQL],
      {
        cwd: repoRoot,
        env: cli.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000,
      },
    )
    // Only the rows: the envelope carries a fresh random boundary on every call.
    const parsed = JSON.parse(out.slice(out.search(/[[{]/)))
    const row = (Array.isArray(parsed) ? parsed : parsed?.rows)?.[0]
    if (typeof row?.started !== 'string' || typeof row?.versions !== 'string') return null
    return `started ${row.started}; migrations ${row.versions}`
  } catch {
    return null
  }
}

const NO_STAMP = () => {}

// `update` parks, rather than replaces, an owned file the install has changed, so this runner
// can meet an older tools/lib beside it. A register without this entry, or a stampGate that
// takes no salt (1.0.3's has two parameters and would drop the CLI version and the database
// identity), means no stamp: both suites run, as they did before 1.0.4.
function stampMachineryReady() {
  return Array.isArray(STAMP_INPUTS[GATE]) && stampGate.length >= 3
}

/** @param {string} why */
function noStamp(why) {
  console.log(`[rls] no stamp this run: ${why}, so both suites run`)
  return NO_STAMP
}

/** Exits on a stamp hit; otherwise returns what records the stamp after a green run. */
function stampOrRecorder() {
  if (inCI || requiresToolchains()) return NO_STAMP
  if (!stampMachineryReady()) {
    return noStamp('tools/lib/stamp-inputs.mjs or tools/lib/gate.mjs predates the rls stamp')
  }
  const identity = dbIdentity()
  if (identity === null) {
    return noStamp('the database identity could not be read (`supabase db query --local`)')
  }
  // stampGate and hashInputs resolve every declared path from the working directory.
  process.chdir(repoRoot)
  try {
    // A hit prints `rls-isolation: STAMPED — …` and exits 0 here; a miss returns the recorder.
    return stampGate(GATE, STAMP_INPUTS[GATE], `supabase ${version}\n${identity}`)
  } catch (e) {
    // hashInputs throws on an input it cannot open (never hashes it as missing): no stamp.
    return noStamp(`a declared input could not be read (${e?.message ?? e})`)
  }
}

/** @param {() => void} record */
function recordStamp(record) {
  try {
    record()
  } catch (e) {
    // Bookkeeping never decides a verdict: both suites passed.
    console.log(
      `[rls] the stamp could not be written (${e?.message ?? e}); the next run re-runs both suites`,
    )
  }
}

const recordGreen = stampOrRecorder()

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, { cwd: repoRoot, env: { ...cli.env, ...extraEnv }, stdio: 'inherit' })
}

// The local keys and the database URL, read from `supabase status` at RUNTIME — never
// committed (the keys are JWT-shaped, and the hygiene gate reds a literal one; the URL's
// port is whatever this project's supabase/config.toml says).
function statusEnv() {
  const out = execFileSync('supabase', ['status', '-o', 'env'], {
    cwd: repoRoot,
    env: cli.env,
    encoding: 'utf8',
  })
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
    // The name the shipped workflow maps DB_URL to and the shipped tools read (1.0.4).
    // auth-trail.test.ts counts its rows through it, so a forked runner that drops this key
    // makes that suite throw rather than reach a database on a guessed port.
    SUPABASE_DB_URL: s['DB_URL'] ?? '',
  })
} catch {
  console.error('[rls] client isolation suite FAILED')
  process.exit(1)
}

console.log('[rls] OK — both runtime layers green')
recordStamp(recordGreen)
process.exit(0)
