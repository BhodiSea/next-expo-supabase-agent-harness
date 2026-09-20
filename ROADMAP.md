# Roadmap

What this project intends to do over roughly the next twelve months, and what
it does not intend to do. Every item below links to the record in this
repository that tracks it. Most of those records are commitments. The
"Field-report upgrades" section holds proposals, and says so.
Dates on calendar items are external deadlines. Nothing here is a promise about
delivery dates for features.

The machine-checked source for most of this is
[`scripts/obligations.json`](scripts/obligations.json): release rows block a
release until they are discharged, and calendar rows turn the nightly run red
when they fall due.

## Now: overdue

- **Two dated compliance re-verifications are overdue**:
  `conformance-play-target-api-window` (Google Play target API level, due
  2026-08-31) and `conformance-cra-art14-application` (EU Cyber Resilience Act
  Article 14 reporting, due 2026-09-11). Each needs the re-read its row
  prescribes.
- **Make the nightly run able to raise an alarm again.** It had been red every
  night since 2026-08-11, which hid the lapse of the Next.js security floor
  review in September (see the 1.0.2 CHANGELOG entry). Clearing the two items
  above is the first half. The second is a check that compares the framework
  floor against the vendor's advisory feed, so that a security release is
  noticed when it ships and not when a review window happens to end.
- **Get dependency updates flowing.** `renovate.json` is configured here and in
  every scaffold, and CONTRIBUTING ground rule 5 says Renovate maintains the
  pins, but the Renovate app has never opened a pull request on this
  repository. Until it does, exact pins go stale and caret ranges move
  unobserved. The Supabase CLI is a caret range, which is how CI picked up a
  new local database image in September 2026 with no commit (1.0.2 CHANGELOG).
  Install the app, then pin the CLI exactly.
- **Issue #10**: the Maestro mutation journey fails on the Android emulator in
  the scheduled device lane.

## Next: 1.1.0

1.0.0 opened a set of dated advisory notes for existing installs, all expiring
at 1.1.0. Shipping 1.1.0 means discharging each one:

- The six-gate note fleet becomes enforcing for upgraded installs:
  `auth-posture`, `boundaries`, `docs-sync`, `resilience`, `suppressions`,
  `version-sync` (the `*-ramp-expiry` release rows in the obligations register).
- `uuid` 7, the one vendor-deprecated package in the production dependency
  closure, reaches its recorded re-review at 1.1.0 (`tools/eol.json`).
- The Supabase CLI config census, blocked upstream on supabase/cli#5894, was
  re-dated to 1.1.0 and gets re-examined then.

## Field-report upgrades

Proposals that came out of a retrospective on a project built with this
harness. Unlike the sections above, these are not commitments. None has a row
in `scripts/obligations.json`, so none blocks a release, and the maintainer
decides which become binding. Each item links to its section of
[`design/FIELD-UPGRADES-2026-09.md`](design/FIELD-UPGRADES-2026-09.md), which states the
defect from this repository's own code, the proposal, and the guard that keeps
the change from weakening a gate. An item that adds a check, or changes what an
existing check judges, needs a `gate-proposal` issue first (CONTRIBUTING.md,
ground rule 6).

### 1.1.0, no ramp

None of these tightens a gate for an existing install. Where one changes what
`update` does, its section says so.

- **Input-stamped Stop steps.** The slow Stop entries skip on unchanged
  inputs, a stamped step prints as `STAMPED`, and stamp inputs cover the
  libraries a gate imports.
  ([N01](design/FIELD-UPGRADES-2026-09.md#n01-input-stamped-stop-steps))
- **Stop-step and gate-event telemetry.** Untrimmed local records of step
  durations and of in-turn gate and guard events, read by no gate.
  ([N02](design/FIELD-UPGRADES-2026-09.md#n02-stop-step-and-gate-event-telemetry))
- **Preflight hygiene and a pinned runner environment.** `doctor` reports the
  toolchain it resolved and clears enumerated residue, and the local database
  lane stops taking its CLI and its port from the machine.
  ([N03](design/FIELD-UPGRADES-2026-09.md#n03-preflight-residue-hygiene-and-a-pinned-runner-environment))
- **`validate --ci-parity`.** One flag gives a local run CI's posture: no
  skips and no stamps.
  ([N04](design/FIELD-UPGRADES-2026-09.md#n04-a-ci-parity-flag-for-validate))
- **A dated deferral for an unbuilt surface.** A project building one surface
  first can defer the device and perf lanes for the other, with an expiry and
  a content tripwire. Needs a `gate-proposal` issue first.
  ([N05](design/FIELD-UPGRADES-2026-09.md#n05-a-dated-deferral-for-a-surface-that-is-not-built-yet))
- **Skip a lane that already passed on the same tree.** The post-merge run
  reuses a `success` from the pull request when the tree hash is identical.
  ([N06](design/FIELD-UPGRADES-2026-09.md#n06-skip-a-lane-that-already-passed-on-the-same-tree))
- **Legal empty states on day 0.** `perf-budget`, the event catalog and the
  account-deletion closure stop requiring the worked example, and a factory
  lane proves the chain green without it.
  ([N07](design/FIELD-UPGRADES-2026-09.md#n07-legal-empty-states-on-day-0-and-a-factory-lane-that-proves-them))
- **Database proofs on a fixture table.** Behavioural pgTAP proofs build their
  own table inside the transaction, so deleting the example does not delete
  them.
  ([N08](design/FIELD-UPGRADES-2026-09.md#n08-behavioural-database-proofs-on-a-fixture-table))
- **Generated skill references.** The code in the authoring skill's references
  is extracted from the example's source and drift-checked upstream.
  ([N09](design/FIELD-UPGRADES-2026-09.md#n09-skill-references-generated-from-the-example))
- **A session-start brief and `harness:status`.** Enumerated, length-capped
  install state at the start of a session and on demand.
  ([N10](design/FIELD-UPGRADES-2026-09.md#n10-a-session-start-brief-and-a-status-command))
- **Per-gate field notes.** A seeded, write-guarded file of short notes
  printed under a gate's FAIL line.
  ([N11](design/FIELD-UPGRADES-2026-09.md#n11-per-gate-field-notes-in-fail-lines))
- **A fallback order for reviewer models.** An owed reviewer can still run
  when its pinned model is unavailable, and the ledger records which model
  ran.
  ([N12](design/FIELD-UPGRADES-2026-09.md#n12-a-fallback-order-for-reviewer-models))
- **A resolver for spec anchors.** Specs gain addressable sections, so a
  prompt cites a section and not a file.
  ([N13](design/FIELD-UPGRADES-2026-09.md#n13-a-resolver-for-spec-anchors))
- **Review records outside ADRs.** A defined home for round-by-round review
  records, so ADRs keep decisions.
  ([N14](design/FIELD-UPGRADES-2026-09.md#n14-review-records-outside-adrs))
- **A proposal flow for register edits, and a project-side corpus.** An agent
  stages a protected edit for a human to apply in one action, and the citation
  corpus splits into an owned upstream index and a seeded project file.
  ([N15](design/FIELD-UPGRADES-2026-09.md#n15-a-proposal-flow-for-register-edits-and-a-project-side-corpus))
- **Two guard carve-outs.** Editing a migration that git has never tracked,
  and a sanctioned delete for ignored build output.
  ([N16](design/FIELD-UPGRADES-2026-09.md#n16-two-guard-carve-outs))
- **Absence checklists and a reviewer eval.** Reviewers report what a change
  should have brought with it and did not, and a factory-side eval measures
  them on seeded defects.
  ([N17](design/FIELD-UPGRADES-2026-09.md#n17-absence-checklists-for-reviewers-and-a-reviewer-eval))
- **A smaller always-loaded context.** A sentence leaves `AGENTS.md` only when
  a gate already reds its violation, and `encryption.md` becomes a stub.
  ([N18](design/FIELD-UPGRADES-2026-09.md#n18-a-smaller-always-loaded-context))
- **Compliance register checks on a release cadence.** Locally the two
  register checks run behind an input stamp. CI and releases always run them.
  ([N19](design/FIELD-UPGRADES-2026-09.md#n19-compliance-register-checks-on-a-release-cadence))
- **Provenance by decision class.** Mandatory where a citation guards a
  security decision, advisory elsewhere.
  ([N20](design/FIELD-UPGRADES-2026-09.md#n20-provenance-mandatory-where-it-guards-a-security-decision-advisory-elsewhere))
- **An owned path with no manifest record.** `update` parks the incoming copy
  unless the bytes on disk are a released version. Follows #21.
  ([N21](design/FIELD-UPGRADES-2026-09.md#n21-an-owned-path-with-no-manifest-record))

### 1.1.0, behind a ramp

Each of these changes a verdict for an existing install, so each ships as a
dated note first and becomes enforcing when its ramp expires. Each needs a
`gate-proposal` issue first.

- **Reviewer ledger v2.** The owed set is keyed on the merge base and includes
  deletions, a BLOCK persists until the reviewer that raised it passes, a
  review of a moving tree does not count, and the every-turn reviewers are
  judged. The tightening and the relaxing ship behind one ramp.
  ([R01](design/FIELD-UPGRADES-2026-09.md#r01-reviewer-ledger-v2))
- **A severity contract and a round budget.** Reviewer bodies say which
  severities block, and the hook bounds rounds without ever turning a spent
  budget into a pass.
  ([R02](design/FIELD-UPGRADES-2026-09.md#r02-a-severity-contract-and-a-round-budget))
- **`docs-sync` holds the verdict demand to the end of the body.** Presence is
  checked today. Position is what #23 had to fix.
  ([R03](design/FIELD-UPGRADES-2026-09.md#r03-docs-sync-holds-the-verdict-demand-to-the-end-of-the-body))
- **A CI self-lint job.** The shipped `actions-lint` workflow holds a
  project's own workflows to a bash default and a ceiling on every job.
  ([R04](design/FIELD-UPGRADES-2026-09.md#r04-a-ci-self-lint-job-for-shells-and-ceilings))
- **Grants bounded by policies.** A static upper bound on what `authenticated`
  is granted, generated privilege-exactness assertions, and the three-role
  revoke doctrine with its ADR.
  ([R05](design/FIELD-UPGRADES-2026-09.md#r05-grants-bounded-by-policies-generated-exactness-and-a-revoke-doctrine))
- **`sql-parse` learns `DROP TABLE` and `ALTER POLICY`.** Seven gates stop
  reasoning about tables that are gone and predicates that were replaced.
  ([R06](design/FIELD-UPGRADES-2026-09.md#r06-the-sql-parser-learns-drop-table-and-alter-policy))
- **i18n detection on the syntax tree.** Replaces expressions over source
  text, and keys the allowlist on content instead of a line number.
  ([R07](design/FIELD-UPGRADES-2026-09.md#r07-i18n-detection-on-the-syntax-tree))
- **The web build in the chain, and a browser test per route.** A web app that
  does not compile can pass the local chain today, and no closure asks whether
  a route has a browser test.
  ([R08](design/FIELD-UPGRADES-2026-09.md#r08-the-web-build-in-the-chain-and-a-browser-test-per-route))

### 2.0.0, breaking

- **The example leaves the scaffold.** Reference-only by default, with an
  optional materialised demo and an `eject` verb.
  ([B01](design/FIELD-UPGRADES-2026-09.md#b01-the-example-leaves-the-scaffold))
- **The encryption rule ships with its module.** An install without `e2ee`
  carries none of it.
  ([B02](design/FIELD-UPGRADES-2026-09.md#b02-the-encryption-rule-ships-with-its-module))
- **`prompt_id` leaves the ledger key.** After ledger v2 the path digest is
  what makes a verdict current.
  ([B03](design/FIELD-UPGRADES-2026-09.md#b03-prompt_id-leaves-the-ledger-key))

Five further ideas were considered and rejected. The design record
[lists them with the reason](design/FIELD-UPGRADES-2026-09.md#dropped-after-design-review), so they are not
proposed again.

## Through mid-2027: dated external changes

| Date | What changes | Row |
|---|---|---|
| 2026-10-30 | Supabase stops granting Data API privileges automatically on new projects. The scaffold's migrations already grant explicitly; this is the date to re-verify that against a project created after it. | `conformance-supabase-grants-arrival` |
| 2026-12-02 | EU AI Act Article 50 transitional period ends. The recorded disposition is a confirmed negative, to be re-read. | `conformance-ai-act-transitional` |
| 2026-12-31 | Re-check whether a harmonised standard for the Cyber Resilience Act has been cited. The CRA rows of the conformance map have a shelf life tied to this. | `conformance-cra-hens-citation` |
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

- **Publish to the npm registry.** The install channel is
  `npx github:...` and each release is a provenance-attested GitHub Release
  asset (CONTRIBUTING.md, "Releases").
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
