#!/usr/bin/env node
// Fresh-apply runner: drop + recreate the target database, then apply every
// migration in packages/schema/drizzle/*.sql in filename order, each in its own
// transaction. Proves the committed migration chain builds the schema from zero —
// the property CI relies on and drift silently breaks. Uses MIGRATOR_DATABASE_URL
// (the owner role; RLS-bypassing by design, which is exactly why the bash-guard
// confines it to this runner and drizzle-kit).
// SOURCE: docs/harness/README.md (migration discipline) [corpus: drizzle/migrations-append-only]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = path.join(repoRoot, 'packages', 'schema', 'drizzle')

const url = process.env['MIGRATOR_DATABASE_URL']
if (!url) {
  console.error('[migrations] MIGRATOR_DATABASE_URL not set (run via tests/rls/run-rls.mjs)')
  process.exit(1)
}
if (!existsSync(dir)) {
  console.error(`[migrations] ${dir} not found`)
  process.exit(1)
}

const postgres = createRequire(path.join(repoRoot, 'apps/server/package.json'))('postgres')

const parsed = new URL(url)
const dbName = parsed.pathname.replace(/^\//, '')
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
  console.error(`[migrations] refusing to operate on suspicious database name "${dbName}"`)
  process.exit(1)
}

// 1. Recreate the database from the maintenance DB (app_migrator has CREATEDB).
const maint = new URL(url)
maint.pathname = '/postgres'
const admin = postgres(maint.href, { max: 1 })
try {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
} finally {
  await admin.end({ timeout: 5 }).catch(() => {})
}

// 2. Apply every migration in order.
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const sql = postgres(url, { max: 1 })
try {
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8')
    try {
      await sql.begin((tx) => tx.unsafe(text).simple())
    } catch (e) {
      console.error(`[migrations] FAILED applying ${f}: ${e.message}`)
      process.exit(1)
    }
    console.log(`[migrations] applied ${f}`)
  }
} finally {
  await sql.end({ timeout: 5 }).catch(() => {})
}
console.log(`[migrations] OK — ${files.length} migration(s) applied from zero`)
