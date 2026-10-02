# Precedent: canon-first authoring with a Lift loop

Paths are relative to the stack-head tree. `T/` = `template/base/`, `S/` = `template/stack/`, `D/` = `template/demo/`. "Research" = this directory.

## 1. Name and thesis

**Precedent** (`precedent`). Most slop that survives this harness is a second copy of something that has, or should have, a single home; the scaffold itself carries a failure mapper ×3, port types ×4, a cursor codec and `asRowArray` cloned by push, and `deny_mutation` twice in SQL (`w1-stack-anatomy.md` §3, §5–6). Agents ignore context they already have (RepoReuse), but feedback at diff time backed by an obligation works (Infer: 70% fixed vs 0% in batch). This harness already owns **every moment where code is born**: the spec template, `scaffold-slice.mjs`, the three author subagents and the PostToolUse hooks. It also already declares its anatomy as behaviour-keyed slot laws (`T/tools/lib/vertical-anatomy.mjs:51-59`), each slot with a known similarity polarity. Precedent turns each birth moment into a deterministic lookup of the canonical home. At plan time the author gets the home for every slot it will fill. At scaffold time the script imports shared code, copies only a sibling's skeleton, and **refuses to create the third copy** of a high-polarity slot, routing the author to **Lift** instead. Lift creates `packages/shared/<concept>`, which five rules already name but which does not exist (`T/dependency-cruiser.cjs:24-41`); it needs an ADR and is held by a rule-of-two law. After each edit the author gets a pointer dossier. At Stop and in CI a narrow owed set of exact rename-invariant clones is recomputed from the tree. After merge, residue becomes GitHub issues that a headless refactor agent drains one key at a time. Every finding key has **one adjudicator**: the gate for owed, the reviewer for advisory, the tracker for residue. What was shown to an agent never decides a verdict, so nothing is penalised twice.

## 2. Architecture

### 2.1 Index core: `T/tools/lib/precedent/` (owned; covered by write-guard rule `tools-lib`, `guard-rules.mjs:393`)

| File | Job |
|---|---|
| `extract.mjs` | One record per function. Parser: the project's own `typescript`, syntax-only, via R07's `loadParser` (`T/tools/lib/i18n-tree.mjs:28-32`); a missing parser yields null, a NOTE locally and a failure in CI. SQL comes through the existing `sql-parse.mjs` views (`parseFunctions:1045`, `parseTriggers:1107`, `parsePolicies:481`, `parseColumnFacts:978`). No new dependency |
| `slots.mjs` | File → anatomy slot (path plus behaviour, the `vertical-anatomy.mjs` keys) with polarity **HIGH** or **LOW** (`w1-stack-anatomy.md` §1). `TWIN_SLOTS`: procedure ↔ Server Action ↔ RSC seam; one port per consumer (`architecture-reviewer.md:42-44`); the web/native design system |
| `fingerprint.mjs` | **L1a `ri`**: rename-invariant hash. Locals renamed in binding order; imported, global and property names kept; literals reduced to their kind; comments dropped (allowed: this is not a binding digest). **L1b**: 64-permutation MinHash over node-kind 3-shingles, LSH 16×4. **L1c**: signature key (arity, normalised types, identifier sub-tokens). **Facts**: literals, key sets, `.from`/`.rpc` shapes, read from `query-shapes.json` when present |
| `concepts.mjs` | **L2** concept graph built from artifacts already in the tree: SQL column → `rows.ts` key → `@app/contracts` field → query-shapes → action-inventory → `routes.generated.ts`. Not an import graph (the "`vitest --changed`" lesson) |
| `index.mjs` | Per-blob cache `.harness/precedent/v1/blob/<sha>.json` keyed by `(blobSHA, extractorVersion)`, plus `merged.bin` (LSH table and records) keyed by tree digest. Temp-file writes, then `rename`. Per-session overlay `overlay-<session_id>.json` for uncommitted definitions |
| `rank.mjs`, `render.mjs` | Ranking and caps (§2.4), through closed validators lifted from `harness-brief.mjs:48-72` into a shared `tools/lib/closed-text.mjs` |

**Function record v1**:

```json
{"id":"@app/notes#asRowArray","file":"packages/verticals/notes/src/data/rows.ts","blob":"…","span":[80,86],
 "slot":"row-seam","polarity":"high","altitude":"vertical","exported":true,
 "ri":"9f3a2c41d07e","mh":"<64×u32 in merged.bin>","sig":{"arity":1,"params":["unknown"],"ret":"readonly unknown[]"},
 "nameTokens":["as","row","array"],"tokens":41,"stmts":3,"calls":["Array.isArray"],"tables":[],"facts":[]}
```

**Symbol id**:
- exported symbols use `<package>#<export>`, which survives a file move inside its package;
- non-exported symbols use `<path>#<name>`;
- SQL objects use `sql:<schema>.<fn>`.

**Finding v1**:

```json
{"key":"3f9a2c41d07e5b18","gate":"duplication","rule":"renamed-clone","tier":"owed",
 "subject":["@app/notes#asRowArray","packages/verticals/invoices/src/data/rows.ts#asRows"],
 "layer":"L1a","score":1.0,"moves":["lift:row-array"],"evidence":{"ri":["9f3a2c41d07e","9f3a2c41d07e"]}}
```

`key = sha256(gate|rule|sorted(subject))[0:16]`. The key contains no line numbers and no content hash; content fingerprints are kept only as evidence.

### 2.2 Entry points

| Entry | Location | Extends |
|---|---|---|
| CLI `tools/precedent.mjs`: `--plan`, `--neighbours`, `--explain <key>`, `--sweep`, `--json` | `T/tools/` (owned) | The `spec-anchor.mjs` precedent: "a tool, not a gate" |
| Owed rules `renamed-clone`, `reinvented-export`, `sql-renamed-clone` | `T/tools/check-duplication.mjs` | The existing Stop step (`harness.config.mjs:201`) and its blocking CI lane (`check-duplication.mjs:11-16`) |
| `shared-rule-of-two` | `T/tools/check-workspace-deps.mjs`, which already tiers `shared/` (`:64-67`, `:147`) | The `boundaries` step |
| `noteAdvisory(gate,{rule,subject,…})` | `T/tools/lib/gate.mjs`, mirroring `noteMissingPrerequisite` (`:169`) | Every gate. JSONL to `HARNESS_ADVISORY_REPORT_DIR`; never decides a verdict |
| `posttool-precedent.mjs` | PostToolUse `Edit\|Write\|MultiEdit`, timeout 5 s, invoked **directly** (not `launch.mjs`), exit 0 on every path (as `session-brief.mjs:150-159`) | Runs in parallel with `posttool-fast-check` (`settings.json:11-27`) |
| `subagent-precedent.mjs` | SubagentStart, matcher `*`, timeout 5 s, invoked directly, exit 0. Acts for the three authors plus architecture and torvalds | A **separate** entry beside `subagent-verdict.mjs` (`settings.json:84-95`), leaving R01/B03 and `LEDGER_FORMAT` untouched |
| `scaffold-slice.mjs` v2; `scaffold-shared.mjs` | The skill's `scripts/`; a new skill `lifting-shared-code` | `scaffold-slice.mjs:36-180` |
| Stop summary | `stop-validate-gate.mjs` collects `PRECEDENT —` lines beside FALLBACK (`:268-276`) | Fixes "NOTE lines vanish on green" for this system |

### 2.3 Committed registers

- **`tools/duplication-allow.json`** (existing, PROPOSABLE, ESCAPE_LISTS). It is the **only** exemption store for the owed tier. Rows gain an optional `rule` field, and they stay keyed by fingerprint (the `ri` for renamed clones).
- **`tools/advisory-allow.json`** (new; seeded, write-guarded, listed in ESCAPE_LISTS and PROPOSABLE). Rows are `{key, rule, reason, reviewedOn}`. This is the won't-fix store for advisory keys. Like `check-suppressions.mjs:28-34` it closes both ways and has no calendar dates.
- **`tools/precedent-baseline.json`** (new). Per-rule counts for ratcheted rules. Only `precedent --write-baseline` writes it, and the `self-rebaseline-writer` rule (`guard-rules.mjs:218`) is extended to cover that command. It goes in NOT_PROPOSABLE, alongside the mutation baseline.
- **`docs/adr/<date>-shared-<concept>.md`**: the promotion record.
- **No canon register.** A symbol is canonical by **altitude**: every export of `packages/platform/*` and `packages/shared/*` counts. Altitude is itself reviewed structure, so there is no second list to drift.

### 2.4 Signals, layers, ranking

**Computed signals** (catalogue numbers from `w1-design-quality-signals.md`, plus the slop taxonomy):
- **Owed when exact (L1a):** #27 bypassed/reinvented helper (`reinvented-export`) and copy-adapt (`renamed-clone`).
- **Advisory:**
  - copy-adapt at L1b (`near-clone`);
  - #28 superseded symbol, #9 single-consumer abstraction, #10 pass-through / wrapper-of-one, #12 middle man;
  - #18 naming lineage, #6 fact census as `bound-restated` (SQL CHECK 200 vs `NOTE_TITLE_MAX`);
  - #5 systematic edit, #26 idiom cluster (catch-and-map bypassing `mapPostgresError`), #24 intent-hiding helper, #20 boolean selector;
  - parallel implementation (`apps/mobile/src/components` vs `design-system-native`) and gate-induced helper splitting;
  - `sql-rail-reinvented`, plus `slot-divergence` (a HIGH slot drifting from its sibling) and `slot-convergence` (LOW slots alike).
- **Not computed:** co-change (#1–4, #30), feature envy (#16), module depth (#13), synonym census (#19).

**Precision filters:** exclude tests, generated files, `.d.ts`, `TWIN_SLOTS` pairs and `duplication-allow.json` rows. L1a needs at least 40 normalised tokens and 3 statements. An RNR / literal-density filter drops data tables such as the i18n catalogs.

**Ranking** is lexicographic:
1. candidate altitude: platform/shared > sibling vertical > same package (show the canonical symbol to call, not code to imitate; RepoCoder caution);
2. layer: L1a > L2 > L1b > L1c;
3. agreement with slot polarity;
4. cross-package spread;
5. score, then key.

**Caps:**

| Output | Items | Characters |
|---|---|---|
| Edit dossier | ≤3 (A3-CodGen: more than 5 interfere) | ≤1,500 |
| Dossiers per prompt | ≤3 | |
| Plan brief | 12 lines | ≤2,000 |
| Author brief | | ≤3,000 |
| Reviewer packet | ≤10 | ≤4,000 |

### 2.5 Lift: the extraction and promotion workflow

**Triggers:** the scaffold's `LIFT FIRST`; an owed `renamed-clone` between two verticals, where Lift is the only legal move (`verticals-not-into-verticals`, `T/dependency-cruiser.cjs:24-32`); a plan-brief candidate; or a loop-picked `near-clone` or `idiom-cluster` issue.

**Altitude, decided mechanically:**
- **Kernel-only imports** (`@app/errors`, `@app/events`, `@app/env`) **and no domain name** → `packages/shared/<concept>` (`@app/shared-<concept>`, exporting only `.`).
- **Touches a driver seam that a platform leaf already owns** → reuse or extend that leaf under `platform-imports-kernel-only` (`:43-56`). For example, route the SQLSTATE half through `mapPostgresError`. A consumer may extend its own leaf; the factory may not (below).
- **Names a feature** → no lift; the finding stays advisory (rubric (a), `architecture-reviewer.md:31-36`).

**`scaffold-shared.mjs <concept> --from <symA> --from <symB>`** (skill `lifting-shared-code`):
- Anti-unifies the two records into a signature skeleton: holes become parameters, and differing behaviour becomes a callback (the Tsantalis pattern).
- Writes `package.json` (kernel deps only), `tsconfig.json`, `src/index.ts` (skeleton plus `// from:` pointers) and a test stub.
- Adds the three topology entries (workspace dep, project reference, knip map; `tsconfig.json:9-19`) the way `installer/lib/tsconfig-references.mjs` does for the demo.
- Writes `docs/adr/<date>-shared-<concept>.md` from `0000-adr-template.md`, with a `## Promotion` section: consumers, template and holes, altitude, and what was deleted.

The agent then moves the body, replaces **both** copies with imports and deletes them; the main thread runs `pnpm install`. Checks: `shared-rule-of-two` (§4), `shared-not-into-verticals`, knip `--strict`, the owed key gone, and `superseded-symbol` if an old copy survives.

**The nonexistent `packages/shared`.** The first Lift creates it. `pnpm-workspace.yaml:6-16` already globs `packages/*/*`, and depcruise and `check-workspace-deps.mjs:64-67,147` already tier it by path, so no rule changes.

**The seeded-roots blocker** (`duplication-allow.json:30`) binds only **the factory**. In a consumer repo `packages/` is the project's own code (`installer/lib/layout.mjs:101-103`), so a Lift is an ordinary edit. When the factory dedupes its own template it is **additive only**: *new* package directories ship `seedOnInitOnly`, no export is ever added to an existing seeded file, and existing installs opt in via `update --refresh-seeded` (`update.mjs:9-13,653`) with a `source-fixes` note. Once `packages/shared` exists, the i18n type-preamble allow rows become retirable for new installs.

## 3. Delivery protocol

| Moment | Who receives it | Channel | Shape |
|---|---|---|---|
| **Plan** | main agent (pull) | `precedent --plan specs/<f>.md`, from SKILL Step 0 (`SKILL.md:20-34`) and `new-feature.md` | Reuse brief: whether entity and verb already exist (action-inventory), the canonical symbol per slot, SQL rails (`set_updated_at`, `audit.write_row`), bounds to borrow, lift-first candidates. Ids go into a new `## Reuse` section of `T/specs/_template.md` (beside `:27-29`) as `reuse:<sym>`, `lift:<concept>` or `new:<reason>` |
| **Scaffold** | main agent | `scaffold-slice` v2 output (≤8 lines) | A decision per slot (§3.1) |
| **After an edit** | the editor, main agent or subagent (probe c) | PostToolUse `additionalContext` | Dossier (§3.2), only for a new file, exported symbol, SQL function or zod schema |
| **Author dispatch** | the three author agents | SubagentStart `additionalContext` (probe a). The payload has only `agent_type`/`agent_id`, so the brief comes from the diff, which names the slice once the scaffold has run | Canonical symbol per scaffolded slot, plus open owed keys |
| **Reviewer dispatch** | architecture and torvalds reviewers | Same hook | Changed-file list (fills the no-Bash gap, `architecture-reviewer.md:26`) plus ≤10 keys, each with **machine status** (`resolved:*`, `owed(machine)`, `ratchet(machine)`, `advisory-open`) and delivery facts ("shown to dal-author"). Facts are neutral ("`X` has 1 importer"), never labels. Spec `## Reuse` claims are listed against the actual imports |
| **Stop** | main agent | `duplication` failure; when green, a one-line `PRECEDENT —` systemMessage | Owed failures carry the **full** dossier, since a write-time message may have been dropped |

**Fallbacks if a probe fails.** If (a) fails, append through `updatedInput` (probe b). If both fail, write `.harness/precedent/brief/<agent_type>.md` and add one line to each body: "Read it first if present". `.harness` is denied only to Edit and Write (`settings.json:215-216`); Read stays allowed, and the author cannot forge the file. If the cache is missing, the record says `precedent: null`, never silence.

### 3.1 Scaffold-from-siblings

For each slot `scaffold-slice` would create, the scaffold picks a decision in this order. On a default scaffold with no verticals, this degrades to today's comment stubs, so it is legal when empty.

1. **A shared or platform symbol serves the slot.** Emit an import of it. Example: `@app/supabase#mapPostgresError` for the SQLSTATE half (`S/packages/platform/supabase/src/errors.ts:134`).
2. **Two or more sibling verticals hold the same body** (equal `ri`, or Jaccard ≥0.85) **in a HIGH slot.** Refuse to copy and print `LIFT FIRST: scaffold-shared <concept> --from <a> --from <b>`. This is the moment the third copy would be born.
3. **One sibling exists.** Copy the **skeleton** only: export names, signatures and canonical imports, plus `// precedent: <sym>` pointers. Never a body.
4. **Otherwise**, write today's stub.

v2 also:
- fixes the stale web path (it writes `(protected)/o/[orgSlug]/<slice>/`, not `:108`);
- adds the missing slots: `data/{port,rows,errors,query-probes}.ts`, `page.meta.ts` and `lib/app-data/<slice>.ts`.

### 3.2 The edit dossier (example, 640 characters)

```
precedent (1 of ≤3 this prompt · key 3f9a2c41d07e5b18 · will be OWED at Stop)
NEW   asRows   packages/verticals/invoices/src/data/rows.ts:14
SAME  asRowArray  @app/notes  packages/verticals/notes/src/data/rows.ts:80  [renamed-clone · exact]
      (value: unknown) => readonly unknown[]
A vertical may not import another vertical. The legal move:
  LIFT  node .claude/skills/lifting-shared-code/scripts/scaffold-shared.mjs row-array \
          --from @app/notes#asRowArray --from packages/verticals/invoices/src/data/rows.ts#asRows
        then import it from both sites and DELETE both bodies.
Copying the body is this finding. JUSTIFY needs a human-applied duplication-allow row.
```

**Not an injection surface.** Every field is a repository-relative path (`PATH_RE`), an identifier (`^[A-Za-z_$][\w$]{0,63}$`), a closed-enum rule, a number or fixed template text. No bodies, comments, string literals, commit text or prompt text ever appear; a field that fails validation prints `(unprintable)`. The hooks read only the index, they are owned and hash-pinned, and the author cannot write `.harness/` (`PROT_DIRS`, `pretool-bash-guard.mjs:25`).

**Reuse, not copy.** Pointers are import specifiers plus signatures. The moves are imperative and ordered (IMPORT, then LIFT, then JUSTIFY by a human). Canonical altitude ranks first, and boundary law filters the moves, so the dossier never suggests a vertical-to-vertical import. It states the consequence of copying, and the scaffold never copies a body.

## 4. Enforcement model

**Tiers**

| Tier | Rules | Local | CI | Adjudicator |
|---|---|---|---|---|
| **owed** | `renamed-clone` and `reinvented-export` (L1a, pairs where at least one side is in `reviewChanges()`); `sql-renamed-clone` (a new migration function equal to an existing one after schema normalisation); `shared-rule-of-two` | The `duplication` / `boundaries` Stop step reds | Recomputed from the merge base: `boundaries` is a frozen-floor member (`validate.floor.json:12`), and `duplication` is its own blocking lane. Hooks are irrelevant | the gate |
| **ratchet** (graduated advisory rules only) | per-rule count in `precedent-baseline.json` must not rise, minus keys in `advisory-allow.json` | Stop red | CI red | the gate |
| **advisory** | everything else in §2.4 | never red | never red; recorded; issue on the default branch | reviewer in-turn, then the issue |
| **context** | L1c signature matches, concept neighbours, semantic hits | shown only | none | none |

**`shared-rule-of-two`.** Every `packages/shared/<x>` export must have at least 2 consuming workspaces outside tests, and some `docs/adr/*.md` must name `packages/shared/<x>`. When a consumer is deleted, the export must be inlined back; that is how deletion is favoured. On an empty tree the rule passes.

**CI backstop.** Every owed or ratchet verdict is a pure function of the tree and the merge base. The shown-ledger (`.harness/precedent/shown.jsonl`) and reviewer dispositions are **never** inputs to a verdict. So a human, another agent, or a session with `disableAllHooks` meets the same verdict in CI.

**Disposition records**

| Outcome | Record | Where |
|---|---|---|
| reuse / extract | none; checked mechanically (symbol gone and canonical imported, or both sides import one shared symbol) | the tree |
| justify (owed) | inline `// precedent-accepted: <ri12> — <reason ≥20 chars>` **plus** a `duplication-allow.json` row. The agent stages `harness-proposals/<id>.json` (`T/docs/harness/README.md:258-279`); only a human runs `apply-proposal`, which the bash guard denies agents (`guard-rules.mjs:233`). Closed both ways: a marker without a row reds, and so does a row without a marker | committed |
| advisory answer | the reviewer writes `- [PRECEDENT] <key>: reuse\|extract\|justify\|dismiss — file:line reason`; SubagentStop appends these to `.harness/precedent/dispositions.jsonl`, a separate file, so `LEDGER_FORMAT` is unchanged. Informative only; counted per rule | local |
| advisory won't-fix | a staged proposal to `advisory-allow.json`, applied by a human | committed |

**"Justify" stays a two-place reviewed act.** The agent can write the marker and stage the proposal. It cannot apply the proposal, and no gate reads proposals. An owed justify therefore blocks until a human applies the row. This is deliberate, and it is today's `duplication` contract. Owed is kept narrow, and an autonomous legal move (reuse or lift) always exists except for pairs already allowlisted.

**No double penalty**

| State of a key | Write time | Review | Stop / CI | After merge |
|---|---|---|---|---|
| owed, acted on | shown | `resolved:*`, not judged | green | — |
| owed, ignored | shown | `owed(machine)`; reviewer told not to re-raise | **one** red | cannot merge |
| advisory, reviewer BLOCK | shown if eligible | the one penalty | green | fixed in turn |
| advisory, reviewer PASS | shown if eligible | MEDIUM/LOW, or nothing | green (unless ratcheted) | issue (backlog, not a penalty) |
| ratcheted | shown | `ratchet(machine)`, not judged | red only if the count rises | issue |

Being shown a key and ignoring it never adds a penalty. Write-time showing is only a warning about a verdict that the tree will produce anyway.

**Ratchets against cumulative slop.** Each PR looks benign; the decay is cumulative (SlopCodeBench, CodeThread). A rule **graduates** from advisory to ratchet only when its effective false-positive rate on eval plus dogfood is ≤10% and its reviewer dismiss rate is ≤10%. Graduation is a gate-proposal shipped behind a ramp: a per-release decision, never a runtime toggle.

**Ramps.** Owed rules and graduations use `rampNote('duplication', '2.1.0', …, {until:'2.3.0'})` (`gate.mjs:283`). During the ramp, withheld findings go through `noteAdvisory` (so they reach issue sync) and the Stop `PRECEDENT —` summary (so they survive a green turn). Fresh installs get the rules live.

## 5. Advisory → GitHub issue pipeline

**Recommendation on "all unfixed advisories": not literally all.** Every **class-A, machine-recomputable** advisory becomes *visible* on GitHub: the top 50 as individual issues, the rest on one dashboard issue. That covers precedent keys from a whole-tree sweep, ramp NOTE sites (withheld findings as checklists), provenance classes, control-off and drift, and scheduled-lane reds, one issue per lane (`w2-advisory-inventory.md` rows 1–5, 10, 20–21). Excluded:
- **Class B** (SKIPPED, STAMPED, per-turn): they would open and close every turn.
- **Class C** (already in registers, code scanning or Renovate): linked from the dashboard, never duplicated, because two copies drift (`check-obligations.mjs:22-27`).
- **Reviewer prose:** it cannot be recomputed and carries injection risk. A reviewer finding becomes an issue only if it *is* a machine key.

**Identity.** The marker is `<!-- harness-advisory v1 key=<16hex> body=<sha8> -->`, with the key from §2.1. For a ramp, the subject is `(file, detail with digits normalised)`.

**Lifecycle**

| What the sync sees | Action |
|---|---|
| A new key | Promote by: now-blocking > ramp near `until` > owed-class precedent with the widest spread > provenance > drift > first-seen > key. Up to 10 new per run, 50 open at most; the rest go on the dashboard |
| Body changed | Edit the issue. Never post "still present" comments |
| Key absent in **2 consecutive runs whose gate completed** | Close `completed` |
| Gate skipped or failed | Do nothing |
| Gate has not completed for 7 consecutive runs | Add the `advisory:stale-evidence` label and a dashboard banner (the "unrelated red gate" gap) |
| Key in an allow file | Close `not_planned` |
| A closed-completed key returns | Reopen it |
| Closed by a human with no allow row | Leave it closed; list it as "closed without reviewed exemption"; it still counts toward any ratchet |

**Baseline.** On the first run, or whenever the caps overflow, everything goes to the dashboard and promotion is gradual.

**Workflow security: `advisory-sync.yml`.** Triggers are `schedule` (2 h after the nightly `quality-gate`, `quality-gate.yml:32-34`) and `workflow_dispatch` only.
- **compute** (`contents: read`, `actions: read`): recomputes the `static` lane in the workflow (`validate --min-floor --report-all`, then `precedent --sweep`). It accepts `advisory-records` artifacts only from the same repository's `schedule` run whose `head_sha` is HEAD, and validates them against a strict schema.
- **sync** (`issues: write` only): no install; harden-runner `egress-policy: block` to `api.github.com:443`; text sent through `gh api --input -`, never `${{ }}`. It touches an issue only when the bot is the author and the label and line-1 marker are present. `concurrency` with `cancel-in-progress: false`; permissions pinned by a factory test.

**Base vs module.** The recorder and the precedent core ship in **base**. Issue sync is the opt-in module **`advisory-issues`**: it holds the scaffold's first `issues: write`, and 2.0.0 is the opt-in release.

**Factory vs consumer.** Consumers get the module. The factory runs `factory-advisory-sync.yml`, beside `hygiene.yml`, over a CI install of scaffold plus demo. Its `dogfood`-labelled issues use a `factory:` key namespace, and obligations rows (inventory row 19) go there too. The two repositories' issues never mix.

## 6. Optional embedding layer (module `precedent-embeddings`)

- **Model:** `voyage-code-4`, pinned to its dated snapshot, at 512 dimensions, int8 plus binary. Local alternative: Qwen3-Embedding-0.6B through an OpenAI-compatible endpoint. Both are reached with plain `fetch`, no SDK. The data-policy acknowledgement must be recorded before the first call (`w2-completeness-critique.md` §1.8).
- **Storage:** `.harness/precedent/emb/<modelKey>/{vectors.i8,bits.u32,rows.jsonl,meta.json}`. The flat file is read with exact search: a binary prefilter selects the top 200, then int8 rescores them.
- **Determinism boundary:** vectors are computed only off the synchronous path. An `async` PostToolUse entry embeds changed functions, and the nightly sweep embeds the rest. Synchronous moments only read the cache, and print `semantic: k/n cached` when coverage is partial.
- **Which tiers it can reach.** Never owed or ratchet. At **write time** (edit dossier, author brief) it shows **nothing**. It may add at most 2 `context` hits to the plan brief (pulled) and to the reviewer packet, the latter only with at least one deterministic corroborator (shared callee or table, equal arity plus return shape, or Jaccard ≥0.15). It reaches `advisory` (an issue) only with the same corroboration, and that issue closes when corroboration is absent for 2 runs.
- **Evaluation:** the seeded T3/T3+/T4 corpus from `w2-embeddings.md` §6. Recommend the module at ≥15 points of T4 recall@5 at advisory precision ≥0.8, with the owed set asserted unchanged. Ship as context-only at 5–15 points; do not ship below 5. Re-embed a probe set and disable the layer loudly if cosine falls below 0.995.

## 7. Resolution of the six tensions and the gaps

1. **Semantic hits at write time:** none. Write time is deterministic; semantic hits appear only in the plan brief (pulled), the review packet (corroborated) and issues (corroborated).
2. **Issue identity:** `gate|rule|sorted symbol ids`, where an exported symbol is `package#export`. Moves inside a package keep the key. Content fingerprints are evidence, never identity.
3. **Closing:** two consecutive complete runs without the key, or an allow row (`not_planned`). A content-hash change, a cosine drop or a justify answer never closes an issue by itself.
4. **Every advisory as an issue:** §5. Class A becomes an issue or a dashboard line. B is excluded and C is linked. Reviewer prose and local dossier hits reach issues only as machine keys recomputed in CI. The "committed register of local hits" option is rejected: it would write into guarded `tools/` and duplicate the tree.
5. **Nagging versus owed:** verdicts are functions of the tree only. Reuse and extract cancel the debt mechanically, so there is no "shown, then ignored" penalty. Reviewers judge only advisory keys and the text of a justify. Owed and ratchet keys arrive marked `(machine)`.
6. **The agent loop versus distrusted advisory text:** the loop receives only `key` and `rule` (a closed enum). It never reads issue bodies or comments. It re-derives the finding with `precedent --explain <key>`; if the key does not reproduce, it stops. Gated on probe (d) (§12).

**Gaps:**

| Gap | Resolution |
|---|---|
| CI backstop | §4: owed is recomputed in CI; justify is a committed row |
| Advisories from every lane | Nightly artifacts, plus the static lane recomputed in the sync workflow (§5) |
| Diff-time hits vs the sweep | Owed is diff-scoped; the whole-tree sweep feeds issues only, in baseline mode |
| The existing `duplication` gate | Owed rules live inside it; one owed store, one advisory store; inline markers are only the site half of a two-place act |
| Ramping the new rules | `rampNote` + `noteAdvisory` + the Stop summary line |
| A gate red for an unrelated reason | `stale-evidence` label after 7 runs |
| Delivery to read-only reviewers | Cache-only SubagentStart (about 2 s, inside the 10 s budget) plus the fallback file |
| Opt-in model | §12 |
| Which repository | §5 |
| Action-rate measurement | Telemetry carries only `rule` and outcome (`shown`, `acted`, `dismissed`), never paths (`hookio.mjs:56-58`). "Acted" = keys shown this session that resolved by reuse or extract at Stop |
| Concurrency | Per-session overlays, atomic index rename, shown-ledger lines under 4 KB |

## 8. What it deliberately does NOT do

**Deletion bias.** Lift is complete only when both copies are deleted in the same PR. The refactor loop's PRs must reduce non-test LOC. The rule-of-two law inlines a shared export that has lost its second consumer.

**Rejected ideas, and why:**
- **Bodies or "similar code" in any payload:** similar code is noise (up to −15%), and copying is the failure mode.
- **PreToolUse deny before a write:** thrash. **UserPromptSubmit injection:** it fires before any code exists.
- **A v1 MCP server:** six registry edits for a pull-only tool the CLI already covers.
- **A canon register:** altitude already says what is canonical.
- **Inline-only justify:** the agent would exempt itself. **Calendar expiry:** verdicts would change with the date.
- **Reviewer memory:** the packet holds tree and delivery facts, never past conclusions.
- **Co-change, feature envy, module depth:** noisy on young repositories, 15% precision, and unvalidated respectively.
- **Import-graph-only selection, LLM-built graphs** (which skip about 31% of files), **SARIF, third-party issue actions, auto-merge.**
- **An auto-extraction codemod:** the agent edits, and the gates judge the result.
- **Rule-of-three:** the trigger is the third copy *about to be born*; three existing copies are already slop.

## 9. Evidence trace

| Mechanism | Finding | Source |
|---|---|---|
| Write and scaffold-time delivery | Infer 70% vs 0% batch; SWE-agent lint loop 18.0 vs 15.0 | `w2-write-time.md` §2 |
| Obligation, not context alone | RepoReuse: unused in-workspace context | `w1-ai-slop-evidence.md` Q3 |
| Pointers, not bodies | Similar code −15%; API info helps | `w2-write-time.md` §2 |
| ≤3 items | A3-CodGen >5 interfere; RARe top-1 wins | `w2-write-time.md` §2; `w1-agent-context-retrieval-sota.md` Q2 |
| Canonical altitude first | RepoCoder amplifies existing duplication | `w1-ai-slop-evidence.md` Q4 |
| Exact type-2 owed, type-3 advisory | Rename-invariant hashing is precise; most clones benign | `w1-clone-similarity-sota.md` Q2, Q6 |
| Deterministic proposes, LLM judges | EM-Assist 76% hallucinated; ACE 37%→98% | `w1-ai-slop-evidence.md` Q4 |
| Neutral facts, independent pass | Anchoring; framing flips verdicts | `w1-design-quality-signals.md` Q7 |
| ≤10% FP before interrupt or ratchet | Tricorder | `w2-write-time.md` §3.2 |
| Ratchets | Erosion in 80% of trajectories; 50.8% duplicate by turn 5 | `w1-ai-slop-evidence.md` Q1 |
| Slots and concept graph | Anatomy, seams, deliberate parallels | `w1-stack-anatomy.md` §1–5 |
| Lift into new packages | Seeded roots block new exports | `T/tools/duplication-allow.json:30`; `installer/lib/layout.mjs:101-109` |
| Proposals for justify | Existing two-place channel | `T/docs/harness/README.md:258-279` |
| Issue lifecycle and security | Search-API duplicates; template injection; egress block | `w2-issue-sync.md` §1–3 |
| Loop guardrails | Headless denial; issue-text injection | `CONTROL-PLANE-FACTS.md:618-628`; `w2-issue-sync.md` §4 |
| Embeddings as corroborated context | exec@1 0.33; validators in retrieval | `w2-embeddings.md` §2 |

## 10. Cost and latency budget

All figures are estimates, extrapolated from runs measured on the bare scaffold: `duplication` 310–330 ms over 234 files and 27.5k lines, the i18n TS parse 106 ms, a bare node start 33 ms, and `launch.mjs` with source-check 60 ms.

| Moment | Scaffold, cold | Scaffold, warm | 200k LOC, warm | Tokens to the model |
|---|---|---|---|---|
| Plan CLI | 1 s | 0.3 s | 0.6 s | ≤500 |
| Scaffold | +0.3 s | | +0.5 s | ≤200 |
| PostToolUse | p50 150 ms, p95 300 ms, deadline 1 s, hidden under Biome | | same: lookup only, `merged.bin` about 6 MB | ≤400 × ≤3 per prompt |
| SubagentStart | ≤2 s (re-extracts changed files only) | | ≤2 s | ≤800 author / ≤1,000 per reviewer |
| Stop: `duplication` with owed rules | 0.8 s | 0.4 s | 1–2 s | 0 when green |
| CI `static` (always cold) | 1 s | | about 10 s, against a 15 s step ceiling in `chain-budget.json` | — |
| Nightly sweep | 2 s | | about 30 s (LSH candidates, about 20k functions) | — |
| Refactor loop | — | | — | 1 run per day, `--max-turns 60`, about $1–4 per run |
| Embeddings (module) | — | | about 2.5M tokens cold, about $0.30 | — |

**Scaling to 200k LOC:** a per-blob cache; a binary LSH table; `worker_threads` (4) for cold extraction; L1b limited to HIGH-polarity slots and cross-package pairs; a swap to `oxc-parser` behind `extract.mjs` only if CI cold time breaks the 15 s ceiling; and a `precedent` row in the factory's `chain-budget.json`.

## 11. Evaluation

**1. Deterministic tiers** (`tests/precedent/`, factory, no LLM)
- Apply inverse refactorings to a demo install: inline a function, rename and reinvent, insert a middle man, duplicate the port cast, restate a bound, re-grow an SQL rail, add a boolean selector.
- Difficulty tiers T1–T5. For every seed there is a **clean twin** and a **decoy twin**:
  - `mapPostgrestFailure`'s read/write asymmetry, documented as deliberate at `D/…/notes/src/data/errors.ts:18-21`;
  - the procedure ↔ action pair;
  - the per-consumer ports.
- Each owed rule also gets an anti-vacuity canary that must go red.
- Bars:
  - owed precision 1.0 on decoys and twins, with zero false owed;
  - owed recall ≥0.95 on T1–T2;
  - advisory precision ≥0.8 per rule before the rule is shown at write time.

**2. Dogfood corpus.** 15 labelled keys that already exist in a demo install with the push slice applied (`w1-stack-anatomy.md` §5–6): failure mapper ×3; port types ×4; the push cursor codec, `asRowArray` and `mapFailure`; write-context assembly (router vs action); port cast ×3; "renderable title" ×3; NoteView's restated bound; `NOTE_TITLE_MAX` vs the SQL CHECK; `deny_mutation`, `ensure_partitions` and `drop_partitions` ×2 each; mobile `src/components` vs `design-system-native`; i18n key divergence. Bar: at least 11 of 15 under their expected rule, and zero hits on the 9 `duplication-allow.json` rows.

**3. Reviewer eval** (`scripts/reviewer-eval.mjs`).
- New `KINDS` (`:72`): `helper`, `slot`, `sql-rail`, `promotion`.
- New companion rows, each restating an existing rule:
  - architecture `reuse-existing-home`, stated by (e)/(f), enforced by `duplication`;
  - architecture `lift-record`, stated in `boundaries.md:34-36`, enforced by `boundaries`;
  - torvalds `no-pass-through`, stated by (d), `review only`.
- Each kind gets a BLOCK case, a PASS twin and a **decoy twin**. A new `mustCite` field requires the reviewer to name the existing home's path.
- A/B the `livePrompt` with and without the packet, n ≥ 3 runs per case. Bar: BLOCK recall +20 points with the packet, and no fall in the decoy PASS rate.

**4. Generation eval** (factory-local `claude -p`; Fact 5 means no CI lane). 20 tasks plus 4 chains of 5 turns (the RepoReuse design), with arms OFF, ON, and ON with embeddings. Bars:
- canonical-reuse recall up;
- decoy false-reuse ≤10%;
- renamed or near clones per KLOC down;
- turn-5 chain redundancy at most half of OFF;
- pass rate within 2 points;
- tokens +≤15%.

**5. Loop eval** over 30 days: ≥70% of loop PRs merged unmodified, zero reverts, net LOC ≤ 0 on every PR, and the total advisory count monotonically falling.

## 12. Rollout (after `stack/52-i37-work-plan` merges)

**Ships in base**
0. **Spike-0 probes** (CONTROL-PLANE-FACTS 19–23): (a) does SubagentStart `additionalContext` reach the *subagent*? (b) does PreToolUse `Agent` `updatedInput` rewrite the prompt? (c) does a PostToolUse `additionalContext` fired inside a subagent reach that subagent? (d) headless `claude -p`: subagent tool permissions via a PermissionRequest hook, plus `HARNESS_SESSION_ID`, without which `reviewer-verdicts` skips (`check-reviewer-verdicts.mjs:146-160`); (e) `async` PostToolUse.
1. **Gate-proposal issues:** (i) owed rules in `duplication`; (ii) `shared-rule-of-two` in `boundaries`; (iii) the ratchet framework, with no rules graduated yet.
2. `tools/lib/precedent/` and `tools/precedent.mjs`, plus `closed-text.mjs`. No gate reads them; legal on an empty tree.
3. `noteAdvisory` in `gate.mjs` and the Stop `PRECEDENT —` summary.
4. **[factory]** `tests/precedent/` seeded corpus and dogfood labels.
5. `duplication` owed rules: canaries, ramp `2.1.0 → until 2.3.0`, `rule` field on allow rows, both-ways marker census.
6. Plan brief: the `## Reuse` spec section, SKILL Step 0, `new-feature.md`.
7. `scaffold-slice` v2, the `lifting-shared-code` skill with `scaffold-shared.mjs`, and `shared-rule-of-two` (ramped).
8. `posttool-precedent.mjs`. Subagent delivery is enabled only if probe (c) passes.
9. `subagent-precedent.mjs`, the reviewer and author body lines, and an `agents.lock.json` regen. Gated on probe (a) or (b), with the file fallback otherwise.
10. **[factory]** Reviewer-eval kinds, rows, twins, decoys and `mustCite`.
11. **[stack/demo]** Dogfood Lift: `packages/shared/keyset` (cursor codec), `packages/shared/row-array`, and verticals calling `mapPostgresError` for the SQLSTATE half.
    - Shipped `seedOnInitOnly`, so new installs get them and existing installs opt in via `update --refresh-seeded` (`update.mjs:9-13`, `:653`), with a `source-fixes` note. This sidesteps the seeded-root blocker: a **new** package is additive, while an export added to a seeded file never arrives.
    - A forward migration unifies `deny_mutation`, under its ADR.

**Ships as modules**
12. Module `advisory-issues`.
13. **[factory]** `factory-advisory-sync.yml`.
14. Module `refactor-loop`, only after probe (d) (§12.1).
15. Module `precedent-embeddings`, only after the §6 bar is met.
16. **[base, ramped]** Graduations to ratchet, per rule, on measured false-positive rates.

### 12.1 The refactor loop (module `refactor-loop`)

- **Selection.** `refactor-loop.yml` runs daily plus dispatch. `tools/ci/refactor-pick.mjs` emits **only** `{key, rule}`: the oldest `agent:ready` issue whose rule is allowed by `tools/refactor-loop.json` (seeded, write-guarded). Allowed: `renamed-clone`, `reinvented-export`, `near-clone`, `bound-restated`, `pass-through`, `superseded-symbol`. Never SQL, security classes or `now-blocking` keys.
- **Run.** SHA-pinned `claude-code-action` with a fixed prompt template (`precedent --explain <key>`, then reuse or Lift only). The repo's own `.claude/` hooks apply, so the Stop chain and reviewers run. A PermissionRequest hook allows only reviewer read-only tools; `HARNESS_SESSION_ID` is set; harden-runner blocks egress.
- **Permissions.** `contents: write` (push `claude/advisory-<key8>`), `pull-requests: write`, `issues: read`. The loop never writes issues; the sync job counts attempts from PR state.
- **Churn guards:**
  - at most 1 open loop PR and 5 per week;
  - a 14-day per-file cooldown after a merged loop PR, read from git history;
  - 2 attempts per key, then `agent:blocked` (human relabel only);
  - a ping-pong stop: a loop merge that creates any new key gets `loop-regression` and pauses the loop until a human relabels;
  - forbidden paths: `ESCAPE_LISTS`, `tools/`, `.claude/`, `.github/`, `supabase/migrations/`, `harness-proposals/`, so the loop can never justify;
  - a diff of ≤400 lines and ≤12 files;
  - CI must show the target key gone, no rule's count up, and net non-test LOC ≤ 0;
  - no auto-merge.

## 13. Risks and failure modes

| Risk | Mitigation |
|---|---|
| The probes fail | Fall back to the file, which relies on the agent choosing to Read it. Prevention weakens; enforcement does not change |
| The agent rebuilds a function from its signature | An exact rebuild is owed; anything else is advisory or ratchet |
| Premature abstraction (Torvalds' `make_u32` objection) | Rule-of-two law; single-consumer facts in the packet; the loop never creates a helper with one user |
| Gaming the fingerprint (renaming properties to dodge L1a) | L1b still catches it; decoy and twin evals |
| Owed false positives on deliberate twins | `TWIN_SLOTS`, allow rows, a PASS canary per twin |
| Seeded-root delay | Existing installs keep old copies until they opt in; issues remind them |
| The loop's cost, churn, and injection through code it reads | Key-only input, egress block, churn guards |
| A stale or corrupt index | Keyed by content; candidates re-hashed; stale pointers dropped; null reported loudly |
| An advisory flood when adopting a 200k-LOC codebase | Baseline mode, caps, dashboard |
| Dossier and reviewer-body verbs drift apart | Docs-sync holds `reuse\|extract\|justify\|dismiss` as `doctrine-symbols` |

## 14. Open questions for the user

1. **Human availability for the second place of a justify.** Applying `apply-proposal` needs a human at a terminal. If you want *zero* human touch, the design needs a second principal, such as a CODEOWNERS bot identity, which would replace the human-only apply. Is a human applying proposals within about a day acceptable?
2. **Who runs the refactor loop?** GitHub Actions with an `ANTHROPIC_API_KEY` secret (a CI write lane; the security model in §12.1), or a Claude Code routine on your account (it pushes `claude/*` as you, and is limited to hourly schedules)? Is the loop allowed to auto-merge when everything is green and the reviewers PASS, or do merges always need a human? The default here is a human.
3. **Template dedupe.** Is the `seedOnInitOnly` / `--refresh-seeded` delivery for the factory's own Lift fixes (PR 11) acceptable, or do you want a 3.0.0 that re-adopts the seeded shared roots so that existing installs converge?
