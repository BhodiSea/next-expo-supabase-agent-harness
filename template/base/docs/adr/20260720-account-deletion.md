# 20260720 — In-app account deletion (the store-compliance slice)

- **Status:** Accepted
- **Date:** 2026-07-20
- **Slice:** account-deletion

## Context

Apple rejects apps that support account creation but offer no in-app way to
initiate account deletion (App Review Guideline 5.1.1(v)) — one of the most
common hard rejections. The scaffold ships a sign-in surface, so it ships the
deletion surface too, as the worked exemplar of the store-compliance slice.
Constraints: this stack has NO users table (identity is the verified token's
subject), every table is FORCE RLS with the `app.user_id` GUC as the only
visibility filter, and the client is an untrusted bearer of a scoped token —
deletion must be authorized in the DAL on RLS, never client-side.

## Decision

`DELETE /api/me` (Bearer-guarded, 204, idempotent) calls
`accountDal.deleteAllOwnedData(userId)`: ONE unqualified `DELETE ... RETURNING`
per owned table inside `withUserContext` — the RLS policy qual IS the filter,
so the statement can only ever sweep the caller's own rows. The mobile surface
is a command-palette action (`session.deleteAccount`) behind a native
destructive confirm (the deliberate two-step reviewers look for); on confirm
the client deletes server-side FIRST, then drops the local session and returns
to sign-in. A failed deletion keeps the session and surfaces the envelope
toast — nothing half-deletes. The expo-policy gate's account-deletion closure
asserts the action id and the openapi DELETE operation exist whenever an auth
surface ships.

## Alternatives Considered

- **A dedicated settings route** — rejected for the scaffold: a new route costs
  the full route-manifest closure (Maestro flow + startup-budget row + three
  fabricated data states) for a surface with no primary query; the command
  palette is the scaffold's canonical home for session verbs. A real app with a
  settings screen should move the action there.
- **Application-side `WHERE owner_id = $user`** — rejected: an app-side filter
  can only ever mask an RLS policy regression (the notes DAL doctrine); the
  live cross-tenant test proves the unqualified sweep kills only the caller.
- **Soft delete / deactivation** — rejected: 5.1.1(v) requires deletion, and
  with no users table there is nothing to deactivate — the owned rows ARE the
  account.

## Consequences

Positive: the scaffold passes the account-deletion review bar out of the box,
and the slice is the worked pattern for extending deletion to new owned tables
(add the table's `DELETE` to the DAL + a dal-shapes probe entry). Negative:
deletion is immediate and unrecoverable by design — an app that needs a grace
period must add its own staging surface; and each new owned table must be
added to `deleteAllOwnedData` explicitly (the RLS suite's per-target sweep
case reds a table the DAL forgets only if the DAL is extended per table —
review discipline documents this in the module docs).

## Sources

- <https://developer.apple.com/app-store/review/guidelines/#5.1.1> — Apple App
  Review Guideline 5.1.1(v): apps supporting account creation must let users
  initiate account deletion within the app (backs the route, the registry
  action, and the two-step confirm).
- `[corpus: postgres/rls-initplan]` — RLS policy-qual visibility through the
  `app.user_id` GUC (backs the unqualified DELETE: the policy is the filter).

## Traceability

| Requirement | Migration / DAL / route / UI files | Test ids |
| ----------- | ---------------------------------- | -------- |
| In-app deletion initiation (5.1.1(v)) | `apps/mobile/src/features/actions/registry.ts` (`session.deleteAccount`), `apps/mobile/app/actions.tsx` (confirm + choreography) | `actions-modal.test.tsx` "account deletion" cases |
| Server-side sweep under FORCE RLS | `apps/server/src/dal/account.ts`, `apps/server/src/app.ts` (`DELETE /api/me`) | `dal/account.test.ts` (statement shape), `app.routes.test.ts` "DELETE /api/me" cases |
| Only the caller's rows die | `tests/rls/dal-shapes.ts` (`accountDal.deleteAllOwnedData` plan probe) | `tests/rls/cross-tenant-isolation.test.ts` "account deletion" sweep |
| End-to-end against real Postgres | the whole slice | `live-api-proof.test.ts` "account deletion" |
