---
description: Run the security-reviewer over the RLS/policy/migration diff, plus (if the local stack is up) the rls_verify probe and pgTAP — return PASS or FAIL and fix until PASS.
allowed-tools: Read, Grep, Glob, Bash
model: sonnet
---

Audit the row-level-security surface of the current change.

Files changed in the working tree:

!`git diff --name-only HEAD`

Run the `security-reviewer` subagent over that diff. It holds the RLS invariants: every
user-scoped table has `ENABLE` + `FORCE ROW LEVEL SECURITY` in the SAME migration that creates
it; four per-operation policies `TO authenticated` (never `FOR ALL`), each predicate real (no
`USING (true)`) and keyed on the initPlan sub-select `(select auth.uid())`, with `WITH CHECK`
on INSERT/UPDATE; a LEADING-column owner index; `REVOKE ALL ... FROM service_role` (the only
lever over the BYPASSRLS role, which no policy constrains) with grants narrowed to
`authenticated`; append-only migrations; exemptions only via the write-guard-protected
`tools/rls-exempt.json`. It reports by severity with `file:line` refs and the exact offending
SQL.

If the local Supabase stack is up, add live evidence:

- the `security-reviewer` may probe mid-review with the `rls_verify` MCP tool
  (`rls_verify { table, userA, userB }`) — a cross-user read/write that must return zero rows
  across tenants; treat a `SKIPPED` result as NO evidence, never as a pass;
- the main thread runs `pnpm db:test` — the pgTAP structure + isolation suites under
  `supabase/tests/*.sql`, read back out of `pg_catalog` against what the database actually
  compiled (a migration that never ran or was undone is exactly what a static scan misses).

Return a single verdict line: `PASS` or `FAIL`. If `FAIL`, fix the migration/policy — a fix is
a further NEW `supabase/migrations/<timestamp>_*.sql`, never an edit to a committed one — and
re-run this command until it returns `PASS`.
