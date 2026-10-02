# Repository context retrieval for coding and review agents (research report, 2026-10-01)

**How I sourced this.** The egress proxy blocked arxiv.org, cursor.com, qodo.ai, coderabbit.ai, greptile.com, augmentcode.com, sourcegraph.com, github.blog and trychroma.com. I read these directly: the Anthropic engineering posts, Anthropic's Code Review post, the Opus 4.6 announcement, Aider's `repomap.py`, and the GitHub READMEs for AutoCodeRover, mini-swe-agent, LocAgent, RepoFuse, Serena and OpenCodeReview. All other figures come from search-engine extracts of each paper's abstract or HTML page. I did not read those papers in full. No code was changed.

## Executive summary

1. **For strong models, letting the agent fetch context on demand ("pull") beats putting pre-computed context in the prompt ("push"), for review as well as generation.** Claude Code dropped RAG with a vector database in favour of model-driven grep and glob [1].
   - On AACR-Bench, adding BM25 top-3 context cut F1 by 31% for one non-agent reviewer (Claude-4.5-Sonnet).
   - Non-agent reviewers got worse as context grew (Diff > File > Repo). Agent reviewers improved at repo level [20].
2. **A structural index offered as a tool still gives real gains on multi-file work.** In an ablation with Opus 4.7 (June 2026):
   - localisation acc@5 rose from 44.3% to 84.5%;
   - resolve rate rose from 41.9% to 50.4% on SWE-bench Pro and SWE-PolyBench, with no extra cost;
   - the gain was largest for changes touching 3 or more files [13].
   - LocAgent, LARGER and CodeNib point the same way [8][14][15].
3. **grep plus semantic search beats either alone.** Cursor reports +12.5% mean accuracy and +2.6% code retention on large repositories. This is the vendor's own A/B test [10].
4. **The best graphs are deterministic def/ref, import and call graphs built from the syntax tree (AST) or a language server (LSP).** Knowledge graphs extracted by an LLM did worse: the LLM skipped about 31% of files and the build cost about 20× more [16].
5. **Ranking methods that have worked:**
   - personalised PageRank seeded on the working set (Aider) [5];
   - k-hop neighbourhoods around a symbol (RepoGraph) [6];
   - a text-search hit first, then expansion along graph edges (LARGER) [14];
   - hybrid BM25 + embeddings + SCIP symbol graph (CodeNib) [15].
6. **Less context works better.** The single best retrieved example beats several for review generation [22]. Input length alone hurts reasoning even when retrieval is perfect [30]. All 18 models in Chroma's study degraded as input grew [29].
7. **1M-token windows have improved recall, not reasoning over code.** Opus 4.6 scores 76% on the MRCR v2 8-needle test at 1M tokens (vendor figure) [32]. LongCodeBench, however, saw issue resolution fall from 29% to 3% between 32K and 256K tokens for Claude 3.5 Sonnet [31].
8. **Review quality comes from structure and verification, not from more context.**
   - OpenCodeReview scored 2.17× the SEM-F1 of Claude Code on the same model while using 5–15× fewer tokens. It uses fixed file and rule dispatch, six tools with capped output, and a checker that sees only the diff [24].
   - Merging several independent review runs raised F1 by up to 43.67% [21].
   - Anthropic's Code Review finds bugs, verifies them, then ranks them [27].
9. **Products are converging on the same split:** the agent fetches code itself, and retrieval or memory is kept for what the repo cannot tell it, such as past PR decisions and team conventions. Qodo 2.4 removed most of its code RAG [25]. CodeRabbit uses "learnings" plus a graph rebuilt for each review [26]. Copilot code review moved to agentic tool calling [28].
10. **The failure modes have been measured.**
    - Stale retrieved snippets caused references to outdated helpers 76–88 percentage points more often than current snippets did [34].
    - Agent-written code is 2.3× more verbose than human code and gets worse with each iteration [36].
    - In 2024, copy-pasted lines exceeded moved (refactored) lines for the first time [37].

## Q1. Repository-level retrieval for coding agents

**Static maps pushed into the prompt.** Aider works like this [5]:
- It parses files with tree-sitter and builds a file graph whose edges run from where an identifier is defined to where it is referenced.
- It ranks the graph with NetworkX PageRank, personalised towards the files in the chat.
- Edge weights:
  - edges from chat files ×50;
  - identifiers mentioned in the chat ×10;
  - private `_names` ×0.1;
  - identifiers defined in more than 5 places ×0.1.
- It outputs the top signatures within a token budget (default about 1k).

No published ablation measures what the repo map adds on its own.

**Graph plug-ins.**
- **RepoGraph** (ICLR 2025) builds a def/ref graph at the level of individual lines and retrieves k-hop neighbourhoods ("ego-graphs"). Added to existing systems, it gave a mean relative improvement of 32.8% on SWE-bench Lite (+2.34 absolute for Agentless) and carried over to CrossCodeEval [6].
- **CodexGraph** (NAACL 2025) stores the repo in Neo4j, and a translator agent writes Cypher queries. I could not verify its headline numbers [7].
- **LocAgent** (ACL 2025) builds one graph with several node and edge types. Nodes are directories, files, classes and functions; edges are contain, import, invoke and inherit. An agent traverses it over several hops. Results: 92.7% file-level localisation, +12% Pass@10 on issue resolution, and a fine-tuned 32B model at about 86% lower cost [8].

**Structured agentic search.**
- **AutoCodeRover** uses AST-based search APIs plus spectrum-based fault localisation. It reached 46.2% on SWE-bench Verified (Nov 2024) at under $0.70 per task [9].
- **Agentless** narrows down from file to class or function to line, using prompting plus embeddings. It scored 32% on SWE-bench Lite at $0.70 [9b].
- **SWE-agent's interface work (ACI)** showed that purpose-built search and view commands with capped output matter. Its successor, mini-swe-agent, uses only bash and scores above 74% on SWE-bench Verified [9c]. On SWE-bench-type tasks, custom retrieval tooling is no longer the bottleneck.

**Retrieval for code completion (2023–25).**
- **RepoCoder** alternates retrieval and generation, beating zero-shot completion by more than 10% [17].
- **RepoFuse** combines two kinds of context [18]:
  - "analogy" context: similar code;
  - "rationale" context: dependencies and APIs.
  - It fits them into a fixed budget by ranking and truncating, gaining +3.97 / +3.01 exact match on CrossCodeEval (Python / Java).
  - This split matches your "similar code" versus "callers, callees and shared abstractions".
- **GraphCoder** retrieves through a statement-level control- and data-dependence graph (+6.06 exact match) [19a].
- **CodeRAG** links requirements to code in a two-sided graph and adds agentic reasoning: +40.90 / +37.79 Pass@1 on DevEval with GPT-4o and Gemini-Pro, compared with no retrieval [19b].

**Products.**
- **Claude Code** pushes CLAUDE.md into the prompt up front and fetches everything else with glob and grep [1][2]. Searching is delegated to a read-only Explore subagent, so its output stays out of the main context [3].
- **Cursor** trains its own embedding model on relevance labels taken from agent traces and offers it alongside grep. It reports +12.5% accuracy (6.5–23.5% depending on the model) [10].
- **Windsurf / Cognition** built SWE-grep, a retrieval subagent trained with reinforcement learning. It makes 8 parallel calls per turn for 4 turns and is about 20× faster than frontier models at similar retrieval quality. Their motivation: more than 60% of an agent's first turn went on retrieval [11].
- **Augment** offers its "Context Engine" as an MCP server. It claims +70–80% across agents and 51.8% on SWE-bench Pro [12]. This is unverified and vendor-run.
- **Serena** is an MCP server backed by the language server, with tools such as `find_symbol` and `find_referencing_symbols`. There is no independent benchmark [12b].
- **Codebase-Memory** is an MCP server built on a tree-sitter graph. It reached 83% answer quality against 92% for an agent exploring files directly, using 10× fewer tokens [12c].
- **CodeNib** builds text, embedding and SCIP views for each commit. Agents with it finished 78 of 90 runs against 65 without it, using 50–87% fewer tokens than grep and read [15].
- **Sourcegraph Cody / Amp:** I could not reach their sources, so I make no claims about them.

## Q2. Retrieval for review rather than generation

**Academic work.**
- **AACR-Bench** (Alibaba, 2026) has 200 PRs and 1,505 expert-verified comments. Each comment is tagged with the context it needed: the diff, the whole file, or the repo [20].
  - Non-agent reviewers did worse as the context level rose; agents showed the opposite trend.
  - Extra retrieval helped some models (BM25 for DeepSeek-V3.2, embeddings for Qwen-Coder-480B) and hurt Claude. The effect depends on the model.
  - Claude Code as a reviewer scored 39.9% precision and 10.1% recall.
- **SWR-Bench** (FSE 2026) has 1,000 PRs, half of them clean so that false positives can be measured. The best F1 was about 19%. Merging 10 runs raised F1 by up to 43.67% and recall by 118.83% [21].
- **RARe** uses retrieved past reviews as examples in the prompt. Retrieving only the top-1 example works best; adding more hurts through "redundancy and conflicting cues" [22].
- **c-CRAB** found that all review agents together solve about 40% of tasks [23].
- **OpenCodeReview** (Alibaba, August 2026) names two weaknesses of review agents: run-to-run variation, and a reviewer that effectively sees only the diff. Its fixes [24]:
  - fixed rules decide which files are reviewed and against which criteria;
  - a subagent per file uses six tools with capped output (for example, file_read ≤ 500 lines, code_search ≤ 100 matches);
  - a separate checker sees only the diff and tries to disprove each comment.
  - Result: SEM-F1 of 25.10% against 11.57% for Claude Code, both on Opus 4.6.

**Products.**
- **CodeRabbit** rebuilds a dependency graph for every review, because a pre-built index goes stale and "similarity search surfaces code that looks like the change while missing the code that structurally depends on it". It also uses past PRs, Jira tickets, "learnings" from comments people corrected, and linters [26]. This is the vendor's description; there is no ablation.
- **Greptile** reports an 82% catch rate on 50 bugs (July 2025) [26b]. The benchmark is vendor-run, and other sources report many more false positives.
- **Qodo** built code RAG for Qodo Merge in 2025, then "took most of it out" in 2.4: *"Retrieval is the wrong tool for finding code an agent can fetch itself, and the right tool for remembering things an agent has no way to rediscover."* It now keeps a memory of PR history and review decisions [25].
- **Copilot code review** uses agentic tool calling to gather code, directory structure and references, and runs ESLint and CodeQL alongside. It was in preview from October 2025 and generally available from March 2026 [28]. A GitHub post titled "Better tools made Copilot code review worse" exists, but I could not read it.
- **Anthropic Code Review** (March 2026) runs parallel agents that find, verify and then rank issues. Fewer than 1% of findings are marked incorrect, and 54% of PRs now get substantive comments, against 16% before [27].

**Bottom line.** The evidence that verification and aggregation improve review is stronger than the evidence that more repository context does.

## Q3. Push versus pull

**Anthropic's guidance** [2]:
- Aim for "the smallest possible set of high-signal tokens".
- Just-in-time agents "maintain lightweight identifiers (file paths, stored queries, web links, etc.)" and load the content when needed.
- A hybrid is best: "CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep" handle navigation.
- Subagents return condensed summaries, "often 1,000-2,000 tokens".

Related guidance:
- Claude Code caps a tool response at 25,000 tokens by default. Tools should page results and can offer a `response_format` option of concise or detailed [4].
- Loading tool definitions only when needed cut one example from 150k to 2k tokens [4b].
- In Anthropic's multi-agent research system, separate context windows act as compression, token usage explained 80% of performance variance, and the cost is about 15× the tokens of a chat [3b].

**When a small pushed dossier wins:**
- with weaker or non-agentic models (AACR-Bench [20]);
- for facts the repo cannot reveal, such as PR history and team conventions [25];
- when fixed scoping removes run-to-run variation [24];
- when it is tiny, ranked and points to code rather than pasting it. Top-1 beats top-k [22], and granularity and ordering matter more than volume [33];
- when the system can decide not to retrieve at all, as Repoformer learned to [35].

## Q4. Graph representations

**What the strong systems used:**
- def/ref edges (Aider, RepoGraph);
- contain, import, invoke and inherit edges (LocAgent);
- control- and data-dependence (GraphCoder, completion only);
- ranking by reachability (Code Isn't Memory);
- SCIP symbol graphs (CodeNib).

**Gaps.** None of the top agent systems I found uses a full code property graph. I found no 2024–26 ablation of co-change graphs for LLM agents; products approximate them with past-PR retrieval.

**How the graph is built.** Graphs built from the syntax tree beat graphs extracted by an LLM on correctness and coverage: 0.90 against 0.64 chunk coverage, built in seconds rather than hundreds of seconds [16].

**How it is ranked:**
- PageRank personalised towards the working set [5];
- k-hop neighbourhoods [6];
- agent-driven traversal [8];
- a text-search hit first, then a filtered neighbourhood (+13.9 Acc@5 on LocBench) [14];
- hybrid BM25 + embeddings [15];
- LLM relevance labels distilled into embeddings [10].

## Q5. Long context versus retrieval in 2026

- **Recall has improved.** On the MRCR v2 8-needle test at 1M tokens, Opus 4.6 scores 76% against 18.5% for Sonnet 4.5 [32].
- **Reasoning still degrades with length:**
  - With perfect retrieval, and even with the extra text replaced by whitespace, accuracy still drops. For example, Llama-3.1-8B lost 24.2% on MMLU at 30K tokens [30].
  - All 18 models in Chroma's study degraded, and distractors made it worse [29].
  - Models attend least to the middle of the input, a U-shaped curve ("lost in the middle") [31b].
  - On LongCodeBench, issue resolution fell from 29% to 3% between 32K and 256K tokens (Claude 3.5 Sonnet) [31].
  - LoCoBench-Agent found agents hold up well as length grows, but more exploration costs efficiency [31c].
- **No head-to-head study.** I found no independent 2026 study showing that "load the whole repo" beats agentic retrieval on SWE-bench-type tasks.

Treat 1M tokens as spare capacity, not as a strategy.

## Q6. Failure modes and mitigations

- **Stale index.** Retrieving only stale snippets made models reference outdated helpers in 15/17 and 13/17 cases. Adding current evidence largely fixed it [34].
  - Mitigations: use no index (Claude Code [1]), rebuild per review (CodeRabbit [26]), or update incrementally per commit (CodeNib [15]).
- **Embedding drift and wrong lookalikes.** Similarity search misses code that depends structurally on the change [26]. Retrieval using embeddings alone hallucinated most on architectural questions [16].
  - Mitigation: look up by text and graph structure first.
- **Over-retrieval** [20][22][30].
  - Mitigations: hard caps, top-1, and summaries from subagents.
- **Anchoring on the wrong abstraction.** Conflicting retrieved examples confuse the model [22], and models follow whatever helpers are retrieved [34].
  - Mitigation: show candidates with where they came from, and make the agent justify its choice.
- **Copying creates duplication** [36][37].
  - Mitigation: frame retrieved code as "call or extend this", and add a duplicate-code check.
- **Reviewer variance** [24].
  - Mitigations: aggregate runs [21] and add a verification step [27].
- **Graph incompleteness.** LLM-built graphs skip files [16]. The language server's go-to-declaration fails for external dependencies [12b].

## Comparison table

| System | Retrieval unit | Index | Ranking | Push or pull | Reported gain (quality of source) |
|---|---|---|---|---|---|
| Aider repo map [5] | Symbol signatures | tree-sitter def/ref file graph | Personalised PageRank | Push | None published |
| RepoGraph [6] | Lines / k-hop neighbourhood | Line-level def/ref graph | k-hop around search term | Both | +32.8% mean relative, SWE-bench Lite (peer-reviewed) |
| LocAgent [8] | Directory, file, class, function | Multi-type graph + BM25 | Agent multi-hop traversal | Pull | 92.7% file-level; +12% Pass@10 (peer-reviewed) |
| AutoCodeRover [9] | Class or method | AST | Agent queries + fault localisation | Pull | 46.2% SWE-bench Verified (public leaderboard) |
| Agentless [9b] | File → function → line | Repo skeleton + embeddings | LLM narrows down step by step | Push (fixed pipeline) | 32% SWE-bench Lite at $0.70 (peer-reviewed) |
| Claude Code [1][2] | File or line range | None | Model-driven grep/glob | Pull (+ CLAUDE.md pushed) | "Outperformed by a lot" (no published numbers) |
| Cursor [10] | Chunks | Custom embeddings + grep | Embeddings trained on agent traces | Pull | +12.5% accuracy; +2.6% retention (vendor) |
| SWE-grep [11] | Files and line ranges | None | Search policy learned by RL | Pull (subagent) | ~20× faster at similar recall (vendor) |
| Augment Context Engine [12] | Chunks | Proprietary semantic index | Proprietary | Pull (MCP) | +70–80%; 51.8% SWE-bench Pro (vendor, unverified) |
| Code Isn't Memory [13] | Paths and symbols | Structural index | Reachability | Pull | acc@5 44→85%; resolve 42→50% (preprint) |
| CodeNib [15] | Source ranges | BM25 + embeddings + SCIP, per commit | Hybrid | Pull (MCP) | 78/90 vs 65 runs; 50–87% fewer tokens (preprint) |
| OpenCodeReview [24] | Files, one subagent each | Rules + six capped tools | Fixed rules | Push (scope) + pull | 2.17× SEM-F1 vs Claude Code (preprint) |

## Design principles for our harness

1. **Pull by default. Push only a small set of pointers (about 1–1.5k tokens) built deterministically, not code bodies.** Its job is to save the agent's first searches, not to replace them [2][20][25].
2. **Seed retrieval on the diff.** Run personalised PageRank, or k-hop expansion, over a def/ref, import and call graph, starting from the changed symbols [5][6][13].
3. **Build the graph deterministically from the TypeScript compiler, a language server or tree-sitter, and rebuild it from HEAD for every run.** Never build it with an LLM, and never trust a cached embedding index for code [16][26][34].
4. **Expose the neighbourhood as a few tools with capped output** (callers, similar code, co-changed files, existing helpers), each with a concise or detailed mode [4][24].
5. **For "similar code", combine text search, embeddings and graph structure,** starting from a text-search hit [10][14][15].
6. **Rank hard and keep only the top few results, most relevant first.** More context measurably hurts [22][30][31b].
7. **Explore in isolated subagents that return summaries of 2k tokens or less, with file:line citations** [2][3].
8. **For reviewers: fixed dispatch of which files and rules apply, an agent per file or module, and a separate checker that sees only the diff plus cited evidence** [24][27].
9. **Run reviewers more than once, and keep findings that are confirmed across runs** [21].
10. **Present retrieved code as an existing abstraction the new code must call or extend, not as an example to imitate.** Back this with a duplicate-code gate [36][37]. The specific clone detector is my suggestion, not tested in the sources.
11. **Use retrieval or memory only for knowledge the repo cannot provide:** past review decisions and conventions such as ADRs [25][26].
12. **Do not rely on 1M-token windows. Build a small internal eval of past diffs with known duplicates and couplings, and measure each change against it** [10][13][31].

## Unverified or flagged claims

- These are vendor-run with unknown methodology: Augment's +70–80% and 51.8%, Greptile's 82%, SWE-grep's 20×, Cursor's +12.5%.
- Boris Cherny's "by a lot" comes from an X post, with no published numbers.
- Aider's repo map has no published ablation.
- I could not verify CodexGraph's numbers, Moatless results, or anything about Sourcegraph Cody/Amp.
- I know only the title of the GitHub "Better tools made Copilot code review worse" post.
- The Qodo 2.4 date is approximate (2026).
- The Opus 4.6 MRCR figure is Anthropic's own.
- The 2026 arXiv preprints [13][14][15][16][24][34][36] are not yet peer-reviewed.

## References

1. Boris Cherny (Anthropic), X post, 2026. https://x.com/bcherny/status/2017824286489383315
2. Rajasekaran et al., Anthropic, "Effective context engineering for AI agents", September 2025. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
3. Anthropic, Claude Code subagents documentation (Explore subagent), 2026. https://code.claude.com/docs/en/sub-agents
   - 3b. Hadfield et al., Anthropic, "How we built our multi-agent research system", June 2025. https://www.anthropic.com/engineering/multi-agent-research-system
4. Aizawa, Anthropic, "Writing effective tools for agents", September 2025. https://www.anthropic.com/engineering/writing-tools-for-agents
   - 4b. Jones and Kelly, Anthropic, "Code execution with MCP", November 2025. https://www.anthropic.com/engineering/code-execution-with-mcp
5. Gauthier (Aider), 2023: https://aider.chat/2023/10/22/repomap.html and the current code at https://github.com/Aider-AI/aider/blob/main/aider/repomap.py
6. Ouyang et al., RepoGraph, ICLR 2025. https://arxiv.org/abs/2410.14684
7. Liu et al., CodexGraph, NAACL 2025. https://arxiv.org/abs/2408.03910
8. Chen et al. (Gerstein Lab), LocAgent, ACL 2025. https://github.com/gersteinlab/LocAgent
9. AutoCodeRover (NUS), 2024. https://github.com/AutoCodeRoverSG/auto-code-rover
   - 9b. Xia et al., Agentless, FSE 2025. https://arxiv.org/abs/2407.01489
   - 9c. SWE-agent team, mini-swe-agent, 2025. https://github.com/SWE-agent/mini-swe-agent
10. Cursor, "Improving agent with semantic search", November 2025. https://cursor.com/blog/semsearch
11. Cognition, "SWE-grep", October 2025. https://cognition.com/blog/swe-grep
12. Augment, Context Engine MCP, February 2026. https://www.augmentcode.com/blog/context-engine-mcp-now-live
    - 12b. Oraios, Serena. https://github.com/oraios/serena
    - 12c. Vogel et al., Codebase-Memory, 2026. https://arxiv.org/abs/2603.27277
13. Bhola et al., "Code Isn't Memory", 2026. https://arxiv.org/abs/2606.22417
14. Hu et al., LARGER, 2026. https://arxiv.org/abs/2605.16352
15. CodeNib, 2026. https://arxiv.org/abs/2607.25431
16. "Reliable Graph-RAG for Codebases", 2026. https://arxiv.org/abs/2601.08773
17. Zhang et al., RepoCoder, EMNLP 2023. https://aclanthology.org/2023.emnlp-main.151/
18. RepoFuse (Ant Group / CodeFuse), 2024. https://arxiv.org/abs/2402.14323
19. Code-completion and generation retrieval:
    - 19a. Liu et al., GraphCoder, ASE 2024. https://dl.acm.org/doi/10.1145/3691620.3695054
    - 19b. CodeRAG, 2025. https://arxiv.org/abs/2504.10046
20. Zhang et al. (Alibaba), AACR-Bench, 2026. https://arxiv.org/abs/2601.19494
21. SWR-Bench (Peking University), FSE 2026. https://arxiv.org/abs/2509.01494
22. Meng et al., "When More Retrieval Hurts" (RARe), 2025. https://arxiv.org/abs/2511.05302
23. Zhang et al. (NUS), c-CRAB, 2026. https://arxiv.org/abs/2603.23448
24. Alibaba, OpenCodeReview, 2026. https://arxiv.org/abs/2608.09290 and https://github.com/alibaba/open-code-review
25. Qodo, "We built a state-of-the-art RAG system for code review. In Qodo 2.4, we took most of it out", 2026. https://www.qodo.ai/blog/we-built-a-state-of-the-art-rag-system-for-code-review-in-qodo-2-4-we-took-most-of-it-out/
26. CodeRabbit, 2025. https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews
    - 26b. Greptile, benchmarks, 2025. https://www.greptile.com/benchmarks
27. Anthropic, Code Review, March 2026. https://claude.com/blog/code-review
28. GitHub changelogs, October 2025 and March 2026:
    - https://github.blog/changelog/2025-10-28-new-public-preview-features-in-copilot-code-review-ai-reviews-that-see-the-full-picture/
    - https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/
29. Hong, Troynikov and Huber (Chroma), "Context Rot", July 2025. https://www.trychroma.com/research/context-rot
30. Du et al., "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval", EMNLP Findings 2025. https://arxiv.org/abs/2510.05381
31. LongCodeBench, 2025. https://arxiv.org/abs/2505.07897
    - 31b. Liu et al., "Lost in the Middle", TACL 2024. https://arxiv.org/abs/2307.03172
    - 31c. Salesforce AI Research, LoCoBench-Agent, 2025. https://arxiv.org/abs/2511.13998
32. Anthropic, Claude Opus 4.6 announcement, February 2026. https://www.anthropic.com/news/claude-opus-4-6
33. "Beyond More Context", 2025. https://arxiv.org/abs/2510.06606
34. Weng et al., "When Retrieval Hurts Code Completion: A Diagnostic Study of Stale Repository Context", 2026. https://arxiv.org/abs/2605.14478
35. Wu et al., Repoformer, ICML 2024. https://arxiv.org/abs/2403.10059
36. SlopCodeBench, 2026. https://arxiv.org/abs/2603.24755
37. GitClear, AI code quality research, 2025. https://www.gitclear.com/ai_assistant_code_quality_2025_research