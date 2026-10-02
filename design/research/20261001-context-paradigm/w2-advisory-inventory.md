# Advisory inventory: every non-blocking output the harness emits (stack head, 2.0.0)

All paths are relative to the stack-head tree. `tb/` = `template/base/`.

## Headline findings

1. **There is no "advisory" type.** The scaffold has no record, id or helper for a non-blocking finding. What it has is a text convention: `<gate>: NOTE — <free text>` on stdout. There are 107 such print sites across 37 scripts under `tb/tools/`. Beside it sit `SKIPPED —`, `STAMPED —`, `FALLBACK MODEL —`, `provenance: ADVISORY (n) —`, `FIELD-NOTE[...]`, and `doctor`'s `warn`/`info`. Only one machine reads NOTE lines: `graduate`'s regex `/NOTE\s*—/ && /ramp/i` (`installer/commands/graduate.mjs:115-122`).
2. **NOTE lines disappear on a green turn.** The Stop hook collects only `SKIPPED`, `STAMPED` and `FALLBACK MODEL` lines from green steps (`tb/.claude/hooks/stop-validate-gate.mjs:268-276`). Everything else in a green step's output is dropped, so neither the agent nor the user sees a NOTE. Telemetry counts skips and stamps per step and does not count notes (`:232-250`).
3. **In CI, NOTEs reach only a job log.** The `static` job runs `validate --min-floor` and uploads nothing (`tb/github/workflows/quality-gate.yml:117`). On the post-merge push the lane is usually REUSED, so its steps never run and no NOTE prints (`:87-98`). The nightly `schedule` run never reuses (`:20-21`). That makes it the one full, deterministic run on the default branch, and the natural place to sync issues.
4. **Nothing files issues today.** No workflow in the scaffold, its modules or the factory holds `issues: write`. The only issue-producing automation is Renovate's Dependency Dashboard: the template's `renovate.json` extends `config:best-practices`, and the factory's `renovate.json:11-12` enables it explicitly.
5. **Ramp NOTEs are nearly gone at 2.0.0.** `scripts/lib/ramp-sites.mjs` counts 69 shipped `rampNote` sites. Only 4 have `until` > 2.0.0, all expiring at 2.1.0: `check-reviewer-verdicts.mjs:241,572,609` and `check-version-sync.mjs:545`. The 18 sites dated 1.2.0 are already expired on any 2.0.0 install (1.2.0 is never cut), so they hard-red as `RAMP EXPIRED` (`tb/tools/lib/gate.mjs:319`). The 4 live sites fire only on installs whose baseVersion is below 1.1.0, or below 2.0.0 for `:545`.
6. **Below-blocking reviewer findings are recorded by no machine.** MEDIUM and LOW findings appear only in the reviewer's reply and in the hand-written `docs/reviews/` prose. The ledger keeps only `blocking` lines (`tb/.claude/hooks/subagent-verdict.mjs:431`). For the dossier paradigm this is the most relevant gap.

## 1. Inventory

Class: **A** = should become an issue, **B** = should stay a terminal line, **C** = already tracked elsewhere.

| # | Advisory | Emitter | Format | Stable identity? | Disappears when | Class |
|---|---|---|---|---|---|---|
| 1 | Ramp NOTE header | `tb/tools/lib/gate.mjs:329`, via 69 `rampNote` sites | stdout `<gate>: NOTE — <detail> (ramp: live from baseVersion M; … expires in U)` | **Yes.** The factory enforces `(file, detail)` as a unique per-site id (`scripts/lib/ramp-sites.mjs:529-550`), plus `minVersion` and `until`. Caveat: some details embed a count (`check-workspace-deps.mjs:207`, `check-docs-sync.mjs:355,456`), so digits must be normalised. | Swept, then `graduate`. Otherwise at expiry it turns into the hard `RAMP EXPIRED` red. | **A** |
| 2 | Withheld ramp findings, `(ramp) …` and "N finding(s) withheld" | About 36 sites, e.g. `check-docs-sync.mjs:750`, `check-rls-manifest.mjs:815`, `check-tenancy.mjs:1600`, `check-reviewer-verdicts.mjs:249,575,618` | stdout, free text | **Partial.** Gate plus prose. `file:line` is often embedded but no rule id is. | Fixed | **A**, as checklist items inside row 1's issue |
| 3 | Provenance advisory classes (N20: `vector-index`, `llm-sampling`, `tuning-constants`) | Gate: `tb/tools/check-sources.mjs:304-316`. Write-time: `tb/.claude/hooks/posttool-source-check.mjs:101-112` (`additionalContext`). Telemetry: `:85` | `provenance: ADVISORY (n) — file:line [group] why` | **Good.** `(group, file)` plus an excerpt hash. The line number drifts. Groups are a closed set (`tb/tools/lib/provenance-rules.mjs:103`). | Site cited, or class promoted in `tools/decision-groups.json` | **A** |
| 4 | Control OFF until the project adopts it | `check-styleguide-manifest.mjs:228,283,344`; `build-check.mjs:324` (gzip ratchet OFF); `check-framework-floor.mjs:71,99,124,144` (register absent); `quality-gate.yml:939` (`::notice::` db-scale) | stdout fixed text, or a workflow notice | **Yes.** `(gate, message template)` | A human adopts it (`update --refresh-seeded`, or writes the file). It never clears by itself. | **A** |
| 5 | Ratchet and hygiene drift | `check-mutation-ratchet.mjs:235` (stale baseline), `:240` (tightenable survivors); `tb/tools/lib/bundle-measure.mjs:186` (chunk gone); `check-wiring.mjs:367` (CODEOWNERS patterns unjudged); `check-version-sync.mjs:581` (versionCode bound near) | stdout | **Yes.** `(gate, file, mutator, snippet)`, chunk key, pattern, or version | Someone runs `--write` or plans the next version | **A** |
| 6 | Legal empty states and reviewed empties | `check-workspace-deps.mjs:175`; `check-rls-manifest.mjs:749` (`mfaRailUnused`); `check-perf-budget.mjs:465` (`emptySubjects`); `check-auth-posture.mjs:397`; `check-i18n.mjs:150` (single-locale SKIPPED); `quality-gate.yml:945` | stdout | Yes | The first vertical or route arms the check. Reviewed rows carry `reviewedOn`. | **C** (reviewed register rows) / **B** |
| 7 | Accepted exemptions | `check-migrations.mjs:409`; `check-gate-integrity.mjs:288-291` | stdout | Yes, through the allow-file entry | The entry is deleted | **C** |
| 8 | Transitional and local NOTEs | Partial install: `check-version-sync.mjs:662,722`, `check-styleguide-manifest.mjs:143`, `check-i18n.mjs:218`, `check-migrations.mjs:148`. Upgrade in flight: `check-gate-integrity.mjs:527,672`, `check-docs-sync.mjs:179,269`, `check-migrations.mjs:191`. Dev tree only (no manifest): `check-version-sync.mjs:440,471,768`, `check-docs-sync.mjs:1032,1425`, `check-data-flow.mjs:321` | stdout | n/a | CI or the upgrade commit resolves them | **B** |
| 9 | `SKIPPED` (missing toolchain) | `tb/tools/lib/gate.mjs:191` (`skipOrFail`, 76 call sites in 40 files); `tb/lefthook.yml:13` (gitleaks) | stdout. On green the Stop hook lists them on stderr (`stop-validate-gate.mjs:381-383`). | `(gate, reason)` | CI fails closed (`gate.mjs:181-189`) | **B** |
| 10 | A skip CI permits | `check-backup-posture.mjs:47,119` (`backup-evidence` lane, `osv-scan.yml:129`) | Scheduled job log | Yes | A token is wired, or `HARNESS_REQUIRE_BACKUP_EVIDENCE=1` | **A** |
| 11 | `STAMPED`; `FALLBACK MODEL`; reviewer-ledger NOTEs | `gate.mjs:469`; `check-reviewer-verdicts.mjs:239` (shown as a `systemMessage`, `stop-validate-gate.mjs:390-395`); `check-reviewer-verdicts.mjs:182,600,629` | stdout / systemMessage | Session-scoped | The next turn | **B** |
| 12 | Stop-hook notes | `stop-validate-gate.mjs:286-372`: floor injected, floor unreadable, previous turn ended red, cap unparseable, ledger write error, concurrent session | stderr (the debug log when green) | No | Session state | **B**. "Previous turn red" is **C**: `turn-outcomes.jsonl` plus a one-time block. |
| 13 | Biome fast-check output | `tb/.claude/hooks/posttool-fast-check.mjs:31-38` | stderr, plus a telemetry `warn` | No | The Stop `format`/`lint` steps are the authority | **B** |
| 14 | `FIELD-NOTE[gate]` (N11) | `gate.mjs:119,134` | Printed only on failure, after FIX | — | — | **B**. It is a human-authored remedy on a red, not a finding. |
| 15 | Reviewer findings below `Blocking:` (R02) | Reviewer bodies, e.g. `tb/.claude/agents/architecture-reviewer.md:84-90` (`Severities: CRITICAL, HIGH, MEDIUM, LOW / Blocking: CRITICAL, HIGH`) | Transcript only. A human may copy them into `tb/docs/reviews/<change>.md` (`tb/docs/reviews/README.md`). | **No.** `- [SEV] file:line — …` free text, and not captured | Never tracked | **A**, once captured (see §4) |
| 16 | `doctor` warnings | `installer/commands/doctor.mjs`: `:169` catalog pin below a security floor (F15); `:139` unapplied seeded source fix; `:103` parked upgrade; `:198,208` lockfile; `:375` lefthook not installed; `:69,73` config tuned or owned drift; `:425` seeded-divergence info | `  warn …` / `  info …`, exit 2 (`:435-438`) | Pin floor: `(name, minVersion, advisory id)`. Source fix: `(since, gate)`. Parked: path. | Recomputed from the tree; the pending files clear themselves | **A** for pin floor, source fix and parked upgrade. **B** for lefthook, config-tuned and divergence (per clone, or expected). |
| 17 | `update` notes and `.harness/pending/*.json` | `installer/commands/update.mjs:419-443`; `installer/lib/migrations.mjs:389,518,627-715`; `installer/lib/report.mjs:21` | JSON ledger plus a `note:` line (`--json` available, `report.mjs:7`) | Yes | Clear themselves | **C**. Row 16 reads the same facts. |
| 18 | Dated harness deferrals | `tb/tools/deferrals.json`; judged at `check-docs-sync.mjs:1440-1452` | Silent until the target arrives, then a hard red | `id` | A harness release ships or re-dates it | **C**: the factory `scripts/obligations.json` census, and harness-owned |
| 19 | Factory calendar obligations | `scripts/check-obligations.mjs --clockful`, `.github/workflows/hygiene.yml:90-91` | A scheduled job goes red | Row `id` | Discharged or re-dated | **A**, factory side |
| 20 | Review-window lapses (framework floor, cc-floor, `eol.json`, support register, `security.txt` `Expires`) and `eol` removalTarget arrival | `check-framework-floor.mjs:146-160` in `floor-review` (`osv-scan.yml:79-102`); `tb/tools/lib/eol.mjs:340,615` | A scheduled job goes red | `(register path, package/key)` | A reviewed commit moves the dates | **A** |
| 21 | Other scheduled lanes going red | `patch-window` (`deploy-record.yml:81-115`); `restore-manifest` (`:117`); surface-deferral review (`osv-scan.yml:104-111`); `sbom-inventory` (`:173`); `mutation.yml:68-71`; the `quality-gate` nightly (`:32-34`) | Run failure only. Today the signal is GitHub's failed-run email to whoever last edited the cron. | Lane id plus finding text | The next green run | **A**, one issue per lane |
| 22 | OSV full scan, CodeQL | `osv-scan.yml:56-63`; `codeql.yml:17-19` | SARIF to code scanning | GHSA / rule id | GitHub closes the alert | **C** |
| 23 | CI display lines | `quality-gate.yml:97` (reused `::notice::`); `tb/tools/ci/summarize-gate.mjs:114-136` (SKIPPED/REUSED, deferral reason) | Step summary | No | Per run | **B** |
| 24 | SessionStart brief / `harness-status` | `tb/.claude/hooks/session-brief.mjs`; `tb/tools/lib/harness-brief.mjs` (four fixed fields, capped at 1200 characters) | Context text | No | — | **B**: a view over rows 16 and 17 |
| 25 | Telemetry (N02) | `tb/.claude/hooks/lib/hookio.mjs:44-110`; `stop-validate-gate.mjs:232-251` | JSONL | Ids only | — | Not an advisory. It is a data stream (§2). |

**Justifications in brief.**
- **A** covers advisories that are deterministic, about the code or configuration, owned by the project, and silent unless someone reads a log. Rows 1-5 vanish on a green Stop (finding 2). Rows 20-21 currently reach only an email.
- **B** covers lines that are either resolved by CI's fail-closed posture (a local SKIP) or are facts about one session or turn. An issue for them would open and close every turn and teach people to ignore the label.
- **C** covers advisories that already live in a reviewed, dated register (allow files, `surfaces.json`, `deferrals.json`, `obligations.json`) or in GitHub's own tracked objects (code scanning, Renovate dashboard). A second copy as an issue is the "two copies drift" failure the codebase repeatedly warns against (`scripts/check-obligations.mjs:22-27`). One exception: if the user truly wants ALL unfixed advisories as issues, the C rows can be linked from one umbrella issue, never duplicated.

## 2. Machine-readable streams that already exist

None of these is an advisory stream. Each one carries part of what an issue would need.

- **`.harness/telemetry.jsonl`** (N02; `hookio.mjs:44-110`). Append-only and never trimmed. It is written only when `.harness/manifest.json` exists. Record shapes:
  - `{v:1, kind:'hook-event', at, session_id, prompt_id, hook, tool, rule, outcome: deny|block|warn|bounce|advisory}`
  - `{v:1, kind:'stop-step', at, session_id, prompt_id, step, status: ok|fail|stamped, ms, skips, stamps}`
  - `{v:1, kind:'validate-gate', …, gate, ms}`

  By contract it holds **never paths, content or messages, and no gate reads it** (`:56-58`). It can count advisories but cannot key them. NOTE lines are not even counted.
- **`--ci-parity` records** (`gate.mjs:162-176`, `validate.mjs:186-238`). JSONL lines of `{gate, reason}`, one directory per step in an OS temp dir, deleted on exit. They cover missing prerequisites only. The mechanism, an env-named directory plus append-only JSONL plus a guarantee never to decide a verdict, is the right template for an advisory recorder.
- **`VALIDATE_TIMINGS {totalMs, notRun, steps}`**: one stdout line (`validate.mjs:374-380`). Timings only.
- **`--report-all`** (`validate.mjs:12-14, 347`) runs every step. Its output is text only.
- **`summarize-gate.mjs`** reads the `needs` JSON (`{job: {result, outputs:{reused-from}}}`) and writes text to `$GITHUB_STEP_SUMMARY` (`quality-gate.yml:1719`).
- **Local ledgers** under `.harness/`, which git ignores except `manifest.json` (`tb/gitignore:58-61`), so CI never sees them:
  - `turn-outcomes.jsonl` (last 200 records)
  - `reviewer-ledger.jsonl`: `{v, session_id, prompt_id, agent_type, agent_id, verdict, path_state, path_state_start, path_state_stop, model, pinned, blocking, round, overBudget}` (`subagent-verdict.mjs:412-435`)
  - `reviewer-dispatch.jsonl`, `verdict-bounces.jsonl`
  - `stop-output/<step>.log`
  - `pending/pin-floors.json`: `{harnessVersion, floors:[{since,name,found,minVersion,advisory,why}]}`
  - `pending/source-fixes.json`: `{harnessVersion, fixes:[{since,gate,why,paths}]}`
  - `pending/dependencies.json`
- **Factory**: `shippedRampSites()` returns `{file, gate, line, minVersion, until, detail}` for every ramp. This is the identity source for row 1.
- **Precedents for content fingerprints**, which issue keys can reuse:
  - `duplication-allow.json` keys accepted clones by the sha1 of the normalised token run (`check-duplication.mjs:255-262`). It stays stable when lines move.
  - The mutation baseline keys by `(file, mutator, snippet)` (`check-mutation-ratchet.mjs:226`).

## 3. GitHub automation and permissions today

**Scaffold base workflows**: `actions-lint`, `adr-guard`, `codeql`, `deploy-record`, `gitleaks`, `migration-safety`, `mutation`, `osv-scan`, `quality-gate`.
- Every one declares top-level `permissions: contents: read`.
- Job-level escalations:
  - `security-events: write` for `codeql.yml:17-19` and `osv-scan.yml:51-63`.
  - `actions: read` and `pull-requests: read` on the six reuse lanes (`quality-gate.yml:62-65` etc.). A factory test pins these **exactly** and reds on any widening (`tests/gates/workflow-lanes.test.mjs:478-479, 630-631`). An issue-sync step therefore cannot ride those lanes.
- `deploy-record.yml:104-112` already uses the `gh` CLI with `GH_TOKEN: ${{ github.token }}` (reads only).

**Module workflows** carry job-scoped writes, each with an inline justification:
- `preview-mobile.yml:48-51`: `pull-requests: write`, `actions: write`
- `release-please.yml:33-35`: `contents: write`, `pull-requests: write`
- `release-mobile.yml:295,407`: `contents: write`
- `provenance.yml` and `web-deploy.yml`: `id-token: write`, `attestations: write`

**`issues: write` appears nowhere.**

**Hardening**:
- Every job starts with `step-security/harden-runner` using `egress-policy: audit`. `actions-lint.yml:83-120` checks this by count, and `tb/tools/check-workflow-hardening.mjs` checks it by position, along with a bash default and a literal `timeout-minutes`.
- `tb/github/zizmor.yml` ignores only `cache-poisoning`, for three release files. Every default audit is active, including `excessive-permissions` and `template-injection`.

**Factory** (`.github/workflows/`: `lint`, `selftest`, `hygiene`, `scorecard`, `release`, `codeql`):
- Writes are limited to `release.yml:23-26` (`contents`, `id-token`, `attestations`) and `scorecard`/`codeql`/`hygiene` (`security-events`).
- **No issue filing.** `check-obligations.mjs --clockful` and `check-floor-advisories.mjs` turn the scheduled `hygiene` job red (`hygiene.yml:90-91, 142-145`), and that is all they do.
- Issues are filed by hand through `.github/ISSUE_TEMPLATE/{bug-report,gate-proposal}.yml`. The work plan itself is an issue index (#37, `ROADMAP.md:70-80`).

## 4. Implications for the issue design

1. **Add one recorder, not a parser.** Put a helper in `gate.mjs`, e.g. `noteAdvisory(gate, {rule, path, fingerprint, until?, text})`, that both prints the NOTE line and appends a JSONL record to `HARNESS_ADVISORY_REPORT_DIR`. Mirror `noteMissingPrerequisite` exactly: silent, never decides a verdict, never writes into the tree. `rampNote` and the ramp-withheld loops route through it.

   Parsing today's free text would be fragile. Issue identity can be `sha256(gate | rule | path | fingerprint)`, where:
   - for a ramp, `rule` is the `(file, detail)` site id with digits normalised;
   - for provenance, `rule` is the class and the fingerprint is the excerpt hash;
   - for a doctor pin floor, `rule` is `name@minVersion` plus the advisory id.

   Line numbers must never be part of the key.
2. **Keep the sync off the PR path, in a dedicated workflow.** Run it on `schedule` plus `workflow_dispatch` on the default branch, in its own workflow, so a sync failure can never touch `gate-summary`. Requirements:
   - one job, `permissions: {contents: read, issues: write}`, harden-runner first, bash default, a ceiling;
   - it runs `validate --min-floor` with the recorder enabled, or reads the same job's output, and never trusts a cross-workflow artifact;
   - it runs `doctor --json`-equivalent output and `check-framework-floor`;
   - it upserts issues via `gh issue … --body-file` (no `${{ }}` interpolation of finding text, which zizmor `template-injection` would flag);
   - it uses a hidden marker `<!-- harness-advisory:<key> -->` and a `harness-advisory` label;
   - it **closes an issue only when a complete nightly run omits its key**. A SKIPPED or failed step must not close anything, or "a skip is never a pass" is broken.

   Also needed: a factory selftest leg that proves the job can go red (canary registry), and a test that pins its permissions exactly.
3. **Rows 20-21 (scheduled reds) need lane-level issues, not per-line ones.** One issue per failing scheduled lane, with the run URL and the FAIL bullets as a checklist, closed on the next green run of that lane. That replaces today's email to whoever last edited the cron.
4. **Reviewer findings (row 15) need capture before they can become issues.** Extend `subagent-verdict.mjs` to record *all* `- [SEV] file:line — …` lines, not only `blocking`, with `path` and a content fingerprint of the cited lines. The ledger lives in git-ignored `.harness/`, so the sync must run where the review ran. That conflicts with the CI-only sync above. The options:
   - (a) commit them through `docs/reviews/` (already the sanctioned home, but prose);
   - (b) have the owed-disposition Stop step write a committed `tools/generated/advisories.json` that CI reads.

   Option (b) also gives the dossier system's low-confidence hits the same path.
5. **Doctrine tension to state openly.** The harness distrusts advisory context ("quality is a deterministic gate"). An issue is advisory by nature. The guardrails that keep it honest:
   - every issue must cite the gate and rule that produced it;
   - closure must be machine-decided;
   - a ramp issue must carry its `until` as a due date, because at expiry the advisory becomes a hard red regardless of the issue's state.
6. **Write-time precedent already exists.** `posttool-source-check.mjs:101-112` gives the authoring agent advisory findings through PostToolUse `additionalContext` without blocking. The dossier's write-time delivery should reuse that channel and its closed-output discipline (`harness-brief.mjs:11-17`).

Report length: (about 2,700 words, a little over the ~2,500 target; the file paths account for much of it).