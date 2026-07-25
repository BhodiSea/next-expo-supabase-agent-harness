---
description: Audit the working tree against the always-loaded security-invariants rule via the torvalds-reviewer subagent — return a PASS/FAIL verdict naming any invariant weakened.
allowed-tools: Read, Grep, Glob, Bash
model: opus
---

Audit the just-written change against the non-negotiable invariants in
`.claude/rules/security-invariants.md` (always loaded; also hook- and lint-enforced).
This is the human-readable second opinion behind the deterministic gates — it catches
the invariant a two-row test DB and a passing static scan both miss.

Files changed in the working tree:

!`git diff --name-only HEAD`

Run the `torvalds-reviewer` subagent over that diff (it runs `git diff` against the
base itself, ranks every finding CRITICAL / HIGH / MEDIUM / LOW with a `file:line`
ref, and ends `VERDICT: SHIP` or `VERDICT: BLOCK`). Then RECONCILE its findings against
each invariant family below — a `SHIP` verdict is necessary but not sufficient; you own
the final call, and a weakened invariant the reviewer under-ranked is still a FAIL.

- **RLS keyed on `auth.uid()` is THE authorization boundary.** Every user-scoped table
  ships `ENABLE` + `FORCE ROW LEVEL SECURITY` in the SAME migration that creates it, four
  per-operation policies `TO authenticated` (never `FOR ALL`, never `TO public`), each
  predicate REAL and keyed on the `(select auth.uid())` initPlan sub-select, `WITH CHECK`
  on INSERT/UPDATE, and a LEADING-column owner index. Both surfaces reach the same rows
  through these policies, so an app-side `owner_id` filter is not defence — it MASKS a
  policy regression. Exemptions live only in the human-reviewed `tools/rls-exempt.json`.
- **`service_role` BYPASSES RLS and has exactly one home.** Reachable ONLY inside an
  ADR-governed Edge Function (`supabase/functions/<name>/index.ts`) via
  `createServiceRoleClient_BYPASSES_RLS(warrant)` — never a Server Action, a tRPC
  procedure, a script, or a screen. Migrations `REVOKE ALL ... FROM service_role`
  (and `FROM anon`); the factory lives on the `.` barrel only, and `SUPABASE_SERVICE_ROLE_KEY`
  appears nowhere else. Flag any use outside `supabase/functions/**`.
- **Server-side identity is `getUser()` / `getClaims()`, NEVER `getSession()`.** On a
  server the cookie is attacker-controlled input; `getSession()` decodes it without
  verifying the signature, so it is one autocomplete away in `apps/web/lib/supabase/server.ts`.
  The request-scoped client is built PER REQUEST (`createRequestScopedClient()`), never at
  module scope where one caller's identity renders under another's; the mobile mirror is
  `useState(factory)`. `apps/web/proxy.ts` is NOT an authz boundary (CVE-2025-29927) — it
  only rotates the auth cookie and excludes `api/trpc` + `.well-known` from its matcher.
- **The envelope is the single error channel.** Procedures (`@app/api`) and web Server
  Actions return `ActionOutcome<T>` from `@app/errors` on the DATA channel —
  `outcomeOk(...)` / `outcomeErr(appError.X())`; a domain failure is RETURNED, never
  thrown (a thrown `TRPCError` flattens the discriminated `AppError` the screens switch on
  into a status). Only transport auth (`UNAUTHORIZED`) and the skew guard's `CONFLICT` may
  bypass it. A `memberProcedure` write carries its `const gate = ctx.member; if (!gate.ok)
  return gate` two-liner; ids come from the VERIFIED `ctx.actor`, never the input.
- **Boundary + exports walls.** verticals `_|_` verticals; `shared -/-> verticals`;
  `platform/*` reaches only the `{errors,events}` kernel; `packages/api -/-> next/*` (the
  reversibility wall); `apps/mobile -/-> ` web-only pkgs; `apps/web -/-> ` react-native. The
  dual barrel holds: `.` is the SERVER barrel (`"use server"`, service-role, Next-coupled),
  `./client` is the Metro-safe barrel (pure domain, zod, direct RLS reads), and the single
  census of which packages may expose `./client` is `tools/exports-walls.json`. `@app/api`
  is ABSENT from mobile's runtime deps — a devDependency taken `import type` only.
- **Mobile / web bundle purity.** `apps/mobile` reaches the backend through the tRPC client
  (`apps/mobile/src/lib/trpc/client.ts`, Class-B default) or a vertical's `./client` direct
  RLS reads (Class-A opt-in) — NEVER a `.` server barrel or a value-import of `@app/api`
  (Metro does not tree-shake, so either drags the server graph into the native binary). The
  session lives only in `LargeSecureStore` (`apps/mobile/src/host/large-secure-store.ts`),
  never plain AsyncStorage/kv or module state. No secret behind a `NEXT_PUBLIC_` OR an
  `EXPO_PUBLIC_` name (`*KEY|SECRET|TOKEN|PASSWORD|PRIVATE` — both prefixes inline into the
  shipped client bundle); the anon / publishable key is public BY DESIGN, the service-role
  key never is. Generated native dirs (`apps/mobile/android/**`, `ios/**`) are never
  hand-edited; identity, ATS/cleartext, and the OTA runtimeVersion stay locked.

Return a single verdict line: `INVARIANTS: PASS` or `INVARIANTS: FAIL`. On FAIL, name
every invariant weakened with its `file:line` and the offending code — the Stop hook and
the deterministic gates (`boundaries` / `architecture` / `schema-rls` / `check-exports-walls`,
the ESLint `app-error-only` rule, the SQL RLS suite) will red the turn on the same finding,
so the turn cannot end until each is resolved and this command returns `INVARIANTS: PASS`.
