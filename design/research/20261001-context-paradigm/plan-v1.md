# Single Home v1: prevent at birth, owe exactly, lift executably

*Paths: `T/` = `template/base/`, `S/` = `template/stack/`, `D/` = `template/demo/`, `P/` = the push module's `slice/`, all at stack head `b158f5a`. Lineage: the chassis is minimal-core (the doctrine and feasibility judges' pick). Prevention-loop's birth-moment ideas are co-equal, because the outcome judge is right that the chassis alone treats symptoms. Everything doctrine forbids is dropped.*

## 1. Name and thesis

**Single Home** is named after the architecture reviewer's rule: "a diff that edits the same fact in three places names the missing single home" (`T/.claude/agents/architecture-reviewer.md:55-56`).

Most slop that gets past 36 gates is a second copy of something that has, or should have, one home. In this tree the causes are structural:
- `scaffold-slice.mjs` creates no `data/{port,rows,errors,query-probes}.ts` and writes a stale web path (`T/.claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs:108`).
- The rules name `packages/shared` as the home for shared code (`T/dependency-cruiser.cjs:24-41`), but it does not exist.
- The canonical `mapPostgresError` (`S/packages/platform/supabase/src/errors.ts:134`) has **zero production consumers**, although its doc forbids re-deriving the SQLSTATE table (`:121-126`). The reason is the tree's own law `dal-client-value-import` (`T/tools/lib/vertical-anatomy.mjs:243-253`), which bars verticals from value-importing `@app/supabase`. So notes re-derived the table (`D/packages/verticals/notes/src/data/errors.ts:18-40`), and so did push (`P/…/push-tokens.ts.txt:152`).

What is new is the answer at the moment and altitude this harness already owns:
1. **One fact table.** A deterministic function-shape table lives inside the existing `duplication` gate. Plan, scaffold, PostToolUse, SubagentStart, Stop, CI and the nightly sync all read it, so pointer, packet line, red and issue are one fact.
2. **A scaffold that wires each slot to its reachable home.** It also refuses to begin the third copy.
3. **An executable Lift into `packages/shared`.** Reachability is checked mechanically, and a rule-of-two brakes over-abstraction.
4. **Obligations that are pure functions of tree, merge base and one register.** Exact copies a diff introduces are owed. Near-misses are advisory until measured. Nothing records what an agent was shown.

## 2. Architecture

### 2.1 Components

| # | Component | Location | Extends | Ships |
|---|---|---|---|---|
| C1 | Shape extractor and index | `T/tools/lib/shapes.mjs` (owned, hash-pinned) | `loadParser()` (`T/tools/lib/i18n-tree.mjs:98`); duplication scan roots (`check-duplication.mjs:44-63`); `sql-parse.mjs` | base |
| C2 | L1 rules and marker census | `T/tools/check-duplication.mjs` | The `duplication` Stop step (`T/tools/stop.floor.json:9`) and CI `unit` job (`T/github/workflows/quality-gate.yml:206-210`; full history at `:155-158`) | base |
| C3 | Recorder | `noteAdvisory()`/`noteComplete()` in `T/tools/lib/gate.mjs` | Mirrors `noteMissingPrerequisite` (`:169-178`); `rampNote` (`:283`) routes through it | base |
| C4 | NOTE survival | `T/.claude/hooks/stop-validate-gate.mjs` | `NOTE_RE` beside SKIP/STAMP/FALLBACK (`:183-196`, `:268-276`); green `systemMessage` (`:394`) | base |
| C5 | Write-time pointers | `T/.claude/hooks/posttool-neighbours.mjs` | 3rd entry of the Edit/Write group (`T/.claude/settings.json:11-26`); invoked directly; always exits 0 | base |
| C6 | Dispatch briefs | `T/.claude/hooks/subagent-neighbours.mjs` | 2nd SubagentStart entry; invoked directly; always exits 0. Leaves `subagent-verdict.mjs`, `LEDGER_FORMAT` and R01/B03 untouched: `subagent-verdict.mjs` is fail-closed via `launch.mjs` and shared with SubagentStop (`settings.json:84-106`) | base |
| C7 | Closed printers | `T/tools/lib/closed-text.mjs` | `NAME_RE`/`PATH_RE`, moved out of `harness-brief.mjs:51-68`, where they are private | base |
| C8 | Query modes | `check-duplication.mjs --neighbours \| --explain <key> \| --sweep --json` | The gate's CLI | base |
| C9 | Scaffold v2 and Lift | `scaffold-slice.mjs`; skill `lifting-shared-code/scripts/scaffold-shared.mjs` | `scaffold-slice.mjs:36-180` | base |
| C10 | `shared-rule-of-two` | `T/tools/check-workspace-deps.mjs` | `boundaries`, which is in the frozen CI floor (`T/tools/validate.floor.json:12`) | base |
| C11 | `single-home` companion row | architecture and torvalds bodies (`torvalds-reviewer.md:99-106`) | Restates `duplication` | base |
| C12 | Issue sync | `advisory-sync.yml`, `tools/ci/sync-advisories.mjs` | — | module `advisory-issues` |
| C13 | Semantic sweep | `tools/ci/semantic-sweep.mjs` | — | module `embeddings` |

**The one register** is `T/tools/duplication-allow.json`. It is already seeded (`installer/lib/layout.mjs:212`), write-guarded (`guard-rules.mjs:605`), in `ESCAPE_LISTS` (`enforcement-surface.mjs:88`) and `PROPOSABLE` (`installer/lib/proposals.mjs:60`). Its rows gain an optional `rule`, which the existing validator already tolerates (`check-duplication.mjs:84-103`).

**Caches** live in `.harness/context/`, which is git-ignored (`T/gitignore:58-61`) and denied to agent writes (`settings.json:215-216`).

**C1's closed, owned constants** are `DELIBERATE_TWINS`, `SLOT_RULES` and `HARNESS_HOMES`.

### 2.2 Parser

**TypeScript.** The project's own `typescript`, syntax-only, loaded through `loadParser()`. Hooks call `module.enableCompileCache()`, which cuts the load from about 215 ms to about 130 ms. If the parser is missing, `skipOrFail` applies (`gate.mjs:182`): a NOTE locally, a FAIL in CI.

**SQL.** `sql-parse.mjs`, folded last-wins.

**Refused:** oxc, tree-sitter, ast-grep and libpg_query. A warm parse plus α plus MinHash over the 49k-LOC template measured about 0.39 s, so none of them is needed.

### 2.3 Records

```json
// .harness/context/blobs/<aa>/<blobSha>.json — key: blob sha + EXTRACTOR_VERSION
{"v":1,"fns":[{"name":"asRowArray","exported":true,"line":80,"end":82,"tokens":26,"stmts":1,
  "alpha":"3b1e0c9a77d2","shape":"c04f…","mh":"<b64 64×u32>","sig":"(data: unknown) => readonly unknown[]",
  "pass":null,"dataShaped":false,"slot":"rows","alt":"vertical"}],
 "imports":[{"from":"@app/errors","names":["appError"],"type":false}],"tables":["notes"]}
```

**`alpha`** is rename-invariant. Bound names become `$1…$n` and the function's own name becomes `$f`, while free identifiers and properties are kept. Literals become `S` or `N`, and comments are dropped.

**`shape`** maps identifiers to `I` and properties to `P`, drops types, and adds a 64-permutation MinHash over 4-grams (FNV-1a, fixed seeds).

**`slot` and `alt`** come from `SLOT_RULES`: path plus the `vertical-anatomy.mjs` behaviour keys.

**SQL bodies** are hashed after replacing schema names with `σ`, **inside string literals too**. The two `deny_mutation` bodies differ only in `'audit.events…'` vs `'auth_trail.events…'` (`S/supabase/migrations/20260202000000_audit.sql:196-206`; `20260816000000_auth_event_trail.sql:132-142`).

**Postings** go to `.harness/context/postings/<aa>.jsonl`, written tmp-then-rename. Keys: `a:` alpha, `s:` shape, `b<i>:` band, `t:` table, `x:<pkg>#<export>` importers. C5 keeps a per-session overlay. The merge-base index parses only the base blobs of changed files.

### 2.4 Layers, tiers, signals

| Layer | Match | Tier |
|---|---|---|
| L0 (exists) | Type-1, ≥70 tokens and 6 lines, whole tree | owed |
| **L1a** | Equal `alpha` across files, with ≥30 tokens **or the same declared name and ≥12 tokens**. The name clause excludes route-convention basenames (`page\|layout\|loading\|error\|not-found\|template\|default\|route`, `_layout`) and `dataShaped` functions | **owed, diff-scoped** |
| **L1s** | Equal σ-normalised SQL bodies on the folded state | **owed, diff-scoped** |
| L1b | Equal `shape`, or verified MinHash J ≥ 0.80 with equal arity. Both sides need ≥30 tokens, ≥2 statements and RNR ≥ 0.5, and must be neither data-shaped nor mostly JSX | advisory |
| D-rules | `twin-drift`, `wire-bound`, `wire-orphan` | advisory; recorder-only until precision ≥ 0.90 |
| L2 | `table-home`; `single-consumer` (#9, `port.ts` exempt); `pass-through` (#10); `fan-in` (#15); `home-unreachable` | context |

**The name clause makes `asRowArray` owed.** It is one statement of 26 tokens (`D/…/notes/src/data/rows.ts:80-82`), alpha-equal to `P/…/push-tokens.ts.txt:121`. If eval A records a single false owed hit on a decoy, the clause ships advisory.

**When a pair is "new".** At least one side must be a callable whose `(file, name, alpha)` is absent from the merge-base index of `reviewChanges()` (`T/tools/lib/git-diff.mjs:111`). That is the reviewer ledger's own base, and follows the precedent of the diff-scoped `check-diff-coverage.mjs`.
- **Moves** are excluded: an alpha equal to a callable deleted in the same diff does not count.
- **No upstream:** the base is HEAD.
- **Unchanged pairs** are `legacy`: recorded, never owed.

**LSH** uses 16×4 bands. A bucket with more than 50 members is an idiom: counted, never paired.

**`DELIBERATE_TWINS`** is closed and doctrine-cited.
- *Excluded:* the design-system web/native mirror and the i18n catalogs (`T/tools/duplication-allow.json:5-42`).
- *Downgraded to advisory `twin-drift` subjects, because they have already drifted:* router ↔ Server Action, `action-outcome.ts` ↔ `trpc/normalize.ts`, and RSC seam ↔ `useListQuery`.

**Signals:**
- **#27 bypassed helper:** the other side is a home export.
- **#28 superseded symbol (`new-near-miss`):** an L1b pair *absent at the merge base*. It is pair-level, so editing an old function into likeness also counts.
- **`promotion-candidate`:** an exact group in one converge slot across ≥2 verticals.
- **`twin-drift`:** argument shapes passed to the shared function differ, e.g. `ctx.now` vs `new Date()` (`D/packages/api/src/routers/notes.ts:44-51`; `D/apps/web/app/actions/notes.ts:76-81`).
- **`wire-bound`** (#6): `*_MAX` ≠ the SQL CHECK.
- **`wire-orphan`** (#18): a projection column with no SQL column.
- **`home-unreachable`:** a home export with 0 non-test importers whose consumers are barred by law.

These cover these slop classes: reinvented helper, copy-adapt, parallel implementation, wrapper-of-one, speculative generality (C10), constant sprawl, one concept under many names.

**Ranking:** tier, then home before sibling, then spread, group size, score, key.

**Caps:**

| Channel | Cap |
|---|---|
| Write time | 3 items / 1,500 chars, ≤3 messages per prompt |
| Author brief | 1,500 chars |
| Reviewer packet | 10 items + 40 paths / 3,000 chars |
| Issues | 10 new / 50 open |

### 2.5 Scaffold v2 and Lift

`SLOT_RULES` names two kinds of slot:
- *converge:* port, rows, errors, query-probes, cursor codec, events, barrels, router, read seam, page-meta;
- *diverge:* domain, DAL query chains, UI.

**Scaffold v2** adds the missing data slots, `page.meta.ts` and `lib/app-data/<slice>.ts`. Pages go under `(protected)/o/[orgSlug]/<slice>/`. For each converge slot, the first matching rule wins:
1. **A `HARNESS_HOMES` export is reachable:** import it. If it is absent on an older install, print the `update --refresh-seeded packages/shared/<x>` line.
2. **An exact alpha group spans ≥2 verticals in this slot and has no allow row:** refuse with `LIFT FIRST: node .claude/skills/lifting-shared-code/scripts/scaffold-shared.mjs <concept> --from <a> --from <b>`. This is exact-only, never on a Jaccard match.
3. **One sibling exists:** copy its skeleton only (names, signatures, home imports, `// sibling:` pointer), never a body.
4. **Otherwise:** today's stub. An empty tree behaves exactly as today.

**Lift** decides altitude mechanically, by the candidate's imports:

| Candidate | Result |
|---|---|
| Identifier sub-tokens name a vertical | Refuse; the reviewer decides |
| Workspace imports are kernel only (`@app/errors\|events\|env`; external deps allowed) | `packages/shared/<concept>` |
| It imports a driver | The owning platform leaf, **only if every consumer may value-import it**; otherwise refuse with `home-unreachable` |

Prevention-loop's scaffold import of `@app/supabase#mapPostgresError` would itself red `dal-client-value-import`, which is why the reachability check exists.

**What the script writes:** `package.json` with kernel deps only, `tsconfig.json`, and an `src/index.ts` holding only `// lift:` pointers. It also wires the consumers' dependencies, the tsconfig reference and the knip entry, as `installer/lib/tsconfig-references.mjs` does. It generates **no body** and does **no anti-unification**.

**The agent** moves one body, imports it at both sites, deletes both copies and runs `pnpm install --offline`. **The Lift is done** when the owed key is gone, `shared-not-into-verticals` holds, knip is green and C10 holds.

**C10.** Every `packages/shared/*` export outside `HARNESS_HOMES` needs ≥2 importing workspaces, tests excluded. Otherwise the message is "inline it into its one consumer". `HARNESS_HOMES` lists the template-shipped slot homes (PR 4), which may have zero consumers on a no-demo install. C10 is ramped, empty-legal, and needs no ADR.

## 3. Delivery protocol

| Moment | Recipient and channel | Content |
|---|---|---|
| **Plan** | Main agent pulls `--neighbours table:<t>\|@pkg#sym\|<path>\|slots`, triggered by a Step 0 line in `SKILL.md:20-34`. `T/specs/_template.md` gains `## Reuse` (`reuse:`/`lift:`/`new:` lines) | ≤10 pointers. `## Reuse` is a planning aid only: **no gate or packet reads it** |
| **Scaffold** | Main agent, via `scaffold-slice` stdout | §2.5 decisions, ≤8 lines |
| **After an edit** | The editor (and subagents, if probe c passes), via C5 `additionalContext` (Fact 18; precedent `posttool-source-check.mjs:106`) | **Only** when the edited TS or `supabase/{schemas,migrations}` SQL now holds a callable in an **owed** pair (index plus overlay). Other families wait for eval D |
| **Author dispatch** | `dal-author`, `migration-rls-author`, `test-author`, via C6 (probe a) | Reachable home exports for their slots (path, name, signature), plus open owed keys |
| **Reviewer dispatch** | Reviewers carrying `single-home`, plus torvalds (owed every turn), via C6 | Cached per tree digest (`.harness/context/packet-<digest12>.txt`), with a 3 s self-deadline inside 10 s. Contents: the `reviewChanges()` list (reviewers have no Bash, `architecture-reviewer.md:9`); owed pairs marked `(machine: Stop decides — do not re-raise)` or `owed (ramped to 2.3.0)`; near-misses from eval-A-cleared families; marker *lines*, never text; L2 facts |
| **Stop** | Main agent: `duplication` exits 1; on green, the C4 `systemMessage` | A red names both sides, the home, the legal move, the exact allow row and any staged proposal id. A green prints `advisories: N` and the first 3 NOTEs |

**Fallbacks:**
1. If probe (a) fails, use (b): an `updatedInput` append.
2. Otherwise, write `.harness/context/brief/<agent_type>.md` and add a body line: "Read it first if present".

A cold index logs `neighbours: null`, never silence.

```
single-home (OWED: `duplication` reds this at Stop and in CI)
NEW   packages/verticals/invoices/src/data/rows.ts:14 asRows
SAME  packages/verticals/notes/src/data/rows.ts:80 asRowArray [same function]
      (data: unknown) => readonly unknown[]
HOME  none reachable; verticals may not import each other. LIFT:
      node .claude/skills/lifting-shared-code/scripts/scaffold-shared.mjs row-array \
        --from @app/notes#asRowArray --from packages/verticals/invoices/src/data/rows.ts#asRows
      then import it at both sites and DELETE both bodies.
A re-typed copy has the same hash and stays owed. JUSTIFY needs a human-applied allow row.
```

**Not an injection surface.**
- Every field passes a `closed-text.mjs` printer or prints `(unprintable)`:
  - paths: `PATH_RE`;
  - symbols: `^[A-Za-z_$][\w$]{0,63}$`;
  - SQL names: `^[a-z_]\w{0,62}(\.[a-z_]\w{0,62})?$`;
  - everything else: enums and numbers;
  - signatures: rebuilt from AST tokens, with literal types shown as `S`.
- No body, comment, literal, commit text or prompt text ever appears.
- Markers carry no reason text.
- Owned code computes the payload from the tree. The author's Agent prompt is never an input.

**Reuse, not copy.**
- Pointers only: bodies are noise, API facts help.
- Two verbs, IMPORT and LIFT, never "see" or "example".
- The home comes before the sibling.
- A legal-move filter (depcruise plus vertical-anatomy) means no suggestion can red.
- The consequence is stated: a copy *is* the finding.
- The packet opens: "Facts, not verdicts. Do your own pass first, then report `single-home: present (file:line) | absent`."

## 4. Enforcement model

| Tier | Contents | Local | CI | Disposition |
|---|---|---|---|---|
| **owed** | L0; **new** L1a/L1s pairs; marker census; C10 | Stop reds `duplication`/`boundaries` | `unit` job (merge base via `fetch-depth: 0`) plus the frozen floor | The pair is gone from the tree, or an allow row plus a marker |
| **advisory** | L1b, `new-near-miss`, D-rules, legacy pairs, promotion candidates, every gate's NOTE (C3) | Never red; appears in the packet if eval-cleared, and as a C4 line | Nightly recompute → issue | Fix, or an allow row (`not_planned`) |
| **context** | L2 | Packet only | — | — |

**One adjudicator per key:**
- an owed key gets exactly one red, from the gate, unless the agent acted on it;
- an advisory key is judged by the reviewer's BLOCK, or else becomes a post-merge issue;
- being *shown* a key never adds a penalty.

**CI backstop.** Owed verdicts are a pure function of the tree, the merge base and `duplication-allow.json`. A human, another agent, or `disableAllHooks` meets the same verdict in CI.

**Disposition record.** A row is `{"fingerprint":"<12 hex>","reason":"<≥20 chars, both sides>","rule":"l1a|l1s|l1b"}`. The fingerprint is:
- the alpha, for L1a;
- the σ-body hash, for L1s;
- sha1 of the sorted shapes, for L1b.

Because the key is content, an edited accepted divergence **lapses and is re-reviewed** (Juergens). L0 rows are unchanged.

**Justify is a two-place act** (`T/tools/check-suppressions.mjs:27-33`):
1. The agent writes `// single-home: <fp12>` at the new side.
2. It stages `harness-proposals/<id>.json` (`T/docs/harness/README.md:261-265`).
3. A human runs `apply-proposal`, which agents are denied (`guard-rules.mjs:233-236`).

The census closes both ways: a marker without a row reds, a row without a marker reds, and a stale row reds. No endorsement exists.

**AWAITING-HUMAN is rejected.** It would special-case the most load-bearing hook right after `stack/51` changed the ledger. The block cap of 8 (`T/.claude/settings.json:8`) and the "PREVIOUS TURN ENDED RED" carry-forward (`stop-validate-gate.mjs:303-345`) already end such turns loudly. Only the wording changes: "awaiting human `apply-proposal <id>`; report and stop". Justify is rare, because owed is exact-only and a Lift is always executable. If more than 5% of owed-red turns hit the cap on pending proposals, that becomes a gate-proposal.

**Ratchets against cumulative slop** (no committed baseline):
1. Diff-scoped exact owed: the count of exact pairs can only fall. Legacy pairs drain via issues.
2. The scaffold refuses the third copy.
3. `new-near-miss` is pair-level and needs no file. It is the **first graduation candidate**: owed for cross-package pairs with verified J ≥ 0.80 and equal arity, once all of these hold:
   - eval A precision ≥ 0.90;
   - field false positives ≤ 10%;
   - eval C decoy dismissals ≤ 10%;
   - eval D passes.
4. C10.
5. Demote a family one rung when justify plus won't-fix exceeds 30%.
6. Nightly per-family trend lines.

I reject the ledger's committed per-(family, package) count baseline. Pair-level novelty gives the same "cannot grow" guarantee without a file, without shrink-red until `--prune`, without a self-rebaseline guard and without merge conflicts.

**Ramps.** The new rules ship behind `rampNote('duplication', '2.1.0', 'function-shape, SQL-function and marker rules', {until: '2.3.0'})`. C10 and each graduation get their own ramp. Withheld findings flow through C3 (issues), C4 (green turns), the packet (`owed (ramped to 2.3.0)`) and the `update` count. At expiry, keys keep emitting with `status: blocking` (`gate.mjs:316-323`).

## 5. Advisory → GitHub issue pipeline

**Recommendation: not literally "all".** An advisory becomes an issue, or a dashboard line once the caps bind, only when it is:
1. **Keyed.**
2. **Recomputed at default-branch HEAD inside the sync job.** Only then can a machine close it; reviewer prose and local hits never can.
3. **About project-owned code.** Harness-owned `tools/` and `.claude/` findings go to an "upstream" dashboard section, because the write guard denies those edits.
4. **Not already a register row.** Class C is linked, never copied: "two copies drift" (`scripts/check-obligations.mjs:22-27`).

Class B (per-turn lines) is excluded. Reviewer findings never become issues; one that recurs becomes a human-filed gate-proposal.

**v1 sources:**
- C3 records from `validate --min-floor --report-all` (critique §1.4);
- `check-duplication --sweep`;
- one lane issue per red scheduled lane. This is derived only from job **conclusions** read under `actions: read`, never from logs or artifacts, and closes on that lane's next green.

**Identity.** The key is `sha256(gate|rule|subject)[:16]`. It never contains a line or content. Subjects:

| Finding | Subject |
|---|---|
| Exported pair | sorted `pkg#name` |
| Unexported pair | `path#name` |
| SQL | `sql:schema.fn` |
| Ramp | `(file, detail)`, digit-normalised |
| Lane | `lane:<job>` |

The fingerprint is evidence and the exemption key. Line 1 of the body is `<!-- harness-advisory v1 key=… body=<sha8> -->`.

**Recorder.** Each record is `{v, gate, rule, status: advisory|legacy|ramp-withheld|blocking, subject, fp, evidence, until}`, written to `$HARNESS_ADVISORY_REPORT_DIR/<pid>.jsonl`. `noteComplete(gate)` writes `{gate, complete: true}` **before both `ok()` and `failures()`**. A red gate is therefore still complete; only a crash leaves no terminator.

| Observation | Action |
|---|---|
| New key, slot free | Open; otherwise dashboard |
| Body changed | Edit; never comment |
| `fp` in allow file | Close `not_planned`, linking the row |
| Exact key (L0, L1a, L1s, ramp) absent from **1** complete run | Close `completed`, citing the SHA |
| Thresholded key (L1b, near-miss, D-rule, semantic) absent from **2 consecutive** complete runs | Close `completed` |
| Gate incomplete | No change; after 7 days, add `advisory:stale` and name the gate |
| Key returns | Reopen as a regression |
| Allow-closed, then `fp` changes | Reopen |
| Human-closed without a row | Stays closed; listed as "closed without reviewed exemption" |
| `ramp-withheld` → `blocking` | `ramp:until-X` → `advisory:now-blocking`; stays open |

Won't-fix is an allow row. Closing an issue never exempts anything, and no gate reads issue state.

**Caps.** At most 10 new and 50 open. The first run is a baseline: everything starts on the dashboard and is promoted in this order: now-blocking, ramp-withheld, legacy exact pairs, cross-vertical near-misses, then the rest. At 200k LOC, expect a few hundred keys, about 30 runs to drain them, and ≤60 writes per run.

**Security.** `advisory-sync.yml` runs on `schedule` (after `'11 3 * * *'`) and `workflow_dispatch` only, under `concurrency`, and reads no cross-workflow artifact.
- `compute` (`contents: read`, `actions: read`) emits a schema-checked output of at most 1 MB.
- `sync` (`issues: write`) installs nothing and sparse-checks-out only its script and the allow file. It runs harden-runner with `egress-policy: block` to `api.github.com:443` and `github.com:443`, and writes via `gh api --input -` at 1 per second (honouring `retry-after`, no `${{ }}`). It uses `GITHUB_TOKEN`, so it never re-triggers itself, and touches only bot-authored, labelled issues that carry the marker.
- Titles use a fixed vocabulary, paths sit in code spans, and control, bidi and zero-width characters are stripped. A golden test forbids `@`, `#\d` and `<` outside code; factory tests pin the permissions and prove the lane can go red.

**Base or module.** C3, C4 and `--sweep` ship in base. The sync is the **opt-in module `advisory-issues`**: it would be the scaffold's first `issues: write`, and 2.0.0 is "the opt-in release" (`CHANGELOG.md:16`). `doctor` warns when an enabled sync is more than 3 days stale.

**Factory or consumer.** Each repo files only into itself. The factory dry-runs the sync against recorded `gh` responses, and asserts eval B over the combined template.

**Future loop contract** (recorded now, designed after probe d): input is only `{key, rule}`, re-derived via `--explain`; it never reads issue text, never auto-merges, never touches `ESCAPE_LISTS`, `tools/`, `.claude/`, `.github/`, migrations or `harness-proposals/`, and keeps net non-test LOC ≤ 0.

## 6. Optional embedding layer

**Module `embeddings`.**
- **Model:** `voyage-code-4`, pinned to a dated snapshot (512-d int8 plus sign bits), or a local Qwen3-Embedding-0.6B behind an operator endpoint. There is no silent fallback between them, and each has its own cache.
- **Storage:** `.harness/context/emb/<modelKey>/{vectors.i8,bits.u32,rows.jsonl}`, kept in `actions/cache` and never committed. Search is a binary prefilter to the top 200, then an int8 rescore.
- **Enabling:** a human edits the write-guarded `tools/embeddings.config.json`. The training opt-out must be recorded **before the first call**. Only `git ls-files` source is sent, filtered through `tools/secret-patterns.json`.

**Determinism boundary.** Only the module's nightly job touches vectors or the network. A probe set must re-embed at cosine ≥ 0.995, or the layer disables itself loudly. The owed set must be **byte-identical** with the module on and off, and a factory test asserts this.

**Tier: advisory issues only.** A hit qualifies with cosine ≥ T_adv (calibrated per model) **and** at least one deterministic corroborator:
- a shared table;
- a shared home import;
- equal arity and equal return shape;
- MinHash ≥ 0.15.

Qualifying hits are recorded as `noteAdvisory('duplication', {rule: 'semantic'})` under the pair identity, and close on 2 runs with hysteresis (T_close = T_adv − 0.03). Hits never reach write time, packets or the owed tier.

**Evaluation.** About 40 home helpers with T3, T3+ and execution-verified T4 variants, plus hard negatives. Compare T4 recall@5 against L1b, at advisory precision ≥ 0.8:
- ≥ +15 points: recommended;
- +5 to +15: shipped as experimental;
- under +5: not shipped.

## 7. Resolution of the six tensions and the gaps

**Tensions**
1. **Semantic hits at write time:** none. Write time is deterministic and owed-only. Semantic hits reach only corroborated nightly issues.
2. **Identity:** `gate|rule|subject`. The fingerprint is evidence and the exemption key, so identity survives moves while an exemption lapses on edit.
3. **Closing:** exact keys close after 1 complete run; thresholded and semantic keys after 2; lanes on their next green. Unknown is not absent. Only an allow row closes an issue `not_planned`; a justify answer never does.
4. **"Every advisory becomes an issue":** only advisories that are keyed, recomputable, project-owned and not registered (§5). B is excluded and C linked. Inventory option (b) is refused, because the nightly job recomputes.
5. **Nag versus owed:** there is no shown-ledger. Stop judges the tree, so acting on a pointer cancels the debt. One adjudicator per key; only justify needs a human.
6. **Loop versus distrusted text:** no loop in v1. The key is the only actionable field, and `--explain` re-derives it. The constraints are in §5, gated on probe (d) and Fact 5 (`design/CONTROL-PLANE-FACTS.md:618-628`).

**Gaps**

| Gap | Resolution |
|---|---|
| CI backstop | `unit` job plus floor `boundaries`; the allow file and markers are committed |
| Every lane | Static and duplication are recomputed. The other 14 lanes get lane issues from their conclusions, and their NOTEs are listed as "not covered" |
| Diff vs sweep | Owed is diff-scoped; the sweep runs in baseline mode under the 10/50 caps |
| Existing `duplication` gate | One gate, one store. `advisory-allow.json` and `dispositions.json` are refused |
| Ramp visibility | C3, C4, the packet, the `update` count |
| Unrelated red | The terminator is written on the failure path. After a crash, `advisory:stale` appears after 7 days |
| Read-only reviewers | SubagentStart within 3 s, carrying the change list, with the fallback file |
| Opt-in | C1–C11 ship in base; issues and embeddings are modules |
| Which repository | Consumers; the factory dry-runs |
| Action rate | Counts-only telemetry `{kind:'single-home', rule, tier, outcome}` joined by `prompt_id`, with no paths (`T/.claude/hooks/lib/hookio.mjs:50-60`). False positives = allow rows per 100 owed hits |
| Concurrency | Content-addressed blobs, atomic renames, per-session overlays, per-pid records; no verdict reads shared mutable state |

## 8. What it deliberately does NOT do

**Deletion bias.** A Lift is complete only when both copies are gone. Dogfood PRs are net-negative in LOC. C10 inlines any export left with a single consumer.

| Rejected | Why |
|---|---|
| Owed on near-misses (ledger `rb`; prevention-loop's J ≥ 0.85 refusal) | Only exact hashes gate (clone research Q6). Anything else graduates |
| L1a floor of ≥40 tokens and 3 statements | Misses `asRowArray` |
| Extra stores; endorsements; `LEDGER_FORMAT` changes | Sprawl; LLM output on the escape path |
| AWAITING-HUMAN; PENDING-ROW | Changes Stop semantics; local and CI would diverge |
| Count baselines; `atlas-census.json` | Pair-level novelty already does this, without the churn |
| Packet inside `subagent-verdict.mjs` | Couples an advisory to fail-closed verdict recording |
| Shown-ledger | Not recomputable in CI (critique §1.7) |
| Anti-unified skeletons; codemods | Callback soup; 76% of LLM extract suggestions were hallucinated |
| Refactor loop | First CI Claude lane with `contents: write`, before Fact 5 is probed |
| PageRank, concept graph, co-change, MCP | Maintenance cost; no slop evidence; young repos; `--strict-mcp-config` |
| Owed `wire-*`; ten launch ratchets | Precision unmeasured; human-only discharge |
| Embeddings in synchronous moments | Breaks "same tree, same packet" |
| `## Reuse` text in packets | The author would steer the reviewer |
| Cross-workflow artifacts; log scraping | The sync recomputes |
| PreToolUse deny; UserPromptSubmit | Thrash; fires before code exists |

## 9. Evidence trace

| Mechanism | Finding | Source |
|---|---|---|
| Obligation, not context | Agents ignore context they have; 50.8% duplicated logic by turn 5 | `w1-ai-slop-evidence.md` §1, Q3 |
| Scaffold prevention; specified Lift | CodeTaste: agents carry out specified refactorings but do not discover them | `w1-ai-slop-evidence.md` Q3 |
| Fix the exemplars | RepoCoder amplifies existing duplication; healthier code helps agents | `w1-ai-slop-evidence.md` Q4 |
| Exact owed; type-3 advisory | Rename-invariant hashing is precise; most clones are benign | `w1-clone-similarity-sota.md` Q2, Q6 |
| Content-keyed exemptions | Inconsistent changes to clones cause faults (Juergens) | `w1-clone-similarity-sota.md` Q6 |
| Write-time delivery | Infer: ~70% fixed at diff time vs ~0% in batch | `w1-design-quality-signals.md` Q7 |
| Pointers, ≤3 | Similar code is noise; more than 5 items interfere | `w2-write-time.md` §2 |
| Neutral packet | Tufano anchoring; AACR-Bench F1 −31% | `w1-design-quality-signals.md` Q7; `w1-agent-context-retrieval-sota.md` §1 |
| ≤10% FP gate | Tricorder | `w2-write-time.md` §2, §3.2 |
| Deterministic refactor checks | ACE 37%→98%; EM-Assist | `w1-ai-slop-evidence.md` Q4 |
| Eval D as a gate | No controlled study of this intervention exists | `w1-ai-slop-evidence.md` eval design |
| Corroborated embeddings | ExecRetrieval exec@1 = 0.33 | `w2-embeddings.md` §2 |
| Recorder, NOTE survival, lanes | No advisory type exists; NOTEs vanish | `w2-advisory-inventory.md` 1–2, §4.3 |
| Issue lifecycle and security | Search-API duplicates; compute/sync split | `w2-issue-sync.md` §2–3 |
| Slots, homes, SQL fold | `asRowArray`; mapper ×3; `deny_mutation` ×2 | `w1-stack-anatomy.md` §1, §3, §6 |

## 10. Cost and latency budget

Baselines: `duplication` takes 310 ms. The TypeScript load is ~215 ms (~130 ms with the compile cache). A warm parse plus α plus MinHash over 49k LOC takes ~0.39 s.

| Moment | Scaffold | 200k LOC | Bound |
|---|---|---|---|
| Plan | 0.3 s | ≤1 s | — |
| Scaffold | +0.2 s | +0.5 s | — |
| C5 | p50 ≤300 ms, p95 ≤600 ms | same | 1 s self-deadline, 5 s timeout; runs alongside Biome |
| C6 | ≤1 s | ≤2.5 s | 3 s self-deadline; ≤750 tokens; once per digest |
| Stop `duplication` | +0.4 s | 2–4 s warm, ≤8 s cold | `chain-budget.json` |
| CI `unit` | +1 s | +5–10 s with the blob cache | — |
| Nightly | 2 s | about 30 s (estimate); ≤60 writes | — |
| Embeddings | — | ~$0.12/M tokens; cents incrementally | nightly |

**Scaling.**
- Only changed blobs are re-parsed.
- Postings are spread over 256 shards.
- LSH buckets are capped at 50.
- A cold run uses 4 `worker_threads`.
- The base index covers only changed files.

Oxc replaces `extract()` only if a cold CI run exceeds 10 s, and then as a reviewed dependency change.

## 11. Evaluation

**A. Detector eval** (factory; extends `tests/gates/check-duplication.test.mjs`; gating). About 40 home helpers, each mutated: locals renamed, a literal swapped, 1–3 statements edited or reordered, a copy in a sibling vertical, an SQL copy across schemas (literals included), a move (must stay silent), and an edit into resemblance. Decoys: local vs UTC `formatDate`, `toCents`/`fromCents`, the transport twins, the design-system mirror, the i18n catalogs, zod tables, the two legal policy shapes, route-convention files, tiny same-name functions with different bodies, and notes' read/write asymmetry (`errors.ts:18-21`).

| Measure | Bar |
|---|---|
| Owed recall | 100% |
| False owed on decoys | **0** (otherwise the name clause is demoted) |
| L1b recall / L1b and near-miss precision | ≥0.80 / ≥0.90 |
| D-rule precision before reaching packets | ≥0.90 |
| Two machines | byte-identical |

Each owed rule, the marker census and C10 get a canary in `tests/canary/injections.json`.

**B. Dogfood golden.** Covers base + stack + demo + the materialised push slice (`w1-stack-anatomy.md` §5–6).

| Item | Expected |
|---|---|
| `asRowArray` (`rows.ts:80` ↔ `push-tokens.ts.txt:121`) | L1a, name clause |
| `mapFailure` ↔ `mapPostgrestFailure`; home `mapPostgresError` | L1b + `home-unreachable` |
| `deny_mutation` ×2 | L1s |
| Partition functions ×2 | L1s or L1b |
| Router ↔ action write context | `twin-drift` |
| `apps/mobile/src/components/*` ↔ `design-system-native` | L1b |
| `NOTE_TITLE_MAX` ↔ CHECK 200 | `wire-bound` fires when one side is mutated |
| Planted orphan column | `wire-orphan` |
| Allow-rowed cursor codec | silent |

The bar is ≥8 of 9 found, and **0** hits on the 10 allow rows and the twins. Expected misses become reviewer-eval cases: port cast ×3, renderable title ×3, port types ×4. After PR 4, the sweep shows none of the fixed items, and every dogfood PR has negative net LOC.

**C. Reviewer eval.** `KINDS` (`scripts/reviewer-eval.mjs:72`) gains `helper` and `sql-function`. Each kind gets three cases, for both the architecture and torvalds reviewers:
- a BLOCK where the home is outside the diff;
- a PASS twin;
- a decoy PASS.

`scoreOne` (`:314`) checks a new optional `mustCite: [<home path>]`. There are two arms: the diff alone, and the diff plus `renderPacket()` via `livePrompt` (`:389`). Each runs at least 5 times, with `claudeVersion` recorded.

Bars:
- BLOCK hit rate +25 points;
- twin and decoy PASS rate down by no more than 5 points;
- `mustCite` ≥80%.

**D. Generation A/B.** Runs factory-local under `claude -p` (Fact 5: no CI lane). It is a **decision gate**. The RepoReuse-style design is 12 chains × 5 turns × 3 seeds, OFF vs ON.

Bars:
- duplicated-logic chains at turn 5 ≤50% of OFF;
- canonical-reuse recall +20 points;
- decoy false-reuse ≤10%;
- pass rate within 2 points;
- tokens ≤+15%.

A passing run recorded in `tests/evals/generation-ab/<date>.json` is **required** before any of these:
- a non-owed family may interrupt at write time;
- any graduation;
- calling scaffold v2 "recommended".

**E. Field.**
- ≥70% of owed pointers are resolved before Stop.
- Effective false positives ≤10%.
- A rule is retired at >30% `not_planned` over ≥20 issues.
- Demotion follows §4.

## 12. Rollout

All PRs land after `stack/52-i37-work-plan` (2.0.0) merges.

| # | PR | Ships in |
|---|---|---|
| 0 | **Spike-0 probes**, recorded as CONTROL-PLANE-FACTS 19–23 and re-run at every Claude Code floor bump. (a) Does SubagentStart `additionalContext` reach the *subagent*? The reviewer echoes a nonce. (b) Does PreToolUse `Agent` `updatedInput` rewrite the prompt? (c) Does a subagent's own PostToolUse reach it? (d) Headless permissions through a PermissionRequest hook (recorded only). (e) `async` PostToolUse, and Edit/Write delivery in VS Code | factory |
| 1 | **Gate-proposal issues:** diff-scoped L1a/L1s with the marker census; `shared-rule-of-two`; `new-near-miss` graduation; future `wire-*`/`twin-drift` gates | factory |
| 2 | `closed-text.mjs`, the recorder, C4, and a factory check that every template `NOTE —` emitter routes through `noteAdvisory`. Canary: a NOTE survives a green turn | base |
| 3 | `shapes.mjs`, query modes, eval A. No verdicts yet | base, factory |
| 4 | **Dogfood Lift**, net-negative in LOC. (a) New `seedOnInitOnly` packages: `packages/shared/pg-errors` (`mapPostgresError` and its siblings, moved out of `@app/supabase`, which never uses them); `packages/shared/postgrest-rows` (`asRowArray`); and a hand-designed `packages/shared/keyset` with one length parameter, since the codec imports `@app/contracts` and so is not mechanically liftable. Notes and push import them, and `HARNESS_HOMES` lists them. (b) A forward migration unifying `deny_mutation` and the partition functions. Existing installs opt in via `update --refresh-seeded` (`installer/commands/update.mjs:4-13`) | stack, demo, module |
| 5 | **L1a + L1s owed live**: allow `rule` field, marker census, ramp 2.1.0→2.3.0, canaries, a `gates-catalog.md` entry (`:2442`), chain budget re-measured | base |
| 6 | Scaffold v2, `scaffold-shared.mjs`, C10 (ramped, with canary), `## Reuse`, the Step 0 line | base |
| 7 | C5, owed-only. The subagent half depends on probe (c) | base |
| 8 | C6, the companion rows, `agents.lock.json` regenerated. The fallback path is set by probes (a) and (b) | base |
| 9 | Eval C; the eval D harness and its first recorded run | factory |
| 10 | D-rules, recorded as advisories | base |
| 11 | `advisory-issues`: sanitiser golden, permission pin, red canary, `doctor` check | module |
| 12 | `embeddings`, behind the §6 bar | module |
| 13+ | Graduations, starting with `new-near-miss`. Each needs a gate-proposal, a ramp and a passing eval D | base |

## 13. Risks and failure modes

1. **Probe (a) fails.** Fallbacks apply. Packets never gate, so verdicts are unaffected.
2. **A false owed finding stalls autonomy**, because only a human applies the escape. Mitigated by: exact-only matching, diff scope, twins, the name-clause kill switch, and a monitored allow-row rate.
3. **Gaming by cosmetic divergence.** L1b and near-miss catch it; disguised wrappers surface as #10 or #9; eval D decoys measure it.
4. **A parallel-PR race** leaves a pair that neither PR saw. It becomes a legacy pair and goes to the front of the nightly queue. Accepted.
5. **Older installs lack the homes.** The scaffold prints the `--refresh-seeded` line.
6. **A wrong `DELIBERATE_TWINS` or `HARNESS_HOMES` entry hides slop.** Both are closed and cited, and change only in a release.
7. **Packet anchoring.** The packet is facts only, the reviewer does its own pass first, and eval C has decoys.
8. **Parse cost at scale.** Chain-budget rows watch it, with oxc in reserve.
9. **Issue fatigue.** Caps, baseline mode, opt-in, and retirement at 30% `not_planned`.
10. **Workflow compromise.** Split privileges, blocked egress, the issue filter, and no interpolation.
11. **Stale pointers.** Candidates are re-hashed before printing.
12. **Pending proposals exhaust the block cap.** The §4 trigger handles it.

## 14. Open questions for the user

1. **Who supplies the second place of a justify?** Today a human runs `apply-proposal`. Zero human touch would need a second principal, such as a CODEOWNERS bot identity. That changes the escape model.
2. **Should `advisory-issues` be opt-in, or on by default in base with `issues: write`?**
3. **How should the template dedupe reach existing installs?** Options: opt-in `--refresh-seeded`, or a 3.0.0 that converges seeded roots.
4. **Which embedding provider?** Hosted Voyage (after the opt-out acknowledgement) or local-only. This sets the default adapter and the privacy controls.
5. **Is the refactor loop on the roadmap?** If yes, probe (d) becomes priority work and the loop gets its own design.
