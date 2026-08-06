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
    // The lock_timeout preamble is the 0.2.0 rule, not this test's subject: ALTER
    // TABLE on a pre-existing table takes ACCESS EXCLUSIVE, so a migration without
    // it reds for an unrelated reason and this fixture would stop testing comments.
    '-- INSERT INTO notes was considered and rejected here\nSET lock_timeout = \'3s\';\nALTER TABLE "notes" ADD COLUMN "extra" text;\n',
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('FIXED (0.2.0): the unquoted multi-char UPDATE false negative is closed', () => {
  // The ancestor regex `UPDATE\s+[a-z"]` + trailing \b only ever matched a quoted
  // identifier or a single-character table name, so `UPDATE notes SET ...` slipped
  // past the DML rule entirely — pinned here as an ODDITY until the statement-level
  // rewrite. Both spellings must now red identically.
  const quoted = fixture()
  appendMigration(quoted, '0001_fix.sql', 'UPDATE "notes" SET "title" = \'x\';\n')
  const rq = runGate(quoted)
  assert.equal(rq.code, 1, rq.out)
  assert.ok(rq.out.includes('contains DML'), rq.out)

  const unquoted = fixture()
  appendMigration(unquoted, '0001_fix.sql', "UPDATE notes SET title = 'x';\n")
  const ru = runGate(unquoted)
  assert.equal(ru.code, 1, ru.out)
  assert.ok(ru.out.includes('contains DML'), ru.out)
})

test('GREEN: DML inside a CREATE FUNCTION body is not the migration\'s DML', () => {
  // A SECURITY DEFINER RPC's body legitimately writes tables; the migration only
  // DEFINES it. The old raw-text grep false-positived exactly this, which would have
  // forced a bogus `-- harness-allow-dml` marker onto every RPC-bearing migration.
  const dir = fixture()
  appendMigration(
    dir,
    '0001_rpc.sql',
    [
      'CREATE FUNCTION public.join_org(_org uuid) RETURNS void',
      "LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''",
      'AS $$',
      'BEGIN',
      "  INSERT INTO public.memberships (user_id, org_id) VALUES (auth.uid(), _org);",
      "  DELETE FROM public.invitations WHERE org_id = _org;",
      'END;',
      '$$;',
      '',
    ].join('\n'),
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('RED: DML smuggled through a leading CTE still reds', () => {
  const dir = fixture()
  appendMigration(
    dir,
    '0001_cte.sql',
    "WITH doomed AS (SELECT id FROM notes) DELETE FROM notes WHERE id IN (SELECT id FROM doomed);\n",
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('contains DML'), r.out)
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

// ---------------------------------------------------------------------------
// 0.2.0 — statements that remove an authorization control without removing the
// object it guarded. All of these shipped ADR-free: none matches
// DROP TABLE|DROP COLUMN|TRUNCATE, so the destructive-DDL rule never saw them.
// ---------------------------------------------------------------------------

for (const [label, sql] of [
  ['DROP POLICY', 'DROP POLICY notes_select_own ON public.notes;'],
  ['DISABLE ROW LEVEL SECURITY', 'ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY;'],
  ['NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE public.notes NO FORCE ROW LEVEL SECURITY;'],
  ['DROP FUNCTION', 'DROP FUNCTION public.set_updated_at();'],
  ['DISABLE TRIGGER', 'ALTER TABLE public.notes DISABLE TRIGGER notes_audit;'],
  ['REVOKE FROM authenticated', 'REVOKE ALL ON TABLE public.notes FROM authenticated;'],
]) {
  test(`RED (0.2.0): ${label} without an \`-- adr:\` is an unrecorded authorization removal`, () => {
    const dir = fixture()
    appendMigration(dir, '0001_authz.sql', `SET lock_timeout = '3s';\n${sql}\n`)
    const r = runGate(dir)
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('removes an authorization control'), r.out)
  })
}

test('GREEN (0.2.0): the same removal WITH a resolvable `-- adr:` is a recorded decision', () => {
  const dir = fixture()
  addAdr(dir, '0001-drop-widgets.md')
  appendMigration(
    dir,
    '0001_authz.sql',
    "-- adr: docs/adr/0001-drop-widgets.md\nSET lock_timeout = '3s';\nDROP POLICY notes_select_own ON public.notes;\n",
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('RED (0.2.0): ALTER TABLE on a pre-existing table with no lock timeout', () => {
  const dir = fixture()
  appendMigration(dir, '0001_alter.sql', 'ALTER TABLE public.notes ADD COLUMN body text;\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ACCESS EXCLUSIVE'), r.out)
  assert.ok(r.out.includes('notes'), 'names the table it would lock')
})

test('GREEN (0.2.0): a table CREATED in the same migration needs no lock preamble', () => {
  // Nothing can be reading a table that did not exist a statement ago — this is why
  // the seeded account-spine and notes migrations pass untouched.
  const dir = fixture()
  appendMigration(
    dir,
    '0001_new.sql',
    'CREATE TABLE public.widgets (id uuid PRIMARY KEY);\nALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;\n',
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

// ---- 0.4.0: the pre-adoption escape, and the three ways it refuses ---------------
//
// The two 0.2.0 rules above are the only findings in this gate a consumer cannot sweep:
// both remedies live INSIDE the migration, and rule 1 reds any edit to a committed one.
// So when the ramp expired in 0.4.0, an install whose own applied history carried either
// finding had a red whose only in-file fix was a different red. tools/migrations-allow.json
// is the acknowledgement — bounded so it cannot become a way of writing around the rule.

const HEAVY = 'ALTER TABLE "notes" ADD COLUMN "extra" text;\n'

/** A repo whose HISTORY carries a lock-timeout finding: notes created, then altered. */
function appliedHeavy() {
  const dir = fixture()
  appendMigration(dir, '0001_alter.sql', HEAVY)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'alter')
  return dir
}

/** @param {string} dir @param {unknown} body */
function writeAllow(dir, body) {
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/migrations-allow.json'), JSON.stringify(body))
}

const REASON =
  'Applied in production 2026-03; the lock was taken and released months ago and the migration cannot be edited.'

test('0.4.0 GREEN: a reviewed exemption turns an APPLIED history finding into a NOTE', () => {
  const dir = appliedHeavy()
  assert.equal(runGate(dir).code, 1, 'precondition: the finding must be red without the file')
  writeAllow(dir, { allow: [{ file: '0001_alter.sql', rule: 'lock-timeout', reason: REASON }] })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('reviewed exemption'), r.out)
  assert.ok(r.out.includes('ACCESS EXCLUSIVE'), r.out)
})

test('0.4.0 RED: a migration that is NEW at the diff base cannot be exempted at all', () => {
  // The property that keeps this an acknowledgement of the past rather than an escape
  // hatch for the present: a migration being written now HAS an in-file remedy.
  const dir = fixture()
  appendMigration(dir, '0001_alter.sql', HEAVY)
  writeAllow(dir, { allow: [{ file: '0001_alter.sql', rule: 'lock-timeout', reason: REASON }] })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('it is NEW in this change'), r.out)
})

test('0.4.0 RED: a stale exemption is a standing permission nobody reviewed', () => {
  const dir = fixture()
  writeAllow(dir, { allow: [{ file: '0001_alter.sql', rule: 'lock-timeout', reason: REASON }] })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('produces no such finding'), r.out)
})

test('0.4.0 RED: an exemption for the WRONG rule does not cover the finding', () => {
  // Keyed by (file, rule), never by file: a new destructive statement in an
  // already-exempted migration is a new decision.
  const dir = appliedHeavy()
  writeAllow(dir, { allow: [{ file: '0001_alter.sql', rule: 'authz-adr', reason: REASON }] })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ACCESS EXCLUSIVE'), r.out)
  assert.ok(r.out.includes('produces no such finding'), r.out)
})

test('0.4.0 FAIL CLOSED: a thin reason is not a review', () => {
  const dir = appliedHeavy()
  writeAllow(dir, { allow: [{ file: '0001_alter.sql', rule: 'lock-timeout', reason: 'legacy' }] })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('substantive reason'), r.out)
})

test('0.4.0 FAIL CLOSED: malformed exemption JSON is not read as "no exemptions"', () => {
  const dir = appliedHeavy()
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/migrations-allow.json'), '{ nope')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must be reviewable data'), r.out)
})

test('0.4.0: the unexempted failure NAMES the escape, because the in-file fix reds', () => {
  // Without this line the remediation path is a dead end: the message says "add
  // SET lock_timeout", the append-only rule reds the edit, and nothing connects the two.
  const r = runGate(appliedHeavy())
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/migrations-allow.json'), r.out)
  assert.ok(r.out.includes('editing a committed migration reds the append-only rule'), r.out)
})
