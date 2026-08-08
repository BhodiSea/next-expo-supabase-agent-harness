// Can-fail proofs for the data-flow gate (template/base/tools/check-data-flow.mjs).
//
// Fixture-driven against the SHIPPED supabase/migrations, supabase/schemas,
// tools/data-flow.json and tools/pii-columns.json, verbatim — so template drift reds here
// rather than on someone's first scaffold, and so the GREEN case is a real statement about
// what the harness installs.
//
// THE HEADLINE PROOF is `RED: an FK with NO ON DELETE CLAUSE`. PostgreSQL treats an omitted
// clause as NO ACTION, so the spelling that makes account deletion FAIL is the one that looks
// like every other column definition — no keyword to notice, nothing to grep for. That is a
// GDPR Art. 17 failure and an Apple 5.1.1(v) rejection from a line a reviewer reads past.
//
// The second is `RED: the declarative schema disagrees with the applied history`. Nothing else
// in this repository compares those two directories on column facts, and this is the one
// question where they nearly did disagree in the shipped tree: notes.owner_id was created ON
// DELETE CASCADE and demoted to SET NULL by a later ALTER.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  classifyLinks,
  erasedTables,
  foreignKeys,
} from '../../template/base/tools/lib/data-flow.mjs'
import {
  parseColumnFacts,
  splitStatements,
} from '../../template/base/tools/lib/sql-parse.mjs'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-data-flow.mjs', import.meta.url))
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const STACK = fileURLToPath(new URL('../../template/stack/supabase', import.meta.url))
const DOCS = fileURLToPath(new URL('../../template/base/docs', import.meta.url))
const SHIPPED_POLICY = JSON.parse(readFileSync(join(TOOLS, 'data-flow.json'), 'utf8'))

/**
 * A project root carrying the real supabase tree. `policy` may be mutated by `edit`; an
 * `extraSql` string is appended as one more migration, which is how a hypothetical column is
 * introduced without rewriting a shipped file.
 * @param {{ policy?: any, edit?: (p: any) => void, extraSql?: string, schemaEdit?: (s: string) => string }} [opts]
 */
function fixture({ policy, edit, extraSql, schemaEdit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-dataflow-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  mkdirSync(join(dir, 'docs/runbooks'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(STACK, join(dir, 'supabase'), { recursive: true })
  cpSync(join(DOCS, 'runbooks'), join(dir, 'docs/runbooks'), { recursive: true })
  cpSync(join(TOOLS, 'pii-columns.json'), join(dir, 'tools/pii-columns.json'))

  if (schemaEdit) {
    const p = join(dir, 'supabase/schemas/20_notes.sql')
    writeFileSync(p, schemaEdit(readFileSync(p, 'utf8')))
  }
  if (extraSql !== undefined) {
    writeFileSync(join(dir, 'supabase/migrations/29990101000000_fixture.sql'), extraSql)
  }
  const next = policy === null ? null : structuredClone(policy ?? SHIPPED_POLICY)
  if (next !== null && edit) edit(next)
  if (next !== null) writeFileSync(join(dir, 'tools/data-flow.json'), JSON.stringify(next, null, 2))
  return dir
}

function runGate(dir) {
  // CI=true so skipOrFail fails closed rather than skipping loudly, and the toolchain flag
  // cleared FIRST so a maintainer's exported shell cannot make the fixture check MORE than CI
  // does — the lane-porosity trap, applied to a unit test.
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// A table whose only FK to the subject carries the given action, as one extra migration.
const linkedTable = (action) => `
CREATE TABLE public.fixture_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid REFERENCES auth.users (id)${action === null ? '' : ` ON DELETE ${action}`}
);
`

test('GREEN: the shipped schema satisfies the shipped policy', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data-flow: OK/)
  assert.match(r.out, /0 delete-blocking link\(s\)/)
  assert.match(r.out, /supabase\/schemas agrees with the applied history/)
})

// ── the bucket nobody watches ────────────────────────────────────────────────────────

test('RED: an FK with NO ON DELETE CLAUSE — the spelling that breaks deletion silently', () => {
  const r = runGate(fixture({ extraSql: linkedTable(null) }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /fixture_rows\.subject_id REFERENCES auth\.users ON DELETE NO ACTION/)
  assert.match(r.out, /no ON DELETE clause — the PostgreSQL default/)
  assert.match(r.out, /deleting the account would FAIL/)
  assert.match(r.out, /Art\. 17 failure and an Apple 5\.1\.1\(v\) rejection/)
})

test('RED: ON DELETE RESTRICT is the same finding, said out loud', () => {
  const r = runGate(fixture({ extraSql: linkedTable('RESTRICT') }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /ON DELETE RESTRICT/)
  assert.match(r.out, /deleting the account would FAIL/)
})

test('RED: a blockingAllowed escape whose procedure is not a file in the tree', () => {
  const r = runGate(
    fixture({
      extraSql: linkedTable('RESTRICT'),
      edit: (p) => {
        p.blockingAllowed = [
          {
            table: 'fixture_rows',
            column: 'subject_id',
            reason: 'a reason long enough to read as a reason rather than a rubber stamp here',
            procedure: 'supabase/functions/does-not-exist/index.ts',
          },
        ]
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not a file in this tree/)
  assert.match(r.out, /a procedure nobody can open is not that something/)
})

test('GREEN: a blocking link IS allowed when the sweep procedure really exists', () => {
  const r = runGate(
    fixture({
      extraSql: linkedTable('RESTRICT'),
      edit: (p) => {
        p.blockingAllowed = [
          {
            table: 'fixture_rows',
            column: 'subject_id',
            reason: 'the sweep clears these rows before deleteUser is called, exactly as the personal org is swept',
            procedure: 'supabase/functions/delete-account/index.ts',
          },
        ]
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// ── severed: the row survives ────────────────────────────────────────────────────────

test('RED: an UNREVIEWED severed link — a row survives and nothing says why', () => {
  const r = runGate(fixture({ extraSql: linkedTable('SET NULL') }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /fixture_rows\.subject_id REFERENCES auth\.users ON DELETE SET NULL/)
  assert.match(r.out, /the row SURVIVES the account's deletion/)
  assert.match(r.out, /no entry in tools\/data-flow\.json severed\[\] says why/)
})

test('RED: a STALE severed entry — reasoning outliving the decision it explained', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.severed.push({
          table: 'notes',
          column: 'gone_id',
          reason: 'a reason long enough to read as a reason rather than a rubber stamp here',
        })
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /severed\[\] reviews notes\.gone_id/)
  assert.match(r.out, /reads as coverage and is not/)
})

test('RED: a THIN severed reason — the one place a reader learns why data is still here', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.severed.find((s) => s.table === 'notes').reason = 'the org owns it'
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /has a reason under 40 characters/)
})

// ── retained: nothing the delete does will reach it ──────────────────────────────────

test('RED: a pii-columns entry accounted for nowhere — the lower-bound closure', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.retained = p.retained.filter((u) => !(u.table === 'notes' && u.column === 'body'))
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /notes\.body is declared personal data in tools\/pii-columns\.json/)
  assert.match(r.out, /nothing removes it and nothing explains that/)
})

test('RED: a retained entry for a column that IS erased — a gap claimed where none exists', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.retained.push({
          table: 'profiles',
          column: 'display_name',
          reason: 'a reason long enough to read as a reason rather than a rubber stamp here',
          procedure: 'docs/runbooks/data-subject-requests.md',
        })
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /but profiles is erased by a chain of ON DELETE CASCADE/)
})

test('RED: a retained entry whose PROCEDURE is not in the tree — procedure-backed or not backed', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.retained.find((u) => u.column === 'email').procedure = 'docs/runbooks/nope.md'
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not a file in this tree/)
  assert.match(r.out, /answered by a PROCEDURE or it is not answered at all/)
})

// ── the portability half ─────────────────────────────────────────────────────────────

test('RED: a projected column no migration creates — a promise nobody can keep', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.export.projection.find((x) => x.table === 'profiles').columns.push('nickname')
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /promises profiles\.nickname, which no migration creates/)
})

test('RED: a subject-data table neither projected nor excluded — silence is the one answer', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.export.excluded = p.export.excluded.filter((x) => x.table !== 'invitations')
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /invitations carries subject data and appears in neither/)
  assert.match(r.out, /Silence is the one answer a data subject cannot be given/)
})

test('RED: export.surface "none" with no dated target — a deferral nobody has to keep', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        delete p.export.surface.target
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /an absence with no date is a deferral nobody has to keep/)
})

test('RED: export.surface names a procedure file that does not exist', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.export.surface = { kind: 'procedure', procedure: 'packages/api/src/routers/nope.ts' }
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /export\.surface names procedure/)
})

// ── the two directories, closed against each other ───────────────────────────────────

test('RED: the declarative schema disagrees with the applied history on ON DELETE', () => {
  // The shipped near-miss, made real: schemas says CASCADE, the migrations leave SET NULL.
  // Nothing else in this repository compares those two directories on a column fact.
  const r = runGate(
    fixture({
      schemaEdit: (s) =>
        s.replace(
          'owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL',
          'owner_id uuid REFERENCES auth.users (id) ON DELETE CASCADE',
        ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /supabase\/schemas declares ON DELETE CASCADE but the applied history/)
  assert.match(r.out, /leaves it ON DELETE SET NULL/)
})

// ── the policy itself ────────────────────────────────────────────────────────────────

test('RED: no policy at all fails CLOSED, and counts what it found', () => {
  const r = runGate(fixture({ policy: null }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /tools\/data-flow\.json is missing/)
  assert.match(r.out, /3 severed link\(s\)/)
  assert.match(r.out, /--refresh-seeded/)
})

// ── the reachability core, directly ──────────────────────────────────────────────────

test('the CASCADE closure is TRANSITIVE — a one-pass reader is wrong at depth 2', () => {
  const sql = `
CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE);
CREATE TABLE public.prefs (id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE);
CREATE TABLE public.deep (id uuid PRIMARY KEY REFERENCES public.prefs (id) ON DELETE CASCADE);
CREATE TABLE public.other (id uuid PRIMARY KEY REFERENCES public.prefs (id) ON DELETE SET NULL);
`
  const edges = foreignKeys(parseColumnFacts(splitStatements(sql)))
  assert.deepEqual([...erasedTables(edges)].sort(), ['deep', 'prefs', 'profiles'])
})

test('a DROPPED and re-ADDed constraint reads as the LAST word, not the first', () => {
  // The shipped case, minimised: notes.owner_id is created CASCADE and demoted to SET NULL.
  // A reader that stopped at CREATE TABLE would call a note erased with its author.
  const sql = `
CREATE TABLE public.notes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE
);
ALTER TABLE public.notes
  DROP CONSTRAINT notes_owner_id_fkey,
  ADD CONSTRAINT notes_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES auth.users (id) ON DELETE SET NULL;
`
  const links = classifyLinks(foreignKeys(parseColumnFacts(splitStatements(sql))))
  assert.deepEqual([...links.erased], [], 'notes must NOT be erased with the account')
  assert.deepEqual(
    links.severed.map((e) => `${e.table}.${e.column}`),
    ['notes.owner_id'],
  )
})

test('a DROPPED constraint with no replacement leaves NO reference behind', () => {
  // The direction that matters most: an FK the parser believes in but the database does not
  // would report a row as erased with the account when nothing removes it at all.
  const sql = `
CREATE TABLE public.t (
  id uuid PRIMARY KEY,
  subject_id uuid CONSTRAINT t_subject_fkey REFERENCES auth.users (id) ON DELETE CASCADE
);
ALTER TABLE public.t DROP CONSTRAINT t_subject_fkey;
`
  const facts = parseColumnFacts(splitStatements(sql))
  const col = facts.get('t').get('subject_id')
  assert.equal(col.references, null)
  assert.equal(col.onDelete, null)
})
