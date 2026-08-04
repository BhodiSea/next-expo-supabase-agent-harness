# Runbook: adopting org scope on an install that already has rows

For an install created before v0.2.0 — per-user tables keyed on `owner_id = (SELECT
auth.uid())` — moving to the org-scoped model in `supabase/schemas/05_tenancy.sql`
without a window of downtime, a window of invisible rows, or a window where one
tenant can read another's.

A **fresh** scaffold needs none of this: it ships the spine and `org_id NOT NULL`
from its first migration and is never in the transition state for a single
statement. This runbook is only for a database that already holds production data.

It is the tenancy-specific companion to `docs/runbooks/expand-contract.md`, which
covers the general shape (and the mobile fleet-skew arithmetic that decides *when*
each phase may start). Read that one first; this one adds what is different when the
thing changing is the authorization boundary itself.

## Why this cannot be one migration

Three facts collide, and each is independently non-negotiable.

1. **`org_id` must end up `NOT NULL`.** `= ANY(array)` is NULL-false, so a row with a
   NULL tenant key is invisible to every org-scoped policy — including to its own
   author. The `tenancy` gate reds a nullable tenant key for exactly this reason.
2. **`org_id` cannot *start* `NOT NULL`.** The existing rows have no org, and there is
   no default that could invent one: which org a row belongs to is a fact about its
   owner's membership, which does not exist yet either.
3. **The gap between (2) and (1) is a backfill**, and on a table of any size a
   backfill is minutes-to-hours of batched work, not a statement inside a migration.

So there is necessarily a window in which `org_id` is nullable and partly populated.
The only question is what the policies do during it — and the answer is **both policy
sets at once**. PostgreSQL ORs permissive policies together, so a row reachable by
either its owner or its org stays reachable. Drop the owner set early and every
un-backfilled row vanishes from the product mid-transition.

> **Never write `OR org_id IS NULL` into a policy.** It is the intuitive fix for a
> half-backfilled table and it is a global leak: the arm is true for every NULL row
> regardless of who is asking, so every user reads every un-backfilled row in the
> database. The dual policy set exists precisely so nobody needs that arm. The
> `tenancy` gate reds any top-level OR arm that carries no reviewed scope term, which
> catches this specific mistake — but do not rely on the gate to teach the lesson.

## The clock

The transition state is licensed by ONE entry in `tools/tenancy.json`:

```json
"dualScopedTables": [
  {
    "table": "notes",
    "ownerColumn": "owner_id",
    "until": "0.3.0",
    "reason": "adopting org scope on a 0.1.x install with live rows; the owner-scoped policies retire once the backfill completes"
  }
]
```

That entry does four things and expires three ways:

| It licenses | It reds when |
|---|---|
| the arm `owner_id = (SELECT auth.uid())` as a legal predicate form **on that table only** | the install's `harnessVersion` reaches `until` |
| a NULLable `org_id` on that table | `org_id` becomes `NOT NULL` (the transition finished — the entry is now pure widening) |
| tenant-blind UNIQUE/PRIMARY KEY constraints on that table | the table or the named `ownerColumn` does not exist |
| — | there is no `.harness/manifest.json` to read the deadline against |

`until` is compared against **`harnessVersion`**, the field `installer update`
advances — deliberately not `baseVersion`, which only moves when a human graduates a
ramp. A deadline measured against a field the escape's own author controls is not a
deadline. Set `until` to the next harness minor you expect to take, not a distant
one: the entry reds on its own the moment the contract phase lands, so a near
deadline costs nothing on the happy path and only bites a transition that stalled.

Extending it is a CODEOWNERS-reviewed diff to an escape list, on purpose. A
transition state nobody re-approves is a per-user product wearing an org-scoped
schema.

## Phase 0 — Install the spine (additive; touches no existing table)

Take the v0.2.0 harness and apply `20260201000000_tenancy_spine.sql` as-is. It creates
`orgs`, `memberships`, `invitations`, the two NOLOGIN roles, the helpers and the
definer RPCs. Nothing it does is visible to existing queries.

Then run `node tools/check-tenancy.mjs`. With no `org_id` anywhere it emits an
adoption NOTE and passes — that ramp covers exactly this moment, and it stops the
instant any table carries a tenant column.

## Phase 1 — Provision an org for every existing user

**Do this as a batch, before the backfill, and do not let it be lazy.**

`ensure_personal_org()` runs at each user's first authenticated request, which covers
everyone who comes back. It does not cover anyone dormant — and their rows are
precisely the ones with no org to backfill from. Discovering that at `SET NOT NULL`,
weeks later, means restarting the transition.

Run as `postgres`, which holds `BYPASSRLS` — the only way to write these rows, since
`orgs` is `FORCE ROW LEVEL SECURITY` and no policy admits an insert by someone who is
not yet a member of anything. Batch it: there is no reason to hold one long
transaction across a large `auth.users`.

```sql
-- The slug shape is ensure_personal_org()'s, deliberately: a user provisioned here
-- and a user provisioned lazily at their next request must be indistinguishable
-- afterwards. 'personal-' || 32 hex = 41 chars, inside orgs_slug_shape's 48.
-- ON CONFLICT names the PARTIAL unique index orgs_personal_creator_key
-- (created_by WHERE kind = 'personal') — the real one-personal-org-per-human key.
-- name is left(...,120) because orgs_name_length caps at 120 and an email may be 320.
INSERT INTO public.orgs (slug, name, kind, created_by)
SELECT 'personal-' || replace(u.id::text, '-', ''),
       left(coalesce(u.email, 'Personal'), 120), 'personal', u.id
  FROM auth.users u
 WHERE NOT EXISTS (
   SELECT 1 FROM public.orgs o WHERE o.kind = 'personal' AND o.created_by = u.id
 )
 ORDER BY u.id
 LIMIT 5000
ON CONFLICT (created_by) WHERE kind = 'personal' DO NOTHING;

-- The founding seat. Separate statement so a partial first pass is resumable.
INSERT INTO public.memberships (user_id, org_id, role_rank)
SELECT o.created_by, o.id, 40
  FROM public.orgs o
 WHERE o.kind = 'personal' AND o.created_by IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.memberships m WHERE m.org_id = o.id AND m.user_id = o.created_by
   )
ON CONFLICT DO NOTHING;
```

Repeat until the first statement reports `INSERT 0 0`. Verify before continuing:

```sql
SELECT count(*) FROM auth.users u
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id);
-- must be 0
```

## Phase 2 — EXPAND: nullable key, both policy sets, one escape entry

One migration per table. For each:

```sql
SET lock_timeout = '3s';   -- plain SET, not SET LOCAL: the CLI applies migrations
                           -- outside a transaction block, where LOCAL is inert

ALTER TABLE public.notes
  ADD COLUMN org_id uuid REFERENCES public.orgs (id) ON DELETE CASCADE;

CREATE INDEX notes_org_created_idx ON public.notes (org_id, created_at DESC, id DESC);

CREATE TRIGGER notes_freeze_org BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

-- The NEW set, ALONGSIDE the existing owner-scoped policies. Do not touch those.
CREATE POLICY notes_select_org ON public.notes FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));
-- … insert/update/delete in the reviewed rank-floor form …
```

`private.freeze_org_id()` is **set-once, not never-set**: it refuses `value -> other
value` and `value -> NULL`, and permits `NULL -> value`. That is what makes the
backfill legal, and the relaxation closes itself — after `SET NOT NULL` the
`OLD.org_id IS NULL` branch is unreachable. (Verified against PostgreSQL 17: the
trigger fires for `postgres` even though that role holds `BYPASSRLS`, so the freeze
is not something a privileged backfill can step around.)

Add the `dualScopedTables` entry in the same commit. Then:

```bash
node tools/check-tenancy.mjs   # green, and the OK line names the transition and its deadline
pnpm test:rls                  # pgTAP + the supabase-js suite, both still green
```

Ship this migration and let it settle before writing a single row.

## Phase 3 — DEPLOY the dual-writing server

Every insert must stamp `org_id` from the caller's active org; every read may still
find rows without one. Deploy the server **before** any backfill, so the set of
un-backfilled rows is closed and shrinking rather than being topped up behind you.

The acting org is a transport selector — it arrives in `x-org-id` and is resolved
server-side against the caller's real memberships (`requireOrgContext()`). It is
never a payload field, which is why no zod object gains an `orgId`.

## Phase 4 — BACKFILL, out of band

Not a migration. A batched, idempotent, resumable runner, executed as `postgres`:

```sql
-- The join lives INSIDE the CTE. Putting it in the UPDATE's FROM clause instead —
-- `UPDATE notes n ... FROM batch b JOIN memberships m ON m.user_id = n.owner_id` —
-- does not parse: "invalid reference to FROM-clause entry for table n". The UPDATE
-- target cannot be referenced from a JOIN condition in its own FROM list.
-- FOR NO KEY UPDATE (not FOR UPDATE): the backfill does not touch the key, so the
-- weaker lock is the honest one and it does not block concurrent FK checks.
-- SKIP LOCKED steps over a row a user is editing right now; the next pass gets it.
WITH batch AS (
  SELECT n.id, m.org_id AS target_org
    FROM public.notes n
    JOIN public.memberships m ON m.user_id = n.owner_id
    JOIN public.orgs o ON o.id = m.org_id AND o.kind = 'personal'
   WHERE n.org_id IS NULL
   ORDER BY n.id
   LIMIT 2000
   FOR NO KEY UPDATE OF n SKIP LOCKED
)
UPDATE public.notes n
   SET org_id = b.target_org
  FROM batch b
 WHERE n.id = b.id;
```

The `o.kind = 'personal'` join is what makes the mapping single-valued: a user with
several memberships would otherwise match several rows and the chosen org would be
whichever the planner reached first. Phase 1 guarantees exactly one personal org per
human, so this join has exactly one answer.

Loop until it reports 0 rows. Then check for stragglers *before* trusting the count:

```sql
SELECT count(*) FROM public.notes WHERE org_id IS NULL;               -- the remainder
SELECT count(*) FROM public.notes WHERE owner_id IS NULL AND org_id IS NULL;  -- orphans
```

Rows whose `owner_id` is NULL (a deleted account, since attribution is `ON DELETE SET
NULL`) can never be attributed by this query and will block `SET NOT NULL`. Decide
about them explicitly — assign them to an archive org or delete them under an ADR —
rather than discovering them as a failed `ALTER TABLE` at the end.

`pnpm test:rls` after the backfill, not just before: the backfill runs with
`BYPASSRLS`, so a row it writes into the wrong org is invisible to the writer and
loud only to the isolation suite.

## Phase 5 — CONTRACT: close it, ADR-coupled

Only once the remainder is 0 and the deployed fleet no longer runs a reader that
expects the owner path (`docs/runbooks/expand-contract.md` has the fleet-floor
arithmetic — on mobile that floor is measured from store telemetry, not assumed).

1. Write the ADR first: `/adr tenancy-contract` → `docs/adr/YYYYMMDD-<slug>.md`. It
   records which policies are dropped, the measured evidence the backfill is
   complete, and the rollback story.
2. One migration, carrying `-- adr: docs/adr/YYYYMMDD-<slug>.md` — `DROP POLICY` is in
   the `migrations` gate's authorization-destructive set and will not pass without it:

```sql
SET lock_timeout = '3s';
-- adr: docs/adr/YYYYMMDD-tenancy-contract.md

-- A bare `ALTER COLUMN ... SET NOT NULL` seq-scans the whole table while holding
-- ACCESS EXCLUSIVE, which on a large table is a hard outage. The three-step keeps
-- the strong lock brief: NOT VALID takes it without scanning, VALIDATE does the scan
-- under SHARE UPDATE EXCLUSIVE (readers AND writers proceed), and SET NOT NULL then
-- reuses the validated constraint instead of scanning a second time.
-- SOURCE: https://www.postgresql.org/docs/17/sql-altertable.html (ADD CONSTRAINT ... NOT VALID; VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE)
ALTER TABLE public.notes
  ADD CONSTRAINT notes_org_present CHECK (org_id IS NOT NULL) NOT VALID;
ALTER TABLE public.notes VALIDATE CONSTRAINT notes_org_present;
ALTER TABLE public.notes ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.notes DROP CONSTRAINT notes_org_present;

-- Every UNIQUE/PRIMARY KEY on a tenant table must include the tenant column: it is
-- what makes the table partition-ready, and a tenant-blind unique is a cross-org
-- information channel (a duplicate-key failure discloses another org's value).
-- BOTH actions in ONE statement, so the table is never momentarily without a primary
-- key. This rebuilds the index under ACCESS EXCLUSIVE and is the expensive step of
-- the whole adoption — schedule it, and expect the lock_timeout above to bounce it
-- if a long transaction is open, which is the desired behaviour.
ALTER TABLE public.notes DROP CONSTRAINT notes_pkey,
  ADD PRIMARY KEY (org_id, id);

DROP POLICY notes_select_owner ON public.notes;
DROP POLICY notes_update_owner ON public.notes;
DROP POLICY notes_delete_owner ON public.notes;
```

3. Delete the `dualScopedTables` entry. The gate reds if you forget: once `org_id` is
   `NOT NULL` the entry is stale by its own rule.
4. Remove the dual-write fallback in the data layer (`knip` flags the dead path) and
   run the full chain: `pnpm validate`, `pnpm test:rls`, both unit suites.

## Phase 6 — Adopt the audit trail (separate, and deliberately not automatic)

`installer update` does **not** plant the audit migration. Every tenancy/audit
migration is `seedOnInitOnly`, because an installer that writes unapplied DDL into a
live repository produces exactly the failure the `migrations` gate is built to catch:
history appearing out of order. So an install that adopts tenancy through this runbook
has tenancy and no trail, and the `tenancy` gate says so with a NOTE rather than a red
— adoption ramps; correctness does not.

Take the trail when the contract phase is done, not before. The reason is Phase 4: the
backfill is a large `UPDATE` over every pre-tenancy row, and with the audit trigger
already attached it would write one audit row per updated row — a trail whose first
million entries record a migration rather than anything a human did, in a table you
cannot then delete from.

1. Copy `supabase/migrations/20260202000000_audit.sql` and
   `supabase/schemas/40_audit.sql` from a fresh scaffold of the same harness version
   (`node installer/cli.mjs init --dir /tmp/ref --tier <yours> --yes`), renaming the
   migration to a timestamp after your latest.
2. Add an `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION
   `audit.write_row('<tenant column>', '<identity column>')`` trigger for **every**
   org-scoped table you own, not just the seeded ones — the gate closes over all of
   them and will name any you miss. No `WHEN` clause.
3. Copy `tools/audit-columns.json` and `tools/pii-columns.json`, then edit both to
   your schema: the deny list reds on any entry naming a column your tables do not
   have, which is the check that stops it silently protecting nothing.
4. Add `audit.events` and `audit.events_default` to `tools/rls-exempt.json` with the
   reasons from the reference scaffold, and `audit.write_row` /
   `public.org_audit_events` to `tools/security-definer-allow.json`.
5. `pnpm db:types` — `public.org_audit_events` is a public function and changes the
   generated mirror, so `types-drift` reds until you regenerate.

Nothing here is destructive and none of it touches existing rows, so Phase 6 is safe
to run at any point after Phase 5 and reverts by dropping the `audit` schema.

## What the gates do at each phase

| Phase | `tenancy` | `migrations` | `rls-isolation` |
|---|---|---|---|
| 0 — spine | adoption NOTE (no tenant column yet) | append-only | unchanged |
| 2 — expand | green **only** with the escape entry; names the deadline in its OK line | `lock_timeout` preamble required on the ALTER | must stay green — the owner path still works |
| 4 — backfill | unchanged | DML outside migrations, so it never sees the runner | the real check: a mis-attributed row is invisible to its writer |
| 5 — contract | green with the entry **deleted**; reds if it survives | `DROP POLICY` needs `-- adr:` | org isolation now the only path |

## Rollback

Phases 0–2 are additive and revert by dropping the new policies and the column. From
Phase 4 onward the backfilled `org_id` values are the only record of the mapping, so
**do not drop the column to roll back** — leave it, restore the owner-scoped policies
(they are permissive, so they widen back), and re-add the `dualScopedTables` entry.
Phase 5 is the irreversible step, which is why it is the one with the ADR.
