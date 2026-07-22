# Module: eval-live

The live-model evaluation lane. The scaffold's eval package is fixture-scored by
design (deterministic fakes, no network in any gate); this module adds the pieces
that face a REAL served model — behind the same `InferenceProvider` port — plus
the two cheap gates that keep live evaluation honest: GBNF grammar
pre-validation and exemplar/holdout disjointness.

## What it adds

| File | Purpose |
| --- | --- |
| `packages/eval/src/adapters/live.ts` | OpenAI-compatible chat-completions adapter (plain fetch, no SDK; the only directory depcruise lets near a model endpoint) |
| `packages/eval/src/adapters/live.test.ts` | contract tests with injected fetch — run in the default unit lane, no GPU |
| `packages/eval/schemas/extraction-result.schema.json` | JSON Schema mirror of the zod contract, consumed by the grammar gate |
| `tools/check-gbnf.mjs` | runs llama.cpp's json_schema_to_grammar converter in check mode over every schema |
| `tools/check-eval-disjoint.mjs` | fails if any holdout item's text appears among the prompt exemplars |
| `.github/workflows/eval-live.yml` | self-hosted-GPU lane: cheap gates first, then the live run |

## Prerequisites

- A self-hosted runner labeled `[self-hosted, gpu]` with:
  - a llama.cpp checkout at `LLAMA_CPP_DIR` (for the grammar converter),
  - a served OpenAI-compatible endpoint at `EVAL_LIVE_ENDPOINT`
    (e.g. `llama-server -m model.gguf` → `http://127.0.0.1:8080/v1/chat/completions`;
    the model path is the runner's deployment config, never repo content).
- Nothing for the adapter tests and the disjointness gate — those run anywhere,
  today: `node tools/check-eval-disjoint.mjs`.

## How enabling works

```
npx next-expo-supabase-agent-harness enable eval-live
```

`live.test.ts` joins the default vitest lane immediately (fake fetch — proves the
adapter's request shape and schema enforcement without a model). The workflow is
dispatch-only until the GPU runner exists; uncomment its `schedule:` block for a
nightly live eval afterwards. The `gpu` runner label is already declared in the
scaffold's `.github/actionlint.yaml` (the base ships it), so the actions-lint
lane accepts the workflow without further config. No `tools/harness.config.mjs`
change — the workflow IS the live gate (though `eval-disjoint` is cheap enough
to add to the validate chain if contamination ever bites you).

## How its gates can FAIL (anti-vacuity)

- **gbnf**: on a machine with `LLAMA_CPP_DIR` set, replace
  `extraction-result.schema.json`'s body with
  `{"$ref": "https://elsewhere.example/nope.json"}` (an unresolvable remote ref)
  → the converter raises, the gate reports `conversion FAILED` → FAIL. Malformed
  JSON fails the same way, and a converter that emits no `root ::=` rule is also
  red (a rootless grammar constrains nothing). Verified against llama.cpp's
  `examples/json_schema_to_grammar.py` at master, 2026-07-18 — note the converter
  TOLERATES some unsupported keywords (e.g. `"format": "email"` passes through),
  so an unconstrained keyword is not a reliable red-proof. Unset `LLAMA_CPP_DIR`
  locally → loud SKIP; with `HARNESS_REQUIRE_TOOLCHAINS=1` (the workflow sets it)
  → FAIL closed.
- **eval-disjoint**: paste any `holdout.json` item's input text into
  `packages/eval/prompts/extract.v1.md` → FAIL naming the item and the file.
  (Prompts are hash-locked, so do this in a scratch branch.)
- **adapter**: break `schema.parse` out of `chatJson` → the "raw model text never
  escapes" test fails in the default unit lane.

## Honest limits

- The zod schema (`extract.ts`) and its JSON Schema mirror are kept in lockstep
  BY REVIEW, not by a generator — the mirror's `description` says so. If they
  drift, the grammar constrains a shape the code rejects; the live lane surfaces
  that as schema-parse failures.
- The live scoring script (holdout → adapter → `score.ts` → calibration report)
  is a marked TODO in the workflow: scoring policy (thresholds, calibration
  binning) is a project decision. The plumbing on both sides of it ships here.
- harden-runner is not used on the self-hosted jobs — its agent targets
  GitHub-hosted VMs; egress control on your GPU box belongs to its firewall.
  (The scaffold's harden-runner coverage check exempts self-hosted jobs for
  exactly this reason.)
