# FIELD-UPGRADES-2026-09 — upgrade proposals from a field report, each stated against this repository's code

**Verified 2026-09-20** against `main` at `494447f` (version 1.0.2, untagged). Every
`path:line` below was read at that commit. Four pull requests open on that date (#21 to
#24) move some of these lines and change a few of the cited facts; the sections that
depend on one say so. **Re-verify a section's citations before acting on it.** Same
discipline as the `*-FACTS.md` files beside this one: dated, sourced, re-verified when
the code moves.

## Why this file exists

These proposals came out of a retrospective on a private project built with this
harness. That project's code, findings and numbers are private and none of them appear
here. What the retrospective contributed is a list of places to look. Each section then
states the defect from this repository's own code, so a reader can check it with nothing
but a clone. Where the code shows no defect, the section says "no defect claimed" and
stands as a proposal only.

`ROADMAP.md` requires every item to link to the record that tracks it. This file is that
record for the roadmap's "Field-report upgrades" section. Nothing here is a commitment:
no item has a row in `scripts/obligations.json`, and the maintainer decides which become
binding.

## How to read a section

- **Class** is one of: *1.1.0, no ramp* (nothing tightens for an existing install),
  *1.1.0, behind a ramp* (a verdict changes for an existing install, so it ships as a
  dated note first), *2.0.0, breaking*.
- **Defect** cites this repository. Paths are repository-relative, and a bare `:line`
  refers to the file cited just before it.
- **Guard** is what keeps the change from weakening a gate. A proposal whose guard
  cannot be built should not be built.
- An item that adds a check, or changes what an existing check judges, says **needs a
  `gate-proposal` issue first** (`CONTRIBUTING.md`, ground rule 6).
- Sections are labelled N (no ramp), R (ramped) and B (breaking) so they can cite each
  other. The labels carry no priority.

---

# 1.1.0, no ramp

## N01: Input-stamped Stop steps

**Defect.** The Stop hook runs every entry of `STOP_HOOK_STEPS` at every turn end; the
loop has no skip path (`template/base/.claude/hooks/stop-validate-gate.mjs:136-142`;
the ten entries are `template/base/tools/harness.config.mjs:170-218`). Input stamps
exist (`stampGate`, `template/base/tools/lib/gate.mjs:278-287`), but all twelve call
sites are gates inside the `validate` entry. None of the other nine entries is stamped,
and they include the two slowest kinds of work the hook does: the database isolation
suite and the two unit-test runs.

A stamp hit is also invisible. It prints an ordinary `OK` line (`gate.mjs:41-43`), and
the Stop hook surfaces only lines that contain `SKIPPED` (`stop-validate-gate.mjs:157-159`),
so a turn that ended on warm stamps reads exactly like a turn that re-proved everything.

Third, a stamped gate's declared inputs include its own script and the stamp machinery
(`template/base/tools/lib/stamp-inputs.mjs:16-17`) but not the `tools/lib/*.mjs` modules
that script imports. `tenancy` declares five data paths (`:172-178`) and imports
`lib/sql-parse.mjs`, the module that decides what a policy predicate says; editing the
parser leaves `.harness/tenancy.ok` warm. CI never honours a stamp (`gate.mjs:281`) and
`update` clears them (`installer/commands/update.mjs:176-184`), so the residue is a
local edit to a gate library, which is the moment a re-run matters most.

**Proposal.** Stamp the slow Stop entries on declared inputs, `rls-isolation` first,
then the unit-test wrappers. Print `STAMPED` as its own status and have the Stop hook
list stamped steps beside skipped ones. Before either, close the import gap: derive each
stamped script's `./lib` imports and hash them with the script.

**Guard.** CI ignores stamps, as today. An input list is reviewed data in an owned file
and its failure mode is a missing input class, so the first stamped Stop entry lands
with a test that fails when a stamped script imports a library file its list omits.
Steps are never chosen by classifying the diff (see "Dropped after design review").

## N02: Stop-step and gate-event telemetry

**Defect.** The per-turn ledger records which gates blocked, by name, and nothing else:
no step durations and no in-turn events
(`template/base/.claude/hooks/lib/turn-outcomes.mjs:194-216`). It is trimmed to the last
200 records across all sessions (`:62`, `:217`; the cost is documented at `:179-184`).
The PreToolUse and PostToolUse hooks write only to stderr or to the deny response
(`template/base/.claude/hooks/posttool-fast-check.mjs:29`,
`template/base/.claude/hooks/posttool-source-check.mjs:51-54`,
`template/base/.claude/hooks/lib/hookio.mjs:45-56`), so a red that was fixed mid-turn
leaves no trace. `validate` prints `VALIDATE_TIMINGS` to stdout and deliberately writes
no file (`template/base/tools/validate.mjs:273-282`); its only reader is the factory's
`scripts/check-chain-budget.mjs:107`, from a piped CI log.

An install therefore has no data on which steps cost the time, which gates fire most or
which guard rules deny most. Those are the numbers most of the proposals in this file
should be judged with.

**Proposal.** Append-only, untrimmed JSONL under `.harness/`: one record per Stop step
(`step`, `status`, `ms`) and one per in-turn gate or guard event (`hook`, the rule or
gate id, `outcome`). The objection at `validate.mjs:273-275` is to artifacts that show
up in `git status`; `.harness/*` is ignored (`template/base/gitignore:56-57`).

**Guard.** Bookkeeping never decides an outcome: a record that cannot be written changes
no exit code. No gate reads the log. Records hold enumerated fields and ids, never file
content or command text.

## N03: Preflight residue hygiene and a pinned runner environment

**Defect.** The local database lane resolves its tools from `PATH` with no version
check: `supabase` at `template/base/tests/rls/run-rls.mjs:35-37`, `:62` and `:73`, and
`psql` at `template/base/tests/rls/auth-trail.test.ts:29-31`. The scaffold pins the CLI
as a workspace dependency (`template/base/package.json.tmpl:55`), and CI puts that copy
on `PATH` in a step of its own and says why
(`template/base/github/workflows/quality-gate.yml:240-248`). Locally nothing does: the
Stop entry starts the runner with plain `node`
(`template/base/tools/harness.config.mjs:174`), so the binary that answers is whichever
one the machine has. `auth-trail.test.ts:22`
hardcodes the database URL with port 54322, while its sibling reads the running stack's
values from the environment (`template/base/tests/rls/db-context.ts:15-17`, populated at
`run-rls.mjs:83-87`). Node is pinned to a major version only (`template/base/nvmrc`,
`template/base/node-version`, `package.json.tmpl:9-11`).

Residue accumulates with nothing to clear it. `.harness/stop-output/<gate>.log` is
written and never deleted (`template/base/.claude/hooks/stop-validate-gate.mjs:40`,
`:50-51`), and the `build` gate leaves `apps/mobile/dist` behind
(`template/base/tools/build-check.mjs:194`). The installer has no verb for either job
(`installer/cli.mjs:68-90`).

**Proposal.** `doctor` gains a toolchain report: for `node`, `pnpm`, `supabase` and
`psql`, the resolved binary, its version and the pin it is compared with. `doctor
--clean` removes an enumerated list of ignored residue. `run-rls.mjs` resolves the
workspace's CLI, and `auth-trail.test.ts` takes its URL from the same `supabase status`
output as its sibling.

**Guard.** The clean list is a constant in an owned file and every entry must be
git-ignored. Stamps are not on it by default. The toolchain report informs and fails
nothing; the gates that need a tool keep their own skip-or-fail rule.

## N04: A CI-parity flag for validate

**Defect.** Two behaviours differ between a local run and CI, both keyed on one
predicate (`template/base/tools/lib/gate.mjs:15-16`): a missing prerequisite skips
locally and fails in CI (`:55-64`), and a stamp short-circuits locally and never in CI
(`:281`). `validate` reads four flags (`template/base/tools/validate.mjs:61`,
`:111-140`) and none of them sets that predicate. The way to get CI's posture locally
is to export `HARNESS_REQUIRE_TOOLCHAINS=1` by hand (`docs/cli.md:111`); otherwise the
variable is set only as workflow `env`
(`template/base/github/workflows/quality-gate.yml:38`).

**Proposal.** `node tools/validate.mjs --ci-parity` sets the predicate for the run: no
skips, no stamps, and a closing line naming each prerequisite that was missing.

**Guard.** The flag can only tighten. It is an option of the existing runner, not a
step, so the chain and its frozen floor are unchanged.

## N05: A dated deferral for a surface that is not built yet

**Defect.** The `mobile` path filter in
`template/base/github/workflows/quality-gate.yml:454-494` includes
`packages/contracts/**` (`:469`), `packages/api/**` (`:475`) and
`packages/verticals/**` (`:479`), and it arms `mobile-e2e` (`:755-763`, ceiling 120
minutes) and `perf-lane` (`:918-926`, ceiling 90). The file argues for the inclusion at
`:473-474`, and for a project whose app is real the argument holds. A project that is
building its web surface first has no way to say so. There is no surface register
(`template/base/tools/deferrals.json:2` is the harness's own ledger, `tools/modules.json`
lists modules, and the installer asks no surface question), and the per-gate "surface
absent" path fails closed in CI by design (`template/base/tools/check-web-e2e.mjs:36`).
Every backend pull request in such a project arms both device lanes against the app the
scaffold shipped.

**Proposal.** A seeded `tools/surfaces.json` with rows of `surface` (`mobile` or `web`),
`deferredUntil` and `reason`. Only the device and perf lanes in CI read it. While a
deferral is live and honest, those lanes report `skipped` with the reason.

**Guard.** Dated: past `deferredUntil` the lanes run again and the row reds. Content
tripwire: a deferral is void as soon as the surface's tree differs from what the
installer planted (the manifest holds the shas), so the first real screen re-arms the
lanes. Static, unit and security gates never read the register. The tripwire is a new
check: **needs a `gate-proposal` issue first**.

## N06: Skip a lane that already passed on the same tree

**Defect.** `template/base/github/workflows/quality-gate.yml` triggers on
`pull_request` and on `push` to the default branch, with no `paths:` filter on either
(`:12-19`). The concurrency group is keyed on `github.ref` (`:24-26`), which differs
between a pull request and the push its merge produces, so neither run cancels the
other. Six lanes carry no `if:` and run on both events: `static` (`:34`), `unit`
(`:75`), `mutation` (`:154`), `runtime-rls` (`:211`), `e2e-fast` (`:288`) and
`integration-lane` (`:325`). Nothing in the shipped workflows compares trees.

**Proposal.** On `push`, a lane first asks whether the same lane concluded `success` on
a commit with the same tree hash. If so it exits early and names the run it relied on.

**Guard.** Only `success` counts; skipped, cancelled and neutral do not. The key is the
tree hash, so a merge that changed anything (a branch that was behind its base, a
conflict resolution) runs everything. Scheduled and dispatched runs never skip. The
required `gate-summary` check keeps its meaning, because an early exit is a pass that
cites a pass.

## N07: Legal empty states on day 0, and a factory lane that proves them

**Defect.** Three closures cannot be satisfied by a project that has removed the worked
example.

- `perf-budget` names the example as a constant
  (`template/base/tools/check-perf-budget.mjs:60`) and ships it as the only subject
  (`template/base/tools/perf-budget.json:3-10`). A subject whose file is gone is an
  error (`check-perf-budget.mjs:527-530`), an empty `subjects` array is an error
  (`:400-404`), and the file is write-guarded
  (`template/base/.claude/hooks/lib/guard-rules.mjs:555`). No state of the file is both
  green and free of the example.
- The event catalog generator imports the example vertical by name
  (`template/base/tools/gen-event-catalog.mjs:22-27`). Deleting the vertical breaks the
  import and reds `contracts`. The file argues for a curated list over a barrel scan
  (`:7-11`), and the argument is about curation, not about naming the example.
- The account-deletion closure reads its action id and function name from
  `template/base/tools/store-tunables.json:5-9` and hardcodes the registry path inside
  the example's feature directory (`template/base/tools/check-expo-policy.mjs:857-866`).

No factory lane runs the chain with the example removed. Every `selftest.yml` job
scaffolds the full template, and the one step that touches the example adds a file and
removes it again (`.github/workflows/selftest.yml:406-410`).

**Proposal.** Each closure gets an explicit empty state. `subjects: []` is accepted only
with a dated reason row. Event catalogs are discovered from a named export of each
vertical's `./client` entry, which keeps the per-vertical opt-in and drops the example's
name from an owned tool. The registry path moves into `store-tunables.json`. A factory
lane deletes the example from a scaffold and requires the chain green.

**Guard.** An empty state is a reviewed row with a reason, never a silent pass, and the
direction that matters (every real subject measured, every real event catalogued) is
unchanged. The factory lane is the can-fail proof. Prerequisite for B01.

## N08: Behavioural database proofs on a fixture table

**Defect.** The pgTAP suites prove the security rails by exercising the example table.
`public.notes` is named 29 times in
`template/stack/supabase/tests/rls_isolation.test.sql` (for instance `:225-229`), 17
times in `template/stack/supabase/tests/mfa_aal2.test.sql` (`:207-210`) and 7 times in
`template/stack/supabase/tests/audit_immutability.test.sql` (`:215-218`). The
supabase-js twin queries it too (`template/base/tests/rls/cross-tenant-isolation.test.ts:172`,
`:179`, `:186`; `template/base/tests/rls/db-context.ts:250`). A project that deletes the
example deletes its proofs of isolation, of the step-up rail and of audit capture with
it. The suites already contain the alternative: `rls_isolation.test.sql:822` creates a
scratch table inside the test transaction, because no shipped table could show the
property in question (`:818-820`).

**Proposal.** Behavioural proofs build their own fixture table inside the transaction,
with policies written the way the authoring skill teaches, and roll it back. Structural
proofs keep enumerating the real tables.

**Guard.** The two halves stay distinct and both stay present: the fixture proves the
rail works, the structural closure proves every real table is on the rail. A fixture
whose policy shape drifts from the taught shape proves nothing, so the fixture's DDL
and the skill reference (N09) come from one source. These files are seeded, so the
change reaches new scaffolds only; an existing install keeps the suites it has.

## N09: Skill references generated from the example

**Defect.** The four reference files under
`template/base/.claude/skills/authoring-vertical-slice/references/` are hand-written
descriptions of the example (`dal-dto.md:6-7`, `migration-rls.md:7-8`). None of the seven
`template/base/tools/gen-*.mjs` generators writes or checks them. The one check that
reads them is `prompts`, which compares the prose with a hash of itself
(`template/base/tools/check-prompts-lock.mjs:122`). The example can change shape and
the references keep teaching the old one with every gate green.

**Proposal.** The code-bearing parts of the references become generated regions,
extracted from marked spans of the example's source, with a `--check` mode run in the
factory.

**Guard.** Generation runs upstream, where the example compiles and is tested; an
install receives markdown. Prose around the regions stays hand-written. This is what
lets B01 take the example out of a scaffold without taking out what it teaches.

## N10: A session-start brief and a status command

**No defect claimed.** `template/base/.claude/settings.json` wires four hook events
(`PostToolUse` `:11`, `PreToolUse` `:28`, `Stop` `:60`, `SubagentStop` `:72`) and no
`SessionStart`, and `template/base/package.json.tmpl:12-40` has no status script. An
agent that starts or resumes a session learns the install's state (tier, version,
parked files, blocks spent, reviewers owed by the current diff) by running into it.

**Proposal.** `pnpm harness:status` prints that state. A `SessionStart` hook prints the
same brief into context, including when a session resumes after compaction.

**Guard.** The brief is an injection surface. Its fields are enumerated and
length-capped; values are counts, enums, versions and repository-relative paths; no file
content is echoed. The hook always exits 0. `.claude/settings.json` is owned and
hash-pinned, so the hook reaches an install through `update` or not at all.

## N11: Per-gate field notes in FAIL lines

**No defect claimed.** A FAIL line ends with one generic hint
(`template/base/tools/lib/gate.mjs:29`, used by `fail` at `:47` and `skipOrFail` at
`:55`). What a project learns about a gate in its own tree (the fixture it trips on, the
fix that is usually right) has nowhere to live except agent memory or an instructions
file that grows.

**Proposal.** A seeded `tools/field-notes.json`, gate name to a short note, printed
under that gate's FAIL line.

**Guard.** Print-only: a note cannot change an exit code or suppress a finding.
Length-capped. On the write-guard list, because the text reaches an agent at the moment
it is deciding how to make a red go away.

## N12: A fallback order for reviewer models

**Defect.** Every agent pins one model in its frontmatter
(`template/base/.claude/agents/security-reviewer.md:12`, `architecture-reviewer.md:11`,
`citation-verifier.md:9`, and the other eight agent files) and nothing provides an
alternative. When a pinned model is unavailable the owed reviewer cannot run,
`reviewer-verdicts` stays red, and the turn ends only when Claude Code's block cap is
spent (`template/base/.claude/hooks/lib/turn-outcomes.mjs:59`).

**Proposal.** A reviewed fallback order per reviewer, used only when the pinned model
is unavailable, with the model that actually ran recorded in the ledger entry. The
mechanism is open: frontmatter takes a single model today, so it has to be settled
against `design/CONTROL-PLANE-FACTS.md` by probe, not by reading.

**Guard.** A fallback is never silent. The ledger records the model, the Stop output
names any verdict a fallback produced, and the security reviewers may fall back only
within a listed set. The `prompts` lock covers the fallback list.

## N13: A resolver for spec anchors

**No defect claimed.** `template/base/AGENTS.md:311` and
`template/base/.claude/commands/new-feature.md:80` require a spec for risky changes.
`template/base/specs/_template.md` is a list of bold labels with no headings, so nothing
in a spec can be addressed, and no tool reads `specs/`. A reviewer or a later session
that needs one decision from a spec loads the whole file, and a reference to a spec from
an ADR or a test is unchecked text.

**Proposal.** The template gains headings with stable ids, and
`node tools/spec-anchor.mjs specs/<feature>.md#<id>` prints one section. Agent prompts
cite sections, not files.

**Guard.** The resolver alone is a tool and changes no verdict. Holding citations to
resolve would be a new check: **needs a `gate-proposal` issue first**.

## N14: Review records outside ADRs

**No defect claimed.** The ADR template has no review section
(`template/base/docs/adr/0000-adr-template.md`, headings at `:7` to `:35`) and no
shipped instruction says where the findings of a review go. The ADR is the only
per-change document the harness defines besides the spec, so it is where a multi-round
review record will end up, and a decision buried in its own transcript is harder to
read than one that is not.

**Proposal.** A defined home, `docs/reviews/<change>.md`: one entry per round with the
reviewer, verdict, findings and resolution. The ADR's Traceability section links to it.

**Guard.** ADRs keep decisions, which is what the `adr-guard` workflow and the `-- adr:`
migration markers rely on. Review records are not a gate input.

## N15: A proposal flow for register edits, and a project-side corpus

**Defect.** The write guard protects the harness's registers and machinery with 98
entries, each register listed by name
(`template/base/.claude/hooks/lib/guard-rules.mjs:365-682`). The mechanism is a deny
with one environment override
(`template/base/.claude/hooks/pretool-write-guard.mjs:133-140`). That is the right
default, and it has no second half: nothing lets an agent hand a human a proposed edit
to a protected register in a form the human can apply in one reviewed action. The
nearest mechanism, `.harness/pending/`, runs the other way
(`installer/commands/update.mjs:448-452`).

The corpus shows the cost. The always-loaded rule tells authors to extend it in the
pull request that first cites a new id (`template/base/.claude/rules/provenance.md:24-25`),
and the gate repeats that in its failure text
(`template/base/tools/check-sources.mjs:284`). But `tools/mcp/corpus/index.json` is
owned (nothing in `installer/lib/layout.mjs` seeds it), hash-pinned
(`template/base/tools/check-gate-integrity.mjs:34-39`, `:60`), write-guarded
(`guard-rules.mjs:379`), and the only path the gate reads (`check-sources.mjs:49`,
`:178-187`). A project that follows the rule forks an owned file. After #21 `update`
parks that fork and no longer overwrites it, and the fork still stops receiving
upstream's additions without a hand merge. `tools/decision-groups.json` already has the
right shape: seeded, and merged with the built-ins
(`template/base/tools/lib/provenance-rules.mjs:148`).

**Proposal.** (a) An agent writes the intended register edit and its reason to
`.harness/proposals/`; `harness apply-proposal` shows the diff and applies it under a
human's hand. (b) The corpus splits: the upstream index stays owned, and a seeded
`tools/mcp/corpus/project.json` is merged by the gate and by the MCP server.

**Guard.** A proposal is inert, and no gate reads the directory. The project corpus
passes the same shape lint and host allowlist as the upstream one and stays
write-guarded, so a new authority is still a human decision. The flow makes it one
action.

## N16: Two guard carve-outs

**Defect.** Two guards block the honest path and leave a workaround open.

- Migrations are append-only by file presence.
  `template/base/.claude/hooks/pretool-write-guard.mjs:146-150` denies an edit to any
  migration that exists, with no git call and no override. A migration the agent
  created a minute ago and has not committed is treated as deployed history, so a typo
  is fixed by moving the file away and writing it again. The repository already knows
  how to tell the two apart: `template/base/tools/check-gate-integrity.mjs:511-513`
  combines an untracked status with a manifest match.
- `rm -rf` is denied on its flags alone, with no path term
  (`template/base/.claude/hooks/lib/guard-rules.mjs:131-142`, repeated at
  `template/base/.claude/settings.json:150-155`), so clearing `.next` is denied. The
  interpreter rule matches protected path literals only (`guard-rules.mjs:79-84`, rule
  `interpreter-write-protected` at `:151`), so
  a one-line script that removes the same directory is allowed. The deny message
  prescribes the non-force form, which works, so the cost is friction. The
  inconsistency is that the denied form and the allowed form do the same thing.

**Proposal.** (a) Allow an edit to a migration that `git status --porcelain` reports as
untracked. (b) Extend N03's clean list to ignored build output (`.next`, `dist`, tool
caches) and point the `rm-rf` deny message at it.

**Guard.** (a) Untracked only; any git failure denies, as today; the `append-only` job
in `migration-safety.yml` is unchanged and still guards committed history. (b) The list
is a constant, every entry must be ignored and inside the repository, symlinks are not
followed, and `rm -rf` stays denied.

## N17: Absence checklists for reviewers, and a reviewer eval

**Defect.** Reviewer bodies are lists of properties to look for in what a diff contains
(`template/base/.claude/agents/security-reviewer.md:32-114`, `## INVARIANTS`;
`:116-133`, `## MIGRATION AUDIT`). None asks the converse: given what this diff
introduces, what must accompany it, and is any of that missing? 1.0.2 is this
repository's own example. Seven shipped tables lacked a revoke, which is a statement
that was not there, and the CHANGELOG records that it was found by a CI lane on the
release's pull request, "not by review" (`CHANGELOG.md`, 1.0.2, Fixed). Separately,
nothing measures the reviewers. There is no suite of seeded defects with expected
verdicts, so a change to a reviewer body, or to the model behind it, ships on judgement.

**Proposal.** Each reviewer body gains a short "what must accompany it" table keyed on
what a diff introduces (a table, a function, a route, an Edge Function, a screen),
filled from rules the harness already states, and the reviewer reports each companion
as present or absent. A factory-side eval holds fixture diffs with seeded defects,
absences among them, each with the verdict a reviewer must return.

**Guard.** The checklist adds questions and removes none. The eval is factory-side,
reports a score and gates nothing until a `gate-proposal` says what a score means. It
is re-run at each model change (N12).

## N18: A smaller always-loaded context

**Defect.** Every session loads `template/base/AGENTS.md` (336 lines, 23,098 bytes) and
the three rule files that carry no `paths:` frontmatter:
`template/base/.claude/rules/security-invariants.md` (166 lines, 12,200 bytes),
`encryption.md` (160 lines, 11,554 bytes) and `provenance.md` (39 lines, 2,495 bytes).
`encryption.md:10` says of itself that it is always loaded while the module that
implements it is opt-in. `docs-sync` holds `AGENTS.md` to the budget the file states
(`template/base/tools/check-docs-sync.mjs:269-294`), which bounds growth and says
nothing about what earns a place.

**Proposal.** A sentence leaves `AGENTS.md` only when a gate already reds its
violation, because then the FAIL line (with N11's note) teaches it at the moment it
matters. `encryption.md` becomes a stub holding the invariants that apply with the
module off and a pointer to the full rule, which moves to a path-scoped rule file.

**Guard.** The test for removing a sentence is mechanical: name the gate and the
can-fail proof that reds the violation. Sentences about judgement, which no gate can
hold, stay. `AGENTS.md` is seeded, so an existing install changes only if its owner
copies the change. The rule files are owned and arrive through `update`.

## N19: Compliance register checks on a release cadence

**Defect.** The `docs-sync` step runs three scripts, and two of them grade the
compliance registers (`template/base/tools/harness.config.mjs:160`; why they share a
step is at `:145-156`). The registers are 7,184 lines
(`template/base/tools/conformance-map.json`) and 2,339 lines
(`template/base/tools/essential-eight.json`). Neither script is stamped, and `validate`
runs every step on every invocation (`template/base/tools/validate.mjs:126-130`), so
both registers are graded again at every turn end. What they grade changes when a
register row or the evidence it cites changes, which is release-time work far more
often than turn-time work.

**Proposal.** Locally, the two register scripts run behind an input stamp (N01) keyed
on the register and every evidence path it cites. CI and the release checklist always
run them in full.

**Guard.** A turn that moves or deletes cited evidence still reds that turn, because
the evidence paths are stamp inputs. Nothing leaves the chain and its count does not
move. Whether to go further, to release-only, is a maintainer decision this record
does not make.

## N20: Provenance mandatory where it guards a security decision, advisory elsewhere

**Defect.** The `provenance` gate has seven built-in decision classes
(`template/base/tools/lib/provenance-rules.mjs:17-84`) and one seeded class
(`template/base/tools/decision-groups.json:5-16`), and treats them alike: one bucket of
uncited sites and one red (`template/base/tools/check-sources.mjs:328-333`; `:308-311`
says the semantic checks are hard on every install). A missing citation on
`CREATE POLICY` and a missing citation on a `timeoutMs` constant block a turn equally,
and the only per-site escape is a row in a write-guarded overrides file (`:284-285`).

**Proposal.** `rls-policy`, `guc-identity`, `token-verification`, `cryptography` and
`mobile-security` stay mandatory. `vector-index`, `llm-sampling` and `tuning-constants`
become advisory: reported on every run, counted in telemetry (N02), not a red.

**Guard.** The split is a constant in the owned library. A project can promote a class
to mandatory in its seeded file and cannot demote a mandatory one. It is a relaxation
only, so it needs no ramp, and the advisory findings still print.

## N21: An owned path with no manifest record

**Defect.** `classifyDrift` treats an owned file that exists on disk with no manifest
record as unmodified, so `update` overwrites it (`installer/lib/reconcile.mjs:6-10`,
pinned by `tests/installer/reconcile.test.mjs`). #21 stops `update` overwriting a fork
whose record was re-made. It leaves this case as it was and says so in its CHANGELOG
entry.

**Proposal.** No record means no evidence that the bytes are the harness's. Park the
incoming copy unless the bytes on disk match a released sha for that path, a test the
tables in #21 make possible.

**Guard.** Depends on #21. It changes what `update` does for an existing install (exit
2 where it was 0), so it ships with the same CHANGELOG blast-radius paragraph and
runbook note that #21 carries, and `--force` still overwrites.

---

# 1.1.0, behind a ramp

## R01: Reviewer ledger v2

**Defect.** Six properties of the reviewer gate, each from the code.

1. Locally the owed set comes from a diff against `HEAD` plus staged and untracked
   files (`template/base/tools/lib/git-diff.mjs:38-42`). A commit made before the turn
   ends empties that set, and an empty owed set is green
   (`template/base/tools/check-reviewer-verdicts.mjs:72-74`). CI mode uses the merge
   base (`git-diff.mjs:29-32`), but `reviewer-verdicts` is a Stop entry only
   (`template/base/tools/harness.config.mjs:218`) and no shipped CI lane runs it.
2. Deletions are filtered out in both modes (`git-diff.mjs:11`, `:32`, `:39-40`), so
   removing a policy file, a test or a guard summons no reviewer.
3. The ledger is read for the current session and `prompt_id` only
   (`template/base/tools/lib/reviewer-verdicts.mjs:158`, `:178`, `:192`), and
   `prompt_id` changes with each user message (`design/CONTROL-PLANE-FACTS.md:49`). A
   BLOCK is forgotten when the user next speaks, and a PASS over files that have not
   changed is owed again.
4. Within a turn, any BLOCK entry reds the gate (`check-reviewer-verdicts.mjs:105`), so
   a reviewer that blocks, reads the fix and passes cannot clear its own block. #23
   makes the message say so; the rule is unchanged.
5. The path-state digest is computed when a review ends
   (`template/base/.claude/hooks/subagent-verdict.mjs:70-79`, `:148-157`). Nothing
   records what the tree looked like when the review started, so a review of a tree
   that moved underneath it counts.
6. Two reviewers that the instructions summon on every turn sit in `notTriggered`
   (`template/base/tools/reviewer-triggers.json:97-105`). Their verdicts are recorded
   and never judged. The register says why: "a whole-turn obligation needs a different
   mechanism than a path glob" (`:100`).

**Proposal.** One change, behind one ramp.

- The owed set is keyed on the merge-base diff in both modes and includes deletions.
- A BLOCK persists across turns until the same `agent_id` returns PASS at the current
  digest. A fresh run of the same reviewer type is a second opinion and does not
  retract the first. Whether `agent_id` survives a resumed subagent has to be probed
  (the `CONTROL-PLANE-FACTS.md` method) before the design freezes.
- A `settled` marker records that a PASS at a digest stands, so a new prompt over
  unchanged paths owes nothing.
- The digest is recorded at dispatch and again at `SubagentStop`. A verdict whose two
  digests differ is not counted.
- A `wholeTurn` trigger class makes the two every-turn reviewers judged.

**Guard.** The change tightens (points 1, 2, 5 and 6, and the first half of 3) and
relaxes (point 4 and the second half of 3) at once. Both halves ship behind one ramp,
so an install never receives the relaxation without the tightening. `prompt_id` stays
in the key until B03. It changes what an existing gate judges: **needs a
`gate-proposal` issue first**.

## R02: A severity contract and a round budget

**Defect.** No reviewer body maps severity to verdict. A nit and a vulnerability both
justify `VERDICT: BLOCK`, and the body decides by tone. Nothing bounds rounds per
reviewer. The only bound is Claude Code's turn-wide block cap
(`template/base/.claude/hooks/lib/turn-outcomes.mjs:59`), which every kind of block
spends, and when it is spent the turn ends with the findings standing
(`template/base/.claude/hooks/stop-validate-gate.mjs:273-276`).

**Proposal.** Each body states its severities and which of them block. The
`SubagentStop` hook counts rounds per reviewer per change set. Past the budget it
accepts no further rounds and hands the standing findings to the human.

**Guard.** Spending the budget is never a pass: the way out is exit 2 with the
findings, not exit 0. The author of a change cannot downgrade a blocking severity.
Ramped because a project's edited reviewer bodies would otherwise red on upgrade.
**Needs a `gate-proposal` issue first.**

## R03: docs-sync holds the verdict demand to the end of the body

**Defect.** `docs-sync` checks that each reviewer body contains the verdict demand with
an unanchored substring test (`template/base/tools/check-docs-sync.mjs:618-623`). At the
verified commit two shipped bodies asked for text after the verdict line while the
parser read only the last line, and the gate could not see the contradiction. #23 fixes
the bodies and the parser and pins the position in a factory test. A project's own
reviewer bodies are still held to presence only.

**Proposal.** `docs-sync` requires the demand to be the body's closing instruction.

**Guard.** It tightens an existing gate over files a project may have edited, so it
ships behind a ramp. **Needs a `gate-proposal` issue first.**

## R04: A CI self-lint job for shells and ceilings

**Defect.** The shipped `actions-lint.yml` holds one structural property of a project's
workflows, harden-runner coverage, by counting
(`template/base/github/workflows/actions-lint.yml:84-99`). A count cannot see position:
the job promises "first step", and two harden-runner steps in one job would cover a
bare neighbour. Nothing holds a workflow-level `defaults.run.shell` or a
`timeout-minutes` on every job. At the verified commit no shipped base workflow
declares `defaults:`, and the only ceilings are four jobs in the quality gate
(`template/base/github/workflows/quality-gate.yml:763`, `:926`, `:1039`, `:1137`). #22 adds both everywhere and holds them with a
factory test, which protects what ships and not what a project writes next.

**Proposal.** A job in `actions-lint.yml`, in the `harden-runner-coverage` pattern,
that fails a workflow with no workflow-level bash default or a runnable job with no
ceiling, and that checks harden-runner by position.

**Guard.** New check: **needs a `gate-proposal` issue first**, with its can-fail proof
in the canary registry. Ramped because a project's own workflows would otherwise red
on upgrade.

## R05: Grants bounded by policies, generated exactness, and a revoke doctrine

**Defect.** The static grant check is one-way by design. A policy implies a grant, and
nothing asks whether a grant is wider than any policy needs
(`template/base/tools/lib/table-grants.mjs:24-27`;
`template/base/tools/check-rls-manifest.mjs:385`). The reason given is sound
(`service_role` bypasses row security, so its grants have no policy behind them), and
it leaves `authenticated` unbounded as well. The runtime half is
`template/stack/supabase/tests/rls_structure.test.sql`, which keeps a hand-counted
`plan(35)` (`:28`) and four hand-built table lists (`:34-45`, `:233`, `:244` and `:254`,
`:271-272`), and records that those lists had already drifted once (`:260-262`). The
1.0.2 escape was a grant wider than its policies.

**Proposal.** (a) A static upper bound for roles that do not bypass row security: every
privilege granted to `authenticated` on a table is admitted by some policy or listed
with a reason. (b) The exactness assertions are generated from the parsed schema, so a
new table cannot be left off a list. (c) The doctrine that every new table revokes the
platform default from all three roles before it grants, recorded in an ADR and held
by (a).

**Guard.** `service_role` stays outside (a) for the reason the file gives. Generated
SQL is committed and drift-checked like the other generated artifacts. New checks:
**needs a `gate-proposal` issue first**. Ramped: an existing install's tables predate
the doctrine, and #24 only teaches it.

## R06: The SQL parser learns DROP TABLE and ALTER POLICY

**Defect.** `template/base/tools/lib/sql-parse.mjs` models `CREATE TABLE`,
`CREATE POLICY`, `DROP POLICY` (`:363`), index and constraint drops, and
`DROP NOT NULL` (`:588-589`). It has no occurrence of `DROP TABLE` or `ALTER POLICY`,
and `parseCreatedTables` only ever adds to its map (`:566-580`). A table dropped by a
later migration stays in the parsed schema for good, and a policy rewritten with
`ALTER POLICY` keeps its original predicate in the view of every gate that reads it.
Seven gates import the parser: `check-data-flow`, `check-db-limits`, `check-db-perf`,
`check-migrations`, `check-query-shapes`, `check-rls-manifest` and `check-tenancy`.

**Proposal.** Model both statements, with the fold-forward semantics the parser already
applies to indexes and constraints.

**Guard.** Each statement kind lands with fixtures in both directions: the drop that
must clear a finding and the alter that must create one. Ramped because verdicts change
in seven gates at once for any install whose history contains either statement.
**Needs a `gate-proposal` issue first.**

## R07: i18n detection on the syntax tree

**Defect.** `template/base/tools/check-i18n.mjs` finds user-facing strings with regular
expressions over comment-blanked source text (`:257` for JSX text, `:221-228` for
attributes and object literals). The file documents three guards added after type
syntax was reported as copy (`:233-245`) and a known false negative (`:252-256`). The
escape is an allowlist keyed on `file:line` (`:61`, `:272`). It is write-guarded
(`template/base/.claude/hooks/lib/guard-rules.mjs:575`), and a key moves off its
target when a line is inserted above it. When the gate is wrong about a string, the
response within an agent's reach is to reshape the code until the expression stops
matching.

**Proposal.** Walk the TypeScript syntax tree the scaffold already has (JSX text nodes,
the listed attributes, the listed object keys), and key the allowlist on a content hash
of the node, not on a line number.

**Guard.** The tree walk must red everything in the current can-fail fixtures before
the expressions are removed, and both run side by side for one release. Ramped because
the finding set changes in both directions. **Needs a `gate-proposal` issue first.**

## R08: The web build in the chain, and a browser test per route

**Defect.** The chain's `build` step is the mobile export
(`template/base/tools/harness.config.mjs:122`;
`template/base/tools/build-check.mjs:193-194`). No chain step compiles the web app:
`types` is a typecheck (`harness.config.mjs:36`), and `build-check.mjs --web` scans an
existing `.next/static` and skips when there is none (`build-check.mjs:140-145`). `next build` runs
only in the path-filtered `web-build` CI job
(`template/base/github/workflows/quality-gate.yml:1187-1203`) and inside the `web-e2e`
server start. The file explains the trade at `build-check.mjs:125-130`: a Next build
costs minutes. The consequence is that a web app that does not compile can pass the
whole local chain.

On the closure side, mobile closes route to flow to budget
(`template/base/tools/check-mobile-perf.mjs:11-13`). For the web,
`template/base/tools/check-web-routes.mjs` never asks whether a route has a browser
test, and `template/base/tools/check-web-e2e.mjs` checks aggregates only (`:10-20`,
`:52-56`).

**Proposal.** (a) A stamped web build step: a full `next build` when the web inputs
changed and a stamp hit otherwise, which N01's mechanism makes affordable locally.
(b) A closure from `apps/web/lib/routes.generated.ts` to a Playwright spec per route.

**Guard.** A new chain step and a new check: **needs a `gate-proposal` issue first**.
The chain count, the frozen floor and every count-matched claim move together. Ramped.

---

# 2.0.0, breaking

## B01: The example leaves the scaffold

**Defect.** The worked example ships as product. Under `template/stack`, 44 of 348
files carry its name in their path, and the action registry it feeds adds 5. The stack
tree is seeded almost entirely (`installer/lib/layout.mjs:89-99`), so an install owns
those files from its first day and the harness can never update them. Under
`template/base`, 78 files name the example, led by three registers
(`tools/mutation-baseline.json`, `tools/generated/query-shapes.json`,
`tools/conformance-map.json`). Nothing marks it as removable
(`template/stack/packages/verticals/notes/package.json.tmpl:4` calls it "the seeded
reference vertical") and the installer has no verb to remove it
(`installer/cli.mjs:68-90`). Removing it by hand means editing registers the write
guard protects (N07, N15).

**Proposal.** The default scaffold carries no example code. The example lives
upstream, where it compiles and is tested, and reaches an install as generated
reference markdown (N09). `init --with-demo` materialises it for those who want to run
it, and `eject` removes it again using a generated sidecar index of every register row
that names it, as `{file, jsonPointer}` pairs.

**Guard.** Depends on N07 (legal empty states), N08 (proofs that do not stand on the
example) and N09. The sidecar index is checked complete upstream: a register row that
names the example and is missing from the index reds the factory. Breaking because the
default scaffold changes shape.

## B02: The encryption rule ships with its module

After N18 the always-loaded rule is a stub. 2.0.0 moves the full rule into
`template/modules/e2ee`, so an install without the module carries none of it. Breaking
because a file leaves the base install: it needs a `removed` record in
`template/migrations.json`, and an install that forked the rule keeps its copy (the
fork handling in #21).

## B03: `prompt_id` leaves the ledger key

After R01, what makes a verdict current is the digest of the paths it reviewed, and
`prompt_id` (R01, point 3) only causes re-runs. 2.0.0 drops it from the key and the
ledger format version moves. Breaking because a ledger written by an older hook and a
gate from the newer release cannot read each other, and the gate treats an entry it
cannot bind as a BLOCK (`template/base/tools/check-reviewer-verdicts.mjs:15-24`).

---

# Dropped after design review

Recorded so they are not proposed again.

- **Comment-insensitive path digests.** Would let R01's digest ignore comment-only
  edits. It fails open: suppressions, `-- adr:` markers and `SOURCE:` citations are
  comments, and they are what several gates read.
- **Persistent memory for reviewers.** The reviewers are read-only by roster (every
  reviewer's `tools:` line is `Read, Grep, Glob`, plus one read-only MCP tool for two
  of them). Memory is a write surface, and it would carry one review's conclusions into
  the next as unexamined premises.
- **Diff-class Stop tiers.** Choosing steps by classifying the diff makes a
  misclassification a silent skip. Input stamps (N01) get the same saving from a hash.
- **`vitest --changed`.** Selection by import graph misses what a test depends on
  without importing: SQL, JSON registers, the environment. Coverage floors measured on
  a subset mean nothing.
- **A code-bearing reference directory.** Code that no toolchain compiles rots, and
  code that one does compile is product again. N09 generates markdown from code that is
  compiled upstream.
