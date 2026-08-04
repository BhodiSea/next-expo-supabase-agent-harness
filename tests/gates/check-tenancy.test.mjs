// Can-fail proofs for the tenancy gate (template/base/tools/check-tenancy.mjs).
//
// The gate's whole reason to exist is the predicate schema-rls provably cannot
// judge: `org_id = (SELECT auth.uid())` — a tenant column compared to a user id —
// is REAL by every schema-rls rule and isolates nothing. Every case here builds a
// W4-shaped tenancy spine from knobs and perturbs exactly one rule, asserting the
// exact red. The GREEN case doubles as the reference shape W4's real migration is
// written against — the schema lands UNDER the gate, not retrofitted to it.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GATE_SRC = join(ROOT, 'template/base/tools/check-tenancy.mjs')
const LIB_SRC = join(ROOT, 'template/base/tools/lib')
const CONFIG_SRC = join(ROOT, 'template/base/tools/tenancy.json')

const RANK = (n) => `coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= ${n}`

const RPC_ROLE = 'app_tenancy_rpc'
const READER_ROLE = 'app_tenancy_reader'

/**
 * The seat table's policy set: self-only reads for BOTH roles, deny-all human
 * writes, real predicates for the rpc writer role. `rpcSelect` is the knob that
 * removes the paired SELECT policy — the silent-no-op case.
 */
const membershipPolicies = ({
  memSelect = 'USING (user_id = (SELECT auth.uid()))',
  memInsert = 'WITH CHECK (false)',
  rpcSelect = `CREATE POLICY memberships_select_rpc ON public.memberships FOR SELECT TO ${RPC_ROLE} USING (user_id = (SELECT auth.uid()));`,
  // The terminal node of the recursion chain: self-only and helper-free. Its own knob,
  // because "the base case went missing" is a distinct silent failure from "the pairing
  // went missing" — both end in seat writes matching zero rows.
  readerSelect = `CREATE POLICY memberships_select_reader ON public.memberships FOR SELECT TO ${READER_ROLE} USING (user_id = (SELECT auth.uid()));`,
} = {}) => `CREATE POLICY memberships_select_self ON public.memberships AS PERMISSIVE FOR SELECT TO authenticated ${memSelect};
${rpcSelect}
${readerSelect}
CREATE POLICY memberships_insert_none ON public.memberships FOR INSERT TO authenticated ${memInsert};
CREATE POLICY memberships_update_none ON public.memberships FOR UPDATE TO authenticated USING (false);
CREATE POLICY memberships_delete_none ON public.memberships FOR DELETE TO authenticated USING (false);
CREATE POLICY memberships_insert_rpc ON public.memberships FOR INSERT TO ${RPC_ROLE} WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY memberships_update_rpc ON public.memberships FOR UPDATE TO ${RPC_ROLE} USING (${RANK(30)} AND role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0)) WITH CHECK (${RANK(30)} AND role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0));
CREATE POLICY memberships_delete_rpc ON public.memberships FOR DELETE TO ${RPC_ROLE} USING (role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) OR (user_id = (SELECT auth.uid()) AND role_rank < 40));`

const ORGS_POLICIES = `CREATE POLICY orgs_select_member ON public.orgs FOR SELECT TO authenticated USING (id = ANY((SELECT private.member_org_ids())::uuid[]));
CREATE POLICY orgs_insert_rpc ON public.orgs FOR INSERT TO ${RPC_ROLE} WITH CHECK (created_by = (SELECT auth.uid()));
CREATE POLICY orgs_update_rpc ON public.orgs FOR UPDATE TO ${RPC_ROLE} USING (coalesce(((SELECT private.member_ranks()) ->> id::text)::smallint, 0) >= 40) WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> id::text)::smallint, 0) >= 40);
CREATE POLICY orgs_delete_rpc ON public.orgs FOR DELETE TO ${RPC_ROLE} USING (coalesce(((SELECT private.member_ranks()) ->> id::text)::smallint, 0) >= 40);`

const HELPERS_SQL = `CREATE FUNCTION private.member_org_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
  AS $$ SELECT coalesce(array_agg(m.org_id), ARRAY[]::uuid[]) FROM public.memberships m WHERE m.user_id = (SELECT auth.uid()) $$;
CREATE FUNCTION private.member_ranks() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
  AS $$ SELECT coalesce(jsonb_object_agg(m.org_id::text, m.role_rank), '{}'::jsonb) FROM public.memberships m WHERE m.user_id = (SELECT auth.uid()) $$;`

const FREEZE_FNS_SQL = `CREATE FUNCTION private.freeze_org_id() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN RAISE EXCEPTION 'org_id is immutable'; END IF; RETURN NEW; END $$;
CREATE FUNCTION private.freeze_membership_identity() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN RAISE EXCEPTION 'membership identity is immutable'; END IF; RETURN NEW; END $$;`

// public, not private: PostgREST can only call functions in an exposed schema, and
// supabase-js .rpc() is the only transport this stack has.
const DIRECTORY_SQL = `CREATE FUNCTION public.org_members(p_org_id uuid) RETURNS TABLE (member_id uuid, member_rank smallint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$ SELECT m.user_id, m.role_rank FROM public.memberships m WHERE m.org_id = p_org_id AND EXISTS (SELECT 1 FROM public.memberships me WHERE me.org_id = p_org_id AND me.user_id = (SELECT auth.uid())) $$;`

// The bearer-invite table. Consumption is a DELETE (never an accepted_at stamp), so
// a redeemed token cannot be replayed — the row is gone. Only the DIGEST is stored,
// so a rank-30 admin reading the table learns nothing redeemable.
const INVITATIONS_SQL = `CREATE TABLE public.invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  email text NOT NULL,
  role_rank smallint NOT NULL,
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, email)
);
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations FORCE ROW LEVEL SECURITY;
CREATE TRIGGER invitations_freeze_org BEFORE UPDATE ON public.invitations FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();
CREATE POLICY invitations_select_admin ON public.invitations FOR SELECT TO authenticated USING (${RANK(30)});
CREATE POLICY invitations_insert_rpc ON public.invitations FOR INSERT TO ${RPC_ROLE} WITH CHECK (${RANK(30)});
CREATE POLICY invitations_update_rpc ON public.invitations FOR UPDATE TO ${RPC_ROLE} USING (${RANK(30)}) WITH CHECK (${RANK(30)});
CREATE POLICY invitations_delete_rpc ON public.invitations FOR DELETE TO ${RPC_ROLE} USING (${RANK(30)} OR expires_at > now());`

const AUDIT_W = 'app_audit_writer'
const AUDIT_R = 'app_audit_reader'

/**
 * The append-only trail, as the W6 migration builds it. Every GREEN case carries it
 * because the audit closure is a property of the WHOLE tree — "every org-scoped table
 * is audited" cannot be checked from one table — so a fixture without it reds on a
 * rule that has nothing to do with the case under test.
 *
 * Note what is NOT here: no FK on org_id (evidence must outlive the org it describes),
 * no freeze trigger (UPDATE is refused outright, which is strictly stronger), and no
 * UPDATE or DELETE policy at all — that absence is layer 1 of four.
 */
const auditSql = ({
  auditTable = `CREATE TABLE audit.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  table_name text NOT NULL,
  row_id text,
  PRIMARY KEY (org_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);`,
  rowGuard = 'CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();',
  truncGuard = `CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER events_default_no_truncate BEFORE TRUNCATE ON audit.events_default FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();`,
  insertPolicy = `CREATE POLICY events_insert_writer ON audit.events FOR INSERT TO ${AUDIT_W} WITH CHECK (actor_id IS NOT DISTINCT FROM (SELECT auth.uid()));`,
  selectPolicy = `CREATE POLICY events_select_admin ON audit.events FOR SELECT TO ${AUDIT_R} USING (${RANK(30)});`,
  readerPairing = `CREATE POLICY memberships_select_audit ON public.memberships FOR SELECT TO ${AUDIT_R} USING (user_id = (SELECT auth.uid()));`,
  writeFn = `CREATE FUNCTION audit.write_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$ BEGIN INSERT INTO audit.events (org_id, actor_id, action, table_name) VALUES (NULL, private.caller_id(), TG_OP, TG_TABLE_NAME); RETURN NULL; END $$;`,
  notesTrigger = "CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE OR DELETE ON public.notes FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');",
  orgsTrigger = "CREATE TRIGGER orgs_audit AFTER INSERT OR UPDATE OR DELETE ON public.orgs FOR EACH ROW EXECUTE FUNCTION audit.write_row('id', 'id');",
  memTrigger = "CREATE TRIGGER memberships_audit AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'user_id');",
  invTrigger = "CREATE TRIGGER invitations_audit AFTER INSERT OR UPDATE OR DELETE ON public.invitations FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');",
  grants = '',
} = {}) => `CREATE SCHEMA IF NOT EXISTS audit;
${auditTable}
CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
CREATE FUNCTION audit.deny_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = ''
  AS $$ BEGIN RAISE EXCEPTION 'append-only' USING ERRCODE = '42501'; END $$;
${rowGuard}
${truncGuard}
${insertPolicy}
${selectPolicy}
${readerPairing}
${writeFn}
${grants}
${notesTrigger}
${orgsTrigger}
${memTrigger}
${invTrigger}`

const NOTES_TABLE_SQL = `CREATE TABLE public.notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, org_id)
);
CREATE INDEX notes_org_created_idx ON public.notes (org_id, created_at DESC, id DESC);`

/** The W4-shaped spine; every knob perturbs exactly one rule. */
function tenancyMigration(o = {}) {
  const {
    memSelect,
    memInsert,
    rpcSelect,
    memPolicies,
    orgPolicies = ORGS_POLICIES,
    memGrant = 'GRANT SELECT ON TABLE public.memberships TO authenticated;',
    memFreeze = 'CREATE TRIGGER memberships_freeze BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION private.freeze_membership_identity();',
    helpers = HELPERS_SQL,
    freezeFns = FREEZE_FNS_SQL,
    directory = DIRECTORY_SQL,
    invitations = INVITATIONS_SQL,
    notesTable = NOTES_TABLE_SQL,
    notesFreeze = 'CREATE TRIGGER notes_freeze_org BEFORE UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();',
    notesSelect = 'USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]))',
    notesInsert = `WITH CHECK (${RANK(20)})`,
    notesUpdate = `USING (${RANK(20)}) WITH CHECK (${RANK(20)})`,
    notesDelete = `USING (${RANK(30)} OR (owner_id = (SELECT auth.uid()) AND ${RANK(20)}))`,
    notesPolicies,
    audit = auditSql(),
    extra = '',
  } = o
  const mem = memPolicies ?? membershipPolicies({ memSelect, memInsert, rpcSelect, readerSelect: o.readerSelect })
  const notes =
    notesPolicies ??
    `CREATE POLICY notes_select_org ON public.notes AS PERMISSIVE FOR SELECT TO authenticated ${notesSelect};
CREATE POLICY notes_insert_org ON public.notes FOR INSERT TO authenticated ${notesInsert};
CREATE POLICY notes_update_org ON public.notes FOR UPDATE TO authenticated ${notesUpdate};
CREATE POLICY notes_delete_org ON public.notes FOR DELETE TO authenticated ${notesDelete};`
  return `CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'team',
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);
ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orgs FORCE ROW LEVEL SECURITY;
${orgPolicies}
CREATE TABLE public.memberships (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  role_rank smallint NOT NULL CHECK (role_rank IN (10, 20, 30, 40)),
  PRIMARY KEY (user_id, org_id)
);
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
${memGrant}
${mem}
${helpers}
${freezeFns}
${directory}
${invitations}
${memFreeze}
${notesTable}
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;
${notesFreeze}
${notes}
${audit}
${extra}`
}

/** No tenant column anywhere — the pre-0.2.0 owner-scoped world. */
const OWNER_ONLY_SQL = `CREATE TABLE public.notes (id uuid PRIMARY KEY, owner_id uuid NOT NULL);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;`

/**
 * `config` edits the shipped tenancy contract in place; `rawConfig` replaces the file
 * BYTE for byte (the malformed-JSON cases, which a structured edit cannot express).
 * @param {{ migration?: string, config?: (base: any) => any, rawConfig?: string,
 *           configToml?: string | null, manifest?: any }} [opts]
 */
function fixture({ migration = tenancyMigration(), config, rawConfig, configToml = null, manifest = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-tenancy-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
  cpSync(GATE_SRC, join(dir, 'tools/check-tenancy.mjs'))
  cpSync(LIB_SRC, join(dir, 'tools/lib'), { recursive: true })
  const base = JSON.parse(readFileSync(CONFIG_SRC, 'utf8'))
  // The fixtures build a minimal spine — orgs, memberships, invitations, notes — and
  // never create the account-scoped or metering tables the shipped contract records
  // here. Carrying the real lists over would red every case on a STALE-ESCAPE error
  // that has nothing to do with the rule under test. Cases that exercise either escape
  // set it explicitly, and both escapes' own stale-closures have dedicated cases below.
  base.untenantedTables = []
  base.auditExemptTables = []
  writeFileSync(join(dir, 'tools/tenancy.json'), rawConfig ?? JSON.stringify(config ? config(base) : base))
  if (migration !== null) writeFileSync(join(dir, 'supabase/migrations/0001_tenancy.sql'), migration)
  if (configToml !== null) writeFileSync(join(dir, 'supabase/config.toml'), configToml)
  if (manifest !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, ['tools/check-tenancy.mjs'], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const V013 = { baseVersion: '0.1.3', harnessVersion: '0.1.3', files: {} }

// ── the reference shape ───────────────────────────────────────────────────────

test('GREEN: the W4-shaped spine passes — including the OR-of-two-scoped-arms delete policy', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('tenant table(s)'), r.out)
})

test('GREEN: a bad policy that a later migration DROPs is out of judgment (live fold)', () => {
  const extra = `CREATE POLICY notes_bad ON public.notes FOR SELECT TO authenticated USING (org_id = (SELECT auth.uid()));
DROP POLICY notes_bad ON public.notes;`
  const r = runGate(fixture({ migration: tenancyMigration({ extra }) }))
  assert.equal(r.code, 0, r.out)
})

// ── adoption vs correctness (the security-headers ramp lesson, pinned here too) ──

test('ADOPTION RAMP: a pre-0.2.0 install with NO tenant column passes with a NOTE, even in CI', () => {
  const r = runGate(fixture({ migration: OWNER_ONLY_SQL, manifest: V013 }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE'), r.out)
})

test('skip asymmetry: no tenant column and no manifest → loud local SKIP, hard CI fail', () => {
  const local = runGate(fixture({ migration: OWNER_ONLY_SQL }), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(fixture({ migration: OWNER_ONLY_SQL }))
  assert.equal(ci.code, 1, ci.out)
})

test('REGRESSION: an ancient baseVersion must NOT disarm findings once a tenant column exists', () => {
  // The security-headers bug, pre-pinned for this gate: the ramp covers ADOPTION
  // (no tenant column on an upgrading install) only. The moment the surface exists,
  // wrong predicates are a hard red regardless of manifest vintage.
  const r = runGate(
    fixture({
      migration: tenancyMigration({ notesSelect: 'USING (org_id = (SELECT auth.uid()))' }),
      manifest: V013,
    }),
  )
  assert.equal(r.code, 1, `an old baseVersion must not make the tenancy gate advisory:\n${r.out}`)
  assert.ok(!r.out.includes('NOTE —'), `findings must not print as NOTEs:\n${r.out}`)
})

// ── the predicate form set ────────────────────────────────────────────────────

test('RED: a tenant column compared to a user id — real by every schema-rls rule, isolates nothing', () => {
  const r = runGate(
    fixture({ migration: tenancyMigration({ notesSelect: 'USING (org_id = (SELECT auth.uid()))' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('matches NO reviewed predicate form'), r.out)
  // The exact normalized predicate is printed, so admitting a reviewed form is copy-paste.
  assert.ok(r.out.includes("org_id = (select auth.uid())"), r.out)
})

test('RED: a top-level OR arm without the scope term re-opens per-user scope', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        notesSelect: 'USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]) OR owner_id = (SELECT auth.uid()))',
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('OR arm carrying no tenancy scope term'), r.out)
})

test('RED: the correlated-argument ban — (SELECT private.member_rank(org_id)) is a per-row SubPlan', () => {
  const r = runGate(
    fixture({ migration: tenancyMigration({ notesSelect: 'USING ((SELECT private.member_rank(org_id)) >= 30)' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('passes org_id INTO private.member_rank(...)'), r.out)
})

test('RED: a rank floor that is not a configured role rank', () => {
  const r = runGate(fixture({ migration: tenancyMigration({ notesInsert: `WITH CHECK (${RANK(25)})` }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('rank floor 25') && r.out.includes('not a configured role rank'), r.out)
})

test('RED: an EXISTS over the membership table is a relation sub-select, not a hoisted scalar', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        notesSelect:
          'USING (EXISTS (SELECT 1 FROM public.memberships m WHERE m.org_id = notes.org_id AND m.user_id = (SELECT auth.uid())))',
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('sub-select over a relation'), r.out)
})

test('RED: a tenant policy without TO, or TO a role other than authenticated', () => {
  const notesPolicies = `CREATE POLICY notes_select_org ON public.notes FOR SELECT USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));
CREATE POLICY notes_insert_org ON public.notes FOR INSERT TO anon WITH CHECK (${RANK(20)});`
  const r = runGate(fixture({ migration: tenancyMigration({ notesPolicies }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no TO clause'), r.out)
  assert.ok(r.out.includes('granted TO anon'), r.out)
})

// ── the tenant key's schema shape ─────────────────────────────────────────────

test('RED: a nullable tenant key (the mid-adoption shape left unfinished)', () => {
  const notesTable = `CREATE TABLE public.notes (
  id uuid PRIMARY KEY,
  title text NOT NULL
);
ALTER TABLE public.notes ADD COLUMN org_id uuid REFERENCES public.orgs (id);`
  const r = runGate(fixture({ migration: tenancyMigration({ notesTable }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not NOT NULL'), r.out)
})

test('GREEN: the expand→contract path — nullable ADD COLUMN hardened by a later SET NOT NULL', () => {
  const notesTable = `CREATE TABLE public.notes (
  id uuid,
  title text NOT NULL
);
ALTER TABLE public.notes ADD COLUMN org_id uuid REFERENCES public.orgs (id);
ALTER TABLE public.notes ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.notes ADD CONSTRAINT notes_pkey PRIMARY KEY (id, org_id);`
  const r = runGate(fixture({ migration: tenancyMigration({ notesTable }) }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a tenant key with no FOREIGN KEY to the org table', () => {
  const notesTable = NOTES_TABLE_SQL.replace(' REFERENCES public.orgs (id) ON DELETE CASCADE', '')
  assert.notEqual(notesTable, NOTES_TABLE_SQL, 'the mutation matched nothing — the fixture SQL moved')
  const r = runGate(fixture({ migration: tenancyMigration({ notesTable }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no FOREIGN KEY to public.orgs'), r.out)
})

test('RED: a UNIQUE constraint omitting the tenant column (partition-ready rule)', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({ extra: 'CREATE UNIQUE INDEX notes_title_key ON public.notes (title);' }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("'notes_title_key'") && r.out.includes('omits org_id'), r.out)
})

test('GREEN: the same UNIQUE registered in uniqueWithoutTenantColumn with a reason', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({ extra: 'CREATE UNIQUE INDEX notes_title_key ON public.notes (title);' }),
      config: (c) => ({
        ...c,
        uniqueWithoutTenantColumn: [
          ...c.uniqueWithoutTenantColumn,
          { table: 'notes', index: 'notes_title_key', reason: 'global lookup key; the value is server-minted randomness, not tenant data' },
        ],
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('FAIL CLOSED: a uniqueWithoutTenantColumn entry with an empty reason', () => {
  const r = runGate(
    fixture({
      config: (c) => ({ ...c, uniqueWithoutTenantColumn: [{ table: 'notes', index: 'x', reason: ' ' }] }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('non-empty reason'), r.out)
})

test('RED: a stale uniqueWithoutTenantColumn entry naming a constraint no migration declares', () => {
  const r = runGate(
    fixture({
      config: (c) => ({
        ...c,
        uniqueWithoutTenantColumn: [{ table: 'notes', index: 'ghost_key', reason: 'left over from a dropped constraint' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ghost_key') && r.out.includes('stale escape'), r.out)
})

test('RED: a stale exemptTables entry naming a table with no tenant column', () => {
  const r = runGate(
    fixture({
      config: (c) => ({ ...c, exemptTables: [{ table: 'profiles', reason: 'user-scoped profile row' }] }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("'profiles'") && r.out.includes('stale escape'), r.out)
})

// ── the freeze ────────────────────────────────────────────────────────────────

test('RED: a tenant table with no freeze trigger — rows could move between orgs', () => {
  const r = runGate(fixture({ migration: tenancyMigration({ notesFreeze: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no BEFORE UPDATE trigger executing private.freeze_org_id'), r.out)
})

test('RED: a freeze trigger with a WHEN clause is disarmable', () => {
  const notesFreeze =
    'CREATE TRIGGER notes_freeze_org BEFORE UPDATE ON public.notes FOR EACH ROW WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id) EXECUTE FUNCTION private.freeze_org_id();'
  const r = runGate(fixture({ migration: tenancyMigration({ notesFreeze }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('WHEN clause'), r.out)
})

// ── the membership table: self-only read, deny-all writes, recursion smell ──────

test('RED: a membership policy calling the scope helper — the recursion smell test', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({ memSelect: 'USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]))' }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  // 54001, not 42P17: SET search_path = '' blocks SQL-function inlining, so the
  // rewriter's cycle check never fires and the recursion exhausts the stack instead.
  // Verified against PostgreSQL 17 — the message names the code people will actually see.
  assert.ok(r.out.includes('54001'), r.out)
})

test('RED: a self-keyed membership INSERT policy lets a user grant themselves any seat', () => {
  const r = runGate(
    fixture({ migration: tenancyMigration({ memInsert: 'WITH CHECK (user_id = (SELECT auth.uid()))' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('grant THEMSELVES a seat'), r.out)
})

test('RED: no SELECT policy on the membership table — the recursion terminator is missing', () => {
  const memPolicies = `CREATE POLICY memberships_insert_none ON public.memberships FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY memberships_update_none ON public.memberships FOR UPDATE TO authenticated USING (false);
CREATE POLICY memberships_delete_none ON public.memberships FOR DELETE TO authenticated USING (false);`
  const r = runGate(fixture({ migration: tenancyMigration({ memPolicies }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('recursion terminator'), r.out)
})

test('RED: GRANT INSERT on the membership table to authenticated', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({ memGrant: 'GRANT SELECT, INSERT ON TABLE public.memberships TO authenticated;' }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('read-only to authenticated'), r.out)
})

// ── the rpc writer role: the silent-no-op class ───────────────────────────────

test('RED: a rank-scoped write TO the rpc role with no paired self-SELECT policy', () => {
  // THE SILENT NO-OP. member_ranks() is SECURITY INVOKER, so inside the definer it
  // reads memberships AS app_tenancy_rpc. With no SELECT policy for that role the
  // read hits RLS default-deny, the rank map comes back empty, every comparison is
  // false, and the UPDATE matches zero rows AND SUCCEEDS — a promotion that reports
  // OK and changes nothing, in production, with nothing raised anywhere. Nothing
  // else in the chain can see this: the SQL is valid, the policy is present, and the
  // predicate matches a reviewed form.
  //
  // The rule is closed over every non-`authenticated` role in a helper-bearing policy
  // rather than over the rpc writer alone, because W6's audit reader has the identical
  // failure with the opposite consequence: a READ that silently returns nothing, which
  // an admin reads as "no activity" rather than as a fault. The two are asserted
  // separately — see the audit-reader case further down.
  const r = runGate(fixture({ migration: tenancyMigration({ rpcSelect: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RLS default-deny'), r.out)
  assert.ok(r.out.includes('ZERO ROWS WHILE REPORTING SUCCESS'), r.out)
  assert.ok(r.out.includes(RPC_ROLE), r.out)
})

test('RED: a policy TO a role that is neither authenticated nor the reviewed rpc writer', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        rpcSelect: 'CREATE POLICY memberships_select_rpc ON public.memberships FOR SELECT TO some_other_role USING (user_id = (SELECT auth.uid()));',
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('some_other_role'), r.out)
})

test('RED: the seat table SELECT policy for the rpc role may not call a helper (recursion)', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        rpcSelect: `CREATE POLICY memberships_select_rpc ON public.memberships FOR SELECT TO ${RPC_ROLE} USING (${RANK(10)});`,
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  // 54001, not 42P17: SET search_path = '' blocks SQL-function inlining, so the
  // rewriter's cycle check never fires and the recursion exhausts the stack instead.
  // Verified against PostgreSQL 17 — the message names the code people will actually see.
  assert.ok(r.out.includes('54001'), r.out)
})

// ── the org table: the root of the model, invisible to column-driven discovery ──

test('RED: an org-table policy that leaks every org — the table has no tenant column', () => {
  // public.orgs carries no org_id, so the column-driven table discovery never reaches
  // it. Without the explicit org-table pass this predicate passes every static gate
  // in the repo while publishing every org row to every signed-in user.
  const orgPolicies = ORGS_POLICIES.replace(
    'USING (id = ANY((SELECT private.member_org_ids())::uuid[]))',
    'USING (created_by = (SELECT auth.uid()) OR name IS NOT NULL)',
  )
  assert.notEqual(orgPolicies, ORGS_POLICIES, 'the mutation matched nothing — the fixture SQL moved')
  const r = runGate(fixture({ migration: tenancyMigration({ orgPolicies }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('orgs:') && r.out.includes('OR arm carrying no tenancy scope term'), r.out)
})

test('RED: an org table with no policies at all', () => {
  const r = runGate(fixture({ migration: tenancyMigration({ orgPolicies: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('root of the tenancy model'), r.out)
})

// ── table-narrowed forms stay narrow ──────────────────────────────────────────

test('RED: a table-scoped form does not license the same predicate elsewhere', () => {
  // `expires_at > now()` is reviewed for invitations ONLY (acceptance is performed by
  // someone who is not yet a member). A notes policy claiming it must still red.
  const r = runGate(
    fixture({ migration: tenancyMigration({ notesSelect: 'USING (expires_at > now())' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('matches NO reviewed predicate form'), r.out)
})

test('FAIL CLOSED: a table-narrowed form without a substantive reason', () => {
  const r = runGate(
    fixture({
      config: (c) => ({
        ...c,
        predicateForms: c.predicateForms.map((f) =>
          f.name === 'invitation-live' ? { ...f, reason: 'ok' } : f,
        ),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('substantive "reason"'), r.out)
})

// ── the helpers ───────────────────────────────────────────────────────────────

test('RED: a SECURITY DEFINER scope helper breaks the invoker-based recursion safety', () => {
  const helpers = HELPERS_SQL.replace(
    "LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''\n  AS $$ SELECT coalesce(array_agg",
    "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''\n  AS $$ SELECT coalesce(array_agg",
  )
  assert.notEqual(helpers, HELPERS_SQL, 'the mutation matched nothing — the fixture SQL moved')
  const r = runGate(fixture({ migration: tenancyMigration({ helpers }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must be SECURITY INVOKER'), r.out)
})

test('RED: a helper that takes a parameter is the correlated-SubPlan door', () => {
  const helpers = HELPERS_SQL.replace('private.member_ranks() RETURNS jsonb', 'private.member_ranks(_scope uuid) RETURNS jsonb')
  assert.notEqual(helpers, HELPERS_SQL, 'the mutation matched nothing — the fixture SQL moved')
  const r = runGate(fixture({ migration: tenancyMigration({ helpers }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('parameter(s)'), r.out)
})

test('RED: a helper the config names but no migration defines', () => {
  const [orgIdsOnly] = HELPERS_SQL.split('CREATE FUNCTION private.member_ranks')
  const r = runGate(fixture({ migration: tenancyMigration({ helpers: orgIdsOnly }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('private.member_ranks') && r.out.includes('defined in no migration'), r.out)
})

test('RED: a helper without STABLE cannot promise the InitPlan hoist', () => {
  const helpers = HELPERS_SQL.replace(
    "member_org_ids() RETURNS uuid[]\n  LANGUAGE sql STABLE",
    'member_org_ids() RETURNS uuid[]\n  LANGUAGE sql',
  )
  assert.notEqual(helpers, HELPERS_SQL, 'the mutation matched nothing — the fixture SQL moved')
  const r = runGate(fixture({ migration: tenancyMigration({ helpers }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must be STABLE'), r.out)
})

// ── the directory RPC + the PostgREST wall ────────────────────────────────────

test('RED: a configured directory RPC that no migration defines; GREEN: an explicit null', () => {
  // The shipped contract sets directoryRpc to null — a RECORDED decision (no member
  // directory can exist without a non-recursive seat-table read; see tenancy.json).
  // The red case therefore has to configure one, which is the point: null and
  // "forgot to ship it" must not be the same state.
  const red = runGate(
    fixture({
      migration: tenancyMigration({ directory: '' }),
      config: (c) => ({ ...c, directoryRpc: 'public.org_members' }),
    }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('directory RPC'), red.out)
  const green = runGate(fixture({ migration: tenancyMigration({ directory: '' }) }))
  assert.equal(green.code, 0, green.out)
})

test('RED: a nonPublicSchemas schema published in [api].schemas', () => {
  const r = runGate(
    fixture({ configToml: '[api]\nenabled = true\nschemas = ["public", "private"]\n' }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("schema 'private' is listed in [api].schemas"), r.out)
})

// ── the contract fails closed ─────────────────────────────────────────────────

test('FAIL CLOSED: an EMPTY predicateForms set never passes vacuously', () => {
  const r = runGate(fixture({ config: (c) => ({ ...c, predicateForms: [] }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('EMPTY'), r.out)
})

test('FAIL CLOSED: malformed contract JSON', () => {
  const r = runGate(fixture({ rawConfig: '{ nope' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not valid JSON'), r.out)
})

test('FAIL CLOSED: a contract missing a required section', () => {
  const r = runGate(
    fixture({
      config: (c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'roles')),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"roles"'), r.out)
})

test('FAIL CLOSED: a contract whose forms never mention the named helpers disagrees with itself', () => {
  const r = runGate(
    fixture({ config: (c) => ({ ...c, scopeHelper: 'private.renamed_helper' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('disagrees with itself'), r.out)
})

test('FAIL CLOSED: a missing contract file', () => {
  const dir = fixture()
  rmSync(join(dir, 'tools/tenancy.json'))
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/tenancy.json is missing'), r.out)
})

// ── the recursion base case, and the untenanted-table rule ────────────────────

test('RED: the reader role has no seat SELECT policy — the definer scope helper reads empty', () => {
  // The silent-no-op failure one role deeper than the rpc pairing. Without this policy
  // readerScopeHelper runs under RLS default-deny, returns an empty org array, every
  // admin arm is false, and seat management matches ZERO ROWS while reporting success.
  const r = runGate(fixture({ migration: tenancyMigration({ readerSelect: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no SELECT policy TO app_tenancy_reader'), r.out)
})

test('RED: the reader seat policy is not self-only — the terminal node must stay terminal', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        readerSelect: `CREATE POLICY memberships_select_reader ON public.memberships FOR SELECT TO ${READER_ROLE} USING (${RANK(10)});`,
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('TERMINAL node'), r.out)
})

test('RED: a new table with no tenant column at all — the gate must not discover its way past it', () => {
  // Every other rule here is discovered BY the tenant column, so omitting the column
  // is the one way to pass without being judged. A per-user table in a B2B product
  // passes every cross-tenant assertion while hiding the row from the colleagues who
  // are supposed to share it.
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        extra: `CREATE TABLE public.widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  label text NOT NULL
);`,
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('widgets: created with no org_id column'), r.out)
})

test('GREEN: an untenanted table recorded with a reason', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        extra: `CREATE TABLE public.widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  label text NOT NULL
);`,
      }),
      config: (c) => ({
        ...c,
        untenantedTables: [{ table: 'widgets', reason: 'account-scoped device registry, deliberately not org data' }],
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a stale untenantedTables entry naming a table no migration creates', () => {
  const r = runGate(
    fixture({
      config: (c) => ({ ...c, untenantedTables: [{ table: 'gone', reason: 'removed last release' }] }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("untenantedTables names 'gone'"), r.out)
})

// ── the expiring escape: an install adopting org scope with production rows ───
//
// THE SHAPE UNDER TEST is the middle of docs/runbooks/tenancy-adoption.md: org_id
// has arrived NULLable on a table full of pre-tenancy rows, the new org-scoped
// policies sit BESIDE the old owner-scoped ones (permissive policies OR, so nothing
// breaks for anyone mid-flight), and the primary key is still the pre-tenancy
// `(id)` because a nullable column cannot join a PK. Every one of those three facts
// is a hard red in the finished world — which is the point: the escape licenses
// exactly them, on exactly one table, until exactly one version.

/** The expand-phase notes table: nullable tenant key, pre-tenancy primary key. */
const DUAL_NOTES_TABLE_SQL = `CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.orgs (id) ON DELETE CASCADE,
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_org_created_idx ON public.notes (org_id, created_at DESC, id DESC);`

/** New org-scoped policies ALONGSIDE the surviving owner-scoped set. */
const DUAL_NOTES_POLICIES = `CREATE POLICY notes_select_org ON public.notes FOR SELECT TO authenticated USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));
CREATE POLICY notes_insert_org ON public.notes FOR INSERT TO authenticated WITH CHECK (${RANK(20)});
CREATE POLICY notes_update_org ON public.notes FOR UPDATE TO authenticated USING (${RANK(20)}) WITH CHECK (${RANK(20)});
CREATE POLICY notes_delete_org ON public.notes FOR DELETE TO authenticated USING (${RANK(30)});
CREATE POLICY notes_select_owner ON public.notes FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY notes_update_owner ON public.notes FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY notes_delete_owner ON public.notes FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));`

const dualMigration = (o = {}) =>
  tenancyMigration({ notesTable: DUAL_NOTES_TABLE_SQL, notesPolicies: DUAL_NOTES_POLICIES, ...o })

const DUAL_ENTRY = {
  table: 'notes',
  ownerColumn: 'owner_id',
  until: '0.4.0',
  reason: 'adopting org scope on a 0.1.x install with live rows; owner policies retire after the backfill',
}
// ONE entry, deliberately — the transition must have exactly one clock on it. If
// the pre-tenancy primary key needed its own uniqueWithoutTenantColumn escape, that
// second entry would not expire and would outlive the transition it was written for.
const withDual = (entry = DUAL_ENTRY) => (c) => ({ ...c, dualScopedTables: [entry] })
/** An install running 0.2.0 — before the escape's declared end. */
const RUNNING = { baseVersion: '0.2.0', harnessVersion: '0.2.0', files: {} }

test('RED: the mid-adoption shape with NO escape — a nullable key and a surviving owner policy', () => {
  const r = runGate(fixture({ migration: dualMigration(), manifest: RUNNING }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not NOT NULL'), r.out)
  assert.ok(r.out.includes('matches NO reviewed predicate form'), r.out)
})

test('GREEN: the same shape with a dualScopedTables entry that has not expired', () => {
  const r = runGate(fixture({ migration: dualMigration(), config: withDual(), manifest: RUNNING }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('MID-ADOPTION'), `the green line must NAME the transition:\n${r.out}`)
  assert.ok(r.out.includes('notes@0.4.0'), r.out)
})

test('RED: the escape EXPIRES — the install has passed the version it was declared to end at', () => {
  const r = runGate(
    fixture({
      migration: dualMigration(),
      config: withDual(),
      manifest: { baseVersion: '0.2.0', harnessVersion: '0.4.0', files: {} },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('declared to end at harness 0.4.0'), r.out)
})

test('the deadline is measured against harnessVersion, NOT the baseVersion its own author controls', () => {
  // The escape's beneficiary is the human who bumps baseVersion. If the deadline
  // read that field, an install could sit at baseVersion 0.2.0 forever and the
  // transition would never expire — the escape would be permanent by inaction,
  // which is the single outcome this mechanism exists to prevent.
  const r = runGate(
    fixture({
      migration: dualMigration(),
      config: withDual(),
      manifest: { baseVersion: '0.2.0', harnessVersion: '0.9.1', files: {} },
    }),
  )
  assert.equal(r.code, 1, `an ancient baseVersion must not shelter an overdue transition:\n${r.out}`)
  assert.ok(r.out.includes('this install now runs 0.9.1'), r.out)
})

test('RED: the escape goes stale the moment the contract phase lands (tenant key NOT NULL)', () => {
  // The happy path: the backfill finished, SET NOT NULL landed, and the entry is
  // now pure widening. This reds BEFORE the deadline is ever reached, so the
  // deadline only ever fires for a transition that actually stalled.
  const r = runGate(fixture({ migration: tenancyMigration(), config: withDual(), manifest: RUNNING }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('is ALREADY NOT NULL'), r.out)
})

test('FAIL CLOSED: an entry with no manifest to measure its deadline against', () => {
  // Deleting .harness/ must not be a way to make the escape permanent.
  const r = runGate(fixture({ migration: dualMigration(), config: withDual() }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no readable .harness/manifest.json'), r.out)
})

test('FAIL CLOSED: an until that is not a dotted version can never expire', () => {
  const r = runGate(
    fixture({
      migration: dualMigration(),
      config: withDual({ ...DUAL_ENTRY, until: 'someday' }),
      manifest: RUNNING,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("until='someday'"), r.out)
})

test('FAIL CLOSED: an entry missing its until is not a deadline at all', () => {
  const r = runGate(
    fixture({
      migration: dualMigration(),
      config: (c) => ({ ...c, dualScopedTables: [{ table: 'notes', ownerColumn: 'owner_id', reason: 'mid-adoption' }] }),
      manifest: RUNNING,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('dualScopedTables'), r.out)
})

test('RED: the escape is TABLE-SCOPED — an owner arm on another table is still red', () => {
  // The load-bearing containment property. `notes` is licensed; `widgets` is not,
  // and the licensed form must not leak into the general form set.
  const widgets = `CREATE TABLE public.widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  label text NOT NULL
);
CREATE INDEX widgets_org_idx ON public.widgets (org_id);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widgets FORCE ROW LEVEL SECURITY;
CREATE TRIGGER widgets_freeze_org BEFORE UPDATE ON public.widgets FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();
CREATE POLICY widgets_select_owner ON public.widgets FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));`
  const r = runGate(
    fixture({ migration: dualMigration({ extra: widgets }), config: withDual(), manifest: RUNNING }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('widgets: policy widgets_select_owner'), r.out)
})

test('RED: an entry naming an ownerColumn the table does not have licenses nothing', () => {
  const r = runGate(
    fixture({
      migration: dualMigration(),
      config: withDual({ ...DUAL_ENTRY, ownerColumn: 'author_id' }),
      manifest: RUNNING,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("ownerColumn 'author_id'"), r.out)
})

test('RED: a stale entry naming a table no migration creates', () => {
  const r = runGate(
    fixture({
      config: (c) => ({ ...c, dualScopedTables: [{ ...DUAL_ENTRY, table: 'gone' }] }),
      manifest: RUNNING,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("dualScopedTables names 'gone'"), r.out)
})

test('the tenant-blind pre-tenancy PRIMARY KEY needs no SECOND, non-expiring escape', () => {
  // A nullable column cannot join a primary key, so every unique on a mid-adoption
  // table is tenant-blind until the contract phase reshapes it. Demanding a
  // uniqueWithoutTenantColumn entry for each would put a permanent escape beside a
  // temporary one — and the permanent one is the one that survives. The dual-scope
  // entry covers them, under its own deadline. The proof that this is a suspension
  // and not a deletion is the case below.
  const r = runGate(fixture({ migration: dualMigration(), config: withDual(), manifest: RUNNING }))
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes('uniqueWithoutTenantColumn'), r.out)
})

test('RED: the unique rule comes BACK the moment the dual-scope entry is gone', () => {
  const r = runGate(fixture({ migration: dualMigration(), manifest: RUNNING }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("omits org_id"), `suspending the rule must not delete it:\n${r.out}`)
})

// ---------------------------------------------------------------------------
// W6 — the append-only audit trail
// ---------------------------------------------------------------------------
// Every case below perturbs exactly one property of a trail that is otherwise
// correct, because the failure mode this gate exists for is a trail that looks
// complete: the schema is there, the triggers are there, and one table is missing
// from the closure or one layer has been quietly removed.

test('RED: an org-scoped table with no audit trigger — the closure that makes the rest non-vacuous', () => {
  // Without this rule every other audit check is satisfiable by a well-built trail
  // that records nothing. It is also the likeliest real regression: a new vertical
  // copies the notes table, gets its policies and freeze trigger right, and simply
  // never adds the audit trigger — at which point that table's history does not exist
  // and nothing else in the chain notices.
  const r = runGate(fixture({ migration: tenancyMigration({ audit: auditSql({ notesTrigger: '' }) }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no AFTER INSERT OR UPDATE OR DELETE trigger'), r.out)
  assert.ok(r.out.includes('leave no record'), r.out)
})

test('GREEN: a table recorded in auditExemptTables with a reason is out of the closure', () => {
  // The escape the shipped contract uses for the metering counters: a derived row that
  // moves on every metered write, whose mover is already in the trail via the metered
  // table's own trigger. Without an escape the only way to silence that duplication is
  // to delete the closure rule itself, which is how a whole-tree rule becomes vacuous.
  const r = runGate(
    fixture({
      migration: tenancyMigration({ audit: auditSql({ notesTrigger: '' }) }),
      config: (c) => ({
        ...c,
        auditExemptTables: [{ table: 'notes', reason: 'exercising the escape, not a real exemption' }],
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a stale auditExemptTables entry naming a table no migration creates', () => {
  // The dangerous direction of staleness. An exemption outlives the table it was
  // written for, a later migration creates a NEW table under that name — a real
  // org-scoped one — and it arrives pre-exempted from the trail, with a reason in the
  // contract that describes a table that no longer exists to justify it.
  const r = runGate(
    fixture({
      config: (c) => ({
        ...c,
        auditExemptTables: [{ table: 'usage_counters', reason: 'the table this described was dropped' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("auditExemptTables names 'usage_counters'"), r.out)
  assert.ok(r.out.includes('table-shaped hole'), r.out)
})

test('RED: an audit trigger with a WHEN clause — a trail with a blind spot', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          notesTrigger:
            "CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE OR DELETE ON public.notes FOR EACH ROW WHEN (NEW.title <> 'secret') EXECUTE FUNCTION audit.write_row('org_id', 'id');",
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('carries a WHEN clause'), r.out)
})

test('RED: an audit trigger that skips one operation', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          notesTrigger:
            "CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');",
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not fire on DELETE'), r.out)
})

test('RED: a BEFORE audit trigger records writes the database then rejects', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          notesTrigger:
            "CREATE TRIGGER notes_audit BEFORE INSERT OR UPDATE OR DELETE ON public.notes FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');",
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('is BEFORE, not AFTER'), r.out)
})

test('RED: an audit trigger declaring the wrong tenant column files rows under the wrong org', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          // 'id' is a real column of notes, so the arg resolves — it is simply the
          // wrong one, which is why the check compares against the expected name
          // rather than merely asserting the column exists.
          notesTrigger:
            "CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE OR DELETE ON public.notes FOR EACH ROW EXECUTE FUNCTION audit.write_row('id', 'id');",
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("declares tenant column 'id', expected 'org_id'"), r.out)
})

test('RED: an UPDATE policy on the trail — layer 1 is the ABSENCE of one', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          insertPolicy: `CREATE POLICY events_insert_writer ON audit.events FOR INSERT TO ${AUDIT_W} WITH CHECK (actor_id IS NOT DISTINCT FROM (SELECT auth.uid()));
CREATE POLICY events_fix_typos ON audit.events FOR UPDATE TO ${AUDIT_W} USING (true);`,
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('the trail is append-only'), r.out)
})

test('RED: the layer-3 row trigger is missing — the only layer that binds BYPASSRLS', () => {
  // Layers 1 and 2 are policies and grants, and a role holding BYPASSRLS is subject to
  // neither. Verified against PostgreSQL 17: `postgres` on Supabase holds rolbypassrls
  // and the trigger still fires, which is what makes this layer load-bearing rather
  // than redundant.
  const r = runGate(fixture({ migration: tenancyMigration({ audit: auditSql({ rowGuard: '' }) }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('BYPASSRLS'), r.out)
})

test('RED: an immutability trigger with a WHEN clause is disarmable', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          rowGuard:
            "CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON audit.events FOR EACH ROW WHEN (OLD.action <> 'INSERT') EXECUTE FUNCTION audit.deny_mutation();",
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('disarmable immutability guard'), r.out)
})

test('RED: no TRUNCATE guard — no row trigger can substitute for it', () => {
  const r = runGate(fixture({ migration: tenancyMigration({ audit: auditSql({ truncGuard: '' }) }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('BEFORE TRUNCATE'), r.out)
})

test('RED: a partition with no TRUNCATE guard of its own — they are NOT cloned', () => {
  // The parent's guard covers `TRUNCATE audit.events` and nothing else. Verified:
  // PostgreSQL clones ROW triggers to partitions (including later ones) but never
  // TRUNCATE triggers, and truncating a leaf directly does not fire the parent's. A
  // trail guarded only at the parent is emptiable one month at a time.
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          truncGuard:
            'CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();',
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('TRUNCATE triggers are NOT cloned'), r.out)
})

test('RED: a FOREIGN KEY on the trail’s tenant key destroys the evidence with the org', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          auditTable: `CREATE TABLE audit.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  table_name text NOT NULL,
  PRIMARY KEY (org_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);`,
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must NOT be a foreign key'), r.out)
})

test('RED: actor_id as a column DEFAULT — a default is overridden by any writer that supplies it', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          auditTable: `CREATE TABLE audit.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid NOT NULL,
  actor_id uuid DEFAULT auth.uid(),
  action text NOT NULL,
  table_name text NOT NULL,
  PRIMARY KEY (org_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);`,
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has a column DEFAULT'), r.out)
})

test('RED: the INSERT policy does not constrain the actor — history can name anyone', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          insertPolicy: `CREATE POLICY events_insert_writer ON audit.events FOR INSERT TO ${AUDIT_W} WITH CHECK (org_id IS NOT NULL);`,
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not constrain actor_id'), r.out)
})

test('RED: a client role granted on the trail — layer 2 is that none is', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({ grants: 'GRANT SELECT ON TABLE audit.events TO service_role;' }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('service_role'), r.out)
  assert.ok(r.out.includes('BYPASSES RLS'), r.out)
})

test('RED: the audit writer is SECURITY INVOKER — every audited write would fail 42501', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          writeFn: `CREATE FUNCTION audit.write_row() RETURNS trigger LANGUAGE plpgsql SET search_path = ''
  AS $$ BEGIN INSERT INTO audit.events (org_id, actor_id, action, table_name) VALUES (NULL, private.caller_id(), TG_OP, TG_TABLE_NAME); RETURN NULL; END $$;`,
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not SECURITY DEFINER'), r.out)
})

test('RED: the audit writer takes no verified identity — it records what the writer claimed', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration({
        audit: auditSql({
          writeFn: `CREATE FUNCTION audit.write_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$ BEGIN INSERT INTO audit.events (org_id, actor_id, action, table_name) VALUES (NULL, NEW.owner_id, TG_OP, TG_TABLE_NAME); RETURN NULL; END $$;`,
        }),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('derives no verified identity'), r.out)
})

test('RED: the audit reader has no seat SELECT policy — the trail reads EMPTY and reports success', () => {
  // The mirror of the rpc-writer case, and the reason the pairing rule is closed over
  // every role rather than one: member_ranks() is INVOKER, so evaluating the trail's
  // SELECT policy reads memberships AS app_audit_reader. Without a self-only policy
  // there, the rank map is empty, the floor is never met, and org_audit_events()
  // returns nothing to the admin entitled to everything — which reads as "no activity"
  // rather than as a fault, so nobody investigates.
  const r = runGate(fixture({ migration: tenancyMigration({ audit: auditSql({ readerPairing: '' }) }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(AUDIT_R), r.out)
  assert.ok(r.out.includes('ZERO ROWS WHILE REPORTING SUCCESS'), r.out)
})

test('ADOPTION RAMP: a tenancy tree with no audit trail NOTEs on a pre-0.2.0 install', () => {
  // The audit migration is seedOnInitOnly, so `installer update` never plants it. An
  // install that adopted tenancy through the runbook therefore has tenancy and no
  // trail, and hard-failing it would be the upgrade ambush the ramp doctrine exists to
  // prevent. Adoption ramps; correctness never does — the case below is the proof.
  const r = runGate(
    fixture({ migration: tenancyMigration({ audit: '' }), manifest: { baseVersion: '0.1.3' } }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('the audit trail arrives in 0.2.0'), r.out)
})

test('REGRESSION: an ancient baseVersion must NOT disarm audit findings once a trail exists', () => {
  // The ramp covers "no trail yet", never "a trail with a hole in it". An install that
  // HAS the audit schema has adopted the surface, and a broken layer there is a hard
  // red regardless of manifest vintage.
  const r = runGate(
    fixture({
      migration: tenancyMigration({ audit: auditSql({ rowGuard: '' }) }),
      manifest: { baseVersion: '0.1.0' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('BYPASSRLS'), r.out)
})

test('FAIL CLOSED: auditWriterRole and auditReaderRole must not be the same role', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration(),
      config: (c) => ({ ...c, auditReaderRole: c.auditWriterRole }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('the split is the control'), r.out)
})

test('FAIL CLOSED: an auditSchema absent from nonPublicSchemas is a trail PostgREST may serve', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration(),
      config: (c) => ({ ...c, nonPublicSchemas: c.nonPublicSchemas.filter((s) => s !== 'audit') }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('contract disagrees with itself'), r.out)
})

test('RED: the audit schema published in [api].schemas', () => {
  const r = runGate(
    fixture({
      migration: tenancyMigration(),
      configToml: '[api]\nschemas = ["public", "graphql_public", "audit"]\n',
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("schema 'audit' is listed in [api].schemas"), r.out)
})
