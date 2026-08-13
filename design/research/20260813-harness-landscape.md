# The harness landscape, and what this repo should take from it

**Captured 2026-08-13 against harness 0.9.9-evidence.** Frozen artefact with sources, grades and closures: [`20260813-harness-landscape.json`](./20260813-harness-landscape.json). Method: an 18-agent research workflow — four Prime Agent deep dives, seven survey clusters, two maps of this repo, three adversarial critiques, one synthesis. 3,167,349 subagent output tokens, 812 tool uses, 0 agent errors, 258 unique sources.

This is a research record and a roadmap. **It commits nothing.** No item here is scheduled, entered in `scripts/obligations.json`, or owed by any release.

---

## 0. The two corrections that reframed the question

The work was commissioned to answer: *port Prime Agent to TypeScript to eliminate its root-privilege requirement.* Both halves of that premise are false, and finding out why was worth more than the port would have been.

**Prime Agent is already TypeScript.** `PrimeIntellect-ai/prime-agent`, MIT, launched 2026-08-05. GitHub language bytes: TypeScript 11,773,264 against Python 167,606. It is an npm-workspaces monorepo on Node ≥ 22.8, built on `@earendil-works/pi-coding-agent`. The Python is *one component* — `prime-agent-runtime`, an IPython kernel the TypeScript host drives as the model's **action substrate**. The mistake is an easy one: every writeup leads with "the model writes and runs Python in a persistent kernel."

**It needs no root.** Its own docs say so three times, in three files:

> "Workers and kernels are separate processes for lifecycle and failure containment, **not security sandboxes**. They normally run with the same operating-system permissions as the client." — `docs/architecture.md`

The only `sudo` in the distribution is `install.sh` bootstrapping Node via apt/apk, gated on Node being absent and skipped entirely on a machine that has it (Homebrew on macOS). What you most likely read about is issue #705: `npm install -g` failing `EACCES` against a root-owned `/usr/local` prefix. Fix PR #706 is still unmerged. The single transferable lesson is small and real — **never `npm install -g` into a root-owned prefix**; ship via `npx`, a repo-local `node_modules/.bin`, or `NPM_CONFIG_PREFIX=~/.local`.

The one place root buys a capability is the *optional* sandbox extension, and on macOS that is `sandbox-exec`, which needs no root at all.

> ⚠️ **Supply chain.** `github.com/prime-RLM-agent/prime-agent` is a typosquat created 2026-08-08, three days after the genuine launch, with the real project's tagline copied verbatim. It ranks on some searches. If you ran an installer, confirm it resolved to `PrimeIntellect-ai`.

### And a third correction, which is the one that actually matters

The identification agent relayed Prime Agent's headline numbers. The evidence deep-dive then checked them against the benchmark authorities and they did not survive:

| Claim | What the authority says |
|---|---|
| ARC-AGI-3 **95.5%** on Opus 5 | Vendor-run on the **public** set. ARC Prize's verified semi-private row for Opus 5 is **30.2%**. ARC Prize policy requires public/semi-private agreement within ±15pp before a score is accepted. Prime Agent appears on **no verified leaderboard** |
| EmulatorBench emulators from scratch | Prime Intellect's own preview benchmark. Actual table: 0.208 / 0.275 / 0.047. **On Opus 5, Claude Code beat Prime Agent — 0.062 vs 0.047** |
| Long-context benchmark wins | Beats Claude Code on Opus 5 by ~1–2pp six times out of nine, loses three. The large gains in its tables are all on the **weak open-weight model** |
| SWE-bench / Terminal-Bench / SWE-Lancer | No entries exist |

**For a repo already running Opus 5 in Claude Code, Prime Agent's harness gains are approximately zero.** That single fact removes any argument for adopting its architecture, and redirects the whole question from orchestration cleverness to containment and evidence discipline.

---

## 1. What Prime Agent actually is

Two ideas, both worth understanding even though neither transfers wholesale.

**The RLM substrate — "context as a variable."** It collapses the tool menu to exactly one tool: a persistent IPython kernel whose heap survives turns. The model does not emit `read_file` / `bash` / `spawn_subagent` calls; it writes Python. Three consequences follow. Large data lives as a *named variable* outside the token window rather than as transcript text. Delegation becomes an ordinary function call — `await rlm("sub-task")` spawns a child with its own kernel and history, so fan-out is a loop and reduction is code. Control flow — retries, filtering, conditions — is expressed as code rather than as prose the model re-reasons each turn.

The seam that matters is not the REPL. It is this, from `docs/architecture.md`: *"Typed host requests return authoritative operations to the TypeScript session."* The kernel is scratch space; every authoritative act is a typed request back into TypeScript, which authorises it. One in-process chokepoint that a differently-spelled command cannot route around.

**The Continual Harness.** Weights stay fixed; the *harness* learns. Lessons persist as supplemental prompts, memories, skill descriptions and subagent specs, each with a recorded refinement history, driven by `/refine`. It is safer than its reputation for one structural reason: refinement can only write typed JSON records into `harness/harness_state.json`. A `skill` refinement is a *pointer at an already-installed callable*, not new code. The base system prompt is refused by id. No file outside the store is touched.

Plus a daemon-backed long-running mode: supervisor, session workers, heartbeats, goals, schedules, and an autonomous mode bounded by token/turn/time budgets — structurally the same shape as this repo's Stop validate-gate.

### The three-question verdict

**Replace the IPython substrate with a Node one? No — and not close.** The blocker is structural. Prime Agent's core move is `allToolNames = new Set(["ipython"])`, and there is no configuration seam in the Claude Code CLI that lets a harness collapse the tool menu, because **this repo configures a CLI it does not own**. Every enforcement layer here is keyed to built-in tool names: PreToolUse matchers are exact tool names, the write-guard's ~90 protected path regexes operate on `Edit`/`Write`/`MultiEdit` payloads, the mcp-guard parses `mcp__server__tool`. A `ts_exec` substrate would sit *beside* all of that, not under it, and the 134-rule table would see one opaque call whose contents it cannot inspect.

Even setting the seam aside, the economics point the wrong way. Anthropic's own published counter-result: on τ²-bench, whose turns are sequential single calls, programmatic tool calling left scores unchanged at **~8% higher cost**. "Run gate, read verdict, fix, re-run" is exactly that shape. The measured 20–40% input-token wins are for 10–49 tool definitions with large fan-out result sets — not this workload. And Node documents that `stripTypeScriptTypes` output "should not be considered stable across Node.js versions," which is disqualifying for gates that must agree across machines.

*What is lost:* context-as-a-variable, delegation as ordinary concurrency, skills as typed callables. The first is genuinely valuable and **recoverable at S effort without the substrate** — see `next10`, bounded output with spill-to-file. The other two are not recoverable and, on current evidence, not worth a runtime rewrite.

**Adopt `@anthropic-ai/sandbox-runtime`? Yes as an opt-in module, no as the default — and the more important answer is that the *native* Claude Code sandbox should come first and is currently missing entirely.** Confirmed: no `sandbox` key anywhere in either settings tree. Native is Seatbelt on macOS with nothing to install, enforced by the kernel on the running process rather than on the command string, and it protects `.claude/hooks`, `.claude/agents`, `.mcp.json` and settings with a deny **no `allowWrite` or Edit rule can lift** — a strictly stronger version of the `HARNESS_ALLOW_SELF_EDIT` tripwire. Anthropic reports 84% fewer permission prompts, which is what makes a long unattended run viable at all.

`srt`'s distinct value is that it is the only option putting the seven hooks and two MCP servers *inside* the boundary — and for this repo those processes are the entire enforcement surface. It cannot be the default: docker is documented incompatible, unix sockets are blocked, and the Stop chain's `rls-isolation` step needs live Supabase, so excluding it reopens exactly the surface being sandboxed. It is also a Beta Research Preview whose config format may change.

**Build the typed capability broker? No — the seam already exists, better contained.** Prime Agent needs `host.request` *because* its action space is arbitrary code with no chokepoint between plan and execution. This repo's chokepoint is PreToolUse over a pure-data 134-rule table with symlink realpath resolution, append-only migration enforcement, default-deny MCP over a reviewed registry, and fail-closed `hookio` semantics. That is a genuine broker; it is simply spelled as hooks.

The decisive argument is the research's own unanswered question: *"Two independent enforcement lists that must agree is a defect generator."* This repo learned that lesson expensively — `scripts/check-escape-registry.mjs` exists because `decision-groups.json` carried a write-guard rule and a seeded entry for multiple releases while being absent from `ESCAPE_LISTS`. Adding a third list to reconcile is a regression dressed as an upgrade.

### What is actually worth taking

Three items, all small, none needing the substrate:

1. **Workspace-fingerprint anti-thrash** (`autonomous.ts`) — refuse to re-run a failed gate when the worktree is byte-identical, and still count the attempt. → `now4`
2. **Subagent caps** (`agent-messages.ts`) — payload ceiling that *rejects rather than truncates*, spawn depth, fan-out rate, unknown options fail rather than being ignored. → `now6`
3. **Bounded output with spill-to-file** (`output-accumulator.ts`). → `next10`

And the inverse is worth stating plainly. The Continual Harness — described throughout the corpus as Prime Agent's most valuable idea — is **the one place this repo is already ahead**. `rampNote` throws when `until <= minVersion`, reds an unconsumed return value, reds a ramp below the lineage floor, and ratchets deadlines against the previous release tag. Prime Agent's ledger has no expiry, no reviewer verdict, and an `expectedOutcome` field nothing ever validates.

---

## 2. The landscape

The frontier has converged on a small set of structural moves, and almost none of them are prompt engineering.

| Harness | The one differentiating structural choice |
|---|---|
| **Codex** (OpenAI) | Two-file enterprise config: `managed_config.toml` you may change, `requirements.toml` you may not, with a **published precedence chain** and clamp-and-notify on conflict |
| **Cursor** | Three-tier autonomy — allowlist → sandbox → **classifier subagent** returning allow / take-a-different-approach / ask-human. Never asks the human first |
| **Cognition (Devin)** | A **clean-context reviewer** deliberately denied the coder's trajectory, plus writes single-threaded forever |
| **Antigravity** (Google) | The unit of work is an **Artifact carrying verification evidence** — plans, diffs, screenshots, browser recordings — not a chat summary |
| **Copilot / Agent HQ** | One **audit log of record** where agent actions land beside human actions, with streaming to external destinations |
| **Factory Droid** | Autonomy as a **fail-fast tier on the invocation** (`--auto low\|medium\|high`), non-zero exit with no partial changes |
| **Amp** | Rejects per-command approval outright: *"taking tools away… makes the agent look for an alternative"* |
| **SWE-agent** | **Apply, parse, revert** — broken code never enters the file or the transcript. The only mechanism in the corpus with a clean on/off ablation |
| **Aider** | Deterministic, budget-bounded context selection via PageRank over a def/ref graph |
| **Goose** | Completion defined by **shell checks that must exit 0** — commands the model cannot argue with |
| **Roo / Kilo** | Per-mode `fileRegex` write scoping, with a repairable error naming mode, pattern and attempted path |
| **OpenHands** | One append-only **event log** every component reads from, so runs replay by construction |

Two cross-cutting findings dominate:

**Execution safety moved from parsing strings to OS confinement.** Codex uses Seatbelt / bwrap+seccomp; Cursor uses Seatbelt / Landlock+seccomp. The text guard became advisory; the kernel became the control. This repo's bash guard is currently the pattern the field moved past — and its own docs say so: *"Guards are tripwires, not sandboxes."*

**Everything with a published number works by making a deterministic, non-LLM process decide something the model would otherwise decide.** SWE-agent's linter reverting a bad edit (18.0% → 15.0% without it). Aider's ranked map choosing context inside a token budget. Goose's shell checks defining done. Roo's `fileRegex` deciding what a mode may write. Everything that works by asking the model to be more careful has **no number behind it** — including, measurably, TDD prompting and anti-slop instructions.

### Anti-patterns the field has already paid for

- **Always-on context files as the primary knowledge mechanism.** 138 real tasks, four agents: LLM-generated `AGENTS.md` cut success ~3%, developer-written gained ~4%, both raised inference cost ~19–20%. Agents are "too obedient" — naming a tool in the file drove its invocation from near-zero to ~2.5× per instance. *(Read the caveat in §7 before acting on this one.)*
- **Partial egress control presented as a firewall.** GitHub documents in its own product that the coding-agent firewall does not cover MCP servers or setup steps. An allowlist with named uncovered paths is a false assurance.
- **Browser subagents sharing workspace credentials.** Antigravity: instructions hidden in 1px font drove credential and source exfiltration; Google classified one vector as *"Intended Behavior (Won't Fix)."*
- **Parallel writer subagents.** Cognition's Flappy Bird case — two writers, neither holding the other's implicit design decisions.
- **Docker-socket coupling for sandboxing.** OpenHands reversed its own, making sandboxing optional in the V1 SDK.

---

## 3. The moat — where this repo is already ahead

The gap analyst read the repo directly and compared it against the whole corpus:

> *"This is the most rigorous enforcement harness in the corpus, and it is not close."*

Five things nothing else in the survey does:

1. **Bidirectional falsifiability closure.** `tests/canary/injections.json` closes 44 steps, 27 lanes, 27 factory gates and every guard rule id — in *both* directions, so a stale entry reds as loudly as a missing one. Nothing commercial or open-source in the corpus has this.
2. **The ramp / obligations ratchet** — a stricter Continual Harness than Prime Agent's, pointed at debts instead of lessons, with real expiry, an unconsumed-return-value red, and deadlines ratcheted against the previous release tag.
3. **Anti-vacuity as enforced doctrine, with a public self-catch.** The 0.6.0 `web-e2e` finding — nine rows pointing at a lane that ran green while every spec in it was anonymous — is the kind of failure most projects never find and none write down.
4. **`design/CONTROL-PLANE-FACTS.md` is a capability, not a document.** It answers by observation questions the research corpus lists as *open*.
5. **Turn-scoped enforcement with tree binding.** `path_state` digests mean a stale PASS cannot cover a later edit. The mechanism is sound and unique; only its subject is weak — see §5.

---

## 4. The four gaps

Ranked. Each is structural rather than incremental, and each is load-bearing *only* because the target is unsupervised operation.

**1 — No outcome oracle.** Every claim in the repo is about a **control**; none is about an **outcome**. 87 gate and hook test files, zero about agent outcomes. No CI lane spawns Claude at all. All 34 gates are the visible oracle in a regime where SpecBench measured visible/held-out gaps up to 100pp. Until this exists, the repo cannot distinguish *"produces world-class systems"* from *"produces systems that satisfy this harness"* — which is exactly the unfalsifiable class the other 34 gates exist to delete.

**2 — No OS containment.** The best sandbox writeup in the corpus sits in this repo's own `docs/security/sandbox-and-supply-chain.md` §99, arguing the whole case, and ships none of it. Worse, the four keys that matter — `strictAllowlist`, `mask`, `tlsTerminate`, and the credential controls — are **ignored when set in a repository's `.claude/settings.json`**, so a naive one-file version would be inert while looking committed and reviewed.

**3 — No agent budget.** Tokens, dollars, turns, fan-out and context pressure are all unmeasured. The **only ceiling in the entire system** is `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=8`.

**4 — No escape-growth ratchet.** The obvious reward hack — satisfy a gate by widening its policy across the 37 escape lists — is visible, documented and completely unbudgeted. `check-escape-registry.mjs` reconciles *membership* across three lists and has no delta logic at all.

---

## 5. The biggest risk

**The reviewer layer is the one unanchored oracle in the system, it sits in the turn-fatal position at Stop step 10, and it silently carries the compensation for everything the deterministic gates disclaim.**

The measurements are not encouraging. TeamBench (851 templates / 931 instances, OS-enforced role separation): LLM verifiers approved **49.4%** [45.9–52.9] of submissions a deterministic grader rejected; per-task verification value averaged **−5.8 points**; and **removing the verifier raised mean score by 5.5**. SWE-Review found Opus 4.6 false-approving 20.2% on the high-quality split, dominated by subtle logic bugs and cross-file gaps — *the same classes the static gates are weakest on*, so the two error surfaces correlate rather than compose.

The fix is not a better reviewer. It is anchoring: record the deterministic chain's verdict in the same ledger row, refuse a PASS that co-occurs with a red gate, and publish disagreement as a metric (`now2`). That converts the reviewer from an independent oracle into a **recall-extender over a deterministic floor** — which is what the TeamBench authors themselves recommend.

Two second-order risks worth naming. Six reviewers with overlapping trigger globs is probably about **two opinions** — a nine-judge panel bought 2.18 effective votes in the Apple study, and `accessibility-reviewer` and `design-reviewer` share three trigger globs verbatim. And the chain-cost numbers (24337 ms validate, 50531 ms stopWall) are honest and measured **on an empty scaffold**, with no designed growth path; the documented remedy today is a human commenting steps out of a write-protected file.

---

## 6. Roadmap

Full rows with integration points, proofs and risks are in the JSON. Every item names the gate that would red without it.

### Now — 6 items, four of them S

| # | Item | Effort | The one-line case |
|---|---|---|---|
| `now1` | **Escape-growth ratchet** | S | Closes the most obvious reward-hacking path. ImpossibleBench: cheating drops ~92% → ~1% only when the shortcut becomes *unreachable*, not when instructed away |
| `now2` | **Reviewer `gate_state` + inadmissible PASS** | S | Anchors the unanchored oracle. Today a fixture writing a reviewer PASS beside a red gate is **green** — that is the defect |
| `now3` | **Sandbox posture, two-file split + gate** | M | The doc already argues the case; the gate makes its own claims machine-checked. A one-file version is inert while looking reviewed |
| `now4` | **Stop-hook run governor** | S | Kills the 3am failure mode: re-running a 50s chain forever on a byte-identical tree |
| `now5` | **Test-weakening classifier** | M | The deterministic middle path between the blanket ban you correctly declined and nothing |
| `now6` | **Subagent caps** | S | Payload ceiling that **rejects rather than truncates** — a truncated verdict is a review nobody can parse |

Two implementation traps worth pulling out of the JSON, because both would silently disable the item:

- `now4` token accounting must be `input + output + cacheWrite` **excluding cacheRead**. With prompt caching on Opus 5, a 34-step chain otherwise reads as a 300k-token run and the ceiling fires immediately.
- `now2`'s `gate_state` must be captured **when the subagent stops**, not read back at Stop time — the chain runs `reviewer-verdicts` last, so a late read records the post-fix tree rather than the reviewed one. Reuse the `pathStateDigest` idiom, which already solves this exact binding problem.

### Next — 15 items

Telemetry and cost ledger · structured finding schema with verbatim-quote grounding · panel-health gate (Kish *n*<sub>eff</sub>) · reviewer-level canaries · adaptive canary mutation corpus · MCP tool-definition hash pinning · `Assisted-by` trailer with no-agent-DCO · falsifiability closure extended to the compliance registers · compaction load-class lint · bounded gate output with spill-to-file · `invariants.json` register · worktree isolation for the three author agents · SBOM completeness gate · currency discipline for the floors · stamped/diff-scoped Stop chain.

Three notes. **`next3` may end in deleting reviewers** — that is a legitimate outcome and the removal path costs more than the measurement, because roster counts appear in the README and the plugin manifest. **`next5` deliberately leaves `injections.json` alone**; it is a falsifiability registry and excellent at that, and conflating it with a security eval would corrupt both. **`next14` exists because this artefact demonstrated the failure it prevents** — see §7.

### Later — 11 items

Gated on the private eval or on external surfaces that have not settled: factory-side private eval and the first headless lane · AI change-record attestation · CycloneDX Attestations export · gate determinism harness · `sandbox-runtime` as an opt-in module · learned-lesson row kind · exhaustive authz decision-table enumeration · structural-rot ratchet · org-side spend ceiling · plugin/marketplace delivery evaluation · bounded review-revise loop.

> **`later1` is a trigger, not just an item.** `CONTROL-PLANE-FACTS` Fact 5 records that no CI lane in this repository spawns Claude at all — which is why six CI-agentic controls were rejected as a batch on a precondition rather than on merit. The moment the private eval lands, all six must be re-opened **as one unit**.

### Rejected — 16 entries

The full list with reasons is in the JSON, and it is as load-bearing as the roadmap. The four that matter most:

- **The RLM substrate and the typed broker** — structurally impossible, and self-defeating even if they weren't.
- **A consumer-shipped held-out test suite** — strongest evidence in the corpus, impossible delivery. Anything shipped to `template/base/` is a readable file in the consumer's own tree by construction.
- **Re-implementing four controls this repo already ships** — property-based testing (`fast-check` is already pinned, `fuzzyScore.test.ts` already runs fixed-seed against an independent oracle), mutation testing (already a set-based ratchet, and its header already rejects the score threshold the research also warns against), attestation plumbing (`ci-provenance` already attests, SBOMs and verifies in CI), and reviewer read-only enforcement (all eight already carry `disallowedTools`, machine-asserted and sha-locked — **that is TeamBench's 3.6× enforcement win, already banked**).
- **Building cron, notifications or cloud microVM sessions** — Claude Code ships all of them natively. That proposal was a stale-memory artefact.

---

## 7. Claims I am relaying, not confirming

Six corrections were applied to the research during compilation and are recorded in `correctionsAppliedToSourceResearch[]`. Three are worth surfacing here:

- **`@anthropic-ai/sandbox-runtime` was asserted at 0.0.71 in two separate legs. The registry shows 0.0.67.** Pin from a registry read, never from prose. This is precisely the failure mode `next14` exists to catch, demonstrated by the artefact that proposes it.
- **The Claude Code hook-event count was given as both 30 and 31.** Not adjudicated. The direction is certain — materially more than the 4 this repo binds (7 hook entries across PreToolUse, PostToolUse, Stop and SubagentStop) — the number is not.
- **"No published benchmark exists for gate-level determinism"** was asserted and is false; two 2026 papers address it. An unfalsifiable absence claim is exactly the class this repo's doctrine forbids, and it appeared in research *about* that doctrine.

**More broadly: this compiling session did not open the arXiv papers.** Every paper-derived figure in this document — SpecBench, SlopCodeBench, TeamBench, the Kohli panel study, ImpossibleBench, SWE-Review, AHE, the AGENTS.md studies — carries `relayed: true` in the JSON and is capped at `confidence: medium`. They are leads, not findings. Anyone acting on an effect size should read the paper first; several are load-bearing for tier placement.

Two specific cautions:

**The AGENTS.md studies measure a different thing than this repo does.** They measure context files as a *correctness* mechanism. Here, always-on rules are deliberately advisory with the gates as the invariant — the studied failure mode, where the file is the only thing holding the rule, does not apply the same way. The measurable question is *cost*, and that needs telemetry (`next1`) before it can be answered. **Do not delete doctrine on the strength of a study that measured something else.**

**Vendor self-reports are graded down regardless of precision.** Devin Review's "2 bugs per PR, 58% severe" has no baseline, no false-positive rate and no external replication. The clean-context *architecture* is sound; the numbers are unverified.

Eight open questions are recorded in the JSON. The two that would change a design before it starts: whether a PreToolUse hook can **rewrite** tool input (if not, any sandbox wrapping must happen at the npm-script layer instead), and whether an `@`-included `AGENTS.md` paragraph survives compaction (`now5`'s doctrine paragraph depends on it, and Fact 9 documents project-root `CLAUDE.md` but says nothing about includes).

---

## 8. What would actually win the title

The gap analyst's answer, and I think it is right: the repo is **one artefact away** from converting world-class internal discipline into portable external evidence, and it is currently spending nothing on that.

Every register here — `obligations.json`, the reviewer ledger, the mutation baseline, the Essential Eight grades — is legible only to another in-house `.mjs`. An auditor sampling changes under SOC 2 CC8.1, or a consumer verifying SLSA source properties, cannot check any of it independently or detect tampering. `later2`'s signed change record is the piece that closes it, and it depends on the telemetry and trailer items before it.

But the order matters, and it is not the order that feels natural. **Close the reward-hacking paths first** (`now1`, `now5`), because an unsupervised agent will find them and reward hacking demonstrably generalises. **Put a boundary and a governor under the run second** (`now3`, `now4`, `now6`), because on an unattended macOS session there is no CI backstop. **Anchor the reviewer third** (`now2`), because it is the one oracle currently trusted on its own word. And **only then measure outcomes** (`later1`) — because until the eval exists, every claim in this repo, including the ones in this document, is a claim about a control.
