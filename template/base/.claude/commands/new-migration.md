---
description: Add a Supabase migration + RLS — a declarative schema change plus a new timestamped, append-only migration carrying FORCE RLS, per-op policies on auth.uid(), a leading-column owner index, and narrow grants.
argument-hint: "[table-or-change]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

Add the schema change **$1**. Two files move together: the DECLARATIVE source of truth and a
new APPLIED migration.

Today's UTC migration timestamp (the command engine does NOT expand `$(...)`, so use this
inline line):

!`date -u +%Y%m%d%H%M%S`

## What to write

1. **Declarative change** in `supabase/schemas/*.sql` — the desired end state and the home for
   every rationale comment (`supabase/schemas/20_notes.sql` is the reference shape).
2. **A NEW migration** at `supabase/migrations/<timestamp>_$1.sql` (use the 14-digit UTC
   timestamp printed above as `<timestamp>`). Migrations are APPEND-ONLY and DML-free: they are
   applied history, not desired state, and an existing migration is NEVER edited — a mistake is
   a further new migration. Editing an applied file changes nothing on a database that already
   ran it, so the deployed schema and the committed history diverge silently.

Every user-scoped table carries, IN THE SAME migration:

- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` AND `... FORCE ROW LEVEL SECURITY;` (FORCE
  subjects the table owner too — the role that runs migrations and SQL-editor sessions becomes
  policy-subject; a BYPASSRLS role still bypasses, which the REVOKE below is for);
- four per-operation policies `TO authenticated` (never `FOR ALL`), each predicate real (no
  `USING (true)`) and keyed on the initPlan sub-select `(select auth.uid())` so the planner
  hoists it into an InitPlan (once per statement, not once per row), with `WITH CHECK` on
  INSERT/UPDATE so a row cannot be inserted under — or handed to — another owner;
- a LEADING-column owner index (every policy filters by the owner column on every statement,
  so a second-position index degrades the policy to a sequential scan a two-row test DB never
  reveals); when the table is keyset-paginated, carry the `ORDER BY` columns in the same index
  so one index serves the policy, the sort and the cursor range;
- `REVOKE ALL ON TABLE ... FROM anon;` and `REVOKE ALL ON TABLE ... FROM service_role;`
  (`service_role` BYPASSES RLS by role attribute — the REVOKE is the only lever over it, and it
  stays revoked until an ADR-governed Edge Function needs a per-table `GRANT`), then `GRANT`
  only the operations the feature needs to `authenticated`.

`-- SOURCE: <authority> [corpus: <id>]` on every decision line (FORCE, each CREATE POLICY, the
initPlan sub-select, the index). Destructive DDL (DROP TABLE/COLUMN, TRUNCATE) requires
`-- adr: docs/adr/<file>` pointing at an EXISTING ADR — run `/adr` FIRST, before the migration
is written (append-only: it cannot be edited afterwards to add it). RLS exemptions are a human
decision in the write-guard-protected `tools/rls-exempt.json` — never edit it yourself.

Delegate the authoring to the `migration-rls-author` subagent. Then wire the new table into
the `rls_targets` list and the pgTAP suites (`supabase/tests/*.sql` — structure + cross-user
isolation) and the live isolation matrix (`tests/rls/`).

## Apply + prove

```
pnpm db:reset        # fresh-applies the whole chain from zero
pnpm db:test         # pgTAP: structure + cross-user isolation, against what the DB compiled
```

Both must pass. Then run `/rls-check` (or the `security-reviewer` subagent) over the diff and
require PASS.

Current working tree: !`git diff --name-only HEAD`
