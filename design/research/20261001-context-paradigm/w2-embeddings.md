# Optional embedding layer: research and design (as of 2026-10-01)

This report is about 2,800 words by `wc`, a little over the ~2,500 target; table pipes and the JSON example account for some of that.

Unless a path starts with `design/` or `tests/`, internal paths are relative to `template/base/` at the 2.0.0 stack head (`b158f5a`). WebFetch was blocked for most vendor and arXiv domains, so most external figures come from search-result extracts of the cited pages. † marks figures I could not open first-hand.

## Summary

- **Default hosted model: `voyage-code-4`.** **Local fallback: Qwen3-Embedding-0.6B** (Apache-2.0), reached through a local OpenAI-compatible server. Local mode then needs no npm or native dependencies.
- **Embeddings measure resemblance, not equivalence.** Use them to propose candidates, and confirm each candidate with deterministic structural evidence.
- **Embeddings never create an owed disposition and never take part in a Stop or CI verdict.** They produce only two tiers:
  - `context`: shown to the writer and the reviewers;
  - `advisory`: tracked as a GitHub issue, only when at least one deterministic signal corroborates it.
- **Storage is a flat file in `.harness/` with exact search.** I measured it at up to 50k functions with no dependency. pgvector inside the app's local Supabase is a trap.
- **The module is not "recommended" until a seeded type-4 evaluation shows it adds recall over the structural layer.**

## 1. Models (late 2026)

| Model | Licence / kind | Code scores (suites differ) | Dims / context | $ per M tokens |
|---|---|---|---|---|
| **voyage-code-4** (2026-08-13) | API; also on AWS SageMaker and Azure, deployable in your own VPC | Over voyage-code-3: +13.98% on Voyage's 28 code sets, +27.54% on its new 19-set "agentic" suite (issue-fixing PRs). Over Gemini Embedding 2 / Cohere v4 on the 28 sets: +16% / +19% (vendor) | 256–2048 MRL, int8 and binary / 32K | 0.12 |
| voyage-4-nano (2026-01) | Apache-2.0 open weights, 340M | Shares a space with voyage-4/-lite/-large. Not stated to share one with voyage-code-4 | MRL / 32K | local |
| Gemini Embedding 2 (GA 2026-04) | API | Press: #1 on MTEB Code † | 128–3072 / 8,192 | 0.20 (batch 0.10) |
| Cohere Embed v4 | API | No code figure found | 1,536 / 128K | 0.12 |
| OpenAI text-embedding-3-large (2024; still current, Sept 2026) | API | CoIR 65.17 (Qodo's table) | 3,072 / 8,191 | 0.13 |
| Codestral Embed (2025-05) | API | Vendor: beats voyage-code-3 | flexible | 0.15 |
| **Qwen3-Embedding 0.6B / 8B** | **Apache-2.0** | MTEB-Code 75.41 / 80.68 | 1024 MRL / 32K | local: official GGUF; community ONNX for transformers.js |
| jina-code-embeddings 0.5B / 1.5B | **CC-BY-NC-4.0** | 1.5B: MTEB-Code 78.94; has a `code2code` prefix | MRL / 32K | excluded by licence |
| nomic-embed-code 7B / CodeRankEmbed 137M | Apache-2.0 / MIT | CodeSearchNet-JS 77.1 / 71.4 | – | 7B too big for CPU; 137M is NL→code only |
| SFR-Embedding-Code (CodeXEmbed) 400M / 2B | **CC-BY-NC-4.0** | CoIR 61.9 / 67.4 | – | excluded |
| Qodo-Embed-1 1.5B / 7B | OpenRAIL++-M / commercial | CoIR 68.53 / 71.5 | – | excluded |
| CodeSage-v2 large | Apache-2.0 | CoIR 64.2 | MRL | ONNX unverified |

**Caveats**

- The suites (CoIR, MTEB-Code, CodeSearchNet, vendor) cannot be compared with each other.
- Agentic benchmarks rank models very differently:
  - On CORE-Bench, Qwen3-Embedding-8B scores 71.7 on classic code search but 20.3 on issue-to-edit localisation (https://arxiv.org/abs/2606.11864).
  - On Agent Retrieval Bench, the winner varies by task, and structural RepoMap gives the best context yield for a fixed budget (https://arxiv.org/abs/2607.24882).
- I found no reliable per-model CoSQA figures for 2026 models.

**CPU throughput (estimate †)**

- A 0.6B encoder costs about 1.2 GFLOP per token, so a laptop running q8 manages roughly 200–600 tokens/s.
- One changed function takes under 1 s.
- A cold index of about 1M tokens (5k functions) takes 30–80 minutes locally, or about $0.12 and a few minutes through the API.
- So cold indexing belongs in CI or a background job.

**Sources**

- https://blog.voyageai.com/2026/08/13/voyage-code-4/
- https://blog.voyageai.com/2026/01/15/voyage-4/
- https://ai.google.dev/gemini-api/docs/embeddings
- https://developers.openai.com/api/docs/guides/embeddings
- https://arxiv.org/abs/2506.05176
- https://arxiv.org/abs/2508.21290
- https://www.nomic.ai/news/introducing-state-of-the-art-nomic-embed-code
- https://arxiv.org/abs/2411.12644
- https://www.qodo.ai/blog/qodo-embed-1-code-embedding-code-retrieval/
- https://mistral.ai/news/codestral-25-08/

## 2. Fitness for clone and reuse detection

**General code embeddings rank resemblance, not "does the same job":**

- **ExecRetrieval** plants execution-verified buggy distractors, each one edit away from the correct function. The best system ranks the right function first only 33% of the time but always has it in the top 10 (exec@1 = 0.331, exec@10 = 1.00). 91.5–99.4% of rank-1 misses are the buggy near-clone (https://arxiv.org/abs/2609.01865).
  - A critique says the headline number is partly an artefact of the setup (https://github.com/jjakimoto/research-issues/issues/1337).
  - The point stands: near-clones cluster, and cosine cannot tell them apart.
- **Functional-consistency study:** embedding models have "inherent limitations in capturing functional semantics" (https://arxiv.org/abs/2508.19558).
- **"Semantic Code Clone Detection: Are We There Yet?":** all 11 detectors degrade under 8 semantics-preserving transformations (https://arxiv.org/abs/2606.25272).
- **Specialised clone models:**
  - LWVIC4Code reaches type-4 F1 of 0.92–0.98 on GPTCloneBench (https://arxiv.org/abs/2609.17338).
  - But task-specific detectors lose up to 48% F1 on unseen functionality (https://arxiv.org/abs/2510.04143).
  - None ships for TypeScript.

**The pattern that works.** A study of embedding-guided reuse detection found many pairs above 0.90 cosine were not usable as reuse. Its fix was deterministic validators inside retrieval: parameter parity, call-graph overlap, token overlap and branching pattern. They were 97.5% accurate on the rejections that were checked by hand (https://arxiv.org/abs/2608.04137). **Embeddings retrieve; structure confirms.**

**Where embeddings should add recall over L1 (MinHash over AST shingles) and L2 (anti-unification):** code with the same intent but different structure and vocabulary. Examples:
- `clampPercent` versus `boundValue(x, 0, 100)`;
- a hand-rolled retry loop versus the platform `withRetry`.

**Chunking unit: one chunk per function, from the same oxc AST pass as the structural index.**

- **What counts as a function:** declarations; arrow functions assigned to a `const`; methods; components and hooks; exported zod schemas; tRPC procedures.
- **Minimum size:** about 25 tokens and 3 statements. Tiny functions saturate cosine.
- **Large functions:** over about 80 lines, also emit cAST-style statement-block sub-chunks, so a helper inlined inside a large function can still be found.
- **Sliding windows** win when retrieving context for code completion (https://arxiv.org/abs/2605.04763). For reuse detection the function is the unit of identity.

**Normalisation (versioned; part of the cache key):**

- **Keep:** identifiers and TS types. They carry the intent; rename-invariance is L1's job.
- **Strip:** all comments. The harness's ubiquitous `// SOURCE: … [corpus: …]` lines would pull unrelated functions together (e.g. `tools/check-duplication.mjs:17`). Also strip licence headers.
- **Truncate and collapse:** literals over 32 characters; whitespace.
- **Exclude:** the file path. It biases towards same-folder neighbours, and the structural layer already has proximity.
- **Embed both sides the same way:** use the model's code-to-code instruction where one exists, and the same `input_type` on both sides for Voyage.

## 3. Determinism and reproducibility

**Facts:**

- **Hosted APIs are not bit-stable.** OpenAI users report 3rd–4th-decimal drift on identical input, caused by batch-dependent GPU kernels (https://community.openai.com/t/can-text-embedding-ada-002-be-made-deterministic/318054). Assume the same of all vendors.
- **Model ids change vector spaces.** `gemini-embedding-001` and `-2` are incompatible. A dated `voyage-code-4-20260812` id is listed on OpenRouter †.
- **Local ONNX differs across CPUs.** AVX-512 and AVX2 machines give different results (https://github.com/pytorch/pytorch/issues/155552), and int8 models have misbehaved on AVX2-only CPUs (https://github.com/microsoft/onnxruntime/issues/6004).
- **llama.cpp pooling.** Wrong pooling for Qwen3 silently yields bad vectors (https://github.com/ggml-org/llama.cpp/issues/14234).
- **ReproRAG:** retrieval is the main source of non-reproducibility in RAG systems (https://arxiv.org/abs/2509.18869).

**Rules:**

1. **Compute once, replay.** The cache key is `sha256(modelId|dims|dtype|normaliserVersion|canonicalText)`. A cached key is never recomputed, so reruns on one machine are identical.
2. **Pin and fingerprint the model.**
   - A committed probe set of about 20 functions, with reference int8 vectors, is re-embedded on cold start and on schedule.
   - If cos(reference, live) < 0.995, the layer disables itself loudly.
   - This catches provider drift and misconfigured local servers.
3. **Keep embeddings out of verdicts.**
   - The owed set is a pure function of the tree, computed by the structural tiers.
   - The Stop step never reads vectors.
   - No gate touches the network, as in the eval-live doctrine (`template/modules/eval-live/docs/modules/eval-live/README.md`).
4. **Stop small score changes from flipping issues.**
   - Round cosine to 2 decimal places.
   - Use two thresholds: open an advisory at T_open. Close it only when one of the two functions' content hash changes, a disposition is recorded, or cosine falls below a lower T_close.
   - Key issues by (sorted content fingerprints, rule), never by score.
   - Only one job syncs issues: the scheduled CI job, with an Actions cache keyed by the model.
5. **Optional bridge to obligations.**
   - Materialise accepted advisories into a committed register keyed by content fingerprint, as `tools/duplication-allow.json` already does for accepted clones.
   - "This diff modifies a function with an open semantic advisory" then becomes a fact about the tree and can be owed.
   - Discovery stays non-deterministic; the obligation does not.

## 4. Storage and retrieval

**Measured here: Node 22.22, 4 vCPU, single-threaded scalar JS, exact search, one query:**

| N × D | f32 size | f32 | int8 | 1-bit Hamming | all-pairs (1-bit) |
|---|---|---|---|---|---|
| 5k × 1024 | 20 MB | 8 ms | 12 ms | 0.4 ms | ≈1 s |
| 50k × 512 | 102 MB (int8: 26 MB) | 59 ms | 65 ms | – | – |
| 50k × 1024 | 205 MB | 81 ms | 119 ms | 4 ms | ≈100 s |
| 100k × 1024 | 410 MB | 194 ms | 241 ms | 10 ms | ≈480 s |

The benchmark scripts were throwaway and are not committed.

**Recommended layout: `.harness/context/emb/<modelKey>/`.** `.harness/*` is already gitignored.

- **Files:** `vectors.i8` (512-d Matryoshka), `bits.u32` (sign bits), `rows.jsonl` (contentHash → row) and `meta.json`.
- **Search:** a binary prefilter selects the top 200, then int8 rescores them.
- **Incremental updates.** The structural index already maps (blob SHA, span) to content hash:
  - an unchanged blob costs nothing, and a moved function reuses its vector;
  - writes only append, and deleted rows are marked rather than removed;
  - compaction drops rows HEAD has not referenced for 14 days.
- **CI:** the files go in `actions/cache` and are never committed.

**Alternatives:**

- **pgvector in the local Supabase.**
  - **For:** it is already part of the stack, and `postgres` is already a devDependency (`package.json.tmpl:64`). HNSW gives about 3 ms against about 600 ms for a sequential scan at 100k × 768 (https://bigdataboutique.com/blog/hnsw-vs-ivfflat-how-to-choose-the-right-vector-index).
  - **Against:**
    - it needs Docker;
    - `db reset` wipes it;
    - harness tables in the app database show up as drift in `supabase db diff`, and as tables without RLS.
  - **Verdict:** only in a separate `CREATE DATABASE harness_ctx`, and only above about 100k functions.
- **sqlite-vec** (MIT/Apache, pre-v1): a native extension plus `node:sqlite` with `allowExtension`, for no gain at this scale.
- **LanceDB:** Rust native binaries; too heavy.
- **hnswlib-node:** no prebuilt binaries (node-gyp on every install) and no longer maintained. Rejected.
- **usearch** (Apache-2.0, prebuilt): the reserve option for more than 100k functions.

## 5. Privacy and supply chain

**Vendor data policies**

| Vendor | Trains on API data? | Retention / option | What to do |
|---|---|---|---|
| Voyage | **Yes, by default.** An org-admin opt-out gives zero-day retention † | – | Opt out first, or self-host via SageMaker or Azure |
| OpenAI | No | 30 days for abuse monitoring; Zero Data Retention on approval, which covers `/v1/embeddings` | – |
| Gemini | No on the paid tier; yes on the free tier | – | Use a paid project |
| Cohere / Mistral | Reported to train unless you opt out † | 30-day logs | Check before enabling |

**Controls**

- **Default off.** Enabling takes a human edit to a write-guarded `tools/embeddings.config.json`. The edit names the provider and pinned model, and adds a `dataPolicy` acknowledgement (date, who, "opt-out confirmed"). The adapter refuses a provider whose registry row says `trainsByDefault: true` unless the acknowledgement is present.
- **What leaves the machine:**
  - Only tracked source (`git ls-files`) under the roots `check-duplication.mjs` scans.
  - Never `.env*`, `supabase/seed.sql`, fixtures or generated files.
  - Every chunk passes `tools/secret-patterns.json`'s matchers first. A hit means the chunk stays local or is skipped.
- **Keys:**
  - Use a server-only name (`VOYAGE_API_KEY`). The `NEXT_PUBLIC_` / `EXPO_PUBLIC_` secret-name guards already block a public prefix.
  - Hooks read it from the environment. The agent cannot read `.env` (`.claude/hooks/lib/guard-rules.mjs:274-286`).
  - In CI, only a `schedule` / `workflow_dispatch` job gets it (as `osv-scan.yml:74-81` gates its scheduled jobs). It runs with harden-runner and `permissions: {contents: read, issues: write}`.
  - Add a key-shape rule to `secret-patterns.json` and `.gitleaks.toml` in lockstep. The `pa-` prefix needs verifying.
- **Zero npm dependencies.**
  - The API adapter uses plain `fetch` with no SDK, following eval-live's `adapters/live.ts`.
  - Local mode calls an endpoint the operator runs (`EMBEDDINGS_ENDPOINT`, e.g. `llama-server --embedding --pooling last` with Qwen's official GGUF). The model file is machine configuration, not repo content.
  - Running transformers.js inside the harness process is **rejected**:
    - its `onnxruntime-node` is a 211 MB tarball with binaries for every platform, and on Linux the install fetches about 236 MB of CUDA libraries from NuGet (https://github.com/huggingface/transformers.js/issues/1687);
    - it pulls in `sharp`, whose `@img/sharp-libvips-*` is **LGPL-3.0-or-later**, outside the `ALLOWED` licence list in `check-licenses.mjs`.
- **The licence gate cannot see model weights.** Add `tools/embedding-models.json` with the SPDX licence and pinned revision of each model, enforced by a module check. Apache-2.0 and MIT pass; CC-BY-NC (jina-code, SFR-Code) and OpenRAIL (Qodo) fail.
- **MCP.** An optional `neighbourhood_query` answers "neighbours of symbol X" from the cache only, with no network. That fits a `readOnly` self-authored row in `approved-tools.json`, like `corpus_search`. The `corpus_search` header already plans to "swap for embeddings later behind the same tool contract" (`tools/mcp/corpus-search-server.mjs:2-3`).

## 6. Recommendation: the `embeddings` opt-in module

**Shape.** It follows the eval-live module, enabled with `enable embeddings`:

- `tools/context/embed/` containing:
  - `adapter-voyage.mjs`
  - `adapter-openai-compat.mjs` (OpenAI, Gemini's compatible endpoint, llama-server, Ollama)
  - `store.mjs`
  - `normalise.mjs`
  - `probe.mjs`
- `tools/embeddings.config.json` and `tools/embedding-models.json`, both write-guarded;
- `.github/workflows/embeddings-sweep.yml`;
- `docs/modules/embeddings/README.md`, with red-proofs.

It also needs these registrations:

- an entry in `tools/modules.json` and in `installer/lib/layout.mjs` MODULES (a factory test checks the two match);
- write-guard rules for both config files;
- the key-shape rule in `tools/secret-patterns.json` and `.gitleaks.toml`.

**Models**

- **Hosted default:** `voyage-code-4`, pinned to its dated snapshot, 512-d int8 plus binary.
- **Local default:** Qwen3-Embedding-0.6B, truncated to 512-d.
- **No silent fallback between them.** Their vector spaces differ, so each has its own cache, and the dossier names the model that produced each hit.

**When it runs**

1. **Write time.**
   - An `async: true` PostToolUse entry embeds changed functions that are not yet cached. It has a 5 s timeout, fails open, and emits nothing.
   - The next synchronous dossier (the next PostToolUse, or SubagentStart for author agents) reads cached neighbours.
   - It shows **at most 2 pointer-shaped** `semantic` hits: import path and signature, never a body. Each needs cosine ≥ T_ctx **and** at least one deterministic corroborator.
   - Every hit shown is logged in the seen-ledger.
   - This keeps non-determinism off the synchronous path, consistent with `research/write-time.md`.
2. **Review time.**
   - Before the architecture and torvalds reviewers are dispatched, one batch call embeds the changed functions (20 s timeout).
   - On failure the dossier says `semantic layer: UNAVAILABLE (<reason>)`, loudly.
3. **Nightly.** Probe check, then incremental embed, then an all-pairs binary prefilter, then structural corroboration, then **advisory issue sync**. Issues are labelled `advisory:semantic-dup` and follow the two-threshold rule in section 3.
4. **Model change.** Re-embed everything ($0.12–1.20 for 5k–50k functions), then run one trial sweep that opens no issues, then go live.

**Dossier entry**

```json
{ "kind": "semantic-neighbour", "a": "verticals/notes#toExcerpt", "b": "platform/text#truncateWords",
  "cos": 0.87, "model": "voyage-code-4-20260812/512/int8",
  "corroboration": { "sharedCallees": ["Intl.Segmenter"], "sharedTables": [], "sharedDtoFields": [],
                     "minhashJaccard": 0.18, "paramArityEqual": true, "returnShape": "string" },
  "tier": "context" }
```

**Tiers**

- **`context`:** cosine ≥ T_ctx. Shown to the writer and the reviewers; not tracked.
- **`advisory`** (becomes an issue), when all of these hold:
  - cosine ≥ T_adv;
  - at least one corroborator: shared callee, table or DTO field; equal arity plus return shape; or Jaccard ≥ 0.15;
  - both functions meet the minimum size;
  - they are in different files;
  - the pair is not allowlisted.
- **Never `owed`**, except through the committed-register bridge (section 3, rule 5).

Reviewers may answer with reuse, extract or justify. A justify answer closes the issue as accepted divergence. T_ctx and T_adv are **calibrated per model**, because cosine distributions differ between models.

**Evaluation (in `tests/`, offline in CI)**

1. **Seeds.** Take about 40 helpers from `packages/platform/*` and shared utilities. Plant three variants of each in a vertical:
   - **T3:** edited or reordered statements;
   - **T3+:** the 8 transformation operators of arXiv 2606.25272;
   - **T4:** a reimplementation written from the signature and docstring only, with different names and algorithm, **execution-verified** against the helper's own unit tests.
2. **Hard negatives.** Same topic, different job: `formatDate`/`parseDate`, `toCents`/`fromCents`.
3. **Metrics:**
   - recall@5 of the true helper, structural alone versus structural plus embedding, per split;
   - precision of the advisory tier;
   - Jaccard overlap of the advisory set across 5 runs and 2 machines (target ≥ 0.98);
   - p95 latency and cost.
4. **Ship bar:**
   - **Recommend the module:** T4 recall@5 improves by ≥ 15 percentage points at advisory precision ≥ 0.8, with the owed set unchanged (asserted).
   - **Ship as context-only:** an improvement of 5–15 points.
   - **Do not ship:** under 5 points.
5. **Replay.**
   - Commit the fixture vectors for the pinned model (about 100 KB) so CI replays them deterministically.
   - A dispatch-only live job re-embeds the fixtures and fails if probe cosine drops below 0.995.

## Not verified first-hand

- Voyage's terms of service and opt-out wording, and its key prefix.
- Gemini Embedding 2's MTEB-Code figure.
- Whether voyage-code-4 shares a vector space with voyage-4-nano.
- Cohere's and Mistral's training defaults.
- CPU throughput: an estimate from arithmetic, not a measurement.
- Brute-force timings: from one 4-vCPU container running scalar JS. SIMD or worker threads would be faster.