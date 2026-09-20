# 20260920 — Revoke the default write privileges from `authenticated` on read-only tables

- **Status:** Accepted
- **Date:** 2026-09-20
- **Slice:** authenticated-write-revoke

## Context

Seven tables are read-only to the `authenticated` role by design. Seats and
elevations (`orgs`, `memberships`, `invitations`, `admin_elevations`) are written only
through definer RPCs running as `app_tenancy_rpc`. The quota tables (`org_usage`,
`org_quota`, `quota_defaults`) are written only by `app_quota_writer`, because a tenant
that can write its own counter or raise its own ceiling has no quota.

Supabase's default privileges grant ALL on every new table in `public` to `anon`,
`authenticated` and `service_role`. The migrations that created these tables revoked
that from `anon` and `service_role`, then wrote `GRANT SELECT ... TO authenticated`. A
GRANT adds a privilege and removes none, so `authenticated` kept INSERT, UPDATE,
DELETE, TRUNCATE, REFERENCES and TRIGGER on all seven.

Row security still refused every client write: each table is `FORCE ROW LEVEL
SECURITY` with deny-all INSERT, UPDATE and DELETE policies for `authenticated`. Two
things make that insufficient by this project's own rules. PostgreSQL checks table
privileges before row security, and the security invariants treat the grant as a
boundary of its own. And row security does not apply to TRUNCATE at all; only the
privilege governs it. The Data API exposes no TRUNCATE, so nothing reached it, but that
is a property of the gateway and not of the schema.

`supabase/tests/rls_structure.test.sql` has asserted "authenticated holds NO write
grant" on the seat tables since 0.2.0. On an unchanged tree it passed against the local
stack of Supabase CLI 2.115.0 (Postgres image 17.6.1.159) and failed against 2.117.0
(17.6.1.167). The newer local stack applies the default privileges to tables a
migration creates. The assertion was right; the database it had been passing against
was more locked down than the documented default.

Migration discipline bounds the fix: a committed migration is never edited, because
`supabase db push` records migrations by filename and an edit changes nothing on a
database that already ran it.

## Decision

Add one forward migration, `20260920000000_authenticated_write_revoke.sql`, that runs
`REVOKE ALL ON TABLE ... FROM authenticated` and then `GRANT SELECT ON TABLE ... TO
authenticated` for each of the seven tables. The declarative twin
`supabase/schemas/30_quota.sql` gains the same REVOKE lines. The structure test gains an
assertion that `authenticated` holds exactly `{SELECT}` on all seven, which covers
TRUNCATE, REFERENCES, TRIGGER and `quota_defaults`, none of which the older assertions
named.

REVOKE ALL followed by GRANT SELECT, not a revoke of three verbs: the intended set is
exactly `{SELECT}`, and stating what is kept cannot miss a privilege the platform adds
to its defaults later.

## Alternatives Considered

- **Edit the creating migrations to revoke in place.** Rejected. It would fix fresh
  scaffolds and leave every deployed database untouched while the committed history
  claimed otherwise, which is the divergence append-only exists to prevent.
- **Pin the Supabase CLI to 2.115.0 so the test passes again.** Rejected as a fix. It
  would restore a green result about a local database that does not match the
  documented default, and it changes nothing on a hosted project.
- **Revoke only INSERT, UPDATE and DELETE.** Rejected. It leaves TRUNCATE, the one
  write verb row security does not cover, and it names today's defaults instead of the
  intended state.
- **Rely on row security alone and delete the assertion.** Rejected. It removes a
  layer this project's invariants require and deletes the test that found the gap.

## Consequences

- New scaffolds get the migration. Existing installs do not have it planted: a
  project's `supabase/migrations/` is its own applied history, and a file with this
  timestamp could sort ahead of migrations the project has already applied. The
  harness upgrade runbook gives the SQL for a project to put in a migration of its own.
- An existing install that upgrades its Supabase CLI will see its copy of the
  structure test fail until it applies that SQL. That failure is accurate.
- No application code changes. `authenticated` never wrote these tables, and every
  reader keeps SELECT. The REVOKE and GRANT run in one transaction, so no reader sees a
  table without its SELECT.
- A local stack can differ from the platform in ways a green test hides. This is the
  second finding in this release caused by something moving unobserved, and the
  Supabase CLI is still a caret range in the catalog.

## Sources

- <https://www.postgresql.org/docs/17/ddl-priv.html> — privileges are additive; REVOKE
  ALL and the privilege list for tables.
- <https://www.postgresql.org/docs/17/ddl-rowsecurity.html> — row security is checked
  after table privileges and does not apply to TRUNCATE.

## Traceability

| Requirement | Migration / DAL / route / UI files | Test ids |
| ----------- | ---------------------------------- | -------- |
| R1: `authenticated` holds exactly SELECT on the seven read-only tables | `supabase/migrations/20260920000000_authenticated_write_revoke.sql`, `supabase/schemas/30_quota.sql` | `supabase/tests/rls_structure.test.sql > authenticated holds exactly SELECT on every read-only table` |
| R2: readers keep SELECT | same | `supabase/tests/rls_structure.test.sql > authenticated can still SELECT orgs, memberships, invitations and admin_elevations` |
