# Can a public benchmark show this harness works?

**Captured 2026-08-13 against harness 0.9.9-evidence. Untracked working note — commits nothing.**

Companion to [`20260813-harness-landscape.md`](./20260813-harness-landscape.md), which named
*"no outcome oracle"* as gap #1 and specified `later1` as the answer. This note asks the narrower
question: **is there a publicly available benchmark that could measure whether Claude Code
(Opus 5, ultracode) produces better results inside this harness than outside it?**

Method: a 13-agent research workflow — six survey lenses, each adversarially re-verified by a
second agent instructed to refute it. Twelve agents completed; the final completeness critic died
on a network error, so this sweep is one lens short of its design and should be read as thorough
rather than exhaustive. The load-bearing external fact (Harbor) was re-verified by hand.

---

## 0. The answer

**No public benchmark can measure this harness. One public *runner* can host a private one, and
Claude Code ships a native harness-off switch.**

That is not a gap in the field. It follows from four things, each sufficient on its own.

### 1. The harness is not transplantable

Every public benchmark materialises **its own** repository into a sandbox — Django, sympy, Babel,
Redis. This harness is a scaffold generator for one shape: a pnpm monorepo with Next.js 16 web and
Expo 57 mobile over Supabase. Of the 36 gates in `template/base/tools/harness.config.mjs`, roughly
31 are stack-bound (`expo-policy`, `schema-rls`, `tenancy`, `migrations`, `query-shapes`,
`route-manifest`, `security-headers`, `styleguide`, `mobile-perf`, …). Dropped into `sympy` they
are inert or vacuous — and this repo's own doctrine already rules that vacuous truth is never
`effective`.

So the honest experiment is never *"harness vs no harness."* It is *"a hand-ported generic
enforcement shell vs nothing"* — maybe 20% of the harness, hand-carried into each container. **Budget
the port as the real cost, not the benchmark run.**

Worse, a naive attempt is actively negative. `stop-validate-gate.mjs` shells out to
`tools/validate.mjs`, the RLS suite, vitest and jest-expo. In a foreign repo all four are missing →
stderr → exit 2 → the turn cannot end, up to `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=8`. You would be
measuring the hook's failure mode. Separately, `guard-rules.mjs` denies `curl`, `wget`, `sed -i`,
`git apply`/`patch` and interpreter `-e` writes in every spelling — much of a terminal benchmark's
working vocabulary.

### 2. The arithmetic rules public benchmarks out

Run-to-run variance is larger than the effect you are hunting. From arXiv:2602.07150 (60,000
trajectories over SWE-bench Verified, 500 tasks), read directly by the sweep:

| condition | pass@1 SD |
|---|---|
| temperature 0.6 | 0.7 – 1.4 pp |
| temperature 0.0 (greedy) | 1.0 – 1.8 pp |

**Temperature 0 does not remove variance — it measured worse.** Single-run pass@1 estimates swing
**2.2 – 6.0 pp** depending purely on which run you look at.

A paired McNemar design (same task, harness-on vs harness-off) needs, at α=0.05 two-sided and
80% power, with discordance rate π_d:

| effect δ | π_d=0.10 | π_d=0.15 | π_d=0.20 | π_d=0.30 |
|---|---|---|---|---|
| 2 pp | 1,960 | 2,941 | 3,922 | 5,884 |
| 3 pp | 870 | 1,306 | 1,742 | 2,614 |
| **5 pp** | **312** | **469** | **626** | **940** |
| 8 pp | 120 | 182 | 243 | 366 |
| 10 pp | 76 | 115 | 155 | 233 |

Calibrating a flaky-task model against the observed SDs puts π_d around **0.15 – 0.30**. So a 5 pp
effect needs **312 – 940 matched task pairs**. Terminal-Bench 2.1 has **89 tasks**. *The instrument
is smaller than the measurement error.*

### 3. The obvious targets are saturated, retired, or dead

| Target | Status |
|---|---|
| **Terminal-Bench 2.1** | ~89% and saturating. Artificial Analysis: GPT-5.6 Sol (xhigh) 89.5%, Claude Opus 5 (Max Effort) 89.1%, Grok 4.6 88.4%. A handful of tasks of headroom across the whole suite. |
| **SWE-bench Verified** | OpenAI stopped treating it as a frontier measure in Feb 2026. A 138-task audit found **59.4%** had flawed test design or problem statements. |
| **HAL** (Princeton) | **Archived 2026-07-01.** Leaderboard no longer updated through it. Ignore any advice that still recommends it. |
| **METR Vivaria** | Not archived, but METR now directs users to Inspect. Last push 2026-05-18. |
| **SWE-Lancer** | Repo archived 2025-07-18; merged into `openai/preparedness`. |

### 4. The closest published analogue is a null result

ETH Zurich SRI, *"Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding
Agents?"* (MemAgents @ ICLR 2026, oral runner-up; code at `github.com/eth-sri/agentbench`).
Design: none vs LLM-generated vs human-written context files, multiple agents and models, 138 Python
tasks over 12 repos plus SWE-bench Lite.

> **No improvement in task success rate. >20% higher inference cost. Broader-but-not-better
> exploration. LLM-generated verbose files actively hurt.**

This harness is a much heavier version of the same intervention, and its cost delta will exceed 20%
because gates and the chain consume turns that produce no patch. **On issue-resolution benchmarks the
honest prior is that this harness scores worse.** If you run SWE-bench and score lower, that is the
expected result and not evidence the harness is bad — it is evidence of a benchmark mismatch.

This aligns with the landscape artefact's own cross-cutting law: everything with a published number
works by making a *deterministic, non-LLM process* decide something the model would otherwise decide.
Everything that works by asking the model to be more careful has no number behind it.

---

## 1. What *is* newly possible

Three things changed the answer from "build everything yourself" to "borrow the plumbing."

### `claude --bare -p` — a native harness-OFF arm

Anthropic ships the ablation switch. `--bare` skips auto-discovery of hooks, skills, plugins, MCP
servers, auto memory and `CLAUDE.md`, and is documented as the CI/reproducibility mode that "will
become the default for `-p` in a future release."

Two caveats that will silently corrupt the experiment if missed:

- `--bare` suppresses the instruction/hook/skill layers but **does not delete gate scripts sitting in
  the tree as files**. A true OFF arm also needs a stripped worktree.
- Bare mode **never reads OAuth credentials** — you must set `ANTHROPIC_API_KEY`.

### Harbor — a public runner that takes a private task suite

`github.com/harbor-framework/harbor` (originating org: laude-institute), Apache-2.0, ~4.2k stars,
~1,431 commits, actively pushed 2026-08-13.

> ⚠️ **Version unresolved.** My own fetch and the adversarial verifier both read **v0.16.1**; one
> survey agent reported v0.21.0 and noted the releases page rendered implausible dates. Pin from a
> registry read before relying on it. This is exactly the failure mode the landscape artefact's
> `next14` exists to catch.

Why it matters: `src/harbor/agents/installed/claude_code.py` is a first-class Claude Code adapter
whose injection points map onto this harness's surfaces almost one-for-one.

| Harbor knob | What it carries |
|---|---|
| `config` (host path or inline JSON) | uploaded and passed as `claude --settings <path>` — **this is your hook injection point** |
| `skills_dir` | copied into `$CLAUDE_CONFIG_DIR/skills/` |
| `memory_dir` | pre-seeded auto-memory |
| `mcp_servers` | written to `$CLAUDE_CONFIG_DIR/.claude.json` |
| `CLI_FLAGS` | `--append-system-prompt`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--max-budget-usd`, `--permission-mode`, and `--effort` whose enum **includes `ultracode`** |

The adapter declares `SUPPORTS_ATIF`, `SUPPORTS_RESUME`, `SUPPORTS_LOAD_NATIVE_TRAJECTORY`,
`SUPPORTS_HANDOFF`, `SUPPORTS_CONFIG`. For everything `settings.json` cannot carry (`CLAUDE.md`, the
gate scripts, the chain, the obligations registers) you subclass `BaseInstalledAgent`, override
`install()`, and use `exec_as_root`/`exec_as_agent`.

**The decisive feature:** `harbor run --repo <org>/<repo> -d <dataset>` resolves a task suite from
**any** git repo containing a `registry.json`. Public plumbing, private tasks. That is `later1`
without writing a runner.

### Published precedent that harness effects are real

- **Claw-SWE-Bench** (arXiv:2606.12344) — a benchmark *for agent harnesses*. Five harnesses × two
  models: model choice moves Pass@1 by 29.4 pp; **harness choice moves it 27.4 pp with the model
  held fixed.** Covers 8 languages including TypeScript. *Fine print:* its extreme case (19.1% vs
  73.4%) is measuring adapter **competence** — patch extraction, tool plumbing — not process
  discipline. A broken adapter vs a working one is not gates vs no gates.
- **Harness-Bench** (arXiv:2605.27922) — harness effects across six harnesses and eight backends.
- **"Stop Comparing LLM Agents Without Disclosing the Harness"** (arXiv:2605.23950) — the Binding
  Constraint Thesis and a variance-decomposition protocol. Methodology, no code.
- **SkillsBench** (arXiv:2602.12670) — skills moved 33.9% → 50.5%.

---

## 2. Ranked options

### A. Harbor + a private task suite over your own template — **recommended**

This is `later1` with public plumbing. Author tasks over the actual scaffold, seeded with defects the
harness claims to catch: a pre-existing test suite a careless patch breaks, a planted EOL dependency,
an RLS hole, a spec the agent can quietly under-deliver on.

- **Proves:** whether the harness improves *outcomes on the axes it defends*, on its own stack.
- **Does not prove:** anything about generic coding capability, or that the result generalises to
  other stacks.
- **Cost:** ~$30–80 per 20-task sweep; ~$200–500 for a 3-seed 2-arm A/B (the landscape artefact's own
  costing, unchanged).
- **Why it works:** score with **gate exit codes**, so no LLM judge sits in the primary metric.
  That matters — TeamBench found LLM verifiers approved 49.4% of submissions a deterministic grader
  rejected, and *removing* the verifier raised mean score by 5.5.

### B. ImpossibleBench — the best conceptual fit publicly available

`github.com/safety-research/impossiblebench` (MIT). Scores **cheating rate** on
specification-conflicting tasks: test-assertion rewriting, special-case shims, state-gaming. Any pass
on an impossible task is by construction a spec violation.

- **Lower is better**, so harness overhead cannot inflate the score — the one place the ceiling
  argument runs in your favour.
- Attacks exactly what the guards defend: a Stop hook forbidding "done" without a green chain, and
  write-guards blocking edits to test and enforcement surfaces.
- Claude Code is **not** native here — it arrives via Inspect's agent bridge (`inspect_swe`).
- Small repo (8 commits); expect to read source, not docs.

### C. SlopCodeBench — long-horizon erosion

`github.com/SprocketLab/slop-code-bench` (MIT, arXiv:2603.24755). Structural degradation and
verbosity across 93–196 checkpoints of iterative development. **`--agent claude_code` is verbatim in
the quickstart** and the paper evaluates agents in their *native CLI harnesses* — rare and exactly
right for this question.

- **Cost is the real constraint:** the paper's prompt-intervention studies cost **$84–$423 per
  configuration**, two-hour wall-clock cap *per checkpoint*. Two arms × seeds is high-hundreds to
  low-thousands USD and days of wall-clock.

### D. A SWE-bench-family arm — run it as *falsification*, not as the headline

Multi-SWE-bench / SWE-bench Multilingual (the 300-instance "flash" split) gives real TypeScript and
JavaScript coverage, which Terminal-Bench and vanilla SWE-bench Verified (Python-only) do not.

Run it to answer *"does the harness cost me generic capability, and how much?"* — a non-inferiority
guard. Expect a decrease. Publish it anyway; the landscape artefact's §7 discipline says an
unmeasured claim is not a claim.

### Also worth knowing

- **promptfoo** ships `anthropic:claude-agent-sdk` (alias `anthropic:claude-code`) with `settings`,
  `hooks`, `permission_mode`, `max_budget_usd` as config — the cheapest possible rig: two provider
  entries differing only in `settings`/`working_dir`.
- **Inspect AI + `inspect_swe`** — `claude_code()` as a standard solver, custom scorers make a bespoke
  honest-reporting eval cheap. ⚠️ **Defect found by reading source:** `inspect_swe` writes
  `$HOME/.claude/settings.json` itself for its `apiKeyHelper` and exposes no `settings=` parameter,
  so **user-scope hooks get clobbered**. Inject at *project* scope (`cwd/.claude/settings.json`).
- **Vercel `next-evals-oss`** — Next.js-specific, `agent: "vercel-ai-gateway/claude-code"` is a
  first-class field. Closest public benchmark to half your stack. Published economics: $0.018–$18.21
  and 115–771 s per eval.
- **SecRepoBench** — `--agent claudecode` first-class, but C/C++ and **no license statement on the
  repo**; resolve licensing before any published use.

---

## 3. How to run it

### The paired ablation, which is the whole experiment

```bash
# ON arm — inside a worktree with the harness installed
claude -p "$TASK" --model claude-opus-5 \
  --output-format stream-json --verbose --include-hook-events \
  --permission-mode acceptEdits --max-turns 80 --max-budget-usd 5 \
  --no-session-persistence > on/$TASK.$REP.jsonl

# OFF arm — same task, stripped worktree, auto-discovery disabled
claude --bare -p "$TASK" --model claude-opus-5 \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits --max-turns 80 --max-budget-usd 5 \
  --no-session-persistence > off/$TASK.$REP.jsonl
```

`--include-hook-events` gives gate-fire counts for free. The terminal `result` message carries
`total_cost_usd`, `num_turns`, `session_id`. Add `CLAUDE_CODE_ENABLE_TELEMETRY=1` with
`OTEL_METRICS_EXPORTER=otlp` for `claude_code.token.usage`, `claude_code.cost.usage`,
`claude_code.code_edit_tool.decision`.

> **Score both arms with the same external oracle, run outside the agent.** Never let the harness
> grade itself, or you have measured a tautology. This is the one rule that invalidates everything
> if broken.

### Harbor

```bash
uv tool install harbor          # or: pip install harbor
export ANTHROPIC_API_KEY=...

# free smoke test — the oracle agent costs nothing beyond compute
harbor run -d terminal-bench/terminal-bench-2 -a oracle -l 5

# stock Claude Code, no harness
harbor run -d <dataset> -a claude-code -m anthropic/claude-opus-5

# your own task suite from your own repo
harbor run --repo <org>/<repo> -d <dataset> -a claude-code -m anthropic/claude-opus-5

# harnessed arm: subclass BaseInstalledAgent, override install()
harbor run --repo <org>/<repo> -d <dataset> \
  --agent-import-path my.pkg:ClaudeCodeHarnessed \
  -m anthropic/claude-opus-5 --ak "config=$PWD/settings.json"
```

Docker required locally. `--n-attempts k` re-runs each task and reports pass@k. `harbor trial regrade`
re-scores recorded trajectories **without re-incurring model cost** — use it liberally. Cloud fan-out
via `--env daytona -n 32` or `--env modal --n-concurrent 500`.

### Inspect + ImpossibleBench

```bash
pip install inspect-ai inspect-swe
# ImpossibleBench: clone github.com/safety-research/impossiblebench, follow its README
```

```python
from inspect_swe import claude_code
Task(dataset=..., solver=claude_code(), scorer=..., sandbox="docker")
```

Remember the project-scope settings workaround above.

### Statistical design — non-negotiable

- **Paired, not unpaired.** Same task, both arms. McNemar on discordant pairs:
  `n = [z_{α/2}·√π_d + z_β·√(π_d − δ²)]² / δ²`
- **k ≥ 3 repeats per arm minimum**, 5 preferred. Terminal-Bench's own docs note variance is
  concentrated in a small set of unstable tasks — precisely the structure that makes pairing pay off.
- Report **pass@1, pass@k and pass^k** (all-k-succeed). pass^k is the one that speaks to reliability,
  which is what a gates harness actually claims to sell.
- **Normalise for cost.** A harness that burns 5× the tokens for +2 pp is not obviously better.
  Report the cost-quality Pareto frontier, not a single number. The ON arm pays roughly 24,337 ms of
  validate chain and 50,531 ms of Stop chain per turn end — the committed figures in
  `scripts/chain-budget.json`, measured on one Linux GitHub runner, not portable to your hardware.

---

## 4. Honest limits

- **The completeness critic did not run.** One of thirteen agents failed on a network error. Treat
  this as a thorough sweep, not an exhaustive one.
- **Adversarial verification changed real answers.** Of the items checked, one benchmark's
  harness-pluggability claim was **invented** (ChainSWE — the paper states the opposite: *"We hold
  the agent scaffold fixed"*), one methodology attribution fused two unrelated papers under a wrong
  title, and one cited page contained none of the content attributed to it. Several task counts,
  versions and dates were wrong in the first pass. **Do not act on any figure here without opening
  the primary source** — the same caution §7 of the landscape artefact applies to itself.
- **The Harbor version is unresolved** (v0.16.1 vs v0.21.0). Pin from a registry read.
- **This changes no commitment.** Nothing here is scheduled, entered in `scripts/obligations.json`,
  or owed by any release. `later1` remains a `later`-tier item, and the ordering advice in the
  landscape artefact §8 still stands: close the reward-hacking paths first, put a boundary and a
  governor under the run second, anchor the reviewer third, **and only then measure outcomes**.
- **The field moves weekly.** Captured 2026-08-13.

## 5. If you do only one thing

Run the free Harbor oracle smoke test to confirm the plumbing, then author **five** tasks over your
own template — not twenty — and run them 3× in each arm with `claude -p` and `claude --bare -p`.
That is a few dollars and an afternoon, and it tells you whether the measured effect is anywhere near
the 2.2–6.0 pp noise floor before you commit to the full `later1` build.

If the pilot shows nothing above noise, that is a finding worth having, and it is the finding this
repo's own doctrine would want recorded.
