# Google Play Data safety — repo-side checklist

EAS Metadata is beta and **Apple-only** (Google Play is explicitly not
implemented), so the Play listing and its Data safety form stay console-managed
— there is no `store.config.json` equivalent to review in a PR.
SOURCE: https://docs.expo.dev/eas/metadata/

This file is the repo-side mirror: the answers you gave (or will give) in the
Play Console, kept where a reviewer can diff them against the code that makes
them true. Update it in the SAME diff as any change to what the app collects.

## The mirror rule (permissions ↔ declarations)

`tools/expo-permissions.json` is the reviewed Android permission allowlist; the
`expo-policy` gate locksteps it bidirectionally against the resolved app config,
so it can never quietly over-grant. This checklist extends that lockstep one
step further:

> **Every entry in `tools/expo-permissions.json` MUST have a row in the table
> below, added in the same diff as the grant.**

As shipped the allowlist is **empty** — the scaffold grants no Android runtime
permissions (the baseline `INTERNET` permission is injected at prebuild and is
not a config-surface grant). So there are no permission-derived data sources:
no location, no camera, no contacts, no microphone. If a permission ever lands
in the allowlist without a row here, this file is lying — fix it in review.

| Declared permission | Data safety category (Play) | Collected? Shared? | Why |
| --- | --- | --- | --- |
| _(none declared — table must stay in lockstep with `tools/expo-permissions.json`)_ | — | — | — |

## What the scaffold app actually collects (permission-free flows)

Play's form covers everything the app transmits off-device, not just
permission-gated sources. Category names below are Play's own.
SOURCE: https://developer.android.com/guide/topics/data/collect-share

| Play category | Answer for the scaffold | Grounding |
| --- | --- | --- |
| Personal info → User IDs | **Collected** (account identifier from your identity provider, sent as the bearer token subject to `{{WEB_ORIGIN}}`; the server keys rows by it). Not shared with third parties. | auth flow + FORCE RLS schema |
| Personal info → Name / Email address | **VERIFY per tenant**: whether ID-token claims carry name/email depends on the scopes and claims your identity tenant releases. Declare what your tenant actually emits. | your IdP configuration |
| App activity → Other user-generated content | **Collected** (note content the user writes syncs to `{{WEB_ORIGIN}}`). Not shared. | notes feature |
| App info and performance → Crash logs / Diagnostics | **Not collected** in the base scaffold. Flips to *Collected* the moment the `crash-reporting` module (or any telemetry) is enabled — update this row in that same diff. | no crash/telemetry dependency in base |
| Device or other IDs | **Not collected** — the scaffold reads no advertising or device identifier. | dependency set |
| Location / Contacts / Calendar / Photos / Messages / Financial / Health | **Not collected** — no permission grants (see mirror table above). | empty `tools/expo-permissions.json` |

## Form answers that are structurally true

- **Encrypted in transit: yes.** The committed API origin must be HTTPS (or
  loopback for local dev) — the `expo-policy` gate asserts it; a cleartext
  production origin cannot land without that gate going red.
- **Data deletion:** Play asks how users request deletion. The scaffold ships
  **no** account-deletion path — that is a product decision left to you. Do not
  declare a deletion mechanism until one exists. TODO row: fill in your answer
  and the code/runbook that makes it true.

## Console checklist (per listing update)

- [ ] Every `tools/expo-permissions.json` entry has a row in the mirror table.
- [ ] The "actually collects" table matches the current dependency set (crash
      reporting? analytics? push?) — modules change answers.
- [ ] Form filled in Play Console: App content → Data safety; answers copied
      FROM this file, not improvised in the console.
- [ ] iOS privacy declarations tell the same story
      (`docs/store/ios-privacy-manifests.md`, App Store Connect privacy
      questions) — stores must not contradict each other.
- [ ] This file's date-of-truth bumped: last verified against the console on
      `YYYY-MM-DD` (fill in).
