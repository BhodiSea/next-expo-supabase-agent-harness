# Syncing advisories to GitHub issues safely and idempotently

The report is about 2,000 words without the source list. Nothing in any repository was changed.

`tb/` means `template/base/` in the stack-head tree. This report covers the GitHub side only. For which advisories exist, and the proposed `noteAdvisory()` JSONL recorder, see `research/advisory-inventory.md`.

## Recommendation

Build `tools/ci/sync-advisories.mjs` in house, with no dependencies, calling `gh api`. Run it in its own `advisory-sync.yml`, triggered only by `schedule` and `workflow_dispatch`, on the default branch. Split it into two jobs:

- **compute** (`contents: read`): runs `validate --report-all` with the recorder and emits `advisories.json`.
- **sync** (`issues: write`, harden-runner in `block` mode): reads that file and the committed `tools/advisory-allow.json`, then creates or updates issues.

How the issues behave:
- **Identity:** a hidden marker on the first line of each issue body. The sync only touches issues that the bot authored and that carry the label.
- **Shape:** one rolling "Advisory dashboard" issue lists everything. A capped number of findings are promoted to their own issues.
- **Closing:** the sync decides when an issue closes, never a person.
- **Won't fix:** a reviewed row in an allowlist file in the repo, never an issue state.

Only advisories that CI can **recompute** should become issues, because closing on fix requires CI to see that the finding is gone. SARIF upload is at most an optional extra on public repos.

## 1. Mechanisms

| | (a) First-party upsert | (b) SARIF → code scanning | (c) Marketplace actions | (d) Rolling tracker |
|---|---|---|---|---|
| Idempotent | Yes: list by label with `state=all` and match the marker | Yes, via `primaryLocationLineHash`, the only fingerprint GitHub uses | By title, or by an issue number you already know | Trivially |
| Closes on fix | You write it | Built in: an alert becomes "fixed" when the next analysis from the same tool and category omits it. If that category stops uploading, its alerts go stale and stay open. | No | Body rewrite |
| Dedupe across branches and PRs | Sync on the default branch only | Built in, per branch | No | n/a |
| Permissions | `issues: write` | `security-events: write` + `actions: read` | `issues: write` held by a third party | `issues: write` |
| Fork PRs | Never runs on them | Upload fails (the token is read-only) | n/a | n/a |
| Cost | Free | Free on public repos. Private repos need GitHub Code Security ($30 per active committer per month). | Free | Free |

**(a) First-party upsert.** Don't use the search API to find existing issues. Its index is eventually consistent, so it misses issues and creates duplicates (nexus-agents#5729). Instead:

- Page through `GET /repos/{o}/{r}/issues?labels=harness-advisory&state=all&per_page=100` and drop pull requests.
- Parse `<!-- harness-advisory v1 key=<16hex> body=<sha256-8> -->`. The body hash lets the sync skip updates that would change nothing.
- Issue bodies are capped at 65,536 characters.

Issue fields (generally available for organizations since 2026-07-02) could store `key`, `gate` and `until` as typed fields. Repos owned by personal accounts can't use them, so the marker stays the key that works everywhere.

**(b) SARIF and code scanning.** Drawbacks:

- The house already rejected SARIF for zizmor because of the licence (`.github/workflows/lint.yml:74-79`; see also `tb/github/workflows/codeql.yml:5`).
- Each result needs a file location. Lane failures and "control OFF" advisories have none.
- Only users with write access can see the alert list.
- Dismissing an alert is a setting in GitHub's UI, not reviewed data in the repo.
- The Claude GitHub App has no permission to read security events, so an agent loop couldn't read the alerts.

GitHub Code Quality became generally available on 2026-07-20 at $10 per committer. It runs CodeQL rules plus AI detection, and its docs describe no way to feed in findings from other tools. It can sit alongside this design but can't carry harness findings.

**(c) Existing actions.**

- `JasonEtco/create-an-issue` matches on exact title and never closes issues.
- `peter-evans/create-issue-from-file` can only update an issue whose number you already know.
- `sarif-to-issue-action` is built for security findings.

None of them closes issues on fix or filters by author. The house prefers pinned first-party code over wrapper actions (`tb/github/workflows/gitleaks.yml:1-6`). zizmor's `superfluous-actions` audit flags actions that the preinstalled `gh` CLI can replace. Don't give `issues: write` to a third-party action.

**(d) A single rolling tracker.** This is the Renovate Dependency Dashboard pattern, which the factory already uses (`renovate.json:11`).

- **For:** one write per run and almost no notifications.
- **Against:** findings are easy to overlook. Single findings can't be assigned or closed with `Fixes #N`. The body hits the 65,536-character cap.
- **Doctrine problem:** its checkboxes invite people to use issue state as an input to the gates.

Sub-issues allow at most 100 children per parent. One third-party report says closed children count toward that cap, so a long-lived parent per gate would fill up. Per-finding issues can be linked and picked up by an agent, but they cost API writes and send notifications. **Use the hybrid.**

## 2. Security

**Triggers.** Use only `schedule` and `workflow_dispatch`. Never use:

- `pull_request_target`. Since 2025-12-08 it always runs the default branch's workflow. Workflow execution protections became generally available on 2026-09-17. Their default rule disables this trigger on public repos and is enforced from 2026-11-02.
- `workflow_run`. GitHub Security Lab says to treat artifacts from the triggering run as untrusted.
- `issues` or `issue_comment`.

zizmor's `dangerous-triggers` audit flags `pull_request_target`, `workflow_run` and, since v1.31.0, `issue_comment`. On fork PRs the token is read-only anyway.

**Keep the two jobs' privileges apart.**

- **compute** runs `pnpm install`, so it executes third-party npm code. It never holds a write permission.
- **sync** installs nothing:
  - It checks out only the script, the allowlist and the schema.
  - It checks the payload against a strict schema.
  - It receives the payload as a job output (up to 1 MB), so it needs no artifact endpoints.
- That makes **sync** the obvious first job in the scaffold to run harden-runner with `egress-policy: block`, using `allowed-endpoints: github.com:443 api.github.com:443`. Confirm that list in audit mode first.
- Block mode is an extra layer, not a guarantee. CVE-2026-25598 let traffic bypass harden-runner's audit logging; it was fixed in 2.14.2, and the house pins 2.20.0.

**Token.**

- Grant `issues: write` at the job level, with an inline comment justifying it (zizmor `undocumented-permissions`). Pin the permissions in a factory test, as `tests/gates/workflow-lanes.test.mjs` already does for other workflows.
- Use no personal access token and no GitHub App token. Events created with `GITHUB_TOKEN` don't start new workflow runs (dispatch events excepted), so the sync can't trigger itself in a loop.
- `issues: write` covers every issue in the repo. So the sync changes an issue only when all three hold:
  - `user.login == 'github-actions[bot]'`;
  - the label is present;
  - the marker is on line 1.

  On a public repo anyone can open an issue containing a forged marker.
- Set `concurrency: {group: advisory-sync, cancel-in-progress: false}` so two runs can't both create the same issue.

**Untrusted text.** Finding text comes from merged code: file paths, code snippets and commit subjects from the co-change history. It can still contain:

- @-mentions that notify people outside the project;
- `owner/repo#N` references and github.com URLs, which add backlinks to other people's repos;
- raw HTML, forged markers, and bidirectional or zero-width characters;
- prompt injection aimed at the agent that reads the issue later.

Rules:

1. Never insert finding text with `${{ }}` (zizmor `template-injection`). Pass it with `gh api --input -`.
2. Build titles only from fixed vocabularies. Restrict any file basename to `[A-Za-z0-9._-]`.
3. Put paths in code spans after checking them against an allowlist regex. Put snippets in code fences longer than their longest run of backticks, and cap them at about 20 lines.
4. Strip control, bidirectional and zero-width characters.
5. Build links to this repo yourself. Write any link to another github.com repo via `redirect.github.com` so it creates no backlink.
6. Add a golden test that no `@`, `#\d` or `<` appears outside code. GitHub's autolink docs don't say that text inside code is exempt from linking.

**Rate limits.**

- `GITHUB_TOKEN` allows 1,000 requests per hour per repo.
- GitHub's secondary limits allow 80 content-creating requests per minute and 500 per hour.
- Send requests one at a time, wait at least 1 second between writes, honour `retry-after`, and back off exponentially.
- The caps in §3 keep a run to about 60 writes.

## 3. Lifecycle

**Source of truth.** Use the complete nightly run at the head of the default branch. The `quality-gate` run after a merge reuses results from the PR run instead of re-running lanes (`tb/github/workflows/quality-gate.yml:10-22`), so it isn't complete. The payload:

```
{sha, harnessVersion,
 gates: {id: "complete" | "skipped" | "failed"},
 findings: [{key, gate, rule, class, status: "advisory" | "blocking", subject, until?, evidence}]}
```

`key = sha256(gate|rule|subject)`, where `subject` is one of:
- a symbol id;
- a sorted pair of symbol ids, for a dossier hit;
- a concept id.

Digits in the subject are normalised, and it never includes line numbers. Content fingerprints are recorded as evidence, not used as identity, so small edits don't close and reopen the issue.

PRs never write to issues. At review time the dossier may read them and tell the reviewer "already tracked as #123".

| What the sync sees | What it does |
|---|---|
| A new key | Opens an issue if the key is promoted; otherwise lists it on the dashboard |
| The rendered body changed | Updates the body. Never posts "still present" comments. |
| The key is in `advisory-allow.json` | Closes as `not_planned`, linking the allowlist row |
| `status: blocking` (the ramp expired) | Keeps it open, relabels it `advisory:now-blocking`, comments once |
| Missing in 2 consecutive runs where its gate completed | Closes as `completed`, citing the commit SHAs |
| Missing, but its gate was skipped or failed | Does nothing: unknown is not absent |
| Closed as `completed`, then the key returns | Reopens it as a regression |
| Closed by a person with no allowlist row | Leaves it closed and lists it on the dashboard under "closed without reviewed exemption" |

**The escalation row is the trap.** When a ramp expires, its advisory note turns into a `RAMP EXPIRED` failure (`tb/tools/lib/gate.mjs:319`). If the recorder simply stopped emitting the key at that point, the sync would close the issue as "fixed" at the very moment it became a hard failure. So the recorder must keep emitting the key with `status: blocking`.

Ramp issues carry a `ramp:until-X.Y.Z` label. `update` already knows locally which ramps expire at the target version, so it should list them as upgrade blockers.

**Labels.**

- `harness-advisory`: the identity filter.
- `advisory:<class>`: ramp, dossier, provenance, control-off, drift or lane.
- `gate:<id>`.
- `agent:ready`, `agent:attempted` or `agent:blocked`.

Group by gate, not by file: one label per file would explode, and label names are capped at 50 characters. Findings a ramp is still holding back become checklist lines inside that ramp's issue. Each failing scheduled lane gets one issue. That replaces the failed-run email, which today goes only to whoever last edited the cron schedule.

**Caps and first install.**

- At most 10 new issues per run and 50 open advisory issues in total.
- Promote in a fixed order (class priority, then confidence, then first seen, then key), so the same findings get promoted from run to run.
- On first install, or whenever the cap would be exceeded, use a baseline mode: everything goes on the dashboard, and new keys are promoted as slots free up. This keeps "all unfixed advisories" bounded on an existing codebase that adopts the harness.

**Won't fix.** Add `tools/advisory-allow.json` with rows `{key, reason, reviewedOn, until?}`, modelled on `duplication-allow.json`:

- protected by the write guard;
- listed in `ESCAPE_LISTS` (`tb/tools/check-gate-integrity.mjs:32`);
- covered by CODEOWNERS;
- checked in both directions by a local gate, as `check-suppressions` does: a key that no longer exists, or an `until` date that has passed, fails the gate.

When a reviewer answers a dossier hit with "justify divergence", that answer is written as the same kind of row. Closing an issue never exempts anything.

On public repos, GitHub disables scheduled workflows after 60 days without activity. `doctor` should warn when the last successful sync is more than 3 days old. It can use the same `gh api` lookup of workflow runs as `deploy-record.yml:104-112`.

## 4. Agent loop

**Options.**

- **`claude-code-action@v1` on a schedule.** It runs unattended when given a `prompt`. It rejects bot actors, and GitHub attributes a scheduled run to whoever last edited the cron. It strips HTML comments, so the key must be passed in the prompt. `include_comments_by_actor` limits whose comments it reads.
- **Claude Code routines** (research preview). Schedules run at most hourly. GitHub triggers cover only pull request and release events. Routines push to `claude/*` branches and act as the user.

Issues created with `GITHUB_TOKEN` never start `issues:` workflows, so the loop can only be driven by a schedule. That is what we want.

**Guardrails.**

1. **Selection.** Take the oldest `agent:ready` issue in an allowed class: dossier reuse or extract, provenance citation, or a ratchet `--write`. Never pick `now-blocking` or security classes.
2. **One at a time.** At most one run per day, a `concurrency` group, no run if a PR is already open on `claude/advisory-<key8>`, and at most 2 open agent PRs.
3. **Attempt budget.** Record each attempt in the marker. After 2 failures (PR closed without merging, or CI red), set `agent:blocked` with a 7-day cooldown. Only a person can relabel it.
4. **Done is checked by CI, not by the agent.** PR CI re-runs the recorder. The target key must be gone, and the advisory set must not grow on the same subjects; this stops "fixes" that just move a clone elsewhere. The Stop chain and the reviewer verdicts also apply, because the session loads the repo's `.claude/` hooks.
5. **No escape hatches.** Agent PRs may not touch `ESCAPE_LISTS`, `.github/`, `.claude/` or migrations. The write guards and CODEOWNERS already cover these; add a PR check for branches starting `claude/`.
6. **Limits.** A cap on diff size, `--max-turns`, `timeout-minutes`, and no auto-merge.
7. **Prompt injection.** The agent takes only the key and re-derives the finding by running the gate itself. Give it minimal `--allowedTools` and run harden-runner. "Comment and Control" (April 2026), PromptPwnd and Invariant Labs' toxic-flow attack all exploited agents that acted on text in issues or comments.

## Sources

- Code Security licensing: https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/
- SARIF:
  - https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github
  - https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support
  - https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/resolving-code-scanning-alerts
  - https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/assessing-code-scanning-alerts-for-your-repository
- Code Quality:
  - https://docs.github.com/en/code-security/concepts/about-code-quality
  - https://devops.com/github-code-quality-moves-to-general-availability-bringing-new-costs-and-capabilities/
- Rate limits:
  - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
  - https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Triggers:
  - https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/
  - https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/
  - https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
  - https://github.com/zizmorcore/zizmor/blob/main/docs/audits.md
- harden-runner:
  - https://docs.stepsecurity.io/guides/how-to-fix-a-blocked-endpoint-in-your-workflow
  - https://www.sentinelone.com/vulnerability-database/cve-2026-25598/
- `GITHUB_TOKEN` events: https://github.blog/changelog/2022-09-08-github-actions-use-github_token-with-workflow_dispatch-and-repository_dispatch/
- Autolinks: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
- Actions:
  - https://github.com/JasonEtco/create-an-issue
  - https://github.com/peter-evans/create-issue-from-file
  - https://github.com/sett-and-hive/sarif-to-issue-action
- Issue mechanics:
  - https://github.com/nexus-substrate/nexus-agents/issues/5729
  - https://github.com/orgs/community/discussions/27190
  - https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
  - https://github.com/aigency/gbd/issues/64
  - https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available/
- Claude:
  - https://code.claude.com/docs/en/github-actions
  - https://github.com/anthropics/claude-code-action/blob/main/docs/security.md
  - https://code.claude.com/docs/en/routines
- Prompt injection:
  - https://invariantlabs.ai/blog/mcp-github-vulnerability
  - https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-github-actions-security-20260503-csa-st/
  - https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents