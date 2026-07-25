# supabase — the shared backend (schema, RLS, tests, functions)

ONE Postgres database that the Next web host and the Expo mobile client both reach through the
SAME RLS policies. Schema truth is SQL-first; there is no ORM.

## Layout

- `schemas/*.sql` — the DECLARATIVE source of truth (`00_shared`, `10_account`, `20_notes`, …),
  the desired end-state a reviewer reads.
- `migrations/<timestamp>_<slice>.sql` — the APPLIED, append-only history. `supabase db push`
  records a migration by FILENAME, so editing an already-applied file changes nothing on a
  database that ran it and silently diverges deployed schema from committed history. Never edit
  or delete a committed migration — add a new timestamped one (`supabase migration new`).
- `tests/*.sql` — pgTAP. `rls_structure.test.sql` reads back what the database compiled;
  `rls_isolation.test.sql` proves the empty-set principle through raw role-switch. Both run on
  `pnpm db:test` and are the structural twin of `tests/rls/` (the supabase-js client suite).
- `functions/<name>/index.ts` — Edge Functions: the ONLY sanctioned home for service-role code,
  each with a merged `docs/adr/NNNN-<slug>.md`.
- `seed.sql` — fixtures (DML belongs here, not in a migration). `config.toml` — local ports
  (API 54321, Postgres 54322, Studio 54323).

## Every user-scoped table, in the migration that CREATES it

- `ENABLE` + `FORCE ROW LEVEL SECURITY` (ENABLE alone still lets the table owner — the role that
  runs migrations — read every row; FORCE closes that, and only the REVOKE below constrains a
  `BYPASSRLS` role).
- Four per-operation policies (SELECT/INSERT/UPDATE/DELETE, never `FOR ALL`), each `TO
  authenticated`, each predicate REAL (no `USING (true)`), identity via the initPlan sub-select
  `(select auth.uid())` — hoisted once per statement, not run per row.
- `WITH CHECK` on every INSERT and UPDATE (the only defence against writing under, or handing
  away, another user's owner column).
- `REVOKE ALL … FROM anon` and `FROM service_role`, then `GRANT SELECT, INSERT, UPDATE, DELETE …
  TO authenticated`. A table stays unreachable by an Edge Function until a later, ADR'd migration
  grants it explicitly, per table.
- A leading-column index on the owner column (an index whose LEADING column is the owner turns
  the policy qual into an Index Cond; when keyset-paginated the same index carries the ORDER BY
  tail). A two-row test database never reveals a missing one.

## Rules

- Destructive DDL (DROP/TRUNCATE) needs a resolvable `-- adr: docs/adr/<file>`; non-fixture DML
  in a migration needs `-- harness-allow-dml: <reason>`. The `migrations` gate enforces both.
- `pnpm db:types` regenerates `packages/platform/supabase/src/database.types.ts` (byte-diffed by
  the `types-drift` gate). Exemptions from FORCE RLS are a reviewed `tools/rls-exempt.json` entry.
- Reviewer: `security-reviewer` (MUST) on any migration, schema, policy, or GRANT change.
