# Org-scoped tenancy: the authorization model, and what it replaces

- **Status:** accepted
- **Date:** 2026-02-01
- **Supersedes:** parts of [20260720-account-deletion.md](./20260720-account-deletion.md)
  (the one-statement account sweep; see *Account deletion* below)

## Context

The scaffold shipped a per-user model: `owner_id = (SELECT auth.uid())` on every
policy, two tables, no organization construct. Meanwhile the API carried a tenancy
*shape* with no substance — a `MembershipRole` enum nothing wrote, a `Membership`
interface resolved by a hardcode, and a `memberProcedure` that was byte-identical in
effect to `authedProcedure`. A product serving thousands of B2B clients cannot be
built on that, and the gap was invisible to every gate because the phantom layer
type-checked.

## Decision

Authorization is **table-anchored and revocation-immediate**. A user's reach is
whatever `public.memberships` says at statement time.

Exactly **two predicate shapes** are legal, both uncorrelated scalar sub-selects the
planner hoists into one InitPlan per statement:

```sql
org_id = ANY((SELECT private.member_org_ids())::uuid[])
coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
```

`(SELECT private.member_rank(org_id)) >= 30` is **banned**: passing a column of the
row under test makes it a correlated SubPlan evaluated per row, which also re-enters
the membership table's own policies. It is syntactically wrapped in `(SELECT`, so it
passes every wrapper check — `tools/check-tenancy.mjs` inverts the rule and reds any
tenancy helper invoked with a column of the policy's own table.

### Rejected: JWT claims

Putting the org set in the access token was designed and rejected. Revocation would
wait for token expiry; the org array exceeds Vercel Edge's 16KB header limit at a few
hundred orgs per user; shortening `jwt_expiry` multiplies GoTrue refresh traffic and
races the documented reuse interval; and on a hosted project JWT expiry is a Dashboard
setting no `config.toml` parse can observe — so the gate would manufacture false
assurance for the design's largest risk.

### The writer role

Every table ships `FORCE ROW LEVEL SECURITY`, which subjects the table owner to its
own policies — and a `SECURITY DEFINER` function runs as its owner, so the definer is
**not exempt either**. Seat writes must be denied to `authenticated` (an INSERT policy
keyed on the caller is a self-service seat grant). Those two facts together mean that
without a third role holding a write policy, **no role in the database could create a
membership**: the first `create_org` fails 42501 and `supabase db reset` dies at seed.

`app_tenancy_rpc` is that role — NOLOGIN, holding no grant any client can reach, and
enterable only by executing one of the six allowlisted definer RPCs, each of which
re-derives the caller from `auth.uid()`.

**The pairing is load-bearing.** The rank-scoped write policies call
`private.member_ranks()`, which is `SECURITY INVOKER` — so during a definer call it
reads `public.memberships` *as `app_tenancy_rpc`*. With no SELECT policy for that role
the read hits RLS default-deny, the rank map comes back empty, every comparison is
false, and the write **matches zero rows and returns success**. Every promotion in
production would report OK and change nothing. So `memberships_select_rpc` exists,
`tools/check-tenancy.mjs` enforces the pair, and each seat RPC additionally raises on
`NOT FOUND` rather than trusting the policy to have matched.

### Recursion is structural, not lucky

`memberships`' own SELECT policy is self-only (`user_id = (SELECT auth.uid())`) for
both roles and never calls the helpers. The helpers read that table, so a SELECT
policy that called one would be re-entered by it. Measured against a live database,
that surfaces as `54001 stack depth limit exceeded`, **not** the `42P17 infinite
recursion detected in policy` the documentation leads you to expect: `SET search_path =
''` populates `pg_proc.proconfig`, the planner refuses to inline a SQL function carrying
one, and the rewriter's cycle check — which only sees inlined bodies — never sees a
cycle to report. Worth writing down, because the error you search for is not the error
you get. This is also why **no member
directory ships in this release**: any policy letting one caller read *other* members'
rows must express "rows in orgs I belong to", which requires a helper that reads the
seat table, which is the recursive case. Elevating past it would need `BYPASSRLS`,
which hosted Supabase's `postgres` does not hold and which this design refuses to
depend on. A non-recursive directory needs a materialized membership index maintained
by trigger — real machinery with its own consistency story — so it is deferred rather
than faked.

### Account deletion

The prior ADR's property — *"an unqualified `DELETE FROM public.notes` removes exactly
that user's rows"* — is **replaced, not dropped**. `owner_id` is demoted to nullable
attribution with `ON DELETE SET NULL`, because in B2B the data controller is the org:
an employee deleting their account must not delete the company's notes. Deletion now
revokes seats (`memberships.user_id` cascades), nulls attribution, and sweeps the
caller's *personal* org — whose deletion cascades its notes and invitations.

The sweep runs in the `delete-account` Edge Function **before** `admin.deleteUser`, and
it must be **verified before proceeding**: `ON DELETE SET NULL` on `orgs.created_by`
means that if `deleteUser` runs while a personal org still exists, the join key the
sweep filters on is destroyed by the FK action itself and the org becomes permanently
unsweepable — with the auth user gone, no retry can even authenticate. So the function
checks the sweep's error *and* its row count and returns 500 without calling
`deleteUser` on any mismatch. This requires `GRANT SELECT, DELETE ON public.orgs TO
service_role`, which is the per-table, ADR-attached grant this repo's doctrine
prescribes; the pgTAP structural suite reads that grant from a reviewed allowlist so
`service_role` holding anything beyond it still reds.

## Honest losses

- **No member directory** (above). No member-management UI ships in 0.2.0 either, so
  nothing depends on it — but "see who else is in my org" is genuinely absent.
- **Ownership transfer does not exist.** Rank 40 is below nobody, so the
  `rank-below-caller` predicate makes an owner seat unremovable and undemotable —
  including one's own. That is what makes the last-owner rule structural without a
  count no policy can perform. Transfer is a v0.3 feature.
- **Email binding on invitations is defence-in-depth, not the control.** Token
  possession is the credential, which is why the token is 122-bit server-minted
  randomness, stored only as a digest, and consumed by DELETE. GoTrue emails are
  mutable and their verified status is project configuration, so binding on them alone
  would collapse exactly when it mattered.
- **A team org whose only owner deletes their account becomes ownerless.** The seat
  cascades away and no automation promotes a survivor. Recorded rather than hidden.
- **DSR completeness is now procedure-backed, not schema-backed.** Under the old
  single-root FK graph, "delete user X" and "what belongs to X" were the same query and
  a forgotten table was a schema error. Now the personal-org sweep is a `WHERE` clause
  in a function, and after deletion the nulled attribution means residual rows can no
  longer be enumerated back to the subject. Pending invitations addressed to a deleted
  user's email also survive in other orgs.

## Sources

- PostgreSQL row security — `FORCE` applies row security to the table owner as well
  [corpus: postgres/rls-force]
- RLS performance — wrap the identity call in a scalar sub-select so the planner hoists
  it into an InitPlan [corpus: postgres/rls-initplan]
- PostgreSQL `CREATE FUNCTION` — writing `SECURITY DEFINER` functions safely,
  `search_path` pinning — https://www.postgresql.org/docs/current/sql-createfunction.html
- PostgreSQL explicit locking — `ACCESS EXCLUSIVE` conflicts with every other lock mode
  — https://www.postgresql.org/docs/17/explicit-locking.html
