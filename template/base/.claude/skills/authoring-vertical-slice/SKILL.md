---
name: authoring-vertical-slice
description: >
  The migration -> RLS -> ./client read -> tRPC procedure -> web screen -> mobile screen ->
  test recipe for shipping one whole feature slice through the Next 16 web + Expo 57 mobile
  + Supabase monorepo in a single turn. Use when asked to add a feature, procedure, or screen
  end-to-end.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
argument-hint: "[feature-name]"
---

# Authoring a vertical slice

One backend, two surfaces: a `packages/verticals/<slice>` domain, a tRPC procedure in
`@app/api` that `apps/web` serves and `apps/mobile` consumes, and a Server Action for the
web write. Build the slice in this strict order. Each layer has a lazy reference file — read
it before writing that layer (progressive disclosure keeps context lean). Delegate the two
non-trivial layers to the named subagent.

## Step 0 — read the contracts surface FIRST, and stop if the operation already exists

Before you write anything, read what the API already exposes:

- `tools/generated/action-inventory.json` — every tRPC procedure `appRouter` exposes, one
  committed row per procedure (emitted by `tools/gen-action-inventory.mjs`, regen-diffed by
  the `contracts` gate).
- `tools/generated/event-catalog.json` — every event the platform and vertical catalogs
  declare (emitted by `tools/gen-event-catalog.mjs`).
- `packages/api/src/routers/*.ts` — the routers themselves (`notes.ts` is the worked
  example, `system.ts` the health/`me` pair).

If an equivalent operation already exists, STOP and reuse it — a second `list`/`create` for
the same entity is exactly the drift the "one operation, two callers" rule exists to prevent.
Only when nothing covers the need do you scaffold a new slice.

## The order

1. **Migration + RLS** — read `references/migration-rls.md`. The desired shape is a
   declarative table in `supabase/schemas/<NN>_<slice>.sql`; the APPLIED change is a NEW
   timestamped, append-only migration `supabase/migrations/<timestamp>_<slice>.sql` carrying
   `ENABLE` + `FORCE ROW LEVEL SECURITY`, four per-operation policies keyed on `auth.uid()`
   (`TO authenticated`), a leading-column owner index, `REVOKE ALL` from `anon`,
   `service_role` AND `authenticated`, and then the exact `authenticated` grants the
   policies admit (a GRANT removes nothing — see `references/migration-rls.md`). Never a GUC — RLS keys on the request's verified JWT
   (`auth.uid()` reads `request.jwt.claims`), never on an application-set identity value.
   Delegate to the `migration-rls-author` subagent.
2. **RLS tests** — read `references/tests.md`. TWO twins, both run by `pnpm test:rls`:
   pgTAP under `supabase/tests/*.sql` (the structural + isolation suites read back what the
   database compiled and prove the empty-set principle through raw role-switch), and the
   supabase-js client suite under `tests/rls/` (the same boundary through the real PostgREST
   + GoTrue transport a Class-A mobile write takes — tenant B cannot read A). Add the table
   to BOTH registries: `rls_targets` in `supabase/tests/rls_structure.test.sql` AND
   `ISOLATION_TARGETS` in `tests/rls/db-context.ts`, then regenerate the exact-privilege
   assertions with `node tools/gen-grant-assertions.mjs` (never by hand).
3. **`./client` data function** — read `references/dal-dto.md`. The vertical's Metro-safe
   barrel (`packages/verticals/<slice>/src/client.ts`) exports the DIRECT RLS READ: it TAKES
   a per-request Supabase client, returns zod DTOs from `@app/contracts` wrapped in the
   `ActionOutcome` envelope from `@app/errors`, never raw rows and never a thrown domain
   failure. Writes stay off `./client` (they set an owner column and emit events — server
   barrel only). Delegate to the `dal-author` subagent. Every vertical's `./client` key needs
   an entry in the census `tools/exports-walls.json`, Class-B included, and that entry is a
   human's step (see Scaffold).
4. **tRPC procedure (+ optional web Server Action)** — same reference. Add the procedure to
   `packages/api/src/routers/<slice>.ts` on `orgProcedure` (READS INCLUDED — the acting org
   is WHICH DATA a read is about), name an input schema, hand the call to the vertical. If the
   web surface writes this entity, add the twin Server Action at
   `apps/web/app/actions/<slice>.ts` — SAME contract, SAME vertical implementation, SAME
   envelope, different transport. It takes the org as a BOUND argument (the route's slug,
   parsed with `OrgSlug`), resolves user and org with `requireOrgContext`, narrows the
   client with `to<Slice>Port` from `apps/web/lib/app-data/<slice>-port.ts` (the one cast
   apps/web has) and revalidates the org's path. Then the MAIN THREAD regenerates the
   committed inventories: `pnpm gen` (the `contracts` gate regen-diffs
   `tools/generated/*.json`; the `parity` gate holds the mobile ledger to the action
   inventory). Class-B is the DEFAULT — mobile writes through the procedure. Class-A (mobile writes DIRECT to Supabase via the vertical
   `./client`) is an explicit, reasoned opt-in, never the reflex: it widens what the
   `./client` barrel carries, so the census entry's reason is a security review.
5. **Web screen** — a segment under the org scope,
   `apps/web/app/(protected)/o/[orgSlug]/<slice>/`: `page.tsx`, its `page.meta.ts` (id,
   `titleKey`, the three state test ids) and `loading.tsx`. The segment IS the tenant
   selector; the page reads `orgSlug` from `params`. Read via `apps/web/lib/app-data/<slice>.ts`
   (the RSC read seam: `requireOrgContext(orgSlug)` -> `to<Slice>Port(gate.data.client)` ->
   vertical `./client`, scoped to the RESOLVED org -> match the outcome -> a render model),
   NEVER a Supabase query in a Server Component and NEVER a `fetch()` to the app's own
   `/api/trpc`. Render each state as `data-testid={meta.states.<key>}`, add the `titleKey` to
   `apps/web/lib/i18n/catalog.ts`, regenerate the registry (`node tools/gen-web-routes.mjs`)
   and name one state id in a spec under `apps/web/e2e`: `route-manifest` holds all four.
   Writes go through the Server Action from step 4. `getUser()`/`getClaims()`
   server-side for rendering decisions — never `getSession()` (it decodes an
   attacker-controlled cookie without verifying the signature). RLS-scoped reads are never
   cached on a shared key.
6. **Mobile screen** — read `references/mobile-screen.md`. An expo-router screen under
   `apps/mobile/app/**` composing a `apps/mobile/src/features/<slice>/` feature; data via the
   mobile tRPC client (`src/lib/trpc/client.ts`, reached through `useApi()` and folded to the
   envelope by `callProcedure`) for a Class-B slice, or the vertical `./client` for a Class-A
   read. REGISTER the screen in `src/routes.ts` (id, titleKey, path, file, state testIDs) and
   render its root as `<Screen testID="<route-id>-screen">` — the device lane asserts that
   container id for every `ROUTES` entry. Styling ONLY through `@app/design-tokens` (via
   `useThemedStyles((palette) => ...)`); every string a catalog key; a11y from the
   `src/components` primitives. BEFORE composing, read the `designing-mobile-ui` skill's
   checklist for the surface type.
7. **Tests + provenance + green gate** — read `references/tests.md`. Unit tests in the right
   runner (vitest for pure domain/logic; jest-expo for RN components/screens; fast-check for
   any parser), each holding the per-file coverage floor. Delegate to the `test-author`
   subagent. Then provenance, in this order: (a) `// SOURCE:` (`--` in SQL) on every
   non-trivial decision; (b) emit the ADR via `/adr <slice>` so
   `docs/adr/<YYYYMMDD>-<slice>.md` exists and reconciles with the inline citations; (c) run
   `/verify-citations` and require `CITATIONS: CLEAN`. Finish only when the ADR exists,
   citations are CLEAN, the `design-reviewer` answers `PASS` on any UI the slice touched, and
   `pnpm validate`, `pnpm test:rls`, `pnpm test`, and `pnpm test:mobile` are all green. The
   Stop hook re-runs the same steps; do not stop on a red build or with provenance
   incomplete.

## Scaffold

The MAIN THREAD scaffolds the empty skeleton (the `dal-author` subagent has no Bash):

```
node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs <slice>
```

`<slice>` is a single kebab-case argument (e.g. `release-notes`). The script is idempotent:
it writes a file only if it does not already exist. It writes the worked example's shape: the
vertical's `src/` with every data seam (`data/{port,rows,errors,query-probes,<slice>}.ts`), the
router, the Server Action, the web segment `apps/web/app/(protected)/o/[orgSlug]/<slice>/`
(`page.tsx`, `page.meta.ts`, `loading.tsx`), the read seam `apps/web/lib/app-data/<slice>.ts`,
`apps/web/lib/app-data/<slice>-port.ts` (the one narrowing function; no other stub casts) and
the mobile feature. A stub that cannot compile until the vertical resolves is comment-only.
Each step the script must not take itself is a printed `next:` line (among them the catalog
key, the registry regen, the browser spec, the query probes and the vertical's
`package.json`); until they are done, `route-manifest` and `query-shapes` red with the
findings those lines name. One `next:` line is a human's, not yours: the census entry for the
new `./client` key. `tools/exports-walls.json` is harness-owned and hash-pinned, so the write
guard denies your edit. Hand the `{package, reason}` entry to a human, who adds it under
security-owner review and re-records the file's sha256 in `.harness/manifest.json` in the same
reviewed commit; until then `boundaries` reds the package as NOT sanctioned. It deliberately
does NOT create the
migration file — `supabase/migrations/*` is append-only (timestamped, applied history), so a
pre-created stub could never be filled in and would only invite a hand-edit of applied
history. Compose the migration completely with `supabase migration new <slice>`, then write
it once.

## IP boundary

Keep reusable platform abstractions separate from bespoke feature code. A vertical MUST NOT
import another vertical — cross-feature logic belongs in `packages/shared`, promoted
deliberately. Never bake customer content into shared modules.
