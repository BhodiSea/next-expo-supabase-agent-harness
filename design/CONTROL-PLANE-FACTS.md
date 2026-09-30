# CONTROL-PLANE-FACTS — what Claude Code actually hands a hook

**Observed 2026-08-07, re-verified 2026-08-15** against Claude Code in the VS Code
extension (originally `CLAUDE_AGENT_SDK_VERSION=0.3.222`; the re-verification ran
against **Claude Code 2.1.232 / SDK 0.3.232**, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`,
same probe method — a probe hook in `.claude/settings.local.json` capturing raw stdin,
plus the empirical exit-code matrix for Fact 12 and the advisory re-query for Fact 10).
Facts 1, 2, 3, 5, 6, 10 and 12 were re-verified by execution; Facts 7, 8, 9, 11 and 13
are documentation-sourced and were re-read, not re-probed. Fact 14 (read 2026-09-30) is
documentation-sourced and has **not** been probed: it records what is documented about
`agent_id` across a resumed subagent, and the probe that still owes an observed answer.
Fact 15 (read 2026-09-30, for the 1.1.0 SessionStart brief) is documentation-sourced on the
same terms: what the `SessionStart` payload and output contract are documented to be, what
the brief relies on, and the probe that still owes an observed payload.
Fact 16 (2026-09-30) was probed against **Claude Code 2.1.285** in print mode: where the
model a subagent ran on can be read, which output of a green Stop hook reaches the user, and
the three answers the print-mode probe could not observe.
**Re-verify on any Claude Code upgrade.** Same discipline as `EXPO-FACTS.md` and `CI-LANE-FACTS.md`: dated,
sourced, re-verify-on-bump.

## Why this file exists

The harness's entire enforcement layer *is* `.claude/settings.json` plus hooks. That makes
Claude Code the harness's most important dependency — and the only one whose behaviour was
never verified by execution. 0.6.0's W4 rests on three payload facts that had been read from
documentation and never observed, and the repo's own standard is that **a proof that has only
ever been read is not a proof**.

Method: a probe hook (always exits 0, cannot block) registered in `.claude/settings.local.json`,
writing each invocation's raw stdin to a scratch file. A trivial subagent was then spawned.

## Fact 1 — `.claude/settings.local.json` is re-read MID-SESSION

The probe hooks were added to a running session and fired on the very next subagent. Hook
configuration does **not** require a restart. This matters twice: it is what makes probes like
this one cheap, and it is what makes `disableAllHooks` in a local settings file an immediate
single point of failure rather than a next-session one.

## Fact 2 — `SubagentStop` fires and carries everything W4 needs

Re-observed 2026-08-15 (2.1.232): the payload key list below is **key-for-key
identical**, `last_assistant_message` again arrived untruncated with the verdict as
its last non-empty line, and `agent_type` again matched the roster name.

Payload keys, verbatim:

```
agent_id  agent_transcript_path  agent_type  background_tasks  cwd  effort
hook_event_name  last_assistant_message  permission_mode  prompt_id
session_crons  session_id  stop_hook_active  transcript_path
```

| Field | Observed value | Why it matters |
|---|---|---|
| `last_assistant_message` | the subagent's **full** final text (487 chars in the probe, untruncated) | The mandated `VERDICT: PASS\|BLOCK` line lands here as a **first-class field**. No transcript scraping. |
| `agent_type` | `"general-purpose"` | Matches the roster name, so a hook can bind to exactly the reviewer set. |
| `session_id` + `prompt_id` | both present, UUIDs | The ledger key. `prompt_id` changes per user turn, which is what makes "did this reviewer run **this turn**" answerable. |
| `agent_transcript_path` | a real per-agent `.jsonl` | A fail-closed reader has a file to fall back to. |
| `stop_hook_active` | `false` | **Present on SubagentStop.** See Fact 4. |

The probe's subagent wrote prose *before* its verdict line, which is the realistic shape:
**the parse must read the last non-empty line**, not the whole message. Observed:

```
last non-empty line: "VERDICT: PASS"
```

## Fact 3 — `SubagentStart` fires too, with a narrower payload

Re-observed 2026-08-15 (2.1.232): identical seven-key payload.

```
agent_id  agent_type  cwd  hook_event_name  prompt_id  session_id  transcript_path
```

No `last_assistant_message` (nothing has been said yet). Usable for an "expected reviewer
started" record, not for a verdict.

## Fact 4 — the `Stop` payload, and `stop_hook_active` is REAL

2026-08-15 re-verification status: the `Stop` payload was re-captured (2.1.232) and is
**key-for-key identical** to the list below — `stop_hook_active: false` on an ordinary
turn, no `agent_*` fields, `last_assistant_message` present and untruncated. The
one-shot `true` transition was not re-run (it requires deliberately blocking a turn);
the 2026-08-07 observation stands for that half, at the original version.

`stop-validate-gate.mjs` reads `input?.stop_hook_active === true`, and
`docs/harness/README.md` states that it "escalates the message on repeat blocks". The current
hooks reference does **not** list it among the Stop event's fields, and every test in this repo
supplies it synthetically — so nothing proved Claude Code ever sends it. Now observed:

```
background_tasks  cwd  effort  hook_event_name  last_assistant_message  permission_mode
prompt_id  session_crons  session_id  stop_hook_active  transcript_path
```

`stop_hook_active: false` on an ordinary turn. **The field is real and the doctrine sentence
stands.** Two further notes worth keeping:

- `Stop` carries **no** `agent_*` fields (no `agent_id`, `agent_type`, `agent_transcript_path`)
  — those are the SubagentStop half. It does carry `last_assistant_message`, the same
  first-class field Fact 2 records.
- `session_id` + `prompt_id` are present, which is what lets `stop-validate-gate.mjs` pass the
  turn's identity down to Stop step `reviewer-verdicts`.

**And it goes `true`.** A one-shot probe hook was armed to block exactly once, and the Stop that
followed carried `stop_hook_active: true` under the **same `prompt_id`** — so the flag is real,
functional, and scoped to the turn rather than to the session:

```
#1  stop_hook_active=false  prompt_id=738c5caf   (an ordinary turn ending)
#2  stop_hook_active=false  prompt_id=f120181f   (the block itself — this turn's first)
#3  stop_hook_active=true   prompt_id=f120181f   (the continuation caused by that block)
```

Note #2: the payload of the invocation that BLOCKS is still `false`. The flag describes "you are
here because a hook blocked", not "a hook is about to block" — so a hook cannot use it to know
it is looping until the loop has already happened once. That is exactly why the block count in
`.harness/turn-outcomes.jsonl` is kept by the harness rather than read off this field.

## Fact 4b — settings `env` reaches a hook's process

Observed in the same capture. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` was absent from the hook
environment (this repo never set it), then present as `"8"` after being added to the `env` block
of `.claude/settings.local.json` — **without a restart**, which re-confirms Fact 1.

This is load-bearing rather than trivia: `readCap(process.env)` in
`.claude/hooks/lib/turn-outcomes.mjs` decides whether a block is the last one a turn gets, and
the scaffold sets that cap in `settings.json`'s `env` block. Had settings `env` applied only to
Bash-tool subprocesses and not to hooks, every consumer would silently fall back to the default
— which happens to be the same number, so nothing would ever have looked wrong.

## Fact 7 — a hook matcher is an EXACT TOOL NAME; a `Bash(...)` permission rule is not

This is the distinction 0.5.0's live bypass turned on, and it is easy to read past:

| Surface | `Bash(npm run *)` covers | Note |
|---|---|---|
| **permission rules** | Bash **and Monitor** | `PowerShell(...)` is a *separate* namespace |
| **hook matchers** | whatever the matcher string names, exactly | `"Bash"` matches the Bash tool and nothing else |

Matcher grammar, from the hooks reference: a matcher containing only letters, digits, `_`,
`-`, spaces, `,` and `|` is an **exact string or `|`/`,`-separated list of exact strings**;
anything else is compiled as an **unanchored** JavaScript regex (so `Edit.*` also matches
`NotebookEdit`); `"*"`, `""` or an omitted matcher matches all.

Two consequences the harness had wrong:

1. **`Monitor` runs commands.** It was reachable-around every content check in
   `pretool-bash-guard.mjs`.
2. **On Windows without Git Bash, Claude Code does not register the Bash tool at all** — the
   docs say so directly: *"A hook that matches only `Bash` never fires there."* The guard was
   not degraded on that platform; it was absent. `PowerShell` delivers its command in the same
   `tool_input.command` field, so matching it costs nothing but the matcher string.

Fixed in 0.6.0: `"matcher": "Bash|Monitor|PowerShell"`, held there by `check-wiring.mjs`.

**Not established, deliberately recorded as such:** whether `Monitor` commands are sandboxed
the way Bash commands are (the sandbox docs never mention Monitor); and whether a
`Bash`-matching PreToolUse hook fires for a skill's `` !`command` `` expansion (the docs call
that preprocessing and say nothing about hook dispatch). Do not build a control on either.

## Fact 8 — `Write(path)` permission rules are accepted and never consulted

File-permission rules are consulted under `Edit(...)` and `Read(...)`. A `Write(path)` rule is
accepted, warned about at startup, and never consulted — the one documented exception being a
`Glob` rule passed in `--allowedTools`. `NotebookEdit(path)` and `MultiEdit(path)` are in the
same inert class.

The shipped settings carry seven `Write(...)` denies. Every one has an `Edit(...)` twin, so
protection holds — but that was an accident of authoring in a file whose whole job is to be
asserted. `check-wiring.mjs` now requires the twin. The `Write(...)` lines stay: they cost
nothing, they document intent, and they are already right if Claude Code ever consults them.

## Fact 9 — path-scoped rules load on demand, and compaction drops them

| Instruction file | Loaded | Survives compaction |
|---|---|---|
| project-root `CLAUDE.md`, parent-dir `CLAUDE.md`, user memory | session start | yes |
| `.claude/rules/*.md` **without** `paths:` | session start | yes |
| `.claude/rules/*.md` **with** `paths:` | when a matching file is read | **no** — lost until a matching file is read again |
| nested `CLAUDE.md` in a subdirectory | when a file in that subtree is read | **no** — same |

`paths:` in a *rules* file takes a **YAML list** of globs (since 2.1.84). The comma-separated
string form documented for **skills** is not documented for rules — do not accept it.

The harness ships two scoped rules, `boundaries.md` and `mobile-server-split.md`, and both
already open with "best-effort scoped; the gates are the invariant". That framing is now
**verified rather than hopeful**: the loading semantics are exactly as those headers assume, so
the doctrine's rule — *never rely on conditional loading for invariants* — is satisfied by
construction rather than by luck.

`InstructionsLoaded` exposes a `load_reason` of `"compact"` when instruction files are
re-loaded after a compaction. **Which** file classes emit it is not documented, so a control
that watched for it and concluded "my scoped rule came back" would be resting on undocumented
behaviour.

## Fact 10 — the published advisory surface, queried 2026-08-07, re-queried 2026-08-15

`gh api "/advisories?ecosystem=npm&affects=@anthropic-ai/claude-code"` returns **28**
advisories. The maximum `first_patched_version` across all of them is **2.1.163**, which is
also the earliest version outside every published vulnerable range. That number, not a
round one, is the floor — see `template/base/tools/cc-floor.json` for the per-advisory
citations. The 2026-08-15 re-query returned the SAME 28 advisories and the same maximum
`first_patched_version`: no new advisory has published since 2026-07-24 (CVE-2026-55607),
so the floor is unchanged and only `checkedOn` moves.

Ten land on the harness's own enforcement surface: settings-file config injection
(CVE-2026-25725, patched 2.1.2), repo-controlled settings trust bypass (CVE-2026-33068,
2.1.53), two command-injection bypasses of file-write restrictions via piped `sed` and via
directory change (CVE-2026-25723 / -25722, 2.0.55 / 2.0.57 — *the "a text tripwire is not a
sandbox" class, as shipped CVEs rather than as this repo's own caveat*), symlink sandbox
escape (CVE-2026-39861, 2.1.64), Windows system-wide-config privilege escalation
(CVE-2026-35603, 2.1.75), and **two git-worktree escapes** (CVE-2026-40068, 2.1.84;
CVE-2026-55607, 2.1.163) — which is the answer to whether reviewer subagents should use
worktree isolation: only above the floor.

Two advisories on the `anthropics/claude-code` repository advisory page are scoped to the
`anthropic`/**Claude Desktop** ecosystem, not npm, and **must not** set this floor.

Separately, three changelog fixes matter to a harness whose enforcement layer is hooks, and
none carries a CVE: a PreToolUse hook returning `"allow"` could bypass `permissions.deny`
including enterprise managed settings (2.1.77); `permissions.deny` did not override a hook's
`permissionDecision: "ask"` (2.1.101); and `PermissionRequest` `updatedInput` was not
re-checked against `permissions.deny` (2.1.110).

## Fact 11 — only MANAGED hooks survive `disableAllHooks`

`disableAllHooks: true` in a user, project or local settings file stops every non-managed hook.
There is no setting that forbids a developer setting it, and no hook left to notice. The one
documented property that helps: *"Only `disableAllHooks` set at the managed settings level can
disable managed hooks."* So a hook survives if and only if it lives in the managed file.

Two near-misses worth keeping written down, because both look like the fix and are not:

- **`allowManagedHooksOnly` BLOCKS non-managed hooks.** Enabling it while the harness hooks
  still live in the project settings disables the harness — the outcome you were preventing,
  reached while trying to prevent it.
- **`allowManagedPermissionRulesOnly` drops user and project permission `allow` rules and
  `additionalDirectories`.** A real change to how every session behaves, not a hardening no-op.

Managed settings **parse tolerantly**: an entry failing schema validation is stripped with a
warning and the rest of the policy still applies, so one typo cannot take a whole policy down —
but it does remove that one protection, and `/doctor` is what lists stripped entries with their
source file and field.

Do **not** use `/hooks` to prove a managed hook loaded. Its source labels are User / Project /
Local / Plugin / Session / Built-in — there is no managed category, and whether managed hooks
appear there is undocumented. The documented proofs are `/doctor`,
`claude --debug-file <path> --init-only`, and
`claude -p --output-format stream-json --verbose --include-hook-events`.

Deployment paths, the drop-in directory semantics, the minimal correct policy, and why a managed
hook needs a dispatcher (it fires in *every* project on the machine, including ones with no
harness installed) are in `template/base/docs/security/managed-settings.md`.

## Fact 12 — a hook file that cannot PARSE fails OPEN (probed 2026-08-10, node v26; re-probed 2026-08-15, node v26.4.0 — matrix identical)

The fail-closed guarantee lives *inside* `hooks/lib/hookio.mjs` — its
`uncaughtException`/`unhandledRejection` → `exit(2)` handlers — and those install only after
the module loads. Damage that prevents the load never reaches them. Probed empirically against
the shipped hooks (`pretool-write-guard.mjs` and `stop-validate-gate.mjs`, realistic stdin):

| damage to `hookio.mjs` | node's failure | exit | Claude Code's reading |
|---|---|---|---|
| truncated mid-statement (60%) | in-file `SyntaxError: Unexpected end of input` | 1 | non-blocking — **action proceeds** |
| truncated to 0 bytes | valid empty module; importer throws `does not provide an export` | 1 | non-blocking — **action proceeds** |
| deleted | `ERR_MODULE_NOT_FOUND` | 1 | non-blocking — **action proceeds** |
| intact, malformed stdin | runtime throw → installed handler | 2 | **blocked** (fail-closed, correct) |

One torn file therefore disarms all three PreToolUse guards, both PostToolUse hooks and the
Stop chain at once — and the Stop hook exiting 1 lets the turn END with no validate, so
gate-integrity (which would name the sha mismatch) never runs locally; first detection is CI.
The 0.9.0 mitigations: the installer's write primitive stages to a dot-tmp and renames (a
destination is old bytes or new bytes, never a truncation), `update --rollback` restores the
recorded pre-update tree, and the upgrade runbook's RECOVERY section names the torn-hook case
as the urgent one. The fail-closed *launcher* SHIPPED at 1.0.0
(`.claude/hooks/launch.mjs` — every GUARD hook's command routes through it, and a hook that
cannot load exits 2 and blocks; proven by the launcher block in
tests/hooks/hook-contract.test.mjs against exactly this matrix). The residual is the launcher
itself: one import-free file whose own tearing still fails open, re-probed at every Claude
Code pin bump. The one hook that blocks nothing, the 1.1.0 SessionStart brief, is invoked
directly instead: the launcher reports a load failure as "failing closed, action blocked",
which would be false for an event that cannot block, and the brief exits 0 on every path
(Fact 15).

## Fact 13 — a bare tool name in `permissions.allow` retires every scoped rule for that tool

Within a scope the evaluation order is deny → ask → allow, first match wins, and **rule
specificity does not reorder anything** — so `"WebFetch"` in `allow` sitting beside eight
`"WebFetch(domain:…)"` entries means the domain scoping is decorative: the bare entry matches
first, every time. Same for `"Bash"` beside `"Bash(pnpm validate:*)"`. Removing the bare entry
does not hard-deny the tool — a non-matching call falls through to the PROMPT default — and a
deny rule (`Write(./.claude/hooks/**)`) holds over any allow, from any scope ("deny rules from
any scope are evaluated before allow rules"). The shipped scaffold settings carried bare
`Bash`/`WebFetch`/`WebSearch` allows at 0.8.0; 0.9.0 drops them.

## Fact 14 — `agent_id` across a RESUMED subagent: documented, NOT yet observed

**Status, 2026-09-30: documentation-sourced, not probed, no Claude Code version observed.**
Recorded before the reviewer ledger v2 (1.1.0, #70) coded its standing-BLOCK rule, because
that rule keys on `agent_id`: a BLOCK stands until the SAME `agent_id` returns PASS at the
current digest. The session that wrote 1.1.0 could not start a Claude Code session of its
own, so the probe below did not run; it is an owner step, and the rule is built to fail
closed on either answer.

What the documentation states, read 2026-09-30:

- The subagents page: *"Claude uses the `SendMessage` tool with the agent's ID or name as
  the `to` field to resume it"*, and *"Resuming starts a new run of the agent under the same
  ID, so a subagent that had already failed or completed shows as running again in the task
  list and in the Agent SDK's task events."* So a resumed reviewer is documented to keep its
  `agent_id`.
- The hooks page: `SubagentStart` *"Fires when a subagent is spawned"*, and its payload
  carries `agent_id` (*"Unique identifier for the subagent"*), `agent_type` and `prompt_id`,
  as SubagentStop's does (Facts 2 and 3). **Whether `SubagentStart` fires again when a
  completed subagent is resumed is not stated anywhere.**

What the ledger v2 relies on, and what happens if either reading is wrong:

1. **A resumed reviewer keeps its `agent_id`.** That is what lets a reviewer clear its own
   BLOCK: fix what it named, resume it, and its PASS at the current digest clears the
   BLOCK. If a resume issued a new id instead, the resumed PASS would read as a second
   opinion, which retracts nothing, and the BLOCK would stand for the rest of the session.
   That fails closed: a new session starts from an empty ledger view, because the ledger is
   session-scoped.
2. **`SubagentStart` fires for the resumed run.** The hook records a dispatch digest at
   every `SubagentStart` and pairs a verdict with the LATEST dispatch record for its
   (`session_id`, `agent_id`). If a resume fires no `SubagentStart`, the resumed verdict
   pairs with the original dispatch: when the tree moved in between (the usual case after
   fixing a BLOCK), its start and stop digests differ and the PASS is not counted. That also
   fails closed, and the finding says the tree moved during the review.

**The probe**, the same method as Facts 2 and 3: a probe hook for `SubagentStart` and
`SubagentStop` in `.claude/settings.local.json` that appends raw stdin to a scratch file;
spawn a trivial subagent and let it finish; resume it with `SendMessage`; let it finish
again. Record the Claude Code version, the `agent_id` on all four payloads, and whether a
second `SubagentStart` arrived. If the id changes, or no second `SubagentStart` arrives,
write it here and open an issue against the standing-BLOCK rule: the rule stays fail-closed,
but a reviewer could then clear its own BLOCK only in a new session.

## Fact 15 — the `SessionStart` payload and output contract: documented, NOT yet observed

**Status, 2026-09-30: documentation-sourced, not probed, no Claude Code version observed.**
Recorded before the 1.1.0 SessionStart brief (`.claude/hooks/session-brief.mjs`, #60) was
wired, because the hook's whole contract rests on what this event does with its output. The
session that wrote it could not start a Claude Code session of its own, so the probe below
did not run; it is an owner step, and the hook is built so that neither answer can make it
block or leak.

What the hooks reference states, read 2026-09-30 (https://code.claude.com/docs/en/hooks):

- **When it fires, and the `source` it carries.** On a new session (`startup`), `--resume`,
  `--continue` or `/resume` (`resume`), `/clear` (`clear`), auto or manual compaction
  (`compact`), and a forked session (`fork`; before v2.1.214 a fork reported `resume`). The
  matcher is matched against `source`, so `"matcher": ""` fires on all five.
- **The payload.** The common fields (`session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, and `prompt_id` only after the first user input), plus `source`, and
  optionally `model`, `agent_type` and `session_title`; on a `resume` or `fork` with at least
  one response, also `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired` and `estimated_cache_write_usd`.
- **The output.** It cannot block. On exit 0, stdout that does not both start with `{` and end
  with `}` is plain text, and plain text is added to Claude's context; `SessionStart` is one
  of the four events that do this. Exit 2 "shows stderr to user only" (the per-event exit-2
  table). Plain stdout is capped at 10,000 characters, measured whole; over it, Claude Code
  saves the output to a file and keeps a 2,000-character preview. The default timeout is 600
  seconds, and a hook runs "in the current directory with Claude Code's environment".

What the brief relies on, and what happens if a reading is wrong:

1. **Plain stdout on exit 0 reaches the context.** The brief's first line always starts with
   `harness`, so it can never parse as JSON output. If plain stdout did not reach the context,
   the brief would be lost, and nothing else changes: the hook blocks nothing either way.
2. **Exit 2 is not a block here.** The hook never exits 2: it does not import
   `lib/hookio.mjs`, is not routed through `launch.mjs`, loads its lib in a try/catch, and
   exits 0 on an uncaught error. If exit 2 did block, the hook still never produces one.
3. **Nothing in the payload is needed.** The hook never reads stdin, so no payload byte, and
   no field the documentation adds later, can reach the brief. The brief reads the whole turn
   ledger rather than scoping by `session_id`, because a new session's id matches none of the
   earlier records. Its output is capped at 1,200 characters, well inside the 10,000 above.

**The probe**, the same method as Facts 2 and 3: a probe hook for `SessionStart` in
`.claude/settings.local.json` that appends raw stdin to a scratch file and prints one marker
line; start a session, `/clear`, `/compact`, and resume it. Record the Claude Code version, the
payload keys for each `source`, and whether the marker line reached the context (ask the model
to quote it). Write the result here, and delete the obligations row
`control-plane-facts-sessionstart-probe` in the same diff.

## Fact 16 — the model a subagent ran on, and the channel a green Stop can speak on: observed in print mode

**Status, 2026-09-30: observed against Claude Code 2.1.285 in print mode (`claude -p`),
except where a point says "not observed".** Recorded before `reviewer-verdicts` started
judging the model a reviewer's verdict ran on (1.1.0, #62). Method, the same as Facts 2, 3
and 14: a scratch project whose `.claude/settings.local.json` wired one probe hook to
`SubagentStart`, `SubagentStop` and `Stop`. The hook appended raw stdin to a scratch file
and copied the file at `agent_transcript_path` as it stood when `SubagentStop` ran. A probe
agent, `probe-reviewer`, pinned `model: haiku`, carried a `harnessFallbackModels: sonnet,
claude-probe-nonexistent-1` line and ended with `VERDICT: PASS`; a second agent,
`probe-broken`, pinned `model: claude-probe-nonexistent-1`. Six runs, each one `claude -p`
prompt that dispatched one agent with the Agent tool: `probe-reviewer` on its pin; the same
with the Agent tool's `model` parameter set to `sonnet`; the same under
`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`; `probe-broken`
with no chain; `probe-broken` under `--fallback-model haiku`; and a turn with no subagent
whose Stop hook printed `{"systemMessage": …}`, once more with stderr only, both under
`--output-format stream-json --verbose`. The documentation cited below was read on
2026-09-30 from `code.claude.com/docs/en/hooks`, `/sub-agents` and `/model-config`.

1. **Does any Subagent* payload name a model? No, observed.** `SubagentStart` carried
   `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `agent_id`,
   `agent_type` and `hook_event_name`. `SubagentStop` carried those plus `permission_mode`,
   `effort` (on some runs), `stop_hook_active`, `agent_transcript_path`,
   `last_assistant_message`, `background_tasks` and `session_crons`. `Stop` carried no model
   either. The hooks page agrees: *"Only `SessionStart` hooks can receive a `model` field"*.
2. **Where does the subagent's transcript record the model? On each assistant line, at
   `message.model`, as a full model ID, observed.** The transcript is JSONL. Its lines have
   `type` `user`, `attachment` or `assistant`. Every `assistant` line (one per API response
   block: a `thinking` line with `stop_reason: null`, then the `text` line with
   `stop_reason: "end_turn"`) carries a `message` object whose `model` is the model that
   produced it. The alias pin `haiku` was recorded as a dated full ID of its family
   (`claude-haiku-<version>-<yyyymmdd>`); `sonnet` passed as the per-invocation `model`,
   and `sonnet` forced by the environment, were each recorded as an undated full ID
   (`claude-sonnet-<major>-<minor>`). So a plain string comparison with an alias pin would
   never match, which is why `modelMatches` matches an alias against its family. The last
   line of the file was an `attachment`, which carries no `message`, so the reader takes the
   model of the last `assistant` line, not of the last line. **After a failover** (run 5:
   the pin answered HTTP 404, `--fallback-model haiku` took over) no assistant line for the
   failed request was written: every assistant line carried the fallback's ID, while an
   `attachment` of type `model` still told the agent it ran on the pinned model. The model
   that ran is `message.model`, never that attachment. A line with `model: "<synthetic>"`
   (a line Claude Code writes itself) was not observed; the reader skips one defensively.
3. **Where does that transcript live, and can the main agent write to it?** Observed at
   `~/.claude/projects/<project path with each "/" as "-">/<session_id>/subagents/agent-<agent_id>.jsonl`,
   and complete, final assistant line included, when `SubagentStop` ran. That is outside
   the project tree, where the write guard does not reach, and under `~/.claude` the shipped
   permissions deny edits only to `settings.json` and `settings.local.json`. Whether the main
   agent's Edit tool may write there was **not observed**. So the model record is the hook's
   reading of a file the session could have edited: it catches a configuration that moves a
   reviewer off its pin (an override, a substitution, a chain), not an agent that forges its
   own transcript. A deny on `~/.claude/projects/**` would also deny Claude Code's own
   writes there, so none ships.
4. **Which output of a Stop hook that exits 0 reaches anyone? A JSON `systemMessage` on
   stdout, observed.** Under `--output-format stream-json --verbose`, a Stop hook that printed
   `{"systemMessage": "<text>"}` and exited 0 produced a `system` event of subtype
   `informational`, level `notice`, content `Stop says: <text>`, and the turn ended
   (`result`, subtype `success`). The same hook writing the text to stderr instead produced
   only the raw `hook_response` event that `--verbose` streams for every hook, and no notice.
   Plain `-p` text output showed neither. The hooks page says the same: *"Stderr from a hook
   that exits 0 goes to the debug log only, never the transcript, and Claude never sees
   it"*, and `systemMessage` is a *"Warning message shown to the user"*.
   `hookSpecificOutput.additionalContext` would reach Claude, but it keeps the conversation
   going, so it is a continuation, not a notice. How the interactive terminal, the VS Code
   extension and the desktop app render the notice was **not observed**. This is why
   `stop-validate-gate.mjs` sends the lines naming a non-pinned verdict through
   `systemMessage` on a green run (1.1.0), and why its other green-run stderr (skipped and
   stamped layers) reaches only the debug log.
5. **Does SubagentStop fire when a subagent ends on a model error? No, observed (run 4).**
   `probe-broken` got `SubagentStart` and no `SubagentStop`; the Agent tool returned
   `Agent terminated early due to an API error: There's an issue with the selected model
   (claude-probe-nonexistent-1)` with `model_not_found, HTTP 404`. So no ledger entry is
   written and the reviewer stays owed. No `SubagentStop` field named `stop_reason` exists.
   Under `--fallback-model haiku` (run 5) the same 404 was covered by the chain: the
   subagent finished on the fallback, `SubagentStop` fired with an ordinary
   `VERDICT: PASS`, and the Agent tool reported no error. That run is the failure this
   record exists for: a PASS from a model nobody listed, visible only in the transcript.
6. **Do the loaders accept an unknown frontmatter key? The project agent loader does,
   observed.** `probe-reviewer`, carrying `harnessFallbackModels`, loaded and ran with no
   error or warning. The plugin loader was **not observed**; the subagents page says
   *"Claude Code ignores a field it doesn't recognize without reporting an error"*, and the
   plugins page does not list an unknown key as a load failure. The key is prefixed so that
   no future Claude Code field can take its name: Claude Code does not act on it, and only
   the harness reads it.
7. **How does each mechanism move a subagent off its pin?** Observed at 2.1.285:
   - the Agent tool's per-invocation `model` (`sonnet`) overrode the frontmatter pin
     (`haiku`);
   - `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` ran the
     `haiku`-pinned agent on the Sonnet ID;
   - a `--fallback-model` chain moved a subagent whose pin failed onto the fallback,
     silently (point 5).

   Documented, not observed: the resolution order is the per-invocation `model`, then the
   frontmatter `model`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation's
   model (*"Before v2.1.251, `CLAUDE_CODE_SUBAGENT_MODEL` came first in this order"*);
   `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` *"Requires Claude Code v2.1.257 or later"*; a family
   alias *"resolves to the main conversation's model instead of the version the alias points
   to"* when the main conversation is in that family, *"including any `[1m]` suffix"*; an
   `availableModels` allowlist substitutes for a blocked value (the newest permitted version
   of a blocked family alias since v2.1.222, otherwise the inherited model); the
   `fallbackModel` chain applies to subagents since v2.1.247 (*"Before v2.1.247, a failure
   the chain covers ended the subagent instead"*); a request a safety classifier flags
   re-runs on a named fallback model since v2.1.219; and `/tasks` names the model on a
   subagent's row (v2.1.242), for a human, not a hook.

   The alias rule in `modelMatches` follows from points 2 and 7: an alias entry matches any
   model ID of its family, and a full ID matches only itself. The harness ships no session
   `fallbackModel` chain, so `tools/cc-floor.json` does not move.

**Still owed.** Three things the print-mode probe could not show: how the interactive
terminal, the VS Code extension and the desktop app render a green Stop's `systemMessage`;
whether the plugin loader accepts `harnessFallbackModels`; and whether the main agent's
Edit tool may write a subagent transcript. To observe the first, wire the same probe Stop
hook, printing `{"systemMessage": …}`, in each surface and end one turn there; for the
second, load the harness as a plugin (`--plugin-dir`) and dispatch a reviewer; for the
third, ask the main agent, under the shipped permissions, to edit a subagent transcript
under `~/.claude/projects/`. Record each here and
delete the obligations row `control-plane-facts-reviewer-model-probe` in the same diff. If
a later Claude Code moves the model off `message.model`, every entry records
`model: null`, and the null finding names this Fact: fix `transcriptModel` and its fixture
in the same diff.

## Fact 5 — no CI lane in this repository spawns Claude at all

Searched `.github/workflows/` and `template/base/github/workflows/` for `claude -p`,
`claude --print` and `anthropics/claude-code`: **no matches** (re-run 2026-08-15,
still zero).

This settles an open W4 risk. Since v2.1.198 subagents run in the background by default, and in
non-interactive mode a tool call is denied when no `PermissionRequest` hook returns a decision —
so the reviewer roster could in principle be silently denied its tools in a headless lane.
There is no headless lane, so the risk is **not live today**. It becomes live the moment
someone adds one, which is the reason this is written down rather than concluded and forgotten.

## Fact 6 — the hook environment

Variables a hook can see (`CLAUDE*` / `HARNESS*` only), re-captured 2026-08-15
(2.1.232 / SDK 0.3.232):

```
CLAUDECODE=1                       CLAUDE_CODE_ENTRYPOINT=claude-vscode
CLAUDE_PROJECT_DIR=<repo root>     CLAUDE_CODE_SESSION_ID=<uuid>
CLAUDE_PID=<pid>                   CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_AGENT_SDK_VERSION=0.3.232   CLAUDE_EFFORT=xhigh        (SubagentStop only)
CLAUDE_CODE_ENABLE_TASKS=0         CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true
CLAUDE_CODE_MESSAGING_SOCKET=<path>   CLAUDE_CODE_MESSAGING_TOKEN=<hex>   (new at 2.1.232)
```

Two deltas since 2026-08-07, both additive: `CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN` now reach hooks — treat the token as a secret (a hook
that logs its environment now logs a credential). A `CLAUDE_CODE_EXECPATH` variable was
observed in the **Bash-tool subprocess** environment but NOT in the hook environment;
the two channels are not the same set, which is one more reason a hook must read the
payload, not the ambient env. `CLAUDE_CODE_CHILD_SESSION=1` was again observed in a
MAIN VS Code session — re-confirming that a control keyed on it would misfire.

`CLAUDE_CODE_SESSION_ID` duplicates the payload's `session_id`; prefer the payload, which is
the documented channel and is present for every event.
