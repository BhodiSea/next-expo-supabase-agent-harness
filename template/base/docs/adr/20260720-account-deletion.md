# 20260720 — In-app account deletion (the store-compliance slice)

- **Status:** Accepted
- **Date:** 2026-07-20
- **Slice:** account-deletion

## Context

Apple rejects apps that support account creation but offer no in-app way to
initiate account deletion (App Review Guideline 5.1.1(v)) — one of the most
common hard rejections. The scaffold ships a sign-in surface, so it ships the
deletion surface too, as the worked exemplar of the store-compliance slice.

The identity in this stack is a Supabase `auth.users` row: there is no
project-owned users table, and `public.profiles.id` plus every owned
`owner_id` (`public.notes`, …) reference `auth.users(id) ON DELETE CASCADE`
(see `supabase/schemas/10_account.sql`, `20_notes.sql`). Every owned table is
`FORCE ROW LEVEL SECURITY` with `owner_id = (select auth.uid())` as the only
visibility filter. Deleting the identity row therefore removes the whole
account in ONE statement — but no policy a signed-in user runs under can touch
`auth.users`, and `service_role` (the only credential that can) is confined to
Edge Functions by doctrine (`supabase/functions/README.md`).

## Decision

A **`delete-account` Edge Function** (`verify_jwt = true`) is the deletion
backing. It reads the caller's id from their verified token via `getUser()` —
never from the request body, so a caller can only ever delete themselves — and
performs one elevated call, `auth.admin.deleteUser(userId)`, a HARD delete that
removes the `auth.users` row and fires the `ON DELETE CASCADE` sweeping every
owned table. It needs no table `GRANT` of its own: the cascade is a database
constraint triggered by the auth delete, not a `service_role` write to
`public.*`.

The mobile surface is a command-palette action (`session.deleteAccount`) behind
a native destructive confirm (the deliberate two-step reviewers look for); on
confirm the client invokes the function server-side FIRST, then drops the local
session and returns to sign-in. A failed deletion keeps the session and
surfaces the envelope toast — nothing half-deletes. The expo-policy gate's
account-deletion closure asserts the registry action id and the backing Edge
Function (its `index.ts` on disk AND its `[functions.delete-account]` block in
`config.toml`) exist whenever an auth surface ships.

## Alternatives Considered

- **A dedicated settings route** — rejected for the scaffold: a new route costs
  the full route-manifest closure (Maestro flow + startup-budget row + three
  fabricated data states) for a surface with no primary query; the command
  palette is the scaffold's canonical home for session verbs. A real app with a
  settings screen should move the action there.
- **A tRPC procedure running as the user** — rejected: a `memberProcedure`
  runs as `authenticated` and is bound by RLS exactly like every other write,
  which is the point of that layer; it cannot reach `auth.users`. Deleting the
  identity is the one operation that genuinely requires stepping outside the
  policy wall, which is what makes it a legitimate Edge Function rather than an
  accidental one.
- **Per-table `DELETE` sweeps (the ancestor's DAL pattern)** — rejected: a
  hand-maintained sweep list is a table someone forgets to add. The FK cascade
  makes "delete my account" one statement against `auth.users` and makes a
  forgotten new table a schema error, not a silent data leak.
- **Soft delete / deactivation** — rejected: 5.1.1(v) requires deletion, and a
  soft delete would tombstone the identity while leaving the owned rows orphaned
  (the cascade only fires on a hard delete).

## Consequences

Positive: the scaffold passes the account-deletion review bar out of the box,
and extending deletion to a new owned table is automatic — a table whose
`owner_id` references `auth.users(id) ON DELETE CASCADE` is swept with no change
to the function. Negative: deletion is immediate and unrecoverable by design —
an app that needs a grace period must add its own staging surface; and the one
piece of elevated code in the repository is code a human must review by hand
(which is the entire reason it lives in a separately-deployed function with a
one-sentence blast radius rather than in the web process).

## Sources

- <https://developer.apple.com/app-store/review/guidelines/#5.1.1> — Apple App
  Review Guideline 5.1.1(v): apps supporting account creation must let users
  initiate account deletion within the app (backs the action, the Edge
  Function, and the two-step confirm).
- `[corpus: postgres/rls-force]` — FORCE RLS + owner-scoped policies as the
  authorization boundary the owned tables share (backs "the cascade, not an
  app-side filter, is what deletes only the caller's rows").

## Traceability

| Requirement | Migration / function / UI files | Test ids |
| ----------- | ------------------------------- | -------- |
| In-app deletion initiation (5.1.1(v)) | `apps/mobile/src/features/actions/registry.ts` (`session.deleteAccount`), `apps/mobile/app/actions.tsx` (confirm + choreography) | `actions-modal.test.tsx` account-deletion cases |
| Elevated deletion of the identity row | `supabase/functions/delete-account/index.ts`, `supabase/config.toml` (`[functions.delete-account]`) | expo-policy account-deletion closure |
| Owned data dies with the account | `supabase/schemas/10_account.sql`, `supabase/schemas/20_notes.sql` (`ON DELETE CASCADE`) | `supabase/tests/` cascade coverage |
| Only the caller's account dies | `supabase/functions/delete-account/index.ts` (`getUser()`-derived id, never a parameter) | — |
