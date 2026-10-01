# v3 Pillar 2: the Concept Wire

*Adjustment B2, approved. Built on PLAN v2 ("Single Home"). All facts are from the stack-head tree `b158f5a`. `T/` = `template/base/`, `S/` = `template/stack/`, `D/` = `template/demo/`.*

## What the pillar is

Single Home's exact rule catches 6 of the 15 second homes in the dogfood. The other 9 are mostly *re-spelled meaning*: one concept stated in two places along the stack's own wire, which no clone detector can match. This pillar adds deterministic checks for each hop of that wire. Each check joins two facts the tree already states. Every hop below is joined today only by name (`w1-stack-anatomy.md` §2, "Hops joined only by name"):

| Hop | Check |
|---|---|
| SQL column ↔ query projection, payload and filters | `wire-orphan` |
| SQL CHECK and nullability ↔ the DTO field a row seam borrows | `wire-bound` |
| DTO field ↔ the same field restated in another DTO | `wire-restate` |
| Reviewed export projection ↔ the code that reads it | `export-mirror` |
| tRPC procedure ↔ its Server Action twin | `twin-drift` |
| Procedure input schema ↔ client-side validation | `validation-parity` |
| Action ↔ screen (`PARITY.md`) | `parity-truth` |
| Screen ↔ i18n key, across surfaces | `i18n-key-parity` |
| Screen ↔ testID ↔ Maestro journey or e2e spec | `testid-orphan` |

**Rules for the pillar:**
- **Owed** means a gate-proposal plus `rampNote(gate, R, detail, {until})`, where R is the release that ships the leg. Fresh installs and the template tree are strict. Older installs are ramped. A leg is owed only where its precision holds by construction.
- **Advisory** means a closed `noteAdvisory` record (PLAN §5). It reaches the reviewer packet (adjustment B1) and, once its family is measured, an issue.
- No leg reads a cache. Every leg runs cold in the same gate process locally and in CI.

## 0. Summary, ordered by value per cost

| # | Check | Home step (`T/tools/harness.config.mjs`) | Tier | Cost | Live hits: B01 (no demo) / with demo | Dogfood |
|---|---|---|---|---|---|---|
| 1 | `wire-orphan` | `query-shapes` (:109) | owed | XS | 0 (empty-legal) / 0 | preventive |
| 2 | `validation-parity` | `parity` (:119) | owed; `respelled-guard` advisory | S | 0 / 1 owed + 1 advisory | #15 |
| 3 | `parity-truth` | `parity` | owed (stale `—`); `cell-unreached` advisory | S | 0 / 2 owed | #20 |
| 4 | `twin-drift` | `parity` | `twin-schema` owed; `twin-args` advisory | S | 0 / 1 advisory | #13 |
| 5 | `wire-bound` | `contracts` (:101) | owed; `wire-rename` advisory | M | 1 pair judged / 3 pairs judged (all green) | #17 |
| 6 | `export-mirror` | `contracts` | owed | S | 2 reads judged / 3 (all green) | preventive (privacy) |
| 7 | `i18n-key-parity` | `i18n` (:206, Stop) | advisory | S | ~2 / ~4 | #19, plus 2 stack instances |
| 8 | `testid-orphan` | `route-manifest` (:144) | owed | XS | 0 (all 12 Maestro + 7 e2e ids resolve) | preventive |
| 9 | `wire-restate` | `contracts` | advisory | S | 0 / 5 | #18 |

**Cost key:** XS < 60 LOC, S 60–150, M 150–300, each excluding tests.

**Ordering.** Rows 2–4 share one build, the action map (§1), so the second and third of them are nearly free once the first exists.

## 1. Shared machinery

**`T/tools/lib/wire-map.mjs`** (new; owned and hash-pinned). It holds pure functions over TypeScript source files parsed with the R07 parser, `loadParser()` (`T/tools/lib/i18n-tree.mjs:98`). Each gate imports only the slice it needs. Per PLAN F-M1(4), every export ships with its `tools/*.mjs` consumer in the same PR.

| Function | What it returns |
|---|---|
| `actionMap()` | For each action: its procedure file and line, the input schema `S` from `.input(S)`, and the vertical function `F` its handler calls. Mount keys come from `packages/api/src/index.ts` (`D/…/index.ts:30`, `notes: notesRouter`). They are cross-checked against `tools/generated/action-inventory.json`, which `contracts` proves fresh before `parity` runs (`T/tools/check-mobile-parity.mjs` header). `F` is defined only when the handler calls exactly one function imported from a `packages/verticals/*` barrel, as the router law requires (`D/packages/api/src/routers/notes.ts:19-23`) |
| `serverActions()` | The `export async function *Action` census, which is the same grammar `check-rate-limits.mjs:423` already uses. For each action: its `.inputSchema(S′)` and the vertical functions it calls |
| `surfaceCalls(surface)` | Per file: tRPC calls `<x>.<ns>.<act>.(query\|mutate\|useQuery\|useMutation)(`, calls to Server Actions and read seams, and app-local value-import edges. Roots are `WEB_ROUTES` (`D/apps/web/lib/routes.generated.ts:14-30`) and mobile `ROUTES` (`D/apps/mobile/src/routes.ts:46`). It excludes `__tests__`, `*.test.*`, `src/testing/`, `e2e/` and all `packages/*` (so the design-system mirror can never connect two screens) |
| `rowBindings()` | Every `z.object` literal (optionally wrapped in `z.array`) under `packages/contracts/src` or `packages/verticals/*/src/data` whose keys are all snake_case. It is bound to the unique `(table, column set)` whose set equals its key set. Candidate sets come from `query-shapes.json` `columns` and from `data-flow.json` `export.projection`. An ambiguous match is a NOTE |
| `zodChain(expr)` | A closed grammar: `z.string()`, `.min`, `.max`, `.length`, `.optional`, `.nullable`, `.nullish`, `.default`, `.refine`, `.superRefine`. Bounds resolve through `export const NAME = <number>` (numeric separators allowed). Alias consts (`ListNotesSchema = NotesListQuery`, `D/…/schemas.ts:46`) resolve to their target |

**Parser absence.** The rule is PLAN §2.2's: the parser legs fail closed as partial legs (a NOTE locally, a FAIL in CI), and every parser-free leg still judges. The precedent is `T/tools/check-i18n.mjs:213-216`.

**Escape register.** `T/tools/wire-allow.json` is one write-guarded register for the whole pillar.
- Rows are `{check, subjects[], field?, reason ≥ 20 chars}`. They are members-bound, as PLAN §2.5 requires.
- The file is seeded empty and listed in `SEEDED_FILES`, `WRITE_PROTECTED`, `ESCAPE_LISTS` and `PROPOSABLE`, the same places `duplication-allow.json` is (PLAN §2.1).
- A stale row produces an advisory, never a red.

**Printers.** Records use `closed-text.mjs` with three printers added:
- action: `ACTION_RE` (`T/tools/check-mobile-parity.mjs:34`);
- i18n key: `^[A-Za-z0-9_.-]{1,80}$` (camelCase keys exist, for example `auth.signIn`);
- testID: `^[a-z0-9][a-z0-9-]{0,63}$`.

Several subjects are App Router paths, so this pillar **depends on resolving N4**. The recommendation is to widen `PATH_RE` (`T/tools/lib/harness-brief.mjs:52`) to admit `()[]`, still rejecting `..`, and to print paths only inside code spans.

**Stamps and cost.**
- `contracts` gains `supabase/migrations` and `tools/data-flow.json` as stamp inputs (`T/tools/lib/stamp-inputs.mjs:85-104`).
- `parity` has no stamp today. It gains a `STAMP_INPUTS` row covering the routers, `apps/web/app`, `apps/web/lib`, `apps/mobile/{app,src}`, `PARITY.md` and the inventory.
- New parser loads: two (`contracts` and `parity`), at about 0.1–0.23 s each (PLAN §10), plus a subset parse. The total is about +0.5–1 s cold in CI and nothing on a local stamp hit.

## 2. The checks

### 1. `wire-orphan`: a query column with no SQL column

**Recipe.**
1. In `check-query-shapes.mjs`, after `parseFunctions` (`:201-204`), add `parseColumnFacts(statements)` (`T/tools/lib/sql-parse.mjs:978`).
2. Add rule 11. For each non-rpc manifest row, every bare identifier in `columns` (split on commas), `payload`, `eq`, `is`, `orColumns`, `order[].column`, `range[].column` and `onConflict` must be a key of `facts.get(table)`.
3. Tokens that are not `^[a-z_][a-z0-9_]*$` (an alias `a:b`, a cast `::`, an embed `rel(…)`) are counted as unjudged. So is a table no migration creates, such as a view.

**Same PR.** Fold `ALTER TABLE … RENAME COLUMN a TO b` into `applyAlterAction` (`sql-parse.mjs:899`). It has no RENAME arm today, so a renamed column would read as an orphan. The fix also corrects `data-flow`'s `has()`.

**Reads:** `query-shapes.json` (schema `T/tools/lib/query-shapes.mjs:42-60`) and the folded migration history. **Granularity:** (row id, column).

**Tier: owed.** PostgREST rejects an unknown column at runtime. Today only the integration lanes catch this, and `columns` and `payload` are judged nowhere (`check-query-shapes.mjs:327` onward judges index service only).

**B01.** `emptyState()` returns green before any rule runs (`:101-123`).

**False positives.** Covered by the PostgREST-grammar and view exclusions above. There are no parallels to respect.

**Canary.** A fixture manifest row with column `titel` reds. A rename-column migration plus the renamed projection stays green.

**Catches.** No live finding; it is preventive at hop 6 ("not checked statically", `w1-stack-anatomy.md` §2).

### 2. `validation-parity`: client validation ≠ the server's schema

**Recipe.**
1. In every client function body (`surfaceCalls`), find a value that flows from `X.safeParse(e)` or `X.parse(e)` (`v.data`, `v`, or inline) into a tRPC call for action `a`, or into a Server Action `s`.
2. Let `S` be `a`'s `.input(S)`, or `s`'s `.inputSchema(S)`.
3. Red when `subject(X) ≠ subject(S)` after alias resolution.
4. Print the difference:
   - if `S` is defined as `X.refine(…)`, print "client skips N refinement(s)";
   - if the reverse holds, print "client is stricter";
   - otherwise print "unrelated".

**The move.** Parse with `S`. When the surface may import it, say so: for example, `@app/notes/client` is census-sanctioned (`S/tools/exports-walls.json:17`).

**Advisory half, `respelled-guard`.** It fires when all of the following hold:
- a client module sends field `f` (for example `{ title }`) to `a` or `s`;
- the server schema's refinement calls a predicate `P` that the vertical's `./client` barrel exports (`isRenderableTitle`, `D/packages/verticals/notes/src/client.ts:46`);
- the module gates on an expression over `f` (`disabled={E}`, or an early `if (E) return`) that calls neither `P` nor `S`.

**Reads:** routers, actions, both client trees, the vertical barrels. **Granularity:** (client call site, action).

**Tier.** The direct parse-then-send form is **owed**: the client admits input the server refuses, by construction. A legitimate exception, such as an async server-only refinement, takes a `wire-allow` row. `respelled-guard` is **advisory**, because it is pattern-matched and its precision is unmeasured.

**B01.** No stack client parses before a call, so it reports "0 bindings".

**Parallels.** Web and mobile are expected to share `S`. That is the invariant `D/apps/web/app/actions/notes.ts:13-19` states.

**Canary.** Mobile `NewNoteInput.safeParse` → `api.notes.create.mutate(p.data)` reds. Parsing `CreateNoteSchema` instead is green.

**Catches #15**, the mobile half, an owed red:
- `D/apps/mobile/src/features/notes/useCreateNote.ts:139` parses `NewNoteInput`, and `:156` sends the result;
- the server validates `CreateNoteSchema = NewNoteInput.refine(…)` (`D/packages/verticals/notes/src/schemas.ts:29-32`; router `:58`);
- the comment at `:135-137` ("the SAME schema") is false.

**Catches #15**, the web half, as an advisory: `D/apps/web/app/(protected)/o/[orgSlug]/notes/note-composer.tsx:61` gates on `title.trim() === ''`.

### 3. `parity-truth`: the PARITY cell ↔ the actual call site

**Recipe.**
1. Reuse the parity row parser (`check-mobile-parity.mjs:123`).
2. **Backward (owed).** For a `—` cell on surface X, red if any file under X's routes reaches the action. "Reaches" means a direct tRPC call to `ns.act`, or a call (directly, or through an app-local Server Action or `lib/app-data/*` read seam) to `F(action)`.
3. **Forward (`cell-unreached`, advisory).** A cell's file P is reached if P's app-local value-import closure (depth 3), or the closure of a module that value-imports P, contains such a call. The upward hop is needed because the composer is rendered by its caller.

**Reads:** `PARITY.md`, the inventory, the action map, `surfaceCalls`. **Granularity:** (action, surface).

**Tier.** Backward is **owed**: a `—` cell next to a live call is unambiguous rot, the same class as the existing stale-row red. Forward is **advisory**, because the one-hop-up rule is unmeasured. If `F` is shared by more than one action, the cell is unjudged and gets a NOTE.

**B01.**
- Forward: base `PARITY.md` has two mobile cells, `ConnectionStatus.tsx` → `api.system.health` (`S/…/ConnectionStatus.tsx:84`) and `app/(tabs)/index.tsx` → `api.system.me` (`:72`). Both are reached.
- Backward: the system procedures have no vertical `F`, so it is silent.

**Parallels.** Web surfaces an action through its twin (a Server Action or RSC read seam calling the same `F`). Mapping through `F` is how the pillar *uses* the twin rather than flagging it. The ledger's own text agrees (`D/PARITY.md:29`: "the app-data read exists").

**Canary.** A web `—` cell for an action the web page calls reds.

**Catches #20**, two owed reds:
- `notes.create` web `—` (`D/PARITY.md:27`) while `note-composer.tsx:8,29` → `createNoteAction` → `createNote`;
- `notes.list` web `—` (`:29`) while `page.tsx:3` → `lib/app-data/notes.ts:69` → `listNotes`.

Forward is green on all cells. The mobile `NoteComposer.tsx` reaches the call through `NotesPanel.tsx:15-16`, because its own import of `useCreateNote` is type-only (`:8`).

### 4. `twin-drift`: a procedure and its Server Action diverge into the same `F`

**Recipe.** Pair procedure `a` with Server Action `s` when both call the same `F`.
- **`twin-schema` (owed).** `subject(S_a) ≡ subject(S′_s)`. A twin with no `.inputSchema` and no `S.parse` before `F` reds as unvalidated.
- **`twin-args` (advisory).** Compare `F`'s argument vectors position by position.
  - An object-literal argument, or a call to a file-local builder that returns one (inlined one level, with parameter substitution), is compared property by property.
  - Each value gets a class: `derived` (a member chain rooted at any binding), `ambient:{clock|random|env}` (closed list: `new Date`, `Date.now`, `Math.random`, `crypto.*`, `process.env.*`, `performance.now`), `fn-literal`, `literal` or `call:<callee>`.
  - Report differing key sets and class mismatches.

**Reads:** the action map and `serverActions()`. **Granularity:** (F, a, s), listing the differing properties.

**Tier.** Schema identity is **owed**: the twin's documented contract is "the same zod contract" (`actions/notes.ts:13-19`). Argument classes are **advisory**, because a deliberate difference is possible.

**B01.** No stack Server Action shares an `F` with a procedure, so it reports "0 twins".

**Parallels.**
- The twin pair itself is the anchor.
- The transport-only parts (bind args, rate limit, `revalidatePath`, the fold) never enter `F`'s arguments, so they are never compared.
- The port argument (`gate.data.client` cast vs `ctx.db`) is `derived` on both sides.

**Canary.** `.inputSchema(NewNoteInput)` in the action reds. Today's tree must emit exactly the two `twin-args` properties below.

**Catches #13** as one advisory record:
- `now`: `derived` (`ctx.now`, `D/packages/api/src/routers/notes.ts:48`) vs `ambient:clock` (`new Date()`, `actions/notes.ts:79`);
- `emit`: `derived` vs `fn-literal` (`:78`);
- the context is built by `writeContext` (`:44-51`) on one side and inline (`:76-81`) on the other.

`twin-schema` is green: both sides use `CreateNoteSchema` (`:38` and `:58`).

### 5. `wire-bound`: `*_MAX` and nullability ↔ SQL CHECK and NOT NULL

**Recipe.**
1. Add `parseCheckBounds(statements)` to `sql-parse.mjs`. Today `TABLE_LEVEL_ENTRY` recognises a CHECK (`:814-815`), but `applyTableLevelEntry` (`:877`) drops it. The closed grammar is `char_length|length(col)` with `BETWEEN a AND b`, `<= b`, `< b`, `>= a` or `> a`, at column or table level. It folds `ADD CONSTRAINT` and `DROP CONSTRAINT` by name.
2. For each `rowBindings()` key `k` bound to `(T, k)`, resolve its value (`X.shape.f`, or an inline chain) through `zodChain`.
3. Red if the DTO's `max` ≠ the CHECK's upper bound, or its `min` (default 0) ≠ the CHECK's lower bound (default 0).
4. Red if the column is nullable (`parseColumnFacts`) and the DTO field is not.
5. Sub-rule `wire-rename` (advisory): `f ≠ camel(k)`, which is rubric (d).

**Reads:** migrations, `query-shapes.json`, `data-flow.json`, the row seams, contracts. **Granularity:** (table, column).

**Tier: owed.** A row seam parses database rows. A DTO narrower than the CHECK fails on real data, and a wider one gets a 23514 at write time. The nullability half is a bug this tree already shipped once: `D/packages/contracts/src/index.ts:263-277` records that a non-null `ownerId` over a nullable column blanked an org's notes list, and only the integration lane found it.

**Only row-bound fields are judged.** An input DTO narrower than the CHECK is legal, because the CHECK states "bounds, not validation" (`D/supabase/schemas/20_notes.sql:36-37`).

**B01 is live.**
- Binding: `ProfileExportRows` (`S/packages/contracts/src/index.ts:324`) ↔ `profiles` projection (`T/tools/data-flow.json:45`).
- Judged: `display_name` (`max(DISPLAY_NAME_MAX)` `:294` ↔ `<= 120`, NOT NULL, `S/supabase/schemas/10_account.sql:21,28`) is green.
- `memberships.role_rank IN (…)` is outside the grammar and counted as unjudged.

**With the demo,** three further columns are judged, all green:
- `notes.title`: `min(1).max(NOTE_TITLE_MAX)` (`:26`, `:279`) ↔ `BETWEEN 1 AND 200` (`20_notes.sql:38`);
- `notes.body`;
- `owner_id` and `archived_at` nullability.

**Coverage limit, stated.** `orgs.name` ↔ `ORG_NAME_MAX` has no row seam, so it is unbound. The `ok()` line lists the unbound CHECKs.

**False positives.**
- A binding is ambiguous when two candidate sets are equal → NOTE.
- A bound that is not a constant → unjudged.
- `char_length` counts code points while zod counts UTF-16 units. The leg compares stated bounds, not runtime semantics.

**Canary.**
- `NOTE_TITLE_MAX = 201` reds.
- B01: `DISPLAY_NAME_MAX = 121` reds.
- Removing `.nullable()` from `ownerId` reds.

**Catches #17.** It turns the CHECK restatement into a *linked* second home: both are needed, and a drift on either side reds.

### 6. `export-mirror`: the reviewed projection ↔ the code that reads it

**Recipe.**
1. Start from `data-flow.json` `export.surface.procedure`.
2. Follow app-local value imports. Example: `D/packages/api/src/routers/system.ts:4` → `export.ts`.
3. In those files, collect `.from(T).select(C)` chains where T and C resolve to file-local string consts. Example: `S/packages/api/src/export.ts:44-49`, `:99`, `:126-127`.
4. For each vertical function imported from a barrel (for example `listAuthoredNotes`), take its `query-shapes.json` select rows. Example: `#page` columns, which come from `NOTE_EXPORT_COLUMNS`, `D/…/data/notes.ts:316`.
5. For a table in `export.projection`, red when `set(cols) ≠ set(projection.columns)`.
6. A projected table with no read found is advisory, since an RPC or a view is possible.

**Reads:** `data-flow.json`, the api sources, `query-shapes.json`. **Granularity:** (table, read site).

**Home: `contracts`, not `data-flow`.** `contracts` already loads the parser for #5 and #9, and is stamped. The message names `data-flow.json`.

**Tier: owed.** An over-projection is the privacy defect the register exists to prevent (`D/tools/data-flow.json` export comment). Precision holds by construction once the sites resolve.

**B01 is live.** `PROFILE_COLUMNS` and `MEMBERSHIP_COLUMNS` are judged against `T/tools/data-flow.json:45` and are green. The demo adds `notes`, also green.

**Parallels.** The list projection `NOTE_COLUMNS` is a different read, deliberately (`rows.ts:84-95`). Only reads reached from the export surface are compared.

**Canary.** Adding `owner_id` to `NOTE_EXPORT_COLUMNS` reds. On B01, adding a column to `PROFILE_COLUMNS` reds.

**Catches.** Nothing live. It links the projection the tests restate by hand (`rows.test.ts:154`, `S/…/system.export.test.ts:221-231`).

### 7. `i18n-key-parity`: one affordance, two key names

**Recipe.**
1. During `check-i18n`'s existing walk of both surfaces (`SURFACES`, `check-i18n.mjs:106`), record anchors: JSX elements whose `testID` or `data-testid` is a string literal.
2. For each anchor, collect K: the keys of `t('<lit>')` in the element's attributes, plus the user-facing attributes (the check-1 set, `:17-19`) of its nearest ancestor that carries one, at most 3 levels up.
3. Join anchors across surfaces by testID.
4. Record when both K are non-empty and disjoint.

**Reads:** both app trees, through the walk `check-i18n` already pays for. **Granularity:** testID.

**Tier: advisory.** Key naming is maintainability, not correctness.

**B01.** It is live, with 8 shared testIDs. A grep approximation, which the parser leg replaces, gives:
- **disjoint:** `sign-in-submit` (web `auth.signIn`, `S/apps/web/app/sign-in/sign-in-form.tsx:102`; mobile `signin.submit` / `signin.pending`, `S/apps/mobile/app/sign-in.tsx:163-168`) and `sign-up-submit`;
- **agree:** `security-enrol`, `mfa-challenge-verify` and `mfa-enrol-verify`.

**Fresh installs.** These would be two harness-shipped advisories on every new install. They are renamed in PR 7a before the family is turned on.

**False positives and parallels.**
- Deliberate surface namespaces (`web.*` / `mobile.*`) would make the family noise. PLAN §11E's retirement rule handles that: more than 30% `not_planned`.
- The catalogs' mirror row covers file *shape*. This leg compares key names per anchor and never compares catalog contents.
- Dynamic testIDs are skipped.

**Canary.** Renaming one mobile key to match the web key removes the record.

**Catches #19:**
- `note-composer-submit`: `notes.add` vs `notes.composer.submit` / `notes.composer.pending`;
- `note-composer-input`: `notes.new` vs `notes.composer.label` / `notes.composer.placeholder` (`D/…/note-composer.tsx:49-62`; `D/apps/mobile/src/i18n/catalog.ts:50-54`).

### 8. `testid-orphan`: a journey or spec references a testID nothing renders

**Recipe.**
1. Collect references:
   - mobile: `id: "<x>"` in `maestro/{journeys,flows}/*.yaml` (generated sweep flows excluded);
   - web: `getByTestId('<x>')` in `apps/web/e2e/**/*.spec.ts`.
2. Collect definitions on that surface:
   - literal `testID` or `data-testid` values;
   - `ROUTES` and `page.meta` state ids;
   - the generated `<id>-screen` convention (`T/tools/lib/maestro-flows.mjs:10-12`);
   - template literals, matched on their static prefix or suffix (the dynamic-key rule `check-i18n.mjs:32-34` already uses).
3. Every reference must resolve.

**Reads:** YAML, specs and sources, as text. **Granularity:** (reference file, id).

**Home.** `route-manifest`: the mobile half in `check-route-manifest.mjs`, the web half in `check-web-routes.mjs`, which already proves that state ids are rendered (`:176`).

**Tier: owed.** An unresolved reference is a guaranteed failure in the slow device or e2e lane. This moves that failure to Stop.

**B01.** It is live. Measured: every journey and flow id and all 7 e2e ids resolve.

**False positive, measured.** `sign-in-error` resolves only through the template `${idPrefix}-error` (`S/apps/web/app/sign-in/credential-fields.tsx:57`). Without the template rule it would be a false red.

**Canary.** Renaming `note-row` in `D/…/NotesPanel.tsx:75` reds `D/maestro/journeys/mutation.yaml:69-77`.

**Catches.** Nothing live (hop 17); it is preventive.

### 9. `wire-restate`: a DTO field restates the row-bound field

**Recipe.**
1. In `packages/contracts/src`, find each inline `zodChain` that references a named bound constant.
2. Normalise it by stripping trailing `.optional()`, `.nullable()` and `.default(…)`.
3. Its home H is the row-bound field (from #5) with the same name and an identical normalised chain.
4. Record "restates H; borrow `H.shape.f`". A field whose chain merely *differs* is not reported.

**Reads:** contracts plus the #5 bindings. **Granularity:** (H, restating field).

**Tier: advisory.** Restating an input DTO may be a deliberate input/persistence separation. Eval B labels each hit.

**B01: 0 hits.** `ActorView.displayName` (`min(1)`, `:394` in the demo copy) differs from `ProfileExport`. Its value is session-derived (`S/apps/web/lib/auth/session.ts:121`), which is exactly why variants are not reported.

**Demo: 5 hits.** `NoteView.title` (`:295`), `NewNoteInput.title` and `.body`, and `NoteUpdateInput.title` and `.body`.

**Canary.** Borrowing `NoteRecord.shape.title` in `NoteView` removes that record.

**Catches #18.**

## 3. Delivery, evals, rollout

**Delivery.**
- Owed legs red their home step at Stop, through `validate`. They are not delivered at write time: the PLAN's eval D arms cover duplication only, and a write-time wire arm would need its own arm.
- Advisory records reach the reviewer **pull packet** as families: `respelled-guard`, `cell-unreached`, `twin-args`, `wire-rename`, `i18n-key-parity`, `wire-restate`. Each carries a `confirm|dismiss <key>` line.
- The packet also gets one neutral **`wire-touch`** fact per edited hop. It lists the linked hops of the edited concept from the wire map. For example, an edit to `NOTE_TITLE_MAX` lists the CHECK at `20_notes.sql:38`, row key `rows.ts:40`, and the restating fields. This answers "what does this code touch" without loading the codebase.
- Eval C sets each family's inclusion and rank.
- Issues follow PLAN §5. Each home gate joins the converted-gates ratchet when its family reaches advisory precision ≥ 0.8 on eval B.

**Evals (B4 ladder).** Owed wire legs are deterministic, so evals A and B gate them, as they do the exact rule:
- Eval A: a planted-mutation corpus per leg (the canaries above, plus a mutation on each side of every live binding). Bar: 0 false owed hits on the blind third vertical and in the "scaffold a second vertical" scenario.
- Eval B (frozen pre-dogfood fixture): owed precision 1.0. The expected owed hits are exactly 3, all true: #15 once and #20 twice. Advisory families are labelled.

No C or D run is needed for an owed leg.

**Rollout.**

| PR | Contents |
|---|---|
| W1 | `wire-orphan`, the RENAME fold and `testid-orphan`. Parser-free, so it can follow PLAN PR 3 |
| W2 | `wire-map.mjs`, then the `parity` trio |
| W3 | The `contracts` trio, with `parseCheckBounds` |
| W4 | `i18n-key-parity` |

The template tree is strict, so **PR 7a must land first** with these fixes:
- mobile parses `CreateNoteSchema`;
- the `PARITY.md` notes rows are corrected;
- one write-context builder;
- `NoteView` borrows its title;
- the sign-in, sign-up and composer keys are aligned.

## 4. Considered, not adopted

| Candidate | Why not |
|---|---|
| Route-id parity (`notes` vs `home`) | The mobile nesting is by design |
| Event-field ↔ patch-key parity (`events.ts:29`) | Low value |
| `wire-unbound` as a finding | It is informational only, printed in the `ok()` line |
| Push-style wire context for authors | Contrary to PLAN §3 |

## 5. Coverage after the pillar

Of the 15 second homes:
- the exact rule catches 6;
- the advisory tier catches 2 (#7, #10);
- this pillar adds #13, #15, #17, #18 and #19, which is 5 of the 7 that were left over;
- only #14 (Scaffold v2) and #16 (an ADR) remain unsignalled.

The pillar also reds the stale register #20. It gate-links the restated CHECK bounds (`notes.title`, `notes.body`, `profiles.display_name`) and the three export projections, which until now were joined only by prose or hand-copied test literals.
