# 20260930 — Every table revokes the platform default from all three roles, then grants exactly

- **Status:** Accepted
- **Date:** 2026-09-30
- **Slice:** three-role-revoke

## Context

Supabase's default privileges grant ALL on every new table in `public` to `anon`,
`authenticated` and `service_role`. A GRANT adds a privilege and removes none. So a
migration that creates a table, revokes the default from two roles and then grants four
verbs to the third leaves that third role holding everything the default gave it: on
PostgreSQL 17 that is TRUNCATE, REFERENCES, TRIGGER and MAINTAIN beside the four verbs.
Row security does not apply to any of those four, so no policy can narrow them.

`docs/adr/20260920-authenticated-write-revoke.md` closed that gap on the seven tables
`authenticated` only reads. It named those seven and no others, and two things were left:

- `profiles` and `notes`, the two tables `authenticated` writes, still had the two-revoke
  shape, and so did the push-notifications module's `push_device_tokens`.
- Nothing held a NEW table to the rule. The authoring guidance taught it from 1.0.2, but
  `schema-rls` checked only that a policy had a grant behind it, never that a grant had a
  policy behind it, and its fold of the grant history started empty, so it never saw what
  the default hands a role.

A second property matters as much as the four privileges. While a table keeps the default
for a role, what that role holds depends on whether the platform applied its default when
the table was created. In 1.0.2 that differed between two local Supabase CLI versions, and
it stops for projects created on or after 2026-10-30. A test that asserts the exact
privilege set of such a table is therefore true on one database and false on another with
the same migrations.

Migration discipline bounds the fix: a committed migration is never edited.

## Decision

Every table a migration creates revokes ALL from `anon`, `authenticated` AND `service_role`,
then grants each role exactly what it keeps: for `anon` and `authenticated`, what the
table's policies admit; for `service_role`, only an explicit grant a reviewed ADR records
(the account-deletion sweep's `orgs` SELECT and DELETE is the one the tree ships).

- A new forward migration, `20260930000000_three_role_revoke.sql`, applies the doctrine to
  `profiles` and `notes`: `REVOKE ALL … FROM authenticated`, then the four-verb GRANT. The
  declarative twins `supabase/schemas/10_account.sql` and `supabase/schemas/20_notes.sql`
  gain the same REVOKE, and so do the push-notifications module's migration and its
  `30_push_tokens.sql`.
- `schema-rls` holds every table to it (`tools/lib/table-grants.mjs`). A second fold of the
  grant history starts each `public` table with every privilege for the three roles. Every
  privilege `anon` or `authenticated` then holds must be admitted by a PERMISSIVE policy for
  that operation, naming the role, `public` or no role, with a predicate that is not
  literally `false`; TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are never admitted, so they
  are revoked or listed with a reason in `tools/grant-bound-allow.json`. And for each of the
  three roles, every privilege that fold holds must also be held by a fold that starts empty
  and applies the explicit statements only. The findings ride a 1.1.0 ramp until 1.2.0.
- `tools/gen-grant-assertions.mjs` renders `supabase/tests/rls_grants.generated.test.sql`
  from the explicit fold: one `is_empty` over every table, role and table privilege of the
  configured PostgreSQL major. It refuses while any table fails the doctrine, so no
  committed row depends on whether the default was applied. `schema-rls` fails when the
  committed copy is missing or differs.

## Alternatives Considered

- **Revoke only what the default adds beyond the intended set.** Rejected, for the reason
  the 20260920 ADR gives: naming what is kept cannot miss a privilege the platform adds to
  its defaults later, and naming what is removed can.
- **Bound `service_role` by policies too.** Rejected. It bypasses row security by role
  attribute, so a grant is the only control over it and no policy stands behind a
  legitimate grant. The doctrine holds it to explicit grants instead.
- **Judge the bound on the explicit fold only.** Rejected. That fold is what a project
  created after 2026-10-30 holds; every project created before it holds the default too,
  and that is the one the 1.0.2 escape happened on.
- **Keep counting the pgTAP table lists and `plan()` by hand.** Rejected. They had already
  drifted once, and a table nobody remembered was on none of them. The hand-written
  assertions stay, because they state intent a generated file cannot.

## Consequences

- New scaffolds get the migration and the generated file. Existing installs do not have
  either planted: `supabase/migrations/` and `supabase/tests/` are the project's own, and a
  file with this timestamp could sort ahead of migrations already applied. The upgrade
  runbook's 1.1.0 section gives the SQL, then the generator command.
- An install seeded before 1.1.0 sees the findings as dated NOTEs until 1.2.0; a fresh
  scaffold is held to them at once.
- No application code changes. `authenticated` keeps every verb its policies admit, and the
  REVOKE and GRANT run in one transaction.
- Out of scope: sequences, custom roles, views and `ALTER DEFAULT PRIVILEGES`. The bound
  keeps assuming the platform default, so an install that narrowed its defaults sees extra
  findings. One that widened them in another schema is outside the static check, and the
  generated pgTAP assertion reds against the database instead.

## Sources

- <https://www.postgresql.org/docs/17/ddl-priv.html> — the table privileges of PostgreSQL
  17, MAINTAIN among them; privileges are additive.
- <https://www.postgresql.org/docs/17/ddl-rowsecurity.html> — row security applies after
  the privilege check and not to TRUNCATE, REFERENCES or TRIGGER.
- <https://www.postgresql.org/docs/17/sql-revoke.html> — a table-level REVOKE also revokes
  the column privileges.
- <https://www.postgresql.org/docs/17/functions-info.html> — `has_table_privilege`, which the
  generated assertion calls.
- <https://supabase.com/docs/guides/api> — the Data API's grants and default privileges.

## Traceability

| Requirement | Migration / DAL / route / UI files | Test ids |
| ----------- | ---------------------------------- | -------- |
| R1: `authenticated` holds exactly SELECT, INSERT, UPDATE and DELETE on `profiles` and `notes` | `supabase/migrations/20260930000000_three_role_revoke.sql`, `supabase/schemas/10_account.sql`, `supabase/schemas/20_notes.sql` | `supabase/tests/rls_grants.generated.test.sql > anon, authenticated and service_role hold exactly the table privileges the migrations grant` |
| R2: every table revokes the default from all three roles | `tools/lib/table-grants.mjs`, `tools/check-rls-manifest.mjs` | `schema-rls` |
| R3: the privilege assertions are rendered, never counted by hand | `tools/gen-grant-assertions.mjs` | `schema-rls` |
