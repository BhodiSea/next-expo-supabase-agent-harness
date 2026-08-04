-- supabase/tests/audit_immutability.test.sql — the audit trail, proven against a
-- database rather than against migration text.
--
-- Run with `supabase test db`. Everything happens inside one transaction that ends in
-- ROLLBACK, so the suite leaves no residue and can run against a seeded database.
--
-- WHY THIS FILE EXISTS ALONGSIDE THE STATIC GATE. tools/check-tenancy.mjs reads the
-- migration text and can prove that four immutability layers were WRITTEN. It cannot
-- prove they BIND, and three of the facts the design rests on are properties of the
-- running database that no parser can reach:
--
--   * that the layer-3 trigger fires for a role holding BYPASSRLS (the entire reason
--     layers 1 and 2 are insufficient — a policy and a grant are both invisible to
--     such a role, and `postgres` on Supabase holds rolbypassrls);
--   * that TRUNCATE on a PARTITION is refused, which depends on the per-partition
--     triggers the maintenance function creates at RUNTIME and which therefore appear
--     in no migration at all;
--   * that the rank floor on the read path admits rank 30 and refuses rank 20 — the
--     same user, the same org, one column different.
--
-- The last is the assertion that matters most, because the failure it catches is
-- silent: private.member_ranks() is SECURITY INVOKER, so an audit reader without its
-- own seat policy reads an empty rank map, every comparison is false, and the trail
-- returns ZERO ROWS while reporting success. An admin sees "no activity" and does not
-- investigate. Only a bidirectional test — rank 30 sees rows AND rank 20 sees none —
-- distinguishes a working floor from a floor that refuses everyone.
-- SOURCE: docs/adr/20260202-audit-trail.md

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- Counted by hand against the assertions below. pgTAP fails a plan mismatch, which is
-- the point: an assertion deleted in a hurry cannot pass as a smaller suite.
SELECT plan(26);

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape
-- ─────────────────────────────────────────────────────────────────────────────
SELECT has_schema('audit', 'the audit schema exists');
SELECT has_table('audit', 'events', 'audit.events exists');

-- The partition horizon, read from pg_class AT RUNTIME rather than from migration
-- text. pg_cron is the real source of partitions, so a statically-derived horizon
-- shrinks by one day per day and eventually reds a perfectly healthy database.
SELECT cmp_ok(
  (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'audit.events'::regclass),
  '>=',
  2,
  'audit.events is partitioned with at least a month partition and the default'
);

-- EVERY partition carries RLS of its own. This is the breach in the obvious design:
-- RLS on a partitioned PARENT does not cascade, and a partition accessed DIRECTLY is
-- judged by its own policies. Enabled with ZERO policies, a partition is deny-all for
-- direct access while writes routed through the parent are unaffected — verified.
-- A partition created without this is one URL away from being readable.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well, and a partition's own RLS governs direct access to it [corpus: postgres/rls-force]
SELECT is_empty(
  $$ SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'audit.events'::regclass
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity) $$,
  'every partition of audit.events has RLS enabled AND forced'
);

-- Layer 1: the ABSENCE of an update/delete policy is a control, so assert the absence.
SELECT is_empty(
  $$ SELECT polname FROM pg_policy
      WHERE polrelid = 'audit.events'::regclass AND polcmd IN ('w', 'd', '*') $$,
  'audit.events has no UPDATE, DELETE or ALL policy (layer 1)'
);

-- Layer 2: no client role holds any privilege on the trail. service_role is the one
-- that matters most — it BYPASSES RLS, so for it the grant is the only binding control.
SELECT ok(
  NOT has_table_privilege('authenticated', 'audit.events', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'audit.events', 'INSERT')
  AND NOT has_table_privilege('anon', 'audit.events', 'SELECT')
  AND NOT has_table_privilege('service_role', 'audit.events', 'SELECT')
  AND NOT has_table_privilege('service_role', 'audit.events', 'INSERT'),
  'no client role holds a privilege on audit.events (layer 2)'
);

-- The schema itself is the outermost layer: without USAGE the NAME does not resolve,
-- so a policy or grant added by mistake is still unreachable.
SELECT ok(
  NOT has_schema_privilege('authenticated', 'audit', 'USAGE')
  AND NOT has_schema_privilege('anon', 'audit', 'USAGE')
  AND NOT has_schema_privilege('service_role', 'audit', 'USAGE'),
  'no client role holds USAGE on the audit schema'
);

-- The writer is a definer owned by a NOLOGIN role, and the reader is a DIFFERENT one.
SELECT is(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'audit.write_row()'::regprocedure),
  'app_audit_writer',
  'audit.write_row() is owned by app_audit_writer'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'audit.write_row()'::regprocedure),
  'audit.write_row() is SECURITY DEFINER'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('app_audit_writer', 'app_audit_reader') AND rolcanlogin),
  'neither audit role can log in'
);
-- The split is the control: a writer that can read is an exfiltration path that
-- leaves no audit row, because reading is the one thing the trail does not record.
SELECT ok(
  NOT has_table_privilege('app_audit_writer', 'audit.events', 'SELECT'),
  'the audit writer cannot READ the trail it appends to'
);
SELECT ok(
  NOT has_table_privilege('app_audit_reader', 'audit.events', 'INSERT'),
  'the audit reader cannot WRITE the trail it reads'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Coverage: every org-scoped table is audited, read from pg_trigger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMPORARY TABLE audited_targets (table_name text PRIMARY KEY);
INSERT INTO audited_targets (table_name) VALUES ('orgs'), ('memberships'), ('invitations'), ('notes');

SELECT is_empty(
  $$ SELECT t.table_name
       FROM audited_targets t
      WHERE NOT EXISTS (
        SELECT 1
          FROM pg_trigger g
         WHERE g.tgrelid = ('public.' || t.table_name)::regclass
           AND NOT g.tgisinternal
           AND g.tgfoid = 'audit.write_row()'::regprocedure
           -- tgtype bits: 1 = ROW, 4 = INSERT, 8 = DELETE, 16 = UPDATE.
           -- AFTER is the absence of bit 2 (BEFORE).
           AND (g.tgtype & 1) = 1
           AND (g.tgtype & 2) = 0
           AND (g.tgtype & 4) = 4
           AND (g.tgtype & 8) = 8
           AND (g.tgtype & 16) = 16
      ) $$,
  'every org-scoped table has an AFTER INSERT OR UPDATE OR DELETE row trigger writing the trail'
);

-- A WHEN clause is a documented blind spot whose condition is written by the person
-- the trail exists to record. pg_trigger.tgqual is NULL when there is none.
SELECT is_empty(
  $$ SELECT g.tgname
       FROM pg_trigger g
       JOIN audited_targets t ON g.tgrelid = ('public.' || t.table_name)::regclass
      WHERE NOT g.tgisinternal
        AND g.tgfoid = 'audit.write_row()'::regprocedure
        AND g.tgqual IS NOT NULL $$,
  'no audit trigger carries a WHEN clause'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Layer 3, against the role that layers 1 and 2 cannot touch
-- ─────────────────────────────────────────────────────────────────────────────
-- The suite runs as `postgres`, which holds BYPASSRLS on Supabase. That is not an
-- inconvenience to work around — it is precisely the condition under which layers 1
-- and 2 are inert, so it is the only condition under which layer 3 is worth testing.
SELECT ok(
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'the test runs as a role holding BYPASSRLS (so layers 1-2 are inert here by construction)'
);

-- Seed one row through the real trigger, as a real member, so the assertions below
-- have something to fail against. Written as alice (rank 40 in acme) from seed.sql.
CREATE TEMPORARY TABLE audit_probe AS
SELECT m.user_id, m.org_id
  FROM public.memberships m
 WHERE m.role_rank = 40
 ORDER BY m.org_id
 LIMIT 1;

-- The ids are interpolated with format(%L) rather than read from the temp table
-- inside the assertion: the statement switches to `authenticated`, and a temporary
-- table created by `postgres` is not readable by that role. Resolving them BEFORE the
-- role switch is also more honest about what is being tested — the write, not the
-- lookup.
SELECT lives_ok(
  format(
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    $fmt$ SELECT set_config('request.jwt.claims', %L, true);
          -- SOURCE: transaction-local GUCs — the identity must not outlive the transaction [corpus: postgres/guc-set-local]
          SET LOCAL ROLE authenticated;
          INSERT INTO public.notes (org_id, owner_id, title, body)
          VALUES (%L, %L, 'audit pgtap probe', 'x'); $fmt$,
    json_build_object('sub', (SELECT user_id FROM audit_probe), 'role', 'authenticated')::text,
    (SELECT org_id FROM audit_probe),
    (SELECT user_id FROM audit_probe)
  ),
  'a write by a real member succeeds and fires the audit trigger'
);
-- pgTAP's lives_ok carries no SET clause, so the role switch above outlives the
-- assertion. Every check below reads the audit schema, which `authenticated` cannot
-- resolve at all — without this they would fail on permissions rather than on facts.
RESET ROLE;

SELECT cmp_ok(
  (SELECT count(*)::int FROM audit.events WHERE table_name = 'public.notes' AND action = 'INSERT'),
  '>=', 1,
  'the write produced an audit row'
);
SELECT is(
  (SELECT actor_id FROM audit.events WHERE table_name = 'public.notes' ORDER BY id DESC LIMIT 1),
  (SELECT user_id FROM audit_probe),
  'the audit row names the acting user, derived inside the writer rather than supplied'
);
-- Metadata by default: an INSERT records WHICH row, not WHAT it contained.
SELECT is(
  (SELECT payload FROM audit.events WHERE table_name = 'public.notes' ORDER BY id DESC LIMIT 1),
  '{}'::jsonb,
  'notes are audited as metadata only — no value capture'
);

SELECT throws_ok(
  $$ UPDATE audit.events SET actor_id = NULL WHERE id = (SELECT max(id) FROM audit.events) $$,
  '42501',
  NULL,
  'UPDATE on the trail is refused (layer 3), for a BYPASSRLS role'
);
SELECT throws_ok(
  $$ DELETE FROM audit.events WHERE id = (SELECT max(id) FROM audit.events) $$,
  '42501',
  NULL,
  'DELETE on the trail is refused (layer 3), for a BYPASSRLS role'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Layer 4, on the parent AND on a partition
-- ─────────────────────────────────────────────────────────────────────────────
SELECT throws_ok(
  $$ TRUNCATE audit.events $$,
  '42501',
  NULL,
  'TRUNCATE on the parent is refused (layer 4)'
);
-- The one that a parent-only guard misses. TRUNCATE triggers are NOT cloned to
-- partitions, and truncating a leaf does not fire the parent's — so without the
-- per-partition twins the trail is emptiable one month at a time.
SELECT throws_ok(
  format('TRUNCATE audit.%I', (
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'audit.events'::regclass ORDER BY c.relname LIMIT 1
  )),
  '42501',
  NULL,
  'TRUNCATE on a PARTITION is refused — the guard is not inherited, so it is duplicated'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The read path, in BOTH directions
-- ─────────────────────────────────────────────────────────────────────────────
-- One assertion each way, on the SAME user and the SAME org. A one-directional test
-- cannot tell a working rank floor from one that refuses everybody, and "refuses
-- everybody" is the exact failure an INVOKER helper produces when its role has no
-- seat policy — silently, with a success status.
CREATE TEMPORARY TABLE rank_probe AS
SELECT m.user_id, m.org_id
  FROM public.memberships m
 WHERE m.role_rank = 40
 ORDER BY m.org_id
 LIMIT 1;

SELECT cmp_ok(
  (SELECT count(*)::int FROM (
     -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
     SELECT set_config('request.jwt.claims',
       json_build_object('sub', (SELECT user_id FROM rank_probe), 'role', 'authenticated')::text, true)
   ) _cfg, LATERAL public.org_audit_events((SELECT org_id FROM rank_probe))),
  '>=', 1,
  'a rank-40 member reads their own org''s trail'
);

-- The same call for an org the caller holds no seat in. The function takes the org as
-- an argument, so this is the assertion that the argument is a SELECTOR and not the
-- authorization: the policy is what returns nothing.
SELECT is_empty(
  $$ SELECT e.id FROM (
       -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
       SELECT set_config('request.jwt.claims',
         json_build_object('sub', (SELECT user_id FROM rank_probe), 'role', 'authenticated')::text, true)
     ) _cfg,
     LATERAL public.org_audit_events(
       (SELECT o.id FROM public.orgs o
         WHERE NOT EXISTS (SELECT 1 FROM public.memberships m
                            WHERE m.org_id = o.id AND m.user_id = (SELECT user_id FROM rank_probe))
         ORDER BY o.id LIMIT 1)
     ) e $$,
  'the org argument can only NARROW — an org the caller has no seat in returns the empty set'
);

-- THE RANK BOUNDARY ITSELF: a member of the SAME org, below the floor. This is the
-- assertion the whole read path turns on, because it is the only one that separates
-- "the floor works" from "the floor refuses everyone" — and refusing everyone is what
-- an audit reader without its own seat policy silently does. Paired with assertion 24
-- (a rank-40 member of an org DOES see rows) it closes both directions on the same
-- function, so a database in which every rank were 40, or in which the rank map read
-- empty, could not pass both.
CREATE TEMPORARY TABLE below_floor AS
SELECT m.user_id, m.org_id
  FROM public.memberships m
 WHERE m.role_rank < 30
 ORDER BY m.org_id, m.user_id
 LIMIT 1;

SELECT is_empty(
  format(
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    $fmt$ SELECT e.id FROM (SELECT set_config('request.jwt.claims', %L, true)) _cfg,
          LATERAL public.org_audit_events(%L) e $fmt$,
    json_build_object('sub', (SELECT user_id FROM below_floor), 'role', 'authenticated')::text,
    (SELECT org_id FROM below_floor)
  ),
  'a member BELOW the rank floor reads nothing from an org they genuinely belong to'
);

SELECT * FROM finish();
ROLLBACK;
