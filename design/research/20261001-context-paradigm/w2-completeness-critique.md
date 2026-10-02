1. Contested or unverified claims, and what the tree shows

1. **"NOTE lines vanish on a green turn" (advisory-inventory, finding 2): confirmed.** `stop-validate-gate.mjs:268-276` collects only the SKIP, STAMP and FALLBACK patterns from green steps. The ramp counts are also exact: running `shippedRampSites()` gives 69 sites, 18 at `until:1.2.0`, and 4 at `2.1.0` (`check-reviewer-verdicts.mjs:241,572,609`, `check-version-sync.mjs:545`). One nuance the report misses: `RAMP EXPIRED` goes to stderr and makes the check live (`gate.mjs:316-323`). It only goes red when findings exist, because callers return early on zero findings (`check-reviewer-verdicts.mjs:240`).

2. **"VS Code drops `additionalContext`" (write-time §2, the reason the Stop step blocks "never shown" pairs): overstated.** I opened both issues. #79616 is a PostToolUse hook with the **Bash** matcher, closed as stale. #55889 is the Bash matcher in the **CLI**, also closed as stale. Neither shows Edit or Write in VS Code. Fact 18 (`design/CONTROL-PLANE-FACTS.md:584-616`) was observed only in print mode, on the main thread. Delivery inside a subagent is still documentation-only. The docs (fetched) confirm that hooks fire in subagents, run in parallel, are capped at 10k characters, and that SubagentStart accepts `additionalContext`.

3. **"The Stop chain and reviewer verdicts also apply to the CI agent loop" (issue-sync §4.4): contradicted by the tree.** `CONTROL-PLANE-FACTS.md:618-628` (Fact 5) records that no CI lane spawns Claude. It warns that headless subagents get their tools denied unless a PermissionRequest hook answers, and that this risk "becomes live the moment someone adds one". `reviewer-verdicts` also skips without `HARNESS_SESSION_ID` (`check-reviewer-verdicts.mjs:146-160`). The report also never lists `contents: write`, which the loop needs to push `claude/*` branches.

4. **The compute job runs `validate --report-all` (issue-sync) or `--min-floor` (advisory-inventory): each is wrong alone.** `validate.mjs:5-11` says CI trusts the frozen floor and never the local config, so `--report-all` alone breaks that rule. `--min-floor` alone stops at the first red. It must be `--min-floor --report-all`. Even then it covers only the `static` lane. Advisories from `db-scale` (`::notice::`), mutation, perf and runtime-rls come from 14 other jobs (`quality-gate.yml:57-1674`), so "complete run" is not achievable from a separate workflow without re-running every lane.

5. **The allowlist `until` that "fails the gate when it has passed" (issue-sync §3): contradicted by doctrine.** `check-suppressions.mjs:27-33` says a calendar review-by date "would make `pnpm validate`'s verdict change with the day, which no chain step may do".

6. **An inline `// neighbour-divergence:` marker as `justify` (write-time §3.3): conflicts with suppression doctrine.** The same file (`:28-31`) requires every escape to be "a two-place act", meaning an inline reason plus a row on the write-guarded `tools/` surface. An inline-only marker lets the agent exempt itself. The issue-sync report instead puts `justify` in `tools/advisory-allow.json`. That file is write-guarded (`PROT_DIRS` covers `tools/`, `pretool-bash-guard.mjs:25`), so the agent cannot answer an owed pair within a turn at all.

7. **"The owed-disposition Stop step is the authority": local only.** The `.harness/` ledgers are git-ignored (`gitignore:60`). `reviewer-verdicts` is a Stop-chain step with no CI equivalent. Reuse and extract can be recomputed from the diff in CI. "Shown, then ignored" cannot. So the doctrine "fail closed in CI" does not hold for this step as designed.

8. **Smaller citation drift.** `ESCAPE_LISTS` lives in `tools/lib/enforcement-surface.mjs:14`, not `check-gate-integrity.mjs:32`. The embeddings report's vendor figures (+16% / +19%) differ from what the search results show (+28.25% / +31.03% on the agentic suite); these are probably different suites. Confirmed externally:
   - voyage-code-4 released 2026-08-13 at $0.12 per million tokens;
   - CVE-2026-25598, fixed in harden-runner 2.14.2 (the house pins 2.20.0);
   - workflow execution protections GA 2026-09-17, enforced from 2026-11-02;
   - GitHub Code Quality GA 2026-07-20 at $10;
   - Voyage's training opt-out exists but covers only data sent after opting out. The design should require opting out before the first call.

## 2. Gaps

- **CI backstop for owed dispositions.** None of the reports says what CI checks when the author worked without hooks (a human, another agent, or `disableAllHooks`). A committed disposition record readable in CI is needed.
- **Advisories from every lane.** No report addressed how they reach the sync job. The tree already has a precedent: `lane-reuse.mjs` reads another run's job logs under `actions: read` (`quality-gate.yml:10-24`). Choose between that and duplicating the whole nightly run.
- **Diff-time hits versus a whole-tree sweep.** Dossier hits are computed per diff, but issues need a whole-tree all-pairs sweep. Nobody sized the first sweep on an existing codebase, or how it interacts with the 10 / 50 issue caps.
- **The existing `duplication` gate.** It already blocks type-1 clones of 70+ tokens and 6+ lines, with its own allowlist (`check-duplication.mjs:1-30`, chain `harness.config.mjs:201`). The reports propose three exemption stores: `duplication-allow.json`, `advisory-allow.json` and inline markers. Nobody reconciled the tiers or the stores.
- **The ramp for this new gate.** It tightens verdicts, so it must ship as a NOTE ramp. NOTEs vanish on a green turn, so during the ramp the issue sync would be the only place its findings appear. Nobody planned that.
- **A gate red for an unrelated reason.** Under the rule "failed means do nothing", every advisory of that gate stays frozen open indefinitely. There is no staleness signal.
- **Review-time delivery to Read/Grep/Glob-only reviewers** (`agents/*.md tools:`). The embeddings report's 20 s batch call before dispatch exceeds the existing 10 s SubagentStart budget (`settings.json:84-95`), and it does not say which hook runs it.
- **The opt-in model.** 2.0.0 is "the opt-in release" (CHANGELOG:16). Nobody decided whether issue sync, with the scaffold's first `issues: write`, ships in base or as a module, as embeddings does.
- **Which repository.** "All unfixed advisories" could mean the consumer's issues, the factory's own (row 19, `hygiene.yml`), or both.
- **Measuring the action rate.** The Tricorder ≤10% effective-false-positive bar needs an "acted on" join. Telemetry forbids paths (`hookio.mjs:56-58`), and no evaluation harness exists for the deterministic tiers. Only embeddings has one, and it needs headless Claude runs, which per Fact 5 the harness does not have.
- **Concurrency.** Nobody covered concurrent sessions writing the shown-ledger or the index (the Stop hook already detects concurrent sessions).

## 3. Tensions the designers must resolve

1. **Semantic hits at write time.** Write-time §3.7 says write time is deterministic only. Embeddings §6.1 shows up to 2 corroborated `semantic` context hits at write time. Pick one.
2. **Issue identity (three schemes).**
   - advisory-inventory: `sha256(gate|rule|path|fingerprint)`. Path and content are in the key, so a move or an edit churns the issue.
   - issue-sync: `gate|rule|subject` (symbol ids), with fingerprints kept as evidence only.
   - embeddings: sorted content fingerprints, closing when either function's hash changes.
3. **When an issue closes.** The rules are: one omitting nightly run (inventory), two consecutive complete runs (issue-sync), or a content-hash change or cosine below T_close (embeddings). Embeddings' "a justify answer closes the issue" also conflicts with issue-sync's rule that closing never exempts and only an allowlist row does.
4. **"Every advisory becomes an issue" versus noise and doctrine.**
   - Issue-sync allows only advisories CI can recompute, capped at 10 new per run and 50 open, with a dashboard for the rest.
   - The inventory's B and C classes say per-turn lines and already-registered items must not become issues ("two copies drift", `check-obligations.mjs:22-27`).
   - Reviewer MEDIUM/LOW findings and local dossier hits can only become issues through a committed register (inventory option (b)), which writes into the write-guarded `tools/`.
5. **Nagging at write time versus owed dispositions at review time.** If the dossier is shown and the pair is owed at Stop anyway, write time adds noise without changing the outcome. If a hit shown at write time then blocks at Stop as "ignored", one finding gets two penalties. Decide whether write-time hits that the agent acts on cancel the debt automatically (the mechanical reuse and extract checks), and leave only `justify` to reviewers.
6. **The agent loop versus "advisory context is distrusted".** Issues are advisory text, yet the agent-fix loop would turn them into the instructions that drive work. Issue-sync's rule (pass only the key and have the agent re-derive the finding) must be mandatory, and that loop needs the Fact 5 headless-permission probe first.

Sources:
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [claude-code#79616](https://github.com/anthropics/claude-code/issues/79616) and [claude-code#55889](https://github.com/anthropics/claude-code/issues/55889)
- [voyage-code-4](https://blog.voyageai.com/2026/08/13/voyage-code-4/) and [Voyage FAQ](https://docs.voyageai.com/docs/faq)
- [CVE-2026-25598](https://www.sentinelone.com/vulnerability-database/cve-2026-25598/)
- [Workflow execution protections GA](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/)
- [Code Quality GA](https://github.blog/changelog/2026-06-16-github-code-quality-generally-available-july-20-2026/)