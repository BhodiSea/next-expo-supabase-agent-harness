// Can-fail proofs for the schema-rls gate (template/base/tools/check-rls-manifest.mjs).
// The gate was ported from a Drizzle lineage to Supabase in W3: tables are discovered
// from supabase/schemas/*.sql, RLS facts from supabase/migrations/*.sql, and the runtime
// matrix is closed over TWO registries (tests/rls/db-context.ts ISOLATION_TARGETS and the
// pgTAP rls_targets in supabase/tests/rls_structure.test.sql). An early regex version was
// vacuous against `AS PERMISSIVE`; every rule here is fixture-driven — build a
// scaffold-shaped tree, run the real gate with cwd inside it, assert the exact red/green.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-rls-manifest.mjs', import.meta.url),
)
const STACK_SUPABASE = fileURLToPath(new URL('../../template/stack/supabase', import.meta.url))
const SHIPPED_DB_CONTEXT = fileURLToPath(
  new URL('../../template/base/tests/rls/db-context.ts', import.meta.url),
)
const SHIPPED_DEFINER_ALLOW = fileURLToPath(
  new URL('../../template/base/tools/security-definer-allow.json', import.meta.url),
)
const SHIPPED_EXEMPT = fileURLToPath(
  new URL('../../template/base/tools/rls-exempt.json', import.meta.url),
)

const EXEMPT_EMPTY = '{"comment":"x","exempt":[]}\n'

// A minimal owner-scoped table whose owner column is a SEPARATE indexed column
// (owner_id), the notes shape. Overridable pieces let each RED case perturb one rule.
/**
 * @param {{enable?: string, force?: string, index?: string, usingSelect?: string, policies?: string, grants?: string, extra?: string}} [o]
 */
function migration(o = {}) {
  const {
    enable = 'ALTER TABLE public.thing ENABLE ROW LEVEL SECURITY;',
    force = 'ALTER TABLE public.thing FORCE ROW LEVEL SECURITY;',
    index = 'CREATE INDEX thing_owner_idx ON public.thing (owner_id, created_at DESC);',
    usingSelect = 'USING (owner_id = (SELECT auth.uid()))',
    policies,
    // The GRANT the 0.6.0 policy→grant closure requires. It is a DEFAULT rather than
    // part of the fixed prelude because the whole point of the check is that its absence
    // is invisible: every fixture in this file predates it and every one of them passed.
    grants = 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO authenticated;',
    extra = '',
  } = o
  const pols =
    policies ??
    `CREATE POLICY thing_select_own ON public.thing AS PERMISSIVE FOR SELECT TO authenticated ${usingSelect};
CREATE POLICY thing_insert_own ON public.thing AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing AS PERMISSIVE FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing AS PERMISSIVE FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));`
  return `CREATE TABLE public.thing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
${index}
${enable}
${force}
${pols}
${grants}
${extra}`
}

const SCHEMA_THING =
  'CREATE TABLE public.thing (\n  id uuid PRIMARY KEY,\n  owner_id uuid NOT NULL\n);\n'
const structure = (rows) =>
  `BEGIN;\nCREATE TEMPORARY TABLE rls_targets (table_name text PRIMARY KEY, owner_column text NOT NULL);\nINSERT INTO rls_targets (table_name, owner_column) VALUES\n  ${rows};\nROLLBACK;\n`
const dbctx = (targets) => `export const ISOLATION_TARGETS = [${targets}] as const\n`

const THING_TARGET = "{ table: 'thing', ownerColumn: 'owner_id' }"
const THING_STRUCT = "('thing', 'owner_id')"

// schema/migration/structure/dbContext each override a slice; `shipped: true` copies the
// REAL supabase/ tree instead (the scaffold-passes-untouched regression guard).
function fixture({
  schema = SCHEMA_THING,
  migration: mig = migration(),
  exempt = EXEMPT_EMPTY,
  dbContext = dbctx(THING_TARGET),
  structureRows = THING_STRUCT,
  definerAllow = '{"comment":"x","allow":[]}\n',
  configToml = null,
  shipped = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-rlsgate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'tests/rls'), { recursive: true })
  writeFileSync(join(dir, 'tools/rls-exempt.json'), exempt)
  if (shipped) {
    // The REAL registries, not fixture stand-ins. A shipped-scaffold regression test
    // that supplies its own ISOLATION_TARGETS and definer allowlist is not tracking
    // the shipped tree at all — it would stay green through exactly the drift it
    // exists to catch.
    cpSync(SHIPPED_DB_CONTEXT, join(dir, 'tests/rls/db-context.ts'))
    cpSync(SHIPPED_DEFINER_ALLOW, join(dir, 'tools/security-definer-allow.json'))
    // The REAL exemption list too, for the same reason as the two above: the shipped
    // tree's audit trail is exempt from THIS gate's per-operation model on purpose
    // (an append-only table must have no UPDATE or DELETE policy), and substituting an
    // empty list here would make the test assert a tree nobody ships.
    cpSync(SHIPPED_EXEMPT, join(dir, 'tools/rls-exempt.json'))
    cpSync(STACK_SUPABASE, join(dir, 'supabase'), { recursive: true })
  } else {
    writeFileSync(join(dir, 'tools/security-definer-allow.json'), definerAllow)
    writeFileSync(join(dir, 'tests/rls/db-context.ts'), dbContext)
    mkdirSync(join(dir, 'supabase/schemas'), { recursive: true })
    mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
    mkdirSync(join(dir, 'supabase/tests'), { recursive: true })
    writeFileSync(join(dir, 'supabase/schemas/10_thing.sql'), schema)
    if (mig !== null) writeFileSync(join(dir, 'supabase/migrations/0001_thing.sql'), mig)
    writeFileSync(join(dir, 'supabase/tests/rls_structure.test.sql'), structure(structureRows))
  }
  if (configToml !== null) writeFileSync(join(dir, 'supabase/config.toml'), configToml)
  return dir
}

function runGate(dir) {
  const res = spawnSync('node', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the untouched shipped supabase/ scaffold passes (profiles inline-PK + notes)', () => {
  const r = runGate(fixture({ shipped: true }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: minimal owner-scoped table with a separate leading index', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
})

test('GREEN: an INLINE primary key on the owner column satisfies the index rule', () => {
  // owner column IS `id`, indexed by the inline PRIMARY KEY — no separate CREATE INDEX
  // (the public.profiles shape).
  const mig = `CREATE TABLE public.thing (
  id uuid PRIMARY KEY,
  display_name text NOT NULL DEFAULT ''
);
ALTER TABLE public.thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thing FORCE ROW LEVEL SECURITY;
CREATE POLICY thing_select_own ON public.thing FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing FOR DELETE TO authenticated USING (id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO authenticated;`
  const r = runGate(
    fixture({
      migration: mig,
      dbContext: dbctx("{ table: 'thing', ownerColumn: 'id' }"),
      structureRows: "('thing', 'id')",
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: dropping one per-operation policy fails naming the op (the AS PERMISSIVE vacuity regression)', () => {
  const pols = `CREATE POLICY thing_select_own ON public.thing AS PERMISSIVE FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing AS PERMISSIVE FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));`
  const r = runGate(fixture({ migration: migration({ policies: pols }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FOR DELETE'), r.out)
})

test('RED: USING (true) is a vacuous predicate', () => {
  const r = runGate(fixture({ migration: migration({ usingSelect: 'USING (true)' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('vacuous'), r.out)
})

test('RED: a per-row identity call without the initPlan sub-select', () => {
  const r = runGate(
    fixture({ migration: migration({ usingSelect: 'USING (owner_id = auth.uid())' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('per row'), r.out)
})

test('RED: no ENABLE/FORCE ROW LEVEL SECURITY', () => {
  const r = runGate(fixture({ migration: migration({ enable: '', force: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no ENABLE') && r.out.includes('no FORCE'), r.out)
})

test('RED: a migration-created table not declared in supabase/schemas', () => {
  const r = runGate(
    fixture({ migration: `${migration()}\nCREATE TABLE public.widgets (id uuid PRIMARY KEY);\n` }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('widgets') && r.out.includes('not declared'), r.out)
})

test('RED: an isolation target with no owner-column index in any migration', () => {
  const r = runGate(fixture({ migration: migration({ index: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index with leading column owner_id'), r.out)
})

test('RED: an index with the owner column in SECOND position does not count (leading-column rule)', () => {
  const r = runGate(
    fixture({
      migration: migration({ index: 'CREATE INDEX thing_cover ON public.thing (id, owner_id);' }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index with leading column owner_id'), r.out)
})

test('RED: a declared table absent from ISOLATION_TARGETS (client-suite closure)', () => {
  const r = runGate(fixture({ dbContext: dbctx('') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ISOLATION_TARGETS'), r.out)
})

test('RED: a declared table absent from the pgTAP rls_targets registry', () => {
  const r = runGate(fixture({ structureRows: "('other', 'owner_id')" }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('rls_targets'), r.out)
})

test('RED: a stale ISOLATION_TARGETS row naming a table no schema declares (two-way closure)', () => {
  const r = runGate(
    fixture({ dbContext: dbctx(`${THING_TARGET}, { table: 'ghost', ownerColumn: 'owner_id' }`) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ghost') && r.out.includes('stale target'), r.out)
})

test('RED: the two registries disagree on the owner column', () => {
  const r = runGate(fixture({ structureRows: "('thing', 'id')" }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('disagree'), r.out)
})

test('exemptions: canonical entries work; malformed entries fail LOUD, never open', () => {
  // A fully-uncovered second table passes when exempted with a reviewed reason.
  const green = runGate(
    fixture({
      schema: `${SCHEMA_THING}CREATE TABLE public.country_codes (code text PRIMARY KEY);\n`,
      exempt: JSON.stringify({
        comment: 'x',
        exempt: [{ table: 'country_codes', reason: 'static reference data, no user rows' }],
      }),
    }),
  )
  assert.equal(green.code, 0, green.out)

  // Missing reason → the gate itself fails (the escape hatch cannot fail open).
  const noReason = runGate(
    fixture({ exempt: JSON.stringify({ comment: 'x', exempt: [{ table: 'country_codes' }] }) }),
  )
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('reason'), noReason.out)

  // Legacy/wrong shape (object map instead of array) → loud fail with the expected shape.
  const wrongShape = runGate(fixture({ exempt: JSON.stringify({ tables: { thing: 'nope' } }) }))
  assert.equal(wrongShape.code, 1, wrongShape.out)
  assert.ok(wrongShape.out.includes('ARRAY'), wrongShape.out)
})

// ---------------------------------------------------------------------------
// 0.2.0 — the four checks this gate provably did not have.
//
// Each RED case below was GREEN on the 0.1.3 gate. That is the point of the block:
// the injections are not hypothetical shapes, they are the specific SQL an agent can
// write today that turns RLS off, defeats the initPlan rule, or escalates privilege,
// while every gate in the chain reports the tree fully covered.
// ---------------------------------------------------------------------------

test('RED (0.2.0): a later migration DISABLEs row level security', () => {
  // GREEN on 0.1.3: the gate collected ENABLE and FORCE and matched no negation, so
  // `thing` stayed in the enabled set forever.
  const r = runGate(
    fixture({ migration: `${migration()}\nALTER TABLE public.thing DISABLE ROW LEVEL SECURITY;` }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RLS is DISABLED'), r.out)
  assert.ok(r.out.includes('0001_thing.sql'), 'must name the migration file, not just the table')
})

test('RED (0.2.0): NO FORCE ROW LEVEL SECURITY removes the owner coverage', () => {
  const r = runGate(
    fixture({
      migration: `${migration()}\nALTER TABLE public.thing NO FORCE ROW LEVEL SECURITY;`,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('NO FORCE'), r.out)
})

test('RED (0.2.0): DISABLE TRIGGER silently stops whatever the trigger enforced', () => {
  const r = runGate(
    fixture({ migration: `${migration()}\nALTER TABLE public.thing DISABLE TRIGGER thing_audit;` }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('triggers are DISABLED'), r.out)
})

test('RED (0.2.0): a correlated EXISTS predicate — the shape that passed every 0.1.3 check', () => {
  // This satisfies the vacuity check (not `true`) AND the initPlan regex (it does
  // contain `(select ... auth.uid()`), and is a per-row SubPlan that re-enters
  // public.other's own policies.
  const r = runGate(
    fixture({
      migration: migration({
        usingSelect:
          'USING (EXISTS (SELECT 1 FROM public.other o WHERE o.thing_id = thing.id AND o.user_id = (SELECT auth.uid())))',
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('correlated SubPlan'), r.out)
})

test('GREEN (0.2.0): the uncorrelated scalar-helper form is the one that hoists', () => {
  const helper =
    "CREATE FUNCTION private.member_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT array_agg(org_id) FROM public.memberships WHERE user_id = (SELECT auth.uid()) $$;"
  const r = runGate(
    fixture({
      migration: migration({
        extra: helper,
        usingSelect: 'USING (owner_id = ANY((SELECT private.member_org_ids())::uuid[]))',
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED (0.2.0): moving auth.uid() into a helper called BARE no longer vacates the initPlan rule', () => {
  // GREEN on 0.1.3: the predicate text contained no identity call at all, so the
  // per-row check had nothing to look at.
  const helper =
    'CREATE FUNCTION public.current_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;'
  const r = runGate(
    fixture({
      migration: migration({
        extra: helper,
        usingSelect: 'USING (owner_id = public.current_uid())',
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('per row'), r.out)
})

test('GREEN (0.2.0): the SAME helper wrapped in a scalar sub-select passes — resolution is positional', () => {
  const helper =
    'CREATE FUNCTION public.current_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;'
  const r = runGate(
    fixture({
      migration: migration({
        extra: helper,
        usingSelect: 'USING (owner_id = (SELECT public.current_uid()))',
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED (0.2.0): SECURITY DEFINER with no reviewed allowlist entry', () => {
  const fn =
    "CREATE FUNCTION public.escalate() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;"
  const r = runGate(fixture({ migration: migration({ extra: fn }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('security-definer-allow.json'), r.out)
})

test('RED (0.2.0): an allowlisted SECURITY DEFINER that does not pin search_path', () => {
  const fn =
    'CREATE FUNCTION public.escalate() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;'
  const r = runGate(
    fixture({
      migration: migration({ extra: fn }),
      definerAllow: JSON.stringify({
        comment: 'x',
        allow: [{ function: 'public.escalate', reason: 'reviewed' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('search_path'), r.out)
})

test('RED (0.2.0): a SECURITY DEFINER that accepts who-am-I as an argument', () => {
  const fn =
    "CREATE FUNCTION public.rows_for(_user_id uuid) RETURNS setof public.thing LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT * FROM public.thing $$;"
  const r = runGate(
    fixture({
      migration: migration({ extra: fn }),
      definerAllow: JSON.stringify({
        comment: 'x',
        allow: [{ function: 'public.rows_for', reason: 'reviewed' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('identity-shaped parameter'), r.out)
})

test('RED (0.2.0): EXECUTE to authenticated on an UNREVIEWED definer function', () => {
  // EXECUTE to authenticated is how a PostgREST RPC is reached at all — PostgREST
  // switches to the JWT's role before calling, so there is no "dedicated role"
  // alternative. It is therefore legal, but only as a recorded decision.
  const fn = `CREATE FUNCTION public.priv() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.priv() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.priv() TO authenticated;`
  const r = runGate(fixture({ migration: migration({ extra: fn }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('EXECUTE granted to authenticated'), r.out)
  assert.ok(r.out.includes('no entry in'), r.out)
})

test('RED (0.2.0): a definer function with NO grant statements is anon-callable by default', () => {
  // THE FAILURE MODE THE OLD RULE COULD NOT SEE. PostgreSQL grants EXECUTE to PUBLIC
  // on every new function and Supabase's default privileges additionally grant anon,
  // so a migration that mentions no grants at all still ships an anon-callable
  // privilege-escalation primitive. A gate that only inspects GRANT statements reads
  // that migration as clean. The REVOKE is the only evidence a migration can carry.
  const fn =
    "CREATE FUNCTION public.priv() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;"
  const r = runGate(
    fixture({
      migration: migration({ extra: fn }),
      definerAllow: JSON.stringify({
        comment: 'x',
        allow: [{ function: 'public.priv', reason: 'reviewed for this fixture' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('REVOKE EXECUTE'), r.out)
})

test('RED (0.2.0): EXECUTE granted to anon is never legal, allowlisted or not', () => {
  const fn = `CREATE FUNCTION public.priv() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.priv() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.priv() TO anon;`
  const r = runGate(
    fixture({
      migration: migration({ extra: fn }),
      definerAllow: JSON.stringify({
        comment: 'x',
        allow: [{ function: 'public.priv', reason: 'reviewed for this fixture' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('EXECUTE granted to anon'), r.out)
})

test('GREEN (0.2.0): a reviewed, revoked, search_path-pinned definer RPC passes', () => {
  const fn = `CREATE FUNCTION public.org_members(p_org_id uuid) RETURNS setof public.thing LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT * FROM public.thing $$;
REVOKE ALL ON FUNCTION public.org_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members(uuid) TO authenticated;`
  const r = runGate(
    fixture({
      migration: migration({ extra: fn }),
      definerAllow: JSON.stringify({
        comment: 'x',
        allow: [
          {
            function: 'public.org_members',
            reason:
              'the colleague directory read; verifies the callers own membership from auth.uid() before returning rows',
          },
        ],
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED (0.2.0): a non-public table whose schema is published by PostgREST', () => {
  // The audit trail is kept out of `public` precisely so PostgREST cannot reach it.
  // Listing that schema in [api].schemas gives the rows back to every caller.
  const r = runGate(
    fixture({
      schema: `${SCHEMA_THING}CREATE TABLE audit.events (id bigint PRIMARY KEY);\n`,
      exempt: JSON.stringify({
        comment: 'x',
        exempt: [{ table: 'audit.events', reason: 'append-only trail, no per-caller policy' }],
      }),
      configToml: 'project_id = "x"\n\n[api]\nenabled = true\nschemas = ["public", "audit"]\n',
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('[api].schemas'), r.out)
})

// ---------------------------------------------------------------------------
// 0.6.0 — the POLICY → GRANT closure.
//
// Table privileges are checked BEFORE row security, so a policy naming a role that holds
// no privilege on the table is unreachable code. This gate has parsed grants since 0.2.0
// and consumed only the FUNCTION half; the table half was dead output. Every fixture above
// shipped without a single GRANT statement and every one of them was green — which is
// exactly the shape of the defect, because Supabase's default privileges hand
// anon/authenticated/service_role their privileges on every new table in `public` and
// therefore make the omission work. Those defaults stop applying to projects created on or
// after 2026-10-30.
//
// The ramp is INERT in these fixtures: rampNote returns false when there is no
// .harness/manifest.json, so what a fixture sees is the strict form a fresh install sees.
// ---------------------------------------------------------------------------

test('RED (0.6.0): four policies, four registries, and no GRANT — green until now', () => {
  const r = runGate(fixture({ migration: migration({ grants: '' }) }))
  assert.equal(r.code, 1, r.out)
  // One finding per operation, because the missing privilege is per-operation.
  for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.ok(r.out.includes(`FOR ${op}, but no migration GRANTs ${op}`), `${op}: ${r.out}`)
  }
  // The message must carry the DATE and the code, because the reader of this red has a
  // tree that works today and will not work in a project created after the flip.
  assert.ok(r.out.includes('2026-10-30'), r.out)
  assert.ok(r.out.includes('42501'), r.out)
  // And the exact statement that discharges it — a finding a reader has to translate
  // into SQL is a finding they will translate wrongly.
  assert.ok(r.out.includes('GRANT SELECT ON TABLE public.thing TO authenticated;'), r.out)
})

test('RED (0.6.0): the SHIPPED tree with one GRANT line deleted — the green above is not vacuous', () => {
  // The strongest form of the proof: not a fixture shaped like the scaffold, but THE
  // scaffold, minus one line. A closure that passes the shipped tree because it never
  // looked at it would survive every fixture-only red-proof in this file.
  const dir = fixture({ shipped: true })
  const mig = join(dir, 'supabase/migrations/20260101000100_notes.sql')
  const before = readFileSync(mig, 'utf8')
  const GRANT = 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;'
  assert.ok(before.includes(GRANT), 'the shipped notes migration must carry the grant this deletes')
  writeFileSync(mig, before.replace(GRANT, ''))
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('notes: policy notes_select_own'), r.out)
})

test('GREEN (0.6.0): a deny-all policy needs no grant — the carve-out that keeps the tenancy spine legal', () => {
  // `WITH CHECK (false)` is how the shipped tenancy spine says "authenticated may never
  // insert a membership row" while still holding SELECT. Demanding an INSERT grant behind
  // it would require handing out precisely the privilege the policy exists to refuse.
  const pols = `CREATE POLICY thing_select_own ON public.thing FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_none ON public.thing FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY thing_update_none ON public.thing FOR UPDATE TO authenticated USING (false);
CREATE POLICY thing_delete_none ON public.thing FOR DELETE TO authenticated USING (false);`
  const r = runGate(
    fixture({
      migration: migration({
        policies: pols,
        grants: 'GRANT SELECT ON TABLE public.thing TO authenticated;',
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('GREEN (0.6.0): a RESTRICTIVE policy carries no reachability claim', () => {
  // A restrictive policy only ever SUBTRACTS rows. Writing one for a role that holds
  // nothing is coherent defensive SQL, so it is not evidence the role is meant to read.
  const pols = `CREATE POLICY thing_select_own ON public.thing FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_no_service ON public.thing AS RESTRICTIVE FOR SELECT TO app_reporting USING (owner_id IS NOT NULL);`
  const r = runGate(fixture({ migration: migration({ policies: pols }) }))
  assert.equal(r.code, 0, r.out)
})

test('RED (0.6.0): a CUSTOM role gets the other explanation — it never worked, not "not yet"', () => {
  // Supabase's default privileges cover anon/authenticated/service_role and nothing else,
  // so a policy naming a bespoke role with no grant behind it has never admitted a row.
  // Saying "will break in 2026-10-30" there would be false and would get the finding
  // deferred to a date that has nothing to do with it.
  const pols = `CREATE POLICY thing_select_own ON public.thing FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_select_rpc ON public.thing FOR SELECT TO app_thing_rpc USING (owner_id = (SELECT auth.uid()));`
  const r = runGate(fixture({ migration: migration({ policies: pols }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('app_thing_rpc'), r.out)
  assert.ok(r.out.includes('never has'), r.out)
  assert.ok(!r.out.includes('2026-10-30'), 'a custom role has no flip date to wait for')
})

test('RED (0.6.0): the fold is ORDERED — a later REVOKE undoes an earlier GRANT', () => {
  // A set-union reading of the grant history would report this table fully granted. The
  // shipped idiom is REVOKE-then-narrow-GRANT, so order is the only faithful reading, and
  // the direction that must not fail open is the one where the REVOKE comes last.
  const r = runGate(
    fixture({
      migration: migration({
        grants: `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO authenticated;
REVOKE DELETE ON TABLE public.thing FROM authenticated;`,
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FOR DELETE, but no migration GRANTs DELETE'), r.out)
  assert.ok(!r.out.includes('FOR SELECT, but'), 'the other three privileges survive the REVOKE')
})

test('RED (0.6.0): a SCHEMA grant is not a TABLE grant', () => {
  // `GRANT ALL ON SCHEMA public TO authenticated` and `GRANT ALL ON TABLE public.thing TO
  // authenticated` reduce to the same bare name once the schema prefix is stripped. Folding
  // the first into the second's ledger would let a USAGE grant read as a SELECT grant —
  // which is exactly what the shipped audit migration would have triggered
  // (`REVOKE ALL ON SCHEMA audit FROM anon, authenticated, service_role`).
  const r = runGate(
    fixture({ migration: migration({ grants: 'GRANT ALL ON SCHEMA public TO authenticated;' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('but no migration GRANTs SELECT'), r.out)
})

test('GREEN (0.6.0): ALL TABLES IN SCHEMA fans out, and a grant to PUBLIC is held by everyone', () => {
  // Both are real forms a consumer will reach for after the flip, and reddening either
  // would be the gate telling correct SQL it is wrong.
  const fanOut = runGate(
    fixture({
      migration: migration({
        grants:
          'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;',
      }),
    }),
  )
  assert.equal(fanOut.code, 0, fanOut.out)

  const toPublic = runGate(
    fixture({
      migration: migration({
        grants: 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thing TO PUBLIC;',
      }),
    }),
  )
  assert.equal(toPublic.code, 0, toPublic.out)
})

// ── THE MFA RAIL (0.9.9) ──────────────────────────────────────────────────────────
// A closure over the SHAPE of an aal2 rail, never its coverage — which tables warrant a
// second factor is a product decision. It exists because Supabase's own documented policy
// is broken in two directions and the second is SILENT: read as the invoker it raises
// 42501 for everyone, and "fixed" with a GRANT on auth.mfa_factors it reads zero rows for
// enrolled users too, falls through to array['aal1','aal2'], and admits aal1. Verified
// against a live stack, not reasoned about: installing the vendor shape reddened
// supabase/tests/mfa_aal2.test.sql with the two rows an enrolled aal1 session should not
// have seen. The reds below are the three ways the fixed shape decays back into it.
const MFA_HELPERS = `CREATE FUNCTION private.mfa_is_required() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $mfa$ SELECT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = (SELECT private.caller_id()) AND f.status = 'verified') $mfa$;
CREATE FUNCTION private.mfa_satisfied() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $sat$ SELECT (SELECT private.caller_aal()) = 'aal2' OR NOT (SELECT private.mfa_is_required()) $sat$;
REVOKE ALL ON FUNCTION private.mfa_is_required() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.mfa_satisfied() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.mfa_is_required() TO authenticated;
GRANT EXECUTE ON FUNCTION private.mfa_satisfied() TO authenticated;
`
const MFA_ALLOW = JSON.stringify({
  comment: 'x',
  allow: [{ function: 'private.mfa_is_required', reason: 'reads auth.mfa_factors, no grant' }],
})
const mfaPolicy = (clause = 'AS RESTRICTIVE TO authenticated') =>
  `CREATE POLICY thing_mfa_aal2 ON public.thing ${clause} USING ((SELECT private.mfa_satisfied())) WITH CHECK ((SELECT private.mfa_satisfied()));\n`

/** A tree carrying the rail, with the runtime proof present unless told otherwise. */
function mfaFixture({ extra = '', proof = true } = {}) {
  const dir = fixture({
    migration: migration({ extra: `${MFA_HELPERS}${extra}` }),
    definerAllow: MFA_ALLOW,
  })
  if (proof) writeFileSync(join(dir, 'supabase/tests/mfa_aal2.test.sql'), '-- the runtime proof\n')
  return dir
}

test('GREEN (0.9.9): the correct rail shape — RESTRICTIVE, no FOR clause, both predicates, no grant', () => {
  const r = runGate(mfaFixture({ extra: mfaPolicy() }))
  assert.equal(r.code, 0, r.out)
})

test('RED (0.9.9): a GRANT on auth.mfa_factors is THE fail-open, named as such', () => {
  // The remediation everybody applies when the published policy 403s, and the one that
  // turns a loud failure into a silent one.
  const r = runGate(
    mfaFixture({
      extra: `${mfaPolicy()}GRANT SELECT ON TABLE auth.mfa_factors TO authenticated;\n`,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /auth\.mfa_factors is GRANTed.*that grant is the fail-open/s)
})

test('RED (0.9.9): a PERMISSIVE MFA policy reds — it ORs, so a second policy re-opens it', () => {
  const r = runGate(mfaFixture({ extra: mfaPolicy('AS PERMISSIVE FOR ALL TO authenticated') }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /carries the MFA predicate but is PERMISSIVE/)
})

test('RED (0.9.9): a per-operation MFA policy leaves every other command unguarded', () => {
  // Supabase's own second documentation page writes this policy `for update`, which gates
  // writes and leaves SELECT wide open. Not hypothetical — published.
  const r = runGate(mfaFixture({ extra: mfaPolicy('AS RESTRICTIVE FOR UPDATE TO authenticated') }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /carries the MFA predicate but is FOR UPDATE/)
})

test('RED (0.9.9): USING without WITH CHECK lets an aal1 session write rows it cannot see', () => {
  const r = runGate(
    mfaFixture({
      extra:
        'CREATE POLICY thing_mfa_aal2 ON public.thing AS RESTRICTIVE TO authenticated USING ((SELECT private.mfa_satisfied()));\n',
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /needs BOTH USING and WITH CHECK/)
})

test('RED (0.9.9): the runtime proof is deleted while the policy stays', () => {
  const r = runGate(mfaFixture({ extra: mfaPolicy(), proof: false }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /supabase\/tests\/mfa_aal2\.test\.sql is absent/)
})

test('RED (0.9.9): helpers defined with NO policy using them — a rail nothing references', () => {
  // The other direction, and the one that reads worst to the next person: the functions
  // are there, so the tree looks like it enforces MFA, and nothing does.
  const r = runGate(mfaFixture({ extra: '' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /are defined but NO policy uses them/)
})

test('RED (0.9.9): a RESTRICTIVE policy does not satisfy the per-operation requirement', () => {
  // The hole the rail would have opened. A restrictive policy can only SUBTRACT rows, so
  // one covering SELECT grants nothing — counting it would let a table whose permissive
  // SELECT policy was deleted stay green on the strength of a policy that denies. It was
  // unreachable until this release seeded the tree's first restrictive policy.
  const r = runGate(
    fixture({
      migration: migration({
        policies: `CREATE POLICY thing_select_own ON public.thing AS RESTRICTIVE FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing AS PERMISSIVE FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing AS PERMISSIVE FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));`,
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no PERMISSIVE policy FOR SELECT/)
})
