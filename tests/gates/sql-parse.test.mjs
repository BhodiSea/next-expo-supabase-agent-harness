// In-process proofs for the history fold in template/base/tools/lib/sql-parse.mjs (1.1.0, #75).
//
// The seven SQL gates run as child processes, so the lib coverage floor in selftest.yml
// (--test-coverage-include='template/base/tools/lib/**') cannot see a parser branch that only
// a gate fixture reaches. These cases import the parser itself. Each fold case runs in BOTH
// directions: the history without the folding statement shows the object is there, so the
// case that shows it gone is not vacuous.
//
// The model is PostgreSQL 17's. `DROP TABLE [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`
// removes each table with everything that hangs off it, and a later CREATE starts it fresh.
// `ALTER POLICY` replaces the roles, USING and WITH CHECK clauses it names and keeps the ones
// it omits; its separate `RENAME TO` form renames the policy.
// SOURCE: https://www.postgresql.org/docs/17/sql-droptable.html
// SOURCE: https://www.postgresql.org/docs/17/sql-alterpolicy.html
import assert from 'node:assert/strict'
import { test } from 'node:test'
// A namespace import, so a parser missing one of the new exports reds the case that needs it
// rather than failing the whole file at link time.
import * as sql from '../../template/base/tools/lib/sql-parse.mjs'

const stmts = (text) => sql.splitStatements(text)

const ORGS = `CREATE TABLE public.orgs (id uuid PRIMARY KEY, name text NOT NULL);`
const NOTES = `CREATE TABLE public.notes (
  id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX notes_owner_idx ON public.notes (owner_id);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_select_own ON public.notes AS PERMISSIVE FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY notes_update_own ON public.notes FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE TRIGGER notes_touch BEFORE UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION private.touch();
GRANT SELECT, UPDATE ON TABLE public.notes TO authenticated;`
const WIDGETS = `CREATE TABLE public.widgets (id uuid PRIMARY KEY, owner_id uuid NOT NULL);
CREATE INDEX widgets_owner_idx ON public.widgets (owner_id);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;`

/** Every view the gates read, reduced to what a DROP TABLE must clear for `table`. */
function viewsOf(history, table) {
  const s = stmts(history)
  const toggles = sql.parseRlsToggles(s)
  return {
    created: sql.parseCreatedTables(s).has(table),
    columns: sql.parseColumnFacts(s).has(table),
    indexes: sql.parseIndexes(s).all.some((i) => i.table === table),
    leading: sql.parseIndexes(s).leading.has(table),
    enabled: toggles.enabled.has(table),
    forced: toggles.forced.has(table),
    triggers: sql.parseTriggers(s).some((t) => t.table === table),
    grants: sql.parseGrants(s).some((g) => g.target === table),
    policies: sql.parseLivePolicies(s).live.has(table),
  }
}

const ALL_PRESENT = {
  created: true,
  columns: true,
  indexes: true,
  leading: true,
  enabled: true,
  forced: true,
  triggers: true,
  grants: true,
  policies: true,
}
const ALL_GONE = Object.fromEntries(Object.keys(ALL_PRESENT).map((k) => [k, false]))

// ── DROP TABLE ─────────────────────────────────────────────────────────────────

test('DROP TABLE: without the drop, every view carries the table (the non-vacuous direction)', () => {
  assert.deepEqual(viewsOf(`${ORGS}\n${NOTES}`, 'notes'), ALL_PRESENT)
})

test('DROP TABLE: the table leaves every view — columns, indexes, triggers, RLS toggles, policies, grants', () => {
  assert.deepEqual(viewsOf(`${ORGS}\n${NOTES}\nDROP TABLE public.notes;`, 'notes'), ALL_GONE)
})

test('DROP TABLE: a multi-table drop removes each named table and leaves the others', () => {
  const history = `${ORGS}\n${NOTES}\n${WIDGETS}\nDROP TABLE public.notes, widgets;`
  assert.deepEqual(viewsOf(history, 'notes'), ALL_GONE)
  assert.equal(viewsOf(history, 'widgets').created, false)
  assert.equal(viewsOf(history, 'widgets').indexes, false)
  assert.equal(viewsOf(history, 'orgs').created, true, 'a table the drop does not name stays')
  // …and without the drop both are there.
  const kept = `${ORGS}\n${NOTES}\n${WIDGETS}`
  assert.equal(viewsOf(kept, 'widgets').created, true)
  assert.equal(viewsOf(kept, 'notes').created, true)
})

test('DROP TABLE IF EXISTS: removes a known table; on an unknown one it is a no-op, not unresolved', () => {
  assert.deepEqual(viewsOf(`${ORGS}\n${NOTES}\nDROP TABLE IF EXISTS public.notes;`, 'notes'), ALL_GONE)
  const s = stmts(`${ORGS}\nDROP TABLE IF EXISTS public.ghost;`)
  assert.deepEqual(sql.unresolvedTableDrops(s), [])
  assert.equal(sql.parseCreatedTables(s).has('orgs'), true, 'the no-op drops nothing else')
})

test('DROP TABLE without IF EXISTS on a table no earlier CREATE made is UNRESOLVED', () => {
  const s = stmts(`${ORGS}\nDROP TABLE public.ghost;`)
  assert.deepEqual(
    sql.unresolvedTableDrops(s).map((u) => u.table),
    ['ghost'],
  )
  // A table dropped once and dropped again has no earlier CREATE left to resolve against.
  const twice = stmts(`${ORGS}\n${WIDGETS}\nDROP TABLE widgets;\nDROP TABLE widgets;`)
  assert.deepEqual(sql.unresolvedTableDrops(twice).map((u) => u.table), ['widgets'])
  // …and a drop of a table the history did create resolves.
  assert.deepEqual(sql.unresolvedTableDrops(stmts(`${WIDGETS}\nDROP TABLE widgets;`)), [])
})

test('DROP TABLE CASCADE clears the foreign keys that referenced the table; the referencing table stays', () => {
  const kept = sql.parseColumnFacts(stmts(`${ORGS}\n${NOTES}`)).get('notes').get('org_id')
  assert.equal(kept.references, 'public.orgs')
  assert.equal(kept.onDelete, 'CASCADE')
  const facts = sql.parseColumnFacts(stmts(`${ORGS}\n${NOTES}\nDROP TABLE public.orgs CASCADE;`))
  assert.equal(facts.has('orgs'), false)
  const col = facts.get('notes').get('org_id')
  assert.equal(col.references, null, 'CASCADE removes the referencing constraint')
  assert.equal(col.onDelete, null)
  assert.equal(col.constraint, null)
  assert.equal(col.notNull, true, 'the column itself is untouched')
})

test('DROP TABLE RESTRICT parses as a drop too (it succeeds only when nothing references the table)', () => {
  assert.deepEqual(viewsOf(`${WIDGETS}\nDROP TABLE public.widgets RESTRICT;`, 'widgets').created, false)
  assert.deepEqual(viewsOf(`${WIDGETS}`, 'widgets').created, true)
})

test('DROP TABLE then CREATE TABLE: the new table starts fresh', () => {
  const history = `${ORGS}\n${NOTES}\nDROP TABLE public.notes;\nCREATE TABLE public.notes (id uuid PRIMARY KEY, body text);`
  const s = stmts(history)
  assert.equal(sql.parseCreatedTables(s).has('notes'), true)
  const cols = sql.parseColumnFacts(s).get('notes')
  assert.deepEqual([...cols.keys()].sort(), ['body', 'id'], 'no column survives from the old table')
  assert.deepEqual(
    sql.parseIndexes(s).all.filter((i) => i.table === 'notes').map((i) => i.name),
    ['notes_pkey'],
    'only the new primary key; notes_owner_idx went with the old table',
  )
  const toggles = sql.parseRlsToggles(s)
  assert.equal(toggles.enabled.has('notes'), false)
  assert.equal(toggles.forced.has('notes'), false)
  assert.equal(sql.parseLivePolicies(s).live.has('notes'), false)
  assert.equal(sql.parseTriggers(s).some((t) => t.table === 'notes'), false)
})

test('DROP TABLE of a partitioned table drops its partitions', () => {
  const parent = `CREATE SCHEMA audit;
CREATE TABLE audit.events (id bigint, occurred_at timestamptz NOT NULL) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;`
  assert.equal(sql.parseCreatedTables(stmts(parent)).has('audit.events_default'), true)
  const created = sql.parseCreatedTables(stmts(`${parent}\nDROP TABLE audit.events;`))
  assert.equal(created.has('audit.events'), false)
  assert.equal(created.has('audit.events_default'), false)
})

test('a DROP TABLE inside a function body is dynamic SQL and folds nothing', () => {
  const history = `CREATE SCHEMA audit;
CREATE TABLE audit.events (id bigint) PARTITION BY RANGE (id);
CREATE FUNCTION audit.prune() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TABLE audit.%I', 'events');
END $$;`
  const s = stmts(history)
  assert.equal(sql.parseCreatedTables(s).has('audit.events'), true)
  assert.deepEqual(sql.preFoldHistory(s), s, 'no top-level statement for the fold to read')
})

// ── ALTER POLICY ───────────────────────────────────────────────────────────────

const livePolicy = (history, table, name) => sql.parseLivePolicies(stmts(history)).live.get(table)?.get(name)
const BASE = `${ORGS}\n${NOTES}`

test('ALTER POLICY … USING alone replaces USING and keeps the roles and WITH CHECK', () => {
  const before = livePolicy(BASE, 'notes', 'notes_update_own')
  assert.equal(before.using, 'owner_id = (SELECT auth.uid())')
  const after = livePolicy(
    `${BASE}\nALTER POLICY notes_update_own ON public.notes USING (true);`,
    'notes',
    'notes_update_own',
  )
  assert.equal(after.using, 'true')
  assert.equal(after.check, before.check)
  assert.deepEqual(after.roles, before.roles)
  assert.equal(after.op, 'UPDATE', 'ALTER POLICY cannot change the command')
  assert.equal(after.permissive, 'PERMISSIVE')
})

test('ALTER POLICY … WITH CHECK alone replaces WITH CHECK and keeps the roles and USING', () => {
  const before = livePolicy(BASE, 'notes', 'notes_update_own')
  const after = livePolicy(
    `${BASE}\nALTER POLICY notes_update_own ON public.notes WITH CHECK (owner_id IS NOT NULL);`,
    'notes',
    'notes_update_own',
  )
  assert.equal(after.check, 'owner_id IS NOT NULL')
  assert.equal(after.using, before.using)
  assert.deepEqual(after.roles, before.roles)
})

test('ALTER POLICY … TO alone replaces the roles and keeps both clauses', () => {
  const before = livePolicy(BASE, 'notes', 'notes_update_own')
  assert.deepEqual(before.roles, ['authenticated'])
  const after = livePolicy(
    `${BASE}\nALTER POLICY notes_update_own ON public.notes TO anon, authenticated;`,
    'notes',
    'notes_update_own',
  )
  assert.deepEqual(after.roles, ['anon', 'authenticated'])
  assert.equal(after.using, before.using)
  assert.equal(after.check, before.check)
})

test('ALTER POLICY with every clause replaces all three, and the view gates read moves with it', () => {
  const s = stmts(
    `${BASE}\nALTER POLICY notes_select_own ON public.notes TO anon USING (true);`,
  )
  const byOp = sql.parseLivePolicies(s).policies.get('notes')
  const select = byOp.get('SELECT')
  assert.equal(select.length, 1)
  assert.equal(select[0].using, 'true')
  assert.deepEqual(select[0].roles, ['anon'])
  // The raw per-statement reader is unchanged: it still reports the CREATE as written.
  assert.equal(sql.parsePolicies(s).policies.get('notes').get('SELECT')[0].using, 'owner_id = (SELECT auth.uid())')
})

test('ALTER POLICY … RENAME TO renames the policy and changes nothing else', () => {
  const history = `${BASE}\nALTER POLICY notes_select_own ON public.notes RENAME TO notes_select_mine;`
  const { live } = sql.parseLivePolicies(stmts(history))
  assert.equal(live.get('notes').has('notes_select_own'), false)
  const renamed = live.get('notes').get('notes_select_mine')
  assert.equal(renamed.name, 'notes_select_mine')
  assert.equal(renamed.using, 'owner_id = (SELECT auth.uid())')
  assert.equal(renamed.op, 'SELECT')
  // Without the rename the old name is the live one.
  assert.equal(sql.parseLivePolicies(stmts(BASE)).live.get('notes').has('notes_select_own'), true)
  // A later ALTER resolves against the NEW name; one naming the old name does not.
  const later = sql.parseLivePolicies(
    stmts(`${history}\nALTER POLICY notes_select_mine ON public.notes USING (true);`),
  )
  assert.equal(later.live.get('notes').get('notes_select_mine').using, 'true')
  assert.deepEqual(later.unresolved, [])
  const stale = sql.parseLivePolicies(
    stmts(`${history}\nALTER POLICY notes_select_own ON public.notes USING (true);`),
  )
  assert.deepEqual(
    stale.unresolved.map((u) => `${u.table}.${u.name}`),
    ['notes.notes_select_own'],
  )
})

test('ALTER POLICY on an unknown target is UNRESOLVED and changes nothing', () => {
  // No earlier CREATE at all.
  const none = sql.parseLivePolicies(stmts(`${BASE}\nALTER POLICY ghost ON public.notes USING (true);`))
  assert.deepEqual(none.unresolved.map((u) => u.name), ['ghost'])
  assert.equal(none.live.get('notes').has('ghost'), false)
  // Created, then dropped by DROP POLICY.
  const dropped = sql.parseLivePolicies(
    stmts(
      `${BASE}\nDROP POLICY notes_select_own ON public.notes;\nALTER POLICY notes_select_own ON public.notes USING (true);`,
    ),
  )
  assert.deepEqual(dropped.unresolved.map((u) => u.name), ['notes_select_own'])
  // Created, then its table dropped.
  const tableGone = sql.parseLivePolicies(
    stmts(`${BASE}\nDROP TABLE public.notes;\nALTER POLICY notes_select_own ON public.notes USING (true);`),
  )
  assert.deepEqual(tableGone.unresolved.map((u) => u.name), ['notes_select_own'])
  // …and the same ALTER against a live policy resolves.
  const live = sql.parseLivePolicies(stmts(`${BASE}\nALTER POLICY notes_select_own ON public.notes USING (true);`))
  assert.deepEqual(live.unresolved, [])
})

test('the live fold keeps DROP POLICY and CREATE-after-DROP in statement order', () => {
  const s = stmts(
    `${BASE}\nDROP POLICY notes_select_own ON public.notes;\nCREATE POLICY notes_select_own ON public.notes FOR SELECT TO authenticated USING (false);`,
  )
  const p = sql.parseLivePolicies(s).live.get('notes').get('notes_select_own')
  assert.equal(p.using, 'false', 'the re-created policy is judged, not the dropped one')
  const gone = sql.parseLivePolicies(stmts(`${BASE}\nDROP POLICY IF EXISTS notes_select_own ON public.notes;`))
  assert.equal(gone.live.get('notes').has('notes_select_own'), false)
})

// ── the pre-fold reading the 1.1.0 ramp compares against ─────────────────────────

test('preFoldHistory drops exactly the DROP TABLE and ALTER POLICY statements, in order', () => {
  const s = stmts(
    `${BASE}\nALTER POLICY notes_select_own ON public.notes USING (true);\nDROP TABLE IF EXISTS public.widgets;\nDROP POLICY notes_update_own ON public.notes;`,
  )
  const pre = sql.preFoldHistory(s)
  assert.equal(pre.length, s.length - 2)
  assert.ok(pre.every((x) => !/^(ALTER POLICY|DROP TABLE)\b/i.test(x)))
  assert.ok(pre.some((x) => /^DROP POLICY\b/i.test(x)), 'DROP POLICY was read before 1.1.0 and stays')
  // Over the pre-fold history the fold reads exactly what the 1.0.x parser read.
  assert.equal(sql.parseLivePolicies(pre).live.get('notes').get('notes_select_own').using, 'owner_id = (SELECT auth.uid())')
})
