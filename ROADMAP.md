# Roadmap

What this project intends to do over roughly the next twelve months, and what
it does not intend to do. Every item below comes from a commitment already
recorded in this repository, so each one links to the record that tracks it.
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
