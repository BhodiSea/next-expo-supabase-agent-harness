# The append-only audit trail: a schema PostgREST cannot see, written only by a trigger

- **Status:** accepted
- **Date:** 2026-02-02
- **Depends on:** [20260201-org-scoped-tenancy.md](./20260201-org-scoped-tenancy.md)

## Context

A multi-tenant product serving thousands of clients is asked, eventually, "who
changed this row, and when". Without a trail the honest answer is "nobody knows",
and the usual retrofit — an `updated_by` column and a hope — records only the last
writer of the surviving version, which is precisely the record an attacker edits.

The obvious implementation is a table in `public`. That is the one shape this
decision rules out, for a reason that is specific and verified rather than
stylistic: **PostgREST exposes every table in every schema listed in
`[api].schemas`**, and RLS on a partitioned parent does **not** cascade to its
partitions. A `public.audit_events` partitioned by month is therefore reachable at
`GET /rest/v1/audit_events_2026_08` with the publishable key and any valid JWT, and
that request is judged by the partition's own policies — of which there are none.
The parent's carefully written tenant predicate is not consulted. One URL, every
tenant's history.

## Decision

### The trail lives in a schema the API cannot reach

`audit.events`, in a dedicated `audit` schema that is **absent from
`[api].schemas`**. `anon`, `authenticated` and `service_role` hold no `USAGE` on the
schema at all, so the name does not resolve for them even if a policy were added by
mistake. `tools/check-tenancy.mjs` asserts the absence from `config.toml`, and
`tools/check-rls-manifest.mjs` asserts it independently for every non-`public`
table — deliberately duplicated, because this is the property whose failure is
silent.

### Append-only in four layers, because any one of them can be removed

| Layer | Control | What it survives |
|---|---|---|
| 1 | No `UPDATE`/`DELETE` policy exists | a grant added by mistake |
| 2 | `REVOKE ALL` from `anon`, `authenticated`, `service_role`; `INSERT` granted only to `app_audit_writer` | a policy added by mistake |
| 3 | `BEFORE UPDATE OR DELETE … FOR EACH ROW` raising `42501` | **a role holding `BYPASSRLS`** — verified: `postgres` on Supabase holds `rolbypassrls`, and the trigger still fires |
| 4 | `BEFORE TRUNCATE … FOR EACH STATEMENT`, on the parent **and on every partition** | `TRUNCATE`, which no row trigger can see |

Layer 4's per-partition duplication is not belt-and-braces, it is required.
PostgreSQL **clones row triggers to partitions** (including partitions created
later — verified against 17) but **does not clone `TRUNCATE` triggers**, and
`TRUNCATE audit.events_2026_08` on a leaf does not fire the parent's. A trail
protected only at the parent is a trail that can be emptied one month at a time.
`audit.ensure_partitions()` creates the trigger with the partition, so the
protection cannot be forgotten by the maintenance path that creates the gap.

Removal is only ever `DETACH PARTITION` + `DROP TABLE` — a DDL act requiring table
ownership, which no application role has.

### Each partition also carries RLS with no policies

Verified: writing through the parent is judged by the **parent's** policies even
when the target partition has RLS enabled and no policy of its own; reading a
partition **directly** is judged by the partition's. So `ENABLE` + `FORCE` on every
partition with zero policies makes direct partition access deny-all without
affecting a single legitimate write. This is a positive control on the exact breach
described in *Context*, rather than a reliance on the schema staying unpublished.

### The writer is a trigger function, and the actor is not a parameter

`audit.write_row()` is `SECURITY DEFINER`, `SET search_path = ''`, owned by a
`NOLOGIN` `app_audit_writer` whose entire authority is `INSERT` on one table.

`actor_id` is derived **inside** the function from the caller's verified identity.
It is deliberately not a column `DEFAULT`: a default is overridden by any client
that supplies the column, so `DEFAULT auth.uid()` on an audit table records whoever
the writer says they are. The function body says `private.caller_id()` rather than
`auth.uid()` for the reason recorded in the tenancy ADR — schema `auth` is owned by
`supabase_admin` and `postgres` cannot re-grant `USAGE` on it, so a function *body*
running as any other role cannot resolve the name, while a *policy* can.

The `INSERT` policy is `actor_id IS NOT DISTINCT FROM (SELECT auth.uid())`. It is
the database's own opinion about who is acting, checked against what the row
claims, so even a caller who reached the writer role could not forge an actor.
`IS NOT DISTINCT FROM` rather than `=` because a system write (signup provisioning,
a seed) legitimately has no JWT and both sides are NULL.

### Payload defaults to metadata only

A row records **which columns changed, not what they became**. Value capture is
per-column opt-in, declared as trigger arguments in the DDL —
`audit.write_row('org_id', 'id', 'role_rank')` — mirrored in
`tools/audit-columns.json`, and refused for anything named in
`tools/pii-columns.json`.

The default is not caution for its own sake. An audit table that copies values is a
second, less-policied home for the data it audits: a rank-30 admin reading the
trail would see every member's note titles, and every table's confidentiality would
silently degrade to the audit table's. Declaring capture as a trigger argument
rather than a config table keeps it visible in the migration diff and costs nothing
at runtime — there is no per-row lookup.

### Read path

`public.org_audit_events(_org, _before, _limit)`, `SECURITY DEFINER` owned by a
second `NOLOGIN` role `app_audit_reader` holding `SELECT` and nothing else. The
`_org` argument is a **selector**: authorization is the `SELECT` policy on
`audit.events`, a rank ≥ 30 floor in the reviewed `rank-floor` form. An org the
caller does not administer returns the empty set, so the parameter can only narrow.

The writer cannot read and the reader cannot write. Splitting them is the point: a
single audit role would mean any path that can append can also exfiltrate.

### Retention

`audit.drop_partitions_older_than(interval)` under **pg_cron running as
`postgres`** — never an Edge Function, which runs as `service_role` and cannot drop
a `postgres`-owned partition. `CREATE EXTENSION pg_cron` is guarded: a project
without it gets the functions, a `NOTICE`, and a documented manual schedule rather
than a migration that fails to apply.

## Consequences

- Every org-scoped table carries an `AFTER INSERT OR UPDATE OR DELETE … FOR EACH
  ROW` trigger with **no `WHEN` clause**. `tools/check-tenancy.mjs` enforces the
  closure both ways, and rejects a `WHEN` clause outright: a conditional audit
  trigger is a trail with a documented blind spot, and the condition is written by
  the same person the trail exists to record.
- Writes cost one extra insert. The trail is partitioned so it stays cheap to
  retain and free to drop.
- `supabase db reset` exercises the whole path: the seed writes through the policy
  wall as impersonated users, so every seeded row produces a real audit row written
  by a real trigger under real RLS.

## Honest losses

- **The trail covers mutations only.** `SELECT` auditing requires `pgaudit`
  configuration that is not expressible in a migration, and is out of scope. A
  reader who only reads leaves no trace.
- **`request_id` is a correlation field, not evidence.** It is minted by the server
  on the paths the server controls, and a client talking directly to PostgREST can
  send whatever it likes. `actor_id` is the field with integrity, because it comes
  from the verified JWT and is cross-checked by the insert policy. The two are
  documented separately so nobody builds an investigation on the wrong one.
- **A DEFAULT partition is a trap as well as a backstop.** It guarantees a write
  never fails when maintenance has stopped, but a month partition cannot be created
  once the default holds rows for that month. The maintenance function creates three
  months ahead so the default stays empty; if it ever fills, the fix is a manual
  move, not a retry.

## Sources

- PostgreSQL 17, `CREATE POLICY` / row security and partitioning — parent policies
  govern access **through** the parent; a partition accessed directly is judged by
  its own. Verified against the local stack, not assumed.
- PostgreSQL 17, `CREATE TRIGGER` — row triggers on a partitioned table are cloned
  to partitions, including ones created afterwards; `TRUNCATE` triggers are not.
  Verified.
- `docs/adr/20260201-org-scoped-tenancy.md` — the `auth` schema `USAGE` asymmetry
  between a policy expression and a function body.
