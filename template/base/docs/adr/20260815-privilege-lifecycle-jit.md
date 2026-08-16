# Privileged access gets a lifecycle, and administration becomes just-in-time

- **Status:** accepted
- **Date:** 2026-08-15
- **Depends on:** [20260201-org-scoped-tenancy.md](./20260201-org-scoped-tenancy.md), [20260812-mfa-aal2.md](./20260812-mfa-aal2.md)

## Context

Until this decision a privileged seat (`role_rank >= 30`) was a STANDING grant: it
satisfied every admin predicate forever, with no expiry, no inactivity judgement,
and no revalidation. Essential Eight RAP-02 requires privileged access to be
disabled after **12 months** unless revalidated, RAP-03 after **45 days** of
inactivity, and RAP-13 requires administration to be **just-in-time** rather than
ambient. Those two windows are ASD's verbatim numbers and the only
externally-sourced numbers in the design; the one-hour elevation bound is
session-shaped and deliberately NOT presented as an ASD number.

## Decision

**The lifecycle folds into the effective rank, at the helpers.** Every admin
predicate in the database already routes through `private.member_ranks()` or
`private.rpc_admin_org_ids()` — `tools/tenancy.json`'s closed form set refuses any
other shape — so the fold lives there: a seat's rank counts at 30+ only while its
`memberships.revalidated_at` is within 12 months AND an unexpired
`public.admin_elevations` row exists for that (user, org). Otherwise the helpers
report `LEAST(rank, 20)` — a member. An expired elevation therefore STOPS
SATISFYING the predicate; nothing needs to sweep it.

**Elevation is an act, not a grant.** `public.elevate(p_org_id)` reads the RAW
seat (it mints what the effective helpers consult, so it must not consult them),
applies both ASD windows at the threshold, and mints or refreshes a one-hour
elevation keyed to the seat. `public.revalidate_member` is the human half of
RAP-02: an ELEVATED owner re-affirms a colleague's seat. `set_member_role`
re-stamps `revalidated_at` on any rank change (a rank change is itself a human
privilege decision) and deletes the target's elevation on demotion below 30.

**The deadlock-breaker is the narrowest policy that can exist.** Rank 40 is below
nobody, so a lapsed owner can neither elevate nor be revalidated by anyone — the
same structural fact behind the last-owner rule. `elevate()`'s self-revalidation
branch, gated on `private.mfa_satisfied()` (aal2), is the escape, through a policy
that admits exactly one write: the rpc role updating the caller's OWN rank-40 row,
whose `WITH CHECK` pins `role_rank = 40` so the row cannot change rank through it.

## The two defects the suite found, recorded because they are the design's edges

1. **Permissive policies OR per clause, across the set.** An UPDATE's OLD row may
   pass one policy's USING while its NEW row passes a DIFFERENT policy's WITH
   CHECK. With the owner-self policy added naively, an owner's self-demotion
   passed USING through it and WITH CHECK through the spine's admin policy — and
   the structural last-owner rule evaporated. The admin policy is therefore
   re-declared OTHERS-ONLY (`user_id <> (SELECT auth.uid())`) on both clauses,
   which costs nothing real: no self write was ever admissible through it, because
   your own rank is never strictly below itself.
2. **Cleanup order is authorization.** `remove_member` deletes the target's
   elevation only AFTER the policy-checked seat delete succeeds. Deleting it first
   would let a rank-30 admin revoke the OWNER's elevation on the way to a refusal.

## Consequences

- Admin UX gains one step: elevate before administering (the web orgs action does
  it automatically; the elevation returns its expiry for display).
- `tools/tenancy.json` widens two narrowed forms (`self-row`, `rpc-admin-scope`)
  to the elevation table; the pairing rule extends to `app_audit_reader` and
  `app_quota_writer`, which evaluate rank-floored policies and therefore read the
  elevation table through the fold.
- No composite FK onto the seat: the tenant key carries exactly one referential
  story, and the elevation-dies-with-the-seat invariant closes procedurally in the
  RPCs plus the user/org cascades.
- Existing rows seed `revalidated_at = now()` at migration time — the honest
  alternative to instantly demoting every admin on the upgrade that delivered the
  control. The clock starts real from there.

## Sources

- ASD Essential Eight Maturity Model (RAP-02, RAP-03, RAP-13) — graded in
  tools/essential-eight.json, whose `source` block pins the maturity-model URL and
  the verbatim 12-month / 45-day timeframes this decision transcribes
- PostgreSQL row security: FORCE applies to the table owner; permissive policies
  are combined with OR; a SECURITY DEFINER function's reads are judged against the
  owner's policies [corpus: postgres/rls-force]
- RLS performance: the hoisted scalar sub-select / InitPlan pattern
  [corpus: postgres/rls-initplan]
- Transaction-local GUCs: identity travels in request.jwt.claims
  [corpus: postgres/guc-set-local]
