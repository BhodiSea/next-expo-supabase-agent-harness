# Roadmap

What this project intends to do over roughly the next twelve months, and what
it does not intend to do. Every item below links to the record in this
repository that tracks it. Most of those records are commitments. The
"Field-report upgrades" section began as proposals; each is now built in a
pull request of the stack the work plan section describes, and says which.
Dates on calendar items are external deadlines. Nothing here is a promise about
delivery dates for features.

The machine-checked source for most of this is
[`scripts/obligations.json`](scripts/obligations.json): release rows block a
release until they are discharged, and calendar rows turn the nightly run red
when they fall due.

## Now: overdue

- **Make the nightly run able to raise an alarm again.** It had been red every
  night since 2026-08-11, which hid the lapse of the Next.js security floor
  review in September (see the 1.0.2 CHANGELOG entry). The first half is done:
  the two overdue calendar rows behind its last red job, `obligations-clockful`,
  were re-read on 2026-09-29 and re-dated (issue #54). They are
  `conformance-play-target-api-window` (Google Play target API level) and
  `conformance-cra-art14-application` (EU Cyber Resilience Act Article 14
  reporting). The second half is done in 1.1.0 (issue #81): the scheduled
  `floor-advisories` job in `hygiene.yml` asks OSV and the upstream
  repository's published advisories about every framework floor and the
  catalog pin, so that a security release is noticed when it ships and not
  when a review window happens to end. Its first run is red on a real
  advisory, GHSA-vcvr-r3jv-pc5j, which covers the 16.x floor and the pin
  and waits on the maintainer's floor decision. This bullet leaves the list
  once a scheduled run of the released tree is green end to end.
- **Find why the scheduled device lane's perf-harness phase goes red.** The
  mutation journey of issue #10 has passed since 1.0.0 fixed it, but
  `maestro-smoke` still failed on seven of the fourteen scheduled runs from
  2026-08-17 to 2026-09-29 read for #10, each time on the perf-harness
  marker. 1.0.4 makes the next red print the on-screen verdict, with each
  breached cap and its measured value (the 1.0.4 CHANGELOG, "What stays
  open"); the fix follows from that line.

## Next: 2.0.0

1.1.0 opened a set of dated advisory notes for existing installs, all but three
of them dated 1.2.0. This lineage goes from 1.1.0 to 2.0.0 directly and never
cuts 1.2.0, so those deadlines arrive at 2.0.0, and its version bump settled
each one (issue #86):

- Eighteen sites across fifteen gates are enforcing for installs below 1.1.0:
  the SQL history fold, the grant bound, the reviewer severity contract and
  verdict demand, the `AGENTS.md` gate list, the Edge Function surface, the
  planted escape list, `web-compile`, the per-route browser closure and
  `workflow-hardening`. Their ten `*-ramp-expiry` release rows are gone from
  the obligations register.
- Two ramps existed to carry something to this release, and it went with them:
  the `i18n` gate's 1.0.x regular expressions and `file:line` allowlist entries,
  and the dated `lint` exemption for the seeded delete-account function.
- `uuid` 7 was re-reviewed at 2.0.0 and is still not discharged upstream. Its
  removal target moved to 2.1.0, and `version-sync`'s arrival note re-opened
  until 2.1.0.
- `reviewer-verdicts`' round budget moved to 2.1.0, beside the reviewer ledger
  v2 whose change set it judges. The 2.1.0 release owes all three of that
  step's ramps.
- The Supabase CLI config census, still blocked upstream on
  supabase/cli#5894, was re-checked and re-dated to 2.1.0.

The rest of 2.0.0 is the breaking field-report upgrades below.

## The 2026-09 work plan: one stack of pull requests

Issue #37 indexed the field-report items below and the follow-ups found while
shipping 1.0.2 and 1.0.3, one issue per item. On 2026-10-01 every one of them
except #51 has a pull request in one stack of fifty-two, each based on the one
before it. The maintainer merges them in order with merge commits, and tags
each release on its last position once that position is merged: 1.0.4 on
position 18, 1.1.0 on 48 and 2.0.0 on 52. Until then none of those three
releases exists, and where this file says something is built in 1.0.4, 1.1.0
or 2.0.0 it describes a pull request.

The field-report items are the bullets under "Field-report upgrades" below,
each with its pull request, and the design record's status table lists them
with their positions. The other positions are these:

| Position | Release | Issue | Key | Pull request | What |
|---|---|---|---|---|---|
| 1 | 1.0.4 | #40 | F12 | #91 | Database types regenerated for Supabase CLI 2.118.0, and `types-drift` prints a bounded diff |
| 2 | 1.0.4 | #54 | F09 | #92 | The overdue Play target-API and CRA Article 14 rows re-read and re-dated |
| 3 | 1.0.4 | #38 | — | #93 | The version moves to 1.0.4 first: the local loop release |
| 12 | 1.0.4 | #49 | F01 | #102 | The runbook's 1.0.1 agents-lock claim corrected |
| 13 | 1.0.4 | #50 | F02 | #103 | `git init` before `pnpm install` in the scaffold recipe and the issue forms |
| 14 | 1.0.4 | #52 | F04 | #104 | `update --rollback` removes a directory the update created |
| 15 | 1.0.4 | #53 | F05 | #105 | The complexity ratchet keeps its record at the repository root |
| 16 | 1.0.4 | #55 | F14 | #106 | The factory workflow checks cover the module workflows |
| 17 | 1.0.4 | #88 | F11 | #107 | The catalog's Supabase CLI pinned exactly, with a note on Renovate's bump |
| 18 | 1.0.4 | #10 | — | #108 | The device lane boots its web host, and a device red names the screen |
| 19 | 1.1.0 | #39 | — | #109 | The version moves to 1.1.0 first, and the 1.0.0 ramps are discharged |
| 37 | 1.1.0 | #80 | F08 | #127 | What `HARNESS_ALLOW_SELF_EDIT=1` relaxes, and the Stop-hook cost advice |
| 38 | 1.1.0 | #81 | F10 | #128 | A nightly lane fails on an unrecorded advisory against a framework floor |
| 39 | 1.1.0 | #82 | F13 | #129 | Event catalogs found from each vertical's `./client` (N07's second half) |
| 40 | 1.1.0 | #83 | F15 | #130 | Installs are told when a seeded catalog pin is below a security floor |
| 44 | 1.1.0 | #79 | F07 | #134 | `query-shapes` records and judges `rpc()` and `upsert()` calls |
| 47 | 1.1.0 | #78 | F06 | #138 | Edge Functions under lint, unit tests, mutation and a typecheck |
| 48 | 1.1.0 | #84 | F16 | #139 | `gate-integrity` proves an uncommitted escape list's bytes were planted |
| 49 | 2.0.0 | #86 | B02 | #140 | The version moves to 2.0.0 first, with B02 |
| 52 | 2.0.0 | #37 | — | — | This record |

Two parts of the work plan are outside the stack. C01, the cloud-session
tooling in #36, merged to `main` on 2026-09-29, before the stack's first
position, which merges it. #51 (F03), the version-free pin and verify examples
in `README.md` and `SECURITY.md`, merged to `main` as #90 on 2026-09-30, after
the stack began. Position 1 merges `main` again, so #51 ships in 1.0.4, the
first release whose tag carries it, and the 1.0.4 CHANGELOG lists it under
Fixed.

## Field-report upgrades

These came out of a retrospective on a project built with this harness, as
proposals. The maintainer made each one an issue of the work plan in issue #37,
every `gate-proposal` among them was accepted (CONTRIBUTING.md, ground rule 6),
and each is now built in a pull request of the stack the section above
describes. Each item links to its section of
[`design/FIELD-UPGRADES-2026-09.md`](design/FIELD-UPGRADES-2026-09.md), which states the
defect from this repository's own code, the proposal, the guard that keeps the
change from weakening a gate, and where it was built. Each bullet names its
issue and pull request and sits under the release it was built for. The items
have no row in `scripts/obligations.json`; a ramp one of them opened has its
expiry row there.

### 1.0.4, no ramp

The maintainer scheduled these for 1.0.4, the local loop release (issue #38),
beside fixes that have no proposal here. None of them tightens a gate for an
existing install beyond what its bullet names. Where one changes what `update`
does, its section says so.

- **Input-stamped Stop steps.** `rls-isolation` skips on unchanged inputs, an
  unchanged CLI and an unchanged database, a stamped step prints as `STAMPED`,
  and stamp inputs cover the libraries a gate imports. Stamping `unit` and
  `mobile-unit` needs a wrapper that changes floored commands. It was left for
  1.1.0, and no 1.1.0 issue schedules it yet.
  ([N01](design/FIELD-UPGRADES-2026-09.md#n01-input-stamped-stop-steps),
  issue #42, pull request #95)
- **Stop-step and gate-event telemetry.** Untrimmed local records of step
  durations and of in-turn gate and guard events, read by no gate.
  ([N02](design/FIELD-UPGRADES-2026-09.md#n02-stop-step-and-gate-event-telemetry),
  issue #41, pull request #94)
- **Preflight hygiene and a pinned runner environment.** `doctor` reports the
  toolchain it resolved and clears enumerated residue, and the local database
  lane stops taking its CLI and its port from the machine. On a machine with no
  global CLI, `types-drift` then runs where it skipped and can red a stale
  mirror locally, as CI's `runtime-rls` job already did.
  ([N03](design/FIELD-UPGRADES-2026-09.md#n03-preflight-residue-hygiene-and-a-pinned-runner-environment),
  issue #43, pull request #96)
- **`validate --ci-parity`.** One flag gives a local run CI's posture: no
  skips and no stamps.
  ([N04](design/FIELD-UPGRADES-2026-09.md#n04-a-ci-parity-flag-for-validate),
  issue #44, pull request #97)
- **Legal empty states on day 0.** `perf-budget` accepts `subjects: []` beside
  a reviewed `emptySubjects` row, and an optional `accountDeletion.registry`
  moves the command registry the account-deletion closure reads. The
  `day0-empty-states` factory lane runs the Stop chain on both escapes and
  proves each red. It keeps the example: the event-catalog leg, a generator
  that discovers each vertical's catalog, changes the `contracts` verdict for
  an existing install, so it moves to 1.1.0 (issue #82).
  ([N07](design/FIELD-UPGRADES-2026-09.md#n07-legal-empty-states-on-day-0-and-a-factory-lane-that-proves-them),
  issue #46, pull request #99)
- **A project-side citation corpus.** The citation corpus splits into an owned
  upstream index and a seeded project file, which the provenance gate,
  `docs-sync` and the MCP server merge. The project file joins the escape lists,
  so `wiring` asks every install's CODEOWNERS for its owner, file or no file; the
  shipped rules cover it, and only a CODEOWNERS whose last rule matching it names
  no owner reds. The proposal flow that is the other half of this item stays in
  1.1.0.
  ([N15](design/FIELD-UPGRADES-2026-09.md#n15-a-proposal-flow-for-register-edits-and-a-project-side-corpus),
  issue #47, pull request #100)
- **Two guard carve-outs.** The write guard lets an Edit or Write reach a
  migration git reports as untracked and the install manifest does not record,
  and `doctor --clean` deletes ignored build output, which the bash guard's
  force-delete deny now names.
  ([N16](design/FIELD-UPGRADES-2026-09.md#n16-two-guard-carve-outs),
  issue #45, pull request #98)
- **An owned path with no manifest record.** `update` keeps the file and parks
  the incoming copy unless the bytes on disk are a released version, and a
  `removed` or `renamed` migration keeps it too. Follows #21.
  ([N21](design/FIELD-UPGRADES-2026-09.md#n21-an-owned-path-with-no-manifest-record),
  issue #48, pull request #101)

### 1.1.0, no ramp

None of these tightens a gate for an existing install. Where one changes what
`update` does, its section says so.

- **A dated deferral for an unbuilt surface.** A project building its web
  surface first records the mobile surface in the seeded `tools/surfaces.json`,
  and a live row skips `mobile-e2e` and `perf-lane` on a pull request. The row
  goes void when a file under `apps/mobile/` stops matching the install record,
  and after its date the scheduled `floor-review` job reds it. The register
  takes `mobile` rows only.
  ([N05](design/FIELD-UPGRADES-2026-09.md#n05-a-dated-deferral-for-a-surface-that-is-not-built-yet),
  issue #56, pull request #110)
- **Skip a lane that already passed on the same tree.** On a push, `static`,
  `unit`, `mutation`, `runtime-rls`, `e2e-fast` and `integration-lane` reuse the
  merged pull request's `success` for the same job when the tree is identical,
  and name the run they relied on; anything else runs in full, and scheduled
  and dispatched runs never reuse. Those jobs now request `actions: read` and
  `pull-requests: read`, and `update` parks the new workflow beside a fork.
  ([N06](design/FIELD-UPGRADES-2026-09.md#n06-skip-a-lane-that-already-passed-on-the-same-tree),
  issue #57, pull request #111)
- **Event catalogs found in each vertical.** A vertical opts in by exporting
  its catalog from `./client` as `EVENT_CATALOG`, so the generator no longer
  imports the example by name and a new vertical needs no edit to an owned,
  hash-pinned file. Until 2.0.0 the generator still reads the example's old
  export while an install's root `package.json` lists it, so existing installs
  regenerate the same catalog. Nothing checks that a vertical opts in: that
  needs a `gate-proposal` of its own.
  ([N07](design/FIELD-UPGRADES-2026-09.md#n07-legal-empty-states-on-day-0-and-a-factory-lane-that-proves-them),
  issue #82, pull request #129)
- **Database proofs on a fixture table.** The isolation, MFA and audit pgTAP
  suites build `public.pgtap_fixture` inside their transaction from the
  vertical-slice skill's RLS skeleton, so deleting the example does not delete
  them; a factory test holds each fixture to the skeleton. Structural checks
  and the recursion probe stay on the real tables, and the suites are seeded,
  so existing installs keep theirs.
  ([N08](design/FIELD-UPGRADES-2026-09.md#n08-behavioural-database-proofs-on-a-fixture-table),
  issue #58, pull request #113)
- **Generated skill references.** The code blocks in the vertical-slice
  skill's references are regions cut verbatim from spans the example marks,
  and a factory check fails on drift in either direction. The table, trigger,
  index, FORCE and grant half of the RLS skeleton stays hand-written; since
  1.1.0 the example grants what it teaches (the three-role revoke, #74), so
  that half could be cut from it next.
  ([N09](design/FIELD-UPGRADES-2026-09.md#n09-skill-references-generated-from-the-example),
  issue #59, pull request #112)
- **A session-start brief and `harness:status`.** A `SessionStart` hook and
  `node tools/harness-status.mjs` print the same four fields: the version,
  base and tier, the parked upgrades, how the last turn ended, and the
  reviewers the current diff owes. Every value passes a closed validator, the
  brief is capped at 1,200 characters, and the hook exits 0 on every path. An
  install whose `.claude/settings.json` is a kept fork gets the hook parked
  beside it until the `SessionStart` entry is merged. The `SessionStart`
  payload is documented, not yet probed (CONTROL-PLANE-FACTS Fact 15).
  ([N10](design/FIELD-UPGRADES-2026-09.md#n10-a-session-start-brief-and-a-status-command),
  issue #60, pull request #115)
- **Per-gate field notes.** A seeded, write-guarded `tools/field-notes.json`,
  keyed on the gate token, adds one capped `FIELD-NOTE[<gate>]:` line after a
  failing gate's FIX line. It never prints on a pass and cannot change a
  verdict, and `update` plants the empty file. Steps whose scripts print no
  gate FAIL line get no note.
  ([N11](design/FIELD-UPGRADES-2026-09.md#n11-per-gate-field-notes-in-fail-lines),
  issue #61, pull request #116)
- **A resolver for spec anchors.** The spec template's fields are `##`
  headings whose ids are their GitHub anchors, and
  `node tools/spec-anchor.mjs specs/<feature>.md#<id>` prints one section.
  `/new-feature` puts the sections a slice implements in the reviewer's brief,
  and ADRs cite them. A project's own specs are not rewritten, and nothing
  checks that a citation resolves: that needs a `gate-proposal` of its own.
  ([N13](design/FIELD-UPGRADES-2026-09.md#n13-a-resolver-for-spec-anchors),
  issue #63, pull request #120)
- **Review records outside ADRs.** Each change keeps its review rounds in
  `docs/reviews/<YYYYMMDD>-<slice>.md`, one table per round (reviewer, verdict,
  findings, resolution), linked from its ADR's Traceability, so the ADR keeps
  the decisions. No gate reads the directory, and `update` plants the seeded
  README only where an install has none. The whole-turn reviewers bind to the
  whole diff, record included, so the README orders their last run after it.
  ([N14](design/FIELD-UPGRADES-2026-09.md#n14-review-records-outside-adrs),
  issue #64, pull request #121)
- **A proposal flow for register edits.** An agent writes the whole proposed
  register as `harness-proposals/<id>.json`, a committed directory no deny
  layer names, and a human applies it with `apply-proposal <id>` in a
  terminal after reading the reason and the diff. A stale `base` or a dirty
  target is refused, the bash guard denies an agent the verb, and `doctor`
  lists pending proposals as `info`. The corpus half of this item is in 1.0.4.
  ([N15](design/FIELD-UPGRADES-2026-09.md#n15-a-proposal-flow-for-register-edits-and-a-project-side-corpus),
  issue #65, pull request #122)
- **Absence checklists and a reviewer eval.** Reviewers report what a change
  should have brought with it and did not, and a factory-side eval measures
  them on seeded defects.
  ([N17](design/FIELD-UPGRADES-2026-09.md#n17-absence-checklists-for-reviewers-and-a-reviewer-eval),
  issue #66, pull request #123)
- **A smaller always-loaded context.** `encryption.md` is a stub that keeps the
  invariants whose checks run with the `e2ee` module off, and the full rule is
  the path-scoped `e2ee.md`, which the `authoring-e2ee-feature` skill reads
  first. A sentence left `AGENTS.md` only where a hook denies its violation with
  a message that teaches the fix, and `security-invariants.md` still states it:
  `WITH RECURSIVE`, the public-prefix secret names, and the shell-hygiene
  commands the bash guard denies outright. `AGENTS.md` is seeded, so installs
  keep theirs.
  ([N18](design/FIELD-UPGRADES-2026-09.md#n18-a-smaller-always-loaded-context),
  issue #67, pull request #124)
- **Compliance register checks behind an input stamp.** `essential-eight` and
  `conformance-map`, the `docs-sync` step's register scripts, skip locally when
  nothing their verdict reads has changed: the register, the chain config, the
  workflows and, for the map, the guard rules, the module list and markers, and
  the generator with its two documents. The cited evidence is not an input,
  because neither script opens it. `essential-eight`'s negative proof still runs
  on every run, before the stamp. CI always judges both in full; running them
  only at release time is out of scope.
  ([N19](design/FIELD-UPGRADES-2026-09.md#n19-compliance-register-checks-on-a-release-cadence),
  issue #68, pull request #125)
- **Provenance by decision class.** Mandatory where a citation guards a
  security decision, advisory elsewhere. `vector-index`, `llm-sampling` and
  `tuning-constants` are advisory: an uncited or wrongly grounded site there
  prints an `ADVISORY` line and the hook hands the agent a note instead of
  blocking. Every other class, the seeded and project-added ones included,
  stays mandatory, a seeded `"mandatory"` list promotes a class back, and
  nothing demotes one. A written citation must still resolve in every class.
  ([N20](design/FIELD-UPGRADES-2026-09.md#n20-provenance-mandatory-where-it-guards-a-security-decision-advisory-elsewhere),
  issue #69, pull request #126)

### 1.1.0, behind a ramp

Each of these changes a verdict for an existing install, so each ships as a
dated note first and becomes enforcing when its ramp expires. Each needs a
`gate-proposal` issue first.

- **Reviewer ledger v2.** `reviewer-verdicts` owes reviewers on the merge-base
  diff with the branch's upstream, deletions included; a BLOCK stands across
  the session's prompts until the same `agent_id` passes at the current digest;
  a PASS counts only when the tree at its `SubagentStart`, at its verdict and
  at Stop are the same; and `torvalds-reviewer` and `citation-verifier` are
  owed on every non-empty diff. One ramp opened at 1.1.0 holds it as NOTEs below
  that `baseVersion` until 2.1.0, with the 1.0.x judgement still enforcing
  there. With no upstream it does not judge. Whether a resumed reviewer keeps
  its `agent_id` is documented and not yet probed.
  ([R01](design/FIELD-UPGRADES-2026-09.md#r01-reviewer-ledger-v2),
  issue #70, pull request #114)
- **The model each reviewer verdict ran on, and a reviewed fallback list.** The
  ledger records the model that wrote each verdict, read from the subagent's
  transcript, and each reviewer file carries a `harnessFallbackModels` list.
  `reviewer-verdicts` names every verdict off its pin, on a green turn too, and
  a security reviewer's PASS counts only on its pin or a listed model. That
  finding is a NOTE below `baseVersion` 1.1.0 until 2.1.0. Where the transcript
  records the model was probed at Claude Code 2.1.285 in print mode; how the
  terminal, VS Code and the desktop app show the green-turn notice is not yet
  observed. Planned as no-ramp; the ramp is what keeps an install whose
  configuration already forces a model off the list from redding on its first
  Stop.
  ([N12](design/FIELD-UPGRADES-2026-09.md#n12-a-fallback-order-for-reviewer-models),
  issue #62, pull request #117)
- **A severity contract and a round budget.** Every reviewer body states
  `Blocking: CRITICAL, HIGH`, and `docs-sync` holds the line. The SubagentStop
  hook bounces a PASS that lists a finding at a blocking severity and records
  each verdict's round. `reviewer-verdicts` reds a review loop still open after
  three rounds with the recorded findings, for the human; a PASS past the budget
  never clears it. Two ramps opened at 1.1.0 hold both checks as NOTEs below
  that `baseVersion`: the contract's until 1.2.0, which arrived at 2.0.0, and
  the budget's until 2.1.0, where 2.0.0 moved it to wait for the ledger v2.
  ([R02](design/FIELD-UPGRADES-2026-09.md#r02-a-severity-contract-and-a-round-budget),
  issue #71, pull request #118)
- **`docs-sync` holds the verdict demand to the end of the body.** Each
  reviewer body's last paragraph must be the verdict demand, optionally
  followed by its shipped rationale sentence, so nothing is asked for after the
  line the SubagentStop hook reads last; presence stays a hard red on every
  vintage. One ramp opened at 1.1.0 holds the position check as NOTEs below that
  `baseVersion` until 1.2.0. An earlier paragraph that asks for text after the
  verdict is still not caught.
  ([R03](design/FIELD-UPGRADES-2026-09.md#r03-docs-sync-holds-the-verdict-demand-to-the-end-of-the-body),
  issue #72, pull request #119)
- **A CI self-lint job.** The shipped `actions-lint` workflow runs a
  `workflow-hardening` job that holds a project's own workflows, `.yml` and
  `.yaml`, to a workflow-level bash default, a ceiling on every job and
  harden-runner as each job's first step, in audit mode on Windows, where
  `harden-runner-coverage` beside it only counts. One ramp opened at 1.1.0
  holds its findings as NOTEs below that `baseVersion` until 1.2.0. It reads
  YAML's shape rather than parsing YAML, so a flow mapping or an anchor is
  reported as unreadable, and `graduate` does not run it.
  ([R04](design/FIELD-UPGRADES-2026-09.md#r04-a-ci-self-lint-job-for-shells-and-ceilings),
  issue #73, pull request #131)
- **Grants bounded by policies.** `schema-rls` folds the grant history a
  second time from the platform's default privileges: every privilege `anon`
  or `authenticated` holds must be admitted by a policy, every table revokes
  the default from all three roles (the doctrine and its ADR, applied to
  `profiles` and `notes` by a new migration), and
  `supabase/tests/rls_grants.generated.test.sql`, rendered by
  `tools/gen-grant-assertions.mjs`, asserts the exact privileges of every table
  instead of hand-counted lists. One ramp opened at 1.1.0 holds all three as
  NOTEs below that `baseVersion` until 1.2.0. Sequences, views, custom roles
  and `ALTER DEFAULT PRIVILEGES` stay outside the fold.
  ([R05](design/FIELD-UPGRADES-2026-09.md#r05-grants-bounded-by-policies-generated-exactness-and-a-revoke-doctrine),
  issue #74, pull request #133)
- **`sql-parse` learns `DROP TABLE` and `ALTER POLICY`.** Seven gates stop
  reasoning about tables that are gone and predicates that were replaced.
  ([R06](design/FIELD-UPGRADES-2026-09.md#r06-the-sql-parser-learns-drop-table-and-alter-policy),
  issue #75, pull request #132)
- **i18n detection on the syntax tree.** The `i18n` step walks the TypeScript
  syntax tree beside its regular expressions and reports the union, and its
  allowlist is keyed on a hash of the string's content instead of a line
  number. Two ramps opened at 1.1.0 held what only the walk finds, and the old
  `file:line` entries, as NOTEs below that `baseVersion` until 1.2.0; 2.0.0,
  the release that met that deadline, removed the expressions and `site`
  entries, so the walk is the only scan. A string reached through a variable or
  a helper is still not seen.
  ([R07](design/FIELD-UPGRADES-2026-09.md#r07-i18n-detection-on-the-syntax-tree),
  issue #76, pull request #136)
- **The web build in the chain, and a browser test per route.** A stamped
  `web-compile` step runs `next build` after `build`, so a web app that does not
  compile reds the chain and `static`, and `route-manifest` asks that some spec
  under `apps/web/e2e` names a state test id of every registered web route; the
  seeded suite gains specs for `notes` and `security`. Two ramps opened at 1.1.0
  hold both as NOTEs below that `baseVersion` until 1.2.0, and `docs-sync`'s
  gate-list escape re-opens for the 37th step.
  ([R08](design/FIELD-UPGRADES-2026-09.md#r08-the-web-build-in-the-chain-and-a-browser-test-per-route),
  issue #77, pull request #137)

### 2.0.0, breaking

- **The example leaves the scaffold.** Built in 2.0.0: a default `init` writes
  no worked example, `init --with-demo` overlays it from `template/demo/`, and
  `eject` removes it again using a generated index of its register rows, which a
  factory check holds complete in both directions. An existing install keeps its
  example, and the runbook says how to remove it by hand.
  ([B01](design/FIELD-UPGRADES-2026-09.md#b01-the-example-leaves-the-scaffold),
  issue #85, pull request #141)
- **The encryption rule ships with its module.** Built in 2.0.0: the full rule,
  `.claude/rules/e2ee.md`, is stored in the `e2ee` module, so an install without
  `e2ee` does not carry it, and the 2.0.0 record removes the base copy from
  existing installs. The always-loaded stub stays everywhere, and every base file
  cites it.
  ([B02](design/FIELD-UPGRADES-2026-09.md#b02-the-encryption-rule-ships-with-its-module),
  issue #86, pull request #140)
- **`prompt_id` leaves the ledger key.** Built in 2.0.0: after ledger v2 the
  path digest is what makes a verdict current, so `reviewer-verdicts` reads the
  reviewer ledger by session and a format stamp every entry now carries. An entry
  in another format never counts as a PASS and is named, the step needs only the
  session id, and the 1.0.x judgement keeps the prompt in its key.
  ([B03](design/FIELD-UPGRADES-2026-09.md#b03-prompt_id-leaves-the-ledger-key),
  issue #87, pull request #142)

Five further ideas were considered and rejected. The design record
[lists them with the reason](design/FIELD-UPGRADES-2026-09.md#dropped-after-design-review), so they are not
proposed again.

## Through mid-2027: dated external changes

| Date | What changes | Row |
|---|---|---|
| 2026-10-30 | Supabase stops granting Data API privileges automatically on new projects. The scaffold's migrations already grant explicitly; this is the date to re-verify that against a project created after it. | `conformance-supabase-grants-arrival` |
| 2026-12-02 | EU AI Act Article 50 transitional period ends. The recorded disposition is a confirmed negative, to be re-read. | `conformance-ai-act-transitional` |
| 2026-12-31 | Re-check whether a harmonised standard for the Cyber Resilience Act has been cited. The CRA rows of the conformance map have a shelf life tied to this. | `conformance-cra-hens-citation` |
| 2027-05-31 | Google Play has raised the target API level it requires on 31 August in each of the last two years, and no 2027 level is published yet. This date is three months before the next 31 August. A level above 36 would raise the scaffold's floor, which needs a ramp in a minor release, so the question is asked early. | `conformance-play-target-api-window` |
| 2027-06-11 | Six months before 2027-12-11, when the EU Cyber Resilience Act's reporting duties reach open-source software stewards (Article 24(3)). Whether this project has a steward is an open question for the maintainer. | `conformance-cra-art14-application` |
| 2027-06-15 | ASD is consulting on replacing the Essential Eight. The Essential Eight register gets re-based or retired depending on the outcome. | `conformance-e8-retirement` |

## When something outside this project changes

These are recorded as condition rows. Each names the external event that would
let it close, and none has a date because none is in this project's hands.

- **ESLint 10.** The scaffold pins ESLint 9, which its vendor ended on
  2026-08-06. The move waits on `eslint-plugin-react-native-a11y` and
  `eslint-plugin-jsx-a11y` admitting ESLint 10 (`tools/eol.json`).
- **Phishing-resistant MFA and mandatory MFA enrolment.** Waiting on documented
  WebAuthn support in Supabase Auth.
- **Backup store posture and immutability.** Depends on what the hosting
  platform exposes to a project.
- **A validate lane off Linux.** The blocker is the database: the isolation
  tests need the local Supabase stack, which needs Docker on the runner.
- **A passphrase KDF for the `e2ee` module.** WebCrypto has no memory-hard KDF,
  so this stays a consumer decision until that changes.

## Project health

- **A second maintainer.** The project has one maintainer and no successor
  ([GOVERNANCE.md](GOVERNANCE.md), Continuity). A second person with
  administrator access would mean changes get reviewed by someone other than
  their author, and that the project could continue without its founder.
- Keep meeting the OpenSSF Best Practices criteria and the OSPS Baseline as
  they evolve, and keep the OpenSSF Scorecard results public.

## What this project will not do

Publishing to the npm registry was on this list until 2026-10-02. It came off
because npm 12 refuses the `npx github:` install by default, and because every
scaffold already told its user to run the registry name. The release workflow now
publishes each release's attested tarball there through trusted publishing (#161).

- **Add runtime dependencies to the installer.** It uses Node built-ins only
  (CONTRIBUTING.md, ground rule 3).
- **Claim a certification or a conformance level.** The compliance registers
  are mappings, and `scripts/hygiene.mjs` fails the build on wording that says
  otherwise.
- **Support other stacks in this repository.** A different stack is a sibling
  harness made by forking this one ([docs/forking.md](docs/forking.md)), which
  is how this repository itself began.
- **Weaken a gate to make an upgrade painless.** Existing installs get a dated
  ramp with an expiry. They do not get a permanent exemption.
