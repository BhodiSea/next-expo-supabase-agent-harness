# Concept Atlas: the scaffold's anatomy as the retrieval substrate

Every fact about the stack-head tree is cited as `file:line`. `T/` = `template/base/`, `S/` = `template/stack/`, `D/` = `template/demo/`.

## 1. Name and thesis

**Concept Atlas** (`atlas`). A generic index guesses what code is related, using imports, text or vectors. This harness does not have to guess, because it already declares its own anatomy:
- seven behaviour-keyed vertical laws (`T/tools/lib/vertical-anatomy.mjs:51-66`);
- one documented snake→camel seam (`T/.claude/agents/architecture-reviewer.md:49-52`);
- generated inventories that join functions to tables and columns (`T/tools/lib/query-shapes.mjs:42-60`);
- a closed set of SQL rails (`tenancy.json`, `db-limits.json`);
- registers that say which rows a vertical owns (`demo-index.json`), which files feed which gate (`stamp-inputs.mjs`) and which reviewer a path summons (`reviewer-triggers.json`);
- a reviewed list of deliberate parallels (`duplication-allow.json`).

The atlas compiles these declarations into a typed graph. Every function, SQL object and register row in it has three coordinates: **(unit, slot, concept)**.

Retrieval is **slot-aligned comparison**. A function is compared only with its slot peers in other verticals, with the shared homes (platform and kernel exports) and with the SQL rails, and each slot carries a declared expectation:
- **converge** slots (ports, row seams, error mappers, codecs): a cloned body means a missing generic;
- **diverge** slots (domain rules, query chains, UI): similarity means a reinvented helper;
- **twin** slots (procedure ↔ Server Action, web ↔ native design system): drift between the two is the finding.

The concept wire (SQL column → row key → DTO field → procedure → route → i18n key → testID) becomes a graph walk instead of rubric prose. Only mechanical, CI-recomputable facts block. Everything else is a pointer dossier (paths, symbols and signatures, never bodies), pushed at the moments an agent decides and pullable on demand. No generic tool can know what "the same slot in another vertical" means. This harness writes it down.

## 2. Architecture

### 2.1 Components

| Component | Location | Hooks into |
|---|---|---|
| Slot table and expectations | `tools/lib/atlas/slots.mjs` | reuses the `vertical-anatomy.mjs` behaviour keys (`POSTGREST_CALL` :66, port-presence) |
| Deliberate-parallels doctrine | `tools/lib/atlas/parallels.mjs` | transport twins (`dal-dto.md:132-152`), the per-consumer port (`architecture-reviewer.md:42-44`), the design-system mirror |
| TS / SQL extractors | `tools/lib/atlas/extract-{ts,sql}.mjs` | R07 `loadParser()` (`T/tools/lib/i18n-tree.mjs:98`); `sql-parse.mjs` `parseColumnFacts:978`, `parsePolicies:481`, `parseFunctions:1045`, `parseTriggers:1107`, `parseGrants:1158` |
| Register reader | `tools/lib/atlas/registers.mjs` | `tools/generated/*.json`, `routes.generated.ts`, mobile `routes.ts`, both i18n catalogs, `data-flow.json`, `tenancy.json`, `db-limits.json`, `PARITY.md`, `demo-index.json`, `STAMP_INPUTS`, `reviewer-triggers.json`, `duplication-allow.json` |
| Graph, ranking, comparison, dossier, printer | `tools/lib/atlas/{graph,rank,compare,dossier,print}.mjs` | `print.mjs` reuses the closed validators of `harness-brief.mjs:46-70` (lockstep test) |
| Pull CLI | `tools/atlas.mjs` (`--plan`, `--near`, `--concept`, `--explain <key>`, `--census`, `--advisories`, `--json`) | — |
| Gate | `tools/check-atlas.mjs` | Stop step `atlas` right after `duplication` (`T/tools/harness.config.mjs:201`); the same command in the `quality-gate.yml` `unit` job beside `:206-210`; appended to `tools/stop.floor.json` |
| Write-time hook | `.claude/hooks/posttool-atlas.mjs` | PostToolUse `Edit\|Write\|MultiEdit`. It is invoked **directly**, not through `launch.mjs`, so it fails open like `session-brief.mjs`. |
| Dispatch hook | `.claude/hooks/subagent-atlas.mjs` | a second SubagentStart/SubagentStop entry, also invoked directly. `subagent-verdict.mjs`, its fail-closed Stop and `LEDGER_FORMAT` are untouched. |
| Cache | `.harness/atlas/` | git-ignored (`T/gitignore:60-61`). Hooks write through Node; the agent's Edit and Write are denied. |
| Census (the advisory register) | `tools/generated/atlas-census.json` | generated, write-guarded, regen-diffed by `atlas` |
| Exemption store | `tools/duplication-allow.json` plus a `pairs[]` array | already in `ESCAPE_LISTS` (`enforcement-surface.mjs:88`) and write-guarded (`guard-rules.mjs:605`) |

Everything under `tools/` and `.claude/` is owned, write-guarded and hash-pinned, and reaches existing installs through `update`.

**Parser.** The project's own `typescript`, syntax-only (`ts.createSourceFile`, no Program).
- It is already a root devDependency (`T/package.json.tmpl:65`), and the i18n gate already pays for the same parse (106 ms).
- If it is absent, `skipOrFail` applies (`gate.mjs:182`): a NOTE locally, a failure in CI.
- Rejected for base: oxc and ast-grep (native binaries), and a type-checked Program (too slow).
- The records are parser-neutral. If a cold step exceeds 30 s at 200k LOC, oxc moves into a module.
- SQL reuses `sql-parse.mjs`.

### 2.2 Record formats

**Per-file record** at `.harness/atlas/files/<blobSha>.json`, keyed by `(blobSha, extractorVersion)`, so a moved file costs nothing:

```json
{"v":1,"path":"packages/verticals/notes/src/data/rows.ts","unit":"notes","slot":"rows",
 "exports":[{"name":"asRowArray","kind":"function","line":98,"arity":1,"sig":"(data: unknown) => readonly NoteRow[]"}],
 "fns":[{"name":"asRowArray","span":[98,104],"ntok":41,"stmts":3,"alpha":"9c1e…","mh":"<128×u32>",
         "callees":["NoteRow.array"],"tables":[],"words":["as","row","array"]}],
 "imports":[{"spec":"@app/contracts","names":["NoteRecord"]}],"postgrest":[{"op":"from","table":"notes"}],
 "zod":[{"name":"NoteRow","keys":["id","owner_id","title"]}],"maps":[{"from":"owner_id","to":"ownerId"}],
 "bounds":[{"name":"NOTE_TITLE_MAX","n":200}],"i18n":["notes.composer.title"],"testids":["note-row"],"lits":["n:5242880"]}
```

- `alpha`: a subtree hash with locally bound names replaced by binding order. Imported and global names are kept, so a hit can say "reinvents `@app/supabase`".
- `mh`: a MinHash over AST node-kind 3-shingles, with LSH bands of 32×4.

**SQL record:** `{tables:[{t, cols:[{c,type,null,check}]}], fns:[{q, body:<schema-normalised hash>, rail}], policies:[{t, op, cls:<hash with table→$T>}], triggers:[{t, key:"timing|events|forEach|execute|args"}]}`.

**Shown-ledger** at `.harness/atlas/shown.jsonl`. Append-only, one line under 4 KB, ids only:
`{v, session_id, prompt_id, agent_id, agent_type, moment, key, rule, tier}`.

**Endorsements** at `.harness/atlas/endorsements.jsonl`:
`{session_id, agent_id, agent_type, key, stance:"endorse|reject", state:<reviewStateDigest, reviewer-verdicts.mjs:243>}`.

### 2.3 Graph schema

**Nodes:**
- code and anatomy: `file`, `sym:<unit>:<slot>:<name>`, `slot:<unit>/<slot>`, `slotclass`;
- SQL: `table`, `col:<s.t.c>`, `sqlfn`, `policy`, `trigger`, `rail`;
- wire: `dto`, `field`, `action`, `route:web|mobile`, `i18n:<surface>:<key>`, `testid`, `event`;
- registers and process: `row:<register>#<pointer>`, `gate`, `reviewer`;
- `concept:<stem>`: the snake/camel-folded word, the hub of the wire.

**Edges.** Each records `via`, its derivation, so a dossier can say why two things are linked.

| Edge | Derivation (deterministic) |
|---|---|
| `contains`, `instance-of` | path plus slot rules plus behaviour keys |
| `imports`, `calls` | specifiers resolved through workspace `exports` maps; calls to imported names (single hop) |
| `reads-col`, `writes-col`, `filters-col`, `sorts-col`, `rpc` | `query-shapes.json` `fn/table/columns/payload/eq/order/rpc` |
| `projects`, `maps` | the `rows.ts` projection literal; key pairs of `to<X>Record`, the one seam |
| `bounds` | the convention `<ENTITY>_<FIELD>_MAX` ↔ `CHECK char_length(<field>)` |
| `borrows` / `restates` | `X.shape.f` reuse, versus a re-declared zod chain with the same name |
| `serves`, `twin` | the procedure calls vertical function F, and `apps/web/app/actions/<v>.ts` calls the same F |
| `renders`, `titled`, `state`, `uses-key`, `asserts` | `WEB_ROUTES {id,titleKey,states,file}`, mobile routes, `t('…')` and `testID=` literals, the Maestro/e2e scan |
| `rail-use`, `same-class` | trigger `execute` and policy calls matched against the rails in `tenancy.json`/`db-limits.json`/`00_shared.sql`; equal body or class hash |
| `owns-row`, `stamps`, `triggers` | `demo-index.json` (or rows naming the vertical's tables); `STAMP_INPUTS`; trigger globs |
| `co-change` | PR as the transaction, \|T\| ≤ 30, Wilson-ranked; **off until 50 PRs** |
| `parallel`, `concept` | `parallels.mjs` plus `pairs[]`; name → stem |

Selection is by **typed** edges, of which imports are only one kind. This honours the rejection of "selection by import graph" (`design/FIELD-UPGRADES-2026-09.md:911-929`).

### 2.4 Slots and expectations (a closed set)

| Slot class | Expectation | Owed rule | Advisory rules |
|---|---|---|---|
| `port`, `rows`, `errors`, `probes`, `codec`, `events`, `barrel-*`, `router`, `read-seam`, `page-meta`, `sql-schema` | converge | `slot-clone` | `promotion`: the same helper in ≥2 verticals, or a near-match in a home such as `mapPostgresError` (`S/packages/platform/supabase/src/errors.ts:134`). `shape-drift`: the slot lacks exports that most of its peers have. |
| `domain`, `dal`, `schemas`, `web-route`, `mobile-ui`, `mobile-hook` | diverge | `slot-clone` | `near-clone`; `reinvent` (signature and word overlap with a home export) |
| router ↔ action, read-seam ↔ mobile-hook, ds-web ↔ ds-native, i18n web ↔ mobile | twin (whitelisted) | — | `twin-drift`: the argument shapes passed to the shared F differ, as with `ctx.now` vs `new Date()` (`D/packages/api/src/routers/notes.ts:44-51` vs `D/apps/web/app/actions/notes.ts:76-81`). `i18n-parity`. |
| `platform/*`, kernel, `api-context`, rails | home | — | `single-consumer` (excluding `port.ts`) |
| `apps/mobile/src/components` ↔ `design-system-native` | unlisted parallel | — | `parallel-unlisted` |
| `test`, `generated`, `tooling`, `unclassified` | excluded | never | never |

### 2.5 Signals and layers

- **L0:** the `duplication` gate, unchanged: type-1 clones of at least 70 tokens over 6 lines (`check-duplication.mjs:30-31`).
- **L1a, α-hash:** type-2 clones of **at least 25 normalised tokens and 2 statements**. This is the 25–69 token band that L0 misses, where `asRowArray` and `mapFailure` live.
- **L1b, MinHash:** type-3 clones, with a per-slot `T_slot` calibrated on the dogfood corpus and kept in `tools/lib/atlas/thresholds.mjs`.
- **L1c:** same arity, normalised parameter and return types, and word-Jaccard ≥ 0.5 against a home export. This is the "reinvented helper" signal.
- **L1d:** Jaccard of the callee sets and table sets.
- **L2, anti-unification counts only:** the number of holes and their kinds, never the template text.
- **L3, embeddings:** module only (§6).

**SQL rails.**
- `rail-reinvent` is owed when the diff adds it: the function body hash equals an existing function's after schema normalisation. Examples: `audit.deny_mutation` (`S/supabase/migrations/20260202000000_audit.sql:196`) vs `auth_trail.deny_mutation` (`20260816000000_auth_event_trail.sql:132`), or a re-implemented `set_updated_at`.
- `rail-near` is advisory.

**Concept wire.**

Owed when the diff introduces it:
- `wire-orphan`: a projection column that is not a SQL column. This is hop 6, which nothing checks today.
- `wire-bound`: a `*_MAX` constant that differs from the CHECK.
- `wire-rename`: `camel(column) ≠ field` at the seam. This is exactly rubric (d).

Advisory:
- `wire-restate` (`NoteView`, `D/packages/contracts/src/index.ts:295`);
- `wire-respell`;
- `parity-cell` (`D/PARITY.md:27-29`).

**Catalogue signals, advisory or context only:** #5 systematic edit; #6 fact census (e.g. the port cast ×3); #9 single-consumer abstraction; #10 pass-through; #17 data clumps; #18 naming lineage; #20 boolean selector; #24 intent-hiding helper; #27 bypassed helper; #28 superseded symbol. #1 co-change is context only. **Slop taxonomy covered:** reinvented helper, copy-adapt, one concept/many names, parallel implementation, wrapper-of-one, speculative generality, constant sprawl, boolean fork, superseded helper.

### 2.6 Ranking and caps

**Personalised PageRank, seeded on the diff.** Changed symbols, SQL objects and register rows get weight 1; new ones get weight 2.
- α = 0.15, **40 fixed iterations**, scores rounded to 1e-6, ties broken by id.
- Edge weights: wire and slot 1.0, `calls` 0.8, `concept` 0.7, `imports` 0.6, `contains` 0.5, `co-change` 0.3, `stamps` and `triggers` 0.2.
- Hubs of degree > 64 are damped ×0.1 but stay eligible as homes.

**k-hop wire walk.** At most 4 hops from each changed column, field or action. Each hop is marked `linked`, `convention` or `missing`.

**Eligibility.** Only slot peers, homes, rails and wire nodes are eligible. Owed findings rank first.

**Caps:**
- write time: 3 items and 1,500 characters, at most 3 dossiers per prompt;
- author dispatch: 8 items, 3,000 characters;
- reviewer dispatch: 10 items plus up to 40 changed paths, 4,000 characters;
- Stop: every owed finding, spilling to a log beyond 8,000 characters;
- CLI: 10, or `--all`.

## 3. Delivery protocol

| Moment | Channel → recipient | Content |
|---|---|---|
| Plan | **Pull:** `node tools/atlas.mjs --plan <entity> [--cols] [--verb]`, added to Skill Step 0 (`SKILL.md:20-34`) and as a `## Reuse` section in `specs/_template.md:27`. Main agent. | Existing actions for the entity and verb; tables and DTOs with overlapping columns; the exemplar per slot; rails; homes. Advisory and context are fine here, because nothing has been written yet. |
| Scaffold | `scaffold-slice.mjs` prints `atlas:` lines after its `next:` lines (`:161-180`). Main agent. | Exemplar, homes and rails per slot, and names the slots the script does not create (port, rows, errors, probes). |
| After an edit | `posttool-atlas.mjs` → `additionalContext` (Fact 18; precedent `posttool-source-check.mjs:101-113`). The editing agent; a subagent once probe (c) passes. | Speaks only when the edit adds a file, export, SQL object or zod schema **and** an **owed-tier** hit exists. |
| Author dispatch | `subagent-atlas.mjs` SubagentStart → `additionalContext` (probe a). `dal-author`, `migration-rls-author`, `test-author`. | Slot map and homes for the verticals in the diff and turn overlay. After probe (b), it is also seeded from `Agent` prompt tokens, but only tokens that resolve to existing node ids. |
| Reviewer dispatch | The same hook, for `reviewerTypes()`. `architecture-reviewer` and `torvalds-reviewer`. | The changed-file list, which closes the "reviewers have no Bash" gap; owed findings and their dispositions; advisories new in this diff; the wire walk; "shown to `dal-author` at edit 3: open". |
| Stop | `atlas` step, exit 1 | Each unresolved owed finding: key, pointers, legal moves, and the exact `pairs[]` row a human would commit for `justify`. |

**Write-time message:**
```
atlas (OWED at Stop unless resolved · 1 of ≤3) key 3f9c0a1b slot-clone
NEW  invoices:rows:asRows   packages/verticals/invoices/src/data/rows.ts:41
 ≡   notes:rows:asRowArray  packages/verticals/notes/src/data/rows.ts:98  (α-equal, 41 tok)
     (data: unknown) => readonly Row[]
 Legal moves: EXTRACT to packages/platform/<home>, import from both (verticals may not
 import each other) · JUSTIFY: inline marker + reviewed row.
 Import it; do not re-type it — a re-typed copy has the same α-hash and stays owed.
```

The **reviewer dossier** opens with a fixed frame: "Facts, not verdicts. Do your own pass first. Then give one line per item: `atlas:<key8>: confirm|dismiss — file:line reason`. For a `justify` you agree with, write `atlas:<key8>: endorse`." Items follow as a table of `rule | key8 | a | b | layer/score | via`.

**Injection safety:**
- Owned, hash-pinned code computes the payload from the tree. The author's text never enters it.
- Every value passes a closed validator or prints `(unprintable)`:
  - paths: `PATH_RE` (`harness-brief.mjs:52`);
  - symbols: `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`;
  - rule and slot ids: closed sets;
  - i18n keys: `^[a-z0-9_.-]{1,80}$`;
  - signatures: a whitelist tokeniser, at most 120 characters, string literals shown as `"…"`.
- No body, comment, literal or template text is ever included.
- The surrounding frames are fixed English, and the payload stays under 10,000 characters.

**Reuse, not copy:**
- Pointers carry an import specifier and a signature, never a body (API information helps; similar bodies are noise).
- Moves are filtered by the boundary rules, so no suggested move leads to a depcruise red.
- Stop checks mechanically: a re-typed copy keeps its α-hash, and a wrapper around the import trips #10.

## 4. Enforcement model

| Tier | Contents | Local | CI | Tracked |
|---|---|---|---|---|
| **owed** | Only for subjects the diff introduces or changes: `slot-clone` (L1a), `rail-reinvent`, `wire-orphan`, `wire-bound`, `wire-rename`; census staleness | `atlas` Stop step reds | the same script, `unit` job, merge-base diff | only as accepted rows |
| **advisory** | L1b–L1d, `promotion`, `shape-drift`, `twin-drift`, `parallel-unlisted`, wire advisories, catalogue signals, corroborated semantic hits | shown to reviewers | census equality only | census → issues |
| **context** | wire walk, exemplars, homes, co-change, owned rows, stamps, triggers | shown | — | never |

A rule moves from advisory to owed only through a ramped release, and only once the eval shows ≤ 10% effective false positives (the Tricorder bar) on twins, decoys and the dogfood corpus.

**Dispositions are decided from the tree:**
- **reuse:** the new symbol is gone, or no longer matches, and its file imports the candidate;
- **extract:** both sides import one symbol, outside both units, that matches the pair;
- **justify:** a two-place act:
  1. the agent writes an inline marker, `// atlas-justify: <key8> — <reason ≥20 chars>` (`--` in SQL);
  2. a human commits a row to `tools/duplication-allow.json` under CODEOWNERS, because the write guard denies the agent:
     `{"pairs":[{"key":"3f9c0a1b2c3d4e5f","rule":"slot-clone","subject":["invoices:rows:asRows","notes:rows:asRowArray"],"reason":"…"}]}`

With the marker but no row:
- **Locally**, the step prints `PENDING-ROW` and stays green only if an `architecture-reviewer` or `torvalds-reviewer` endorsement exists for that key, bound to the current tree digest.
- **CI** stays red until the row is committed.

The agent therefore cannot exempt itself. This is the existing local-skip, fail-closed-CI asymmetry (`check-duplication.mjs:17`). Rows close in both directions: a row whose key is absent reds as a stale acceptance (`check-suppressions.mjs:19-33`). Rows carry no calendar date (`:27-33`).

**CI backstop.** `check-atlas.mjs` never reads `.harness/`. With hooks off (a human author, `disableAllHooks`, another agent), CI reaches the same verdict. The shown-ledger and the endorsements only change messages.

**Ratchets against cumulative slop:**
1. The owed rules are diff-scoped, so debt cannot grow by an exact copy.
2. `atlas-census.json` holds the sorted keys of every advisory class and must equal its recomputation. Growth therefore shows in every PR diff, and new keys are mandatory accounting for the reviewer.
3. Nightly, the census becomes issues.

This targets the across-PR accumulation that single-diff gates miss (RepoReuse, SlopCodeBench).

**Ramps.** Each owed rule and the census check ramp through `rampNote('atlas','2.1.0',…,{until:'2.3.0'})` (`gate.mjs:283`). Fresh installs are live. Pre-2.1.0 installs get a NOTE, and the ramped findings also flow through the recorder (§5) into issues. **Gate hygiene:** empty-legal (no verticals and an empty diff → `ok`); a canary (a planted 30-token α-clone across two `rows` slots must red); a catalog entry; a `gate-proposal` issue.

## 5. Advisory → GitHub issue pipeline

**Recommendation on scope.** Track **every deterministic unfixed advisory**, but not as one issue each. That means every class-A advisory (w2-advisory-inventory §1):
- the atlas census;
- ramp NOTEs, one per ramp site;
- provenance advisory classes;
- control-OFF findings;
- ratchet drift;
- doctor pin floors;
- red scheduled lanes, one issue per lane.

Each lands on one rolling dashboard issue, or in its own issue if promoted. Excluded:
- **class B** (per-turn) lines, which would open and close every turn;
- **class C**, which is already tracked; the dashboard links to it ("two copies drift", `scripts/check-obligations.mjs:22-27`);
- **reviewer MEDIUM/LOW findings**: LLM opinion that CI cannot recompute; making it work items violates "advisory context is distrusted";
- **owed findings**, which block;
- **uncorroborated semantic hits**.

The reason: an issue CI cannot close on fix is noise, and noise teaches people to ignore the label.

**Identity.**
- One atlas key, `sha256("atlas/v1|rule|sorted subjects")[:16]`, serves as the census key, the escape-row key, the marker prefix and the issue key. Subjects are slot-qualified (`<unit>:<slot>:<name>`), so a move keeps the identity; content is evidence only.
- Other sources use `sha256("adv/v1|source|rule|subject")`. For ramps the subject is the `(file, detail)` site with digits normalised; for lanes it is `lane:<job>`. Never line numbers.
- Each issue body starts with the marker `<!-- harness-advisory v1 key=<16hex> body=<sha8> -->`.

**Lifecycle:**
- **New key:** dashboard; promoted to its own issue in a fixed order (class, rank, first seen, key).
- **Body changed:** edit, never comment.
- **Close** as `completed` after **2 consecutive complete runs** with the producing gate complete and the key absent. A skipped or red gate is unknown, not absent.
- **Stale:** 7 incomplete runs → `advisory:stale`, listed as "unknown since <sha>".
- **Regression:** a returning key reopens.
- **Expired ramp:** keep emitting with `status: blocking`, label `advisory:now-blocking`.
- **Won't-fix:** a `pairs[]` row (other sources: their own escape list), then close as `not_planned`. Ramps cannot be waived.
- **Human close without a row:** stays closed, listed under "closed without reviewed exemption". Closing never exempts.

**Caps.** At most 10 new issues per run and 50 open. The first run is a baseline: everything goes to the dashboard and keys are promoted as slots free up. `promotion` findings, which name an extraction, are promoted first.

**Workflow security.** `advisory-sync.yml` runs on `schedule` (an hour after the nightly `'11 3 * * *'`, `quality-gate.yml:32-34`) and `workflow_dispatch` only; never `pull_request_target`, `workflow_run` or issue triggers.
- **`compute`** (`contents: read`, `actions: read`): runs `atlas --census --json` and `validate --min-floor --report-all` with the recorder; reads the nightly run's job conclusions and `::harness-advisory::` lines via `gh api` (the `lane-reuse` precedent); emits a job output.
- **`sync`** (`issues: write` only): no install; sparse checkout of script, schema and escape store; harden-runner `block` mode allowing only the GitHub API and github.com; schema-validated payload; titles from fixed vocabularies; `gh api --input -` with no `${{ }}` interpolation; touches only bot-authored, labelled, marker-bearing issues; `concurrency`; serial writes 1 s apart.
- A factory test pins the permissions.

**Base versus module.**
- **Base** gets:
  - the recorder, `noteAdvisory()` in `gate.mjs`, modelled on `noteMissingPrerequisite` (`:169`);
  - the census;
  - NOTE survival: `stop-validate-gate.mjs:268-276` gains a `NOTE_RE` collector (count plus the first 3);
  - `atlas --advisories`.
- **Module `advisory-issues`** carries the workflow and the scaffold's first `issues: write`, because 2.0.0 is the opt-in release.

**Factory versus consumer.** Each repository files only into itself. The factory dogfoods the module twice:
- `hygiene.yml` for its obligations;
- an atlas census over `template/` with the demo and the push slice materialised.

The agent-fix loop is not in v1 (T6).

## 6. Optional embedding layer (module `atlas-embeddings`)

**Models.** Hosted: `voyage-code-4`, pinned to a dated snapshot, 512-d int8 plus sign bits, with the training opt-out confirmed **before the first call**. Local: Qwen3-Embedding-0.6B via an operator-run OpenAI-compatible endpoint (zero npm dependencies). No silent fallback between them.

**Chunks and storage.** Atlas function units (≥ 25 tokens, ≥ 3 statements; sub-chunks over 80 lines), comments and `SOURCE:` lines stripped. Stored in `.harness/atlas/emb/<modelKey>/{vectors.i8,bits.u32,rows.jsonl,meta.json}`; a 1-bit prefilter to the top 200, then int8 rescore; `actions/cache` in CI.

**Determinism boundary.**
- Each vector is computed once per `sha256(model|dims|dtype|normaliser|text)` and replayed after that.
- A probe set of 20 functions must keep cos ≥ 0.995, or the layer disables itself loudly.
- **No gate, Stop step, census or CI verdict reads a vector.**

**Which tier its hits can reach.**
- **Context:** the reviewer dossier and `atlas --near --semantic`, when cos ≥ T_ctx, labelled `semantic(model, cos)`.
- **Advisory:** only from the module's nightly sweep, written straight into the sync payload, never into the committed census. It requires cos ≥ T_adv **and** a deterministic corroborator: a shared callee, table or DTO field, equal arity plus return shape, or MinHash ≥ 0.15.
- **Never owed. Never pushed at write time.**

**Privacy.** Only `git ls-files` source is sent, never chunks matching `secret-patterns.json`. Enabling the layer takes a human edit to the write-guarded `tools/embeddings.config.json`, which includes a `dataPolicy` acknowledgement.

**Evaluation.**
- About 40 platform helpers, each with T3, T3+ and **execution-verified T4** variants, plus hard negatives.
- Metric: recall@5, structural alone vs structural plus embeddings.
- **Recommend** the module at ≥ +15 percentage points of T4 recall with advisory precision ≥ 0.8 and the owed set asserted unchanged.
- **Context-only** at +5 to +15 points. **Do not ship** below that.
- Stability: the advisory set's Jaccard across 5 runs and 2 machines must be ≥ 0.98.

## 7. Resolution of the tensions and gaps

**Tensions**
1. **Semantic hits at write time: none.** Write time pushes only owed-tier hits, which are deterministic. Interrupts need ≤ 10% effective false positives, and embeddings confuse near-clones (ExecRetrieval). Semantic hits go to reviewers, the pull tool and nightly advisories.
2. **Identity:** the slot-qualified subjects of §5. They survive moves and edits. A rename is a genuine identity change: the old key closes after 2 runs. Content-keyed identity is rejected.
3. **Closing:** 2 consecutive complete runs; unknown is not absent. Embedding issues use the same rule with hysteresis (cos ≥ T_adv − 0.03 keeps the issue open). A `justify` answer never closes an issue; only a committed row does, as `not_planned`.
4. **Every advisory versus noise:** every deterministic advisory is tracked, and only promoted ones get their own issue. Local hits reach CI through the **committed, recomputed census** (inventory option (b)), with no write into a hand-edited `tools/` file. Reviewer MEDIUM/LOW findings are excluded.
5. **Nagging versus owed:** one debt, one penalty. The owed set is computed at Stop from the final tree, whatever was shown. Reuse and extract cancel the debt mechanically. "Shown, then ignored" adds no block; the ledger only shapes the wording and the action rate. Only `justify` needs a reviewer and a human. Advisories are never pushed at write time.
6. **Agent loop versus distrust:** deferred to a later `atlas-autofix` module. Preconditions:
   - the Fact 5 headless-permission probe;
   - the agent receives only the key and re-derives the finding with `atlas --explain <key>`, so issue text never enters a prompt;
   - CI proves the key is gone and no new key appeared on the same subjects.

**Gaps**
- **CI backstop:** the same script runs in the `unit` job; dispositions are recomputed or committed.
- **Advisories from every lane:** the atlas computes its own. Other lanes emit `::harness-advisory::`, read from the nightly logs under `actions: read`; no lane re-runs and no `workflow_run` artifacts.
- **Per-diff versus sweep:** the sweep is slot-partitioned with LSH, so pairs grow O(n), ≤ 60 s at 200k LOC. The baseline first run respects the 10/50 caps.
- **The duplication gate:** L0 is unchanged; `slot-clone` covers 25–69 tokens and cross-slot matches. **One** store, `pairs[]`.
- **Ramp visibility:** NOTE survival plus the recorder.
- **Red for an unrelated reason:** the atlas is syntax-only, so it computes on red trees; other gates get the staleness label.
- **Read-only reviewers:** SubagentStart, ≤ 1.5 s at p95 within 10 s, semantic hits from cache only. Fallback in §13.
- **Opt-in model:** the core is base; `advisory-issues` and `atlas-embeddings` are modules.
- **Which repository:** §5.
- **Action rate:** a counts-only telemetry record at Stop, `{kind:'atlas-outcome', rule, shown, resolved}`. The ≤ 10% bar is measured in the factory eval (§11).
- **Concurrency:** content-addressed cache files written then renamed; the graph keyed by tree digest; ledger lines under PIPE_BUF carrying `session_id`; per-session overlays.
- **Contested claims:** nothing blocks on "never shown" (claim 2); no CI agent loop (3); `--min-floor --report-all` (4); no calendar `until` (5); no inline-only justify (6); CI recomputes everything owed (7).

## 8. What it deliberately does NOT do

Deletion bias: one gate, two hooks and one CLI replace three proposed exemption stores, a reviewer memory and an MCP-first design.

| Rejected | Why |
|---|---|
| Pushing bodies or anti-unified templates | Noise, copy bait, injection text |
| Neighbourhoods from the import graph alone | Already-rejected doctrine; misses SQL, registers and the wire |
| A knowledge graph built by an LLM | Skipped about 31% of files at about 20× the cost |
| A type-checked Program; #7 union fan-out; #16 feature envy (≤ 15% precision); #13 depth; #19 synonyms | Too slow or too noisy |
| Native parsers in base; pgvector; a graph database | Dependencies, `db reset`, drift. JSON suffices. |
| Embeddings in a verdict, at write time, or in the census | Not deterministic |
| Co-change beyond context | Young repositories fail every threshold |
| A separate "shown then ignored" block | Double penalty |
| `advisory-allow.json`, inline-only markers, calendar `until` | Store sprawl, self-exemption, a clock in a verdict |
| Reviewer MEDIUM/LOW findings as issues; cached findings; reviewer memory | Distrusted text; memory was rejected |
| MCP `atlas_query` in v1 | `approved-tools.json` is seeded, and the eval runs `--strict-mcp-config`. It comes in v1.1. |
| PreToolUse deny; UserPromptSubmit injection | Thrash; context before any code exists |
| Codemods; autofix in v1; replacing L0 with jscpd | Out of scope; L0 is proven and takes 310 ms |

## 9. Evidence trace

| Mechanism | Finding | Source |
|---|---|---|
| Slot-aligned comparison | Slot expectations; push re-grows the port, `asRowArray` and `mapFailure` under renames that defeat L0 | w1-stack-anatomy §1, closing list |
| Wire edges and wire rules | Hops joined only by name | w1-stack-anatomy §2 |
| SQL rail classes | Two legal predicate shapes; `deny_mutation` clones | w1-stack-anatomy §6 |
| Typed edges, not imports alone | Import-graph selection was rejected | w1-harness-reviewer-pipeline §6 |
| Personalised PageRank on the diff, k-hop walk | Aider; RepoGraph +32.8%; LARGER | w1-agent-context-retrieval Q1, Q4 |
| Pointers, ≤ 3 items | Similar code costs up to 15%; A3-CodGen sees interference above 5 | w2-write-time §2 |
| Deterministic owed tier | Slop needs obligation, not just availability | w1-ai-slop-evidence Q1, Q3 |
| α-hash and MinHash; embeddings only propose candidates | Rename-invariant hashing; cosine measures resemblance | w1-clone-similarity Q2; w2-embeddings §2 |
| Facts not verdicts; reviewer's own pass first | Anchoring (Tufano); hybrid review wins | w1-design-quality-signals Q7 |
| ≤ 10% false positives before interrupting | Tricorder; Infer gets 70% fixed at diff time | w2-write-time §2 |
| Census ratchet | Single-diff gates miss accumulation | w1-ai-slop-evidence summary §1 |
| Issue identity, closing, caps, job split | Search-API duplicates; unknown is not absent | w2-issue-sync §1–3 |
| NOTE survival | NOTEs vanish on green | w2-advisory-inventory finding 2; critique §1.1 |
| Two-place `justify` | `check-suppressions.mjs:27-33` | critique §1.6 |
| SubagentStart delivery | Fires per reviewer; `additionalContext` is documented | w1-harness-reviewer-pipeline exec §1; w1-hooks |

## 10. Cost and latency budget

| Moment | Scaffold / 200k LOC (warm) | Notes |
|---|---|---|
| Plan CLI | 0.3 s / 1.5 s (cold ≤ 20 s, once) | per-blob cache |
| Scaffold | +0.3 s | reads the cached graph |
| PostToolUse | p50 ≤ 150 ms, p95 ≤ 300 ms | 1 s internal deadline, 5 s timeout, runs in parallel with Biome; candidates are re-hashed and stale pointers dropped |
| SubagentStart | ≤ 1.5 s at p95 (10 s timeout) | personalised PageRank at ~100k nodes and 500k edges × 40 iterations ≈ 200 ms |
| Stop `atlas` | ≤ 1 s / ≤ 3 s (cold ≤ 20 s) | re-extracts by blob diff; incremental census |
| CI `unit` lane | +5–20 s | — |
| Nightly | ≤ 60 s; embeddings < $0.01/day incremental | a cold embed of 50k functions costs about $1.20 |

**Scaling to 200k LOC:** blob SHAs from `git ls-tree`; 2–4 `worker_threads` for a cold parse; LSH within a slot class plus the homes; hub damping; a graph snapshot plus per-session overlay patches; `chain-budget.json` rows on the factory side; the oxc swap criterion (§2.1). Hooks never build the index: with a cold cache the hook stays silent and records `cold`.

## 11. Evaluation

**A. Deterministic tiers** (`tests/gates/atlas/`).
- **Seeds** are inverse refactorings:
  - inline function;
  - rename-paraphrase (T2);
  - reorder or insert statements (T3);
  - wrapper insertion;
  - boolean parameter;
  - a push-style mapper re-grow;
  - a SQL rail clone;
  - a wire rename;
  - a bound mismatch;
  - an orphan projection.
- **Twins** are the minimal correct versions.
- **Decoys** are the deliberate parallels: the design-system mirror, the transport twin, the per-consumer port, sign-in/sign-up.
- **Bars:**
  - **owed:** recall ≥ 0.95 on T1–T2, **zero** hits on decoys, precision ≥ 0.95;
  - **advisory:** precision ≥ 0.7, recall ≥ 0.6 on T3;
  - **write-time interruption:** only at ≤ 10% effective false positives.

**B. Dogfood golden** (`tests/fixtures/atlas-dogfood/expected.json`): the scaffold, the demo, and the push slice materialised from its `.txt` files. The atlas must report each of these, with the rule shown:

| Finding | Rule |
|---|---|
| `asRowArray` (push vs notes) | `slot-clone` |
| `mapFailure` / `mapPostgrestFailure` vs `mapPostgresError` | `promotion` |
| port types ×4 | `shape-drift` |
| write-context assembly | `twin-drift` |
| port cast ×3 | fact census |
| renderable title ×3 | `wire-respell` |
| `NoteView` bound | `wire-restate` |
| i18n keys | `i18n-parity` |
| route ids `notes` vs `home` | `twin-drift` |
| mobile primitives vs `design-system-native` | `parallel-unlisted` |
| the `deny_mutation` and partition functions | `rail-reinvent` (census) |
| `PARITY.md:27-29` | `parity-cell` |
| `NOTE_TITLE_MAX` ↔ CHECK 200 | linked; mutating either side must red `wire-bound` |
| the allowed cursor codec | must stay quiet |

Bar: 100% recall on this list, and nothing on the parallels list.

**C. Reviewer eval** (`scripts/reviewer-eval.mjs`).
- Add `KINDS` `helper`, `slot`, `wire` and `rail` (`:72`).
- Add the companion rows `reuse-existing-home`, `one-concept-one-name` and `rail-reuse`, stated in `architecture-reviewer.md` (b, d, e).
- Add at least 8 architecture cases. There are none today. Each is a BLOCK case with a PASS twin and a decoy twin.
- Add `mustCite`: the path of the existing home (requires a `scoreOne` change).
- A/B: `livePrompt()` with `--atlas` appending the dossier, at least 5 runs per case.
- Bar: BLOCK recall +20 pp, with no loss of precision on the twins and decoys (bootstrap 95% CI).

**D. Generation eval.** Factory, live, not gating.
- 12 RepoReuse-style chains of 5 turns each, OFF vs ON, at least 3 seeds.
- Metrics: reuse recall (AST import of the home), decoy false-reuse, redundancy per kLOC, census slope, pass rate.
- Bar: duplicated-logic chains at turn 5 halved, decoy false-reuse ≤ 10%, pass rate within 2 pp.

## 12. Rollout

These PRs start after the stack merges.

| # | PR | Ships in |
|---|---|---|
| 0 | **Spike-0 probes**, recorded as Facts 19–23 and re-checked at every cc-floor bump. Each asks whether: (a) SubagentStart `additionalContext` reaches the **subagent**; (b) PreToolUse(`Agent`) exposes `tool_input.prompt`, and whether `updatedInput` rewrites it; (c) PostToolUse from a subagent's own Edit reaches that subagent; (d) `async` hooks behave as documented; (e) Edit/Write `additionalContext` arrives in VS Code. | factory |
| 1 | `gate-proposal` issues: the atlas gate, the census, NOTE survival, both modules | factory |
| 2 | `tools/lib/atlas/*` and `tools/atlas.mjs`; empty-legal; no gate | base |
| 3 | Dogfood golden, seed/twin/decoy fixtures, threshold calibration | factory tests |
| 4 | Clean up the scaffold's own slop, or add reviewed rows for it: the mobile primitives, `deny_mutation`, the push slice | base / module |
| 5 | NOTE survival and the `noteAdvisory()` recorder | base |
| 6 | Plan and scaffold delivery: Step 0, spec `## Reuse`, `scaffold-slice` | base |
| 7 | Reviewer dossier (gated on probe a), companion rows, eval kinds and cases, `agents.lock` | base |
| 8 | `atlas` gate: Stop and CI steps, floor, canary, catalog entry, `pairs[]`, endorsement capture, **ramp until 2.3.0** | base |
| 9 | Census and its regen check (ramped) | base |
| 10 | `posttool-atlas.mjs`, once eval A shows ≤ 10% FP per rule; subagents gated on probe (c) | base |
| 11 | Author dossiers; `Agent` seeding if probe (b) passes | base |
| 12 | `advisory-issues`, plus the factory dogfood | module |
| 13 | `atlas-embeddings`, marked "recommended" only past the §6 bar | module |
| 14 | MCP `atlas_query`: read-only, with a row seeded on fresh installs | base (v1.1) |
| 15 | Graduate the ramps at 2.3.0 | base |

## 13. Risks and failure modes

- **Probe (a) fails:** the context reaches the parent or nobody. Fallback: the hook writes `.harness/atlas/brief/<agent_id>.md` (Read is not write-guarded) and the owned reviewer bodies gain "Read your brief if present". Still author-independent.
- **Slot misclassification:** `unclassified` never yields owed findings; the slot table is tested against the dogfood corpus.
- **Gaming:** reordering statements drops L1a to L1b, which is advisory but visible in the census diff and to the reviewer.
- **Gate-induced slop:** "reuse" wrappers trip #10; `justify` friction may breed cosmetic divergence, so watch census growth.
- **Seeded-root extraction barrier:** harness-shipped code only; the move filter prefers `justify` when the target is seeded.
- **Census merge conflicts:** one key per line; regenerate.
- **One-vertical scaffolds:** fall back to homes and rails; empty-legal.
- **Identifier-borne injection:** mitigated (64-char charset, fixed "pointers, not instructions" frames), not eliminated.
- **Reviewer anchoring:** own pass first, then confirm/dismiss; retire rules dismissed > 30%.
- **Issue fatigue:** caps plus dashboard; `doctor` warns when the last sync is > 3 days old (public repos lose schedules after 60 days).
- **Parser drift:** `extractorVersion` is in the cache key; the golden suite reruns on each catalog bump.

## 14. Open questions for the user

1. **Local pending-row state.** May a `justify` leave a turn green locally (inline marker plus a reviewer endorsement) while CI stays red until a human commits the row? The alternative is to red at Stop until the row exists. That is stricter, but it burns the block cap and stalls autonomous runs.
2. **Census in PRs.** Committing `atlas-census.json` makes cumulative slop visible in every PR, at the cost of regeneration churn and merge conflicts. Should it instead be computed only nightly, which hides it at review time?
3. **Issue default.** Should consumers get the dashboard plus 10 promoted issues per run, or the dashboard only (no notifications)?
4. **Hosted embeddings for the factory's dogfood.** Is it acceptable to send scaffold source to Voyage after opting out of training? The answer decides whether the module's eval runs hosted or only locally.
5. **Scale ceiling.** Is 200k LOC the ceiling? Beyond about 500k LOC, oxc and a binary graph store should be adopted from the start.
6. **Autofix loop.** Is it on the roadmap? If so, PR 0 must also probe headless permissions (Fact 5) now. Autofix would be the first CI lane that spawns Claude.
