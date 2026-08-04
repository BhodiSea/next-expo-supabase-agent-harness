-- supabase/seeds/scale.sql — the CARDINALITY the plan probe needs, and nothing else.
--
-- NOT applied by `supabase start` or `db reset` (those run supabase/seed.sql). This file
-- is loaded only by the path-filtered `db-scale` CI lane and by `pnpm db:scale`, because
-- it takes minutes and produces a database nobody wants to develop against.
--
-- WHY IT EXISTS. Every structural check in this repo — pgTAP's leading-column
-- assertion, `schema-rls`, `tenancy`, `query-shapes` — is true of a two-row table. The
-- one claim the whole tenancy design rests on is not: that
-- `org_id = ANY(<InitPlan uuid[]>)` with the list screen's keyset order is an ORDERED
-- INDEX SCAN and not a filter over every tenant's rows followed by a Sort. A planner
-- reaches that conclusion from STATISTICS, and on a seeded test database the statistics
-- say "this table is one page, scan it" — which is the right answer there and the wrong
-- answer in production. tools/check-db-perf.mjs asserts plan SHAPE against this data.
--
-- ── DETERMINISTIC, ENTIRELY ────────────────────────────────────────────────────
-- No gen_random_uuid(), no now(), no random(). Every id is md5 over the row's index
-- and every timestamp is an offset from a fixed epoch, so two runs produce byte-identical
-- data and a plan that changed is a change in the CODE, not in the fixture. A probe whose
-- input moves cannot distinguish a regression from a reseed.
--
-- ── SKEW: 3%, NOT 30% ──────────────────────────────────────────────────────────
-- The whale org holds 60k of 2M rows. That is deliberate and the number was chosen
-- against the planner rather than for narrative effect: around 30% of a table, the cost
-- of an index scan and the cost of a sequential scan cross, so the plan FLAPS with
-- autovacuum timing and the probe becomes a flaky test that teams delete. At 3% the
-- index is unambiguously cheaper and a Seq Scan is unambiguously a regression.
--
-- ── WHY THE RLS BYPASS IS `NO FORCE` AND NOT `row_security = off` ──────────────
-- `SET LOCAL row_security = off` does not do what its name suggests: it makes a query
-- ERROR when RLS would apply rather than bypassing it, and under `psql -f` outside an
-- explicit transaction `SET LOCAL` has no transaction to be local to and is a no-op with
-- a warning that scrolls past. The supported bypass for the table OWNER is to lift FORCE
-- for the load and restore it before COMMIT, inside one transaction, so no other session
-- ever observes the table unforced.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well [corpus: postgres/rls-force]

-- ── STATEMENT 1: THE "IS THIS A DEV DATABASE" GUARD ────────────────────────────
-- Database-side facts, so no shell spelling can dodge them. `psql "$SUPABASE_DB_URL"`
-- with a URL somebody pasted from the wrong tab is one keystroke from writing two
-- million rows into a customer's database; a check in the runner would be skipped by
-- running psql directly, which is exactly what a person in a hurry does.
--
-- IT IS NOT AN ADDRESS CHECK, and the first draft of this file was wrong about that.
-- `inet_server_addr()` returns the SERVER's own address, and the local Supabase stack
-- runs Postgres inside Docker: it answers `172.x.x.x` on a bridge network, never
-- `127.0.0.1`. Verified — the loopback version refused the very stack it exists to
-- seed. `inet_client_addr()` fails the same way through a published port (the client
-- appears as the Docker gateway), so neither address is the fact anyone wanted.
--
-- SUPERUSER IS NOT IT EITHER, and that was the second wrong draft. The local stack's
-- `postgres` role reports `is_superuser = off` — verified against the running CLI stack,
-- where `postgres` is `rolsuper = f`. The local role model now mirrors the hosted one
-- closely enough that superuser separates nothing.
--
-- The two facts that DO separate a dev stack from a customer's database:
--
--   1. BYPASSRLS on the connecting role. Locally `postgres` holds it; on hosted Supabase
--      it does not — the same platform fact tools/tenancy.json records as the reason the
--      seat-table design refuses to depend on elevation, and the fact the pgTAP suite
--      already observes from pg_roles. So a pasted hosted connection string is refused by
--      the platform's own role model rather than by a convention this file invented.
--   2. THE REPO'S OWN FIXTURES. supabase/seed.sql creates the 'acme' org on every
--      `db reset`. A database that has never had this repo's development seed applied is
--      not this repo's development database, whatever its address is.
--
-- Neither is sufficient alone: an operator on a self-managed cluster could hold
-- BYPASSRLS, and a restored dev backup could carry the fixtures. Together they describe
-- a database somebody would have to work at to confuse with production.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION
      'refusing to scale-seed: % does not hold BYPASSRLS, so this is not a local Supabase stack (hosted Supabase''s postgres role deliberately does not hold it). This file writes millions of rows and is for the db-scale lane only.',
      current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orgs WHERE slug = 'acme') THEN
    RAISE EXCEPTION
      'refusing to scale-seed: the development fixtures from supabase/seed.sql are absent, so this is not this repo''s development database. Run `supabase db reset` first.';
  END IF;
END
$$;

-- Row count is overridable so a constrained runner can go smaller, but
-- tools/check-db-perf.mjs holds a MINIMUM: seed below it and the probe refuses to
-- certify rather than quietly measuring a small table. The knob cannot buy a green.
\if :{?scale_rows}
\else
\set scale_rows 2000000
\endif
\if :{?scale_orgs}
\else
\set scale_orgs 2000
\endif
\if :{?scale_whale_rows}
\else
\set scale_whale_rows 60000
\endif
\set scale_users 50

BEGIN;

-- Triggers OFF for the load, and this is a correctness requirement rather than a speed
-- optimization. The audit trigger would write one audit row per note (doubling the write
-- volume and filling a monthly partition with fixture noise), and the per-org quota
-- trigger would raise 53400 the moment the whale org passed its 10k ceiling — the load
-- would abort halfway through. They are restored below, in the same transaction.
ALTER TABLE public.notes DISABLE TRIGGER USER;
ALTER TABLE public.orgs DISABLE TRIGGER USER;
ALTER TABLE public.memberships DISABLE TRIGGER USER;

-- Lifted only for the load and restored before COMMIT, so no other session ever observes
-- these tables unforced. See the header for why this and not `row_security = off`.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well, and NO FORCE returns the owner to the ordinary exemption [corpus: postgres/rls-force]
ALTER TABLE public.notes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orgs NO FORCE ROW LEVEL SECURITY;
-- SOURCE: PostgreSQL row security — NO FORCE returns the table owner to the ordinary
-- owner exemption for the duration of the load [corpus: postgres/rls-force]
ALTER TABLE public.memberships NO FORCE ROW LEVEL SECURITY;

-- ── Identities ─────────────────────────────────────────────────────────────────
-- auth.users FIRST: notes.owner_id and orgs.created_by both reference it, and a
-- deferred-constraint trick to load out of order would only hide the ordering bug.
-- No password hash — these accounts cannot sign in, and a committed credential is
-- valid until somebody remembers to rotate it.
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
SELECT
  md5('scale:user:' || i)::uuid,
  'authenticated', 'authenticated',
  'scale-user-' || i || '@example.test',
  jsonb_build_object('display_name', 'Scale User ' || i),
  TIMESTAMPTZ '2024-01-01 00:00:00+00',
  TIMESTAMPTZ '2024-01-01 00:00:00+00'
FROM generate_series(1, :scale_users) AS i
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, slug, name, kind, created_by, created_at, updated_at)
SELECT
  md5('scale:org:' || i)::uuid,
  'scale-org-' || i,
  'Scale Org ' || i,
  'team',
  md5('scale:user:' || ((i % :scale_users) + 1))::uuid,
  TIMESTAMPTZ '2024-01-01 00:00:00+00',
  TIMESTAMPTZ '2024-01-01 00:00:00+00'
FROM generate_series(1, :scale_orgs) AS i
ON CONFLICT (id) DO NOTHING;

-- One seat per org keeps `private.member_org_ids()` honest for every org, and user 1
-- additionally holds three seats — the whale plus two ordinary orgs. THREE, not one:
-- a probe user in exactly one org would make `org_id = ANY(<one-element array>)` a
-- degenerate case the planner can flatten to an equality, which is not the plan
-- production runs and not the plan this file exists to measure.
INSERT INTO public.memberships (user_id, org_id, role_rank, created_at, updated_at)
SELECT
  md5('scale:user:' || ((i % :scale_users) + 1))::uuid,
  md5('scale:org:' || i)::uuid,
  40,
  TIMESTAMPTZ '2024-01-01 00:00:00+00',
  TIMESTAMPTZ '2024-01-01 00:00:00+00'
FROM generate_series(1, :scale_orgs) AS i
ON CONFLICT (user_id, org_id) DO NOTHING;

INSERT INTO public.memberships (user_id, org_id, role_rank, created_at, updated_at)
SELECT
  md5('scale:user:1')::uuid,
  md5('scale:org:' || i)::uuid,
  40,
  TIMESTAMPTZ '2024-01-01 00:00:00+00',
  TIMESTAMPTZ '2024-01-01 00:00:00+00'
FROM generate_series(1, 3) AS i
ON CONFLICT (user_id, org_id) DO NOTHING;

-- ── The rows ───────────────────────────────────────────────────────────────────
-- Org 1 is the whale. Everything else round-robins over the remaining orgs, so each
-- ordinary org holds roughly the same modest count and the whale is the outlier the
-- planner has to price differently.
--
-- created_at advances 13 seconds per row across the WHOLE table rather than per org, so
-- each org's rows are interleaved through the range. That is what makes the keyset index
-- load-bearing: with per-org contiguous timestamps a seq scan would come back sorted by
-- accident and a missing index would not show.
--
-- One row in ten is archived, so `WHERE archived_at IS NULL` is a real predicate with a
-- real selectivity rather than a no-op the planner discards.
INSERT INTO public.notes (id, org_id, owner_id, title, body, created_at, updated_at, archived_at)
SELECT
  md5('scale:note:' || i)::uuid,
  CASE
    WHEN i <= :scale_whale_rows THEN md5('scale:org:1')::uuid
    ELSE md5('scale:org:' || (((i - :scale_whale_rows) % (:scale_orgs - 1)) + 2))::uuid
  END,
  md5('scale:user:' || ((i % :scale_users) + 1))::uuid,
  'Scale note ' || i,
  'Body for scale note ' || i,
  TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * interval '13 seconds'),
  TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * interval '13 seconds'),
  CASE WHEN i % 10 = 0 THEN TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * interval '17 seconds') END
FROM generate_series(1, :scale_rows) AS i
ON CONFLICT (org_id, id) DO NOTHING;

-- ── Bookkeeping the disabled triggers would have done ──────────────────────────
-- The counter is recomputed from count(*) rather than assumed, which is the same thing
-- public.reconcile_org_usage() does nightly and for the same reason: a counter that is
-- WRITTEN rather than DERIVED is a counter that is wrong after the first exception.
-- The whale's ceiling is raised explicitly — 60k rows under a 10k default would leave
-- the database in a state the quota trigger considers already-violated, so the first
-- honest write in that org after the seed would fail for a reason unrelated to the test.
INSERT INTO public.org_quota (org_id, metric, hard_limit)
SELECT md5('scale:org:' || i)::uuid, 'notes', 10000000
FROM generate_series(1, :scale_orgs) AS i
ON CONFLICT (org_id, metric) DO UPDATE SET hard_limit = excluded.hard_limit;

INSERT INTO public.org_usage (org_id, metric, used)
SELECT org_id, 'notes', count(*)
FROM public.notes
GROUP BY org_id
ON CONFLICT (org_id, metric) DO UPDATE SET used = excluded.used;

-- Restored INSIDE the transaction: a COMMIT that left any of these unforced would leave
-- the table owner exempt from every policy on it, which is the state the whole schema
-- exists to prevent.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well [corpus: postgres/rls-force]
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orgs FORCE ROW LEVEL SECURITY;
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well [corpus: postgres/rls-force]
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notes ENABLE TRIGGER USER;
ALTER TABLE public.orgs ENABLE TRIGGER USER;
ALTER TABLE public.memberships ENABLE TRIGGER USER;

COMMIT;

-- ANALYZE OUTSIDE THE TRANSACTION, AND NOT OPTIONAL. The planner reads pg_statistic,
-- not the heap: without fresh statistics it prices two million rows using whatever it
-- learned when the table was empty, and the plan probe would measure the seed's timing
-- rather than the query's shape. Autovacuum would get there eventually, which is not a
-- property a CI lane can wait on.
-- SOURCE: https://www.postgresql.org/docs/17/sql-analyze.html
ANALYZE public.notes;
ANALYZE public.orgs;
ANALYZE public.memberships;
