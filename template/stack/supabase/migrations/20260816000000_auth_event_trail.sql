-- 20260816000000_auth_event_trail — authentication events, successful AND
-- unsuccessful, in an append-only trail the auth service itself writes to
-- (Essential Eight: "successful and unsuccessful … authentication events are
-- centrally logged" — the halves the vendor's own auth.audit_log_entries cannot
-- give you; see the honesty section below).
--
-- APPLIED HISTORY, NOT DESIRED STATE. Append-only and DML-free, like every file
-- in this directory.
--
-- ── THE SEAM, AND WHY IT IS THE ONLY CORRECT ONE ──────────────────────────────
-- A failed sign-in belongs to somebody who never got a session, so no client-side
-- seam can see it: the app's sign-in form observes only ITS OWN failures, and an
-- attacker running credential stuffing against PostgREST's token endpoint never
-- renders your form at all. The only process that sees every attempt is GoTrue,
-- and GoTrue exposes exactly one extension point at that moment: AUTH HOOKS —
-- Postgres functions it calls synchronously during the attempt
-- ([auth.hook.password_verification_attempt] and
-- [auth.hook.mfa_verification_attempt] in supabase/config.toml, pg-functions
-- URIs). Verified against the pinned CLI: FAILED attempts do fire both hooks.
--
-- ── CEILINGS, STATED RATHER THAN IMPLIED ─────────────────────────────────────
--   * An attempt against an email with NO user row fires nothing — GoTrue looks
--     the user up first, so pure username-enumeration sweeps are invisible here.
--     (They are visible in the platform's HTTP logs, which is the organisation's
--     collection surface, not this schema's.)
--   * The password hook covers the password grant. An OAuth or magic-link
--     sign-in does not traverse it; MFA verification has its own hook, wired
--     below.
--   * On hosted Supabase, auth hooks are plan-gated; locally and in CI they are
--     unconditional. The register grades with that ceiling stated.
--
-- ── WHO CAN READ THIS: NOBODY, AND THAT IS THE DESIGN ────────────────────────
-- The audit trail (audit.events) has a rank-30 read path because tenant admins
-- are entitled to their org's history. This trail is ORG-LESS — a failed password
-- attempt has no tenant — and its natural reader is the operator responding to an
-- incident, whose access is the database itself (psql, the dashboard's SQL
-- editor as postgres). So there is NO reader role, NO read policy and NO
-- PostgREST path at all: the read posture is "the operator's own database
-- access", recorded here as a decision rather than left as an omission. A future
-- release can add a definer read surface if a product ever needs one; adding it
-- casually is exactly what this paragraph exists to make visible.
-- SOURCE: tools/essential-eight.json (the register grading these controls; its
-- source block pins ASD's Essential Eight Maturity Model URL)
--
-- The REVOKEs below remove default grants from client roles (the schema wall and
-- layer 2), and drop_partitions_older_than() is the retention DDL — both are the
-- decisions the record explains:
-- adr: docs/adr/20260816-auth-event-trail.md

SET lock_timeout = '3s';

-- One writer role, no reader role — see the header. Idempotent for the same
-- reset-survives-roles reason as every role in this directory.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_auth_trail_writer') THEN
    CREATE ROLE app_auth_trail_writer NOLOGIN;
  END IF;
END
$roles$;

GRANT app_auth_trail_writer TO postgres;

CREATE SCHEMA IF NOT EXISTS auth_trail;

-- The schema wall, exactly as audit's: no USAGE, so the table name does not even
-- resolve for a client role, and the schema is never listed in [api].schemas
-- (tools/tenancy.json nonPublicSchemas is the reviewed census the tenancy gate
-- closes against config.toml).
REVOKE ALL ON SCHEMA auth_trail FROM PUBLIC;
REVOKE ALL ON SCHEMA auth_trail FROM anon, authenticated, service_role;
GRANT USAGE, CREATE ON SCHEMA auth_trail TO app_auth_trail_writer;
-- GoTrue connects as supabase_auth_admin and must RESOLVE the hook functions'
-- names; USAGE on the schema plus EXECUTE on the two functions is its whole
-- reach — it holds no privilege on the table underneath.
GRANT USAGE ON SCHEMA auth_trail TO supabase_auth_admin;

-- ─────────────────────────────────────────────────────────────────────────────
-- auth_trail.events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE auth_trail.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- NULLABLE AND DELIBERATELY NOT A FOREIGN KEY, for the audit trail's reason
  -- one schema over, sharpened: account deletion must never erase the record of
  -- attempts against that account, and a failed attempt during signup races
  -- may reference a user GoTrue is still minting. The id is an opaque value
  -- that outlives whatever it names.
  user_id uuid,
  -- The trail's own CLOSED vocabulary — never GoTrue's enum, which upgrades
  -- with the auth server and would put a moving vendor surface inside a CHECK
  -- constraint this directory can never edit.
  event_kind text NOT NULL,
  -- Which factor an MFA attempt exercised; NULL for password events.
  factor_id uuid,
  -- The claim GoTrue hands the hook, kept whole: it is small, it is the
  -- evidence an investigator actually wants, and selecting fields out of it
  -- would be a second vendor coupling.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT events_kind_known CHECK (
    event_kind IN ('password_success', 'password_failure', 'mfa_success', 'mfa_failure')
  ),
  PRIMARY KEY (occurred_at, id)
)
PARTITION BY RANGE (occurred_at);

-- Backstop-and-trap default partition, exactly as audit.events_default and for
-- the same two reasons — a trail that can refuse a write is a trail that can be
-- used to deny sign-in, and a month partition cannot be created once the
-- default holds that month's rows.
CREATE TABLE auth_trail.events_default PARTITION OF auth_trail.events DEFAULT;
ALTER TABLE auth_trail.events_default ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies — and a partition with RLS on and NO policy is deny-all for direct access [corpus: postgres/rls-force]
ALTER TABLE auth_trail.events_default FORCE ROW LEVEL SECURITY;

-- The incident-response read shape: recent attempts against one account.
CREATE INDEX events_user_recent_idx ON auth_trail.events (user_id, occurred_at DESC, id DESC);

ALTER TABLE auth_trail.events ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
ALTER TABLE auth_trail.events FORCE ROW LEVEL SECURITY;

-- Layer 2: no client role, and no AUTH role either — supabase_auth_admin
-- executes the definer functions and touches nothing directly.
REVOKE ALL ON TABLE auth_trail.events FROM PUBLIC;
REVOKE ALL ON TABLE auth_trail.events FROM anon, authenticated, service_role;
GRANT INSERT ON TABLE auth_trail.events TO app_auth_trail_writer;

-- ─────────────────────────────────────────────────────────────────────────────
-- Layers 3 and 4: immutability that survives BYPASSRLS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION auth_trail.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION 'auth_trail.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted. Remove history by dropping a partition: auth_trail.drop_partitions_older_than(interval).';
END
$deny$;

REVOKE ALL ON FUNCTION auth_trail.deny_mutation() FROM PUBLIC;

-- Layer 3: cloned to every partition, present and future.
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON auth_trail.events
  FOR EACH ROW EXECUTE FUNCTION auth_trail.deny_mutation();

-- Layer 4 on the parent, the default partition, and (via ensure_partitions)
-- every month — TRUNCATE triggers are not cloned.
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON auth_trail.events
  FOR EACH STATEMENT EXECUTE FUNCTION auth_trail.deny_mutation();
CREATE TRIGGER events_default_no_truncate
  BEFORE TRUNCATE ON auth_trail.events_default
  FOR EACH STATEMENT EXECUTE FUNCTION auth_trail.deny_mutation();

-- Layer 1: the INSERT policy is the writer's whole licence. No update/delete
-- policy exists for any role, and there is deliberately no SELECT policy at all
-- (see the header: the read posture is the operator's own database access).
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row [corpus: postgres/rls-force]
CREATE POLICY events_insert_writer ON auth_trail.events
  AS PERMISSIVE FOR INSERT TO app_auth_trail_writer
  WITH CHECK (
    event_kind IN ('password_success', 'password_failure', 'mfa_success', 'mfa_failure')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- The hooks — the only things that ever insert
-- ─────────────────────────────────────────────────────────────────────────────
-- Both are SECURITY DEFINER owned by the writer role (FORCE RLS subjects the
-- owner to the insert policy, exactly as audit.write_row), pin an empty
-- search_path, and take the single `event jsonb` argument the hook contract
-- defines. THE EXCEPTION WRAP IS THE LOAD-BEARING DECISION: a hook that raises
-- fails the sign-in it observes, so a full disk or a dropped partition would
-- lock every user out of the product. A trail must never be able to deny
-- service — the failure direction is a lost row, chosen deliberately and
-- recorded here. Both ALWAYS return {"decision":"continue"}: this trail
-- observes; it does not decide.
-- SOURCE: supabase/config.toml [auth.hook.password_verification_attempt] /
-- [auth.hook.mfa_verification_attempt] — the pg-functions hook contract wired
-- in the same diff as this migration
CREATE FUNCTION auth_trail.password_verification_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $hook$
BEGIN
  BEGIN
    INSERT INTO auth_trail.events (user_id, event_kind, payload)
    VALUES (
      (event ->> 'user_id')::uuid,
      CASE WHEN (event ->> 'valid')::boolean THEN 'password_success' ELSE 'password_failure' END,
      event
    );
  EXCEPTION WHEN OTHERS THEN
    -- Swallowed on purpose — see the header. RAISE WARNING keeps the fault
    -- visible in the database log without touching the attempt's outcome.
    RAISE WARNING 'auth_trail.password_verification_hook: % (row lost, sign-in unaffected)', SQLERRM;
  END;
  RETURN jsonb_build_object('decision', 'continue');
END
$hook$;

CREATE FUNCTION auth_trail.mfa_verification_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $hook$
BEGIN
  BEGIN
    INSERT INTO auth_trail.events (user_id, event_kind, factor_id, payload)
    VALUES (
      (event ->> 'user_id')::uuid,
      CASE WHEN (event ->> 'valid')::boolean THEN 'mfa_success' ELSE 'mfa_failure' END,
      (event ->> 'factor_id')::uuid,
      event
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auth_trail.mfa_verification_hook: % (row lost, sign-in unaffected)', SQLERRM;
  END;
  RETURN jsonb_build_object('decision', 'continue');
END
$hook$;

ALTER FUNCTION auth_trail.password_verification_hook(jsonb) OWNER TO app_auth_trail_writer;
ALTER FUNCTION auth_trail.mfa_verification_hook(jsonb) OWNER TO app_auth_trail_writer;

-- EXECUTE to the auth server alone. PUBLIC/anon/authenticated are revoked for
-- the reason every definer in this directory revokes them; service_role too —
-- an Edge Function has no business writing sign-in history.
REVOKE ALL ON FUNCTION auth_trail.password_verification_hook(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_trail.password_verification_hook(jsonb) FROM anon, authenticated, service_role;
REVOKE ALL ON FUNCTION auth_trail.mfa_verification_hook(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_trail.mfa_verification_hook(jsonb) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth_trail.password_verification_hook(jsonb) TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth_trail.mfa_verification_hook(jsonb) TO supabase_auth_admin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Partition maintenance — audit's machinery, one schema over
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION auth_trail.ensure_partitions(_months_ahead int DEFAULT 3)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $ensure$
DECLARE
  _i int := 0;
  _created int := 0;
  _start date;
  _stop date;
  _name text;
BEGIN
  WHILE _i <= _months_ahead LOOP
    _start := (date_trunc('month', now()) + (_i || ' months')::interval)::date;
    _stop := (_start + interval '1 month')::date;
    _name := 'events_' || to_char(_start, 'YYYY_MM');

    IF to_regclass('auth_trail.' || quote_ident(_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE auth_trail.%I PARTITION OF auth_trail.events FOR VALUES FROM (%L) TO (%L)',
        _name, _start, _stop
      );
      EXECUTE format('ALTER TABLE auth_trail.%I ENABLE ROW LEVEL SECURITY', _name);
      -- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies; a partition carrying RLS with no policy of its own is deny-all for direct access [corpus: postgres/rls-force]
      EXECUTE format('ALTER TABLE auth_trail.%I FORCE ROW LEVEL SECURITY', _name);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON auth_trail.%I FOR EACH STATEMENT EXECUTE FUNCTION auth_trail.deny_mutation()',
        _name || '_no_truncate', _name
      );
      _created := _created + 1;
    END IF;
    _i := _i + 1;
  END LOOP;
  RETURN _created;
END
$ensure$;

CREATE FUNCTION auth_trail.drop_partitions_older_than(_keep interval DEFAULT interval '24 months')
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $retain$
DECLARE
  _dropped int := 0;
  _rec record;
  _month date;
BEGIN
  FOR _rec IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'auth_trail.events'::regclass
     ORDER BY c.relname
  LOOP
    _month := to_date(substring(_rec.relname from 'events_([0-9]{4}_[0-9]{2})$'), 'YYYY_MM');
    IF _month IS NOT NULL AND _month < date_trunc('month', now() - _keep) THEN
      EXECUTE format('ALTER TABLE auth_trail.events DETACH PARTITION auth_trail.%I', _rec.relname);
      EXECUTE format('DROP TABLE auth_trail.%I', _rec.relname);
      _dropped := _dropped + 1;
    END IF;
  END LOOP;
  RETURN _dropped;
END
$retain$;

REVOKE ALL ON FUNCTION auth_trail.ensure_partitions(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_trail.drop_partitions_older_than(interval) FROM PUBLIC;

-- The first months exist from the start, so the default partition begins empty.
SELECT auth_trail.ensure_partitions();

-- Hand back the ownership-transfer membership, as every migration here does.
REVOKE app_auth_trail_writer FROM postgres;
