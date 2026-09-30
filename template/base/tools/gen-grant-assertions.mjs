#!/usr/bin/env node
// Generator: supabase/tests/rls_grants.generated.test.sql — the exact table privileges anon,
// authenticated and service_role hold on every table a migration creates, as ONE pgTAP
// assertion `supabase test db` runs against the local stack. The `schema-rls` gate renders
// the same file in memory and fails when the committed copy is missing or differs.
//
//   node tools/gen-grant-assertions.mjs           # write the committed file
//   node tools/gen-grant-assertions.mjs --check   # regen-diff (exit 1 on drift)
//
// WHY GENERATED (1.1.0, #74). supabase/tests/rls_structure.test.sql asserts privilege
// exactness over table lists and a plan() count written by hand, which had already drifted
// once, and a new table was on none of them until someone remembered. This file is rendered
// from the migrations and supabase/config.toml's [db].major_version (PostgreSQL 17 has eight
// table privileges, 16 and earlier seven), so a table cannot be left off it. The hand-written
// assertions stay: they state intent — the service_role allowlist, the seat and quota
// shapes — which a file generated from the migrations cannot.
//
// IT REFUSES while any table fails the three-role revoke doctrine
// (docs/adr/20260930-three-role-revoke.md), naming those tables and printing the statements
// that clear them. While a table keeps the platform's default privileges for a role, what that
// role holds depends on whether Supabase applied its default to the new table — which is what
// differed between two local CLI versions in 1.0.2, and what stops for projects created on or
// after 2026-10-30 — so no expectation for it can be committed. It also refuses on a GRANT or
// REVOKE it cannot read, and when no migration creates a table.
// SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { readSqlDirByFile } from './lib/sql-parse.mjs'
import { foldPrivileges, postgresMajor, renderGrantAssertions } from './lib/table-grants.mjs'

const MIGRATIONS_DIR = 'supabase/migrations'
const CONFIG_TOML = 'supabase/config.toml'
const OUTPUT = 'supabase/tests/rls_grants.generated.test.sql'

if (!existsSync(MIGRATIONS_DIR)) {
  process.stderr.write(
    `${MIGRATIONS_DIR} not found — nothing to generate (no database surface here).\n`,
  )
  process.exit(0)
}

const statements = readSqlDirByFile(MIGRATIONS_DIR).flatMap((f) => f.statements)
const major = existsSync(CONFIG_TOML) ? postgresMajor(readFileSync(CONFIG_TOML, 'utf8')) : null
const fold = foldPrivileges(statements, major)
const { text, refusal } = renderGrantAssertions(fold)
if (text === null) {
  process.stderr.write(`${OUTPUT} cannot be generated: ${refusal}\n`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
  if (committed !== text) {
    process.stderr.write(
      `${OUTPUT} is stale — the grants in ${MIGRATIONS_DIR}, or [db].major_version in ${CONFIG_TOML}, changed without regenerating it. Run \`node tools/gen-grant-assertions.mjs\` and commit the diff.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(
    `${OUTPUT}: in sync (${String(fold.tables.size)} table(s), PostgreSQL ${String(fold.major)})\n`,
  )
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, text)
  process.stdout.write(
    `wrote ${OUTPUT} (${String(fold.tables.size)} table(s) x 3 roles x ${String(fold.privileges.length)} privileges, PostgreSQL ${String(fold.major)})\n`,
  )
}
