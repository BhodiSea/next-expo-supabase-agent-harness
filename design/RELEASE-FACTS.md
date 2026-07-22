# RELEASE-FACTS — verified facts the release/module workflows are written against

Verified 2026-07-18 against eas-cli v21.0.2 README (published help), docs.expo.dev,
and the GitHub API (tags dereferenced to commits). Companion to EXPO-FACTS.md /
CI-LANE-FACTS.md. Re-verify on eas-cli major bumps.

## eas build orchestration (ci-mobile-release)

- `eas build --platform all --profile production --non-interactive --json`:
  `--json` implies non-interactive; with the default `--wait`, stdout at exit is
  a JSON array of build objects INCLUDING `artifacts.buildUrl` /
  `applicationArchiveUrl` (the .aab/.ipa) / `buildArtifactsUrl`.
- Simplest CI idiom (chosen): one long-running `eas build --wait --json` under a
  GH job `timeout-minutes`, parse artifact URLs at exit, `curl -L` download.
  Alternative: `--no-wait --json` → poll `eas build:view <id> --json` until
  `status: FINISHED`. MEDIUM confidence on whether artifact downloads need
  `Authorization: Bearer $EXPO_TOKEN` — send it; do one dry run before trusting
  the degrade logic.
- CI is not billed while EAS builds (`--no-wait` fire-and-forget is Expo's own
  CI recommendation when artifacts aren't needed in-job).

## eas submit (honest-degrade release job)

- Artifact sources: `--path <.aab|.ipa>` (local file — our checksummed copy),
  `--id <build-id>` (avoids re-upload when the build stayed on EAS), `--url`.
  Plus `--latest`, `--non-interactive`.
- **No store key material on runners**: Google service-account key and the ASC
  API key can both live in the EAS credentials service (`eas credentials
  --platform android|ios`); `serviceAccountKeyPath`/`ascApiKey*` in eas.json
  are the self-managed ALTERNATIVE, not required. Submission executes on EAS
  servers. MEDIUM-HIGH on the exact `--path` + stored-creds + non-interactive
  interplay — dry-run once before shipping the module as verified.

## EAS Metadata (store-metadata module)

- Still **beta**, still **iOS-only** (Play explicitly not implemented).
  `store.config.json` (static or dynamic JS); `eas metadata:push|pull`
  (`--profile`, `--non-interactive`). Module ships it as opt-in with the beta
  caveat in its README; Play data-safety remains a console-managed checklist.

## release-please (ci-mobile-release)

- Current major **v5** (v5.0.0, node24). Pin:
  `googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0`.
- `extra-files` JSON updater syntax confirmed current:
  `{"type": "json", "path": "apps/mobile/package.json", "jsonpath": "$.version"}`.

## eas update in CI (eas-update module)

- `eas update --channel <ch> --message "<msg>" --non-interactive` (+`--json`,
  `--auto`); auth via EXPO_TOKEN. Staged rollout flags per CI-LANE-FACTS.
- `runtimeVersion: {policy: 'appVersion'}` compatibility semantics CONFIRMED:
  updates deliver only to binaries whose runtime version exactly matches — an
  app-version bump fences off older binaries (our chosen conservative posture;
  docs steer toward `fingerprint` for finer reach — recorded as
  considered-and-rejected in PORT-SPEC).

## Action SHA pins (resolved 2026-07-18)

- `actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373 # v4.1.1`
- `dorny/paths-filter@7b450fff21473bca461d4b92ce414b9d0420d706 # v4.0.2`
- `actions/setup-java@03ad4de0992f5dab5e18fcb136590ce7c4a0ac95 # v5.6.0`
- `gradle/actions/setup-gradle@3f131e8634966bd73d06cc69884922b02e6faf92 # v6.2.0`

## Design note

Expo's first-party answer to build→submit orchestration is EAS Workflows; this
harness deliberately stays on GH Actions (SHA-pinning + harden-runner + zizmor
coverage — see PORT-SPEC considered-and-rejected).
