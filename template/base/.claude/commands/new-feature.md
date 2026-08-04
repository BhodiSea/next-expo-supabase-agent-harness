---
description: One-turn vertical-slice entry point (migration+RLS -> RLS tests -> ./client data fn -> tRPC procedure (+ optional Server Action) -> web screen -> mobile screen -> tests -> provenance -> green gate).
argument-hint: "[feature-name]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
model: opus
---

Build the feature **$1** as a complete vertical slice — ONE shared Supabase backend,
two surfaces (Next 16 web + Expo 57 mobile) — in a single turn.

Drive the `authoring-vertical-slice` skill and follow its locked order EXACTLY:

    migration + RLS -> RLS tests -> ./client data fn -> tRPC procedure (+ optional
    Server Action) -> web screen -> mobile screen -> tests -> provenance -> green gate

Delegate each layer to its specialist subagent:

- schema + migration + RLS -> `migration-rls-author`
- the vertical data function + the tRPC procedure -> `dal-author`
- the RLS + unit + component tests -> `test-author`

The MAIN THREAD scaffolds the empty skeleton (the skill owns the layout) and runs the
inventory regen — the `dal-author` subagent authors, the main thread runs Bash:

```
node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs $1
pnpm gen        # after any procedure/event change; the `contracts` gate regen-diffs the committed inventories
```

Migrations are append-only and TIMESTAMPED: the declarative change lands in
`supabase/schemas/*.sql`, and the migration is composed completely and written ONCE as
a NEW `supabase/migrations/<timestamp>_$1.sql`. An existing migration is never edited —
a mistake is a further new migration. (`/new-migration $1` drives just that layer.)

Per-layer non-negotiables the gates enforce (the skill references carry the worked
patterns; `@app/notes` is the seeded reference vertical every layer copies — a slice
missing any of these arrives pre-red):

- **migration + RLS** — in the SAME migration: `ENABLE` + `FORCE ROW LEVEL SECURITY`,
  four per-operation policies `TO authenticated` (never `FOR ALL`) keyed on the initPlan
  sub-select `(select auth.uid())` with `WITH CHECK` on INSERT/UPDATE, `REVOKE ALL ...
  FROM anon` + `REVOKE ALL ... FROM service_role`, a `GRANT` of only the operations the
  feature needs to `authenticated`, and a LEADING-column owner index that also carries
  the list's `ORDER BY` columns so one index serves the policy, the sort and the keyset
  cursor (`supabase/schemas/20_notes.sql` is the pattern). `service_role` BYPASSES RLS by
  role attribute — the REVOKE is the only lever over it, and it stays revoked until an
  ADR-governed Edge Function needs a per-table grant.
- **RLS tests** — the table joins the `rls_targets` list and the pgTAP suites under
  `supabase/tests/*.sql` (structure + cross-user isolation) AND the live isolation matrix
  in `tests/rls/`. `pnpm db:reset` then `pnpm db:test` must pass before the slice is done.
- **./client data fn** — a read lands on the vertical's Metro-safe `./client` barrel; a
  write (sets an ownership column, emits an event) lands on the `.` server barrel. It
  TAKES an RLS-scoped client, never constructs one; returns `ActionOutcome<T>` from
  `@app/errors` (never throws for a domain failure); zod-parses at the exit; every list is
  keyset-paginated with an unconditional LIMIT. NO app-side `owner_id` filter — visibility
  is the RLS policy's job, and an app filter would MASK a policy regression.
- **tRPC procedure (+ optional Server Action)** — a three-line procedure in
  `packages/api/src/routers/<x>.ts` on the correct rung: `authedProcedure` for reads,
  `memberProcedure` for writes, resolving membership as an outcome
  (`const gate = ctx.member; if (!gate.ok) return gate`). It returns the vertical's
  `ActionOutcome` verbatim. If web writes the same data, its twin is a Server Action in
  `apps/web/app/actions/*` sharing the SAME zod contract and the SAME `@app/notes`
  implementation — one operation, two callers, or the surfaces have forked.
- **web screen** — reads through `apps/web/lib/app-data/*` (the RSC seam: RLS-scoped, never
  cached on a shared key, never a direct Supabase query in a component); writes through the
  Server Action. Server-side identity is `getUser()` / `getClaims()`, NEVER `getSession()`
  (it decodes an attacker-controlled cookie without verifying the signature).
- **mobile screen** — REGISTERED in `src/routes.ts` (id, titleKey, path, file, state
  testIDs) with its root `<Screen testID="<route-id>-screen">`; tokens-only styling; every
  user-facing string a catalog key via `t()`; data access ONLY through the tRPC client
  `apps/mobile/src/lib/trpc/client.ts` (`@app/api` is a devDependency, `import type` only);
  the session lives in LargeSecureStore, never a JS-visible store. Plus the closure the Stop
  chain enforces: a Maestro flow AND a `tools/startup-budget.json` row for the new screen
  (human-reviewed — list the needed row in your report if you cannot write it).
- **tests** — enough to hold the per-file coverage floor on every changed file (vitest for
  server/packages/pure logic, jest-expo for RN; both run `--coverage` in the Stop hook).

For invariant-touching work (auth, RLS, migrations, the service-role/Edge-Function
surface, the API contract), write `specs/$1.md` first and get sign-off before implementing.

Before you finish (provenance is REQUIRED — the turn is not done without it):

- run the `torvalds-reviewer` subagent and require `VERDICT: PASS`;
- run the `security-reviewer` if migrations / RLS / a data function / auth changed (or run
  `/rls-check`);
- run the `web-security-reviewer` if `apps/web/app/actions/**`, `apps/web/lib/supabase/**`,
  `apps/web/proxy.ts`, `apps/web/app/api/trpc/[trpc]/route.ts`, any service-role usage, or a
  `NEXT_PUBLIC_` env changed;
- run the `mobile-security-reviewer` if `app.config.ts` / `eas.json` /
  `tools/identity.lock.json` / the permission or plugin allowlists / `src/host/**` / the auth
  session changed;
- run the `accessibility-reviewer` AND the `design-reviewer` if mobile UI changed (require
  `PASS`);
- emit and verify the ADR — run `/adr $1` FIRST (so the ADR Sources list is itself verified),
  THEN `/verify-citations` and require `CITATIONS: CLEAN`.

Every non-trivial decision carries `// SOURCE:` (`-- SOURCE:` in SQL), ideally with a
`[corpus: <id>]` reference. The turn ends ONLY when `pnpm validate` is green and
`pnpm test:rls` / `pnpm db:test` / `pnpm test` / `pnpm test:mobile` pass. The Stop hook
enforces exactly this — do not stop on a red build or with provenance incomplete.

Current working tree for context: !`git status --short`
