// Can-fail proofs for the migrations gate (template/base/tools/check-migrations.mjs).
// Every rule is fixture-driven: build a real scratch GIT repo shaped like the
// scaffold (the gate detects committed state via `git diff --name-status <base>`
// with cwd inside the project), run the real gate script, assert the exact
// red/green. Covers: DML needs `-- harness-allow-dml:`, destructive DDL needs a
// resolvable `-- adr:`, committed migrations are append-only, and the
// append-only diff fails CLOSED in CI / skips LOUDLY locally when git cannot diff.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-migrations.mjs', import.meta.url),
)
const MIGRATIONS = 'supabase/migrations'

const CLEAN_MIGRATION = [
  '-- 0000_init — structure only, nothing destructive.',
  'CREATE TABLE "notes" (',
  '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
  '\t"owner_id" uuid NOT NULL,',
  '\t"title" text NOT NULL',
  ');',
  '',
].join('\n')

function git(dir, ...args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

// A scratch project with the migrations dir committed — the gate diffs the working
// tree against HEAD (locally) exactly like a real checkout, so committed state
// must come from a real git repo, not from file layout alone.
function fixture({ migration = CLEAN_MIGRATION, migrationsDir = true, commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-miggate-'))
  if (migrationsDir) {
    mkdirSync(join(dir, MIGRATIONS), { recursive: true })
    if (migration !== null) writeFileSync(join(dir, MIGRATIONS, '0000_init.sql'), migration)
  }
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'gate-test@example.invalid')
  git(dir, 'config', 'user.name', 'gate-test')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'commit.gpgsign', 'false')
  if (commit) {
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  return dir
}

// appendMigration: the sanctioned workflow — a NEW uncommitted file. It never
// trips append-only (untracked files are not M/D in the diff) but the content
// rules still run over it.
function appendMigration(dir, name, text) {
  writeFileSync(join(dir, MIGRATIONS, name), text)
}

function addAdr(dir, name) {
  mkdirSync(join(dir, 'docs/adr'), { recursive: true })
  writeFileSync(join(dir, 'docs/adr', name), '# ADR: drop widgets\n\nAccepted.\n')
}

/** @param {string} dir @param {{ ci?: boolean, baseRef?: string }} [opts] */
function runGate(dir, { ci = true, baseRef } = {}) {
  const env = { ...process.env }
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  else delete env.CI
  if (baseRef !== undefined) env.GITHUB_BASE_REF = baseRef
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ---- baseline ------------------------------------------------------------------

test('GREEN: committed structure-only migration, untouched working tree', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('migrations: OK'), r.out)
})

// ---- rule 2: DML needs an explicit harness-allow-dml marker ---------------------

test('RED: INSERT INTO without the harness-allow-dml marker', () => {
  const dir = fixture()
  appendMigration(dir, '0001_seed.sql', "INSERT INTO \"notes\" (\"title\") VALUES ('x');\n")
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('contains DML'), r.out)
  assert.ok(r.out.includes(`${MIGRATIONS}/0001_seed.sql`), r.out)
  assert.ok(r.out.includes('harness-allow-dml'), r.out)
})

test('RED: lowercase delete from is still DML (case-insensitive match)', () => {
  const dir = fixture()
  appendMigration(dir, '0001_purge.sql', 'delete from "notes" where "title" = \'\';\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('contains DML'), r.out)
})

test('GREEN: the same DML with `-- harness-allow-dml: <reason>` passes', () => {
  const dir = fixture()
  appendMigration(
    dir,
    '0001_seed.sql',
    "-- harness-allow-dml: static reference data, reviewed\nINSERT INTO \"notes\" (\"title\") VALUES ('x');\n",
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('GREEN: DML keywords inside `--` comment lines are not code', () => {
  const dir = fixture()
  appendMigration(
    dir,
    '0001_note.sql',
    '-- INSERT INTO notes was considered and rejected here\nALTER TABLE "notes" ADD COLUMN "extra" text;\n',
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('ODDITY (pinned): unquoted multi-char UPDATE target slips past the DML rule', () => {
  // The regex `UPDATE\s+[a-z"]` + trailing `\b` only matches a quoted identifier
  // or a single-character table name. Drizzle-generated SQL always quotes, so
  // `UPDATE "notes"` reds — but a hand-written unquoted UPDATE is a false
  // negative. Pinned as current behavior (ported unchanged from the source
  // harness); see the suite's bug report.
  const quoted = fixture()
  appendMigration(quoted, '0001_fix.sql', 'UPDATE "notes" SET "title" = \'x\';\n')
  const rq = runGate(quoted)
  assert.equal(rq.code, 1, rq.out)
  assert.ok(rq.out.includes('contains DML'), rq.out)

  const unquoted = fixture()
  appendMigration(unquoted, '0001_fix.sql', "UPDATE notes SET title = 'x';\n")
  const ru = runGate(unquoted)
  assert.equal(ru.code, 0, ru.out)
})

// ---- rule 3: destructive DDL is ADR-coupled -------------------------------------

test('RED: DROP TABLE without an `-- adr:` comment', () => {
  const dir = fixture()
  appendMigration(dir, '0001_drop.sql', 'DROP TABLE "widgets";\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('destructive DDL requires an ADR'), r.out)
  assert.ok(r.out.includes(`${MIGRATIONS}/0001_drop.sql`), r.out)
})

test('RED: TRUNCATE is destructive DDL too', () => {
  const dir = fixture()
  appendMigration(dir, '0001_truncate.sql', 'TRUNCATE "notes";\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('destructive DDL requires an ADR'), r.out)
})

test('GREEN: DROP TABLE with `-- adr:` pointing at an existing ADR file', () => {
  const dir = fixture()
  addAdr(dir, '0001-drop-widgets.md')
  appendMigration(
    dir,
    '0001_drop.sql',
    '-- adr: docs/adr/0001-drop-widgets.md\nDROP TABLE "widgets";\n',
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('RED: `-- adr:` pointing at a missing file names the dangling path', () => {
  const dir = fixture()
  appendMigration(
    dir,
    '0001_drop.sql',
    '-- adr: docs/adr/9999-not-written.md\nDROP TABLE "widgets";\n',
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('docs/adr/9999-not-written.md'), r.out)
  assert.ok(r.out.includes('does not exist'), r.out)
})

// ---- rule 1: append-only over committed state -----------------------------------

test('RED: editing a committed migration is an append-only violation', () => {
  const dir = fixture()
  writeFileSync(
    join(dir, MIGRATIONS, '0000_init.sql'),
    `${CLEAN_MIGRATION}ALTER TABLE "notes" ADD COLUMN "extra" text;\n`,
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('modified'), r.out)
  assert.ok(r.out.includes('append-only'), r.out)
  assert.ok(r.out.includes(`${MIGRATIONS}/0000_init.sql`), r.out)
})

test('RED: deleting a committed migration is an append-only violation', () => {
  const dir = fixture()
  rmSync(join(dir, MIGRATIONS, '0000_init.sql'))
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('deleted'), r.out)
  assert.ok(r.out.includes('append-only'), r.out)
})

test('CI: an unresolvable diff base (no commits) fails CLOSED, never vacates the check', () => {
  const r = runGate(fixture({ commit: false }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('append-only check cannot run'), r.out)
})

test('CI: GITHUB_BASE_REF selects origin/<ref> as the diff base and reds when unfetchable', () => {
  const r = runGate(fixture(), { baseRef: 'no-such-base' })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('origin/no-such-base'), r.out)
  assert.ok(r.out.includes('append-only check cannot run'), r.out)
})

test('local: a failed diff skips append-only LOUDLY and the content rules still run', () => {
  // No commits → `git diff HEAD` cannot resolve; locally the gate must say so
  // and still red on the DML sitting in the working tree.
  const dir = fixture({ commit: false })
  appendMigration(dir, '0001_seed.sql', "INSERT INTO \"notes\" (\"title\") VALUES ('x');\n")
  const r = runGate(dir, { ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('append-only diff skipped locally'), r.out)
  assert.ok(r.out.includes('contains DML'), r.out)
})

// ---- surface-absent asymmetry ----------------------------------------------------

test('missing migrations dir: SKIPPED locally, FAIL in CI', () => {
  const local = runGate(fixture({ migrationsDir: false }), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)

  const ci = runGate(fixture({ migrationsDir: false }))
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('FAIL'), ci.out)
})
