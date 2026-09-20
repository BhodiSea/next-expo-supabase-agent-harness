-- 20260920000000_authenticated_write_revoke — take back the write privileges the
-- platform's defaults hand `authenticated` on the seven tables it may only read.
--
-- APPLIED HISTORY, NOT DESIRED STATE. Append-only like every other migration here.
--
-- THE GAP. Supabase's default privileges grant ALL on every new table in `public` to
-- anon, authenticated and service_role. The migrations that created these tables undid
-- that for anon and service_role and then wrote `GRANT SELECT ... TO authenticated`.
-- A GRANT adds a privilege. It removes nothing. So authenticated kept INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES and TRIGGER on tables whose whole design is that it
-- writes none of them:
--
--   orgs, memberships, invitations, admin_elevations — every write goes through a
--     definer RPC running as app_tenancy_rpc;
--   org_usage, org_quota, quota_defaults — a tenant that can write its own counter or
--     raise its own ceiling has no quota.
--
-- WHAT STILL HELD, and why this is a missing layer rather than an open door: all seven
-- are FORCE ROW LEVEL SECURITY and carry deny-all INSERT/UPDATE/DELETE policies for
-- authenticated, so a client write was refused by row security. But PostgreSQL checks
-- TABLE PRIVILEGES first and row security second, and this repo's rule is that the
-- grant is a boundary of its own rather than a formality behind the policy. Row
-- security also does not apply to TRUNCATE at all: that verb is governed by the
-- privilege alone. The Data API exposes no TRUNCATE, so nothing reached it, and that
-- is a property of the gateway rather than of this schema.
--
-- HOW IT WAS FOUND. supabase/tests/rls_structure.test.sql has asserted "authenticated
-- holds NO write grant" on the three seat tables since 0.2.0 and on admin_elevations
-- since 1.0.0, and it passed. On an unchanged tree it passed against the local
-- stack of Supabase CLI 2.115.0 (Postgres image 17.6.1.159) and failed against 2.117.0
-- (17.6.1.167): the newer local stack applies the default privileges to tables a
-- migration creates, which is what the platform documents for a project's `public`
-- schema. So the assertion was right all along, and for as long as it was green it was
-- green about a local database that was more locked down than the documented default.
--
-- REVOKE ALL, then re-GRANT SELECT, rather than revoking three verbs: the intended
-- privilege set is exactly {SELECT}, and naming what is kept cannot miss a privilege
-- the platform adds to its defaults later. One transaction, so no reader ever sees
-- the table without its SELECT.
-- adr: docs/adr/20260920-authenticated-write-revoke.md
-- SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
-- SOURCE: https://www.postgresql.org/docs/17/ddl-rowsecurity.html
REVOKE ALL ON TABLE public.orgs FROM authenticated;
REVOKE ALL ON TABLE public.memberships FROM authenticated;
REVOKE ALL ON TABLE public.invitations FROM authenticated;
REVOKE ALL ON TABLE public.admin_elevations FROM authenticated;
REVOKE ALL ON TABLE public.org_usage FROM authenticated;
REVOKE ALL ON TABLE public.org_quota FROM authenticated;
REVOKE ALL ON TABLE public.quota_defaults FROM authenticated;

GRANT SELECT ON TABLE public.orgs TO authenticated;
GRANT SELECT ON TABLE public.memberships TO authenticated;
GRANT SELECT ON TABLE public.invitations TO authenticated;
GRANT SELECT ON TABLE public.admin_elevations TO authenticated;
GRANT SELECT ON TABLE public.org_usage TO authenticated;
GRANT SELECT ON TABLE public.org_quota TO authenticated;
GRANT SELECT ON TABLE public.quota_defaults TO authenticated;
