# Authentication events, logged where the failures actually are: GoTrue's own hooks

- **Status:** accepted
- **Date:** 2026-08-16
- **Depends on:** [20260202-audit-trail.md](./20260202-audit-trail.md), [20260812-mfa-aal2.md](./20260812-mfa-aal2.md)

## Context

Essential Eight asks that **successful and unsuccessful** authentication events be
logged. The vendor's own `auth.audit_log_entries` records successes only — verified
on a running stack, three failed sign-ins wrote nothing — and it carries none of the
append-only protection the application's audit trail has, because the schema belongs
to the auth service and is re-migrated on upgrade. The advice this repository used
to give ("write auth events into `audit.events` at your own sign-in seam") was
misleading and is withdrawn by this decision: a failed sign-in belongs to somebody
who never got a session, so **no client-side seam can see it** — the app's form
observes only its own failures, and a credential-stuffing run against the token
endpoint never renders a form at all.

The only process that sees every attempt is GoTrue, and GoTrue exposes exactly one
extension point at that moment: **auth hooks** — Postgres functions it calls
synchronously during verification (`[auth.hook.password_verification_attempt]`,
`[auth.hook.mfa_verification_attempt]`, pg-functions URIs). Verified against the
pinned CLI: failed attempts DO fire both hooks.

## Decision

**A second trail schema, `auth_trail`, mirroring `audit`'s four append-only layers
exactly** (no write policy for updates/deletes; no client grant; a BEFORE
UPDATE/DELETE row trigger that binds BYPASSRLS; TRUNCATE statement triggers on the
parent, the default partition, and every month partition), org-less because a failed
attempt has no tenant, `user_id` nullable with **no FK** so account deletion can
never erase the record of attempts against the account.

**Two SECURITY DEFINER hook functions** owned by a dedicated writer role, EXECUTE
granted to `supabase_auth_admin` alone. Both are **exception-wrapped and always
return `{"decision": "continue"}`**: the trail observes, it never decides, and a
trail fault (full disk, dropped partition) must never lock users out — the failure
direction is a lost row, chosen deliberately. The pgTAP suite breaks the trail on
purpose and proves the hook still answers continue.

**No reader at all.** The audit trail has a rank-30 read path because tenant admins
are entitled to their org's history; this trail's natural reader is the operator
responding to an incident, whose access is the database itself. So: no reader role,
no read policy, no PostgREST path — a posture recorded rather than an omission, and
the pgTAP suite asserts the absence structurally (a SELECT policy appearing on the
trail is somebody quietly adding a read path).

## Consequences

- Failed and successful password/MFA verifications now leave durable, tamper-proof
  rows an operator can investigate — the Essential Eight halves the vendor table
  cannot give — at the cost of one synchronous pg-function call per attempt (the
  hooks do a single INSERT; the exception wrap bounds the blast radius of any
  fault at one lost row).
- There is deliberately no in-product way to read the trail; incident response
  happens at the database. Adding a read surface later is a reviewed act the pgTAP
  suite will surface (it asserts the ABSENCE of a SELECT policy).
- `supabase/config.toml` gains two `[auth.hook.*]` sections whose values are
  pinned as auth-posture floors; a pre-1.0.0 install sees ramped NOTEs until it
  adopts the migration and the sections together.
- Retention is a partition DROP (`auth_trail.drop_partitions_older_than`), owned
  by nobody the application can reach.

## Ceilings, stated

- An attempt against an email with **no user row fires nothing** — GoTrue resolves
  the user first. Pure enumeration sweeps are visible only in the platform's HTTP
  logs (the organisation's collection surface).
- The password hook covers the **password grant**; OAuth and magic-link sign-ins do
  not traverse it. MFA verification has its own hook.
- On hosted Supabase, auth hooks are **plan-gated**; locally and in CI they are
  unconditional. The register grades with this ceiling stated (MFA-15 is
  alternate-control, and "centrally" remains the organisation's half).

## Proof

- `supabase/tests/auth_trail.test.sql`: the whole privilege path as
  `supabase_auth_admin`, the closed vocabulary, immutability against the superuser,
  client denial at the schema wall, and the broken-trail continue.
- `tests/rls/auth-trail.test.ts`: a REAL failed `signInWithPassword` over HTTP, then
  the row counted through the operator read path — the wiring half only a live
  GoTrue can prove.

## Sources

- The hook wiring: `supabase/config.toml` `[auth.hook.*]` sections (pg-functions
  URIs), pinned as auth-posture floors in `tools/auth-posture.json`.
- The layer design: docs/adr/20260202-audit-trail.md (the four layers and the
  partition discipline this schema mirrors).
- PostgreSQL row security: FORCE subjects the owner; partitions inherit neither RLS
  nor TRUNCATE triggers [corpus: postgres/rls-force]
