// In-process proofs for the grant bound, the three-role revoke doctrine and the generated
// privilege assertions in template/base/tools/lib/table-grants.mjs (1.1.0, #74, design R05).
//
// schema-rls and tools/gen-grant-assertions.mjs run as child processes, so the lib coverage
// floor in selftest.yml (--test-coverage-include='template/base/tools/lib/**') cannot see a
// branch only a gate fixture reaches. These cases import the lib itself.
//
// The model: at each CREATE TABLE of a `public` table the DEFAULT-SEEDED fold starts that
// table with every table privilege for anon, authenticated and service_role (Supabase's
// default privileges), and the EXPLICIT fold starts it with none. GRANT and REVOKE then apply
// to both in statement order. PostgreSQL 17 has eight table privileges (MAINTAIN is new in
// 17); 16 and earlier have seven.
// SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
// SOURCE: https://www.postgresql.org/docs/16/functions-info.html
import assert from 'node:assert/strict'
import { test } from 'node:test'
// Namespace imports, so a lib missing one of the new exports reds the case that needs it
// rather than failing the whole file at link time.
import * as sql from '../../template/base/tools/lib/sql-parse.mjs'
import * as grants from '../../template/base/tools/lib/table-grants.mjs'

const stmts = (text) => sql.splitStatements(text)
const fold = (text, major = 17) => grants.foldPrivileges(stmts(text), major)
const policiesOf = (text) => sql.parseLivePolicies(stmts(text)).policies
const held = (f, table, role, which = 'seeded') => [...(f[which].get(table)?.get(role) ?? [])]

const EIGHT = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const SEVEN = EIGHT.slice(0, 7)

const THING = 'CREATE TABLE public.thing (id uuid PRIMARY KEY, owner_id uuid NOT NULL);'
const REVOKE_THREE = `REVOKE ALL ON TABLE public.thing FROM anon;
REVOKE ALL ON TABLE public.thing FROM service_role;
REVOKE ALL ON TABLE public.thing FROM authenticated;`
const OWN_POLICIES = `CREATE POLICY thing_select_own ON public.thing AS PERMISSIVE FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing AS PERMISSIVE FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing AS PERMISSIVE FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));`
const EXACT = 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO authenticated;'
const DOCTRINE_TREE = `${THING}\n${REVOKE_THREE}\n${OWN_POLICIES}\n${EXACT}`

// ── the major version ────────────────────────────────────────────────────────────────────

test('postgresMajor reads [db].major_version, and null when the file does not say', () => {
  assert.equal(grants.postgresMajor('[db]\nport = 54322\nmajor_version = 15\n'), 15)
  assert.equal(grants.postgresMajor('[db]\nmajor_version=17'), 17)
  assert.equal(grants.postgresMajor('[db]\nport = 54322\n'), null)
  assert.equal(grants.postgresMajor(''), null)
})

test('eight table privileges from PostgreSQL 17, seven below it, and 17 when the tree does not say', () => {
  assert.deepEqual(fold(THING, 17).privileges, EIGHT)
  assert.deepEqual(fold(THING, 18).privileges, EIGHT)
  assert.deepEqual(fold(THING, 16).privileges, SEVEN)
  assert.deepEqual(fold(THING, 15).privileges, SEVEN)
  // A tree with no readable major is judged on 17's eight: for the bound, more privileges
  // can only mean more findings.
  assert.deepEqual(fold(THING, null).privileges, EIGHT)
  assert.equal(fold(THING, null).major, 17)
})

// ── the two folds ────────────────────────────────────────────────────────────────────────

test('a public table starts with every privilege for the three roles in the seeded fold, none in the explicit one', () => {
  const f = fold(THING)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.deepEqual(held(f, 'thing', role).sort(), [...EIGHT].sort(), role)
    assert.deepEqual(held(f, 'thing', role, 'explicit'), [], role)
  }
  // Supabase's default privileges are for `public` only: a table elsewhere starts empty in both.
  const audit = fold('CREATE TABLE audit.events (id bigint PRIMARY KEY);')
  assert.deepEqual(held(audit, 'audit.events', 'anon'), [])
  assert.equal(audit.tables.get('audit.events').qualified, 'audit.events')
  assert.equal(audit.tables.get('audit.events').schema, 'audit')
})

test('three revokes then an exact grant: both folds agree', () => {
  const f = fold(DOCTRINE_TREE)
  assert.deepEqual(held(f, 'thing', 'authenticated').sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  assert.deepEqual(held(f, 'thing', 'authenticated', 'explicit').sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  assert.deepEqual(held(f, 'thing', 'anon'), [])
  assert.deepEqual(held(f, 'thing', 'service_role'), [])
  assert.deepEqual(grants.doctrineProblems(f), [])
})

test('the two-revoke shape leaves the default standing for authenticated, and the doctrine names it', () => {
  const f = fold(`${THING}
REVOKE ALL ON TABLE public.thing FROM anon;
REVOKE ALL ON TABLE public.thing FROM service_role;
${EXACT}`)
  assert.deepEqual(held(f, 'thing', 'authenticated').sort(), [...EIGHT].sort())
  assert.deepEqual(held(f, 'thing', 'authenticated', 'explicit').sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  const problems = grants.doctrineProblems(f)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^thing: the platform default still reaches `authenticated`/)
  assert.match(problems[0], /TRUNCATE, REFERENCES, TRIGGER, MAINTAIN/)
  // The exact statements that clear it: revoke the default, re-grant what was granted explicitly.
  assert.ok(problems[0].includes('REVOKE ALL ON TABLE public.thing FROM authenticated;'), problems[0])
  assert.ok(
    problems[0].includes('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO authenticated;'),
    problems[0],
  )
  assert.equal(
    grants.doctrineFixSql(f),
    'REVOKE ALL ON TABLE public.thing FROM authenticated;\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO authenticated;\n',
  )
})

test('a table that never revokes from service_role fails the doctrine for service_role', () => {
  const f = fold(`${THING}
REVOKE ALL ON TABLE public.thing FROM anon;
REVOKE ALL ON TABLE public.thing FROM authenticated;
${EXACT}`)
  const problems = grants.doctrineProblems(f)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^thing: the platform default still reaches `service_role`/)
  // service_role keeps nothing it was granted explicitly, so the fix is the revoke alone.
  assert.ok(problems[0].includes('REVOKE ALL ON TABLE public.thing FROM service_role;'), problems[0])
  assert.ok(!problems[0].includes('TO service_role;'), problems[0])
})

test('an explicit, ADR-style service_role grant after the revoke satisfies the doctrine without judging it against policies', () => {
  const f = fold(`${DOCTRINE_TREE}\nGRANT SELECT, DELETE ON TABLE public.thing TO service_role;`)
  assert.deepEqual(grants.doctrineProblems(f), [])
  assert.deepEqual(grants.grantBoundProblems(f, policiesOf(DOCTRINE_TREE), new Map()), [])
})

test('a schema-wide REVOKE early in the history does not clear a table created later', () => {
  const f = fold(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
${THING}
REVOKE ALL ON TABLE public.thing FROM anon;
REVOKE ALL ON TABLE public.thing FROM service_role;
${EXACT}`)
  assert.deepEqual(held(f, 'thing', 'authenticated').sort(), [...EIGHT].sort())
  assert.match(grants.doctrineProblems(f).join('\n'), /thing: the platform default still reaches `authenticated`/)
  // …and the same statement AFTER the CREATE does reach it.
  const after = fold(`${THING}
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
${EXACT}`)
  assert.deepEqual(grants.doctrineProblems(after), [])
  // A schema-wide statement reaches only tables in THAT schema.
  const other = fold(`${THING}\nCREATE TABLE audit.events (id bigint);\nGRANT SELECT ON ALL TABLES IN SCHEMA audit TO anon;`)
  assert.deepEqual(held(other, 'audit.events', 'anon'), ['SELECT'])
  assert.ok(!held(other, 'thing', 'anon', 'explicit').includes('SELECT'))
})

test('GRANT … WITH GRANT OPTION grants to the role, never to a role named "authenticated with grant option"', () => {
  const f = fold(`${THING}\n${REVOKE_THREE}\nGRANT ALL ON TABLE public.thing TO authenticated WITH GRANT OPTION;`)
  assert.deepEqual(held(f, 'thing', 'authenticated').sort(), [...EIGHT].sort())
  assert.equal(f.seeded.get('thing').has('authenticated with grant option'), false)
  // GRANTED BY is read off too, and so are CASCADE and GROUP.
  const by = fold(`${THING}\n${REVOKE_THREE}
GRANT SELECT ON TABLE public.thing TO GROUP authenticated WITH GRANT OPTION GRANTED BY postgres;
REVOKE SELECT ON TABLE public.thing FROM authenticated GRANTED BY postgres CASCADE;
GRANT INSERT ON TABLE public.thing TO anon;`)
  assert.deepEqual(held(by, 'thing', 'authenticated'), [])
  assert.deepEqual(held(by, 'thing', 'anon'), ['INSERT'])
})

test('REVOKE GRANT OPTION FOR takes the option away and leaves the privilege', () => {
  const f = fold(`${DOCTRINE_TREE}\nREVOKE GRANT OPTION FOR SELECT ON TABLE public.thing FROM authenticated;`)
  assert.ok(held(f, 'thing', 'authenticated').includes('SELECT'))
})

test('one statement naming two tables reaches both', () => {
  const f = fold(`${THING}\nCREATE TABLE public.other (id uuid);\nREVOKE ALL ON TABLE public.thing, public.other FROM anon;`)
  assert.deepEqual(held(f, 'thing', 'anon'), [])
  assert.deepEqual(held(f, 'other', 'anon'), [])
})

test('a column-level grant is held for the bound, and a table-level REVOKE takes it back', () => {
  const f = fold(`${DOCTRINE_TREE}\nGRANT SELECT (id, owner_id) ON TABLE public.thing TO anon;`)
  assert.deepEqual(held(f, 'thing', 'anon'), [])
  assert.deepEqual([...f.columns.get('thing').get('anon')], ['SELECT'])
  const problems = grants.grantBoundProblems(f, policiesOf(DOCTRINE_TREE), new Map())
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^thing: `anon` holds SELECT \(on columns\) on public\.thing/)
  const revoked = fold(`${DOCTRINE_TREE}
GRANT SELECT (id) ON TABLE public.thing TO anon;
REVOKE SELECT ON TABLE public.thing FROM anon;`)
  assert.deepEqual([...(revoked.columns.get('thing').get('anon') ?? [])], [])
  const colRevoked = fold(`${DOCTRINE_TREE}
GRANT SELECT (id) ON TABLE public.thing TO anon;
REVOKE SELECT (id) ON TABLE public.thing FROM anon;`)
  assert.deepEqual([...(colRevoked.columns.get('thing').get('anon') ?? [])], [])
})

test('DROP TABLE forgets a table, and a re-created one starts from the default again', () => {
  const f = fold(`${DOCTRINE_TREE}\nDROP TABLE public.thing;`)
  assert.equal(f.tables.has('thing'), false)
  const again = fold(`${DOCTRINE_TREE}\nDROP TABLE public.thing;\n${THING}`)
  assert.deepEqual(held(again, 'thing', 'authenticated').sort(), [...EIGHT].sort())
  assert.deepEqual(held(again, 'thing', 'authenticated', 'explicit'), [])
  // CREATE TABLE IF NOT EXISTS of a table that exists is a no-op, in the database and here.
  const noop = fold(`${DOCTRINE_TREE}\nCREATE TABLE IF NOT EXISTS public.thing (id uuid);`)
  assert.deepEqual(grants.doctrineProblems(noop), [])
})

test('statements about functions, schemas, sequences and role membership are not table privileges', () => {
  const f = fold(`${DOCTRINE_TREE}
GRANT EXECUTE ON FUNCTION public.f(uuid) TO anon;
GRANT EXECUTE ON public.g(uuid) TO anon;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.thing_id_seq TO anon;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
GRANT app_role TO postgres;
GRANT SELECT ON TABLE auth.users TO anon;`)
  assert.deepEqual(held(f, 'thing', 'anon'), [])
  assert.deepEqual(f.unread, [])
  // auth.users is no table a migration creates, so it is outside the fold.
  assert.equal(f.tables.has('auth.users'), false)
})

test('a GRANT the fold cannot read is reported, never skipped', () => {
  // splitStatements unwraps the quotes, and a hyphen is no character the grant parse reads:
  // skipping the statement would hide a privilege, so it is listed instead.
  const f = fold(`${DOCTRINE_TREE}\nCREATE TABLE public."my-table" (id uuid);\nGRANT ALL ON TABLE public."my-table" TO anon;`)
  assert.equal(f.unread.length, 1)
  assert.match(f.unread[0], /the grant bound cannot read `GRANT ALL ON TABLE public\.my-table TO anon`/)
  // …and the generator refuses to render on a history it could not read.
  const { text, refusal } = grants.renderGrantAssertions(f)
  assert.equal(text, null)
  assert.match(refusal, /cannot read/)
})

// ── the bound ────────────────────────────────────────────────────────────────────────────

test('a grant behind a deny-all policy is wider than the policies', () => {
  const tree = `${THING}\n${REVOKE_THREE}
CREATE POLICY thing_select_own ON public.thing FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_none ON public.thing FOR INSERT TO authenticated WITH CHECK (false);
GRANT SELECT, INSERT ON TABLE public.thing TO authenticated;`
  const problems = grants.grantBoundProblems(fold(tree), policiesOf(tree), new Map())
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^thing: `authenticated` holds INSERT on public\.thing, which no policy admits/)
  assert.ok(problems[0].includes('REVOKE ALL ON TABLE public.thing FROM authenticated;'), problems[0])
  assert.ok(problems[0].includes('GRANT SELECT ON TABLE public.thing TO authenticated;'), problems[0])
})

test('GRANT ALL hands out four privileges no policy can admit', () => {
  const tree = `${THING}\n${REVOKE_THREE}\n${OWN_POLICIES}\nGRANT ALL ON TABLE public.thing TO authenticated;`
  const problems = grants.grantBoundProblems(fold(tree), policiesOf(tree), new Map())
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /holds TRUNCATE, REFERENCES, TRIGGER, MAINTAIN on public\.thing, which no policy admits/)
  // On PostgreSQL 15 there is no MAINTAIN to hold.
  const on15 = grants.grantBoundProblems(fold(tree, 15), policiesOf(tree), new Map())
  assert.match(on15[0], /holds TRUNCATE, REFERENCES, TRIGGER on public\.thing,/)
})

test('what admits a privilege: PERMISSIVE, that operation or ALL, the role or public or none, not literally false', () => {
  const tree = (pol) => `${THING}\n${REVOKE_THREE}\n${pol}\nGRANT SELECT ON TABLE public.thing TO anon;`
  const judge = (pol) => grants.grantBoundProblems(fold(tree(pol)), policiesOf(tree(pol)), new Map())
  const admitted = [
    'CREATE POLICY p ON public.thing FOR SELECT TO anon USING (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR ALL TO anon USING (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR SELECT TO public USING (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR SELECT USING (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR SELECT TO authenticated, anon USING (true);',
  ]
  for (const pol of admitted) assert.deepEqual(judge(pol), [], pol)
  const refused = [
    'CREATE POLICY p ON public.thing AS RESTRICTIVE FOR SELECT TO anon USING (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR INSERT TO anon WITH CHECK (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR SELECT TO authenticated USING (owner_id IS NULL);',
    'CREATE POLICY p ON public.thing FOR SELECT TO anon USING (false);',
    'CREATE POLICY p ON public.thing FOR ALL TO anon USING (owner_id IS NULL) WITH CHECK ((false));',
  ]
  for (const pol of refused) assert.equal(judge(pol).length, 1, pol)
})

test('a privilege held through PUBLIC is held by anon, and the fix revokes it from PUBLIC', () => {
  const tree = `${THING}\n${REVOKE_THREE}\n${OWN_POLICIES}\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO PUBLIC;`
  const problems = grants.grantBoundProblems(fold(tree), policiesOf(tree), new Map())
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^thing: `anon` holds SELECT, INSERT, UPDATE, DELETE on public\.thing \(through PUBLIC\), which no policy admits/)
  assert.ok(problems[0].includes('REVOKE ALL ON TABLE public.thing FROM PUBLIC;'), problems[0])
  // authenticated's policies admit all four, so authenticated is not reported.
  assert.ok(!problems.join('\n').includes('`authenticated` holds'))
})

test('service_role is never bounded: it bypasses row security, so no policy is expected', () => {
  const tree = `${DOCTRINE_TREE}\nGRANT ALL ON TABLE public.thing TO service_role;`
  assert.deepEqual(grants.grantBoundProblems(fold(tree), policiesOf(tree), new Map()), [])
})

test('an allow row excuses exactly its (table, role, privilege), and a stale one is a finding', () => {
  const tree = `${THING}\n${REVOKE_THREE}\n${OWN_POLICIES}\n${EXACT}\nGRANT TRIGGER ON TABLE public.thing TO authenticated;`
  const f = fold(tree)
  const read = grants.grantAllowRows(
    {
      comment: 'x',
      allow: [
        { table: 'thing', role: 'authenticated', privilege: 'TRIGGER', reason: 'a reviewed reason' },
        { table: 'public.thing', role: 'anon', privilege: 'SELECT', reason: 'no longer granted' },
        { table: 'thing', role: 'authenticated', privilege: 'SELECT', reason: 'a policy admits this' },
      ],
    },
    f.privileges,
  )
  assert.deepEqual(read.problems, [])
  const problems = grants.grantBoundProblems(f, policiesOf(tree), read.rows)
  assert.equal(problems.length, 2, problems.join('\n'))
  assert.match(problems.join('\n'), /allows \(thing, anon, SELECT\), but `anon` does not hold SELECT on public\.thing/)
  assert.match(problems.join('\n'), /allows \(thing, authenticated, SELECT\), but a policy already admits it/)
  assert.doesNotMatch(problems.join('\n'), /holds TRIGGER/)
})

test('the allow list is reviewable data: its shape fails loud, and a key may appear once', () => {
  const privs = EIGHT
  assert.match(grants.grantAllowRows([], privs).problems[0], /must carry an "allow" ARRAY/)
  assert.match(grants.grantAllowRows({ allow: {} }, privs).problems[0], /must carry an "allow" ARRAY/)
  const bad = grants.grantAllowRows(
    {
      allow: [
        { table: 'thing', role: 'service_role', privilege: 'TRIGGER', reason: 'x' },
        { table: 'thing', role: 'anon', privilege: 'EXECUTE', reason: 'x' },
        { table: 'thing', role: 'anon', privilege: 'TRIGGER', reason: ' ' },
        { table: 'thing', role: 'anon', privilege: 'trigger', reason: 'x' },
        { table: 'thing', role: 'anon', privilege: 'TRIGGER', reason: 'again' },
        null,
      ],
    },
    privs,
  )
  assert.equal(bad.problems.length, 5, bad.problems.join('\n'))
  assert.match(bad.problems.join('\n'), /names \(thing, anon, TRIGGER\) twice/)
  // A lower-case privilege is read as its upper-case name, so the fourth row is the key the
  // fifth repeats.
  assert.equal(bad.rows.size, 1)
  // MAINTAIN is no privilege on PostgreSQL 15.
  assert.equal(grants.grantAllowRows({ allow: [{ table: 't', role: 'anon', privilege: 'MAINTAIN', reason: 'x' }] }, SEVEN).problems.length, 1)
})

// ── the generated assertions ─────────────────────────────────────────────────────────────

test('the render is one is_empty over every table, role and privilege, sorted by code unit', () => {
  // audit_x.events sorts AFTER audit.events by code unit ('.' is 0x2E, '_' is 0x5F) and
  // BEFORE it under localeCompare, so this history tells the two orders apart.
  const tree = `CREATE TABLE audit_x.events (id bigint);
REVOKE ALL ON TABLE audit_x.events FROM anon, authenticated, service_role;
CREATE TABLE audit.events (id bigint);
REVOKE ALL ON TABLE audit.events FROM anon, authenticated, service_role;
${DOCTRINE_TREE}
CREATE TABLE public.zed (id uuid);
REVOKE ALL ON TABLE public.zed FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.zed TO PUBLIC;`
  const { text, refusal } = grants.renderGrantAssertions(fold(tree))
  assert.equal(refusal, null)
  assert.match(text, /^-- supabase\/tests\/rls_grants\.generated\.test\.sql — GENERATED by tools\/gen-grant-assertions\.mjs/)
  assert.match(text, /SELECT plan\(1\);/)
  assert.equal((text.match(/is_empty\(/g) ?? []).length, 1)
  const rows = [...text.matchAll(/^\s+\('([^']+)', '([a-z_]+)', '([A-Z]+)', (true|false)\)/gm)].map((m) => m.slice(1))
  // four tables x three roles x eight privileges
  assert.equal(rows.length, 4 * 3 * 8)
  const keys = rows.map((r) => r.slice(0, 3).join('\u0000'))
  assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  assert.equal(rows[0][0], 'audit.events')
  assert.equal(rows[3 * 8][0], 'audit_x.events')
  const expect = (t, role, p) => rows.find((r) => r[0] === t && r[1] === role && r[2] === p)[3]
  assert.equal(expect('public.thing', 'authenticated', 'SELECT'), 'true')
  assert.equal(expect('public.thing', 'authenticated', 'TRUNCATE'), 'false')
  assert.equal(expect('public.thing', 'anon', 'SELECT'), 'false')
  assert.equal(expect('audit.events', 'service_role', 'SELECT'), 'false')
  // has_table_privilege counts a grant to PUBLIC for every role, so the expectation does too.
  assert.equal(expect('public.zed', 'anon', 'SELECT'), 'true')
  assert.equal(expect('public.zed', 'service_role', 'SELECT'), 'true')
  // Byte-stable: the same history renders the same bytes.
  assert.equal(grants.renderGrantAssertions(fold(tree)).text, text)
})

test('a major_version = 15 tree renders seven privileges, and says which major it rendered for', () => {
  const { text } = grants.renderGrantAssertions(fold(DOCTRINE_TREE, 15))
  assert.doesNotMatch(text, /MAINTAIN/)
  assert.match(text, /PostgreSQL 15/)
  assert.equal([...text.matchAll(/^\s+\('public\.thing', 'anon', '([A-Z]+)'/gm)].length, 7)
  const { text: on17 } = grants.renderGrantAssertions(fold(DOCTRINE_TREE, 17))
  assert.match(on17, /'MAINTAIN'/)
})

test('the render refuses while any table fails the doctrine, naming the tables, and on an empty table set', () => {
  const tree = `${THING}\nCREATE TABLE public.other (id uuid);\nREVOKE ALL ON TABLE public.other FROM anon, authenticated, service_role;`
  const { text, refusal } = grants.renderGrantAssertions(fold(tree))
  assert.equal(text, null)
  assert.match(refusal, /1 table\(s\) fail the three-role revoke doctrine: thing/)
  const empty = grants.renderGrantAssertions(fold('CREATE INDEX x ON public.y (id);'))
  assert.equal(empty.text, null)
  assert.match(empty.refusal, /no migration creates a table/)
})
