# Context-paradigm research, 2026-10-01

The research and design round behind [`design/SINGLE-HOME-2026-10.md`](../../SINGLE-HOME-2026-10.md).
It was run by Claude Code research agents, and every internal fact refers to the 2.0.0 stack head
(`stack/52-i37-work-plan`, commit `b158f5a`), not to `main`. External figures marked † or
"not verified" in a report were read from search-engine extracts, not from the primary source.

**The question.** How can the harness recognise code that is similar to, or touches, other code,
and deliver that to the authoring agent and the architecture reviewer, without the agent loading
the codebase, so that agent-written code stays free of duplication, parallel implementations and
needless complexity?

## Wave 1: the harness and the state of the art

| File | Subject |
|---|---|
| [w1-harness-reviewer-pipeline.md](w1-harness-reviewer-pipeline.md) | The reviewer lifecycle, every extension point a context system could use, doctrine constraints, cost envelope |
| [w1-stack-anatomy.md](w1-stack-anatomy.md) | Vertical slots, the SQL-to-screen concept seams, generated indexes, deliberate vs accidental parallels, SQL rails |
| [w1-hooks.md](w1-hooks.md) | Claude Code hook surfaces for injecting context, and the open probes |
| [w1-clone-similarity-sota.md](w1-clone-similarity-sota.md) | Clone detection, rename-invariant hashing, anti-unification, parsers, SQL-to-TS linking |
| [w1-agent-context-retrieval-sota.md](w1-agent-context-retrieval-sota.md) | Repo maps, code graphs, push vs pull, retrieval for review |
| [w1-design-quality-signals.md](w1-design-quality-signals.md) | Change coupling, smells on TypeScript, Ousterhout and Torvalds heuristics, a 30-row signal catalogue |
| [w1-ai-slop-evidence.md](w1-ai-slop-evidence.md) | Empirical evidence on agent-written code, a slop taxonomy, interventions, eval design |

## Wave 2: the maintainer's three decisions

| File | Subject |
|---|---|
| [w2-write-time.md](w2-write-time.md) | Delivery to the authoring agent at write time |
| [w2-advisory-inventory.md](w2-advisory-inventory.md) | Every non-blocking output the harness emits, and whether it can be keyed |
| [w2-issue-sync.md](w2-issue-sync.md) | Syncing advisories to GitHub issues safely |
| [w2-embeddings.md](w2-embeddings.md) | The optional embedding layer |
| [w2-completeness-critique.md](w2-completeness-critique.md) | Contested claims, gaps, and six tensions every design had to resolve |

## Design round

Four architects designed independently, three judges scored them, a synthesis became v1, four
adversarial critics attacked it, and a revision became v2 (`design/SINGLE-HOME-2026-10.md`), which
a final pass fact-checked against the stack head.

| File | Angle |
|---|---|
| [design-minimal-core.md](design-minimal-core.md) | Minimal deterministic core |
| [design-concept-atlas.md](design-concept-atlas.md) | Stack-aware concept graph |
| [design-obligation-ledger.md](design-obligation-ledger.md) | Enforcement-first obligation ledger |
| [design-prevention-loop.md](design-prevention-loop.md) | Prevention at authoring time, plus a refactoring loop |
| [plan-v1.md](plan-v1.md) | The synthesis the critics attacked |
