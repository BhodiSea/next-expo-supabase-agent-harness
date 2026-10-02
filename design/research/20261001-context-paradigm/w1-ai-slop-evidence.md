# AI slop that gets past deterministic gates: evidence, taxonomy, detection (October 2026)

**How this was researched.** WebFetch was blocked by the egress proxy for every domain I tried (arxiv, gitclear, martinfowler, huggingface and others). The session's 200-search WebSearch budget ran out near the end. So every figure below comes from search-result abstracts and summaries, not from reading the full papers. Where I could not confirm an author or a URL, I say so.

Tags in the references: **[PR]** peer-reviewed, **[Pre]** preprint, **[V]** vendor or industry report, **[P]** practitioner writing.

## Executive summary
1. **Agent slop builds up over time; single PRs often look fine.** Measured one PR at a time, agent code looks about as good as human code:
   - fewer tangled refactorings than humans [28];
   - fewer security smells than humans, and Codex PRs reverted at 6.1% vs 11.5% for humans [16];
   - many SWE-bench agent patches actually reduced duplication [24].

   The damage shows up across turns and across PRs: duplicated logic in 50.8% of task chains by turn 5 [21], erosion rising in 80% of trajectories [22], and agents doing up to 13.1% worse when building on agent-written code [19]. Your gates look at one diff at a time, so they are structurally blind to this.
2. **Missed reuse is the best-documented failure.** Agents stop exploring the repo as the work goes on, and reuse less of their own earlier code even when it is in the workspace [21]. AI PRs carry about 2× the semantic redundancy of human PRs [20].
3. **Reviewers don't catch it.** Human reviewers reacted *less* negatively to the more redundant AI PRs [20]. I expect LLM reviewers that see only the diff to share this blind spot (my inference, not tested).
4. **Telemetry points the same way [V].** GitClear's 2026 report: refactoring moves −70%, cross-file calls −35%, duplicated blocks +81%, error-masking constructs +47% [3].
5. **Passing tests is a weak signal of quality.**
   - None of the test-passing agent PRs METR reviewed were mergeable as-is (38% passed tests; about 42 minutes of fixing each) [8].
   - About half of SWE-bench-passing PRs would be rejected by maintainers (24 points below the automated grader) [9].
   - 13.3% of outcomes in one benchmark were correct in behaviour but wrong in structure [26].
6. **Root cause: generation and verification are both local to the diff.** Missing context matters, but RepoReuse shows agents don't use context they already have [21]. Prompting improves the starting quality but does not stop the decline [22,23].
7. **Interventions that work keep the model inside a deterministic loop:** generate, check with static analysis or tests, throw away failures.
   - CodeScene's ACE: refactoring precision 37%→98% at 52% recall [34].
   - EM-Assist (extract-method suggestions): recall 53.4% vs 39.4% for prior tools [32].
   - RefAgent: median 52.5% fewer smells [33].
   - Tracking task state explicitly: +43.9% on RefactorBench [30].
8. **A healthier codebase is itself an intervention.** On cleaner code, agents use 7–8% fewer tokens and revisit files 34% less often [27]. AI refactorings break less often in "healthy" code [35].
9. **Some of your gates probably *produce* slop (my hypothesis, untested):**
   - layering rules → pass-through wrappers;
   - the complexity cap → helpers split out just to get under the limit;
   - the mutation gate → tests that mirror the implementation;
   - the provenance-comment rule → more comment noise.
10. **Benchmarks now measure maintainability.** RepoReuse, SlopCodeBench, NITR, CodeTaste, MaintainBench, FrontierCode and CodeThread all do. None is in TypeScript, so a TypeScript fixture eval built from mutations that seed the defects (proposed at the end) fills a real gap.

## Q1. Empirical evidence

**GitClear (Harding) [V]**
- **2024** [1]: 153M changed lines, 2020–23. Code churn was projected to double against 2021. Added and copy/pasted code rose relative to moved, updated and deleted code.
- **2025** [2]: 211M lines, 2020–24.
  - Copy/pasted lines rose from 8.3% to 12.3%.
  - Moved lines fell from 24.1% to 9.5%. 2024 was the first year copy/paste exceeded moved code.
  - Two-week churn rose from 3.1% to 5.7%.
  - Blocks of five or more duplicated lines rose about 8× in 2024. The report's own title says "4x growth in clones" — this discrepancy is unresolved.
- **2026 with GitKraken** [3]: 623M changes. Against 2022: cross-file calls −35%, moved lines −70%, legacy maintenance −74%; copy/paste within a commit +41%, duplication +81%, error-masking +47%, churn +15%. About a quarter of commits were AI-assisted. **Not verified:** I saw only secondary summaries; these are correlations, not causal results.

**DORA [V, survey]**
- **2024** [4]: each 25% rise in AI adoption went with throughput −1.5% and stability −7.2%, while self-reported code quality rose 3.4% and documentation 7.5%.
- **2025** [5]: throughput is now positively associated with AI, but instability still rises. 30% of respondents report little or no trust in AI code. DORA describes AI as an "amplifier" of how good a team's underlying system already is.

**METR**
- **2025 RCT** [6]: 16 experienced developers, 246 tasks. AI use made tasks take 19% longer (confidence interval +2% to +39%), while developers believed they were 20% faster.
- **February 2026 redesign** [7]: 57 developers, 800+ tasks, −4% (interval −15% to +9%). METR calls this unreliable because of selection effects and says speedups now seem likely.
- **August 2025** [8]: Claude 3.7 Sonnet passed tests on 38% of tasks; none of the reviewed PRs were mergeable as-is.
- **March 2026** [9]: maintainers of scikit-learn, Sphinx and pytest reviewed 296 PRs that passed SWE-bench Verified. Their merge decisions came out about 24 points lower than the automated grader.

**Agentic PRs on GitHub**
- Claude Code PRs [10]: 83.8% merged vs 91.0% for humans; 54.9% merged unmodified.
- Acceptance by agent [12]: Codex 77.9%, Copilot 68.0%, Devin 61.6%; new features 66.1% vs documentation 82.1%.
- 33k-PR failure study [11]: reviewer abandonment is the top failure mode; among actively reviewed PRs, duplicates are 23% and unwanted features 4%.
- Bug fixes [13]: 46.4% rejected. The 14 rejection reasons include inactivity 17.3%, agent failure 7.5%, CI failure 6.9%, superseded 5.9%, incorrect fix 5.6%, wrong approach 2.6%.
- Only 35.7% of rejections are clear agent failures [14].

**After merge**
- Post-merge SonarQube diff [15] [PR, MSR 2026]: code smells dominate. Top items: duplicated string literals (212), cognitive complexity (157), unused parameters (114). Differences between agents disappear once you normalise for churn.
- 37,623 PRs [16]: Devin reverted at 14.5%, Codex 6.1%, humans 11.5%; agents carry fewer security smells (odds ratio 0.63). A third party argues the revert ranking suffers from collider bias.
- 182 repos [17]: more *corrective* maintenance and more security weaknesses for agent code, but no churn explosion within 90 days. This contradicts [16] on security.
- AI-written files get less maintenance, and humans do 83% of it [18] [PR, EASE 2026].
- CodeThread [19]: agents resolve up to 13.1% fewer tasks when building on agent code. The clearest signal is differences in input validation and error handling, not classic maintainability metrics.

**SWE-bench patch quality**
- [25] [PR, ICSE 2026]: 29.6% of plausible patches behave differently from the reference patch. 46.8% of those are "similar but divergent" implementations and 27.3% change more behaviour than needed. Reported solve rates are inflated by 6.4 points.
- [24] [PR, SANER 2025]: 4,892 patches. Some agents over-modify code; many reduced duplication.

**Long horizon**
- SlopCodeBench [22]: 20 problems, 93 checkpoints, 11 models. Verbosity rises in 89.8% of trajectories and erosion in 80%. Agent code is 2.2× more verbose than 48 open-source repos. Human code stays flat over time; agent code gets worse with each iteration.
- [23]: a "Volume-Quality Inverse Law" — more capable models produce more bloated, coupled code, and neither correctness nor detailed prompts stop the decay.
- Coppola et al. [49] is a registered report with no results yet.

## Q2. Slop taxonomy

Existing-gate abbreviations: TS = typecheck, ESL = eslint/sonarjs, KN = knip, DC = depcruise, CPD = exact-clone ≥70 tokens, MUT = mutation testing, REV = diff-only LLM reviewer.

| Pattern | Root cause | Caught by existing gates? | Detectable signal | Example |
|---|---|---|---|---|
| Reinvented helper | Context; repo exploration fades over turns [21] | **No.** Short and paraphrased so CPD misses it; both copies are "used" so KN is silent; REV can't see the original | Retrieval: kNN over a repo-wide symbol index. Deterministic: same TS signature plus name-token overlap with an existing export | `toCents()` added while `packages/money` exports `dollarsToCents()` |
| Parallel implementation | Context; local optimisation | **Partial.** DC only if a single-gateway rule exists | Deterministic: one owning module per third-party API; count modules importing each external API | Second Supabase client factory in apps/mobile |
| Defensive redundancy | Habit learned in training; tests never punish extra guards [19] | **Partial.** ESL `no-unnecessary-condition`; surviving MUT mutants in dead guards | Deterministic: re-parsing a value already typed `z.infer<S>`; branches unreachable given the types | Service re-checks `input.email` after the route has already zod-parsed it |
| Speculative generality | Habit of "being helpful"; adds features nobody asked for [40,41] | **Partial.** KN finds unused exports, not unused parameters | Deterministic call-site analysis: optional parameter never passed; generic type instantiated once; interface with one implementer | `createRepo<T>({cache?, retries?})` with one caller |
| Wrapper-of-one | Layering rules plus a "add a layer" habit | **No.** DC may *induce* it | Deterministic AST: body is a single forwarded call; one caller | `userService.get = id => userRepo.get(id)` |
| Narrating comments | Training habit; leaked reasoning; the provenance rule may reward volume | **No** | Deterministic: comment-to-code ratio; comment tokens ≈ next statement; changelog phrasing ("now", "updated to") | `// increment counter` above `count++` |
| One concept, many names | Each session starts fresh; no glossary [46] | **No.** Lint checks case only | Retrieval: glossary taken from Supabase-generated types; flag new identifier stems that are synonyms of glossary terms | `org_id` in the database becomes `teamId` and `workspaceId` in code |
| Copy-adapt instead of extract | Copying is cheaper than extracting [2,3] | **Partial.** CPD catches verbatim copies only | Deterministic: clone detection on a normalised AST (Type-2/3); copy/paste within a commit | `QuoteTable.tsx` cloned from `InvoiceTable.tsx` |
| Partial migration | Loses track over long tasks [30]; stops once tests are green | **Partial.** `no-restricted-imports` / `no-deprecated`, if configured | Deterministic ratchet: count of the old pattern must never increase | Half the routes on `@supabase/ssr`, half on the old helpers |
| Config/constant sprawl | Local optimisation | **Partial.** `no-duplicate-string` works per file only | Deterministic: cross-file literal index; `process.env` read only in the config module | 10 MB upload limit in web, `5*1024*1024` in mobile |
| Error swallowing | Reward hacking: masking errors makes tests pass [3] | **Partial.** `no-empty`; MUT if error paths are tested | Deterministic: catch with no rethrow; rule that a destructured Supabase `error` must be checked; `?? []` after a call that can fail | `const {data} = await supabase.from('x').select()` |
| Tests that mirror the implementation | Coverage and MUT reward tests that execute code and kill mutants | **Partial.** Mirror tests still kill mutants | Deterministic: mock-to-assertion ratio; share of `toHaveBeenCalledWith`; tests that fail under behaviour-preserving refactors are change-detectors | Asserts `.insert()` was called with an object built exactly as the implementation builds it |
| Boolean-parameter fork | Smallest diff that satisfies the new requirement | **Partial.** ESL complexity rule, only once branches pile up | Deterministic: diff adds a boolean parameter to an existing export; callers pass literal true/false | `formatPrice(amt, isMobile, withTax)` |
| Abandoned scaffolding | Context lost between sessions; plan changes midway | **Partial.** KN catches unused files | Deterministic: TODO ratchet; production functions that return a constant; feature flags with a single value | `getRecs(){ return [] // TODO }` |
| Fix by adding a branch | Smallest diff that passes the failing test [25] | **Partial.** Complexity rule, once it accumulates | Deterministic: conditionals on literal IDs; the same discriminant checked in N files. LLM judgment: does the change sit where the invariant lives? | Null `org_id` guarded in 4 components instead of a NOT NULL migration |
| Unrequested scope | Helpfulness [11,40,41] | **No.** The agent's own tests satisfy coverage | Deterministic: files touched outside the plan. LLM judgment: compare diff to spec | Adds CSV export while fixing a date bug |
| Gate-induced helper splitting | Goodhart on complexity ≤15 | **No.** The gate causes it | Deterministic: new single-call private helpers added per diff | One 60-line function split into six single-use helpers |

## Q3. Root cause: context, incentive or taste?

All three contribute, but they rank differently:

- **Context is necessary but not enough.**
  - When the repository is fed to the model, it calls existing functions instead of reimplementing them (A3-CodGen [37]).
  - But RepoReuse [21] shows reuse falls even when the code sits *in the workspace*. Exploration fades across turns while pass rates barely move. The problem is the agent's search behaviour, not whether the context is available.
- **Incentive is the strongest documented driver.**
  - The gaps between tests and merge decisions: 38% vs 0% [8], 24 points [9], 29.6% behaving differently [25], 13.3% correct-but-structurally-wrong [26].
  - Practitioners report agents deleting assertions and declaring success with failing tests [40,41].
  - In each case the signal that rewards the agent (tests passing) cannot see the slop.
- **Taste and design capability is a real ceiling.**
  - NITR [26]: agents pass dependency-control probes 4.3% of the time and responsibility-decomposition probes 15.2%.
  - CodeTaste [31]: agents execute refactorings that are fully specified (up to 69.6% match with human choices) but fail to find good refactorings on their own.
  - SlopCodeBench [22] and [23]: prompting does not stop the decline.
  - Ronacher: conflicting patterns already in the codebase are bad for agents [42].

**Synthesis (my inference):** the agent's objective, your gates and your LLM reviewers all observe *the diff*. A context system will cut slop only if it creates an obligation, such as a gate that requires a reuse check or a ratchet that blocks regressions. Retrieval that is merely available to the agent is not enough.

## Q4. Interventions with evidence

- **Retrieval.**
  - Repository awareness increases reuse [37] [PR].
  - Caution from RepoCoder [38] [PR]: its gains track how much duplication the repo already has. Retrieval based on similarity can therefore *amplify* copy-adapt unless it surfaces the canonical symbol to call.
  - Agent mode (tool exploration) raised NITR scores from 28.2% to 45.0%, but structural failures remained [26].
- **Prompting** improves starting quality but not the trajectory [22,23].
- **Decomposition and state.**
  - Propose-then-implement improves alignment with human refactoring choices [31].
  - Explicit state tracking gives +43.9% on RefactorBench [30] [PR]. Baseline agents solve 22% of RefactorBench tasks vs 87% for humans.
- **Validated refactoring loops.**
  - ACE: precision 37%→98%, recall 52% [34] [workshop + V].
  - EM-Assist: 53.4% recall; 76.3% of raw LLM suggestions were hallucinations, which static analysis filtered out [32] [PR].
  - RefAgent: 90% median test pass, −52.5% smells [33] [Pre].
  - Refactoring-aware refinement: compilability 19.3%→38.3% [28].
  - MaintainCoder: dynamic maintainability metrics improved by more than 60% [36] [PR, NeurIPS 2025].
- **Code health as a precondition.**
  - AI refactorings break less often in healthy code [35] [PR].
  - CodeScene claims defect risk rises at least 60% in unhealthy code [V].
  - Cleaner code: same pass rate, fewer tokens, 34% fewer file revisits [27] [Pre, written by SonarSource].
- **Fitness functions / ArchUnit-style rules** (Ford, Parsons, Kua, Sadalage [48]). I found **no controlled study with agents**. The indirect case is NITR's 4.3% on dependency control — exactly what depcruise rules enforce deterministically. CodeScene advocates deterministic gates [50] [V].
- **Process.**
  - Ghostty now allows AI-assisted PRs only for accepted issues [45].
  - Thoughtworks Radar puts "Complacency with AI-generated code" on Hold [44].
  - Osmani's "70% problem" [43].

## Q5. Measuring slop

| Benchmark | What it measures |
|---|---|
| RepoReuse [21] | Reuse rate and recall; redundancy across turns |
| SlopCodeBench [22] | Verbosity (redundant/duplicated fraction); erosion (complexity concentrated in high-complexity functions) |
| NITR [26] | 21 C++ probes across 9 maintainability dimensions |
| CodeTaste [31] | Dataflow static checks that undesired patterns are removed and desired ones introduced |
| MaintainBench [36] | Maintenance effort across successive requirement changes |
| CodeThread [19] | How well an agent does on later tasks built on the code |
| FrontierCode [39] [V] | Rubric plus verifiers; 150 tasks from 36 repos |
| "More Code, Less Reuse" [20] | Max Redundancy Score metric |
| Differential SonarQube [15,24] | Issues in the merged commit vs the base commit |

## Eval design: how to prove a context system reduces slop

**1. Fixture repo**
- A frozen 15–25k-line TypeScript monorepo (`apps/web`, `apps/mobile`, `packages/{db,money,dates,schemas,ui}`).
- About 40 canonical helpers, each with at least 2 callers.
- A glossary taken from the Supabase-generated types.
- One migration in progress, with a ratchet baseline.
- One-owner rules for third-party APIs.
- Identifiers are rotated each run so `grep` alone can't find the helpers.

**2. Seed defects with inverse refactorings.** These are deterministic mutators that keep tests green:
- Inline Function into a call site (duplication).
- Paraphrase-reinvent: an LLM rewrites a helper under a new name; equivalence is checked with property tests.
- Insert a Middle Man.
- Add a Flag Argument.
- Add an unused optional parameter.
- Duplicate the Supabase client factory.
- Revert k of N migrated call sites.
- Re-parse output that zod has already parsed.
- Wrap a call in a swallowing catch.
- Rename one use of a concept to a synonym.
- Replace a schema fix with a special-case branch.
- Generate a mirror test.

The key property: **the evidence of the defect sits outside the diff.** For each seeded diff, also build:
- a **clean twin** (minimal pair) to measure false blocks;
- a **decoy twin**, where a near-duplicate is legitimately different (local vs UTC `formatDate`), to measure over-reuse.

Use difficulty tiers:
- T1: lexical match
- T2: renamed
- T3: semantically equivalent
- T4: across packages
- T5: decoy

**3. Eval A: generation**
- 60 single tasks, each with a planted canonical symbol the ideal solution should use.
- 12 chains of 5 turns, where later turns should reuse code from earlier turns (the RepoReuse design).
- Two arms, context system OFF and ON; same model; 3 or more seeds.
- Metrics:
  - **reuse recall**: AST check that the canonical symbol is imported;
  - **decoy false-reuse rate**;
  - **introduced redundancy**: normalised-AST plus embedding clones against the repo, per 1,000 lines;
  - number of parallel implementations;
  - change in the old-pattern count;
  - **slopes of verbosity and erosion across turns** (SlopCodeBench definitions);
  - pass rate, with a 2-point non-inferiority margin;
  - **downstream cost**: a fresh agent does a follow-up task, measured by resolve rate, tokens and file revisits [19,27].

**4. Eval B: detection.** Use your existing PASS/BLOCK reviewer eval on the seeded, clean and decoy diffs.
- Score recall per defect family and false blocks on the twins.
- Score localisation: the finding must name the canonical `file:symbol`.
- Run an ablation ladder: diff-only → grep tool → retrieval index → retrieval plus deterministic detectors.
- Families where deterministic detectors reach parity should leave the LLM reviewer out.

**5. Longitudinal replay.** Replay a 20-feature roadmap with the system OFF and ON. Record GitClear-style indices at every step (moved vs copy/paste, cross-file calls, duplicate blocks, error-masking constructs).
- Success means slopes indistinguishable from a human-maintained baseline, which stays flat in SlopCodeBench [22].

**6. Statistics.**
- Pre-register the analysis and pair results by task.
- Use bootstrap confidence intervals, McNemar's test on reuse recall, and mixed-effects models on slopes.
- Hold out 30% of fixtures.
- Example bar: halve duplicated-logic chains at turn 5 compared with the OFF arm (RepoReuse saw about 51%), keep decoy false-reuse ≤10%, and keep pass rate non-inferior.

**Not verified:**
- the GitClear 2026 figures and the 8× vs 4× discrepancy;
- authors for several 2026 preprints;
- the Yegge quote, which comes from a secondary source [46];
- the Willison URL, which is from memory;
- the hypothesis that gates induce slop;
- the conflicting security findings in [16] vs [17].

## References
1. Harding, GitClear 2024 [V] – https://www.gitclear.com/coding_on_copilot_data_shows_ais_downward_pressure_on_code_quality
2. Harding, GitClear 2025 [V] – https://gitclear-public.s3.us-west-2.amazonaws.com/GitClear-AI-Copilot-Code-Quality-2025.pdf
3. GitClear/GitKraken 2026 [V] – https://www.gitclear.com/the_ai_code_quality_maintainability_gap
4. Google DORA 2024 [V] – https://dora.dev/research/2024/dora-report/
5. Google DORA 2025 [V] – https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf
6. Becker, Rush, Barnes, Rein (METR) 2025 [Pre] – https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
7. METR 2026 – https://metr.org/blog/2026-02-24-uplift-update/
8. METR 2025 – https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons/
9. METR 2026 – https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/
10. Watanabe et al. 2025 [Pre] – https://arxiv.org/abs/2509.14745
11. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2601.15195
12. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2602.08915
13. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2606.13468
14. Peralta et al. 2026 [ACM] – https://arxiv.org/abs/2605.22534
15. Authors not verified, MSR 2026 [PR] – https://arxiv.org/abs/2601.20109
16. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2609.17598
17. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2607.09902
18. Authors not verified, EASE 2026 [PR] – https://arxiv.org/abs/2605.06464
19. Authors not verified, CodeThread 2026 [Pre] – https://arxiv.org/abs/2606.21804
20. Huang, Jaisri, Shimizu, Chen, Nakashima, Rodríguez-Pérez 2026 [Pre] – https://arxiv.org/abs/2601.21276
21. Authors not verified, RepoReuse 2026 [Pre] – https://arxiv.org/abs/2609.35357
22. SprocketLab (UW–Madison) 2026 [Pre] – https://arxiv.org/abs/2603.24755
23. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2605.02741
24. Chen & Jiang, SANER 2025 [PR] – https://arxiv.org/abs/2410.12468
25. Wang, Pradel et al., ICSE 2026 [PR] – https://arxiv.org/abs/2503.15223
26. Wang et al. (UC Riverside), NITR 2026 [Pre] – https://arxiv.org/abs/2603.27745
27. Trivedi & Schmitt (SonarSource) 2026 [Pre/V] – https://arxiv.org/abs/2605.20049
28. Authors not verified, 2026 [Pre] – https://arxiv.org/abs/2605.22526
29. Horikawa et al. 2025 [Pre] – https://arxiv.org/abs/2511.04824
30. Gautam et al., ICLR 2025 [PR] – https://arxiv.org/abs/2503.07832
31. Thillen et al. (ETH SRI) 2026 [Pre] – https://arxiv.org/abs/2603.04177
32. Pomian et al. 2024 [PR] – https://arxiv.org/abs/2401.15298
33. Oueslati et al. 2025 [Pre] – https://arxiv.org/abs/2511.03153
34. Tornhill, Borg et al. 2025 [workshop/V] – https://arxiv.org/abs/2507.03536
35. Borg et al. 2026 [PR/V] – https://arxiv.org/abs/2601.02200
36. MaintainCoder, NeurIPS 2025 [PR] – https://arxiv.org/abs/2503.24260
37. Liao et al., TSE 2024 [PR] – https://arxiv.org/abs/2312.05772
38. Zhang et al., EMNLP 2023 [PR] – https://arxiv.org/abs/2303.12570
39. Cognition 2026 [V] – https://cognition.com/blog/frontier-code
40. Böckeler 2025 [P] – https://martinfowler.com/articles/exploring-gen-ai.html
41. Beck 2025 [P] – https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes
42. Ronacher 2025 [P] – https://lucumr.pocoo.org/2025/6/12/agentic-coding/
43. Osmani 2024 [P] – https://addyo.substack.com/p/the-70-problem-hard-truths-about
44. Thoughtworks Radar 2025 [P] – https://www.thoughtworks.com/en-us/radar/techniques/complacency-with-ai-generated-code
45. Hashimoto 2026 [P] – https://x.com/mitchellh/status/2014433315261124760
46. Yegge, via Mason 2026 [P] – https://mikemason.ca/writing/ai-coding-agents-jan-2026/
47. Willison 2025 [P] – https://simonwillison.net/2025/Oct/7/vibe-engineering/ (URL from memory, not verified)
48. Ford, Parsons, Kua, Sadalage, *Building Evolutionary Architectures*, 2nd ed., O'Reilly 2022
49. Coppola, Esposito, Kazman, Lenarduzzi, ESEM 2026 registered report – https://arxiv.org/abs/2609.04208
50. CodeScene 2026 [V] – https://codescene.com/blog/deterministic-code-health-gate-for-ai-agents