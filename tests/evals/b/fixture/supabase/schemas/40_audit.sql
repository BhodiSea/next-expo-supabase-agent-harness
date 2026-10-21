-- supabase/schemas/40_audit.sql — the append-only audit trail.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see. The forward step that
-- builds this state, plus the full design argument and every verified Postgres fact
-- it rests on, is supabase/migrations/20260202000000_audit.sql. The decision record
-- is docs/adr/20260202-audit-trail.md.
--
-- WHY THIS SCHEMA IS NOT `public`. PostgREST exposes every table in every schema
-- listed in [api].schemas, and RLS on a partitioned PARENT does not cascade to its
-- partitions. A `public.audit_events` partitioned by month is therefore readable at
-- `GET /rest/v1/audit_events_2026_08` with the publishable key and any valid JWT, and
-- that request is judged by the PARTITION's policies — of which there are none. So
-- the trail lives in `audit`, which is absent from [api].schemas and on which no
-- client role holds USAGE. Both `tools/check-tenancy.mjs` and
-- `tools/check-rls-manifest.mjs` assert that absence, deliberately twice, because it
-- is the property whose failure is silent.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT STATE, and why it is not an omission.
-- `supabase db diff` builds the DESIRED state from this directory in a SHADOW
-- database that has never run a migration. Anything depending on an object a
-- migration creates therefore cannot appear here, or `db diff` fails outright and the
-- drift check that keeps this directory honest stops running at all. 05_tenancy.sql
-- takes the same decision for the same reason and declares its tables only.
--
-- So the following live in supabase/migrations/20260202000000_audit.sql:
--   * the app_audit_writer / app_audit_reader roles, and every GRANT and POLICY that
--     names them — including the two policies that are the read and write paths;
--   * audit.write_row(), which calls private.caller_id();
--   * the monthly partitions, created at runtime by audit.ensure_partitions() and
--     removed by audit.drop_partitions_older_than();
--   * the pg_cron schedule, which is a per-project setting rather than a schema fact;
--   * the AFTER triggers on the org-scoped tables in `public`.
--
-- What IS here is everything a shadow database can hold: the schema, the table, the
-- default partition, the index, RLS, and the immutability layers that need no role.
--
-- The escape entries in tools/rls-exempt.json name this table, because the
-- per-operation policy model that gate enforces is the WRONG model here: an
-- append-only table must have no UPDATE or DELETE policy at all. The rules that do
-- apply are in tools/check-tenancy.mjs, which closes over the four immutability
-- layers, the write path, and the audit trigger on every org-scoped table.

CREATE SCHEMA IF NOT EXISTS audit;

REVOKE ALL ON SCHEMA audit FROM PUBLIC;
REVOKE ALL ON SCHEMA audit FROM anon, authenticated, service_role;

CREATE TABLE audit.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  -- The partition key: a RANGE-partitioned table's PRIMARY KEY must contain it.
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- THE TENANT KEY, AND DELIBERATELY NOT A FOREIGN KEY. Every other org_id in this
  -- database REFERENCES public.orgs (id) ON DELETE CASCADE; here that would mean
  -- deleting an org deletes the record of what was done inside it — the trail erasing
  -- its own evidence, triggered by the act most likely to need investigating.
  org_id uuid NOT NULL,
  -- WHO, and NOT a column DEFAULT: a default is only applied when the writer OMITS
  -- the column, so `DEFAULT auth.uid()` records whoever the writer says they are. It
  -- is assigned inside audit.write_row() and cross-checked by the insert policy.
  actor_id uuid,
  action text NOT NULL,
  table_name text NOT NULL,
  row_id text,
  -- METADATA BY DEFAULT: which columns changed, not what they became.
  changed_columns text[] NOT NULL DEFAULT '{}',
  -- Value capture is per-column opt-in, declared as trigger arguments and mirrored in
  -- tools/audit-columns.json. An audit table that copies values is a second, less
  -- policied home for the data it audits.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- CORRELATION, NOT EVIDENCE. Server-minted on the paths the server controls;
  -- forgeable by a client talking straight to PostgREST. actor_id is the field with
  -- integrity.
  request_id text,
  CONSTRAINT events_action_known CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  CONSTRAINT events_table_name_length CHECK (char_length(table_name) BETWEEN 1 AND 128),
  PRIMARY KEY (org_id, occurred_at, id)
)
PARTITION BY RANGE (occurred_at);

-- A backstop AND a trap: a write never fails when maintenance has stopped, but a
-- month partition cannot be created once the default holds rows for that month.
CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;

CREATE INDEX events_org_recent_idx ON audit.events (org_id, occurred_at DESC, id DESC);

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
-- Not inherited: a partition's own RLS is what governs DIRECT access to it, and a
-- newly attached partition shows relrowsecurity = false regardless of the parent.
-- Enabled with zero policies, a partition denies every direct read while writes
-- routed through the parent are unaffected.
ALTER TABLE audit.events_default ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies — and a partition with RLS on and NO policy is deny-all for direct access [corpus: postgres/rls-force]
ALTER TABLE audit.events_default FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE audit.events FROM PUBLIC;
REVOKE ALL ON TABLE audit.events FROM anon, authenticated, service_role;

-- Layers 3 and 4 of append-only. Layer 3 survives a role holding BYPASSRLS (verified:
-- `postgres` on Supabase holds rolbypassrls and the trigger still fires); layer 4
-- exists because TRUNCATE produces no OLD/NEW pair, so no row trigger can see it.
CREATE OR REPLACE FUNCTION audit.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION 'audit.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted. Remove history by dropping a partition: audit.drop_partitions_older_than(interval).';
END
$deny$;

REVOKE ALL ON FUNCTION audit.deny_mutation() FROM PUBLIC;

-- Cloned automatically to every partition, present and future.
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();

-- NOT cloned to partitions — hence the per-partition twins, created here for the
-- default partition and by ensure_partitions() for every month.
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TRIGGER events_default_no_truncate
  BEFORE TRUNCATE ON audit.events_default
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

-- The two policies that complete this table — events_insert_writer (the row's actor
-- must match the database's own opinion of who is acting) and events_select_admin
-- (rank >= 30, the only read path) — are in the migration, because both name roles
-- that only the migration creates. That is the same split 05_tenancy.sql makes, and
-- the reason is stated in the header: a shadow database has never run a migration.
