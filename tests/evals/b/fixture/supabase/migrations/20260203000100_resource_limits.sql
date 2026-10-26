-- supabase/migrations/20260203000100_resource_limits.sql — per-role resource ceilings.
--
-- WHAT ACTUALLY MAKES THESE BIND, because the obvious reading of the manual says they
-- do not and the obvious reading is half right.
--
-- `ALTER ROLE x SET y` writes a row into pg_db_role_setting, which PostgreSQL applies
-- WHEN ROLE x STARTS A SESSION. `SET ROLE` does not start a session, so it does not
-- re-apply anything — verified directly: connected as `authenticator` (the role
-- PostgREST logs in as), `SET LOCAL ROLE authenticated` left statement_timeout at the
-- AUTHENTICATOR's value, not at the one set on `authenticated`. On that evidence alone
-- every line below would be inert.
--
-- It is not inert, because PostgREST reads pg_db_role_setting for the role it is about
-- to impersonate and applies those settings itself, per request. Verified end to end:
-- with `anon` set to 2s and `authenticator` at 8s, a 5-second RPC called through
-- PostgREST as anon was cancelled at 2.03s with SQLSTATE 57014.
--
-- THE CONSEQUENCE IS A REAL AND UNEVEN BOUNDARY, and it is stated here rather than
-- discovered in an incident: these ceilings bind traffic that arrives THROUGH
-- PostgREST — which is every supabase-js call from web and mobile, i.e. the product —
-- and they do NOT bind a direct connection. An Edge Function using a Postgres driver,
-- a migration, a psql session, or Supavisor in session mode all log in as some other
-- role and get THAT role's settings. For those the binding ceiling is `authenticator`
-- (8s, set by the Supabase image) or `postgres` (unlimited).
--
-- That is also why a pgTAP assertion over pg_db_role_setting is necessary but NOT
-- sufficient: it proves the row exists, which is what PostgREST reads, but it cannot
-- prove PostgREST applied it. public.effective_limits() below closes that gap — the
-- client suite calls it THROUGH PostgREST and compares what the database actually has
-- in force against tools/db-limits.json.
-- SOURCE: https://www.postgresql.org/docs/17/sql-alterrole.html (ALTER ROLE ... SET takes effect when the role starts a new session)

SET lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- statement_timeout — the ceiling on ONE query's duration
-- ─────────────────────────────────────────────────────────────────────────────
-- anon is tightest: an unauthenticated caller has no legitimate long query, and this
-- is the surface reachable with a key that ships in every client bundle.
ALTER ROLE anon SET statement_timeout = '3s';
-- authenticated gets more room for a legitimately heavy list or aggregate, and still
-- far less than the 8s the authenticator allows a direct connection.
ALTER ROLE authenticated SET statement_timeout = '8s';
-- service_role bypasses RLS and exists for elevated back-office work, so it gets the
-- most — but a ceiling nonetheless, because "elevated" is exactly the credential whose
-- runaway query nobody notices until the pool is gone.
ALTER ROLE service_role SET statement_timeout = '30s';

-- ─────────────────────────────────────────────────────────────────────────────
-- idle_in_transaction_session_timeout — the ceiling on a HELD transaction
-- ─────────────────────────────────────────────────────────────────────────────
-- The one that actually saves the database. An idle-in-transaction session holds its
-- snapshot, so autovacuum cannot remove any tuple newer than it: one forgotten BEGIN
-- bloats every hot table for as long as it lives, and it also blocks every ACCESS
-- EXCLUSIVE migration behind it. Bounded far tighter than statement_timeout because no
-- correct application ever holds an open transaction while doing nothing.
ALTER ROLE anon SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE authenticated SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE service_role SET idle_in_transaction_session_timeout = '60s';

-- ─────────────────────────────────────────────────────────────────────────────
-- lock_timeout — the ceiling on WAITING for someone else
-- ─────────────────────────────────────────────────────────────────────────────
-- Without it a request that collides with a migration's ACCESS EXCLUSIVE lock waits
-- indefinitely, and the queue behind it becomes the outage. Failing fast turns a
-- deploy-time collision into a handful of retryable errors instead.
ALTER ROLE anon SET lock_timeout = '2s';
ALTER ROLE authenticated SET lock_timeout = '3s';
ALTER ROLE service_role SET lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- Two knobs the plan called for that are NOT here, recorded rather than faked
-- ─────────────────────────────────────────────────────────────────────────────
-- temp_file_limit: superuser-only (PGC_SUSET). `postgres` on Supabase is NOT a
-- superuser, so `ALTER ROLE authenticated SET temp_file_limit` fails outright with
-- "permission denied to set parameter" — verified. There is no way to set it from a
-- migration on this platform. A large sort therefore still spills without a per-role
-- cap; the cluster-wide setting is the platform's to make.
--
-- CONNECTION LIMIT: `authenticator` is a RESERVED role — "only superusers can modify
-- it" — verified, so the one role where a connection cap would bind cannot take one.
-- Setting it on anon/authenticated/service_role is possible and completely INERT,
-- because a connection limit applies to the role that LOGS IN and none of those three
-- ever do. Shipping it would put a plausible number in pg_authid that bounds nothing,
-- which is worse than shipping nothing: a reviewer would read it as a control.
-- Connection count is bounded by Supavisor's pool size, which is platform config.

-- ─────────────────────────────────────────────────────────────────────────────
-- The binding proof
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns what is IN FORCE for the caller, not what a catalog table says should be.
-- Its whole reason to exist is that those two can differ: pg_db_role_setting is
-- readable by a pgTAP suite running as postgres, but only a call arriving through
-- PostgREST can show whether PostgREST applied the row. The client suite asserts these
-- against tools/db-limits.json, so a limit that stops binding — a PostgREST version
-- that drops the feature, a role renamed, a setting reset by hand — reds.
--
-- SECURITY INVOKER, so it reports the CALLER's context rather than an owner's, which
-- is the only reading that means anything. It discloses three timeouts and no data.
CREATE FUNCTION public.effective_limits()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $limits$
  SELECT jsonb_build_object(
    'role', current_user,
    -- SOURCE: https://www.postgresql.org/docs/17/functions-admin.html (current_setting reports the value in force for THIS session, missing_ok = true)
    'statement_timeout', pg_catalog.current_setting('statement_timeout', true),
    'idle_in_transaction_session_timeout', pg_catalog.current_setting('idle_in_transaction_session_timeout', true),
    'lock_timeout', pg_catalog.current_setting('lock_timeout', true)
  );
$limits$;

REVOKE ALL ON FUNCTION public.effective_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_limits() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Make the ceilings above ACTUALLY BIND. Without this line they are inert.
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgREST does not read pg_db_role_setting per request. It loads the role settings
-- into its SCHEMA CACHE and applies the cached values, so a ceiling changed by a
-- migration does not reach API traffic until that cache is rebuilt.
--
-- Supabase installs a `pgrst_ddl_watch` event trigger on ddl_command_end that issues
-- exactly this NOTIFY, which is why ordinary DDL needs no such line — and it does not
-- help here. Event triggers DO NOT FIRE for shared/global objects, and roles are
-- shared objects, so `ALTER ROLE ... SET` is precisely the DDL that trigger cannot
-- observe. The one statement class that needs the reload is the one class that never
-- gets it automatically.
--
-- MEASURED, not reasoned. Against a live stack with pgrst_ddl_watch installed:
-- `ALTER ROLE anon RESET statement_timeout` removed the catalog row, and PostgREST
-- kept reporting the old '3s' through public.effective_limits(). After
-- `NOTIFY pgrst, 'reload schema'` it reported '8s' — the authenticator's value, anon's
-- own ceiling correctly gone. This is also why a FRESH stack looks fine and hid the
-- bug: `supabase start` boots PostgREST after migrations, so it reads current values
-- once and every local run agrees. The failure only appears where it costs something —
-- an existing project taking a migration that tightens a ceiling, which then silently
-- does not bind until PostgREST restarts for some unrelated reason.
--
-- Transactional: delivered at COMMIT, so a migration that rolls back sends nothing.
-- SOURCE: https://www.postgresql.org/docs/17/event-trigger-matrix.html (event triggers do not fire for shared objects)
-- SOURCE: https://docs.postgrest.org/en/stable/references/schema_cache.html (role settings live in the schema cache; NOTIFY pgrst reloads it)
NOTIFY pgrst, 'reload schema';
