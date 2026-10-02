# Stack-aware index substrate: the anatomy of `next-expo-supabase-agent-harness`

All paths are relative to `template/` at the 2.0.0 stack head (`stack/52-i37-work-plan`, commit `b158f5a`).

**Where the worked example lives.** The `notes` example is in `demo/`. `init --with-demo` overlays it on base and stack, replacing files at the same path and adding new ones (`../installer/lib/layout.mjs:81-91`). `eject` removes it again using `demo-index.json`, which lists every register row the demo adds. Without the demo the scaffold has no vertical at all.

**A second vertical exists only as text.** The push module ships one as `.txt` files under `modules/push-notifications/docs/modules/push-notifications/slice/`. It is the only real evidence of how a second vertical diverges, and I use it below.

---

## 1. The vertical anatomy

### What the laws check
`base/tools/lib/vertical-anatomy.mjs:51-59` defines seven laws:
- `dual-barrel`
- `pure-barrel`
- `domain-purity`
- `dal-client-value-import`
- `port-presence`
- `events-purity`
- `select-star`

Since 1.0.0 the laws key on behaviour, not folder names (`:14-30`):
- Any file that calls `.from(`, `.rpc(` or `.select(` must import a `port.ts` (`:66`, `:255-269`).
- A value import of `@app/supabase` anywhere under `src/**` is red (`:243-253`).

Only `domain/` and `events.ts` are still keyed on their names (`:32-38`). The allow-file is empty in both base and demo.

### What the skill teaches versus what it scaffolds
The skill (`SKILL.md:36-98`) teaches seven steps: migration → RLS tests → `./client` → procedure and Server Action → web → mobile → tests.

`scaffold-slice.mjs:36-149` creates only some of the slots. It does **not** create:
- `data/port.ts`, `data/rows.ts`, `data/errors.ts`, `data/query-probes.ts`
- `domain/*`
- `page.meta.ts`, `lib/app-data/<slice>.ts`

It also writes the web page to `apps/web/app/<slice>/page.tsx` (`:108`). The worked example uses the org-scoped path `(protected)/o/[orgSlug]/notes/`, so the scaffold is stale against it.

### Slot table
"High" in the last column means the slot should look near-identical across verticals, so divergence is a smell. "Low" means the slot is domain-specific, so similarity across verticals suggests a missing shared abstraction.

| Slot | Path pattern (notes witness) | What goes there; imports → exports | Expected similarity |
|---|---|---|---|
| Manifest | `verticals/<s>/package.json` (`.tmpl:7-10`) | `exports {".", "./client"}`; deps on contracts, errors, events, supabase, zod | **High**: law-mandated |
| Server barrel | `src/index.ts:48-86` | Re-exports `./client`, plus the writes, row constants and export codec | **High** shape, names vary |
| Client barrel | `src/client.ts:26-74` | Reads, port types, cursor codec, domain, event types, `EVENT_CATALOG` (`:66`, the generator's discovery key), schemas | **High** |
| Input schemas | `src/schemas.ts:29,55` | `Contract.refine(domainPredicate)`, plus `clampPageLimit` | Shape **high**; refinement **low**. `clampPageLimit` copies are a smell |
| Events | `src/events.ts:76,109` | `defineEventCatalog`, `{actorId, <x>Id, orgId, occurredAt}` base, created/updated/deleted constructors; imports only `@app/events` | **High** CRUD boilerplate: a missing generic factory |
| Port | `src/data/port.ts:55-81` | Structural PostgREST subset, `data: unknown` | **High**. The reviewer rubric calls it the blessed pattern but says to flag copies made by reflex (`architecture-reviewer.md:42-44`) |
| Row seam | `src/data/rows.ts:14,26,34-72,80,98` | Table name, explicit projection, snake row schema borrowing contract shapes, `toXRecord`, `asRowArray` | **High**: a pure function of SQL columns plus the DTO, so derivable. `asRowArray` is a verbatim clone |
| Error mapper | `src/data/errors.ts:69` (`mapPostgrestFailure`), plus `missingX`, `contractDrift`, `unreadableWrite`, `invalidCursor`, `emptyPatch` | SQLSTATE → `AppError` | **High**: this is a smell. It duplicates `@app/supabase`'s `mapPostgresError` (`stack/packages/platform/supabase/src/errors.ts:134`), which the file admits at `:18-21` |
| DAL | `src/data/notes.ts` (`keysetTieBreak:182`, `applyKeyset:192`, `pageOf:203`, `createNote:416`) | Scope/WriteContext; list/get/create/update/delete | Keyset helpers **high** (smell); query chains **low** |
| Probes | `src/data/query-probes.ts:43,77` | `DAL` namespace plus `QUERY_PROBES`, discovered by path (`base/tools/lib/query-shapes.mjs:26-36`) | **High** |
| Domain | `src/domain/note.ts:29,39,81` | Pure rules: `normalizeTitle`, `isRenderableTitle`, `toNoteView` | **Low**: true domain |
| Cursor codec | `src/domain/cursor.ts:142,153` | base64url keyset `{createdAt, id}` | **High**: already cloned by push (`…/push/src/domain/cursor.ts.txt:10-17`) |
| Contracts region | `demo/packages/contracts/src/index.ts:26-363,488` | `*_MAX`, Record, View, NewInput, UpdateInput, Ref, ListQuery, Page, Deletion, Exported — all in one shared file | Name set **high**; fields **low** |
| Router | `packages/api/src/routers/<s>.ts:44-88`, plus one line in `index.ts:30` | `writeContext()`; a three-line gate per procedure | **High**: any logic here is a smell (`dal-dto.md:79-82`) |
| Server Action | `apps/web/app/actions/<s>.ts` | `actionClient.inputSchema`, `requireOrgContext`, port cast, `revalidatePath`, fold | **High** (twin of the procedure) |
| Web read seam | `apps/web/lib/app-data/<s>.ts`, `<s>-model.ts` | gate → port cast → `./client` read → model | **High** |
| Web route | `app/(protected)/o/[orgSlug]/<s>/{page.tsx, page.meta.ts, loading.tsx}` | Meta `{id, titleKey, states}` | Meta **high**; page **low** |
| Mobile feature | `apps/mobile/src/features/<s>/{Panel, Composer, useListQuery, useCreateNote}`, `app/` route, `src/routes.ts` entry | Hooks follow exemplars (`mobile-screen.md:46-51`) | Hooks **high**; UI **low** |
| SQL | `supabase/schemas/NN_<s>.sql` plus migrations | Skeleton from `migration-rls.md:74-146` and 4 policies (`:153-196`) | **High** |
| Registers | `rls_targets`, `ISOLATION_TARGETS`, `startup-budget.json`, `PARITY.md`, `data-flow.json`, `db-limits.json`, `exports-walls.json`, maestro flow | One row per vertical or table | **High** |

### What the second vertical shows
The push vertical re-grows several of these slots under new names, all inline in `push-tokens.ts.txt`:
- The port, as `PushTokens*` (`:43-74`).
- `asRowArray` (`:121`).
- The failure mapper, as `mapFailure` (`:152-168`).

It has no `rows.ts`, `client.ts`, `events.ts` or `query-probes.ts`. It probably also fails `port-presence` today, because its DAL calls `.from(` without importing a `port.ts`.

---

## 2. Cross-layer concept seam: `notes.title` (and `owner_id`)

| # | Layer | file:line | Linked by machinery? |
|---|---|---|---|
| 1 | SQL desired state | `demo/supabase/schemas/20_notes.sql:23`, CHECK 1..200 at `:38` | `sql-parse` `parseColumnFacts` (`base/tools/lib/sql-parse.mjs:978`) |
| 2 | Migration | `demo/supabase/migrations/20260101000100_notes.sql:19,29` | Schema ↔ history agreement in check-data-flow (`:419`) |
| 3 | Generated types | `demo/packages/platform/supabase/src/database.types.ts:67-73` | `types-drift` gate against the live DB. **Deliberately kept off the compile graph** (`check-types-drift.mjs:7-10`), so nothing links it to TS code |
| 4 | Wire bound | `contracts/src/index.ts:26` (`NOTE_TITLE_MAX = 200`) | **No link to SQL CHECK 200.** Prose only (`migration-rls.md:88-89`) |
| 5 | DTOs | NoteRecord `:279`, NoteView `:295` (restated, not borrowed), NewNoteInput `:309`, UpdateInput `:323`, Exported `:494` (borrowed) | Only "is it bounded" (`check-contract-drift.mjs:15-21`) plus tsc where shapes are borrowed |
| 6 | Row seam | `rows.ts:26` (projection), `:40` (`NoteRecord.shape.title`), `:69` (rename) | `rows.test.ts:33-36` checks projection = row keys; tsc. **Does any SQL column exist for the projection? Not checked statically** |
| 7 | Query manifest | `query-shapes.json`, entry `notes.createNote#insert`, `payload [...,"title"]` | Generated and regen-diffed by the contracts gate. `check-query-shapes` checks index service, not column existence (`:203`) |
| 8 | Domain | `domain/note.ts:29,39` | tsc |
| 9 | Input schema | `schemas.ts:29` (`NewNoteInput.refine(isRenderableTitle)`) | tsc |
| 10 | DAL write | `data/notes.ts:437` (`normalizeTitle`); `:436` sets `owner_id` from the actor | `query-shapes` payload |
| 11 | tRPC | `routers/notes.ts:58` → `action-inventory.json` `notes.create` | Inventory holds `{action, type}` only, with **no schema, rung or vertical function** (`base/tools/lib/inventory.mjs:18-28`) |
| 12 | Server Action | `apps/web/app/actions/notes.ts:38,82` | **None.** It is not in any inventory, and PARITY does not track Server Actions. The procedure ↔ action twin is linked only by comment (`:13-19`) |
| 13 | Web composer | `note-composer.tsx:29`; `:61` uses `title.trim()===''` | **None.** This re-spells `isRenderableTitle` |
| 14 | Web page | `page.tsx:51`; `page.meta.ts:7-14` → `lib/routes.generated.ts:21-24` | gen-web-routes plus the route-manifest and web-routes gates (states rendered) |
| 15 | Mobile | `useCreateNote.ts:139` (`NewNoteInput.safeParse`, which **skips the refinement**), `:156` `api.notes.create`; `NotesPanel.tsx:83` | tsc via `AppRouter`; `PARITY.md:27` (parity checks only that the path exists, `check-mobile-parity.mjs:115`) |
| 16 | i18n | mobile `catalog.ts:51,54` (`notes.composer.*`); web `catalog.ts:150-151` (`notes.new` / `notes.add`) | Per-catalog only (literals, dead keys). **No cross-surface key parity**; the key names already diverge |
| 17 | Maestro | `demo/maestro/journeys/mutation.yaml:69-77` (`note-composer-input`, `note-row`) | **None.** Generated flows assert only `<route>-screen` (`maestro-flows.mjs:10-12`) |
| 18 | Web e2e | `apps/web/e2e/notes.spec.ts:82` (`notes-empty`) | Matched to `page.meta` states by name |
| 19 | pgTAP / RLS | `rls_structure.test.sql:38-46,97`; `rls_isolation.test.sql:308`; `rls_grants.generated.test.sql`; `tests/rls/db-context.ts:250-259` (`title:'rls probe'`) | check-rls-manifest syncs `rls_targets` ↔ `ISOLATION_TARGETS`; gen-grant-assertions |
| 20 | DSR export | `demo/tools/data-flow.json` `export.projection` (notes includes title) ↔ `rows.ts:98` | Gate closes projection → SQL (`check-data-flow.mjs:170-175`). The `rows.ts` ↔ JSON link is a **hard-coded literal** in `rows.test.ts:154-166`, so name match only |
| 21 | Events | `events.ts:29` (`NoteField 'title'`) | event-catalog rows carry no payload fields |

### The `owner_id` thread
The same concept runs through these files:
1. SQL: nullable, `ON DELETE SET NULL`.
2. `data-flow.json` `severed[0]`, checked by the gate's FK walk (`base/tools/lib/data-flow.mjs:54-109`).
3. Contracts `ownerId` nullable (`:278`), omitted from NoteView.
4. DAL `:436`.
5. The DELETE-policy arm in `20_notes.sql`, checked by the tenancy gate.

### Hops joined only by name
- SQL CHECK ↔ `*_MAX`
- Server Action ↔ procedure
- Client-side validation ↔ domain refinement
- i18n keys across the two surfaces
- Maestro and e2e testIDs ↔ components
- `rows.ts` export projection ↔ `data-flow.json`
- PARITY cell ↔ whether that file actually calls the action

That last one is already wrong: `PARITY.md:27-29` says web has no screen for `notes.create`/`notes.list`, but `page.tsx` and `note-composer.tsx:29` exist.

---

## 3. Shared layers and promotion doctrine

### `packages/shared` does not exist
Rules point at it in several places:
- `boundaries.md:34-36`
- `dependency-cruiser.cjs:24-41`
- `check-workspace-deps.mjs:142`
- `pnpm-workspace.yaml:7`
- `SKILL.md:117-119`

`CHANGELOG.md:3454` itself records "`packages/shared/*` (does not exist)".

### Platform layer
- The kernel is `errors` and `events`, which import nothing.
- `platform/*` may import only errors, events and env (`dependency-cruiser.cjs:44-56`).
- `@app/supabase` already holds a generic `mapPostgresError` and a `PostgresFailure` type (`errors.ts:49,134`) that verticals re-implement.
- `stack/packages/api/src/context.ts:42-72` holds a **third** structural port: `StoreFailure`, `StoreOutcome`, `StoreQuery`, `ApiDatabase`. It is meant to be widened by intersection (`:35-39`). In the demo it is replaced by `NotesDatabase` (`demo/packages/api/src/context.ts:2,172`).

### Promotion doctrine
- There is **no threshold** such as "rule of three" and no ADR trigger.
- The only review-time duties are the architecture reviewer's "abstraction accounting" and "a one-concept change touching N packages names the missing single home" (`architecture-reviewer.md:37-57`), plus `AGENTS.md:201`.
- There is a **structural blocker**: seeded shared roots (contracts, platform, api, design-tokens) cannot receive new exports through `update`. Extraction is therefore actively discouraged (`duplication-allow.json:30`).

### Mechanism for "two verticals grew the same helper"
The only one is `check-duplication.mjs`:
- It finds type-1 token clones of at least 70 tokens over 6 lines (`:27-31`).
- It normalises string and number literals but **not identifiers** (`:107-140`).
- It scans TypeScript only (`:146`). Its walk does cover the layered `packages/verticals/*` group (`:35-41`).

The push module illustrates the limit. The cursor codec was caught, and the module's fix is an allow-entry (`APPLY.md:246-253`). The renamed port, `asRowArray` and `mapFailure` would not be caught.

---

## 4. Generated and derived indexes

| Artifact | Shape | Graph use |
|---|---|---|
| `tools/generated/action-inventory.json` (`gen-action-inventory.mjs:20`) | `[{action, type}]` | **Nodes** (procedures). Needs edges to schema, vertical function and rung added |
| `tools/generated/event-catalog.json` (`gen-event-catalog.mjs:25`; discovery `base/tools/lib/event-catalogs.mjs:21,62`) | `[{name, version, description}]` | Nodes. No payload, no emitter |
| `tools/generated/query-shapes.json` (`gen-query-shapes.mjs:36`; schema `query-shapes.mjs:42-60`) | `[{id, vertical, fn, table, op, kind, columns, eq, is, order, range, or, orColumns, payload, limit, extra}]` | **Best edge source**: fn → table, fn → columns read, written, filtered and sorted; joins to SQL indexes (`resolveIndex:161`) |
| `apps/web/lib/routes.generated.ts` (`gen-web-routes.mjs:23`) | `WEB_ROUTES [{id, titleKey, states, file, path}]` | Screen nodes; edges to i18n keys and testIDs |
| `supabase/tests/rls_grants.generated.test.sql` (`gen-grant-assertions.mjs:34`) | Per table × role exact privileges | Table → role edges |
| `packages/platform/supabase/src/database.types.ts` (`pnpm db:types`) | `Tables{Row, Insert, Update}` | Column nodes (public schema only) |
| `design-tokens/src/generated/{native.ts, web.css}` | Token → value per theme | Token nodes |
| `demo-index.json` (`../scripts/check-demo-index.mjs`) | `[{file, jsonPointer \| rowKey, restore?}]` | **Vertical → register-row ownership edges**, a ready-made "what belongs to notes" map |
| `tools/agents.lock.json` (`gen-agents-lock.mjs:41`) | sha256 per `.claude` file, plus model | Provenance only |
| `tools/prompts.lock.json` | `{}` (seeded) | No |
| SBOM (`check-sbom.mjs:89`, `lib/sbom.mjs`) | Dependency components | Package nodes |
| `artifacts/deploy-manifest.json` (`emit-deploy-record.mjs:82`) | Deploy record | No |
| Maestro sweep YAML (generated at run time, `maestro-flows.mjs`) | ROUTES × identity | Screen → flow |
| `tools/mcp/corpus/index.json` | `[{id, groups, title, url, version, sha256, text}]` | Edges from `[corpus: id]` citations |
| Skill references (`../scripts/generate-skill-references.mjs`; `skill-region` markers, e.g. `routers/notes.ts:57-63`) | Source span → doc region | Doc ↔ code edges |

Reviewed (hand-written but parse-checked) registers are also good edge sources:
- `data-flow.json` (table.column → erase/export)
- `tenancy.json` (rail function names)
- `db-limits.json` (metered tables)
- `pii-columns.json`, `audit-columns.json`
- `exports-walls.json` (`./client` census). It lists `@app/notes` even without the demo, so it is name-only.
- `reviewer-triggers.json` (path glob → reviewer)
- `lib/stamp-inputs.mjs` (gate → input files)
- `doctrine-symbols.json` (retired → replacement symbol)
- `PARITY.md` (action → screen path)

---

## 5. Cross-surface duplication: deliberate versus accidental

### Deliberate (a similarity detector must not flag these)
- **Web and native design systems.** Same names and props, different implementations (`duplication-allow.json:5-26`; `design-system-native/src/index.ts:4-23`).
- **The two i18n catalogs.** Same type preamble and the same table-of-rows shape (`duplication-allow.json:30-42`).
- **Sign-in and sign-up forms** (`:34`).
- **Server Action and tRPC procedure.** Twin transports over one vertical function (`dal-dto.md:132-152`).
- **Web `lib/action-outcome.ts` and mobile `src/lib/trpc/normalize.ts`.** Both fold their transport's channels onto `ActionOutcome`.
- **RSC read seam and mobile `useListQuery`.**
- **One port per consumer** (blessed, `architecture-reviewer.md:42-44`).

### Accidental (should be flagged)
- **Two mobile primitive sets.** `apps/mobile/src/components/{Button, Card, EmptyState, Field, Input, Skeleton, Spinner}` duplicates `packages/design-system-native/src/*`. `apps/mobile` does **not depend on** `@app/design-system-native` (no import anywhere under `apps/`). The doctrine contradicts itself: `mobile-screen.md:90-93` says to use `src/components`, while `:110-111` and `AGENTS.md` say mobile uses `design-system-native`.
- **Write-context assembly copied.** `routers/notes.ts:44-51` and `actions/notes.ts:76-81` build it separately, and the copies differ: `ctx.now` vs `new Date()`, and the emit sink.
- **Port cast repeated three times.** `as unknown as NotesDatabase` at `actions/notes.ts:71`, `lib/app-data/notes.ts:60` and `app/api/trpc/[trpc]/route.ts:152`.
- **"Renderable title" spelled three ways** (§2, hops 9, 13, 15).
- **Failure mapper ×3 and port types ×4** (§3).
- **NoteView restates the title bound** (`contracts:295`) instead of borrowing it.
- **Diverging i18n keys** for the same affordance across surfaces.
- **Route ids differ for the same screen.** The web notes route id is `notes`; on mobile the notes UI lives inside the `home` route (`routes.ts:48`).

---

## 6. The SQL side

### Can `sql-parse.mjs` detect repetition?
It already exposes the needed views, folded last-wins over the whole migration history:
- **Policies**: `parsePolicies:481` / `parseLivePolicies:583` give `{name, using, check, roles, permissive}` per table and operation, with balanced-paren bodies.
- **Functions**: `parseFunctions:1045` gives `{qualified, params, securityDefiner, searchPath, volatility, language, body}`.
- **Triggers**: `parseTriggers:1107` gives `{timing, events, forEach, when, execute, args}`.
- **Grants, indexes, columns**: `parseGrants:1158`, `parseIndexes:745`, `parseColumnFacts:978`.

Today seven gates use these views only to check legality, not similarity.

Detection would be easy. Only two predicate shapes are legal (`migration-rls.md:52-60`), so after substituting the table name, policy bodies collapse into a few equivalence classes. Function bodies can be hashed after normalising the schema name. Triggers can be keyed on `(timing, events, forEach, execute, args)`.

### Shared helpers new migrations should reuse

| Helper | Defined at | Is reuse enforced? |
|---|---|---|
| `public.set_updated_at()` | `00_shared.sql:39` (the only function in that file) | **Prose only** ("Reuse it; do not reimplement", `migration-rls.md:253-255`) |
| `private.member_org_ids` | `20260201000000_tenancy_spine.sql:230` | Gate-enforced via `tenancy.json` `scopeHelper` and `check-rls-manifest.mjs:290-309` |
| `private.member_ranks` | `20260201000000_tenancy_spine.sql:245`, redefined in `…_privilege_lifecycle_jit.sql:238` | Gate-enforced via `tenancy.json` `rankHelper` |
| `private.freeze_org_id` | `20260201000000_tenancy_spine.sql:311` | Gate-enforced (`check-tenancy.mjs:1078-1089`) |
| `audit.write_row` | `20260202000000_audit.sql:293` | Gate-enforced: audit trigger required on every org-scoped table |
| `private.enforce_org_quota` / `release_org_quota` | `20260203000000_quota.sql:233` / `:300` | Gate-enforced (`check-db-limits.mjs:408`, from `db-limits.json`) |
| `private.mfa_satisfied` | `20260812000000_mfa_aal2.sql:142` | `check-rls-manifest.mjs:659` |

The notes migrations show these rails being reused correctly (`20260930000100_notes_rails.sql:35,91`).

### Reinvention that already happened
- `audit.deny_mutation` (`20260202000000_audit.sql:196`) and `auth_trail.deny_mutation` (`20260816000000_auth_event_trail.sql:132`) are identical except for the schema name.
- `ensure_partitions` (`:388` vs `:246`) and `drop_partitions_older_than` (`:442` vs `:283`) are the same story.

These are invisible because `check-duplication` scans only `.ts`/`.tsx`, and `tenancy.json` names only `audit.deny_mutation`.

---

## What a stack-aware index could know that a generic one cannot

1. **Slot identity.** Every file maps to an anatomy slot by path plus behaviour (the `vertical-anatomy` keys). Comparison can then be done slot by slot, with a per-slot expectation: high-similarity slots flag divergence, low-similarity slots flag convergence. The push vertical's port, `asRowArray` and `mapFailure` would match the notes versions slot-wise despite the renamed identifiers that defeat the token gate.
2. **A typed concept graph.** One deterministic chain links SQL column → `parseColumnFacts` → the `rows.ts` row key (snake) → the `Record.shape` field (camel, by the documented single seam) → query-shapes `columns`/`payload` → DTO → procedure (action-inventory) → `page.meta` / `ROUTES` → i18n `titleKey` → testIDs. The index can fill in today's missing hops by convention: the CHECK ↔ `*_MAX` bound, procedure ↔ Server Action, client validation ↔ domain refinement, cross-catalog key parity, and PARITY cell ↔ actual call site.
3. **A whitelist of deliberate parallels.** It can load `duplication-allow.json`, the DS mirror, the transport twins and the per-consumer port, so it never flags the doctrine's own required duplicates. Conversely, it can flag a parallel that is not on that list, such as `apps/mobile/src/components` vs `design-system-native`.
4. **Ownership of registers.** `demo-index.json`, `stamp-inputs` and `reviewer-triggers.json` already say which register rows, gates and reviewers a change to a vertical touches. That gives "what else must move" without reading the repo.
5. **Classes of shared SQL rails.** Policies and functions can be normalised into the two legal predicate shapes and the named rails from `tenancy.json` / `db-limits.json`. A new migration's function or trigger can then be checked against "reuse `set_updated_at` / `audit.deny_mutation`" instead of a text diff.
6. **Promotion candidates.** A helper that appears in two or more verticals' high-similarity slots, plus an existing platform near-match (`mapPostgresError`, `PostgresFailure`), is a concrete "lift to platform or shared" proposal. A generic index has no notion of altitude to make that call.
