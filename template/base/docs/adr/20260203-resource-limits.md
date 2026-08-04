# Per-org quota and per-role resource ceilings

- **Status:** accepted
- **Date:** 2026-02-03
- **Depends on:** [20260201-org-scoped-tenancy.md](./20260201-org-scoped-tenancy.md),
  [20260202-audit-trail.md](./20260202-audit-trail.md)

## Context

Multi-tenant means one database serving thousands of customers, so the two ways one
tenant hurts another are **volume** (rows without bound) and **duration** (a query
that never ends). Neither is an authorization problem, so RLS says nothing about
either, and both are invisible in a two-row development database.

## Decision 1 — the quota is a statement-level trigger

`public.org_usage` counts, `public.org_quota` overrides, `public.quota_defaults`
supplies the ceiling when no override exists. Enforcement is an
`AFTER INSERT ... REFERENCING NEW TABLE ... FOR EACH STATEMENT` trigger that upserts
the delta and raises **53400** on overflow.

Both obvious alternatives were implemented and rejected for specific reasons:

- **A per-row trigger** serializes every insert behind one hot tuple — the org's usage
  row. A 1000-row import becomes 1000 sequential lock acquisitions and 1000 dead
  tuples on a single page, so the counter becomes the throughput ceiling of the
  product.
- **A RESTRICTIVE policy calling a `STABLE` counting function** fails **open**, and
  looks right while doing it. The planner hoists a `STABLE` call to one evaluation per
  statement, against the **pre-statement** count — so a single multi-row `INSERT` of
  any size is judged as though it were the first row and passes wholesale. The
  optimization defeats the control, silently, and only on the large writes that matter.

Verified against PostgreSQL 17: with a limit of 5 and 3 rows already present, a single
statement inserting 50 rows is refused (`53400`, "53/5"), the counter is unchanged
after the refusal, `+2` reaching exactly 5 succeeds and `+1` beyond it fails.

`appError.quotaExceeded()` is deliberately **not** `rateLimited()`. A quota is not
retryable and has an upgrade path; a client that conflates the two enters a retry loop
that can never succeed.

### The counter is not client-writable

`authenticated` holds `SELECT` on `org_usage` and `org_quota` and nothing else — a
tenant that can raise its own limit has no limit. Writes go through
`app_quota_writer`, a `NOLOGIN` role reachable only as the owner of the enforcement
functions, whose policies use the ordinary reviewed scope form: the trigger runs
inside the caller's transaction, so `auth.uid()` is still the human and the counter can
only move for an org RLS already admitted them to.

### Reconciliation, and the one ownership decision that must not be tidied

Every incrementing counter drifts — a trigger disabled for a bulk load, a logical
restore, a bug in a decrement — and the two directions fail differently: drift **up**
blocks a paying customer, drift **down** gives the product away. `reconcile_org_usage()`
recomputes from `count(*)` nightly.

It is **deliberately not** reassigned to `app_quota_writer`, and the reason is a
failure mode rather than a preference. Reconciliation is inherently a whole-database
read. A tenant-scoped owner resolves its policies through `auth.uid()`, and pg_cron
runs with no JWT — so the scope array would come back empty, the truth set would be
empty, and the follow-up statement would set **every counter in the database to zero**.
Every quota in the product would silently become unlimited, on a schedule. Safety comes
from unreachability instead: `EXECUTE` revoked from `PUBLIC`, `anon` and `authenticated`.
`tools/check-db-limits.mjs` reds if an `ALTER FUNCTION` ever reassigns it.

## Decision 2 — per-role ceilings, and the honest scope of what they bind

`statement_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` are set
on `anon`, `authenticated` and `service_role`.

**What makes them bind is PostgREST, not PostgreSQL**, and the distinction is load
bearing. `ALTER ROLE x SET y` writes a `pg_db_role_setting` row that PostgreSQL applies
when role `x` *starts a session* — and `SET ROLE` does not start a session. Verified:
connected as `authenticator`, `SET LOCAL ROLE authenticated` left `statement_timeout`
at the **authenticator's** value. On that evidence the settings would be inert.

They are not, because PostgREST reads `pg_db_role_setting` for the role it is about to
impersonate and applies it per request. Verified end to end: with `anon` at 2s and
`authenticator` at 8s, a 5-second RPC through PostgREST as `anon` was cancelled at
**2.03s** with SQLSTATE 57014.

So the boundary is real and uneven, and it is written down rather than discovered in an
incident: these ceilings bound traffic arriving **through PostgREST** — every
supabase-js call from web and mobile, i.e. the product — and **do not** bound a direct
connection. An Edge Function on a Postgres driver, a migration, psql, or Supavisor in
session mode each log in as another role and get that role's settings; for them the
ceiling is `authenticator` (8s, set by the Supabase image) or `postgres` (unlimited).

That is also why the runtime proof is a **client-side** assertion. A pgTAP read of
`pg_db_role_setting` proves the row exists — which is what PostgREST reads — but never
that PostgREST applied it. `public.effective_limits()` returns what is in force for the
caller, and the supabase-js suite calls it through the real API and compares against
`tools/db-limits.json`.

### Two knobs refused, because they would be theatre

| Knob | Why it is not here |
|---|---|
| `temp_file_limit` | Superuser-only (`PGC_SUSET`). `postgres` on Supabase is not a superuser: `ALTER ROLE authenticated SET temp_file_limit` fails with *permission denied to set parameter* — verified. It cannot be set from a migration on this platform at all. |
| `CONNECTION LIMIT` | The only role where it would bind is the one that **logs in**, `authenticator`, which is reserved: *"only superusers can modify it"* — verified. On `anon`/`authenticated`/`service_role` it succeeds and binds **nothing**, because a connection limit applies at login and none of those three ever log in. |

`tools/check-db-limits.mjs` therefore reds when either knob **appears**. A number that
cannot bind is worse than no number, because a reviewer reads it as a control.

## Honest losses

- **Statement timeouts bound duration, not concurrency.** Four hundred tenants each
  running a legitimate 7.9-second query still saturate the pool, every one of them
  inside its ceiling. This is not a noisy-neighbour solution and must not be sold as
  one; connection count is bounded by Supavisor's pool size, which is platform
  configuration this repo cannot set.
- **The ceilings do not bind direct connections** (see above). An Edge Function using a
  Postgres driver is subject to `authenticator`'s 8s, not to `service_role`'s 30s.
- **The quota meters rows, not bytes.** A tenant with 9,999 notes of 20KB each is
  inside its limit and using 200MB. Byte metering needs a per-row size computation the
  statement trigger cannot do without reading the rows it is counting.
- **`temp_file_limit` is unset**, so a large sort still spills to disk without a
  per-role cap.

## Sources

- PostgreSQL 17, `ALTER ROLE ... SET` — takes effect when the role starts a new
  session. Verified that `SET ROLE` does not re-apply.
- PostgreSQL 17, `CREATE TRIGGER` — transition tables (`REFERENCING NEW TABLE`) are
  visible to statement-level triggers, including from dynamic SQL. Verified.
- PostgreSQL 17 error codes — `53400 configuration_limit_exceeded`.
