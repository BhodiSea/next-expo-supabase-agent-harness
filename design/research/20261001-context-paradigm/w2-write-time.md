# Write-time delivery to the authoring agent

Paths are under `template/base/` at the 2.0.0 stack head (commit `b158f5a`) unless they start with `design/`. The stack-head tree was not modified.

## Summary

- **When it helps:** only when it is selective and gives pointers (import path and signature), never a function body. A deterministic check must follow it. Dumping similar code hurts. The evidence for both points is indirect but agrees (section 2).
- **No early channel:** Claude Code has no non-blocking way to speak before a write lands. A PreToolUse `additionalContext` arrives "next to the tool result", just like PostToolUse. The only pre-write channel is a deny.
- **Main channel:** a PostToolUse "dossier" message after each relevant edit. It runs in parallel with Biome. Three cheaper moments come earlier: plan time (the agent asks), scaffold time (the script prints), and author-subagent dispatch (SubagentStart).
- **Recording:** every hit shown is written to a ledger that only hooks can write. Being shown a hit never settles what is owed. The ledger lets the Stop step tell "saw it and ignored it" from "never saw it", because delivery is unreliable on some surfaces.
- **Embeddings:** write time uses deterministic matches only. Embedding hits are computed in the background and appear at review time.

## 1. Internal: the moments and the mechanisms

**How the hooks give feedback today**
- **Blocking answer:** PostToolUse exits 2 with stderr (`.claude/hooks/posttool-source-check.mjs:89-98`).
- **Advisory answer:** PostToolUse exits 0 with `hookSpecificOutput.additionalContext` JSON (`posttool-source-check.mjs:7-15`, `:101-113`). Fact 18 shows it reaches the model (`design/CONTROL-PLANE-FACTS.md:584-616`).
- **Fast check:** never blocks (`posttool-fast-check.mjs:3`, `:40`). It spawns `pnpm exec biome` (`:24-30`).
- **Timeouts:** 60 s for the fast check and 30 s for the source check, both matching `Edit|Write|MultiEdit` (`.claude/settings.json:15-25`).
- **Launcher:** `launch.mjs` fails closed. A hook that cannot load becomes exit 2 (`launch.mjs:34-41`).
- **The one exception:** the SessionStart brief is invoked directly and exits 0 on every path (`session-brief.mjs:150-159`).

**What the Claude Code docs confirm** (https://code.claude.com/docs/en/hooks):
- Matching hooks run in parallel.
- `additionalContext` is capped at 10,000 characters.
- PreToolUse and PostToolUse fire inside subagents, carrying `agent_id` and `agent_type`.
- SubagentStart accepts `additionalContext`.
- `async` and `asyncRewake` hook options exist.

**Measured here (node 22)**
- A bare node start takes about 33 ms.
- `launch.mjs` running `posttool-source-check.mjs` on a 444-line file takes about 60 ms.
- The whole-tree clone gate `tools/check-duplication.mjs` takes about 330 ms on the bare scaffold (234 files, 27.5k lines).
- So fingerprinting one file and looking it up fits on every edit. A whole-tree scan stops fitting as the tree grows.

| # | Moment | Mechanism and existing precedent | What to deliver | Verdict |
|---|---|---|---|---|
| M0 | Session start | The SessionStart brief. Its output is treated as an injection surface: closed validators, no file content, 1,200-character cap (`tools/lib/harness-brief.mjs:11-17`, `:33`). | Index fresh or stale, embedding layer on or off, count of open advisories. No hits. | Status only |
| M1 | Spec or plan | Skill Step 0 already says to read `action-inventory.json` and STOP if the operation exists (`.claude/skills/authoring-vertical-slice/SKILL.md:20-34`). The spec's "Files and interfaces" section (`specs/_template.md:27-29`) is addressable through `tools/spec-anchor.mjs`. The `corpus_search` MCP server is the precedent for a query tool (`settings.json:3-6`, `:144-146`); its header says "swap for embeddings later behind the same tool contract" (`tools/mcp/corpus-search-server.mjs:1-5`). | A query tool: `neighbourhood_query` (MCP) or `node tools/neighbourhood.mjs --plan <entity> <cols…>`. It returns concept-graph matches and existing helpers by role. Add a `## Reuse` section to the spec template. | Yes. Cheapest moment: no code written yet. |
| M2 | Scaffold | `scaffold-slice.mjs` runs on the main thread (`SKILL.md:102-106`) and already prints `next:` lines (`scaffold-slice.mjs:161-180`). | The top 3 neighbouring slices: overlapping columns, or the same entity and verb. | Yes. No hook needed. |
| M3 | Author-subagent dispatch | SubagentStart is already wired (`settings.json:84-95`). Its payload has `agent_type` (`design/CONTROL-PLANE-FACTS.md:425-427`). `dal-author` has no Bash and no MCP tools (`.claude/agents/dal-author.md:11`). Its "reuse" duties exist only as prose (`dal-author.md:67-73`, `migration-rls-author.md:118`). | For author agents: the helpers to reuse, computed from the index. Delivered either by a separate entry that is called directly and never blocks on failure, or by granting `mcp__neighbourhood` in the agent's frontmatter (as `citation-verifier` has `mcp__corpus_search`). | Yes |
| M4 | After Write or Edit | PostToolUse `additionalContext` (precedent at `posttool-source-check.mjs:101-113`). Inside a subagent the message reaches the subagent, not the main thread. | The dossier (section 3). | **Primary channel** |
| M5 | Before Stop | Stop chain exits 2 with stderr (`stop-validate-gate.mjs:411-412`). | The unresolved owed pairs, in a message that stands on its own. | The authority |
| – | UserPromptSubmit | Not used by the harness. | It would fire on every prompt, before any code exists. | Rejected |
| – | PreToolUse deny | `denyTool` (`hookio.mjs:122-134`). | The only pre-write channel is a block. It costs a round trip and invites the agent to thrash. | Rejected for v1 |
| – | PostToolBatch | Documented but never probed. | Could dedupe hits across parallel edits. | Later |

## 2. External evidence

**Feedback at the moment of change works when it is precise**
- **Facebook:** the same analyses got about a 70% fix rate at diff time and about 0% as batch lists. https://cacm.acm.org/research/scaling-static-analyses-at-facebook/
- **Google Tricorder:** reports on changed lines only, and allows at most 10% *effective* false positives. Reviewers can see which findings the author ignored. https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
- **SWE-agent:** an edit command with linting resolved 18.0% of tasks, against 15.0% without linting. https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf
- **Pylint/Bandit feedback loops:** readability violations fell from over 80% to 11%. https://arxiv.org/abs/2508.14419
- **CodePlan:** re-analyses impact after each edit and turns the results into edit "obligations", the same shape as owed dispositions. https://www.microsoft.com/en-us/research/publication/codeplan-repository-level-coding-using-llms-and-planning-2/

**Retrieval for reuse helps, as a tool the agent calls or as a pointer**
- **Cursor:** semantic search raised accuracy 12.5% and code retention 0.3% (2.6% in repos with 1,000+ files). Grep plus semantic search did best. https://cursor.com/blog/semsearch
- **Augment Context Engine MCP:** a vendor benchmark that scores "code reuse" and claims a 70–80% gain. https://www.augmentcode.com/blog/context-engine-mcp-now-live
- **ToolCoder:** an API-search tool improved pass@1 by 6.21% or more. https://arxiv.org/abs/2305.04032
- **RepoCoder:** using the *generated code* as the search query beat the in-file baseline by more than 10%. https://aclanthology.org/2023.emnlp-main.151/
- **A3-CodGen:** beats Copilot on reuse, but more than 5 retrieved functions interfere with each other. https://arxiv.org/pdf/2312.05772
- **DevEval:** dependency Recall@k is a usable reuse metric. https://aclanthology.org/2024.findings-acl.214.pdf

**The risks: copying, noise and thrash**
- **Similar code is noise:** retrieving similar code degrades results by up to 15%, while API information helps. https://arxiv.org/abs/2503.20589
- **Retrieval must be selective:** Repoformer found a large share of retrieved contexts unhelpful or harmful. https://arxiv.org/abs/2403.10059
- **Context files can hurt:** AGENTS.md files lowered success and raised cost by more than 20%. https://arxiv.org/abs/2602.11988
- **Assistants duplicate by default:** GitClear saw duplicated blocks rise about 8x in 2024, with copy-paste exceeding moved code. https://www.devclass.com/ai-ml/2025/02/20/ai-is-eroding-code-quality-states-new-in-depth-report/1626250
- **Copilot's low inclusion bar does not carry over:** its +5% gain was for completion context, not for interrupting an agent. https://github.blog/ai-and-ml/github-copilot/how-github-copilot-is-getting-better-at-understanding-your-code/

**Delivery is unreliable on some surfaces**
- The VS Code extension drops `additionalContext`; the issue was closed as not planned. https://github.com/anthropics/claude-code/issues/79616
- It is also dropped for MCP tool calls (https://github.com/anthropics/claude-code/issues/24788).
- It was dropped for the Bash matcher at version 2.1.123 (https://github.com/anthropics/claude-code/issues/55889).

**Verdict.** I found no controlled study of this exact intervention: telling an agent mid-task that similar code exists. The indirect evidence says:
- Interrupt rarely, and only with high-confidence hits.
- Give APIs, not code bodies.
- Make the follow-up deterministic.
- Measure how often each kind of hit is acted on, as Tricorder does.

## 3. The protocol

### 3.1 When the hook speaks (otherwise it exits 0 silently)

It speaks only on one of these:
- **New file** in `apps/**`, `packages/**` or `supabase/{schemas,migrations}/**`. "New" means the path is not in the index or the turn overlay, so no payload field is needed.
- **New exported symbol:** a set difference against the index entry for that file's last git blob.
- **New SQL object:** a new table, column or function.
- **New zod schema.**

It skips tests, generated files, `tools/` and `.claude/`, as `hookScansFile` does (`posttool-source-check.mjs:68`). It also skips candidates the file already imports, and pairs already accepted in `tools/duplication-allow.json` (the deliberate web/native mirror).

### 3.2 Only high-confidence ("owed") hits interrupt

Three kinds of hit qualify:
- **Structural:** similarity at or above a threshold `T_owed`, with matching arity and types.
- **Concept:** a new DTO has the same fields as an existing one, or the same entity and verb already exist in `action-inventory.json`.
- **Exact:** the same fact repeated.

Lower-confidence advisory hits are never shown at write time; they go to review and to GitHub issues.

A kind of hit may interrupt only once its measured effective false-positive rate is 10% or less, Tricorder's threshold. Until then it is review-only. This is the harness's ramp, applied to interruptions.

### 3.3 The message: a pointer, the legal moves, no code body

```
Neighbourhood (ADVISORY, not a block · 1 of ≤3 this turn)
NEW export encodePageToken  packages/verticals/invoices/src/domain/cursor.ts:12
  ≈ encodeCursor  packages/verticals/notes/src/domain/cursor.ts:18  (structure 0.93)
    (createdAt: string, id: string) => string
  A vertical must not import another vertical; legal moves:
    EXTRACT  move it to packages/shared and import it from both
    JUSTIFY  `// neighbour-divergence: notes#encodeCursor — <reason>` above yours
  Do not copy its body. If this pair is still in the diff at Stop, the
  `neighbourhood` step will require: reuse | extract | justify.
```

- **Signature, never the body:** API information helps and similar bodies are noise (2503.20589). A body is what gets copied. It is also text an attacker could have written, so the brief's no-content rule applies (`harness-brief.mjs:11-17`). Names and paths must pass the brief's closed validators (`harness-brief.mjs:48-70`), or they print as `(unprintable)`.
- **Only legal moves:** suggestions are filtered by the boundary rules (`SKILL.md:115-119`) and depcruise. The agent is never steered into a guard failure, which is the main way it would thrash.
- **Same verbs as review time:** reuse, extract, justify. `justify` is an inline committed marker, like the existing `-- harness-allow-dml:` and `// SOURCE:` markers.

### 3.4 Size, speed, and what is computed ahead of time

**Size:** at most 3 items (per A3-CodGen) and at most 1,500 characters.

**Speed**
- Target inside the hook: half of runs within 150 ms, 95% within 300 ms.
- The hook gives itself a 1 s deadline and exits 0 silently if it misses it. The settings timeout is 5 s.
- Because hooks run in parallel, this time hides under the Biome run.

**Computed ahead of time**, stored in `.harness/context/` and updated incrementally by git blob SHA:
- function fingerprints and locality-sensitive hash buckets;
- export tables and the import/call graph;
- the concept graph (SQL column → row type → zod DTO → procedure → screen), built from `tools/generated/*.json` and the database types;
- the slice layout and abstractions that have a single consumer;
- files that change together;
- optional embeddings.

The index is refreshed after a green Stop and by a background SessionStart entry. The PostToolUse hook never builds the index.

**On each edit**
1. Read the one edited file and compute its blob hash in-process.
2. Fingerprint only the new or changed exports, the way the `check-duplication.mjs` tokenizer does.
3. Look up the hash buckets and the concept graph.
4. Re-hash the (at most 3) candidate files and drop any whose content changed, so a pointer is never stale.
5. Apply the boundary filter and the seen-ledger.
6. Write the message.
7. Add the file to a turn overlay. A helper written in file A is then found when the agent writes it again in file B, which is the most likely duplication.

### 3.5 Not nagging

- **Once per pair:** each (session, new symbol, candidate) pair is shown once per session. It is shown again only if it is promoted from advisory to owed.
- **Per-prompt budget:** at most 3 dossiers per prompt. After that, one line says how many further hits were recorded for Stop.
- **Silent cases:** edits that only change function bodies, and edits that respond to a dossier (they add no new export).
- **Telemetry:** `recordHookEvent` with rule `neighbourhood/<kind>` and outcome `advisory` (`hookio.mjs:94-115`). This gives the action rate for each kind of hit.

### 3.6 Recording, and the hand-off to review

The hook appends to `.harness/neighbourhood-shown.jsonl`, which the agent cannot edit (`settings.json:215-216`, `guard-rules.mjs:711`). Each record holds:
- the session, prompt and tool-use ids;
- `agent_id` and `agent_type` when the hook ran inside a subagent;
- the new symbol and the candidate, each as path, symbol and blob;
- the kind, tier and score.

It holds no code content, and it is written only when the install manifest exists (`hookio.mjs:52-61`).

Being shown a hit never settles it. The Stop step classifies each owed pair from the final diff:

| Outcome | How it is decided |
|---|---|
| Reuse | The new symbol is gone and the candidate is imported. Checked mechanically. |
| Extract | Both sides now import one shared symbol. Checked mechanically. |
| Justify | The `justify` marker is present, and the reviewer must endorse it. |
| Shown, then ignored | Block, naming when it was shown and to which agent. |
| Never shown (dropped in VS Code, or delivered only inside a subagent) | Block, with the full dossier included in the message. |

Reviewer briefs get a line like "shown to dal-author at T; disposition X". That gives reviewers Tricorder-style accountability and saves them re-deriving the hits. For subagents the ledger is the only trace that delivery happened, because `dal-author` returns only a file list.

### 3.7 Embedding layer

It stays off the synchronous path, for three reasons:
- each lookup costs a model call;
- the results are not deterministic;
- it needs network access.

How it fits in:
- An optional background (`async`) PostToolUse entry may record semantic hits as advisories. These appear at review time and as issues.
- A semantic hit becomes owed only when a deterministic hit backs it up.
- When the layer is off, the session-start brief says so.
- The MCP query tool serves embeddings behind the same contract, as `corpus_search` already plans to.

### 3.8 What happens when the hook fails

- **It fails open.** The dossier hook is invoked directly, like `session-brief.mjs`, not through `launch.mjs`. It exits 0 on every path. A PostToolUse exit 2 shows stderr to Claude, so a broken advisory hook would print a stack trace on every edit. The Stop step is the authority that fails closed.
- **Probe before relying on it.** Add CONTROL-PLANE-FACTS rows, re-checked at each Claude Code version bump the way Fact 18 was, for:
  - delivery inside a subagent;
  - MultiEdit;
  - the VS Code extension;
  - background PostToolUse hooks;
  - SubagentStart `additionalContext`.

## 4. Open risks

- **Copying from signatures:** the agent may re-implement a function from its signature instead of importing it. The mechanical reuse check at Stop is the backstop. Before letting any kind of hit interrupt, measure dependency Recall@k on seeded test tasks with the hook on and off.
- **Extracting into seeded packages:** `update` cannot deliver new exports into the seeded shared packages (see the i18n entry in `tools/duplication-allow.json`). When the shared target is seeded, the boundary filter should prefer `justify`.
- **Unprobed shortcuts:** `PostToolBatch`, and a field in the Write `tool_response` that would say whether a file was created or updated, could simplify the triggers. Neither has been probed, so nothing should depend on them.