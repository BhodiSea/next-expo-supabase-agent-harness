# Module: store-metadata

The store listing as reviewable repo data. The App Store listing lives in
`apps/mobile/store.config.json` (EAS Metadata) and reaches App Store Connect
only through a dispatch-only workflow with an honest no-credential degrade;
the Google Play side — which EAS Metadata does not implement — is mirrored as a
console checklist that locksteps with the reviewed permission allowlist. Plus
the two store documents every submission needs current: App Review notes and
iOS privacy-manifest scaffolding.

**Beta, and Apple-only.** EAS Metadata is in beta and currently supports only
the Apple App Store — Google Play is explicitly not implemented. That is why
the Play half of this module is a checklist (`docs/store/play-data-safety.md`),
not config. Expect schema/CLI movement while the beta label holds; the pinned
`eas-cli` version in the workflow is the one this module's idioms were verified
against. SOURCE: https://docs.expo.dev/eas/metadata/

## What it adds

| File | Purpose |
| --- | --- |
| `apps/mobile/store.config.json` | the App Store listing as data — PR-diffable, schema-validated, pushed deliberately |
| `tools/check-store-config.mjs` | schema-lite bounds + sentinel refusal; the credential-free leg of every dispatch |
| `.github/workflows/store-metadata-push.yml` | dispatch-only: validate → `eas metadata:push`, honest degrade without `EXPO_TOKEN` |
| `docs/store/app-review-notes.md` | App Review notes template, distilled into `apple.review.notes` per submission |
| `docs/store/play-data-safety.md` | Play Data-safety checklist mirroring `tools/expo-permissions.json` |
| `docs/store/ios-privacy-manifests.md` | app-level `PrivacyInfo` scaffolding: what Expo SDK 57 self-declares, what you must copy app-level |

## Prerequisites

- Nothing secret to enable; nothing here runs in the validate chain or selftest.
- To actually PUSH: an `EXPO_TOKEN` repository secret (robot token —
  https://docs.expo.dev/accounts/programmatic-access/), an EAS project id in
  `app.config.ts` (`eas init`), and a real `ascAppId` in `eas.json`'s submit
  profile (`TBD` placeholders make the push fail loudly, which is correct).
- Fill the listing: the shipped `store.config.json` carries deliberate sentinel
  values (`example.com` URLs, "Replace ..." prose). The first dispatch fails on
  them BY DESIGN — that first red is this module's anti-vacuity proof.

## How enabling works

```
npx next-expo-supabase-agent-harness enable store-metadata
```

copies the files and records them in `.harness/manifest.json`. No
`tools/harness.config.mjs` change: the workflow IS the module's gate, and it
runs only on manual dispatch (pushing a store listing is a human act, never a
merge side effect). This module is part of the `strict` tier.

`store.config.json` sits beside `eas.json` (the app dir is the EAS project
root, which is where EAS Metadata looks for it by default); if you move or
rename it — e.g. to a dynamic `store.config.js` — point
`submit.<profile>.ios.metadataPath` in `eas.json` at the new path.
SOURCE: https://docs.expo.dev/eas/json/ (`submit.<profile>.ios.metadataPath`)
The Expo Tools VS Code extension autocompletes the store-config schema.

**Honest degrade:** with no `EXPO_TOKEN` the dispatch still validates
`store.config.json`, then emits a workflow warning and uploads a
`NOT-PUSHED.txt` artifact instead of failing on the missing secret — and
instead of pretending anything was published. A validation failure, by
contrast, is a real red in both legs.

## How this can FAIL (anti-vacuity)

- **Sentinel refusal, out of the box:** enable the module and dispatch the
  workflow before editing the listing → `check-store-config` fails naming every
  sentinel field. Fill them → green. (Same first-failure pattern as
  ci-provenance's NOTICES gate.)
- **Bounds:** make a keyword 101 characters, or delete `privacyPolicyUrl`, or
  set `configVersion` to 1 → red with the exact field named.
- **Credential hygiene:** add `apple.review.demoPassword` to the committed
  JSON → red. Demo credentials are injected at push time
  (`docs/store/app-review-notes.md` documents both supported paths).
- **Degrade is loud, not green-shaped:** dispatch without `EXPO_TOKEN` and
  confirm the run carries the warning annotation + the
  `store-metadata-not-pushed` artifact. A run that pushed nothing and says
  nothing would be the failure mode this module exists to prevent.
- **Push leg:** with a token but `TBD` store identifiers in `eas.json`,
  `eas metadata:push` fails loudly — store onboarding cannot be faked.

## Considered and rejected

- **fastlane (`deliver`/`supply`) for store metadata** — rejected in the design
  record: it drags a Ruby toolchain into a repo that deliberately has none, for
  a job EAS Metadata covers on the iOS side with plain JSON in the repo. The
  Play half that fastlane would have added is a console-managed form either
  way — mirrored honestly as `docs/store/play-data-safety.md` instead of
  automated dishonestly.
- **Pushing metadata from the release workflow** — a listing change is not a
  build artifact; coupling them would push listing edits as a side effect of
  tagging. Dispatch-only keeps the act deliberate and auditable.

## Honest limits

- **The stores' lockstep is review discipline, not a gate.** The Play
  data-safety table, the privacy-manifest union, and the App Review notes are
  kept true by editing them in the SAME diff as the change that invalidates
  them — each file states its own lockstep rule at the top. No credential-free
  gate can diff a console form or a resolved pod set; the checklists ARE the
  mechanism, and the `expo-policy` permission lockstep is the one automated leg.
- **EAS Metadata is beta** — schema or CLI movement can land between eas-cli
  releases. The workflow pins the eas-cli version this module's idioms were
  verified against; bump it deliberately and re-read the changelog when you do.
- **Nothing here proves a push succeeded against review policy** — App Store
  Connect can still reject values the schema accepts (Apple validates
  server-side). `eas metadata:push` surfaces those errors in the workflow log;
  a green validate leg is a necessary condition, never the whole story.

## Notes

- The three store documents and `store.config.json` are yours after install
  (the installer never overwrites `apps/` or docs you have edited).
- Pair with `ci-mobile-release` for the build/submit DAG; this module owns only
  the listing surface. If you enable `crash-reporting`, the Play data-safety
  crash-logs row and the App Store privacy answers change in that same diff.
