# Single Home: a minimal deterministic core against AI slop

Paths are relative to the stack-head tree. `T/` means `template/base/`. "Research" means this directory.

## 1. Name and thesis

**Single Home.** The name comes from the architecture reviewer's own rubric: "A diff that edits the same fact in three places names the missing single home" (`T/.claude/agents/architecture-reviewer.md:55-56`).

The slop that survives this harness's 36 gates is mostly a second copy of something that already has a home: reinvented helpers, copy-adapt instead of extract, a parallel DAL, SQL rails grown again. Context alone does not fix it, because agents ignore context they already have (RepoReuse); an obligation does. So Single Home is not a retrieval system. It is **one deterministic fact table, the function-shape index, grown inside the existing `duplication` gate**, read verbatim by the Stop step and CI (the authority), a write-time PostToolUse hook, the reviewers' existing SubagentStart branch, a `--neighbours` query mode, and the nightly issue sync.

What is novel, and specific to this harness:

1. **One module, many readers.** The harness's own provenance pattern ("the SAME module … so per-edit and CI can never disagree", `T/.claude/hooks/posttool-source-check.mjs:19-22`), applied to similarity: the write-time pointer, the reviewer's packet, the Stop red and the issue are the same fact.
2. **Obligations are pure functions of the tree.** Nothing records what an agent was *shown*. Acting on a pointer cancels the debt, and a dropped delivery changes no outcome.
3. **It is stack-aware.** Kernel, platform and contracts packages are the "homes". Verticals are slots, and vertical-to-vertical imports are illegal, so similarity between two verticals means "extract". Deliberate twins come from the stack's own doctrine, SQL functions are compared on the folded migration history, and table homes come from the generated `query-shapes.json`, not the import graph.
4. **It adds very little.** No new gate, Stop step, exemption store, MCP server, "shown" ledger or npm dependency.

## 2. Architecture

| # | Component | Location | What it extends |
|---|---|---|---|
| C1 | Shape extractor and index | `T/tools/lib/shapes.mjs` (new; owned, write-guarded, hash-pinned) | R07's `loadParser()` (`T/tools/lib/i18n-tree.mjs:98`); the duplication gate's scan roots and excludes (`check-duplication.mjs:44-63,146-170`) |
| C2 | The L1 layers in the gate | `T/tools/check-duplication.mjs` | Stop step `duplication` (`T/tools/harness.config.mjs:201`); the CI unit lane (`T/github/workflows/quality-gate.yml:206-210`) |
| C3 | Advisory recorder | `noteAdvisory()` in `T/tools/lib/gate.mjs` | Mirrors `noteMissingPrerequisite` (`gate.mjs:169-178`). `rampNote` (`:283`) routes through it |
| C4 | Write-time pointers | `T/.claude/hooks/posttool-neighbours.mjs` (new, about 120 lines) | Third entry in the `Edit\|Write\|MultiEdit` PostToolUse group (`T/.claude/settings.json:11-26`), invoked directly rather than through `launch.mjs`, exit 0 on every path (like `session-brief.mjs`) |
| C5 | Reviewer packet | SubagentStart branch of `T/.claude/hooks/subagent-verdict.mjs:284-301` | That branch, which today writes the dispatch record and prints nothing |
| C6 | `single-home` companion row | `architecture-reviewer.md:73-76`, `torvalds-reviewer.md` (its N17 table) | The N17 companion tables |
| C7 | Query modes | `check-duplication.mjs --neighbours <q>` and `--explain <key>` | The gate's own CLI |
| C8 | Issue sync | Opt-in module `advisory-issues` | — |
| C9 | Semantic sweep | Opt-in module `embeddings` | — |

### Parser

C1 uses the project's own `typescript` parse-only (`ts.createSourceFile`, no Program, no TypeChecker), loaded through `loadParser()` as the i18n gate has done since R07. Without it, L0 still runs and L1 NOTEs locally and fails in CI (`check-i18n.mjs:211-215`). SQL comes from `T/tools/lib/sql-parse.mjs`, folded last-wins over `supabase/schemas` and `supabase/migrations` (`parseFunctions` :1045). Oxc, tree-sitter, ast-grep and libpg_query are refused: new dependencies for an unmeasured speed problem.

### What it extracts

The unit is a callable: a function declaration, a function or arrow bound to a `const`, or a method.
- **`alpha` (L1a):** signature plus body, with bound names (parameters, locals, catch and destructured names) renamed `$1…$n` in binding order and the function's own name as `$f`. Free identifiers and property names are kept, so "calls the same platform API" stays visible. Literals become `S`/`N` as in L0's `TOKEN_RE` (`check-duplication.mjs:113-114`). Types are kept, comments dropped. Stored as 12 hex digits of sha1.
- **`shape` (L1b):** identifiers become `I`, properties `P`, literals `S`/`N`; types are dropped. Hashed with sha1, plus a 64-permutation MinHash over 4-gram shingles (FNV-1a with fixed seeds, so bit-identical on every machine).
- **Facts:** `name, exported, line, end, tokens, stmts`; `sig` (literal types replaced by `S`, at most 100 characters); `pass` (the forwarding target when the body is one `return [await] g(…own params)`); `dataShaped` (at least 60% of tokens inside object, array or JSX literals).
- **Per file:** `imports`/`reexports` as `{from, names}`, and `tables` (the literal first argument of `.from(`/`.rpc(`, the call shape `vertical-anatomy.mjs` keys on).
- **Per folded SQL function:** `{qualified, file, line, params, language, body}`, where `body` is a sha1 with schema qualifiers replaced by `σ` and whitespace and comments collapsed.

### Record and cache shapes

All of these live under `.harness/`, which git ignores except for the manifest (`T/gitignore:59-61`).

```json
// .harness/context/blobs/<aa>/<blobSha>.json   key = git blob sha + EXTRACTOR_VERSION
{"v":1,"blob":"9f2c…","fns":[{"name":"asRowArray","exported":true,"line":80,"end":82,
  "tokens":27,"stmts":1,"alpha":"3b1e0c9a77d2","shape":"c04f…","mh":"<base64 64×u32>",
  "sig":"(data: unknown) => readonly unknown[]","pass":null,"dataShaped":false}],
 "imports":[{"from":"@app/errors","names":["outcomeErr"]}],"reexports":[],"tables":[]}
```

**Postings:** `.harness/context/postings/<aa>.jsonl`, sharded by first key byte, with keys `a:<alpha>`, `s:<shape>`, `b<i>:<band>`, `t:<table>` and `x:<pkg>#<export>` (importers), plus `HEAD.json` `{treeDigest, extractorVersion}`. The gate rebuilds them every run, warm from the blob cache, writing each shard by tmp-then-rename. C4 appends the edited file's entries to `.harness/context/overlay-<session_id>.jsonl`, so a helper written this turn in file A is found when it is written again in file B.

### Layers and tiers

| Layer | Match | Tier |
|---|---|---|
| L0 (exists) | Type-1 windows of at least 70 tokens and 6 lines | owed (unchanged) |
| L1a | `alpha` equal, across files, and either at least 30 tokens or the same declared name with at least 12 tokens | **owed** |
| L1s | SQL function bodies equal modulo schema, on the folded state | **owed** |
| L1b | `shape` equal, or MinHash Jaccard ≥ 0.80 (a starting value to calibrate). Both sides need at least 30 shape tokens and 2 statements, must not be `dataShaped`, must have RNR ≥ 0.5, and must not be mostly JSX | advisory |
| L2 | `table-home`, `single-consumer`, `pass-through`, and `fan-in` on a changed signature | context |

**LSH and pair verification.** LSH uses 16 bands of 4 rows, a candidate threshold near 0.5. Each candidate is then verified on the signature Jaccard. A bucket with more than 50 members is an idiom, so it is counted and never paired.

**Deliberate twins.** `DELIBERATE_TWINS` is a closed constant in C1; each entry cites its doctrine, and consumers cannot edit it.
- **Excluded from both tiers:** same-basename design-system web/native files (the "ONE deliberate dual implementation", `T/tools/duplication-allow.json:2`) and the web/mobile i18n catalogs.
- **Owed downgraded to advisory:** router `packages/api/src/routers/<s>.ts` ↔ action `apps/web/app/actions/<s>.ts`, and `apps/web/lib/action-outcome.ts` ↔ `apps/mobile/src/lib/trpc/normalize.ts`. They are twin transports by doctrine, but their write-context copies have already drifted (`ctx.now` against `new Date()`, `w1-stack-anatomy.md` §5).

### Signals computed

- From the signal catalogue: **#27 bypassed helper** (the other side is a kernel, platform or contracts export, the "home"); **#28 superseded symbol / new near-miss** (an L1b pair with one side a `(package, name)` absent at the merge base); **#9 single-consumer abstraction** (the blessed `src/data/port.ts` slot is exempt, `architecture-reviewer.md:41-44`); **#10 pass-through**; **#15 fan-in** on a changed signature with at least 3 importers.
- **Promotion candidate** (stack-specific): the same `alpha` or `shape` at the same slot path `packages/verticals/*/src/<slot>` in two or more verticals, with no kernel or platform match.
- Slop taxonomy covered: reinvented helper, copy-adapt, parallel implementation (`table-home`), wrapper of one, speculative generality.

### Ranking and caps

Rank by tier (owed, advisory, context), then home matches first, then cross-package spread, group size, score and path. Caps: write time 3 items, 1,500 characters and 3 messages per prompt; reviewer packet 10 items, 3,000 characters; issues 10 new per run, 50 open.

## 3. Delivery protocol

| Moment | What arrives, and how | Shape and size |
|---|---|---|
| **Plan** | `node tools/check-duplication.mjs --neighbours table:<t>\|@pkg#sym\|<path>\|slots`. Step 0 of the slice skill already says to read `action-inventory.json` (`T/.claude/skills/authoring-vertical-slice/SKILL.md:20-34`), and gains one line. | Pointer lines, at most 10 |
| **Scaffold** | `scaffold-slice.mjs` prints one more `next:` line (beside `:162-180`). It lists the promotion candidates in the slots the new vertical is about to create, e.g. `asRowArray` in `data/rows.ts` or the cursor codec. The line reads "a second copy makes these owed: extract first". | At most 5 lines |
| **After an edit** | C4. It speaks only when the edited file (product TS, or `supabase/{schemas,migrations}/*.sql`) holds a callable with an **L1a or L1s match**, or one whose `shape` exactly equals a **home export**, or one that calls `.from('<t>')` on a table another vertical's DAL owns. It never shows L1b near-misses, and does no LSH work at write time. | At most 3 items and 1,500 characters, as `hookSpecificOutput.additionalContext` (the precedent is `posttool-source-check.mjs:101-112`) |
| **Author subagent dispatch** | Nothing: authors get C4 from their own edits if probe (c) passes. If it fails, the SubagentStart branch gives authors a homes list: the top 20 kernel, platform and contracts exports by fan-in (name, import path, signature). | At most 1,500 characters |
| **Reviewer dispatch** | C5, for every reviewer whose body carries the `single-home` row (derived from the body, as `reviewerTypes()` does, `subagent-verdict.mjs:248-261`). Contents: the `reviewChanges()` change list (at most 40 paths), which closes the gap that reviewers are told to `git diff` but hold no Bash; owed pairs touching changed files, including ramp-withheld ones; new near-misses; near-misses with a home; and L2 facts. Cached per tree digest as `.harness/context/packet-<digest12>.txt`, so eight reviewers pay once. Self-deadline 3 s inside the 10 s hook. | At most 10 items and 3,000 characters (about 750 tokens), as SubagentStart `additionalContext` |
| **Stop** | The `duplication` step reds L0, L1a and L1s. The message names both sides, the home, the legal move and the exact allow row, as L0 already does (`check-duplication.mjs:285`). L1b writes only to the recorder plus one count NOTE. | Existing Stop block |
| **Nightly** | Recorder output, which C8 turns into issues | Section 5 |

**Example write-time payload.**
```
single-home (ADVISORY now; `duplication` reds this pair at Stop)
packages/verticals/push/src/data/push-tokens.ts:121 asRowArray
  = asRowArray  packages/verticals/notes/src/data/rows.ts:80  [same function]
    (data: unknown) => readonly unknown[]
  verticals may not import each other: EXTRACT it to one platform package and import it from both.
  Do not re-type it. A copy of either is what `duplication` reds.
```

### Not an injection surface

Every field passes a closed printer or prints as `(unprintable)`. Paths use `PATH_RE` and names `NAME_RE`, exported from `T/tools/lib/harness-brief.mjs:51-52` rather than copied. Symbols must match `^[A-Za-z_$][\w$]{0,63}$` and SQL names `^[a-z_]\w{0,62}(\.[a-z_]\w{0,62})?$`. `kind` is an enum, scores are numbers, and signatures are rebuilt from AST tokens with literals replaced by `S`. No body, comment or string content from the tree ever appears, and all prose lives in owned, hash-pinned hook source. Owned code computes the packet from the tree, so the author's Agent-tool prompt never feeds it.

### Reuse, not copy

The payload is pointer-only (path, name, signature, never a body), because similar code is noise and APIs help (`w2-write-time.md` §2). It uses two verbs only, IMPORT and EXTRACT, never "see" or "example". It names the home before the sibling and filters the legal move by layer: an import is suggested only when the target is kernel, platform or contracts. It also states the consequence: copying the pointed-to function is exactly an L1a match.

The packet opens with: "Facts, not verdicts. Do your own pass first, then report `single-home: present (file:line) | absent`."

## 4. Enforcement model

| Tier | What it contains | Local | CI | Disposition |
|---|---|---|---|---|
| **owed** | L0, L1a, L1s | The Stop step `duplication` reds | The unit lane reds (`quality-gate.yml:206-210`), even when no hook ran | The tree (pair gone) or a row in `tools/duplication-allow.json` |
| **advisory** | L1b, new near-miss, promotion candidates, every other gate's NOTE via C3 | Never reds. It shows in the reviewer packet, and reviewer-verdicts enforces the reviewer's BLOCK locally | Nightly issue (C8) | Issue lifecycle, or the same allow row |
| **context** | L2 | Never | Never | None, by definition |

**Disposition record.** The existing allow file, accepted unchanged by its validator (`check-duplication.mjs:84-103`): `{"fingerprint": "<12 hex>", "reason": "<names both sides and why>"}`. The fingerprint is `alpha` for L1a, the body hash for L1s, and `sha1(sorted(shapeA, shapeB))` for an L1b pair, each cut to 12 hex digits. Because it is a content key, an accepted divergence that is later edited **lapses and is re-reviewed**, which is right: Juergens found that inconsistent changes to clones cause faults. The file is already write-guarded ("accepting a code clone is a human decision", `T/.claude/hooks/lib/guard-rules.mjs:605`), listed in `ESCAPE_LISTS` (`T/tools/lib/enforcement-surface.mjs:88`) and covered by CODEOWNERS.

**"Justify" stays a reviewed act.** There is no inline marker. The agent cannot write the row. It can only quote the row that the red printed. A human commits it in a reviewed diff, the same escape-file shape as every other reviewed register. The owed set is kept tiny so that this rarely stalls an autonomous loop.

**CI backstop.** Owed is recomputed from the tree in the unit lane, whoever authored the change. Advisory is recomputed nightly. Context needs no backstop.

**Cumulative ratchets.**
1. L1a and L1s are judged over the whole tree, so exact copies cannot accumulate at all.
2. **New near-miss** (#28) is relative to the merge base: a pair counts only when one side is a `(package, name)` absent there. Old debt never blocks a diff, and new debt cannot creep in. It is advisory in v1, promoted to owed only at precision ≥ 0.9 on the eval decoys and ≤ 10% effective false positives in the field (Tricorder). This is a deterministic per-diff ratchet with no committed baseline file.
3. The nightly dashboard keeps the tree-wide near-miss count per run as a trend line.

**Ramps.** `rampNote('duplication', '2.1.0', 'function-shape and SQL-function clones', {until: '2.2.0'})`. On older installs the findings print as a NOTE and are recorded as `ramp-withheld`; the packet shows them as `owed (ramped to 2.2.0)` and `update` reports their count, so they never surface only as an issue. Fresh installs are live from day one, which is why PR 3 (§12) makes the scaffold green first. The new-near-miss promotion gets its own ramp.

## 5. Advisory → GitHub issue pipeline

**Recommendation on "all unfixed advisories": not literally all.** An advisory becomes an issue when it is deterministic, recomputable by one CI command at default-branch HEAD, about code or configuration the project owns, and not already a reviewed register row. Everything else is listed or linked on one dashboard issue, never duplicated. Reasons: only a CI-recomputable finding can be closed by a machine; per-turn lines (inventory class B) would open and close every turn; a second copy of a register row drifts (`scripts/check-obligations.mjs:22-27`); and reviewer MEDIUM/LOW findings are unreproducible model text, so their issues could never close.

**v1 sources:** C3 records from `validate --min-floor --report-all` (critique point 4) plus `check-duplication`. They cover ramps, ramp-withheld findings, provenance advisories, static control-off rows and every Single Home advisory. Out of scope in v1, with the reason on the dashboard: the 14 toolchain lanes (Postgres or emulators), class C (linked only), and context-tier facts.

**Identity:** `key = sha256(gate|rule|subject)[:16]`, never including a line number. The subject is the sorted `pkg#name` pair (`pkg#fileStem#name` when not exported), `schema.fn` for SQL, the digit-normalised `(file, detail)` site id for a ramp, and `(group, path)` for provenance. The content fingerprint is evidence and the exemption key, never the identity, so edits do not churn an issue but an edit to an accepted divergence reopens it.

**Recorder.** `noteAdvisory()` appends `{v, gate, rule, status: advisory|ramp-withheld|owed, subject, fp, evidence:{a, b, score, home}, until}` to `$HARNESS_ADVISORY_REPORT_DIR/<pid>.jsonl`, plus a terminator `{gate, complete:true}`. It writes the terminator after scanning, on both the `ok()` and the `failures()` paths. It is silent and never decides a verdict.

**Lifecycle**

| Observation | Action |
|---|---|
| New key with a free slot | Open. Otherwise list it on the dashboard |
| Rendered body changed | Edit it. Never post a "still present" comment |
| `fp` is in `duplication-allow.json` | Close as `not_planned`, linking the row |
| Key absent from a run where its gate wrote `complete` | Close as `completed`, citing the SHA. One run is enough: the run is deterministic on a fixed tree |
| Gate did not complete (crash or skip) | No change. After 7 days without completion, label `advisory:stale` and name the gate on the dashboard |
| Closed as completed, then the key returns | Reopen as a regression |
| Allow-closed, then `fp` changes | Reopen: "accepted divergence changed; re-review" |
| Closed by a human with no allow row | Leave it closed. List it on the dashboard under "closed without reviewed exemption" |
| `ramp-withheld`, then `owed` | Label `ramp:until-X`, then relabel `advisory:now-blocking` and keep it open |

No gate ever reads issue state.

**Caps.** 10 new issues per run, 50 open. Fixed promotion order: now-blocking, ramp-withheld (earliest `until`), near-misses with a home, cross-vertical near-misses, the rest; ties by group size, then key. A first adoption starts everything on the dashboard and promotes as slots free. At 200k LOC, expect a few hundred L1b pairs: about 30 nightly runs to cycle, with new findings jumping the queue.

**Workflow security.**
- `advisory-sync.yml` runs on `schedule` (after the quality-gate nightly) and `workflow_dispatch` only, with `concurrency: advisory-sync`.
- Job `compute` (`contents: read`) installs, runs the two commands and emits a schema-checked JSON job output of at most 1 MB. Job `sync` (`issues: write`, justified inline) installs nothing, sparse-checks-out the script and the allow file, and runs harden-runner with `egress-policy: block` to `api.github.com:443` and `github.com:443`.
- It uses `GITHUB_TOKEN`, so it cannot trigger itself, and touches only issues authored by `github-actions[bot]` that carry the `harness-advisory` label and the marker on line 1.
- Writes go through `gh api --input -` with no `${{ }}` interpolation, one per second, with back-off on `retry-after`.
- Titles use a fixed vocabulary plus validated names; paths sit in code spans; control, bidirectional and zero-width characters are stripped; a golden test checks that no `@`, `#\d` or `<` appears outside code. Factory tests pin the permissions exactly and prove the job can go red.

**Base or module.** The recorder (C3) ships in base: it is silent and harmless. The sync is the **opt-in module `advisory-issues`**, because it carries the scaffold's first `issues: write` and 2.0.0 is "the opt-in release" (`CHANGELOG.md:14`).

**Factory or consumer.** The sync files issues only in the repo it runs in, so in consumer repos. The factory dry-runs it in selftest against a fixture install with recorded `gh` responses. The factory's own obligations stay in `scripts/obligations.json` (class C).

**Agent loop.** None in v1 (§7, tension 6). An issue carries only its key and `node tools/check-duplication.mjs --explain <key>`, which re-derives the finding from the tree.

## 6. Optional embedding layer

**Module `embeddings`.** Models: hosted `voyage-code-4` pinned to its dated snapshot (512 dimensions, int8), or local Qwen3-Embedding-0.6B behind an operator-run `llama-server`. Neither falls back silently to the other, and each has its own cache. Storage is flat files in `.harness/context/emb/<modelKey>/` (`vectors.i8`, `bits.u32`, `rows.jsonl`), kept in `actions/cache` in CI and never committed. A human enables it by editing a write-guarded `tools/embeddings.config.json`, and the provider's training opt-out must be confirmed before the first call. Only `git ls-files` source from the duplication scan roots is sent, after the `tools/secret-patterns.json` matchers.

**Determinism boundary.** No hook, gate or PR job touches a vector or the network for this layer. Only the module's nightly job does: a probe check (cosine with the reference ≥ 0.995, or the layer disables itself loudly), incremental embedding, then a binary prefilter over all pairs with an int8 rescore.

**Which tier its hits reach: advisory only, and only as issues.** A pair qualifies when cosine ≥ T_adv (calibrated per model) **and** at least one deterministic corroborator from C1 holds: a shared `table`, a shared import of a home symbol, equal arity with an equal returned `sig` shape, or MinHash ≥ 0.15. It is recorded as `noteAdvisory('duplication', {rule: 'semantic', …})` with the same pair identity. It never reaches write time or the reviewer packet in v1 and is never owed. Closing uses hysteresis (T_close < T_open), because cosine is the one noisy input.

**Evaluation.** The research's seeded set: about 40 home helpers with T3, T3+ and execution-verified T4 rewrites, plus hard negatives. If T4 recall@5 beats L1b by at least 15 points at advisory precision ≥ 0.8, the module is recommended; at 5–15 points it ships with issues labelled `advisory:semantic-experimental`; under 5 points it does not ship. The owed set must be byte-identical with the module on and off.

## 7. Resolution of the six tensions and the gaps

**Tensions**
1. **Semantic hits at write time.** Write time is deterministic only. Semantic hits reach issues only (§6).
2. **Issue identity.** `gate|rule|subject` over stable symbol ids. The content fingerprint is evidence and the exemption key. Two keys do two jobs: move-stable lifecycle, and edit-sensitive exemption.
3. **When an issue closes.** It closes when the key is absent from one complete run of its gate. An unknown result is not an absence. A won't-fix is an allow row, and closing an issue never exempts anything. Embeddings' rule that "a justify answer closes the issue" is dropped, because only a reviewed row can close an issue as `not_planned`.
4. **"Every advisory becomes an issue".** Section 5: only recomputable advisories, behind caps and a dashboard. Class C is linked, never copied. Reviewer and local hits never become issues, because the nightly job recomputes everything from the tree, so no committed register of local hits is needed. Inventory option (b) is refused.
5. **Write-time nag versus owed.** There is no shown-ledger. Stop judges the tree, so a write-time hit that is acted on cancels itself, and one finding gets one penalty. "Justify" goes to a human allow row, and the reviewer's job is the advisory tier.
6. **Agent loop versus distrusted advisory text.** No loop in v1. The issue body uses a closed vocabulary, and its only actionable field is the key, re-derived by `--explain`. Any future loop needs its own gate-proposal, after a probe of headless permissions (Fact 5, `design/CONTROL-PLANE-FACTS.md:618`).

**Gaps**
- **CI backstop:** the unit lane, with the tree and the committed allow file as dispositions (§4).
- **Advisories from every lane:** v1 covers the static lane plus duplication; neither `lane-reuse` log parsing nor a duplicated nightly run is adopted (§5).
- **Diff-time versus whole-tree:** diffs get exact hits and new near-misses; the nightly sweep runs the whole tree through capped LSH; sizing is in §5.
- **The existing `duplication` gate:** one gate and one store; `advisory-allow.json` and inline markers are refused.
- **The ramp:** NOTE, recorder, packet and the `update` count (§4).
- **A gate red for an unrelated reason:** it still writes `complete`; a crash or skip freezes its issues, and `advisory:stale` names it after 7 days.
- **Read-only reviewers:** SubagentStart, 3 s, deterministic, with the change list included.
- **The opt-in model:** C1–C7 ship in base; issues and embeddings are modules.
- **Which repository:** consumer repos sync; the factory dry-runs.
- **Action rate:** §11 D; the deterministic tiers need no headless Claude.
- **Concurrency:** content-addressed files written by atomic rename, per-session overlays; no verdict reads shared mutable state.

## 8. What it deliberately does NOT do

| Rejected | Why |
|---|---|
| A shown-ledger and an "owed disposition" Stop step | CI cannot recompute "shown, then ignored" (critique point 7); the tree is the authority |
| A new gate, Stop step or exemption store; an inline `// neighbour-divergence:` marker | `duplication` and its allow file exist; an inline-only marker lets the agent exempt itself (critique point 6) |
| An MCP neighbourhood tool | Pull-based, four guarded or seeded registries, invisible under `--strict-mcp-config` |
| Co-change mining | A young repo passes no threshold; signals 1, 4 and 30 are early noise |
| Anti-unification templates | The reviewer reads both pointers; LLM extract suggestions hallucinate up to 76% |
| Naming lineage, literal census, idiom clusters, statement-level smells | Medium to high false positives; they stay in reviewer rubric (d) and (e) |
| A concept-graph or SQL↔TS link parser | `query-shapes.json` and `action-inventory.json` already exist and are regen-diffed |
| A new parser dependency | The root `typescript` suffices until measured otherwise |
| Embeddings in hooks, gates or packets | Determinism boundary |
| Issues from reviewer findings, SARIF, an auto-fix loop | Unreproducible; licence and visibility; Fact 5 unprobed |
| PreToolUse deny, UserPromptSubmit | Thrash, or fire before code exists |
| Reviewer memory, a wider architecture trigger, ledger or dispatch-format changes | Already rejected (`design/FIELD-UPGRADES-2026-09.md:911-929`); torvalds (owed every turn) carries the packet to `apps/**` |

## 9. Evidence trace

| Mechanism | Finding | Source |
|---|---|---|
| Obligation, not mere context | Agents ignore context they have; slop accumulates (50.8% duplicated logic by turn 5) | `w1-ai-slop-evidence.md` Q1, Q3 |
| Pointers, not bodies; at most 3 | Similar code is noise, APIs help; more than 5 retrieved functions interfere; top-1 beats top-k | `w2-write-time.md` §2; `w1-agent-context-retrieval-sota.md` Q3 |
| Feedback at diff time | Infer: about 70% fixed at diff time, about 0% in batch | `w1-design-quality-signals.md` Q7 |
| Locals renamed; MinHash and LSH | Cheapest deterministic primitives for "same shape, different names" | `w1-clone-similarity-sota.md` Q2 |
| Filters and twins | Most clones are benign; the traps are tables, JSX and generated code | `w1-clone-similarity-sota.md` Q6; `w1-stack-anatomy.md` §5 |
| Neutral packet, own pass first | Hints anchor reviewers, and framing flips verdicts | `w1-design-quality-signals.md` Q7 |
| Rebuilt per tree digest | Stale snippets: outdated helpers referenced 76–88 points more often | `w1-agent-context-retrieval-sota.md` Q6 |
| Homes, slots, SQL fold | `mapPostgresError` re-implemented; `asRowArray` verbatim; `deny_mutation` duplicated | `w1-stack-anatomy.md` §3, §6 |
| Embeddings retrieve, structure confirms | Validators inside retrieval were 97.5% accurate on checked rejections | `w2-embeddings.md` §2 |
| Issue-sync shape; recorder | Bot, label and marker filter, compute/sync split; NOTE lines vanish on green | `w2-issue-sync.md` §2–3; `w2-advisory-inventory.md` 1–2 |
| ≤ 10% false-positive promotion bar | Tricorder | `w2-write-time.md` §3.2 |

## 10. Cost and latency budget

| Moment | Cost (scaffold → 200k LOC) | Bound |
|---|---|---|
| Plan `--neighbours` | 0.3 s warm; equal to a gate run when cold | None (a command) |
| Scaffold `next:` | About 0.1 s (reads postings) | — |
| After an edit (C4) | Parse one file (5–20 ms) plus the shard reads it needs. p50 ≤ 150 ms, p95 ≤ 300 ms. It runs in parallel with Biome, so it adds roughly no wall time | 1 s self-deadline, 5 s timeout. Output ≤ 1,500 characters |
| Author dispatch | 0 | — |
| Reviewer dispatch (C5) | Parse the changed files and their merge-base blobs (usually cached), then exact and LSH lookups. About 0.2 s, up to about 2 s | 3 s self-deadline. About 750 tokens. Computed once per digest |
| Stop `duplication` | Today 310 ms. Plus about 0.3 s on the scaffold; about 2–4 s warm and 5–8 s cold at 200k LOC | Chain-budget ceiling 15 s, re-measured |
| Nightly | Validate (about 23 s) plus duplication cold (about 8 s); at most 60 API writes | — |
| Embeddings | About $0.12 per million tokens: a cold 5k functions is about $0.12; incremental runs cost cents | Nightly only |

**Scaling plan.** Only changed blobs are parsed. Postings sit in 256 shards, so write time reads only the shards it needs. LSH buckets are capped at 50. CI caches `.harness/context/blobs` keyed on `EXTRACTOR_VERSION` and the `typescript` version; at about 20k functions the cache is about 4 MB. If a cold parse passes 10 s, swap in `oxc-parser` behind C1's `extract()` interface as a reviewed dependency change, and not before that is measured.

## 11. Evaluation

**A. The deterministic detector eval** (`tests/gates/duplication-shapes.test.mjs`, factory; it gates the factory). A fixture holds about 40 home helpers plus deterministic inverse-refactoring mutants: locals renamed, a literal swapped, 1–3 statements edited or reordered, an inline copy into a sibling vertical, and an SQL function copied into another schema. Its decoys are local versus UTC `formatDate`, `toCents`/`fromCents`, the transport twins, the design-system mirror, the i18n catalogs, zod object tables and the two legal policy shapes.

| Measure | Bar |
|---|---|
| Owed recall on the rename and literal mutants and the SQL copies | 100% |
| Owed false positives on decoys | 0 |
| L1b recall on 1–3-statement edits | ≥ 0.80 |
| L1b precision on decoys plus mutants | ≥ 0.90 |
| Deterministic across two machines | Byte-identical |

**B. Dogfood corpus** (research `w1-stack-anatomy.md` §5–6). Run it on base + stack + demo + the push slice, with the `.txt` files materialised. The tiers below are expectations to confirm or correct:

| Expected hit | Tier |
|---|---|
| `asRowArray` (`demo/…/notes/src/data/rows.ts:80` ↔ `push-tokens.ts.txt:121`) | L1a, owed |
| Cursor codec, notes ↔ push | L1a or L1b |
| `mapFailure` (`push-tokens.ts.txt:152`) ↔ `mapPostgrestFailure`, with home `mapPostgresError` (`stack/packages/platform/supabase/src/errors.ts:134`) | L1b |
| `audit.deny_mutation` ↔ `auth_trail.deny_mutation` (`audit.sql:196`, `auth_event_trail.sql:132`) | L1s |
| `ensure_partitions` ×2 and `drop_partitions_older_than` ×2 | L1s or L1b |
| Write-context assembly, router ↔ action | Advisory (twin downgrade) |
| `apps/mobile/src/components/*` ↔ `design-system-native/src/*` | L1b |

**Bar:** at least 6 of the 7 rows found at the expected tier, and **0 hits** on the deliberate list.

Expected misses, which become reviewer-eval cases instead: the port cast ×3 (an expression), "renderable title" ×3 (inline expressions), the port types ×4 (interfaces), and the `NOTE_TITLE_MAX` bound against the SQL CHECK.

**C. Reviewer eval.** `KINDS` (`scripts/reviewer-eval.mjs:72`) gains `helper` and `sql-function`. The architecture reviewer gets its first cases, and torvalds-reviewer gets the same kinds: per kind, a BLOCK case (reuse absent, home outside the diff), a PASS twin (reuse complete) and a decoy PASS (a legitimate mirror). Cases use `mustName: ["single-home"]` plus a new optional `mustCite: [<home path>]` checked in `scoreOne` (`:314`). Two arms: diff only, and diff plus `renderPacket()` appended by `livePrompt` (`:389`). At least 5 runs per case per arm, with `claudeVersion` recorded.

| Measure | Bar |
|---|---|
| BLOCK hit rate | ≥ +25 points with the packet |
| PASS rate on twins and decoys | Drops by no more than 5 points (anchoring check) |
| `mustCite` correct | ≥ 80% |

**D. Field metrics** (no paths reach telemetry). **Action rate:** telemetry rule `single-home/<tier>` joined to `stop-step` outcomes by `prompt_id`; at least 70% of owed pointers should be acted on before Stop (the Infer-like figure). **Effective false positives:** allow rows added per 100 owed hits, from the allow file's history; target ≤ 10%. **Issue precision:** retire a rule whose issues are closed `not_planned` more than 30% of the time over at least 20 issues.

**E. Longitudinal study** (before 2.2.0; gates nothing). RepoReuse-style, 12 chains of 5 turns, on versus off, 3 seeds. Bars: duplicated-logic chains at turn 5 halved; reuse recall of planted homes up at least 20 points; decoy false-reuse ≤ 10%; pass rate non-inferior within 2 points; flat L1b-count slope.

## 12. Rollout

These PRs come after the stack merges, in order.

| # | PR | Ships in |
|---|---|---|
| 0 | **Spike-0 probes**, recorded as CONTROL-PLANE-FACTS 19–21 and re-checked at each Claude Code bump: (a) SubagentStart `additionalContext` reaches the *subagent* before its first turn (the hook prints a nonce the reviewer must echo); (b) PreToolUse on `Agent` can append to the prompt via `updatedInput`; (c) PostToolUse `additionalContext` from a subagent's own Edit reaches that subagent; plus Edit/Write delivery in VS Code. | Factory |
| 1 | **Gate-proposal issues:** (i) duplication L1a + L1s; (ii) new-near-miss promotion. | — |
| 2 | **`tools/lib/shapes.mjs`** with eval A; no wiring. | Base |
| 3 | **Dogfood sweep:** extract, or add a reviewed allow row for, each eval B item (seeded roots cite the rule at `duplication-allow.json` e83e…); eval B recorded. | Base, stack, demo, push |
| 4 | **L1a + L1s live** in `duplication`: `rampNote` until 2.2.0; canaries in `tests/canary/injections.json` (a renamed-locals copy of a platform function, an SQL copy across schemas); a `gates-catalog.md` entry (`:2442`); chain-budget re-measured. | Base |
| 5 | **`noteAdvisory()` recorder**, with `rampNote` and L1b routed through it; canary: a planted near-miss appears in the output. | Base |
| 6 | **C4 hook** and its settings entry; `--neighbours`, `--explain`; the skill and scaffold lines. The subagent half depends on probe (c). | Base |
| 7 | **C5 packet**, the `single-home` rows, `agents.lock.json` regenerated. If probe (a) fails, use (b), then `.harness/context/packet.txt` plus one body line. | Base |
| 8 | **Reviewer-eval extensions** (eval C), run and recorded. | Factory |
| 9 | **`advisory-issues` module:** `advisory-sync.yml`, `tools/ci/sync-advisories.mjs`, permission-pin, red-canary, sanitiser and dry-run tests. | Module |
| 10 | **New-near-miss promoted to owed** (ramped), only if eval A and the field false-positive bars hold. | Base |
| 11 | **`embeddings` module**, behind the §6 ship bar. | Module |

## 13. Risks and failure modes

1. **Reviewer delivery fails** (probe a): fixed fallback order (PR 7); verdicts are unaffected because the packet never gated anything.
2. **Owed false positives stall autonomy**, since only a human writes the escape: a tiny owed set, twin classes, the same-name rule for small functions, a monitored allow-row rate.
3. **Gaming:** reordering to dodge L1a falls to L1b; a copy disguised as a wrapper surfaces as `pass-through`/`single-consumer`, as does a gate-induced helper split.
4. **Copying from signatures** is exactly an L1a match at Stop.
5. **Anchoring on the packet:** facts only, own pass first, and the decoy arm of eval C.
6. **Seeded roots** cannot receive extractions through `update`: the factory uses reviewed rows (PR 3); consumers own their packages.
7. **Parse cost at scale:** measured in chain-budget, with the oxc swap ready.
8. **Issue fatigue:** caps, dashboard, opt-in, retirement at 30% `not_planned`.
9. **Workflow compromise:** split privileges, egress block, bot/label/marker filter, no interpolation.
10. **A wrong `DELIBERATE_TWINS` entry** hides slop: closed, cited, changed only in a release.
11. **Stale pointers:** each candidate blob is re-hashed before printing.
12. **Ramp blindness without the module:** the packet line and the `update` count.

## 14. Open questions for the user

1. **The escape for owed findings.** Is a human-only allow row acceptable for fully autonomous operation? Or do you want an agent-proposed path, such as a bot PR that adds the row for human approval? A yes to the latter adds a proposal channel and a CODEOWNERS rule.
2. **Default for the issue sync.** Should `advisory-issues` stay opt-in, or ship in base, enabled by default with its `issues: write`?
3. **The near-miss ratchet.** Do you accept that new near-misses block (PR 10) once precision ≥ 0.9? Or should they stay issues-only forever, trading cumulative protection for zero false-positive stalls?
4. **Embeddings default provider.** Hosted Voyage (training opt-out acknowledgement required) or local Qwen only? The answer changes the module's default adapter and its privacy controls.
5. **Factory dogfooding.** Should the factory repo run the sync on its own `scripts/` advisories? That needs a factory-side recorder and a decision on obligations versus issues.
