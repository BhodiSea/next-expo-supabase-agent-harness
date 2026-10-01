# Single Home v2: one fact per duplicate, judged on the whole tree

*Status: proposal, not a commitment. v2, as produced by the 2026-10-01 design round; a v3 revision is in progress. No row in `scripts/obligations.json` tracks it, and nothing here starts until the 2.0.0 stack merges. The research and the four competing designs it was synthesised from are in [`design/research/20261001-context-paradigm/`](research/20261001-context-paradigm/README.md).*

*Final plan for discussion with the maintainer. It targets the post-stack tree (`stack/52-i37-work-plan`, 2.0.0, head `b158f5a`). Nothing here starts until that stack merges.*

*Path prefixes: `T/` = `template/base/`, `S/` = `template/stack/`, `D/` = `template/demo/`, `P/` = `template/modules/push-notifications/docs/modules/push-notifications/slice/`.*

*"Prototype" means an inline Node 22.22 script, run against the stack-head tree with the factory's `typescript@6.0.3` and committed nowhere. It implements the §2.2 normaliser over the existing `duplication` scan roots, with tests, generated files and `.d.ts` excluded. Its TS figures are measurements; I checked the SQL figures by reading the three migration pairs.*

---

## Executive summary

1. **What Single Home is.** It is a deterministic, whole-tree index of every TypeScript function and SQL function, unaffected by renaming. The index groups the functions into *clone classes*. Each class carries one computed legal *home* and one *move*. The same class record serves as the write-time pointer, the Stop red, the reviewer's count, the nightly issue and the `--explain` output. No agent ever loads the codebase. Instead, the agent is told in at most three lines which class its edit just joined, and where that code's single home is.

2. **The thesis is now a hypothesis.** It says that most slop which passes the 37 validate steps of the 2.0.0 stack head is a second home for a fact that has, or should have, one. The dogfood inventory below verifies 22 findings. Of these, 15 are second homes. The blocking rule catches 6, the advisory tier catches 2, and 7 need a reviewer, a gate-proposal or a hand fix. The plan measures that remainder rather than assuming it away.

3. **There is one blocking rule.** An *exact class* is a body that is identical after locals are renamed and literals normalised. One that has at least 30 normalised tokens, a legal home and no reviewed row reds the existing `duplication` Stop step. Everything else is advisory. v1's name clause, slot rules, twins constant, pre-shipped homes, L2 context signals and drift rules are all deleted.

4. **It is judged on the whole tree, as L0 already is.** There is no merge base, no move exclusion and no "legacy" status. The verdict is a pure function of the tree plus one register, so it is the same locally, on PRs, on direct pushes and nightly. Stop and CI parse cold every time and never read a cache. Measured: 0.48 s for the default install including the TypeScript load, and about 2 s at 278k LOC (the feasibility critic's measurement).

5. **Measured on the template.** At the 30-token floor the default install holds exactly two TS classes, and both are real duplicates: `publicCredentials` / `serverPublicCredentials`, and a hand-rolled store copied between two mobile modules. It also holds three SQL pairs. `asRowArray` (24 tokens) and the deliberate `invalidCursor` mirror (28 tokens) fall below the floor and become advisories.

6. **Exemptions are bound to members.** A reviewed row names every member of the class it accepts, so a third copy or a swap reds. When an accepted class drifts, the result is an advisory ("accepted class diverged", the Juergens signal), never a red that blocks the turn on bookkeeping. Two *mirror* rows replace nine of today's ten L0 rows. Source markers are gone.

7. **Moves never silently change behaviour.**
   - IMPORT and LIFT are printed only for exact classes. Where the members' literals differ, the move reads "LIFT with N literal parameters".
   - Near-misses get closed "differs at" facts and the verbs WRAP or JUSTIFY.
   - `mapPostgresError` becomes reachable where it already lives, through a pure `@app/supabase/errors` subpath and a narrowed law. Notes then wraps it, with its conflict semantics pinned by tests.
   - No empty home is shipped ahead of need.

8. **Dogfood comes before the rule goes live.** Agents copy whatever they find, so the template's own second homes are fixed first: the two TS classes, the SQL pairs, the write context built twice, the port cast in three places, "renderable title" spelled three ways, the unreachable mapper, the push module's codec and missing port, and the stale scaffold.

9. **Delivery happens at both moments, each gated by evidence.**
   - *Write time.* Only owed classes are delivered, including ramp-withheld ones, in at most 3 lines. This waits until eval D shows the pointer is no worse than Stop alone.
   - *Review time.* A SubagentStart brief carrying the change list ships live; reviewers have no Bash today, so this fixes a real gap. The similarity and "touches" facts ship dark until eval C shows they do not displace other findings.

10. **Advisories become GitHub issues, but not literally all of them.** My recommendation is every class-A advisory that CI can recompute, added one gate at a time.
    - v1 files only the duplication sweep and red scheduled lanes.
    - Issues are built from closed records that carry no free text.
    - The sync is an `advisory-issues` module with split privileges, on by default for new installs.
    - Without an agent loop, issues are a ledger. Their fix rate is measured as a falsifier.

11. **Embeddings stay optional and off the verdict path.**
    - They run nightly only and produce advisory issues only.
    - Candidates come from deterministic buckets and need at least two corroborators.
    - There is one adapter, and jobs are split with egress blocked.
    - They must beat a signature-plus-name-token index and agent-grep.
    - The owed set is byte-identical with the layer on or off.

12. **Evidence comes before go-live.**
    - Probes (a)–(d) are automated, and probe (d) blocks the headless evals.
    - Eval A: the detector, with a 30% holdout and thresholds frozen first.
    - Eval B: precision over all hits.
    - Eval C: reviewer displacement, push vs pull, powered.
    - Eval D: generation, three arms, an independent oracle, 60 chain-runs per arm.
    - Eval L: Lift completion within the block cap.
    - Fresh installs get the blocking tier only after D and L pass. Tiers change only as factory release decisions.

---

## Dogfood findings

**Method.** Each row was checked by reading the cited lines in the stack-head tree. The "exact" rows also come from the prototype. "Second home" means one fact is stated or implemented in two or more places.

| # | Finding | Where | Second home? | Paradigm signal (v2 tier) | Caught by today's gates? |
|---|---|---|---|---|---|
| 1 | `publicCredentials` and `serverPublicCredentials` have identical bodies | `S/packages/platform/supabase/src/public-env.ts:40`; `S/packages/platform/supabase/src/server-env.ts:28` | yes | exact class, 33 tokens → **owed**; move IMPORT (same package) | No (L0 needs 70 tokens) |
| 2 | A hand-rolled external store (listener set, `emit`, `subscribe`) is copied | `S/apps/mobile/src/i18n/index.ts:135-139,307`; `S/apps/mobile/src/theme/theme.ts:51-55,103` | yes | `subscribe` exact, 33 tokens → **owed**; move MODULE (one helper in `apps/mobile/src/lib`). `emit` (16 tokens) falls below every band | No |
| 3 | `deny_mutation` ×2 | `S/supabase/migrations/20260202000000_audit.sql:196`; `S/supabase/migrations/20260816000000_auth_event_trail.sql:132` | yes | exact SQL class (only the literals differ) → **owed**; move MODULE with 2 literal parameters (the message and the HINT, both naming the schema), or `TG_TABLE_SCHEMA` | No (`duplication` scans `.ts`/`.tsx` only; `tenancy.json` names only `audit.deny_mutation`) |
| 4 | `ensure_partitions` ×2 | `…_audit.sql:388`; `…_auth_event_trail.sql:246` | yes | exact SQL class → **owed** (literal parameters) | No |
| 5 | `drop_partitions_older_than` ×2 | `…_audit.sql:442`; `…_auth_event_trail.sql:283` | yes | exact SQL class → **owed** (literal parameters) | No |
| 6 | Push cursor-codec helpers (once the module is applied) | `P/packages/verticals/push/src/domain/cursor.ts.txt:38,61,99`; `D/packages/verticals/notes/src/domain/cursor.ts:40,65,115` | yes | 3 exact classes (168, 106 and 58 tokens) → **owed**; move LIFT (the helpers are pure; only the schemas import `@app/contracts`) | Yes, as one region. L0 reports a single 479-token clone (notes `cursor.ts:1-129` ↔ push `cursor.ts:1-112`) that spans all three helpers, `isRealTimestamp` included, and `…/push-notifications/APPLY.md:234-257` tells the consumer to allow-row its one fingerprint |
| 7 | `asRowArray` ×2 | `D/packages/verticals/notes/src/data/rows.ts:80-82`; `P/packages/verticals/push/src/data/push-tokens.ts.txt:121` | yes | literal-exact, 24 tokens → **advisory** (exact-small) | No (it is also in a `.txt` file nothing scans) |
| 8 | The `invalidCursor` mirror, documented as deliberate | `D/packages/api/src/export.ts:115-122` ("Mirrors the notes vertical's rejected-cursor answer"); `D/packages/verticals/notes/src/data/errors.ts:130` | deliberate | literal-exact, 28 tokens → **advisory**; eval A labels it a decoy | No |
| 9 | Web/native `useTheme` and `useFieldContext` | `S/packages/design-system/src/ThemeProvider.tsx:62` ↔ `…/design-system-native/src/ThemeProvider.tsx:80`; `field-context.ts:43` ↔ `:32` | deliberate mirror | covered by the mirror row → silent | L0 rows cover other regions of the mirror |
| 10 | Three error mappers, with different semantics | `D/packages/verticals/notes/src/data/errors.ts:69` (23505/23503/23514 → `conflict`, `:89-97`); `P/…/push-tokens.ts.txt:152`; `S/packages/platform/supabase/src/errors.ts:134` (FK → `validation` `:174`, CHECK → `validation` `:185`, quota `:150`) | yes (the SQLSTATE table is restated) | near-miss pair → **advisory** with "differs at". The home is unreachable because of `T/tools/lib/vertical-anatomy.mjs:243-253`; dogfood narrows the law and notes wraps the mapper | No (notes admits the duplication at `errors.ts:18-21`) |
| 11 | The platform doc points at a wrap that cannot exist | `S/packages/platform/supabase/src/errors.ts:121` ("A vertical may wrap this (see @app/notes)") | stale claim | none (architecture rubric f); fixed by #10 | No |
| 12 | The push DAL has no `port.ts` | `P/…/push-tokens.ts.txt:43-75` holds the port inline; `.from(` at `:215`, `:273`, `:314` | — | `port-presence` (`vertical-anatomy.mjs:255-269`) would red when the module is applied. v2 adds a factory test that materialises every module slice | No (the slice is `.txt`) |
| 13 | The write context is built twice, differently | `D/packages/api/src/routers/notes.ts:44-51` (its own comment at `:39-42` forbids "a spread at each call site"); `D/apps/web/app/actions/notes.ts:76-81` (`new Date()`, emit dropped) | yes | none (too dissimilar). Left to the reviewer; fixed by hand in the dogfood PR | No |
| 14 | `as unknown as NotesDatabase` ×3 | `D/apps/web/app/actions/notes.ts:71`; `D/apps/web/lib/app-data/notes.ts:60`; `D/apps/web/app/api/trpc/[trpc]/route.ts:152`. **The scaffold prescribes one per slice:** `T/.claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs:104` | yes | none (6 tokens); scaffold v2 generates one narrowing function per slice | No |
| 15 | "Renderable title" spelled three ways | `D/packages/verticals/notes/src/schemas.ts:29`; `D/apps/web/app/(protected)/o/[orgSlug]/notes/note-composer.tsx:61`; `D/apps/mobile/src/features/notes/useCreateNote.ts:139`. Mobile parses the *unrefined* `NewNoteInput`, while its comment at `:135-137` claims it is "the SAME schema". The domain says emptiness is decided "here, and nowhere else" (`domain/note.ts:36-37`) | yes | none (reviewer); fixed in dogfood (mobile parses `CreateNoteSchema`) | No |
| 16 | Two mobile primitive sets | `S/apps/mobile/src/components/{Button,Card,EmptyState,Field,Input,Skeleton,Spinner}.tsx` vs `S/packages/design-system-native/src/*`. Mobile has no dependency on the latter (`S/apps/mobile/package.json.tmpl:13-16`), and nothing imports it. `T/.claude/skills/authoring-vertical-slice/references/mobile-screen.md:88` and `:110` contradict each other | yes | not exact (the APIs differ); none in the v2 core. Candidate family: "parallel export-name sets" | No |
| 17 | `NOTE_TITLE_MAX` is restated by the SQL CHECK | `D/packages/contracts/src/index.ts:26`; `D/supabase/schemas/20_notes.sql:38` | yes | gate-proposal `wire-bound` against `contracts` | No (prose only) |
| 18 | NoteView restates the title field instead of borrowing it | `D/packages/contracts/src/index.ts:295` vs `:279` | yes | reviewer | No |
| 19 | The i18n keys for one affordance diverge | `D/apps/mobile/src/i18n/catalog.ts:50-54` vs `D/apps/web/lib/i18n/catalog.ts:150-151` | yes (one concept, two names) | none | No |
| 20 | `PARITY.md` says web has no notes screen | `D/PARITY.md:27-29` vs `D/apps/web/app/(protected)/o/[orgSlug]/notes/page.tsx` | stale register | none (`parity` checks only that the path exists) | No |
| 21 | The scaffold is stale | `scaffold-slice.mjs:108` writes `apps/web/app/<slice>/page.tsx`. It creates no `data/{port,rows,errors,query-probes}.ts`, `page.meta.ts` or `lib/app-data/<slice>.ts` | teaches drift | scaffold v2 (§2.7) | No |
| 22 | `packages/shared` is named everywhere and exists nowhere | `T/dependency-cruiser.cjs:24-41`; `T/tools/check-workspace-deps.mjs:16-18,142`; `T/pnpm-workspace.yaml:7`. `T/knip.json` has no entry for it (`:127` covers verticals only) | missing home | Lift script plus a knip glob (§2.6) | n/a |

**Coverage.** Of the 15 second homes:
- the blocking rule catches 6 (#1–6);
- the advisory tier catches 2 (#7, #10);
- 7 are left to a gate-proposal (#17), the dogfood PR (#13, #14, #15), a maintainer decision (#16) or the reviewer (#18, #19).

The two deliberate items (#8, #9) stay silent or advisory, as they should. This table is eval B's coverage target. It is also the plain answer to whether exact duplication is "most" of the slop: in this tree it is about 40% of the second homes, and the rest is re-spelled meaning.

---

## 1. Name and thesis

**Single Home** takes its name from the architecture reviewer's rule: "a diff that edits the same fact in three places names the missing single home" (`T/.claude/agents/architecture-reviewer.md:55-56`).

**Hypothesis H1.** A large share of the slop that survives the 37 validate steps (2.0.0 stack head) is a second home for one fact: a copied function, a re-spelled predicate, a restated bound, or a second builder of one context.

The evidence supports this framing without proving its size:
- 50.8% of agent task chains contained duplicated logic by turn 5 (RepoReuse).
- AI PRs carry about twice the semantic redundancy of human PRs.
- In 2024, copy/paste exceeded moved code for the first time.
- CodeThread's clearest downstream signal is divergent validation and error handling, which is itself a second-home problem.
- In this tree, 15 of the 22 verified findings are second homes (see Dogfood findings).

v2 treats the share as unknown. Evals B and D measure it.

**The paradigm in one paragraph.** Retrieval systems hand the agent context and hope it notices the duplicate. The evidence says agents ignore context they already hold (RepoReuse) and that pushed context can make reviewers worse (AACR-Bench, −31% F1 for a non-agent Claude reviewer). Single Home inverts this. The harness itself does the retrieval, over the whole tree, deterministically. It hands the agent the *conclusion*, which is a class with a legal move. A gate then checks the tree, so acting on the pointer cancels the debt. The agent never holds the codebase. It holds at most three lines about the class its last edit joined.

**What is new, against v1:**
1. **Classes, not pairs.** One duplicate fact is one record, one red, one pointer and one issue, keyed by its fingerprint.
2. **Whole-tree verdicts.** No base and no novelty test.
3. **Homes computed from the same rule files the gates enforce.** No closed constants.
4. **Dogfood before enforcement, and every component gated on a named eval.**

---

## 2. Architecture

### 2.1 Components

| Component | Location | What it does | Ships in |
|---|---|---|---|
| Extractor | `T/tools/lib/shapes.mjs` (owned, hash-pinned) | Parses TS with the project's `typescript` via `loadParser()` (`T/tools/lib/i18n-tree.mjs:98`). Reads SQL functions from `sql-parse.mjs` `parseFunctions`, folded last-wins. Emits per-callable records (§2.3) | base |
| Homes | `T/tools/lib/homes.mjs`; `T/tools/lib/workspace-tiers.mjs` | `home(class)` (§2.3). `tierOf` and the mobile wall (`MOBILE_UNIVERSAL`) move out of `check-workspace-deps.mjs:34-70` so the gate and the extractor share one copy. `.dependency-cruiser.cjs` is loaded in-process and its `forbidden` regexes are evaluated directly | base |
| Gate | `T/tools/check-duplication.mjs` | Keeps L0 unchanged. Adds the exact-class rule, the members-bound register and mirror rows. Modes: `--sweep --json` and `--explain <fp12>`. The verdict path is always cold | base |
| Recorder | `noteAdvisory()` / `noteComplete()` in `T/tools/lib/gate.mjs`; `T/tools/lib/closed-text.mjs` | Opt-in, closed-schema advisory records (§5). `closed-text.mjs` takes `NAME_RE`/`PATH_RE` out of `harness-brief.mjs:51-68`, where they are private | base |
| NOTE survival | `T/.claude/hooks/stop-validate-gate.mjs` | Collects `NOTE —` lines from green steps. On green the **user** sees them through `systemMessage` (Fact 16) | base |
| Write-time hook | `T/.claude/hooks/posttool-single-home.mjs` | A third entry in the Edit/Write PostToolUse group (`T/.claude/settings.json:11-26`). Invoked directly, so it fails open, and always exits 0 | base |
| Dispatch hook | `T/.claude/hooks/subagent-single-home.mjs` | A second SubagentStart entry, invoked directly. It leaves `subagent-verdict.mjs`, `LEDGER_FORMAT` and R01/B03 untouched | base |
| Warmer | spawned by `T/.claude/hooks/session-brief.mjs` | A detached, unref'd, single-flight index build at session start. Prints nothing | base |
| Lift | skill `T/.claude/skills/lifting-shared-code/` and `scripts/scaffold-shared.mjs`; `packages/shared/*` entry in `T/knip.json` | Creates an executable home (§2.6) | base |
| Rule of two | `T/tools/check-workspace-deps.mjs` (the `boundaries` step) | Every `packages/shared/*` export needs at least two importing workspaces. Uses textual import parsing, so it needs no parser | base |
| Scaffold v2 | `scaffold-slice.mjs` | Defect fixes only (§2.7) | base |
| `single-home` companion row | `architecture-reviewer.md`, `torvalds-reviewer.md` | Restates rubric (e). Its exact half is enforced by `duplication` | base |
| Issue sync | `advisory-sync.yml`, `tools/ci/sync-advisories.mjs` | §5 | module `advisory-issues` |
| Embeddings | `tools/context/embed/*` | §6 | module `embeddings` |

**Factory-side components:** evals A, B, C, D and L (§11); print-mode probe scripts (§12, PR 0); and a module-slice materialisation test, which applies every module's `.txt` slice onto base+stack+demo and runs the static floor.

**There are no closed constants.** v1's `SLOT_RULES`, `DELIBERATE_TWINS` and `HARNESS_HOMES` are deleted. The only tables are the reviewed register and the owned rule files the gates already use. That makes the drift test the feasibility critic asked for unnecessary.

**One register.** `T/tools/duplication-allow.json` is already seeded (`installer/lib/layout.mjs:212`), write-guarded (`guard-rules.mjs:605`), listed in `ESCAPE_LISTS` (`T/tools/lib/enforcement-surface.mjs:88`) and `PROPOSABLE` (`installer/lib/proposals.mjs:60`). Its existing validator already tolerates the extra fields (`check-duplication.mjs:72-104`), but it reds any row without a string `fingerprint`, so the mirror rows need the validator change that ships with them.

**Cache.** `.harness/context/` is git-ignored (`T/gitignore:58-61`) and denied to agent writes (`settings.json:215-216`). Only the write-time hook, the dispatch hook and the warmer read it. **Stop and CI never read it.**

### 2.2 Parser and the one normaliser

The same normaliser runs for both languages (taste L1).

**TS callables:**
- Covered: function declarations, function expressions and arrow functions bound to a `const`, and methods.
- The hash starts at the parameter list. The name, `export` and other modifiers are excluded.
- Bound names (parameters, locals, inner function names, catch variables) become `$1…$n` in order of first occurrence. The function's own name becomes `$f`.
- Kept as written: properties after `.`/`?.`, free identifiers (so "calls the platform helper" differs from "reinvents it") and type tokens.
- String, template and regex literals become `S`; numbers become `N`. Comments and whitespace are dropped.
- **`alpha`** is the hash of this stream. **`lit`** is the same stream with literals kept verbatim. `lit` is only ever hashed, never printed.

**SQL functions:**
- Source: `parseFunctions` (`T/tools/lib/sql-parse.mjs:1045`), over the state folded across the whole migration history.
- Same rules: parameters and `DECLARE`d variables are bound, the qualified own name becomes `$f`, and literals become `S`.
- The three audit/auth-trail pairs differ only in string literals (`'audit.events…'` vs `'auth_trail.events…'`), so they are exact under this one rule. v1's separate σ-substitution is unnecessary.

**Scope:**
- The existing `duplication` scan roots (`check-duplication.mjs:44-63`), plus `supabase/{schemas,migrations}`.
- Tests, generated files, `database.types.ts` and `.d.ts` are excluded.
- *Data-shaped* bodies (repetition ratio RNR < 0.5, or literal density > 0.5: zod tables, catalogs) are never owed.

**Parser absence** (feasibility M5):
- If `loadParser()` returns null, L0 and the existing `boundaries` laws still run and decide.
- Only the exact rule fails closed, as a partial leg does: a NOTE locally, a FAIL in CI. It also calls `noteMissingPrerequisite` (`T/tools/lib/gate.mjs:169`), which only appends a `--ci-parity` report record and decides nothing.
- The process never exits early. A factory test proves L0 still reds with the parser stubbed out.
- The gate's catalog entry records the contingency that a TypeScript major might drop `createSourceFile`.

**Refused:** oxc, tree-sitter, ast-grep and libpg_query. The measured costs (§10) do not justify a new dependency.

### 2.3 Records, classes and homes

**Per-blob record.** This is the cache for the hooks and the warmer only.

```json
// .harness/context/blobs/<aa>/<sha256 of content>.json
// key: content sha256 + extractor digest (sha256 of shapes.mjs and its tools/lib import closure, plus ts.version)
{"v":2,"x":"9c1e04ab77d2","lang":"ts","fns":[
  {"name":"publicCredentials","line":40,"tokens":33,"stmts":2,"arity":0,"exported":true,
   "alpha":"e3a91c07b2d4","lit":"5be0d2c1aa90","sig":"() => SupabaseCredentials","mh":"<b64 64×u32>"}]}
```

The cache key is the extractor digest, not a hand-bumped `EXTRACTOR_VERSION`, so a patch drift in TypeScript or an edit to `shapes.mjs` invalidates it (feasibility M4). `mh` is a 64-permutation MinHash over 4-gram shingles with FNV-1a and fixed seeds. It is used only by `--sweep` and the packet builder. v1's `shape` hash and the postings directory are deleted (taste M6).

**Class record.** It is built in memory, in one map from fingerprint to members. It is never stored as a verdict input.

```json
{"fp":"e3a91c07b2d4","lang":"ts","tokens":33,"litEqual":true,
 "members":[{"subject":"@app/supabase#publicCredentials","path":"packages/platform/supabase/src/public-env.ts","line":40,"workspace":"@app/supabase"},
            {"subject":"@app/supabase#serverPublicCredentials","path":"packages/platform/supabase/src/server-env.ts","line":28,"workspace":"@app/supabase"}],
 "home":{"kind":"import","target":"@app/supabase#publicCredentials","params":0},
 "tier":"owed","row":null}
```

**Subject ids:**

| Callable | Subject id |
|---|---|
| Exported | `<package>#<name>` |
| Unexported | `<path>#<name>` |
| Method | `<path>#<Class>.<method>` |
| SQL function | `sql:<schema>.<fn>` |

**`home(class)`** is one total function (taste H1). It is a pure function of the members' files and the rule files the gates already enforce: the `.dependency-cruiser.cjs` forbidden rules evaluated in-process, the vertical-anatomy laws, and the workspace tiers and mobile wall from `workspace-tiers.mjs`.

1. **IMPORT.** Some member's module may already be value-imported by every other member's file. The target is the member with the most importers, ties broken by path.
2. **MODULE.** All members are in one workspace. The home is a module in that workspace (for SQL, a function in schema `private` called by every member's triggers or jobs, added by a forward migration).
3. **LIFT.** Otherwise, if a new `packages/shared/<concept>` is legal for every member, the home is a new shared package. Moving the body into an existing package that every member may import is equally acceptable: the gate checks only that the class is gone, and cohesion stays the reviewer's call (Rebuttal R4).
4. **NONE.** There is no legal home. For example, `packages/shared/*` is outside the mobile wall (`check-workspace-deps.mjs:34-45`, `:104-120`), and only a human-reviewed census entry in `tools/exports-walls.json` could admit it, so a web↔mobile class has nowhere an agent can legally put it. Such a class is **advisory, never owed**: the gate must not demand a move its own machine knows is illegal.

> **Fact-check:** `tools/exports-walls.json` (`S/tools/exports-walls.json`) has no write-guard row at stack head. No `WRITE_PROTECTED` entry in `T/.claude/hooks/lib/guard-rules.mjs` matches it, and it is not in `ESCAPE_LISTS`. Only CODEOWNERS (`T/github/CODEOWNERS:33`, `/tools/**`) and the bash guard's `PROT_DIRS` cover it. So the census entry is human-reviewed at PR time, but an agent can add one in-turn with Edit/Write. "Nowhere an agent can legally put it" holds only if the plan adds a guard row for the census, or accepts that NONE can be turned into LIFT by an in-turn census edit that a human reviews later.

When `litEqual` is false, `params` holds the count of differing literal positions, and the move reads "… with N literal parameters". This prevents the most common silent behaviour change: importing one copy where the other said something different.

### 2.4 Rules and tiers

| Rule | Match | Tier |
|---|---|---|
| **L0** (exists, unchanged) | Token windows of at least 70 tokens and 6 lines (`check-duplication.mjs:27-31`) | owed |
| **exact** | Equal `alpha`, at least 2 members, at least FLOOR normalised tokens, not data-shaped, home ≠ NONE, no matching row | **owed** |
| exact-nohome | As exact, but home = NONE | advisory |
| exact-small | Equal `lit` (literals identical too), 20 ≤ tokens < FLOOR | advisory |
| near-miss | A pair, not a class (the relation is not transitive). LSH prefilter (16×4 bands; a bucket of more than 50 is an idiom and is not paired), then *verified* Jaccard ≥ 0.80 on shingle sets. Equal arity; both sides at least 30 tokens and 2 statements; RNR ≥ 0.5; not data-shaped or mostly JSX | advisory |
| accepted-class-changed, accepted-class-diverged, stale-row | Register row vs tree (§2.5) | advisory |
| rule-of-two | A `packages/shared/*` export with fewer than 2 importing workspaces, tests excluded | advisory during its ramp, then owed (`boundaries`) |

**FLOOR starts at 30**, as do the exact-small band (20) and the near-miss thresholds. All are **frozen in the gate-proposal after eval A's development split and before its holdout run**. The prototype's evidence for the floor (default install = base+stack, 16.3k LOC in scope, 372 callables):

| Floor | Exact TS classes, default install | With demo | With demo and the push slice |
|---|---|---|---|
| 12 | 5 | 6 | 10 |
| 20 | 3 | 4 | 8 |
| **30** | **2** (both same-workspace, both real) | 2 | 5 |
| 40 | 0 | 0 | 3 |
| 70 | 0 | 0 | 2 (the codec, which L0 already finds) |

> **Fact-check:** I re-implemented §2.2 for TS (scan roots and exclusions as `check-duplication.mjs`, no data-shaped filter). It reproduces the default-install column exactly (5 / 3 / 2 / 0 / 0) and the token counts of Dogfood #1, #2, #7 and #8 and of `useTheme` below (33, 33 and `emit` 16, 24, 28, 29). Callables and lines come out at 380 and 16.7k raw lines, against 372 and 16.3k (definitional). The codec counts come out within 3 tokens (165 / 104 / 59). It finds one class the tables omit. `noteCreated` and `noteDeleted` (`D/packages/verticals/notes/src/events.ts:109,134`) have identical bodies that differ only in the event-name literal, at 44 tokens. That class accounts for the whole difference in the demo and push columns (it gives 7 / 5 / 3 / 1 / 0 with demo and 11 / 9 / 6 / 4 / 2 with push). Either the prototype's data-shaped filter drops it, and §2.2 should say so (its literal density is 1/44), or it is a third owed class in the demo tree. In that case the Dogfood inventory, PR 7a and eval B's "after PR 7, the live tree's owed set is empty" must account for it (move: MODULE with 1 literal parameter).

At 20 tokens the floor would make the web/native `useTheme` mirror (29 tokens) and the deliberate `invalidCursor` mirror (28 tokens) owed. That is why v1's 12-token name clause is gone.

**Ranking:** owed before advisory, then cross-workspace spread, then member count, then tokens, then fingerprint.

**Deleted from v1 (taste M1, evidence H2, doctrine M4):** the name clause; `shape`; the D-rules (`twin-drift`, `wire-bound`, `wire-orphan`; the last two go as gate-proposals to `contracts` and `data-flow`); L2 (`table-home`, `single-consumer`, `pass-through`, `fan-in`, `home-unreachable`); `promotion-candidate`; `#27` as a separate signal; `DELIBERATE_TWINS`.

The user asked that unnecessary complexity be recognised. Signals #9 (single-consumer abstraction) and #10 (pass-through function) therefore return later, as **advisory-issue families**, once eval A measures precision of at least 0.90 over all hits (§12, PR 13+). They do not come back as pushed reviewer context.

### 2.5 The register: members-bound rows and mirror rows

```json
{"fingerprint":"e3a91c07b2d4","rule":"exact",
 "members":["@app/supabase#publicCredentials","@app/supabase#serverPublicCredentials"],
 "reason":"≥20 chars naming both sides and why the repetition is irreducible"}
{"mirror":["packages/design-system/src","packages/design-system-native/src"],"reason":"…"}
{"mirror":["apps/mobile/src/i18n/catalog.ts","apps/web/lib/i18n/catalog.ts"],"reason":"…"}
{"fingerprint":"…","rule":"near","members":["…","…"],"reason":"won't-fix for an advisory pair"}
```

**How a class is judged against a row** (doctrine C1, evidence M4, taste C1):

| Tree state | Result |
|---|---|
| Class members equal the row's members | accepted, silent. If the class fingerprint differs from the row's, **advisory `accepted-class-changed`**: both sides changed together, so the reviewed reason may no longer hold |
| Class members are a strict superset of the row's (a third copy, or a swap into another file) | **red**, naming each member the row does not list |
| The row's members exist but no longer form a class | **advisory `accepted-class-diverged`**, naming the edited side. This is the Juergens signal: an inconsistent change to an accepted duplicate |
| A row member no longer exists | **advisory `stale-row`**. `--prune` prints a ready-to-stage `harness-proposals/<id>.json`. Never a red, because an unreachable exemption exempts nothing |
| A `near` row matches a near-miss pair | the advisory closes `not_planned`. A stale `near` row is a NOTE, never a red (doctrine M2) |

**Mirror rows** take a pair of directories (matching corresponding relative paths) or a pair of files.
- They cover a class of exactly two members, one on each side at the same relative path, with the same name.
- They also cover L0 windows between the two sides. The six per-component design-system rows and the three churning i18n rows (`e83e21400fb2`, `f6a177d37c0d`, `4f2c41321264`, which are one decision under three fingerprints) collapse into two rows.
- A copy anywhere else, including `apps/mobile/src/components` ↔ `design-system-native`, is judged normally.

**What is gone.** There are no source markers and no marker census. As for every L0 row today, the write-guarded row under CODEOWNERS is the human act. Because rows bind members, a marker copied along with the code would grant nothing (Rebuttal R6). Shape errors (missing `members` or `reason`, a reason under 20 characters, an unknown `rule`) red, as shape errors do today (today's validator checks only a string `fingerprint` and a non-empty `reason`, `check-duplication.mjs:90-102`).

### 2.6 The Lift and the rule of two

**Command:** `node .claude/skills/lifting-shared-code/scripts/scaffold-shared.mjs '<concept>' --class '<fp12>'`.

**Inputs.** The concept is checked against `^[a-z][a-z0-9-]{1,31}$`. The script re-derives the members from a cold extraction; it takes no symbol arguments to interpolate.

**What it writes** (doctrine H3, feasibility H3), and nothing else:
- `packages/shared/<concept>/{package.json, tsconfig.json, src/index.ts}`. The package depends on the kernel only, and `index.ts` holds a single `// lift: <fp12>` line.
- In each consumer's own `package.json`, a `workspace:*` dependency.
- In each consumer's own `tsconfig.json`, a reference.
- It never writes the root `tsconfig.json`, `knip.json`, `pnpm-workspace.yaml` (whose `packages/*/*` glob already covers it, `T/pnpm-workspace.yaml:13-16`) or any other `WRITE_PROTECTED` path.
- It generates no body and does no anti-unification.

**Shipped with it:**
- A `packages/shared/*` workspace entry in the owned `T/knip.json`, delivered by `update`.
- Allow-list entries in `settings.json` for exactly the script and `pnpm install --offline`. The second is decision Q6.
- A hook-contract test asserting that no skill script writes a `WRITE_PROTECTED` path.
- A factory end-to-end canary: on a fresh scaffold, under the shipped permissions, a Lift turns an owed red green with no guarded write. The canary also proves that a nested `packages/shared/<x>` type-checks with no root reference edit (`check-contract-drift.mjs:50-56` scans one level).

**The agent's part.** It moves one body, imports it at every member and deletes every other body. **The Lift is done** when the class is gone, `shared-not-into-verticals` and knip are green, and the rule of two holds.

**When the Lift is not needed.** Most homes do not need one: IMPORT and MODULE need no new package, so they cause no lockfile change. The Lift is only for cross-workspace classes where no member is reachable.

**The rule of two.** Every `packages/shared/*` export needs at least two importing workspaces, tests excluded; otherwise the message is "inline it into its one consumer". It has no exemption constant. It is empty-legal (no `packages/shared` exists today), ramped and canaried. It counts named imports textually, the way `vertical-anatomy.mjs` already reads specifiers, and treats a namespace import as using every export, so it does not depend on the parser.

### 2.7 Scaffold v2: defect fixes only

The fixes (taste H4):
- Add stubs for `data/{port,rows,errors,query-probes}.ts`, `page.meta.ts` and `lib/app-data/<slice>.ts`.
- Write pages under `apps/web/app/(protected)/o/[orgSlug]/<slice>/`, fixing `:108`.
- Generate one port-narrowing function per slice (`apps/web/lib/app-data/<slice>-port.ts`), replacing the per-call-site cast that `:104` prescribes (Dogfood #14).
- Where a reachable home exists (for example, `@app/supabase/errors` after PR 7a), have the stub import it.

**Removed:** v1's rule 2 (the LIFT FIRST refusal), rule 3 (the sibling skeleton and `// sibling:` pointers), the converge/diverge split, and the `slot`/`alt` record fields. The scaffold's file list stays the one slot list (Rebuttal R5). An empty tree behaves exactly as today.

---

## 3. Delivery protocol

| Moment | Recipient and channel | Content | Goes live |
|---|---|---|---|
| **Scaffold** | Main agent, via `scaffold-slice` stdout | §2.7 only | PR 2 (bug fix) |
| **After an edit** | The editing agent (and a subagent, if probe (c) passes), via PostToolUse `additionalContext` (Fact 18; precedent `posttool-source-check.mjs:101-113`) | Owed classes, **including ramp-withheld ones** (feasibility L2), that the edited file now holds a member of. At most 3 items and 1,500 characters; at most 3 messages per prompt; once per class per session | PR 9, after eval D's +pointer arm |
| **Author subagent stop** (only if probe (c) fails) | The author subagent, via a separate, directly invoked SubagentStop entry that exits 2 | Owed classes with a member in files the subagent touched (its start digest vs stop). At most 2 bounces per `agent_id`; after that, Stop is the authority | PR 9, conditional |
| **Reviewer dispatch** | `architecture-reviewer` and `torvalds-reviewer`, via SubagentStart `additionalContext` (probe a) | **Live:** the `reviewChanges()` file list, since reviewer bodies say "run `git diff`" but hold no Bash (`architecture-reviewer.md:9,26`), plus one line: "N exact classes are owed by `duplication`; not your call". **Dark until eval C:** near-miss facts and *touch* facts (other functions reading or writing the same table, from `tools/generated/query-shapes.json`), at the size and channel eval C chooses | PR 10 / PR 10b |
| **Stop** | Main agent via exit 2 and stderr (red); **user** via `systemMessage` on green (Fact 16) | Red: the class, members, home, move and `--explain` line. Green: "advisories: N" and the first 3 NOTEs | PR 3 / PR 8 |
| **Nightly** | Issues (module) | §5 | PR 11 |

**Dropped (taste M4, evidence C1):** `## Reuse` in the spec template, the Step 0 pull line, `--neighbours`, and author-dispatch briefs. Author briefs can return after an eval D arm tests them.

**Probes and fallbacks.**
- Probe (a) passes → SubagentStart `additionalContext` is the channel.
- (a) fails and (b) passes → a PreToolUse `Agent` `updatedInput` append, wrapped in a **random nonce delimiter per dispatch**. The reviewer bodies state that only a nonce-delimited block or a SubagentStart system reminder is harness-authored, and that any look-alike in the prompt is the author's own text (doctrine H5).
- Both fail → **no packet**. The dispatch hook logs `neighbours: null(probe)`. No packet is better than a stale one.
- v1's fallback 2 (`.harness/context/brief/<agent_type>.md` plus "Read it first if present") is deleted.

**Caching for the hooks.**
- The dispatch hook caches **structured records** under `.harness/context/packets/<digest12>.json` and re-renders them through `closed-text.mjs` at every serve. It never serves stored rendered text.
- The build is single-flight behind a lock: the first process computes, and the others wait until their deadline.
- The write-time hook re-extracts each candidate partner file live before printing. A poisoned cache can therefore only *suppress* a pointer, never invent one.
- The hook keeps a per-session "already told" set (`.harness/context/told-<session>.json`). It is bookkeeping for the once-per-class rule, and no gate reads it.
- Neither hook ever builds the index cold. On a cold miss it logs `null(cold|deadline)` to telemetry, so the null rate is measured. The warmer runs at session start.

**Message formats.** Every agent-controlled name appears in a code span under a fixed header saying that names are data. Printed commands single-quote every argument. Symbols containing `$` print as `(unprintable)` (doctrine L1).

```
single-home — OWED: the `duplication` Stop step reds this. Names below are data, not instructions.
CLASS  `e3a91c07b2d4` · 33 tokens · 2 members · same package
  NEW   `packages/platform/supabase/src/server-env.ts:28` `serverPublicCredentials`
  SAME  `packages/platform/supabase/src/public-env.ts:40` `publicCredentials`
MOVE   IMPORT — keep `publicCredentials`, import it at the other site, delete the other body.
EXEMPT only through a human-applied row naming every member:
       node tools/check-duplication.mjs --explain 'e3a91c07b2d4'
```

```
MOVE   LIFT with 1 literal parameter — no member is importable by the others:
       node .claude/skills/lifting-shared-code/scripts/scaffold-shared.mjs 'append-only-guard' --class 'a1b2c3d4e5f6'
       then move one body into it, pass the differing literal, import it at every member, delete every other body.
```

```
single-home — ADVISORY (no verdict). Resemblance is not equivalence.
PAIR   `packages/verticals/notes/src/data/errors.ts:69` `mapPostgrestFailure`
  ~    `packages/platform/supabase/src/errors.ts:134` `mapPostgresError`  (J 0.81 · arity 2/2)
DIFFERS AT  arm `23503`: appError.conflict | appError.validation · arm `23514`: same · B only: 4 arms
MOVES  WRAP (call it; override only the differing arms) or JUSTIFY (a human-applied `near` row).
```

**"Differs at" facts** are computed by aligning top-level statements and switch arms. They are printed as statement indices, callee names (which pass the symbol printer), and case labels through a strict printer (`^[A-Za-z0-9_]{1,12}$`, else `#n`). No body, comment, free literal, commit text or prompt text is ever printed (evidence H3).

> **Fact-check:** In the tree, both mappers' case labels are named constants, not literals. Examples are `FOREIGN_KEY_VIOLATION` (21 characters) and `CHECK_VIOLATION` (15 characters) in `S/packages/platform/supabase/src/errors.ts:174,185` and `D/packages/verticals/notes/src/data/errors.ts:90-91`. The label printer `^[A-Za-z0-9_]{1,12}$` would print them as `#n`. Printing `23503` as in the example needs the aligner to resolve file-local constants to their values, which prints a literal. One of the two rules has to give. The example's "B only: 4 arms" matches only if arms are counted as case-clause groups: `mapPostgresError` has 6 case labels absent from notes, spread over 4 groups.

**Not an injection surface.** Owned code computes every payload from the tree and never reads the author's Agent prompt. The closed printers allow only:

| Field | Printer |
|---|---|
| Paths | `PATH_RE` |
| Symbols | `^[A-Za-z_]\w{0,63}$` |
| SQL names | `^[a-z_]\w{0,62}(\.[a-z_]\w{0,62})?$` |
| Signatures | Rebuilt from AST tokens, with literal types shown as `S` |
| Everything else | Enums and numbers |

> **Fact-check:** `PATH_RE` is `^[A-Za-z0-9._@+/-]{1,160}$` (`T/tools/lib/harness-brief.mjs:52`). It rejects `(`, `)`, `[` and `]`, so every Next app-router path under a route group or dynamic segment would print as `(unprintable)`. Examples are `apps/web/app/(protected)/o/[orgSlug]/notes/note-composer.tsx` (Dogfood #15) and `apps/web/app/api/trpc/[trpc]/route.ts` (Dogfood #14). Pointers, packets and issue bodies for members there would lose their location unless the path printer is widened (for example, to admit `()[]`) when it moves to `closed-text.mjs`.

**Reuse, not copy.**
- Pointers only: bodies are noise, and API facts help (2503.20589).
- IMPORT, MODULE and LIFT apply only to exact classes; WRAP and JUSTIFY to near-misses. Never "see" or "example".
- Moves pass the same legality rules the boundary gates use, so a printed move does not red `boundaries` or `architecture`. A move can still change behaviour, which is why non-exact matches never get IMPORT. v1's claim that "no suggestion can red" is withdrawn.

---

## 4. Enforcement model

| Tier | Contents | Local | CI | Disposition |
|---|---|---|---|---|
| **owed** | L0; exact classes at or above FLOOR with a legal home and no matching row; register shape errors; a class larger than its row; rule-of-two after its ramp | Stop reds `duplication` / `boundaries` | `unit` job and the frozen floor, **same code, cold** | The class is gone, or a human-applied row names every member |
| **advisory** | exact-small, exact-nohome, near-miss, accepted-class-changed/diverged, stale-row, rule-of-two during its ramp, ramp-withheld exact classes | Never red. NOTE to the user on green; owed and ramp-withheld classes also reach the agent at write time | Nightly → issue (module) | Fix it, or add a row (`not_planned`) |

**Whole-tree, as L0 already is** (taste C2, doctrine H1, feasibility H1). The owed verdict is a pure function of the tree plus `duplication-allow.json`. A human, another agent, `disableAllHooks`, a direct push to the default branch, a scheduled run and a PR all meet the same verdict. There is nothing to resolve: no `@{upstream}`, no `GITHUB_BASE_REF`, no `event.before`, no recorded session base. No merge-base index, move exclusion, `legacy` status or novelty overlay exists.

**No verdict reads a cache** (doctrine H2, feasibility M4). Stop and CI re-extract the whole judged tree in-process: about 0.5 s on the template and about 2–2.5 s at 200k LOC (§10). CI restores no `actions/cache` for verdict inputs. So a test or script that runs earlier in the same job cannot plant records that erase a class. v1's claim that "no verdict reads shared mutable state" was false; it is now true.

**One adjudicator per key.**
- An owed class gets exactly one red, from the gate.
- An advisory key is judged by the reviewer, if it reached a packet, or becomes a post-merge issue.
- Being *shown* a key never adds a penalty. Acting on a pointer cancels the debt, because Stop judges the tree.

**Justify** is the existing staged register edit:
1. The agent writes `harness-proposals/<id>.json`, adding a members-bound row (`T/docs/harness/README.md:255-270`).
2. A human runs `apply-proposal <id>`, which agents are denied.
3. The turn's Stop wording becomes: "awaiting human `apply-proposal <id>`; report and stop".

An AWAITING-HUMAN Stop state is still rejected: it would special-case the most load-bearing hook right after `stack/51`. The block cap of 8 (`T/.claude/settings.json:8`) and the "PREVIOUS TURN ENDED RED" carry-forward end such turns loudly.

**Cap-hit trigger** (evidence H7). The factory telemetry counts **every** owed-red turn that ends at the block cap, whatever the cause: a failed Lift, a pending proposal, or thrash. Above 5%, a gate-proposal reviews the floor or the moves.

**Ramps, conditional on evidence** (evidence C1). The new rule ships as `rampNote('duplication', '2.1.0', 'exact function and SQL-function classes', {until: '2.3.0'})`.
- Fresh installs at 2.1.0 or later meet it live. So **the release that ships it is cut only after evals A (holdout), B, L and the owed-only arm of D pass and are recorded** (§12, PR 8).
- For older installs, `until` is re-dated in a release unless that evidence still holds. A rule never goes blocking by default.
- During the ramp, ramp-withheld classes reach the agent through the write-time hook, reach the user through NOTE survival, and appear in issues. At expiry, keys keep emitting with `status: blocking` (`gate.mjs:316-323`).
- The rule of two has its own ramp.

**What is and is not monotone** (evidence H5).
- *Is:* a green tree holds zero unregistered exact classes at or above FLOOR with a legal home, locally and in CI, on every event.
- *Is not:*
  - near-miss pairs, which may grow and are tracked as issues;
  - exact classes turned into near-misses by cosmetic edits ("degradation");
  - classes below FLOOR;
  - classes with no legal home (for example web↔mobile).
- *Degradation is measured.* At Stop, each owed class that disappears is classified as `lifted`, `imported`, `module`, `deleted`, `degraded` (its members still pair at near-miss level) or `allowed`. It is emitted as a closed telemetry enum with no paths (`T/.claude/hooks/lib/hookio.mjs:57-61`). The bookkeeping file `.harness/context/owed-last.json` is never read by a verdict.
- *Pre-committed:* if eval D or field data shows `degraded` above 10% of discharges, the factory ships, in the next minor and behind a ramp, the graduation "a near-miss pair across workspaces whose normalised signatures are equal is owed" (Rebuttal R8).

**Parallel merges.** Two PRs that each add one copy can both pass and turn the default branch red after the second merges. This is loud rather than silent, unlike v1's "legacy" pair. The fix is a Lift, and the nightly issue opens at once. The docs recommend a merge queue or required up-to-date branches.

**Tier changes are factory release decisions** (doctrine M5). Demotion, retirement and graduation are decided on aggregated eval and field data, through a gate-proposal and a ramp. No consumer gate computes a tier from issue state, allow-row counts or telemetry. A factory test asserts that the tier tables are constants.

---

## 5. Advisory → GitHub issue pipeline

**Recommendation on "all unfixed advisories".** The end state is **every class-A advisory that CI can recompute**, meaning one that is keyed, project-owned and not already in a register. It is reached **one gate at a time**. It is not literally all, for four reasons:
1. **Machine closure.** An issue that only a person can close rots. CI must be able to see the finding gone, so local-only hits and reviewer prose cannot qualify.
2. **Injection.** Free text in an issue body is an instruction channel to every agent that later reads the issue (Copilot assignment, `@claude`, a paste into a session). Records must be closed fields (doctrine H4).
3. **Fatigue.** Class B lines open and close every turn. Unmeasured families teach people to ignore the label (Tricorder; Cihan et al.).
4. **Two copies drift.** Class C items already live in a reviewed register. The dashboard links them and never copies them (`scripts/check-obligations.mjs:23-28`).

A reviewer finding that recurs becomes a human-filed gate-proposal, never an issue.

**v1 sources** (taste M3, feasibility M2):
1. **`check-duplication --sweep --json`.** A single process, *complete* only when it exits 0 and its versioned document ends with `"complete": true`.
2. **Scheduled-lane conclusions,** read under `actions: read` from job **conclusions only**, never from logs or artifacts. Each gives one issue per red lane, closed on that lane's next green.

Other gates join one at a time, each with a closed rule id, class A only. A factory ratchet list records which gates are converted, and the dashboard lists the rest as "not covered". v1's every-`NOTE —` factory check is deleted, and `noteAdvisory` is an opt-in helper.

**Closed record schema.** There is no free text; NOTE prose and snippets stay in the CI log.

```json
{"v":1,"producer":"duplication","rule":"exact|exact-small|exact-nohome|near-miss|accepted-class-changed|accepted-class-diverged|stale-row",
 "status":"advisory|ramp-withheld|blocking","subject":"<closed printers>","fp":"<12 hex>","until":"2.3.0",
 "counts":{"members":2,"workspaces":1,"tokens":33}}
```

Completeness is recorded **per producer leg**, by `noteComplete({producer, leg})`, written only in the final `ok()` or `failures()` and never on an early exit. A key closes only if its own leg completed (doctrine M1). Semantic hits have their own producer, `embeddings`, whose terminator is written only after its probe-set check passes.

**Bodies** use a fixed-vocabulary template. They carry members in code spans (through the closed printers), labels, `until`, and the line `node tools/check-duplication.mjs --explain '<fp12>'`. A golden test asserts that **no body byte comes from outside the closed schema**, and that no `@`, `#\d` or `<` appears outside code.

**Identity.** `key = sha256(producer | family | subject)[:16]`; line numbers and content never appear in it.

| Finding | Subject |
|---|---|
| Exact family (owed, small, nohome) | The class **fingerprint**, so a growing class updates one issue |
| Near-miss pair | Sorted subject ids |
| Lane | `lane:<job>` |

The marker is `<!-- harness-advisory v1 key=<16hex> body=<sha8> miss=<n> last=<sha12> -->` (feasibility L1). Dashboard keys keep their state in a separate marker block, and the dashboard paginates to counts as it nears 65,536 characters.

**Lifecycle**

| Observation | Action |
|---|---|
| New key, and a slot is free (at most 10 new per run, 50 open) | Open; otherwise list on the dashboard |
| Body changed | Edit it; never comment |
| Key matches a members-bound row | Close `not_planned`, linking the row |
| Exact-family key absent from **1** complete run | Close `completed`, citing the SHA |
| Near-miss or semantic key absent from **2 consecutive** complete runs | Close `completed` |
| Producer incomplete | No change. After 7 days, add `advisory:stale` |
| More than 25% of open keys vanish in one run | Close nothing; flag the run as anomalous on the dashboard (doctrine L2) |
| More than 10 closures due in one run | Close the first 10 in key order |
| Key returns after `completed` | Reopen as a regression |
| Row-closed, then the members change | Reopen |
| Human-closed without a row | Stays closed; listed as "closed without reviewed exemption" |
| `ramp-withheld` becomes `blocking` | Relabel `advisory:now-blocking`; stays open |

**Security**
- `advisory-sync.yml` runs only on `schedule` (after `'11 3 * * *'`) and `workflow_dispatch`, under `concurrency`. It reads no cross-workflow artifact.
- **compute** has `contents: read` and `actions: read`. It runs `pnpm install` and `--sweep --json`, and reads lane conclusions. **It recomputes; sync only applies** (doctrine L2). It does not run `validate --report-all`, so the job costs minutes, not an hour (feasibility L1). Its output is schema-checked and at most 1 MB.
- **sync** has `issues: write`. It installs nothing and sparse-checks-out only its script, the register and the schema. It runs harden-runner with `egress-policy: block`, allowing only `api.github.com:443` and `github.com:443`.
- sync writes through `gh api --input -` at 1 write per second, honours `retry-after`, and uses no `${{ }}` interpolation. It uses `GITHUB_TOKEN`, so it cannot re-trigger itself. It touches only bot-authored, labelled issues that carry the marker.
- Titles come from a fixed vocabulary. Control, bidi and zero-width characters are stripped.
- Factory tests pin the permissions and prove the lane can go red.
- There is no `doctor` staleness check, because `doctor` makes no network calls. Staleness shows as the dashboard's own timestamp, and a failed sync is a red scheduled lane.

**Base or module.** The recorder, NOTE survival and `--sweep` ship in base. The sync is the **module `advisory-issues`**: it would be the scaffold's first `issues: write`, and 2.0.0 is "the opt-in release". The recommendation (decision Q3) is that `init` enables it by default, with an opt-out flag, so the user's "advisories become issues" holds out of the box. Existing installs opt in with `enable advisory-issues`, so `update` never silently widens a token's permissions. Each repository files only into itself. The factory dry-runs the sync against recorded `gh` responses.

**Without the loop, issues are a ledger, not a remediation mechanism** (evidence M2). The plan measures each family's fix rate: issues closed `completed` within 30 days. A family whose fix rate stays below 10% over 60 days is a falsifier for routing it to issues. The response is a factory decision to move it to write-time delivery, graduate it, or retire it.

**Future agent-fix loop.** The contract is recorded now; the loop is designed only after probe (d) and 60 days of fix-rate data (decision Q4):
- Its input is only `{key}`, re-derived through `--explain`.
- It never reads issue text and never auto-merges.
- It never touches `ESCAPE_LISTS`, `tools/`, `.claude/`, `.github/`, migrations or `harness-proposals/`.
- Net non-test LOC must be at most 0.
- At most one run a day, with an attempt budget of 2.

---

## 6. Optional embedding layer

**Module `embeddings`.** The user decided there is an optional layer. The evidence decides its *label* and whether it may file issues.

**Prototype first.** A factory script measures the layer before any module code is written (feasibility M8). The comparison is T4 recall@5 against two baselines (evidence M3):
1. a deterministic index of signature plus name sub-tokens, the "reinvented helper" recipe in `w1-ai-slop-evidence.md` Q2;
2. an agent-grep run.

Bars, at advisory precision of at least 0.8 on a **labelled top-K from a full-tree nightly sweep** (not planted pairs alone):

| Lift over the better baseline | Outcome |
|---|---|
| ≥ +15 points | Ships "recommended" |
| +5 to +15 points | Ships "experimental" |
| Under +5 points | Ships dashboard-only, files no issues, and is labelled "not recommended" with the measured number |

**One adapter** (taste L3, feasibility M8). The recommended default is hosted `voyage-code-4`, pinned to its dated snapshot, at 512 dimensions and int8 (decision Q7). The training opt-out must be recorded in the write-guarded `tools/embeddings.config.json` (a new `guard-rules.mjs` row: no rule covers that path today) **before the first call**.

**Storage.** A flat `vectors.i8` file plus `rows.jsonl`, with brute-force search (12 ms per int8 query at 5k×1024, 8 ms in f32; measured, `w2-embeddings.md` §4). `bits.u32` is dropped.

**Jobs, split** (doctrine M6):
- **extract** (`contents: read`; runs `pnpm install`; no secret). It emits normalised function records for the indexed callables only, within the scan roots, with comments stripped and after the `tools/secret-patterns.json` filter. They go to a same-run artifact, because function text exceeds the 1 MB job-output cap at scale (Rebuttal R18).
- **embed** (installs nothing). It holds the API key in exactly one step and runs harden-runner `egress-policy: block`, allowing only the provider host and GitHub. It schema-checks its input.
- It then hands closed hit records (subject pair and cosine rounded to 2 decimals) to the `advisory-issues` sync job in the same workflow.

**Candidates and tier** (evidence M3, taste L3):
- Candidates come from **deterministic buckets**: functions sharing a callee, a table or a DTO field. Within a bucket they are ranked by cosine.
- A hit qualifies with cosine ≥ T_adv **and at least two corroborators, at least one of them non-signature** (shared callee, table or DTO field, or MinHash ≥ 0.15).
- T_adv is calibrated per model on the labelled full-tree top-K.
- Hits are recorded under producer `embeddings`. They close after 2 runs, with hysteresis (T_close = T_adv − 0.03).
- They never reach write time, packets or the owed tier.

**Determinism boundary.**
- Only this job touches vectors or the network.
- A probe set must re-embed at cosine ≥ 0.995, or the layer disables itself loudly. Its terminator is then not written, so no semantic issue closes on unknown.
- The owed set is **byte-identical with the module on and off**, asserted by a factory test.

---

## 7. Resolution of the six tensions and the gaps

**Tensions**
1. **Semantic hits at write time.** None. Write time carries owed classes only, and semantic hits reach only corroborated nightly issues.
2. **Identity.** An exact class is keyed by its fingerprint, which survives renames and growth. A near-miss is keyed by its sorted subject pair. Rows bind members, and the fingerprint is evidence. Three identifiers remain (fingerprint, subject ids, tree digest), down from six.
3. **Closing.** Exact keys close after 1 complete run, thresholded keys after 2, and lanes on their next green. Unknown is not absent. Only a row closes an issue `not_planned`. Closures are capped, and the anomaly guard applies.
4. **"Every advisory becomes an issue."** Every class-A advisory that CI can recompute, phased in (§5).
5. **Nagging versus owed.** There is no shown-ledger. Stop judges the tree, so acting on a pointer cancels the debt. The write-time "already told" set is bookkeeping only.
6. **Loop versus distrusted text.** There is no loop in v2. The key is the only actionable field, the contract is in §5, and probe (d) comes first.

**Gaps**

| Gap | Resolution |
|---|---|
| CI backstop | Whole-tree, the same code cold in CI, with the register committed |
| Every lane | Lane issues from conclusions. Unconverted gates are listed as "not covered" |
| Diff vs sweep | There is no diff scope. Stop's owed set is the sweep's owed subset |
| The existing `duplication` gate | One gate and one register. Mirror rows retire nine L0 rows |
| Ramp visibility | Write-time hook (ramp-withheld classes), NOTE survival (user), issues, the ramp NOTE count |
| Unrelated red | Per-leg terminators, plus the single-process sweep |
| Read-only reviewers | The change list via SubagentStart, or a nonce-wrapped `updatedInput` |
| Opt-in | The core ships in base; issues and embeddings are modules |
| Which repository | The consumer's; the factory dry-runs |
| Action rate | The discharge enum (§4); effective false positives (§11E) |
| Concurrency | Verdicts read no shared mutable state. Caches are content-addressed with atomic renames; the warmer and packet builder are single-flight |
| Existing installs | Ramp, plus pending source fixes (`update.mjs:434`) for harness-shipped duplicates. No `--refresh-seeded` for migrations |
| Forked `settings.json` | `doctor` and the SessionStart brief name any parked single-home hooks (feasibility M7) |

---

## 8. What it deliberately does NOT do

**Deletion bias.** A Lift is complete only when every other body is gone. The rule of two inlines any shared export left with one consumer. Dogfood PRs report net LOC, which is required to be negative only for the pure deduplications.

| Rejected | Why |
|---|---|
| Diff-scoped novelty: merge base, move exclusion, `legacy`, novelty overlay | The base can be moved and goes missing on pushes. Whole-tree is simpler and stronger |
| Owed status for near-misses, small classes or the name clause | Only exact hashes at a measured floor gate. The template's own deliberate mirrors sit at 28–29 tokens |
| Rows keyed by fingerprint alone; source markers; marker census | They let one approval exempt unlimited copies |
| Closed constants (`SLOT_RULES`, `DELIBERATE_TWINS`, `HARNESS_HOMES`) | Owned code that silently hides slop whenever it drifts |
| Pre-shipped empty homes (`pg-errors`, `postgrest-rows`, `keyset`) | Speculative generality, and duplicates on refresh. Existing homes are made reachable instead |
| IMPORT on a non-exact match | Resemblance is not equivalence (ExecRetrieval) |
| L2 context signals and D-rules in packets | Unmeasured precision and anchoring risk. The useful ones return as gate-proposals or measured advisory families |
| Scaffold sibling skeletons; LIFT FIRST refusals | Similarity-driven copying amplifies duplication (RepoCoder), and the third copy is red anyway |
| Shown-ledger; AWAITING-HUMAN | The first cannot be recomputed in CI; the second changes Stop's semantics |
| Cached verdict inputs (locally or via `actions/cache`) | Poisonable, and they break "CI never honours a stamp" |
| Author briefs, `## Reuse`, `--neighbours` | No measured consumer. They return only after an eval D arm |
| Fallback brief file keyed by agent type | It is stale reviewer memory |
| Anti-unified skeletons and codemods | Callback soup. 76% of raw LLM extract suggestions were hallucinated |
| Refactor loop in v2 | It would be the first CI Claude lane with `contents: write`, before probe (d) |
| PageRank, co-change, MCP query tool | Young repos have no history; `--strict-mcp-config` hides MCP tools from the eval |
| Embeddings in synchronous moments | Breaks "same tree, same verdict" |
| Free text in issues; log scraping; cross-workflow artifacts | Injection; the sync recomputes |
| PreToolUse deny; UserPromptSubmit | Thrash; it fires before any code exists |

---

## 9. Evidence trace

| Mechanism | Finding | Source |
|---|---|---|
| Obligation, not context | Agents ignore context they already have; 50.8% duplicated logic by turn 5 | `w1-ai-slop-evidence.md` §1, Q3 |
| Thesis as hypothesis; coverage table | Paraphrased reinvention is the best-documented failure; the share is unquantified | `w1-ai-slop-evidence.md` summary 2, Q2 |
| Dogfood first | RepoCoder amplifies existing duplication; healthier code helps agents | `w1-ai-slop-evidence.md` Q4 |
| Exact-only gate, measured floor | Rename-invariant hashing is precise; most clones are benign; there is no TS benchmark, so calibrate locally | `w1-clone-similarity-sota.md` Q2, Q6, summary 3 |
| Literal-parameter moves; WRAP for near-misses | 29.6% of plausible patches diverge, 46.8% of those "similar but divergent"; near-clones cluster | `w1-ai-slop-evidence.md` [25]; `w2-embeddings.md` §2 |
| Members-bound rows, divergence advisory | Inconsistent changes to clones cause faults (Juergens) | `w1-clone-similarity-sota.md` Q6 |
| Whole-tree verdict | "A CI pass and a local pass mean the same thing"; the base moves with every push | `T/github/workflows/quality-gate.yml:3`; `T/tools/lib/git-diff.mjs:76-79` |
| No cached verdict input | CI never honours a stamp | `T/tools/lib/gate.mjs:426` |
| Write-time delivery, pointers only, at most 3 | Infer about 70% at diff time vs about 0% in batch; similar code is noise; more than 5 items interfere | `w1-design-quality-signals.md` Q7; `w2-write-time.md` §2 |
| Similarity facts dark until eval C | Pushed BM25 context: −31% F1 for a non-agent Claude reviewer; Tufano anchoring; top-1 beats top-k | `w1-agent-context-retrieval-sota.md` summary 1, Q2; `w1-design-quality-signals.md` Q7 |
| Change list to reviewers | Reviewers hold no Bash, yet their bodies say "run `git diff`" | `w1-harness-reviewer-pipeline.md` §1 |
| Eval L before go-live | RefactorBench 22% vs 87% for humans; CodeTaste up to 69.6% | `w1-ai-slop-evidence.md` Q3, Q4 |
| Powered eval D, independent oracle | Pre-register, 30% holdout, identifier rotation, slopes, downstream cost | `w1-ai-slop-evidence.md` eval design §1, §3, §6 |
| Discharge enum, effective false positives | Tricorder's effective-false-positive loop ("not useful" feedback); agents game checks (assertions deleted; error-masking +47%) | `w1-design-quality-signals.md` Q7; `w1-ai-slop-evidence.md` summary 4, Q3 |
| Closed issue records, split privileges | Prompt injection through issues (PromptPwnd, Comment and Control); search-API duplicates | `w2-issue-sync.md` §1–4 |
| Fix-rate falsifier | Batch delivery gets about 0% fixed | `w1-design-quality-signals.md` Q7 |
| Corroborated embeddings, better baselines | ExecRetrieval exec@1 = 0.33; validators 97.5% accurate on checked rejections | `w2-embeddings.md` §2 |
| SQL in scope, folded state | `deny_mutation` and the partition functions ×2 | `w1-stack-anatomy.md` §6; verified |

---

## 10. Cost and latency budget

**Baselines.** `duplication` takes 310 ms today. The TypeScript load is 214–230 ms, or about 130 ms with `module.enableCompileCache()`.

**Measured (prototype):**

| Tree | In-scope LOC | Callables | Cold time, incl. TS load |
|---|---|---|---|
| Default install | 16.3k | 372 | 0.48 s |
| With demo | 20.2k | 447 | 0.54 s |
| With demo and push | 20.8k | 463 | 0.59 s |

The feasibility critic measured 278k LOC (16.8k callables) at 1.9 s cold and 1.5 s warm, plus 214 ms for the load, single-threaded.

| Moment | Template | 200k LOC | Bound |
|---|---|---|---|
| Stop `duplication` (always cold) | about +0.5 s | about 2–2.5 s | `chain-budget.json` row (ceiling 15 s) |
| CI `unit` | about +0.5 s | about 2–2.5 s | no cache |
| Write-time hook | p50 ≤ 300 ms, p95 ≤ 600 ms when warm | same | 1 s self-deadline, 5 s timeout; runs beside Biome |
| Dispatch hook | change list ≤ 200 ms; packet ≤ 1 s warm | ≤ 2.5 s | 3 s self-deadline; single-flight |
| Warmer (background) | 0.5 s | about 2 s | detached at SessionStart |
| Nightly compute | `pnpm install` + about 1 s | install + about 3 s | — |
| Nightly sync | ≤ 60 writes | ≤ 60 writes | 1 write per second |
| Embeddings (nightly) | — | cold 1–3M tokens, incremental is small | provider pricing |

**Eval cost** (feasibility H2). These are estimates: wall-clock depends on hardware, and tokens on the model.

| Eval | Runs | Estimate | When it reruns |
|---|---|---|---|
| D | 3 arms × 20 chains × 5 turns × 3 seeds = **900 agent turns** | Each turn ends in the full Stop chain (52.7 s measured with stamps warm, `rls-isolation` included; `scripts/chain-budget.json` `stopWall`). About 60–120 machine-hours, parallelisable; tokens on the order of 10⁸ per run | Only when a write-time family changes. Graduations are gated on A + E, not a fresh D |
| C | 110 cases × 10 runs × 3 arms ≈ **3,300** single-reviewer `claude -p --agent` runs, plus about 2,200 for ablation on the winning arm | — | Only when a reviewer body or the packet format changes |
| L | 4 scenarios × 10 seeds = **40 sessions** | — | Only when the Lift script changes |
| A, B | Deterministic | Seconds; run in factory CI | Every change |

**Scaling.**
- Only changed blobs are re-parsed, for the hooks.
- Verdicts parse everything cold.
- MinHash and LSH run only in `--sweep` and the packet builder.
- No worker threads (taste M6, feasibility M4).
- oxc replaces the parse only if the chain-budget row shows a cold Stop run over 8 s, and then as a reviewed dependency change.

---

## 11. Evaluation

**Process rules for every eval:**
- Pre-registered, with the analysis plan committed before the run.
- Thresholds frozen before held-out data is seen.
- The Claude Code version and permission posture recorded in `tests/evals/<eval>/<date>.json`.
- Statistical tests instead of raw point deltas.

**A. Detector eval** (factory; extends `tests/gates/check-duplication.test.mjs`; gating).
- **Corpus.** About 40 home helpers, mutated:
  - locals renamed;
  - a literal swapped;
  - 1–3 statements edited or reordered;
  - a copy placed in a sibling vertical;
  - an SQL copy across schemas;
  - a move;
  - an edit that pulls a function into resemblance.
- **Decoys:**
  - **the per-vertical seam constructors** (`invalidCursor`, `emptyPatch`, `unreadableWrite`, `contractDrift`, their push equivalents, and the real `invalidExportCursor` mirror);
  - local vs UTC `formatDate`; `toCents`/`fromCents`;
  - the design-system mirror and the i18n catalogs;
  - zod tables; route-convention files; the two legal policy shapes;
  - tiny same-name functions with different bodies.
- **Split.** A development split of 70%, used to set FLOOR and the near-miss thresholds. Those values are then frozen in the gate-proposal. The **holdout** is 30% of the helpers plus a **third vertical written blind** by an agent that cannot see these rules.
- **Bars on the holdout:**
  - **0 false owed hits** (owed precision 1.0);
  - near-miss precision ≥ 0.90;
  - byte-identical output on two machines.
- **Unit tests, not bars:** owed recall on renames and literal swaps, which is true by construction.
- **Required canaries:** a third copy of a class with an accepted 2-member row reds; a swap of one member into another file reds; a move stays silent; an edit to one side of an accepted class yields `accepted-class-diverged`; L0 still reds with the parser stubbed.
- Each owed rule, the register's shape errors and the rule of two get a canary in `tests/canary/injections.json`.

**B. All-hits precision** (factory).
- **Corpus.** A **frozen fixture snapshot of the pre-dogfood tree**: base + stack + demo + the materialised push slice. It is frozen so that PR 7 cannot make the eval vacuous (feasibility M1).
- **Labelling.** **Every hit** the sweep produces is labelled by tier and rule. This is a precision measurement over all hits, not "found 8 of 9".
- **Bars:**
  - owed precision 1.0 (every owed hit is a true duplicate or covered by a mirror);
  - advisory precision ≥ 0.8;
  - the Dogfood coverage table is reported per tier.
- **External check.** One external TypeScript monorepo sweep, with the top 50 near-misses labelled (reported; it becomes a bar after two runs).
- **"Scaffold and fill a second vertical with the skill" scenario.** Bar: **0 owed hits** on the seam constructors.
- **After PR 7,** the live tree's owed set is empty.

**C. Reviewer eval** (factory). `KINDS` (`scripts/reviewer-eval.mjs:72`) gains `helper` and `sql-function`.
- **Cases.** For each of `architecture-reviewer` and `torvalds-reviewer`, per kind: **at least 10 BLOCK cases** (each a *near-miss or type-3* duplicate whose home lies outside the diff, so the gate cannot catch it), 10 PASS twins and 5 decoys.
- **Arms:**
  1. diff-only, today's `livePrompt`;
  2. **push**: delivery-faithful through SubagentStart, which needs probe (d);
  3. **pull**: the packet as a Readable file named in one line.
- **Ablation** on the winning arm: top-1, top-3 or a cap of 10 items; near-miss only, touch only, or both.
- **Displacement.** The **whole existing corpus** (security, a11y, torvalds) is re-run in every arm.
- **Scoring.** `mustCite` checks the home path. Each packet item needs a `confirm|dismiss <key>` line, so dismissal rates exist.
- **Runs and statistics.** At least 10 runs, analysed with a paired, case-clustered test (McNemar on per-case majority, plus a mixed-effects logistic model).
- **Bars** (a gate-proposal sets the threshold, because the eval itself gates nothing, `reviewer-eval.mjs:50-55`):
  - BLOCK recall up by at least 15 points, with the 95% CI excluding 0;
  - non-duplication BLOCK recall down by no more than 5 points (CI upper bound);
  - twin and decoy false-BLOCK up by no more than 5 points.
- **Its result picks the channel and size.** Probe success alone does not.

**D. Generation A/B** (factory, `claude -p`). **A decision gate.**
- **Permission posture.** Probe (d) blocks it. The eval uses a factory-only `settings.local.json` with a PermissionRequest hook and an allow list identical to what installs ship, and the posture is recorded.
- **Arms:**
  1. OFF;
  2. **Stop-owed only**;
  3. **Stop-owed + write-time pointer**.

  A non-owed-at-write-time arm is added only when that decision is on the table.
- **Design.** A RepoReuse-style 20 chains × 5 turns × 3 seeds = **60 chain-runs per arm**. This is enough to detect a halving of duplicated-logic chains (50% → 25%) at α = 0.05 with power 0.8. The 300 turns per arm resolve a **10-point** non-inferiority margin on pass rate. Smaller effects are reported with CIs, not claimed.
- **Fixtures.** Identifiers are rotated per run; 30% of fixtures are held out.
- **Oracle** (independent of `shapes.mjs`):
  - execution equivalence (a new function that passes a planted helper's own tests under a signature adapter is a functional duplicate);
  - **blind human labels** on a 20% sample;
  - `shapes.mjs`-measured duplication as a secondary metric only.
- **Mandatory metrics:**
  - verbosity and erosion slopes across turns;
  - induced slop (new single-consumer shared exports, wrappers-of-one, shared exports with exactly 2 consumers);
  - **degradation rate** (owed classes discharged as near-misses);
  - Stop blocks per owed class;
  - a downstream follow-up task;
  - tokens.
- **Go-live bars for the owed tier (arm 2 vs arm 1):**
  - pass rate non-inferior (10-point margin);
  - tokens at most +15%;
  - degradation at most 10% of discharges;
  - induced slop not above OFF (CI);
  - all checked together with eval L.
- **Bars for the write-time pointer (arm 3 vs arm 2):** pass rate and tokens non-inferior; degradation not higher; owed-attributable Stop blocks down by at least 30%.
- **Efficacy, H1 (reported, not a go-live bar).** Arm 3 cuts oracle-measured duplicated-logic chains at turn 5 by at least 30% relative to OFF. If it does not, H1 is falsified at that size, and the roadmap is re-ranked toward near-miss graduation and concept-seam gates.

**L. Lift completion** (factory, under the shipped permissions plus the eval posture).
- **Scenarios:** seeded owed classes of four kinds: exact cross-vertical with no reachable member (LIFT); with an importable member (IMPORT); same workspace (MODULE); and an SQL pair (forward migration with a literal parameter).
- **Bars:**
  - ≥ 90% resolved within the block cap and ≥ 70% within 2 Stop blocks;
  - 0 guarded-write denials;
  - after the Lift, all tests pass and no new surviving mutants appear in the lifted function;
  - turns and tokens per Lift are reported.
- **Near-miss graduation** additionally needs a deterministic behaviour-preservation check: both original call sites' tests pass, and no surviving mutants appear at the lifted function.

**E. Field** (consumer telemetry: closed enums, no paths).
- **The discharge enum** (§4).
- **Effective false-positive rate** = (`degraded` + `allowed` + Lifts later reverted or inlined by the rule of two) / owed.
- **A sampled human adjudication** of 20 resolved owed classes a month in the factory dogfood.
- **Reviewer confirm/dismiss rates** per packet family.
- **Issue fix rate** per family (§5).
- **Not used:** "allow rows per 100 owed hits" and "≥ 70% resolved before Stop". Both are blind to evasion and are deleted (evidence H1).
- **Factory release decisions on this data:**
  - retire a family above 30% `not_planned` over at least 20 issues;
  - demote a family whose effective false positives exceed 10%.

---

## 12. Rollout

All PRs land after `stack/52-i37-work-plan` (2.0.0) merges. The order puts each piece of evidence before the component it gates (evidence C1, feasibility M1).

| # | PR | Ships in | Must hold before release |
|---|---|---|---|
| 0 | **Probes**, as print-mode factory scripts recorded as CONTROL-PLANE-FACTS 19–23. Each records the **minimum Claude Code version**, as a `featureFloors` row or a runtime check that stays silent below it. (a) SubagentStart `additionalContext` reaches the subagent (nonce echo); (b) `Agent` `updatedInput` rewrites the prompt; (c) a subagent's own PostToolUse reaches it; (d) the headless PermissionRequest posture; (e) VS Code Edit/Write delivery, recorded once and not re-run | factory | — |
| 1 | **Gate-proposal issues:** the exact-class rule (thresholds frozen after eval A's dev split); members-bound and mirror rows; the rule of two; narrowing `dal-client-value-import` to allow exactly `@app/supabase/errors`; `wire-bound`/`wire-orphan` against `contracts`/`data-flow`. Plus the factory module-slice materialisation test | factory | — |
| 2 | **Scaffold v2** (defect fixes) | base | canary: a scaffolded slice passes the static floor |
| 3 | `closed-text.mjs`; `noteAdvisory`/`noteComplete` (opt-in, per leg; optional `subject` on `rampNote`, printed text unchanged so `graduate` still parses it); NOTE survival; `duplication` converted; the converted-gates ratchet list | base | canary: a NOTE survives a green turn |
| 4 | `shapes.mjs`, `homes.mjs`, `workspace-tiers.mjs` (`tierOf` and the mobile wall move, so the gate has a `tools/*.mjs` consumer and knip stays green); `--sweep --json`, `--explain`; the eval A harness and split; the eval B frozen fixture. **No verdicts yet** | base, factory | eval A dev split; byte-identical on two machines |
| 5 | Eval C, D and L harnesses with the recorded permission posture; OFF baselines | factory | probe (d) |
| 6 | **Lift:** the skill and script, the `packages/shared/*` knip glob, allow-list entries, the hook-contract test, the end-to-end canary; **rule of two** (ramped, advisory) | base | eval L dry run |
| 7a | **Dogfood TS:** #1 and #2 resolved; #13 one write-context builder; #14 a port-narrowing function; #15 mobile parses `CreateNoteSchema`; #10 a `./errors` subpath on `@app/supabase`, the narrowed law, and **notes wrapping `mapPostgresError`**, overriding only its documented arms, with tests pinning every SQLSTATE→kind mapping before and after; #11 the doc made true; #16's doc contradiction fixed to describe today's truth | stack, demo, base (law) | security and architecture reviewers; mapping tests unchanged |
| 7b | **Dogfood SQL (stack only):** a forward migration replacing the three pairs (with `TG_TABLE_SCHEMA` in `deny_mutation` and a `regclass` parameter in the partition functions), a `tenancy.json` update, and a pending source fix for existing installs. Exempt from the net-LOC bar; never advertised through `--refresh-seeded` | stack | security reviewer; `migrations`/`migration-safety` |
| 7c | **Push module:** the codec helpers lifted with the script; a `port.ts`; `APPLY.md` rewritten without the L0 allow row | module | materialisation test green |
| 8 | **Exact rule live** (ramp from 2.1.0, `until` 2.3.0, re-dated unless the evidence holds), canaries, the catalog entry, the chain-budget row | base | **eval A holdout, eval B, eval L, eval D arm 2** |
| 9 | **Write-time hook** (owed and ramp-withheld classes); the author SubagentStop bounce only if probe (c) failed | base | eval D arm 3 |
| 10 | **Dispatch hook:** the change list live; the similarity and touch block dark; the `single-home` companion row; `agents.lock.json` regenerated; `doctor` and the brief name parked hooks | base | probe (a) or (b) |
| 10b | The similarity block enabled at the channel and size eval C chose | base | eval C plus its gate-proposal |
| 11 | **`advisory-issues` module** | module | sanitiser golden, permission pin, red canary, recorded dry run |
| 12 | Embeddings: prototype, then module | factory → module | §6 bars |
| 13+ | **Graduations, each with its own gate-proposal and ramp:** the same-signature cross-workspace near-miss (pre-committed if degradation exceeds 10%); #9/#10 complexity families as advisories; a "parallel export-name set" family (Dogfood #16); `packages/shared/*` added to the mobile wall if pure | base | eval A + E (plus behaviour preservation for near-miss Lifts) |

---

## 13. Risks and failure modes

1. **A probe fails.** If (a) fails, the nonce-wrapped (b) is used. If both fail, there is no packet and `null(probe)` is logged. If (c) fails, the author bounce is used, capped at 2. Verdicts are unaffected.
2. **A false owed finding stalls autonomy**, because only a human applies an exemption.
   - Mitigations: FLOOR 30, measured to leave only 2 true classes in the template; literal-differing moves are parameterised; a class with no legal home is advisory; eval L comes before go-live; the cap-hit trigger counts every cause.
3. **Cosmetic divergence (degradation).** It is measured as an enum, and its graduation is pre-committed.
4. **A parallel merge turns main red.** This is loud rather than silent. The fix is a Lift, and the docs recommend a merge queue.
5. **An existing install has many classes.** It gets a ramp NOTE with counts and issues during the ramp. Harness-shipped duplicates arrive as pending source fixes.
6. **A wrong mirror row hides slop.** Mirror rows are reviewed data scoped to corresponding paths, and eval B labels every silent hit.
7. **Packet anchoring or displacement.** The similarity block stays dark until eval C's displacement test passes.
8. **Parse cost at scale.** Watched by the chain-budget row (about 2–2.5 s at 200k LOC cold), with oxc in reserve.
9. **Issue fatigue.** Mitigated by the caps, baseline mode, the fix-rate falsifier and retirement as a release decision.
10. **Workflow compromise.** Mitigated by split privileges, blocked egress, closed records, closure caps and the anomaly guard.
11. **A TypeScript major drops `createSourceFile`.** The parser-absent semantics apply (L0 and `boundaries` keep deciding), and the contingency is in the catalog entry.
12. **A lifted package needs a root tsconfig reference.** The PR 6 canary detects this. The fallback is for the installer to derive `packages/shared/*` references on `update`, as `tsconfig-references.mjs` already does for verticals.
13. **The mobile wall keeps web↔mobile classes advisory.** A graduation candidate adds pure, kernel-only shared packages to `MOBILE_UNIVERSAL`.
14. **Maintainer load.** There are no closed constants, one adapter, deterministic evals A and B in CI, and C, D and L are re-run only on change.
15. **The SQL unification weakens the audit trail's independence.** Security review is owed. Decision Q8 offers allow rows as the alternative.

---

## 14. Open empirical questions

These are what the probes and evals exist to answer; they are not decisions.
1. Does SubagentStart `additionalContext` reach the subagent, and from which Claude Code version (probe a)?
2. Is the 30-token floor's precision still 1.0 on the holdout and on the blind third vertical (eval A)?
3. Does pushing near-miss and touch facts help Claude reviewers, or displace their other findings, and is pull better (eval C)? AACR-Bench says the sign depends on the model.
4. Do write-time pointers reduce duplication, or only relocate it into paraphrase (eval D degradation rate)?
5. Can an agent complete a Lift within the block cap under the shipped permissions (eval L)?
6. Do advisory issues get fixed without a loop (field fix rate)?
7. Do embeddings add recall over a signature-plus-name-token index (the §6 prototype)?

---

## Decisions needed from the maintainer

1. **Do you accept one blocking rule:** exact classes of TS functions and SQL functions, judged on the whole tree, at or above a floor of 30 normalised tokens (frozen by eval A), with everything else advisory?
   *Recommended: yes.* It is the only rule whose precision the template itself demonstrates, and it removes every base-resolution problem.
2. **Should a human remain the only second principal for exemptions** (`apply-proposal`), with no bot identity?
   *Recommended: yes.* Revisit only if the cap-hit data shows more than 5% of owed-red turns stall on pending proposals.
3. **Should advisory issues cover "every class-A advisory CI can recompute", phased in from duplication plus lanes, shipped as `advisory-issues` on by default for new installs and opt-in for existing ones?**
   *Recommended: yes.* It honours "advisories become issues" without silently widening an existing repo's token permissions.
4. **Should an agent-fix loop for issues be on the roadmap?**
   *Recommended: yes, as its own design.* Start it only after probe (d) and 60 days of fix-rate data, with key-only input and no auto-merge. Without it, issues are a ledger, and the autonomy goal is not met for the advisory tier.
5. **Should the review-time similarity and touch facts ship dark until eval C passes, with only the change list live?**
   *Recommended: yes.* The best evidence (AACR-Bench) says pushed context can cut a non-agent Claude reviewer's F1 by 31%.

   > **Fact-check:** `w1-agent-context-retrieval-sota.md` (summary 1, Q2) scopes the −31% to one *non-agent* reviewer (Claude-4.5-Sonnet with BM25 top-3). The same benchmark found that agent reviewers *improved* with repo-level context. The harness's reviewers are agents with Read, Grep and Glob, so AACR-Bench is weaker support for keeping the block dark than this line implies. The recommendation still stands, because eval C decides the question either way.
6. **Should agents be allowed to run `pnpm install --offline` and the Lift script without a prompt?**
   *Recommended: yes, exactly those two entries.* `--frozen-lockfile` in CI and the dependency gates still judge the result. Without them a LIFT move cannot be executed.
7. **Which single embedding adapter should v1 ship?**
   *Recommended: hosted `voyage-code-4`, pinned snapshot, with the training opt-out recorded before the first call.* The layer runs only in a scheduled CI job, where a local model server is impractical. Local Qwen3-0.6B can follow as a second adapter if demand appears.
8. **Three dogfood behaviour calls.**
   - (a) Notes keeps its `conflict` semantics for 23503/23514 by wrapping `mapPostgresError`. *Recommended: yes.* They are documented and pinned.
   - (b) The SQL pairs are unified by a forward migration rather than allow-rowed. *Recommended: yes, subject to security review.* The functions are invoker-rights, so parameterising widens nothing.
   - (c) The mobile primitive sets. *Recommended:* fix the docs to today's truth now (`src/components` is what is wired), and choose the surviving set in a separate ADR, because adopting `design-system-native` requires NativeWind in `apps/mobile`.

---

## Appendix A: Rebuttals

Each rebuttal is short, cites the evidence, and records where v2 deviates from a critic's specific remedy while still meeting its goal.

- **R1. Keep `--explain` (taste M4 deletes it).** It has two consumers: the issue body's only actionable line (doctrine H4 requires a re-derivation command) and the future loop's key-only contract. It is a filter over `--sweep`, about 20 lines.
- **R2. Rows bind member subjects, not a member count (taste C1).** A count allows a swap into an unreviewed context (delete A, add C, count unchanged) and loses the Juergens signal. Subject binding meets doctrine C1 exactly. The cost is that renaming an accepted member needs a human row edit, which is rare. A consistent edit to both sides is not a red (`accepted-class-changed` is advisory), which answers evidence M4's stall concern.
- **R3. Rows are keyed by members with the fingerprint as evidence (evidence M4 suggests the same).** The difference is that a changed fingerprint is surfaced as an advisory, not ignored.
- **R4. `home(class)` does not pick "an existing package at that altitude" mechanically (taste H1).** Placing code by altitude alone ignores cohesion, which is rubric (a)/(e). It would put row-array coercion into `@app/contracts` or `@app/errors`. The default printed move is `packages/shared/<concept>`, the home the rule files name, and the gate accepts any legal resolution that dissolves the class.
- **R5. The slot list stays in `scaffold-slice.mjs` (taste H4 suggests moving it to `vertical-anatomy.mjs`).** `shapes.mjs` no longer needs slots. A `tools/lib` export consumed only by a skill script would red `knip --strict` (feasibility M1(4)). One list remains, and it is the one that already exists.
- **R6. No inline reason marker (doctrine L3).** Markers are deleted (taste C1). The duplication register is register-only by precedent (every L0 row). With member binding, a marker copied with the code would grant nothing. `--explain` shows the accepting row for any class member, so the next reader still finds the reason.
- **R7. No novelty base at all (doctrine H1, feasibility H1).** Their remedies were default-branch merge bases, `event.before` on push, SessionStart-recorded bases and failing when the base cannot be resolved. Whole-tree judgment (taste C2) removes the base, so it satisfies all of them more strongly. The canary feasibility asked for ("a copy committed and pushed with no PR must red") holds trivially.
- **R8. Degradation stickiness without a merge base (evidence H5).** The critic's first remedy needs "new against the merge base", which no longer exists. v2 adopts its alternative, a pre-committed graduation if degradation exceeds 10%. It ships as a factory release decision with a ramp, not "automatically", because doctrine M5 forbids runtime tier changes.
- **R9. Go-live is conditional, not only expiry (evidence C1, strengthened).** Ramps protect only older installs. Fresh installs meet the rule live, so the release itself waits for evals A, B, L and D arm 2.
- **R10. Eval C is sequenced, not a full factorial (evidence H4).** Push vs pull vs diff-only runs first at top-3, then size and family ablation runs on the winner only. This keeps the required n (at least 10 BLOCK cases per reviewer per kind, at least 10 runs) at about 5,500 runs instead of about 11,000.
- **R11. Complexity signals are staged, not deleted (taste M1).** They are deleted from packets as the critic asks. #9 and #10 return as measured advisory families, because the user explicitly asked that unnecessary complexity be recognised.
- **R12. Eval D is not re-run per graduation (feasibility H2, adopted).** Near-miss graduation still needs evidence H7's behaviour-preservation check.
- **R13. The `embeddings` module exists even under +5 points (feasibility M8: "build only after the prototype passes").** The user decided there is an optional layer. Below the bar it ships dashboard-only, files no issues, and is labelled with its measured lift, with one adapter to limit maintenance.
- **R14. Scaffold refusal is removed rather than tightened (doctrine C1's remedy for rule 2).** Rule 2 is deleted (taste H4). The third copy reds the moment it is written, which meets doctrine's goal without a second enforcement point.
- **R15. A same-run artifact for embedding inputs (doctrine M6 says "job output").** Function text exceeds the 1 MB job-output cap at scale. The producing job holds no secret and no write permission, the consuming job schema-checks its input, and nothing crosses workflows.
- **R16. A per-session "already told" set is kept (taste M6 deletes "the overlay").** The novelty overlay is deleted. The once-per-class and three-per-prompt write-time caps need this bookkeeping, and no verdict reads it.

---

## Appendix B: Change log v1→v2

**Critic issue ids:**
- doctrine-security: D-C1, D-H1…H5, D-M1…M6, D-L1…L4
- evidence: E-C1, E-C2, E-H1…H7, E-M1…M4
- taste: T-C1, T-C2, T-H1…H4, T-M1…M6, T-L1…L3
- feasibility: F-H1…H3, F-M1…M8, F-L1…L3

**Model and verdict**
- Exact pairs are replaced by **clone classes**, keyed by fingerprint: one red, pointer, packet line and issue per class (T-C1).
- Diff-scoped novelty is replaced by **whole-tree** judgment. Deleted: the merge-base index, the novelty triple, move exclusion, `legacy`, the overlay's novelty role and v1 risk 4 (T-C2, D-H1, F-H1, D-M3, E-H5(b,c)).
- **Verdicts never read a cache.** Stop and CI parse cold; the CI blob cache is dropped; the cache key is the extractor digest plus `ts.version`; the concurrency claim is corrected (D-H2, F-M4).
- The name clause is deleted; there is one floor, starting at 30 and frozen by eval A, backed by prototype measurements (T-H3, E-H2).
- **One normaliser** for TS and SQL; σ-substitution and `shape` are deleted; MinHash runs only in the sweep and packet builder; postings, worker threads and the overlay are deleted (T-L1, T-M6, F-M4).
- New: `lit` hash, the exact-small band and **literal-parameter moves**, so IMPORT never silently changes a literal (new; E-H3).
- L2, the D-rules, `promotion-candidate`, `#27` and `home-unreachable` are deleted. `home(class)` (IMPORT / MODULE / LIFT / NONE) and the "no legal home → advisory" rule are added (T-H1, T-M1).
- Parser absence no longer skips L0 or the `boundaries` laws (F-M5).

**Register and exemptions**
- Rows are **bound to member subjects**. A third copy or a swap reds; `accepted-class-changed`/`-diverged` and `stale-row` are advisories with `--prune` (D-C1, E-M4, T-C1).
- Source markers and the census are deleted. Stale advisory-tier rows never red (T-C1, D-M2).
- `DELIBERATE_TWINS` becomes **mirror rows** scoped to corresponding paths, collapsing nine L0 rows into two (T-M2, D-M4).
- `HARNESS_HOMES`, the pre-shipped `pg-errors`/`postgrest-rows`/`keyset` packages and the rule of two's exemption are deleted (T-H2, D-L4, F-M7(1)).

**Lift and scaffold**
- The Lift writes only its own package and the consumers' own manifests. The knip glob is shipped. The script and `pnpm install --offline` are allow-listed. Added: the hook-contract test and the end-to-end canary (D-H3, F-H3).
- Lift input is `--class <fp>` plus a validated concept, with no interpolated symbols (D-L1).
- Scaffold v2 is reduced to defect fixes. Rules 2 and 3, `SLOT_RULES`, `slot`/`alt` and `// sibling:` are deleted. A port-narrowing function replaces the per-site cast (T-H4, E-H2).
- The rule of two parses imports textually (no parser dependency) and has no exemption (F-M5, T-H2).

**Delivery**
- The write-time hook carries owed **and ramp-withheld** classes. The Stop green recipient is corrected to the user (F-L2).
- Fallback 2 and its body line are deleted. The rendered packet cache becomes structured records re-rendered at every serve. Fallback 1 uses a nonce delimiter. If both probes fail, there is no packet (D-H5, T-M5, F-M6(ii)).
- Owed pairs are removed from packets (a count only); "do not re-raise" is deleted (T-L2, E-H4).
- The similarity block ships dark until eval C. The change list ships live. "Touch" facts come from `query-shapes.json` (E-C1, user decision 1).
- Deleted: `## Reuse`, the Step 0 pull line, `--neighbours` and author briefs. `--explain` is kept (T-M4; Rebuttal R1).
- IMPORT/LIFT for exact matches only; "differs at" facts with WRAP/JUSTIFY for near-misses; the "no suggestion can red" claim is withdrawn (E-H3).
- Names go in code spans, arguments are single-quoted and `$` is rejected (D-L1).
- Added: the warmer, single-flight builds, the `null(cold|deadline)` telemetry, and the author SubagentStop bounce as the probe (c) fallback (F-M3, F-M6(i)).
- `doctor` and the brief name parked hooks (F-M7(2)).

**Enforcement**
- Go-live is conditional on evals A, B, L and D arm 2; `until` is re-dated rather than silently expiring (E-C1).
- Tier changes are factory release decisions, with a constants test (D-M5).
- The cap-hit trigger counts every cause (E-H7).
- The monotonicity claims are rewritten; the discharge enum and the degradation rate are added, with a pre-committed graduation (E-H5, E-H1).
- The thesis is restated as hypothesis H1, with a coverage table (E-M1).

**Issues**
- v1 sources are cut to the sweep and lane conclusions. The every-NOTE check is deleted. Gates convert one at a time (T-M3, F-M2).
- The **closed record schema** removes free text; a golden test checks body bytes (D-H4).
- Per-leg terminators; a separate `embeddings` producer (D-M1).
- Compute recomputes and sync only applies. Added: closure caps and the anomaly guard (D-L2).
- The marker carries `miss`/`last`, the dashboard paginates, the real compute cost is stated, and the `doctor` staleness check is deleted (F-L1).
- Exact-family issues are keyed by fingerprint (T-C1).
- The fix-rate falsifier is added, and "issues are a ledger without the loop" is stated (E-M2).
- The "all advisories" recommendation is restated as a phased end-state. A default-on module for new installs is recommended (user decision 2).

**Embeddings**
- One adapter; `bits.u32` dropped; producer id `embeddings`; deterministic candidate buckets (T-L3, F-M8).
- Split jobs with egress blocked; the payload is limited to indexed function bodies (D-M6).
- Baselines are the signature-plus-name-token index and agent-grep. At least two corroborators are required, one non-signature. Calibration uses a labelled full-tree top-K (E-M3).
- Prototype before module (F-M8; Rebuttal R13 on the under-+5 outcome).

**Evaluation**
- Eval A: seam-constructor decoys, a 70/30 split with thresholds frozen first, a blind third vertical; owed recall becomes a unit test (E-H2, E-H6).
- Eval B: precision over all hits, a frozen pre-dogfood fixture, an external monorepo, the second-vertical scenario and coverage (E-H6, F-M1, E-M1).
- Eval C: near-miss BLOCK cases only, the displacement re-run, push / pull / delivery-faithful arms, size ablation, confirm/dismiss and a power-based n (E-H4).
- Eval D: an independent oracle, three arms, 60 chain-runs per arm, a 10-point margin, pre-registration, holdout, rotation, slopes, induced slop, degradation; probe (d) is blocking; the permission posture is recorded; cost is stated; it re-runs only on change (E-C2, F-H2).
- **Eval L** is new (E-H7).
- Eval E: effective false positives redefined; the vanity metrics deleted; human sampling; fix rate (E-H1, E-M2).

**Rollout and migration**
- New order: probes → gate-proposals → scaffold fix → recorder → index → eval harnesses → Lift → dogfood (made with the script) → rule live → write-time → dispatch → issues → embeddings → graduations (F-M1, E-C1).
- The SQL migration is its own stack-only PR, exempt from net-LOC and not advertised through `--refresh-seeded`. Existing installs get a pending source fix (F-M7(3,4)).
- `mapPostgresError` is made reachable in place: a `./errors` subpath, a narrowed law, a wrap with pinned mappings. The net-LOC framing for it is dropped (T-H2, E-H3).
- Probes are automated, with minimum versions recorded; (e) is record-only (F-M6(iii, iv)).
- Every new `tools/lib` export has a `tools/*.mjs` consumer in the same PR (F-M1(4)).
- `tierOf` and the mobile wall move to `tools/lib`; `.dependency-cruiser.cjs` is evaluated in-process (F-L3).

**New in v2 and not requested by any critic**
- The prototype measurements (§2.4, §10).
- Dogfood findings #1, #2, #8, #11, #12, #14 (the scaffold prescribing the cast) and #15 (mobile skipping the refinement while claiming otherwise).
- The literal-parameter move.
- The module-slice materialisation test.
- The `accepted-class-changed` advisory.

---

## Appendix C: Fact-check log

I checked every claim against the stack-head tree (`b158f5a`, `stack/52-i37-work-plan`, 2.0.0, which is confirmed) and against `design/research/20261001-context-paradigm/*`. Token counts and class counts were re-measured with an independent re-implementation of §2.2 for TS, run on materialised trees with Node 22.22.0 and typescript 6.0.3: default = stack, then + demo, then + the push `.ts.txt` slice. The existing L0 gate was also run on each of those trees.

**Corrections made in place**

1. Executive summary 2 and §1 H1: 36 → 37 validate steps (`T/AGENTS.md:82` lists 37 at the stack head; `web-compile` joined at 1.1.0).
2. §1 paradigm, §9 and Decision 5: AACR-Bench "−31% F1 for Claude" → "for a non-agent Claude reviewer". The research scopes the figure that way (`w1-agent-context-retrieval-sota.md` summary 1); §9's source is now "summary 1, Q2".
3. Dogfood #2: `S/apps/mobile/src/i18n/index.ts:136-139` → `:135-139`. The listener `Set` is at `:135` and `emit` at `:137-139`, matching `theme.ts:51-55`.
4. Dogfood #3: "MODULE with 1 literal parameter" → "2 literal parameters". The two `deny_mutation` bodies differ at two literal positions, the `RAISE` message and the `HINT`, and §2.3's `params` counts positions.
5. Dogfood #6, "Caught by today's gates?": "Partly … `isRealTimestamp` is missed" was false. On a materialised push tree, L0 reports one 479-token clone (fingerprint `1a422003961a`, notes `cursor.ts:1-129` ↔ push `cursor.ts:1-112`) that spans all three helpers. The APPLY.md range `238-256` → `234-257` (section 7), which allow-rows one fingerprint.
6. Dogfood #12: `push-tokens.ts.txt:43-78` → `:43-75`. The port ends at `PushTokensDatabase`; `:77-81` is the write context, which notes keeps outside `port.ts`.
7. §2.1 "One register": `enforcement-surface.mjs:14` → `:88`. Line 14 is the `ESCAPE_LISTS` declaration; the `duplication-allow` entry is line 88. I also added that the current validator reds any row without a string `fingerprint` (`check-duplication.mjs:90-102`), so mirror rows need the validator change.
8. §2.2 Parser absence: corrected the role of `noteMissingPrerequisite` (`T/tools/lib/gate.mjs:169`). It only appends a `--ci-parity` report record. The NOTE/FAIL is the gate's own fail-closed leg.
9. §2.5: "Shape errors … still red, as today" is now qualified. Today the validator checks only a string `fingerprint` and a non-empty `reason`; the 20-character and `rule` checks are new.
10. §4: `hookio.mjs:50-60` → `T/.claude/hooks/lib/hookio.mjs:57-61`, where the "enumerated values … never … paths" rule is.
11. §5: `scripts/check-obligations.mjs:22-27` → `:23-28`.
12. §6: "8 ms per query at 5k×1024" is the f32 figure. The int8 store measures 12 ms (`w2-embeddings.md` §4). Also noted that `tools/embeddings.config.json` needs a new guard row, because no `WRITE_PROTECTED` entry matches it today.
13. §9 citations:
    - "best-documented failure" → `w1-ai-slop-evidence.md` summary 2, Q2 (it is not in Q1).
    - eval D design → eval design §1, §3, §6 (identifier rotation is §1).
    - Tricorder wording → "not useful" feedback loop, which is what Q7 says; "no positive action" is not in the file.
    - "assertions deleted" → adds Q3.
    - search-API duplicates → `w2-issue-sync.md` §1–4 (it is in §1).
14. §10 eval D: "52.7 s measured, plus `rls-isolation`" → "52.7 s measured with stamps warm, `rls-isolation` included". `scripts/chain-budget.json` `stopWall` covers all 10 Stop steps.
15. §11 C: `reviewer-eval.mjs:51-56` → `:50-55`.

**Fact-check notes inserted (design-relevant; the design was not rewritten)**

- N1, §2.3 NONE: `tools/exports-walls.json` has no write-guard row, so an agent can add a census entry in-turn. Only CODEOWNERS and the bash guard cover it.
- N2, §2.4 floor table: `noteCreated` / `noteDeleted` (`D/…/notes/src/events.ts:109,134`, 44 tokens, literal-only difference) is an exact class absent from the tables. It accounts for every +1 in the demo and push columns. It is either data-shaped (then say so) or a third owed demo class that PR 7a and eval B must handle.
- N3, §3 "differs at" example: the case labels are named constants (`FOREIGN_KEY_VIOLATION`, `CHECK_VIOLATION`, longer than 12 characters), so the label printer yields `#n`. Printing `23503` requires resolving constants to literal values. "B only: 4 arms" holds only as case-clause groups; there are 6 labels.
- N4, §3 printers: `PATH_RE` (`harness-brief.mjs:52`) rejects `()[]`, so app-router paths (Dogfood #14, #15) print as `(unprintable)`.
- N5, Decision 5: AACR-Bench's −31% is for a non-agent reviewer, and agent reviewers improved with repo context. The recommendation stands on eval C.

**Verified as written (no change)**

- **Paths and lines:**
  - `T/.claude/settings.json:8`, `:11-26`, `:215-216`; `T/gitignore:58-61`
  - `installer/lib/layout.mjs:212` (`SEEDED_FILES`); `guard-rules.mjs:605`; `installer/lib/proposals.mjs:60`
  - `check-duplication.mjs:27-31`, `:44-63`, `:72-104`, and its `.ts`/`.tsx`-only walk
  - `i18n-tree.mjs:98`; `sql-parse.mjs:1045`; `harness-brief.mjs:51-68` (private)
  - `check-workspace-deps.mjs:16-18`, `:34-45`, `:34-70`, `:104-120`, `:142`
  - `vertical-anatomy.mjs:243-253`, `:255-269`; `T/dependency-cruiser.cjs:24-41`
  - `T/pnpm-workspace.yaml:7`, `:13-16`; `T/knip.json:127`
  - `posttool-source-check.mjs:101-113`; `architecture-reviewer.md:9`, `:26`, `:55-56` (quote exact)
  - `gate.mjs:316-323`, `:426`; `T/docs/harness/README.md:255-270`; `update.mjs:434`
  - `check-contract-drift.mjs:50-56`; `quality-gate.yml:3`; `git-diff.mjs:76-79`
  - `reviewer-eval.mjs:72`; `scaffold-slice.mjs:104`, `:108`
- **Dogfood rows:** every other cited line and quote in rows 1–22 is exact. This includes `errors.ts:18-21`, `:69`, `:89-97`, `:121`, `:134`, `:150`, `:174`, `:185`; `useCreateNote.ts:135-139`; `note.ts:36-37`; `PARITY.md:27-29`; `mobile-screen.md:88` vs `:110`; `package.json.tmpl:13-16`; and the SQL lines `196/132`, `388/246`, `442/283`.
- **SQL:** the pairs differ only in literals and comments, and all six are invoker-rights. `tenancy.json` names only `audit.deny_mutation`.
- **Register:** `duplication-allow.json` has 10 rows (6 design-system, 3 i18n with the three cited fingerprints, 1 sign-in/up).
- **Gates and harness facts:**
  - The L0 gate reds `publicCredentials`, `subscribe` and `asRowArray` on no tree.
  - CONTROL-PLANE-FACTS ends at Fact 18, so 19–23 are free; Fact 16 (`systemMessage` reaches the user) and Fact 18 match the plan.
  - The `duplication` row: 310 ms, 15 s ceiling.
  - The TS load measures 221–233 ms, or about 95 ms with the compile cache.
  - No `issues: write` exists in the scaffold.
  - `CHANGELOG.md:16` calls 2.0.0 "the opt-in release"; `doctor` makes no network calls.
  - `'11 3 * * *'` is `quality-gate.yml:34`.
  - Eval C's 110 cases are 100 new plus 10 existing.
  - `apply-proposal` is bash-guard-denied; `knip.json`, `pnpm-workspace.yaml`, the root `tsconfig.json` and `.harness/` are write-guarded; consumer `tsconfig.json`/`package.json` are not.
- **Research figures:** 50.8%; 2× redundancy; copy/paste over moved in 2024; CodeThread; 29.6% and 46.8%; RefactorBench 22% vs 87%; CodeTaste 69.6%; 76% EM-Assist; RepoCoder; Juergens; RNR; Infer 70% vs 0%; Tufano; Cihan; A3-CodGen with more than 5; 2503.20589; ExecRetrieval 0.33; 97.5%; 65,536; the egress allowlist; 52.7 s; `voyage-code-4` 512/int8; Qwen3-Embedding-0.6B; the opt-out.

**Not verifiable from the committed research**

- The feasibility critic's 278k-LOC figures (1.9 s / 1.5 s, 16.8k callables) and all critic issue IDs: no critic files are present.
- The prototype timings 0.48 / 0.54 / 0.59 s. My unoptimised re-implementation takes 0.59 / 0.70 / 0.64 s including process start, so they are plausible.
- `J 0.81` in the advisory example.
- The codec token counts 168 / 106 / 58. Mine are 165 / 104 / 59, a difference of convention.
