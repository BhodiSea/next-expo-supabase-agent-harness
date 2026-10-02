# The reviewer pipeline at stack head, and where a context-delivery system would plug in

All paths below are relative to the 2.0.0 stack head (`stack/52-i37-work-plan`, commit `b158f5a`), and `T/` stands for `template/base/`.

## Executive summary: extension points, most natural fit first

1. **The SubagentStart branch of `T/.claude/hooks/subagent-verdict.mjs:284-301`.** This is the best fit.
   - It already fires for every reviewer, and only for reviewers (`reviewerTypes()` at :248-261).
   - It already knows `agent_type` and `agent_id`.
   - It already computes `reviewChanges()` and the v2 digest (`reviewState` at :160-172).
   - Today it writes the dispatch record and exits 0 with no output. Printing `hookSpecificOutput.additionalContext` there would inject a deterministic neighbourhood that the authoring agent cannot shape.
   - Caveat: the repo has never recorded or probed SubagentStart `additionalContext`. CONTROL-PLANE-FACTS Fact 3 records only the input payload, and Fact 18 covers PostToolUse. It needs a Fact-19 probe first.
2. **The dispatch record (`.harness/reviewer-dispatch.jsonl`).** A `neighbourhood_digest` could sit beside `path_state_start`. The Stop step could then later prove that a PASS was given with the neighbourhood of the tree it judged. Making that a check needs a gate-proposal.
3. **A pure `tools/lib/` index module.** It would reuse the duplication tokenizer and R07's `loadParser()` pattern, and cache under `.harness/` keyed by a content digest, as N01 stamps are.
4. **The spec-anchor precedent (N13).** `T/.claude/commands/new-feature.md:89-92` already tells the main agent to run a tool and paste its output into "the reviewer's brief". It needs no new infrastructure, but it is advisory and the author controls it.
5. **Reviewer bodies and their `## WHAT MUST ACCOMPANY IT` tables.** A row such as "a new helper must bring a search for the existing single home" would make reuse a reported line (`<id>: present|absent`). These files are owned, hash-locked and write-guarded.
6. **The reviewer eval.** `scripts/reviewer-eval.mjs` `livePrompt()` (:389-400) is the natural A/B lever. You would need a new `kind`, a new companion row id, and a "deliberate mirror" twin to measure precision.
7. **PostToolUse `additionalContext` for authoring agents.** Fact 18 observed that it reaches the model, and `posttool-source-check.mjs:97-112` already uses it. It is advisory, capped at 10,000 characters, and runs per edit.
8. **A new read-only MCP tool.** It is pull-based, so it has the same "only finds what it asks for" weakness as Grep. Four write-guarded or seeded registries would have to change, and the eval runs with `--strict-mcp-config`, so it cannot see one.
9. **The SessionStart brief (N10).** Wrong scope (the session, not the reviewer), capped at 1,200 characters, and its doctrine forbids file content.
10. **A deterministic gate** (a near-clone extension of `duplication`, or a new Stop step). Only the mechanical subset belongs here. It needs a gate-proposal, a ramp, a canary, and to be legal on an empty scaffold.

## 1. Reviewer lifecycle end to end

**Owed.**
- `T/tools/reviewer-triggers.json` holds `reviewers[]` (globs plus `except`) and `wholeTurn[]` (:99-108: `torvalds-reviewer` and `citation-verifier`, owed on every non-empty diff).
- `architecture-reviewer` is owed only on `packages/*/src/**`, `packages/*/*/src/**`, a vertical's `package.json`, `tools/exports-walls.json` and `tools/vertical-anatomy-allow.json`, minus tests and `testing/` (:69-80). It is deliberately not owed on `apps/**`; obligation `architecture-reviewer-apps-widening` tracks that (`scripts/obligations.json:131`).
- Matching is done by `owedBy` and `owedByTurn` (`T/tools/lib/reviewer-verdicts.mjs:146`, `:255`) over `reviewChanges()` (`T/tools/lib/git-diff.mjs:111`). That is the merge-base diff, with deletions kept, renames split and `.harness/` excluded.

**Dispatched.** The main agent calls the Agent tool. Nothing in the harness dispatches a reviewer; the obligation is enforced only after the fact.

**Recorded.** `subagent-verdict.mjs` is wired to both SubagentStart and SubagentStop (`T/.claude/settings.json:84-107`, timeout 10s each).
- On SubagentStart it appends `{session_id, prompt_id, agent_type, agent_id, path_state_start}` to `.harness/reviewer-dispatch.jsonl` and exits 0 (:284-301).
- On SubagentStop it:
  - classifies `last_assistant_message` (:303);
  - bounces a missing verdict with exit 2 (:366-379);
  - bounces a PASS that lists a `[CRITICAL]` or `[HIGH]` finding (:384-395);
  - appends to `.harness/reviewer-ledger.jsonl` the fields `v: LEDGER_FORMAT` (`'2.0.0'`, lib :293), `path_state` (v1), `path_state_start`, `path_state_stop`, `model`, `pinned`, `blocking`, `round` and `overBudget` (:413-435).

**Judged.** `T/tools/check-reviewer-verdicts.mjs` is Stop step 10.
- v2 runs in `judgeV2()` (:501-532), which calls `judgeReviewerV2()` (lib :571).
- A BLOCK stands until the same `agent_id` passes.
- A PASS counts only if `path_state_start === path_state_stop ===` the digest at Stop (lib :541-550).
- With no merge base, v2 does not judge.
- It runs behind ramps until 2.1.0 (:29-47, :71).

**"Dispatch-bound verdicts" (R01 point 5, plus B03).**
- R01 (`design/FIELD-UPGRADES-2026-09.md:664-667`, :682-683): the digest is taken at dispatch and again at the verdict. "A verdict whose two digests differ is not counted."
- B03 (:898-907): `prompt_id` leaves the key. A PASS is current while its digest pair matches the tree, read by `session_id` plus the format stamp.

**What a reviewer actually receives today:**
- **The body**, as its system prompt. It is owned, hash-locked in `tools/agents.lock.json`, and the `claude-agents` write-guard rule covers it (`guard-rules.mjs` around :539).
- **The main agent's Agent-tool prompt.** This is free text written by the author whose work is under review.
- **Its tools:** `Read, Grep, Glob`, plus `mcp__rls_verify` for `security-reviewer` and `mcp__corpus_search` for `citation-verifier`.
- **A notable gap:** every reviewer body says "First run `git diff` against the base branch" (`architecture-reviewer.md:26`, `torvalds-reviewer.md:23`), but none holds Bash. So the change set reaches a reviewer only through the dispatch prompt. The eval's `livePrompt` lists the files for exactly this reason.

**Context injection today.** No hook injects anything into a subagent. The only mechanisms are:
- body-directed reads (`src/data/port.ts`, `src/data/rows.ts`, spec sections);
- the main agent pasting `spec-anchor` output into the brief (`new-feature.md:89-92`).

## 2. The architecture-reviewer and torvalds-reviewer bodies

**`T/.claude/agents/architecture-reviewer.md`** (pin `fable`, fallback `opus`). Rubric items that need whole-codebase knowledge:
- **(a) :31-36** "a platform package that knows a feature's name"
- **(b) :37-44** "must name its second consumer or its test-double need … An interface with exactly one implementation and no structural fake in tests is speculative generality" and "flag it when it is copied by reflex"
- **(c) :45-48** "near-identical branches"
- **(d) :49-52** "One concept, one name, across the whole wire: SQL column ↔ `@app/contracts` DTO field ↔ procedure input ↔ screen prop … Two names for one concept, or one name for two concepts"
- **(e) :53-57** "Are a module's exports used together by its consumers … Did a one-concept change touch N packages? A diff that edits the same fact in three places names the missing single home"
- **(f) :58-61** "the superseded helper, the now-unused export … the comment describing the previous design"

**`T/.claude/agents/torvalds-reviewer.md`** (pin `opus`, fallback `fable`). Rubric (d) at :64-84:
- "copy-pasted near-identical blocks"
- "wrappers that wrap one call site"
- "dead exports"
- abstraction accounting and naming coherence across the wire (the same two items again)
- "stale GENERATED inventories" at (b) :44-45

**What N17 added.** N17 (`FIELD-UPGRADES:524-547`) added `## WHAT MUST ACCOMPANY IT` tables that ask the converse question: what must land with what the diff introduces.
- Architecture rows (:73-76): `interface-second-consumer` (`review only`) and `client-export-census` (enforced by `boundaries`).
- Torvalds rows (:99-106): `screen-route-states`, `screen-maestro-flow`, `screen-startup-budget`, `web-page-meta`, `web-page-registry`, `contract-inventories`.
- No row asks about existing code to reuse.
- Rule from `scripts/lib/companion-table.mjs:12-13`: a row "restates a rule, it never makes one", and `Stated in` must name the install path that states it.

## 3. The reviewer eval

**Corpus.** Each case in `tests/fixtures/reviewer-eval/<case>/` has:
- `case.json`: `{reviewer, kind, expect, mustName[], twin, why, edits?}`;
- `overlay/` with new files stored as `*.txt`;
- anchored one-line `edits` that must match exactly one line (`scripts/reviewer-eval.mjs:11-28`, `applyCase` :278).

**Rules and scoring.**
- `KINDS = ['table','function','edge-function','web-page','screen']` (:72).
- Every kind needs one BLOCK case and one PASS twin (`corpusProblems` :227).
- `mustName` ids must be rows of the reviewer's companion table (`mustNameProblems` :175).
- Score: a case is a hit when the verdict matches and every `mustName` id appears as a whole word (`scoreOne` :314, `namesId` :312). Always-PASS or always-BLOCK scores at most half.
- The 10 shipped cases cover security (6), accessibility (2) and torvalds (2). There are **no architecture-reviewer cases**.

**`--live` mode.** It makes a fresh core install, applies the case, and runs `claude -p --agent <reviewer>` with `disableAllHooks` and `--strict-mcp-config` (:402-425, Fact 17). The prompt says "There is no git history … the files below are the whole change" (:389-400).
- Because hooks are disabled and no subagent exists, SubagentStart injection cannot be exercised as-is.
- The A/B would therefore be a `livePrompt` variant that appends the neighbourhood block.
- The eval gates nothing (:51-56).

**Can it measure recall and precision?** Roughly:
- Recall is the BLOCK-case hit rate.
- Precision is the PASS-twin hit rate. A twin that holds a deliberate mirror (the design-system web/native pair accepted in `T/tools/duplication-allow.json`) would catch a reviewer over-flagging once context is injected.
- Gaps: n=10, model nondeterminism (it needs repeated runs, and `live.json` records `claudeVersion`), and no field that checks the reviewer named the *existing* file.

**A "missed reuse" case in this format** (format changes: a new kind in `KINDS`, and a new architecture companion row, e.g. `reuse-existing-home`, stated in `architecture-reviewer.md` (e)/(f)):

```json
{ "reviewer": "architecture-reviewer", "kind": "helper", "expect": "BLOCK",
  "mustName": ["reuse-existing-home"], "twin": "helper-reuse-complete",
  "why": "packages/api/src/routers/billing.ts hand-rolls an {ok:false,error} envelope and kind union instead of outcomeErr/appError from @app/errors (packages/platform/errors/src/index.ts:198,:337); under the 70-token clone floor, so `duplication` stays green." }
```

- The overlay would be `overlay/packages/api/src/routers/billing.ts.txt`, plus an anchored edit that mounts the router.
- The twin imports `outcomeErr`.
- An optional new `mustCite: ["packages/platform/errors/src/index.ts"]` would need a change to `scoreOne`.

## 4. Deterministic structural analyzers already in the scaffold

| Analyzer | What it computes | Granularity | Parser |
|---|---|---|---|
| `T/tools/check-duplication.mjs` (Stop step) | Type-1 token clones, ≥70 tokens and ≥6 lines (:29-30); literals normalized to `S`/`N`; sha fingerprints; walks `apps/*/src`, `packages/*/src`, `packages/*/*/src`, `apps/web/{app,lib}` | token window, cross-file | one regex tokenizer (`TOKEN_RE` :113-114). States it is deliberately not "two functions that merely rhyme" (:8-9) |
| `T/tools/lib/vertical-anatomy.mjs` | Seven laws per vertical (`dual-barrel` … `select-star`, :52-60): import specifiers, PostgREST call shapes, port presence | file / import | textual (:39-41) over `source-text.mjs` |
| `T/dependency-cruiser.cjs` (`architecture` step) | Nine forbidden-edge rules (:17-103); `tsPreCompilationDeps`, `tsConfig: tsconfig.base.json`, `exportsFields` (:108-116) | module import graph | depcruise's own resolver (real TS) |
| knip (`T/knip.json`, `knip --strict`) | Unused files, exports and dependencies per workspace | file / export | knip's parser |
| `check-complexity-ratchet` | Cognitive complexity ratchet | function | Factory-only (`scripts/`), over the installer; re-lints with `--no-inline-config` |
| `T/tools/lib/cc-floor.mjs`, `T/tools/cc-floor.json` | The **Claude Code version floor**, not code complexity | — | — |
| sonarjs (`T/eslint.config.mjs:130`, `:181`) | Only `sonarjs/cognitive-complexity ≤ 15`. typescript-eslint `strictTypeChecked` uses `projectService` (:113-118), so a type-aware AST exists at lint time; custom rules live in `T/tools/eslint-rules/index.mjs` | function | ESTree, type-aware |
| `template/stack/tools/exports-walls.json` (stack, not base) | Census of packages allowed a `./client` export | package | JSON |
| `T/tools/doctrine-symbols.json` | Closed map of retired → replacement tokens over agent-surface prose (`scope` regexes), checked by docs-sync (`check-docs-sync.mjs:891`) | token | regex |
| `T/tools/decision-groups.json` | Regex patterns marking decision sites for provenance | line | regex |
| `T/tools/lib/source-text.mjs` | `blankComments`, `lineOf`, `skipBalanced` (:31, :38, :91): position-preserving text primitives | character | regex |
| `T/tools/lib/stamp-inputs.mjs` | Reviewed per-gate input lists plus machinery and the import closure (:18-23); `stampGate` at `gate.mjs:444` | file set | — |
| `T/tools/lib/git-diff.mjs` | `changedFiles()` (HEAD-based, deletions dropped) vs `reviewChanges()` (merge-base, deletions kept) | file | git |
| `T/tools/generated/*.json` | `action-inventory` is a runtime walk of `appRouter._def.procedures` under tsx; `query-shapes` is executed DAL probes; `event-catalog`. All seeded, write-guarded, and regen-diffed by `contracts` | symbol | runtime |
| Also | `check-mobile-parity.mjs` (action ↔ web screen ↔ mobile screen via PARITY.md); `check-workspace-deps.mjs` (package.json dependency matrix) | — | — |

**Parsers available to template tools.**
- `typescript` (catalog `~6.0.3`, `T/pnpm-workspace.yaml`) is a root devDependency in `T/package.json.tmpl`; `tsx` is in the catalog.
- There is no tree-sitter, ts-morph, Babel, oxc or swc anywhere in template tools.
- **R07** adopted the project's own `typescript` through a dynamic `import('typescript')` (`T/tools/lib/i18n-tree.mjs:28-32`, `loadParser` :98). It uses syntax-only `ts.createSourceFile` (:222), with no Program or TypeChecker. When the parser cannot load, the result is null: a NOTE locally and a failure in CI (`check-i18n.mjs:211-215`). Since 2.0.0 it is the i18n gate's only scan.
- No hook imports any npm package today; hooks import only `node:` built-ins and harness libs.

## 5. Session-context surfaces

**N10, the SessionStart brief.**
- `T/.claude/hooks/session-brief.mjs` and `T/tools/lib/harness-brief.mjs` (cap 1,200 characters at :33).
- It prints the owed reviewers through `owedByTurn` (:302-307), never reads stdin, and always exits 0.
- Its doctrine (`T/docs/harness/README.md:704-735`): "It is an injection surface, so it is closed … No file content is ever read into it."

**N13, `T/tools/spec-anchor.mjs`.** A one-section printer. It is "a tool, not a gate", and the main agent pastes its output into the reviewer's brief.

**N18.** Whatever is always loaded should shrink. A sentence leaves AGENTS.md only when a gate reds its violation (`FIELD-UPGRADES:549-571`).

**N02, telemetry.** `.harness/telemetry.jsonl` (`hookio.mjs:44-63`): "never file content, command text, paths or messages — and no gate reads the file."

**N01, input stamps.** `stampGate` stores `.harness/<gate>.ok`, CI never honours a stamp, and input lists must include each script's `tools/lib` import closure. This is the natural cache key for a neighbourhood index.

**MCP servers.**
- `corpus_search` and `rls_verify` are stdio servers built on `@modelcontextprotocol/sdk`, listed in `T/mcp.json` and in `enabledMcpjsonServers` (`T/.claude/settings.json:3-6`).

**What a new MCP tool would need** (constraints from `T/.claude/hooks/pretool-mcp-guard.mjs` and others):
- a row in `tools/approved-tools.json`, which is default-deny, fails closed on any parse or shape problem, is write-guarded, and is **seeded**, so `update` cannot add a row to an existing install;
- the doc row in `docs/security/approved-tools.md`, which docs-sync holds in lockstep;
- a `readOnly` name-shape check: `MCP_RULES` (`guard-rules.mjs:366-374`) denies `create_|update_|write_|set_|…` names;
- an entry in `REVIEWER_READONLY_TOOLS` (`T/tools/lib/agent-roster.mjs:102-109`), or docs-sync reds the reviewer;
- an edit to the reviewer's frontmatter `tools:` line, which re-hashes `agents.lock.json`;
- a `permissions.allow` entry.

A hook needs none of these. Delivering through SubagentStart is push-based and author-independent; an MCP tool is pull-based.

## 6. Doctrine a new system must respect

**Why advisory context is distrusted.** `T/docs/harness/README.md:10-13` says "quality is a deterministic gate, not a request. Memory files … are advisory context". Lines 26-28 add: "never rely on a layer-1 instruction for anything a layer-3/6 gate could enforce deterministically." Injected context is layer 1, so it raises probability and must never be sold as enforcement.

**Gate rules (CONTRIBUTING.md:39-46, ground rule 6).** A gate must be deterministic, hermetic, fast and green on a fresh scaffold, and needs a `gate-proposal` issue, an anti-vacuity canary and a catalog entry. After B01 the default scaffold has no example code, so an index must be legal when empty (N07).

**Ramps (`gate.mjs:204-230`).** A new verdict on an existing install is a dated NOTE (`until` is mandatory). Add to that the "Weaken a gate to make an upgrade painless" refusal in `ROADMAP.md`.

**Built-ins only applies to `installer/` (ground rule 3)**, not to template tools. Template tools may use root devDependencies (R07's `typescript`), but must tolerate their absence: return null, NOTE locally, fail in CI.

**Write-guarded paths.** These cover `tools/lib/**`, `tools/mcp/**`, `.claude/agents|rules|commands|skills`, `tools/reviewer-triggers.json`, `tools/generated/*` and the allow-files. `.harness/**` is denied to the Edit and Write tools, but hooks write there through Node.

**Ownership.**
- `settings.json`, the hooks and `tools/lib` are owned and hash-pinned, so they reach an install through `update`.
- `reviewer-triggers.json`, `approved-tools.json` and the generated inventories are seeded (`installer/lib/layout.mjs:249-293`).

**CI floor.** `tools/validate.floor.json` and `tools/stop.floor.json` only grow. `reviewer-verdicts` runs in no CI lane (R01 point 1), so reviewer-side context has no CI backstop.

**Already-rejected ideas** (`FIELD-UPGRADES:911-929`, "Dropped after design review"):
- **"Persistent memory for reviewers"**: memory is a write surface and "would carry one review's conclusions into the next as unexamined premises". An index must stay a pure function of the tree, never cached findings.
- **"`vitest --changed`"**: "Selection by import graph misses what a test depends on without importing: SQL, JSON registers, the environment." An import-graph-only neighbourhood would miss rubric (d)'s SQL ↔ DTO ↔ screen chain.
- **"Diff-class Stop tiers"**: a misclassification becomes a silent skip.
- **"Comment-insensitive path digests"**: they fail open. A similarity index may strip comments, but a binding digest must not.
- **A code-bearing reference directory.**

On context size, N18 shrank the always-loaded context. The caps in force are 10,000 characters for `additionalContext` (posttool-source-check :52 caps its list at 20 sites) and 1,200 for the brief.

## 7. The cost envelope

**Hook timeouts** (`T/.claude/settings.json`):

| Hook | Timeout |
|---|---|
| Stop | 600s |
| SubagentStart / SubagentStop | 10s |
| SessionStart | 10s |
| PreToolUse | 10s |
| PostToolUse | 60s (fast-check) / 30s (source-check) |

The block cap is 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

**Chain budget** (`scripts/chain-budget.json`, factory-side only; "Milliseconds are not" deterministic, so no consumer gate reads it):
- validate wall: measured 23.0s against a 120s ceiling;
- Stop wall: measured 52.7s against a 600s ceiling (warn at 450s);
- `duplication` 310ms (ceiling 15s), `i18n` 106ms (the TypeScript parse of the UI), `reviewer-verdicts` 64ms;
- default ceiling for a static step: 5s.

**Implication.** Reviews run mid-turn, before Stop, so a pre-review index adds nothing to Stop wall time unless it is made a step.
- **At SubagentStart** it must fit inside 10s, beside the git calls and file hashing `reviewState` already does. It runs once per dispatched reviewer; at least two whole-turn reviewers fire on every turn, and the tree triggers up to six more.
- On the scaffold a full rebuild costs a few hundred milliseconds (the duplication and i18n figures). A grown project needs an incremental index cached under `.harness/` by content digest and shared across the reviewers of one tree.
- A SubagentStart timeout blocks nothing, so the reviewer silently gets no context. That would have to be recorded, for example `neighbourhood: null` in the dispatch line, never left as a silent skip.

## Constraints the design must not violate

- Deterministic: the same tree gives the same neighbourhood. It must not depend on the clock, the network or model output.
- The neighbourhood must not be stored reviewer memory. It is derived from the tree on each run and never carries one review's conclusions into the next.
- Advisory context changes no verdict. Anything that gates needs a `gate-proposal`, an anti-vacuity canary, a catalog entry and a dated ramp with `until`.
- Bookkeeping never decides an outcome. Index failure is null plus a visible note, never an exit 2 on SubagentStop and never a lost verdict.
- Fail visibly: a skip must never look like a pass. NOTE locally, fail closed in CI where it gates.
- No npm import in a hook without a dynamic `import()` and a null fallback. `subagent-verdict.mjs` also serves SubagentStop, where a load failure turns into exit 2 through `launch.mjs`.
- Namespace-import new lib exports so parked forks still load (the 1.0.2 rule).
- Treat the output as an injection surface: closed, length-capped fields of repository-relative paths, symbol names, line ranges and scores. Reviewers Read the code themselves; the payload carries no raw file content. Stay inside the 10,000-character `additionalContext` cap.
- Reviewers stay read-only (`REVIEWER_READONLY_TOOLS`). No write, shell or network leg.
- Never let the authoring agent control or edit what the reviewer is told. Inputs must come from hook or tool code that is owned, write-guarded and hash-pinned.
- Do not touch the R01/B03 binding semantics, `path_state_start`/`path_state_stop`, or `LEDGER_FORMAT` unless the format version moves.
- Do not select by import graph alone. Cover SQL, JSON registers, contracts and generated inventories.
- Empty-legal on a fresh scaffold (no example code after B01), and hermetic.
- No wall-clock budget in consumer gates. Cost is measured factory-side in `chain-budget.json`.
- Do not widen reviewer triggers by side effect. Narrowness first; widening goes through a reviewed diff.
- The installer stays on Node built-ins only. Template tools may use the root `typescript` with graceful absence.
- Re-probe any Claude Code behaviour relied on (SubagentStart `additionalContext`, resumed `agent_id` from Fact 14) and record it in CONTROL-PLANE-FACTS before the design freezes.
