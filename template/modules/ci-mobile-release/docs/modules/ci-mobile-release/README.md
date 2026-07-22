# Module: ci-mobile-release

The EAS release DAG. Tag-triggered (`v*`): validate floor → EAS production build
(both stores) → artifact download from the build JSON → size budgets from
`tools/perf-baseline.json` → SHA-256 checksums → attach to the GitHub release →
gated `eas submit`. Plus release-please automation that maintains the release PR
and bumps every version surface in lockstep (the `version-sync` gate requires it),
and a PR preview lane: a credential-free native-fingerprint diff on every PR, and
a label-gated EAS preview build.

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/release-mobile.yml` | the tag-triggered gates → build → verify/attach → submit pipeline |
| `.github/workflows/release-please.yml` | conventional-commit release automation |
| `.github/workflows/preview-mobile.yml` | PR fingerprint diff (every PR) + EAS preview build (`preview-build` label) |
| `release-please-config.json` / `release-please-manifest.json` | version-bump config: root + apps/mobile + apps/server `package.json` move together |

## The version story (why extra-files is so short)

The source harness bumped four files per release; this one bumps three
`package.json`s and **no native config file**, because there is none to bump:
`app.config.ts` **derives** every other version surface from
`apps/mobile/package.json` — `version`, `ios.buildNumber`, `android.versionCode`
(maj·1e6 + min·1e3 + pat), and the `runtimeVersion` OTA boundary
(`policy: 'appVersion'`). The `version-sync` gate recomputes those derivations
through the resolved Expo config on every run, so a literal smuggled into a
native surface goes red at the next bump, not at store review. What release-please
must keep in lockstep is exactly what the gate asserts as equal: the root,
`apps/mobile`, and `apps/server` `package.json` versions — the root is bumped
natively by the `node` release type, the other two by `extra-files`.

## Prerequisites

- An [EAS-initialized](https://docs.expo.dev/eas/) project: the `EAS_PROJECT_ID`,
  `ASC_APP_ID`, and `APPLE_TEAM_ID` placeholders answered with real values
  (`doctor` warns while any is `TBD`).
- A GitHub environment named `release` (recommended: protect it with required
  reviewers) carrying the `EXPO_TOKEN` secret — a robot-account access token from
  expo.dev. The build and submit jobs run in that environment; the PR preview
  lane runs outside any environment, so previews additionally need a
  repository-level `EXPO_TOKEN` (fork PRs never see either — they degrade green).
- Store credentials **in the EAS credentials service**, not in GitHub: the Google
  service-account key (`eas credentials --platform android`) and the ASC API key
  (`--platform ios`). Submission executes on EAS servers; no store key material
  ever touches a runner.
- The `AUTO_SUBMIT` repository variable set to `true` — or the `auto-submit`
  input on a manual dispatch — before the submit job does anything but write
  `NOT-SUBMITTED.txt`.
- Conventional commits on `{{DEFAULT_BRANCH}}` (commitlint already enforces this).
- A `preview-build` label in the repo for the label-gated preview lane.

**Honest degrade:** with no `EXPO_TOKEN` the tag pipeline still runs end to end —
it builds an **unsigned** Android bundle on the runner, writes
`UNSIGNED-BUILD.txt` beside it, loud-skips iOS (an `.ipa` cannot exist without
EAS/Apple credentials — the absence is stated, never faked), verifies budgets and
checksums, attaches everything to the release, and attaches `NOT-SUBMITTED.txt`
in place of a submission. A skipped submit with a token present (no
`AUTO_SUBMIT`) also attaches `NOT-SUBMITTED.txt`. Nothing on this path is
silently green.

## How enabling works

```
npx next-expo-supabase-agent-harness enable ci-mobile-release
```

copies the files above and records them in `.harness/manifest.json`. The release
pipeline is live on the next `v*` tag — no gate-config change needed (the
workflow IS the gate). First release: merge the release-please PR it opens after
your first conventional commit, or push a `v0.1.0` tag manually.

One GitHub quirk to know: a tag created by release-please with the default
`GITHUB_TOKEN` does **not** trigger `release-mobile.yml` (workflow-to-workflow
recursion guard). Start it via **Run workflow** on the tag ref, or push tags
manually / with a PAT if you want full automation.
SOURCE: https://docs.github.com/en/actions/concepts/security/github_token

## The PR preview lane

- **fingerprint** runs on every PR (and every `{{DEFAULT_BRANCH}}` push, which
  updates its database): the `expo/expo-github-action` fingerprint sub-action
  diffs the project's native fingerprint and comments the PR. An empty diff means
  the change is OTA-shaped; a non-empty diff means the native app changes and a
  store build is implied. Credential-free by design — no `EXPO_TOKEN` near a PR.
- **preview-build** runs only when the PR carries the `preview-build` label:
  a fire-and-forget `eas build --profile preview --no-wait` (CI is not billed
  while EAS builds; install links appear on the EAS dashboard). Without a token
  the job stays green with a warning naming exactly what is missing.

## How this gate can FAIL (anti-vacuity)

A release gate you have never seen fail is a decoration. Each check has a cheap
injection:

- **degrade honesty**: remove `EXPO_TOKEN` from the environment → the run must
  produce `UNSIGNED-BUILD.txt` + `NOT-SUBMITTED.txt` and a warning, never a
  quiet green that looks like a real release.
- **artifact parse**: point the pipeline at a profile with no artifacts (or
  truncate the build JSON by hand in a fork) → the parse step errors on the
  missing `applicationArchiveUrl`, it does not shrug.
- **size budget**: set `installerBudgetBytes` in `tools/perf-baseline.json` to
  `1` → verify-and-attach fails with the measured size (restore it after — the
  file is write-guard-protected for exactly this reason).
- **checksums/attach**: delete the downloaded artifacts before the checksum step
  (or break the artifact name) → `if-no-files-found: error` and the empty-glob
  guards trip.
- **submit gating**: with a token and `AUTO_SUBMIT` unset, the release must gain
  `NOT-SUBMITTED.txt` — if it doesn't, the gate is lying about what shipped.
- **fingerprint**: touch `apps/mobile/app.config.ts` (add a harmless permission)
  in a PR → the fingerprint diff must be non-empty; revert and it must be `[]`.

## Notes

- Two facts in this pipeline carry recorded MEDIUM confidence in the design
  record (RELEASE-FACTS): whether artifact downloads require the
  `Authorization: Bearer` header (it is sent regardless — harmless when not
  required), and the exact `eas submit` stored-credentials interplay. **Dry-run
  the pipeline once on a throwaway tag before trusting a real release to it.**
- `eas.json` pins `appVersionSource: "local"` and `autoIncrement: false` — the
  repo is the version source of truth, which is what makes the release PR the
  complete release record. Remote/auto-increment variants were considered and
  rejected (design record: PORT-SPEC).
- The identity in `tools/identity.lock.json` pins `{{APP_IDENTIFIER}}` as both
  the iOS bundle id and the Android package; changing it after the first release
  is a new app in both stores. The `expo-policy` gate guards this.
- Pair with the `ci-provenance` module for build attestation + SBOM of what this
  pipeline ships, and the `eas-update` module for the OTA half of the release
  story.
