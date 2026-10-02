# Code similarity and relatedness signals for the harness: research report (2026-10-01)

**How this was checked.** WebSearch worked until the session's search budget (200) ran out. WebFetch could reach GitHub but not arXiv, Hugging Face, the vendor docs sites or university hosts. Claims marked **†** come from search-result snippets or from memory of the cited paper and were not read first-hand here. The last section lists them.

## Executive summary
1. Classical token and AST tools handle type-1, type-2 and very-strongly type-3 clones on BigCloneBench (BCB). Strongly type-3 needs heavy normalisation: NiCad gets about 95% recall. Moderately type-3, weakly type-3 and type-4 are mostly not found by syntactic tools; SourcererCC gets about 5% recall on moderately type-3 †.
2. The 0.93–0.95 F1 that learned models report on BCB is inflated. In a sample of 406 BCB "weakly type-3 / type-4" pairs, 93% were mislabelled. On functionality they have not seen, task-specific models lose on average 31% F1, while generative LLMs lose only about 3%.
3. No published clone benchmark covers TypeScript. Every number below is for Java, C, C# or Python, so thresholds have to be calibrated on our own repo.
4. The best cheap primitives for "same shape, different names" are deterministic: AST subtree hashes with locals renamed (exact type-2) plus MinHash/LSH over AST shingles (type-3). Both are fast.
5. Anti-unification turns a clone group into a template with holes, which is the candidate shared abstraction. The research line runs from Clone Digger through Wrangler and HaRe, Tsantalis's refactorability work, and babble/Stitch/ReGAL.
6. For TypeScript at 200k LOC, `oxc-parser` and `@ast-grep/napi` (both MIT, Rust with Node bindings) fit a budget of a few seconds. The type-checked TS compiler API and CodeQL do not. Semgrep, Comby and GritQL are rule engines, not similarity engines.
7. SQL to TS linking is feasible deterministically: libpg_query on migrations, ast-grep patterns for `.from().select()` / `.rpc()`, and `database.types.ts` as a cross-check. Prior academic work covers Java/JDBC, not supabase-js.
8. For incrementality, every serious indexer (SCIP, Glean, salsa) uses per-file units plus content hashing. A cache keyed by git blob SHA makes warm runs on an unchanged tree close to free.
9. Most clones are harmless or deliberate (Kapser & Godfrey). The useful ranking signals are cross-package spread, logic density, repetitiveness, co-change history and group size. Web vs native duplicates should be classed as "platform variation".
10. Proposed stack, in four layers:
    - **L0:** the token gate (keep it or move to jscpd v5).
    - **L1:** a cached fingerprint index.
    - **L2:** anti-unification plus coupling explanations.
    - **L3:** optional, pinned embeddings.

    Only L0 and the exact-hash facts from L1 should ever gate.

## Q1. Clone taxonomy and detection techniques
The taxonomy (Roy, Cordy & Koschke 2009, https://doi.org/10.1016/j.scico.2009.02.007 †):
- **Type-1:** identical apart from whitespace and comments.
- **Type-2:** also renamed identifiers or changed literals.
- **Type-3:** statements added, removed or changed. BCB splits this by similarity into very-strongly (VST3), strongly (ST3), moderately (MT3) and weakly (WT3) type-3.
- **Type-4:** the same behaviour written differently.

| Family | Exemplars | Strong on | Evidence |
|---|---|---|---|
| Token | CCFinder (Kamiya 2002), SourcererCC (Sajnani 2016, https://arxiv.org/abs/1512.06448), jscpd, PMD CPD | T1–T2, VST3 | SourcererCC BCB recall: T1 100, T2 98, VST3 93, ST3 61, MT3 5; precision about 83% †. CCFinderX finds no type-3. |
| Text plus normalisation | NiCad | up to ST3 | ST3 recall 95%, the best measured (Wu et al. 2020, https://arxiv.org/abs/1909.04238) |
| AST | CloneDR subtree hashing (Baxter 1998 †), Deckard characteristic vectors with LSH (Jiang 2007 †), Clone Digger anti-unification | T1–T3 | Deckard has poor recall on every type (Svajlenko & Roy 2015, https://www.researchgate.net/publication/308732427). On CodeXGLUE's pairwise BCB split it scores P 0.93 / R 0.02. |
| PDG / semantic | Komondoor & Horwitz 2001, Krinke 2001, GPLAG | some T4 | Slow (subgraph isomorphism), and no TypeScript front-ends. |
| Metrics plus ML | Oreo (Saini 2018, https://arxiv.org/abs/1806.05837) | ST3, some MT3 | MT3 about 30%, precision about 89.5% † |
| Learned pairwise | ASTNN, FA-AST-GMN, CodeBERT, GraphCodeBERT, UniXcoder, CodeT5+ | T3/T4 within benchmark | CodeXGLUE BCB F1: ASTNN 0.93, FA-AST-GMN 0.95, CodeBERT 0.941 (https://github.com/microsoft/CodeXGLUE/tree/main/Code-Code/Clone-detection-BigCloneBench) |
| Embeddings | voyage-code-3/4, nomic-embed-code, jina-code-embeddings, Codestral Embed, Qwen3-Embedding, CodeXEmbed | relatedness, partly T4 | No clone-benchmark numbers for these models; see the caveats below. |

**Caveats on the learned and embedding numbers**
- **BCB labels are unreliable for semantic clones.** Krinke & Ragkhitwetsagul found 86% of sampled weakly type-3/type-4 pairs to be false positives (IWSC 2022, https://www.semanticscholar.org/paper/7c7b71adb2d90c4c717444fb578280cff6b3aebd). A 2025 follow-up found 93% of 406 pairs mislabelled, and 139 of 179 papers reviewed had threatened results (https://arxiv.org/abs/2505.04311).
- **Models do not transfer.** Models that do well on BCB swing by more than 20% F1 on SemanticCloneBench (ICSME 2024, https://arxiv.org/abs/2412.14739 †authors). Kitsios et al. 2025 (https://arxiv.org/abs/2510.04143) found task-specific models lose up to 48% F1 (31% on average) on unseen functionality, while LLMs lose about 3%. Sonnekalb et al. 2022 (https://arxiv.org/abs/2208.12588) reported the same problem for CodeBERT.
- **GPTCloneBench** (Alam et al. 2023, https://arxiv.org/abs/2308.13963) has 37,149 true semantic pairs, 19,288 false pairs and 20,770 cross-language pairs in Java, C, C# and Python. SourcererCC, Oreo and CLCDSA did poorly on it. A 2025 study of nine classical tools (Alam et al., https://arxiv.org/abs/2509.25754) found that tools with strong normalisation "retain considerable effectiveness" on AI-generated clones. I could not get its per-tool tables.
- **Embedding models.**
  - voyage-code-3 (Dec 2024) beats OpenAI v3-large by 13.8% on 32 retrieval sets (https://blog.voyageai.com/2024/12/04/voyage-code-3/).
  - voyage-code-4 (Aug 2026) has a 32K context and costs $0.12 per million tokens (https://blog.voyageai.com/2026/08/13/voyage-code-4/).
  - nomic-embed-code is 7B parameters and Apache-2.0 (https://www.nomic.ai/news/introducing-state-of-the-art-nomic-embed-code).
  - jina-code-embeddings comes in 0.5B and 1.5B; the 1.5B roughly matches voyage-code-3 (https://jina.ai/news/jina-code-embeddings-sota-code-retrieval-at-0-5b-and-1-5b/).
  - Codestral Embed came out in May 2025.
  - On the CoIR benchmark, CodeXEmbed-7B is top and no model wins every task (https://arxiv.org/abs/2411.12644).

  All of these are retrieval models, and they measure resemblance, not equivalence. In ExecRetrieval (Kapoor & Khan, Sept 2026 preprint, https://arxiv.org/abs/2609.01865), the best system's rank-1 result was correct only 33% of the time, and 91–99% of the misses were buggy near-clones. The paper's design has been publicly criticised. For cross-language pairs, embeddings plus a simple classifier beat prompted LLMs by 2 to 24 points (Moumoula et al. ASE 2024, https://dl.acm.org/doi/10.1145/3691620.3695335).

**What works for TypeScript today**
- **Type-1 and type-2:** jscpd v5 (Rust engine using the oxc parser; `--ignore-identifiers` / `--ignore-literals` landed in Sept 2026; https://github.com/kucherenko/jscpd, issue #998), PMD CPD, and qlty smells. qlty uses tree-sitter fingerprinting with "identical" and "similar" smells, a default of 12 lines and `nodes_threshold` 50 (https://docs.qlty.sh/qlty-toml).
- **Type-3:** no ready-made TypeScript tool. NiCad, Deckard and Oreo have no TS front-end †. We would build it ourselves with AST shingles.
- **Type-4:** only embeddings or LLM judgement.

## Q2. Near-miss and "same shape, different names" detection
- **Rename-invariant hashing.**
  - CloneDR hashed subtrees while ignoring identifiers.
  - Maziarz et al. (PLDI 2021, https://www.microsoft.com/en-us/research/publication/hashing-modulo-alpha-equivalence-2/) hash modulo alpha-equivalence in O(n log² n).
  - For us, a simpler scheme is enough: rename locally bound names to their binding order and keep imported and global names. Keeping imported names is what lets us say "reinvents `platform/errors`".
- **Set-similarity on structure.**
  - Winnowing (Schleimer, Wilkerson & Aiken 2003 †, https://doi.org/10.1145/872757.872770) guarantees that any match of at least *t* tokens is found. That suits "diff vs index" queries.
  - MinHash/LSH over shingles is the main alternative.
  - Deckard applies LSH to vectors of node-type counts.
  - code2vec path-contexts (Alon 2019 †) can be hashed with identifiers abstracted, with no learning, and used as shingles.
- **Anti-unification as a refactoring proposer.**
  - Clone Digger computes the most specific generalisation of two ASTs (Bulychev & Minea 2008, https://clonedigger.sourceforge.net/duplicate_code_detection_bulychev_minea.pdf). Cerna & Kutsia survey the area (2023, https://arxiv.org/abs/2302.00277).
  - Wrangler (Erlang) turns that generalisation directly into an extracted function (Li & Thompson 2010, https://link.springer.com/chapter/10.1007/978-3-642-11503-5_10).
  - Tsantalis, Mazinanian & Krishnan (TSE 2015 †, https://doi.org/10.1109/TSE.2015.2448531) check whether clone differences can be safely parameterised (JDeodorant). Their ICSE 2017 work passes behavioural differences as lambdas (https://www.semanticscholar.org/paper/acb5942773aeae239f12cf268afd61bfb950bc0f); in TypeScript that means a callback parameter.
  - CREC (Yue et al. 2018, https://arxiv.org/abs/1807.11184) learns which clones get refactored from 34 features, scoring F 83% within a project and 76% across projects. History and co-change features matter most.
  - AntiCopyPaster flags pasted duplicates and suggests Extract Method only "when it is worth it" (2023, https://arxiv.org/abs/2302.03416; 2.0 in 2024).
- **LLM-assisted refactoring.**
  - EM-Assist found up to 76.3% of LLM Extract Method suggestions were hallucinations, and filters them with static analysis (Pomian et al. 2024, https://arxiv.org/abs/2401.15298).
  - CloneManager covers LLM clone identification and refactoring (Qian et al., JSS 2025, https://www.researchgate.net/publication/398339647).
  - Library learning: babble (Cao et al. POPL 2023, https://arxiv.org/abs/2212.04596) and Stitch. Leroy applied Stitch to Python and got only 1.04x compression, which is a sobering result (Bellur et al. 2024, https://arxiv.org/abs/2410.06438). ReGAL has the LLM propose helpers and verifies them by execution (Stengel-Eskin et al. ICML 2024, https://proceedings.mlr.press/v235/stengel-eskin24a.html).
  - **Lesson:** a deterministic anti-unifier proposes the template, and the LLM reviewer judges whether it is worth extracting.

## Q3. Structural search engines
| Tool | Licence | Deterministic | Incremental | Under 5 s on 200k LOC? | Fit |
|---|---|---|---|---|---|
| tree-sitter | MIT | yes | reparses edited trees; per-file caching is ours to build | yes | base parser |
| ast-grep / `@ast-grep/napi` | MIT (https://github.com/ast-grep/ast-grep) | yes | none; `findInFiles` parses in parallel Rust threads | yes. Docs say one pattern over the TypeScript compiler source takes about 0.5 s † | concern rules, Supabase call extraction, node walking |
| oxc-parser (NAPI) | MIT | yes | none | yes. Native parse of typescript.js: oxc 26 ms vs SWC 84 ms (M3 Max, https://github.com/oxc-project/bench-javascript-parser-written-in-rust); NAPI transfer adds overhead | ESTree/TS-ESTree output; fingerprinting; semantic/scope analysis |
| SWC | Apache-2.0 | yes | none | yes, about 3x slower than oxc | alternative |
| TS compiler API / ts-morph | Apache-2.0 / MIT | yes | builder/tsbuildinfo | parse-only yes; type-checked Program probably 10 s+ (estimate). TS 7 (Go) went GA July 2026 at about 10x speed, but its programmatic API is deferred to 7.1 † | nightly or advisory only |
| Semgrep CE / Opengrep | LGPL-2.1. Semgrep rules moved to a non-OSS licence; Opengrep forked v1.100.0 (https://github.com/opengrep/opengrep) | yes | diff-aware baseline † | borderline (startup cost) | rules, not similarity |
| CodeQL | free for OSS/academic; private repos need GitHub Code Security (https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/about-the-codeql-cli) | yes | no | no (building the database takes minutes †) | not a fit |
| Comby | Apache-2.0 | yes | no | probably | lightly maintained (last release 1.8.1, about 2022 †); matches balanced delimiters, not a full AST |
| Biome GritQL plugins | MIT/Apache; GritQL was donated to Biome (https://biomejs.dev/blog/gritql-under-biome-umbrella/) | yes | lint-time | yes | enforce "use `platform/errors`"-style rules; v2.5 adds plugin fixes † |

## Q4. Cross-language linking (SQL to TS)
**Prior work** targets Java/JDBC/ORMs:
- schema/code co-evolution (Qiu, Li & Su FSE 2013 †, https://doi.org/10.1145/2491411.2491431)
- DBScribe, which documents DB usage per method (Linares-Vásquez et al. ISSTA 2016 †, https://doi.org/10.1145/2931037.2931072)
- SQLInspect (Nagy & Cleve ICSE 2018 demo †, https://doi.org/10.1145/3183440.3183496)
- Meurice, Nagy & Cleve 2016 † on schema-evolution inconsistencies

Lineage tools such as sqlglot and OpenLineage stop at SQL. I found nothing on PostgREST or supabase-js.

**A buildable deterministic pipeline**
1. Parse migrations with libpg_query (Postgres's own parser). From it, build a graph of tables, columns, `CREATE POLICY … ON t`, functions, triggers and views.
2. Use pg_query fingerprints to find SQL-function and policy clones. Fingerprints ignore constants and aliases and sort target lists (https://github.com/pganalyze/libpg_query/wiki/Fingerprinting). Supabase's postgres-language-server (MIT, libpg_query) does not analyse SQL embedded in TS (https://github.com/supabase-community/postgres-language-server).
3. On the TS side, use ast-grep patterns for `$C.from('$T')`, the following `.select('$S')`, `.insert/.update/.upsert/.delete`, `.eq('$COL', …)` and `.rpc('$FN')`. Parse select strings with the PostgREST grammar; postgrest-js already parses them at the type level (https://github.com/supabase/postgrest-js/blob/master/src/select-query-parser/parser.ts). Validate names against the keys of `Database['public']['Tables']` in `database.types.ts`.
4. Output, per function, the set of tables, columns and operations it touches. That gives data coupling and lines like "three verticals select the same columns from `profiles`".

## Q5. Incrementality
- **SCIP:** "file-level incrementality should be easy", with per-document streaming and string symbols to limit the damage from indexer bugs (https://github.com/sourcegraph/scip/blob/main/docs/DESIGN.md).
- **Glean:** facts are owned by "units". Excluding a unit hides its facts through bitmap slices. Derived facts get conjunctive ownership, and databases stack (https://github.com/facebookincubator/Glean/blob/main/glean/website/docs/implementation/incrementality.md).
- **stack-graphs:** builds name-resolution data per file and stitches it at query time †. The repo was archived on 2025-09-09 (https://github.com/github/stack-graphs).
- **Kythe:** a batch pipeline per compilation unit; I found no incremental serving in the open-source release †.
- **salsa:** revisions plus "backdating" (an unchanged output stops downstream recomputation) plus durability tiers (https://github.com/salsa-rs/salsa/blob/master/book/src/reference/algorithm.md).

**The simplest scheme for us**
1. `git ls-tree -r HEAD` gives a blob SHA per file.
2. Cache key: (blobSHA, extractorVersion, configHash). The value is that file's function records.
3. Build the global index by merging the records in memory. LSH buckets for about 20k functions take milliseconds.
4. For a PR, re-extract only the blobs that changed.
5. If a function's fingerprint is unchanged, skip everything downstream of it (salsa's early cutoff).

Store the cache in `.cache/`, or in CI cache keyed by tree SHA.

## Q6. Precision traps and what is worth refactoring
- **Evidence that most clones are fine.**
  - Kapser & Godfrey (EMSE 2008 †, https://doi.org/10.1007/s10664-008-9076-6) found many clones are good. Their "platform variation" pattern is exactly web vs native, and they judged about 71% of studied clones to have a positive effect †.
  - Kim et al. 2005 † found many clone genealogies short-lived and many long-lived ones not locally refactorable.
  - Rahman et al. 2012 † found cloned code no more bug-prone than other code.
  - Göde & Koschke 2011 † found most clones never change.
- **Where the risk is.** Juergens et al. (ICSE 2009 †, https://doi.org/10.1109/ICSE.2009.5070547) found inconsistent changes to clones often cause faults.
- **What predicts refactoring.** Co-change and history (CREC). Mondal, Roy & Schneider survey clone refactoring and tracking (2020, https://www.researchgate.net/publication/336031740).
- **Where false positives come from, and how to suppress them**
  - Generated code (`database.types.ts`, `*.gen.ts`): exclude it.
  - Tables and catalogs (i18n, constants, zod objects, JSX attribute lists): use CCFinder's RNR ratio (Higo et al. 2007 †), which flags repetitive token runs, plus a cap on literal density.
  - JSX boilerplate: require a minimum number of non-JSX "logic" tokens.
  - zod: suggest deriving the schema from DB types rather than calling it a clone.
  - Tests: report on a separate channel with higher thresholds.
  - Web/native pairs: tag them as platform variation and report them only when shared non-UI logic is duplicated (suggest moving it to a package).
  - JavaScript-specific clone patterns: Cheung, Ryu & Kim 2016 †.
- **Ranking signals used in production**
  - jscpd's `--skip-local` reports cross-root clones only.
  - Minimum token and line counts.
  - Clone-group size and cross-package spread.
  - Co-change from `git log`: logical coupling (Gall 1998 †). CodeScene combines change coupling with similarity (Tornhill 2018 †).
  - A baseline or ratchet so that only new clones count.

## Recommended technique stack for our harness
| Layer | Tool | Cost (estimates †) | Catches | False-positive risk |
|---|---|---|---|---|
| **L0 gate (exists)** | `check-duplication.mjs`, optionally replaced or backed by jscpd v5 (MIT, oxc, rename-insensitive) with a baseline file | under 1 s | T1 and light T2 | low; gate only on new clones of at least 70 tokens |
| **L1 fingerprint index (deterministic; gate-eligible for exact hashes only)** | `oxc-parser` or `@ast-grep/napi`. Per function: (a) hash with locals renamed; (b) 128-permutation MinHash over AST shingles (node-kind triples or abstracted path-contexts), LSH 32×4 (Jaccard ≈ 0.7); (c) identifier sub-token bag, import set, call set, Supabase table set; (d) tokens, RNR, JSX and literal ratios. Cached per blob SHA. | cold about 2–5 s for 200k LOC; warm under 0.5 s | T2 cross-package, T3, renamed copies, "calls the same platform APIs" | medium; tamed by the Q6 filters and thresholds |
| **L2 structural explanation (deterministic, advisory)** | For L1 candidates, and for each new function vs an inventory of `packages/platform/*` exports: anti-unify the normalised ASTs into a template with typed holes (literal / identifier / expression / statement → callback); ast-grep "concern" rules (error mapping, retry, auth guard, logging); import graph (oxc semantic plus resolver); git co-change over 6–12 months; libpg_query to TS table-touch graph | about 0.5–2 s on the candidate set | "reinvents Z", "three verticals share template T(table, schema)", data and logical coupling | low for the facts themselves; relevance is left to the reviewer |
| **L3 embeddings (optional, advisory only)** | Hosted: voyage-code-3/4 or Codestral Embed. Local: Qwen3-Embedding-0.6B (Apache-2.0) or jina-code-embeddings-0.5b (licence unverified †). Pin the model ID; cache vectors by (blob SHA, span hash, model); exact cosine kNN. | First full embed: about 2–3M tokens, under $0.50 at voyage-code-4's price, or minutes on a local CPU. Incremental: seconds. | type-4-like overlap of intent; naming and topic relatedness | high: "related" is not "duplicate", and vectors are not reproducible across model versions, so never gate on them |

**What the reviewer receives.** For each changed function, a compact similarity dossier: top-k neighbours, the layer that found each one with its score, the anti-unified template and its holes, shared tables, co-change strength, and the path-pair class (same package, cross-vertical, platform variation). The reviewer does the type-4 and "is it worth it" judgement, where LLMs generalise best (Kitsios 2025), but only over candidates that came from deterministic retrieval.

## Not verified first-hand
- **Exact numbers from memory or snippets:** SourcererCC and Oreo per-type BCB numbers and precision, plus Oreo's MT3 30%; the ast-grep 0.5 s claim; the Kapser & Godfrey 71% figure.
- **The 2025–26 papers:** per-tool tables of Alam et al. 2025 and GPTCloneBench; author names of arXiv 2412.14739.
- **Citations from memory:** DOIs and details for foundational papers marked †.
- **Tool status:** TS 7 API timing (secondary sources only); Semgrep's rules-licence date and diff-aware behaviour; Comby's release year; the Biome 2.5 feature set.
- **Model licences:** jina-code-embeddings and CodeRankEmbed.
- **Cost estimates:** all costs for our repo are estimates, not benchmarks.
- **NiCad/Deckard:** that they have no TypeScript grammar.
