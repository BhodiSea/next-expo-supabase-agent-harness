# Deterministic design signals for diff-only reviewers (research, 2026-10-01)

**Verification caveat.** WebFetch was blocked for most academic hosts (arXiv, ACM, university sites, CodeScene docs), and the web-search budget ran out near the end. Figures marked † come from search-engine abstracts or secondary sources, not from the primary paper. I read code-maat's numbers directly from its source. No repository was modified.

## Executive summary
1. **How change coupling is computed.** It is association-rule mining over commits. Support is how many commits changed both files. Confidence is support(A∪B)/support(A) (the ROSE paper). Code-maat's "degree" is shared revisions ÷ the mean revisions of the two files. "Sum of coupling" adds up (commit size − 1) over every commit that touched a file.
2. **Young repos get nothing out of it.** Code-maat defaults to ≥5 revisions, ≥5 shared revisions and ≥30% degree. Older CodeScene docs give ≥10 revisions, ≥10 shared commits and ≥50%†. A young scaffolded repo passes none of these. What it does produce is noise from the scaffold commit, harness-upgrade commits and generated files.
3. **Use structural signals while history is thin.** Count the places that hold the same fact: the same literal, key set, union member or column name in N places. Add repeated edits inside one diff and the number of code sites keyed on each union. All of this comes from the AST in seconds. History then confirms these signals later; it cannot replace them, because only history shows coupling that the import graph lacks.
4. **Cheap, precise smells on TypeScript:** middle man and pass-through functions, an abstraction with only one consumer, data clumps, boolean selector parameters, near-duplicate branches, and fan-in as a blast-radius measure. **Noisy ones:** feature envy (JDeodorant reached at most 15% precision†), divergent change and primitive obsession.
5. **Ousterhout.** I found no peer-reviewed metric for his ideas. Two 2026 open-source efforts approximate "depth" as implementation per exported symbol: codeheat (a proposal, still open) and slopMochi (alpha). Use depth to rank modules, never to gate.
6. **Torvalds' "good taste" leaves fingerprints a checker can find:**
   - a guard that the general path already covers;
   - a branch for the first loop iteration;
   - checks on the same discriminant scattered across files;
   - one-line helpers that hide intent (the 2025 `make_u32_from_two_u16` rejection).
7. **Package metrics.** Per-package afferent/efferent coupling, instability and Stable-Dependencies violations are meaningful. Abstractness and distance from the main sequence are noise in TypeScript, because types are structural and erased. "Which consumers use which exports" measures cohesion better than LCOM.
8. **Aspect mining worked moderately.** Fan-in finds candidates that a person must confirm. History-based HAM averaged about 50% precision (over 90% in the top 10 on Eclipse)†. AST clone detectors found idiomatic checks and error handling well†. In practice the shared tool usually exists already, and the defect is code that bypasses it.
9. **Evidence on hints cuts both ways.** Delivering findings at diff time inside the workflow works: Infer saw a 70% fix rate at diff time and about 0% in batch. But automated reviews anchor human reviewers (more low-severity findings, no more high-severity ones). LLMs also change their verdict with prompt framing. LLM plus static tool beats either alone.
10. **Recommendation.** Write a neutral, capped "evidence packet" of facts and locations, never verdicts, to a file the reviewer reads. Have the reviewer do an independent pass first. Require a confirm or dismiss for each item, and log dismissals so noisy signals can be retired. Validate the whole thing with seeded design-smell canary diffs.

## Q1. Change coupling
**Algorithms.**
- **Gall, Hajek & Jazayeri (1998)** coined "logical coupling": modules that change in the same releases are coupled with no code dependency between them. https://doi.org/10.1109/ICSM.1998.738508 (DOI from memory, unverified)
- **Zimmermann, Weißgerber, Diehl & Zeller (2004), ROSE.** It mines rules over commits regrouped into transactions by a time window. After one change it predicted 26% of the further files to change (15% at function level). The top three suggestions held a correct location 64% of the time†. These results are on long, mature histories. https://thomas-zimmermann.com/publications/files/zimmermann-icse-2004.pdf
- **Code-maat (Tornhill), read from source.**
  - Degree = shared_revs / mean(revs_A, revs_B).
  - Sum of coupling = Σ(|commit| − 1).
  - Defaults: min-revs 5, min-shared-revs 5, min-coupling 30%, max-changeset-size 30.
  - `--temporal-period` merges one day's commits into a single change.
  - https://github.com/adamtornhill/code-maat
- **CodeScene** also couples files by the same author within a time window and by shared ticket ID. Older documentation gives defaults of 10 revisions, 10 shared commits and 50% strength†; current defaults are unverified. https://docs.enterprise.codescene.io/versions/3.4.0/guides/technical/temporal-coupling.html
- **Hotspot** = change frequency × complexity (Tornhill, *Software Design X-Rays*, 2018). https://pragprog.com/titles/atevol/software-design-x-rays/
- **HIST (Palomba et al. 2015)** detects divergent change, shotgun surgery and parallel inheritance from co-change, at 72–86% precision†. https://doi.org/10.1109/TSE.2014.2372760

**How much history, and young repos.** Every threshold above assumes ≥5–10 revisions per file. An agent-built repo with about 100 squash-merged PRs has most files at 1–3 revisions. Adjustments (the last two are my suggestions, not from the literature):
- Treat each PR as one transaction.
- Drop transactions over 30 files: the scaffold commit and harness-upgrade/template-sync commits.
- Exclude generated files (Supabase type mirror, lockfile, inventories).
- Weight each pair by 1/(|T| − 1), so large agent PRs do not inflate coupling.
- Rank by the Wilson lower bound of confidence, so 2-of-2 ranks below 9-of-10.

**Can structural co-change replace history?** Only partly. It works as a forward predictor. History is still needed for "unnamed" coupling. Wong, Cai, Kim & Dalton (2011, Clio) found the interesting cases are exactly where co-change and structure disagree. https://web.cs.ucla.edu/~miryung/Publications/icse11-modularityviolation.pdf

Supporting work for structural predictors:
- Clones and change couplings are related (Geiger et al. 2006). https://link.springer.com/chapter/10.1007/11693017_31
- Tools exist that find the same edit applied in N places inside one change: LSdiff (Kim & Notkin 2009) and LASE (Meng, Kim & McKinley 2013). https://web.cs.ucla.edu/~miryung/publications.html
- TARMAQ handles change-sets never seen before (Rolfsnes et al. 2016). https://www.researchgate.net/publication/293636225

## Q2. Smells mapped to the rubric
**Detection literature.**
- **Lanza & Marinescu (2006)** (https://www.researchgate.net/publication/220692125). Thresholds below via https://simpleorientedarchitecture.com/identify-shotgun-surgery-using-ndepend/
  - Shotgun Surgery = CM > 7 ∧ CC > Many (distinct calling methods and classes).
  - Feature Envy = ATFD > Few ∧ LAA < ⅓ ∧ FDP ≤ Few.
- **DECOR (Moha et al. 2010):** 100% recall, 41–87% precision†. https://www.semanticscholar.org/paper/f5ff5578727727a32deeaa990607818a14f74172
- **JDeodorant (Tsantalis & Chatzigeorgiou 2009):** an independent benchmark measured at most 15% precision and at most 40% median recall for Move Method / Feature Envy† (Kurbatova et al. 2020). https://arxiv.org/abs/2002.06392
- **Designite (Sharma):** its modularization smells map best to our rubric — Unutilized Abstraction, Broken, Insufficient and Hub-like Modularization. https://tusharma.in/smells/DESIGNITEJAVA.html

**JavaScript, React and TypeScript.**
- **JSNose:** 93% precision and 98% recall on 13 smells† (Fard & Mesbah 2013). https://people.ece.ubc.ca/amesbah/resources/papers/scam13.pdf
- **React catalogue of 12 smells:** its tool, ReactSniffer, cannot detect Prop Drilling, Duplicated Component or Low Cohesion (Ferreira & Valente 2023). https://homepages.dcc.ufmg.br/~mtov/pub/2023-ist-react.pdf
- **SniffTSX (2025):** covers Any Type, Multiple Booleans for State and Non-Null Assertion; precision 0.98, recall 0.93†. https://doi.org/10.1016/j.infsof.2025.107835
- **Angular catalogue (2026)†:** https://arxiv.org/abs/2604.27893

**Perception and LLMs.**
- Developers recognise smells inside one class more readily than smells that span classes (Palomba et al. 2014). https://people.lu.usi.ch/bavotg/papers/icsme2014_smells.pdf
- LLMs handle structurally simple smells well and context-dependent ones poorly. LLM-plus-tool voting won on 5 of 9 smells† (2026, TSE). https://arxiv.org/abs/2601.09873

**What is feasible on TypeScript with ts-morph or the compiler API.**
- **High precision:**
  - middle man: delegating functions ≥ half of all functions (the Smell-ML rule†);
  - pass-through functions;
  - speculative generality, measured as "one importer";
  - data clumps;
  - boolean selector parameters;
  - duplicate branches;
  - fan-in.
- **Medium:**
  - parallel inheritance, which in TypeScript becomes "parallel registries" keyed by one union;
  - inappropriate intimacy, as two-way imports or co-change without imports;
  - lazy class.
- **Low:** feature envy, divergent change (needs history; consumer cohesion is the structural proxy) and primitive obsession (useful only for `*Id` strings).

## Q3. Ousterhout
I found no peer-reviewed metric for these ideas; treat that as a gap, since my search was cut short. Ousterhout himself describes depth and "conjoined" methods in cognitive terms, not as a number (Ousterhout–Martin debate, 2024–25: https://github.com/johnousterhout/aposd-vs-clean-code).

Open-source approximations:
- **codeheat #18:** implementation lines per exported symbol, via the TypeScript compiler API. Still open as of 2026-09-30. Its #16 compares interface churn with implementation churn. https://github.com/rexeus/codeheat/issues/18
- **slopMochi (alpha):** SHALLOW = round(100·B/(B+2H)), where B is caller burden and H is hidden responsibility. https://github.com/blater/slopMochi

Deterministic proxies we could build:

| Concept | Proxy |
|---|---|
| Depth | Σ cognitive complexity ÷ interface surface (exports + parameters + type members) |
| Pass-through method | Body is a single forwarding call |
| Pass-through variable | A parameter used only as a same-named argument |
| Conjoined methods | Private function with one adjacent caller that takes ≥3 of that caller's locals |
| Information leakage | The same literal, key set or format knowledge in ≥2 modules |
| "Different layer, different abstraction" | Identical parameter and return signature across a call edge between packages |
| "Define errors out of existence" | Throw sites and catch-and-map blocks per exported API |

Temporal decomposition has no reliable fingerprint; leave it to the LLM.

## Q4. Torvalds
**Primary sources.**
- **TED interview, 2016 (about 14:10):** the linked-list removal, "rewrite it so that a special case goes away and becomes the normal case". Transcript: https://singjupost.com/linus-torvalds-the-mind-behind-linux-at-ted-full-transcript/ ; code: https://github.com/mkirchner/linked-list-good-taste
- **Git mailing list, 27 Jul 2006:** "Bad programmers worry about the code. Good programmers worry about data structures and their relationships." https://lwn.net/Articles/193244/
- **Over-abstraction, 2007, on C++:** "inefficient abstracted programming models where two years down the road you notice that some abstraction wasn't very efficient, but now all your code depends on" it. https://lwn.net/Articles/249460/
- **Over-abstraction, 2025:** rejected `make_u32_from_two_u16()`, writing "if you write the code out as (a << 16) + b, you know what it does". The Register, 2025-08-11: https://www.theregister.com/software/2025/08/11/torvalds-blasts-kernel-dev-for-late-garbage-risc-v-patches/1405573
- **Kernel coding style on typedefs:** https://www.kernel.org/doc/html/latest/process/coding-style.html

**Checkable heuristics.**
1. **Redundant guard.** `if (!xs?.length) return []` placed before a map, filter, for-of or seeded reduce that already returns the same empty value. Confirm it with your mutation tool: deleting the guard leaves a surviving mutant even though the guard is covered.
2. **First-iteration branch.** `i === 0`, `isFirst` or `prev == null` inside a loop, or a copy of the loop body placed before the loop.
3. **Discriminant scatter.** The same union's tag is checked in ≥2 files.
4. **Boolean selector parameter.**
5. **Intent-hiding helper.** A single expression, ≤2 call sites, and a name longer than the body.
6. **Branches instead of data.** A diff that adds N branches on one field instead of adding a type or field.
7. **Rename-only alias.** For example `type UserId = string`.

## Q5. Package metrics
**Meaningful.**
- **Afferent/efferent coupling and instability, per workspace package and folder.** dependency-cruiser's metrics reporter already computes these, substituting folders and modules for Martin's components and classes. https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md
  - A dependency on a more unstable package (a Stable-Dependencies violation) is actionable.
  - Afferent coupling of 1 is the abstraction-accounting signal (rubric b).
- **Propagation cost (MacCormack 2006) and Decoupling Level (Mo et al. 2016)** are cheap trend lines. https://www.semanticscholar.org/paper/082655b75afa0254481c3f0927d10c224e6fd53e
  - A study of 1,252 projects ties complexity to bug-fix effort† (https://par.nsf.gov/servlets/purl/10590984).
- **Hotspot Patterns (Mo et al. 2015).** Unstable Interface and Implicit Cross-module Dependency are rubric (e) with history added. https://dl.acm.org/doi/10.1109/WICSA.2015.12
  - Clio confirmed 40% of the violations it flagged in Eclipse JDT and 65% in Hadoop†.

**Noise.**
- Abstractness and distance from the main sequence: types are erased and structural, and the layering law already fixes placement.
- Instability at file level.
- Cycles, which are already gated.
- LCOM1–3 on modules that contain only functions.

Use LCOM4 (CodeScene's choice: https://codescene.io/docs/guides/technical/code-health.html), or better, consumer cohesion.

**Connascence** (Page-Jones 1996; Weirich; https://en.wikipedia.org/wiki/Connascence).
- Statically detectable forms:
  - Name: the naming lineage;
  - Position: ≥4 positional parameters, or tuple returns;
  - Meaning: shared magic literals;
  - Algorithm: duplicated serialisation or hashing.
- Weight each by distance, so a cross-package instance counts more than a same-file one.
- Execution and Timing connascence are not cheaply detectable.

## Q6. Cross-cutting concerns
- **Fan-in (Marin, van Deursen & Moonen 2007).** Compute fan-in, filter out accessors and utilities, then a person analyses the call sites. It worked on about 200 KLOC but is explicitly semi-automatic. https://arxiv.org/abs/cs/0609147
- **Comparisons.** Fan-in, identifier analysis and dynamic analysis are complementary, with thresholds tuned per system.
  - Ceccato et al. 2006: https://arxiv.org/abs/cs/0607006
  - Roy et al. 2007: https://www.cs.usask.ca/~croy/papers/2007/Roy_ICPC2007_Aspect.pdf
- **Clone-based (Bruntink et al. 2005).** AST clones matched null-pointer checks, range checks and error handling best; PDG-based clones matched tracing best†. https://www.researchgate.net/publication/3188522
- **History-based HAM (Breu & Zimmermann 2006):** about 50% average precision†. https://thomas-zimmermann.com/publications/files/breu-ase-2006.pdf

**For us.** Two signals:
- clusters of idioms at handler entry/exit and in catch blocks that are not routed through a helper;
- inline clones of a high-fan-in helper's body.

Your observability, rate-limit and auth-posture gates check that these concerns are present; these two signals check that they are consolidated.

## Q7. Do hints help reviewers or anchor them?
**Positive evidence.**
- **Infer:** 70% fix rate at diff time versus about 0% in batch (Distefano et al. 2019). https://cacm.acm.org/research/scaling-static-analyses-at-facebook/
- **Tricorder:** effective false-positive rate kept under about 10% using a "not useful" feedback loop (Sadowski et al. 2018; from memory, not re-verified). https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
- **CodeScene research:**
  - unhealthy code had 15× the defects and took 124% longer to resolve (Tornhill & Borg 2022: https://arxiv.org/abs/2203.04374);
  - Code Health matched state-of-the-art ML and beat the average human expert, while SonarQube was heavy on false positives (Borg et al. 2024: https://arxiv.org/abs/2408.10754);
  - AI refactoring breaks semantics more often in unhealthy code (Borg & Tornhill 2026: https://arxiv.org/abs/2601.02200).
- **CodeScene vendor claim:** unguided LLMs fix about 20% of code-health issues, 90–100% with Code Health data over MCP. Not peer-reviewed. https://codescene.com/blog/deterministic-code-health-gate-for-ai-agents
- I found no controlled study of CodeScene's PR integration.
- **Hybrids win:** LLM-plus-static review beats either alone (Jaoua et al. 2025: https://arxiv.org/abs/2502.06633).

**Negative evidence.**
- With an automated review, 29 professionals focused on the flagged locations. They found more low-severity issues, no more high-severity ones, and saved no time (Tufano et al. 2025). https://arxiv.org/abs/2411.11401
- An industrial review bot had 73.8% of its comments resolved, yet PR closure time rose from 5h52 to 8h20 (Cihan et al. 2025). https://arxiv.org/abs/2412.18531
- LLM smell verdicts flip with prompt framing; evidence-first prompting reduces this† (2026). https://arxiv.org/abs/2607.10411
- Framing in commit messages anchors LLM security reviewers† (2026). https://arxiv.org/abs/2603.18740

**Design implications.**
1. State neutral facts, not labels: "`X` has 1 importer", not "speculative generality".
2. The reviewer does an independent pass first, then reads the packet.
3. Every item gets a confirm or dismiss with a `file:line` reason. Retire a signal whose dismissal rate stays above about 30% (my threshold).
4. Cap the packet at about 10 items, ranked by hotspot.
5. A/B test on seeded canary diffs, which matches your anti-vacuity doctrine.

**Incidental observation.** All six reviewer agents in `template/base/.claude/agents/` declare `tools: Read, Grep, Glob`, but their prompts say to run `git diff`. The two I opened, `architecture-reviewer.md` and `torvalds-reviewer.md`, say "First run `git diff`"; the other four say "read the diff (`git diff` vs base)". Without Bash they can only see the diff if something passes it in. Writing the diff and the evidence packet to a file they can Read would fix both.

## Signal catalogue

Rubric column: a–f are the architecture-reviewer items; T is the torvalds-reviewer.

| # | Signal | Detects | Rubric | Recipe | Inputs | Cost | FP risk |
|---|---|---|---|---|---|---|---|
| 1 | Co-change pairs | Logical coupling | e | Transaction = PR; drop \|T\|>30, scaffold/upgrade commits and generated files; degree = shared/mean(revs); rank by Wilson bound | git | s | High in the first ~6 months, then medium |
| 2 | Sum of coupling | Central files | e | SOC(f) = Σ(\|T\|−1) over transactions containing f | git | ms | Medium (barrels, configs) |
| 3 | Hotspot rank | Where to look | triage | Revisions in 90 days × Σ cognitive complexity | git, AST | s | Low (triage only) |
| 4 | Implicit cross-module dependency | Unnamed coupling | e | Cross-package co-change pair with no import path (≤2 hops), minus whitelisted seams | git, import graph | s | Medium-high |
| 5 | Systematic edit in diff | Same fact in N places | e, f | Hunks clustered by normalized shingles; ≥3 hunks in ≥2 files at Jaccard ≥0.8 | diff, AST | ms | Medium (codemods) |
| 6 | Fact-fingerprint census | Information leakage | e, d | Non-i18n literals and key sets present in ≥3 modules or ≥2 packages, when the diff touches one | AST | s | Medium |
| 7 | Union fan-out | Parallel registries | e, c | Per union: count switch / `Record<K,…>` / `===member` sites; flag ≥4 sites or ≥3 packages | TS checker | s | Low-medium |
| 8 | Discriminant scatter | Missing table or polymorphism | T, c | Diff adds checks on the same tag in ≥2 files | diff, AST | ms | Medium |
| 9 | Single-consumer abstraction | Speculative generality | b | New exported type, interface or wrapper with 1 non-test importer; whitelist `port.ts` | import graph, TS | s | Low (judgment still needed) |
| 10 | Pass-through function | Shallow wrapper | b, f | Body is `return [await] g(...)` forwarding its own params | AST | ms | Medium (transport seams) |
| 11 | Pass-through param / prop drilling | Tramp data | e | Param or prop used only as the same-named argument or JSX attribute; chain ≥2 | AST, call graph | s | Medium |
| 12 | Middle-man module | Delegating module | b, f | ≥50% of exports are re-exports or pass-throughs, excluding barrels | AST | ms | Medium |
| 13 | Module depth | Shallow module | b | Σ cognitive complexity ÷ interface surface; flag bottom decile | AST, TS | s | High (unvalidated; rank only) |
| 14 | Consumer cohesion | Two modules sharing a file | e | Exports × importer graph has ≥2 components; LCOM4 as fallback | import graph | s | Medium (`shared/*`) |
| 15 | Fan-in (CM/CC) | Blast radius | e | Distinct referencing functions and files per symbol; flag a signature change with CM >7 | TS language service | s | Low |
| 16 | Feature envy | Wrong altitude | a, e | ATFD >3 ∧ LAA <⅓ ∧ FDP ≤3, with accesses resolved by type | TS checker | s | High |
| 17 | Data clump / bare IDs | Missing type | T, d | ≥3 (name, type) pairs co-occurring in ≥3 signatures; `*Id` typed as bare string across packages | AST, TS | s | Low-medium |
| 18 | Naming lineage | One concept, two names | d | SQL column → generated types → `rows.ts` → DTO → procedure input → prop; flag renames outside `rows.ts`, orphan fields, 1↔2 mappings | SQL, AST | s | Low-medium |
| 19 | Synonym/homonym census | Naming drift | d | Split identifiers into words; flag synonym-list pairs on the same type, or one word bound to different types | AST, TS | s | Medium-high |
| 20 | Boolean selector | Flag that forks behaviour | c | Boolean param is the top-level split condition, or callers pass literal `true`/`false` | AST | ms | Low-medium |
| 21 | Near-identical branches | Special-casing | c | Branch bodies with normalized-token Jaccard ≥0.8 | AST | ms | Medium |
| 22 | Redundant edge guard | Special case the general path covers | T | Empty/null early return before a general path that yields the same value; confirm with a surviving guard-deletion mutant | AST, mutation report | ms / min | Medium; low when mutant-confirmed |
| 23 | First-iteration branch | Head special case | T | `i===0`, `isFirst` or `prev==null` in a loop, or a loop-body clone before the loop | AST | ms | Medium |
| 24 | Intent-hiding helper | Pointless abstraction | T, b | Single expression ≤12 tokens and ≤2 call sites, or name tokens ≥ body tokens | AST | ms | Medium |
| 25 | Rename-only alias | Alias that hides without protecting | T, d | `type A = B` or `= string` with no brand; alias chains | AST | ms | Medium |
| 26 | Idiom cluster | Cross-cutting concern with no home | e | Hash first and last k statements of handlers plus catch bodies; ≥3 in ≥2 files that do not call a helper | AST | s | Medium |
| 27 | Bypassed helper | Reimplemented shared tool | e, f | Helper with fan-in ≥10 whose body is cloned inline elsewhere | AST, clone index | s | Low-medium |
| 28 | Superseded symbol | Old helper not deleted | f | New symbol ≥0.8 similar to an existing one the diff does not delete; net LOC | AST, clone index | s | Medium |
| 29 | Package instability / SDP | Dependency direction | a, e | depcruise per-package metrics; flag dependency on a more unstable package; trend propagation cost | import graph | s | Medium (skip abstractness and main-sequence distance) |
| 30 | Over-fine split | Coupling in a modularity costume | e | Package pairs co-touched in ≥50% of the PRs that touch either | git, workspace map | s | Medium-high early |

**Unverified items to check before relying on them:**
- the 1998 Gall DOI;
- all † figures;
- the Tricorder <10% figure;
- whether `eslint-plugin-sonarjs` v3 ships a boolean selector-parameter rule (the archived plugin README I read does not list one);
- every threshold labelled as my suggestion (1/(|T|−1) weighting, Wilson ranking, the 30% dismissal cutoff).