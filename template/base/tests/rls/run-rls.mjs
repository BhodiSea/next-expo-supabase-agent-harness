#!/usr/bin/env node
// Orchestrator behind `pnpm test:rls`. Flow, each layer independently guarded:
//   1. Resolve DSNs: env DATABASE_URL / MIGRATOR_DATABASE_URL win (whoever sets
//      them owns the target); otherwise derive passwordless local-dev DSNs from
//      docker-compose.yml (trust auth, local only) pointing at a SCRATCH database
//      (`<db>_rls`) — the suite fresh-applies by DROPPING its database, and the
//      scratch keeps that away from dev data.
//   2. Probe the server (SELECT 1 as migrator against the maintenance DB, 3s
//      timeout — the scratch database may not exist yet).
//   3. Reachable → take a session advisory lock keyed on the scratch name
//      (concurrent runners would drop each other's database mid-suite; the lock
//      serializes them and dies with the session), fresh-apply all migrations
//      (tests/migrations/migration-apply.mjs), then run the vitest isolation
//      suite with RLS_SUITE_READY=1 so it runs for real.
//   4. The vitest suite ALWAYS runs (self-skips politely when not ready) and its
//      exit code is the gate. Never hangs, never false-greens a real leak.
// Unreachable-database posture, by caller:
//   - Stop hook (HARNESS_STOP_GATE=1): FAIL CLOSED once migrations exist — the
//     headline promise is "the turn cannot end without the isolation proof", so a
//     polite skip here would be the exact false green the harness exists to kill.
//     The runner first tries `docker compose up -d db` itself (bounded wait).
//   - CI: FAIL CLOSED once migrations exist (service container expected).
//   - Manual runs: single fast probe, loud SKIP — no 25s retry dead-time unless
//     there is evidence a database is expected (explicit DSN env or a compose
//     db container present).
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const migrationsDir = path.join(repoRoot, 'packages', 'schema', 'drizzle')

function deriveDbName() {
  try {
    const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')
    const m = compose.match(/POSTGRES_DB:\s*['"]?([A-Za-z0-9_]+)/)
    if (m) return m[1]
  } catch {
    // fall through
  }
  return 'app'
}

// Scratch database: `<devdb>_rls`. migration-apply DROPs + recreates its target
// on every run — deriving the DEV database here was the classic footgun (every
// test run destroyed dev data). Explicit env DSNs are honoured verbatim.
const db = `${deriveDbName()}_rls`
// HARNESS_DB_PORT mirrors the docker-compose port seam — dev machines routinely
// have a resident Postgres on 5432, and the compose file honours the same var.
const port = process.env['HARNESS_DB_PORT'] || '5432'
// Local-dev defaults matching db/init/01-roles.sql: the documented 'postgres'
// password on loopback only — never a real credential shape.
const DATABASE_URL =
  process.env['DATABASE_URL'] || `postgres://app_api:postgres@127.0.0.1:${port}/${db}`
const MIGRATOR_DATABASE_URL =
  process.env['MIGRATOR_DATABASE_URL'] || `postgres://app_migrator:postgres@127.0.0.1:${port}/${db}`

function loadPostgres() {
  try {
    return createRequire(path.join(repoRoot, 'apps/server/package.json'))('postgres')
  } catch {
    return null // no install yet — nothing can run anyway
  }
}

// The maintenance DB, derived from the migrator DSN: the scratch database may
// not exist before the first fresh-apply, and migration-apply needs this level
// of access anyway (it connects to /postgres to DROP/CREATE the target).
function maintenanceUrl() {
  const u = new URL(MIGRATOR_DATABASE_URL)
  u.pathname = '/postgres'
  return u.href
}

async function probe() {
  const postgres = loadPostgres()
  if (!postgres) return false
  const sql = postgres(maintenanceUrl(), { max: 1, connect_timeout: 3 })
  try {
    await sql`SELECT 1`
    return true
  } catch {
    return false
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {})
  }
}

// Session advisory lock keyed on the scratch name: two concurrent runners (a
// second agent session, a parallel CI shard on one host) would DROP each
// other's database mid-suite — the lock serializes them, and the server
// releases it automatically when the holding session dies (crash-safe).
// SOURCE: PostgreSQL explicit locking — advisory locks
// https://www.postgresql.org/docs/16/explicit-locking.html
/** @type {any} */ // postgres client is loaded dynamically (loadPostgres) — untyped here
let lockSql = null
async function acquireRunLock() {
  const postgres = loadPostgres()
  if (!postgres) return
  lockSql = postgres(maintenanceUrl(), { max: 1 })
  await lockSql`SELECT pg_advisory_lock(hashtext(${`epah-rls:${db}`}))`
}

// Bounded readiness loop: `docker compose up -d db` returns before first-boot
// initdb + role bootstrap finishes, so a started database needs a few probes.
async function reachable(attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await probe()) return true
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL, MIGRATOR_DATABASE_URL, ...extraEnv },
    stdio: 'inherit',
  })
}

// Evidence a database is EXPECTED here: an explicit DSN, CI, or a compose db
// container already defined+running. Without any of it, a manual run gets one
// fast probe and a loud skip instead of a 15s retry loop.
function composeDbPresent() {
  if (!existsSync(path.join(repoRoot, 'docker-compose.yml'))) return false
  try {
    const out = execFileSync('docker', ['compose', 'ps', '-q', 'db'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

const haveMigrations = existsSync(migrationsDir)
const underStopGate = process.env['HARNESS_STOP_GATE'] === '1'
const inCI = Boolean(process.env['CI'])

let up = await probe()
if (!up && haveMigrations) {
  if (underStopGate && !inCI && existsSync(path.join(repoRoot, 'docker-compose.yml'))) {
    // The Stop gate owns the outcome: start the database instead of skipping.
    console.log('[rls] Postgres unreachable — attempting `docker compose up -d db`')
    try {
      execFileSync('docker', ['compose', 'up', '-d', 'db'], {
        cwd: repoRoot,
        stdio: 'inherit',
        timeout: 120_000,
      })
      up = await reachable()
    } catch {
      // docker absent/failed — the fail-closed message below says what to do.
    }
  } else if (
    inCI ||
    process.env['DATABASE_URL'] ||
    process.env['MIGRATOR_DATABASE_URL'] ||
    composeDbPresent()
  ) {
    up = await reachable() // a database is expected — give it time to come up
  }
}

// Fail closed when this run is the proof: CI (service container expected) and
// the Stop hook (a turn must not end green with the isolation suite unexecuted).
if (!up && haveMigrations && (inCI || underStopGate)) {
  console.error(
    inCI
      ? '[rls] CI with migrations present but Postgres unreachable — failing closed'
      : '[rls] FAIL: the RLS surface exists but no database is reachable, so cross-user isolation is UNPROVEN and the turn cannot end.\n' +
          '[rls] Fix: start Docker Desktop (the gate auto-runs `docker compose up -d db`), or run `pnpm db:up`, or point DATABASE_URL/MIGRATOR_DATABASE_URL at a local Postgres 16 (HARNESS_DB_PORT overrides the port).',
  )
  process.exit(1)
}

let ready = '0'
if (haveMigrations && up) {
  console.log(`[rls] Postgres reachable — fresh-applying migrations to scratch database ${db}`)
  await acquireRunLock()
  try {
    run('node', ['tests/migrations/migration-apply.mjs'])
    ready = '1'
  } catch {
    console.error('[rls] migration apply FAILED')
    process.exit(1)
  }
} else {
  console.log(
    `[rls] SKIPPED — ${haveMigrations ? 'database unreachable (pnpm db:up)' : 'no migrations yet'}; the vitest suite will self-skip politely. This layer FAILS CLOSED in CI and under the Stop hook.`,
  )
}

try {
  run('pnpm', ['exec', 'vitest', 'run', 'tests/rls'], { RLS_SUITE_READY: ready })
} catch {
  console.error('[rls] isolation suite FAILED')
  process.exit(1)
} finally {
  // Best-effort: process exit releases the advisory lock server-side anyway.
  await lockSql?.end({ timeout: 2 }).catch(() => {})
}
console.log('[rls] OK')
process.exit(0)
