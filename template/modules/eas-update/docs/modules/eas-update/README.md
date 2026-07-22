# Module: eas-update

Opt-in over-the-air (OTA) updates via EAS Update: a dispatch-only publish
workflow (`eas update --channel <ch> --non-interactive`, honest-degrade without
`EXPO_TOKEN`), a sanity gate over the OTA surface, and this runbook — including
the store-policy constraints and the republish-as-rollback doctrine.

OTA is a policy decision, which is why this is a module and not a default: an
update can change **JS and assets only** — never native code, native
dependencies, permissions, or the SDK version — and under this harness's locked
`runtimeVersion: { policy: 'appVersion' }` an update reaches **only binaries
whose app version exactly matches** the version it was exported against. A
version bump fences off every older binary by design (deterministic and
PR-reviewable; the `fingerprint` policy is rejected in the design record).

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/eas-update.yml` | dispatch-only publish: floor validate → OTA sanity → `eas update`; loud NOT-PUBLISHED degrade without `EXPO_TOKEN` |
| `tools/check-eas-update.mjs` | OTA surface sanity gate (see "What the gate checks") |
| `docs/modules/eas-update/README.md` | this document |

The module deliberately ships **no change to `eas.json` or `app.config.ts`**.
Those are consumer-owned files the installer never clobbers (`enable` would park
a conflicting copy under `.harness/pending/`), so the channel config is a
documented one-line-per-profile patch below — and the gate is the check that the
patch was applied completely and consistently.

## How enabling works

```
npx next-expo-supabase-agent-harness enable eas-update
```

copies the files above and records them in `.harness/manifest.json`. Then do the
one-time setup — the gate and workflow stay inert (loud skip / loud degrade)
until you do.

## One-time setup

1. **Real EAS project identity.** OTA needs the real project UUID, not `TBD`:
   run `eas init` (from `apps/mobile`), then update `easProjectId` in
   `tools/identity.lock.json` **and** `extra.eas.projectId` in
   `apps/mobile/app.config.ts` in the same reviewed diff (the lock is
   write-guard-protected — this is a human edit by design).

2. **Install the client library** (from `apps/mobile`):

   ```
   npx expo install expo-updates
   ```

   `expo install` picks the SDK-aligned version; the `native-deps` gate
   (`expo install --check`) will red any drift. `expo-updates` is deliberately
   not in the base catalog — OTA machinery must not ride into every install.
   If the resolved plugin list grows after installing it, the `expo-policy`
   gate will name the missing `tools/expo-plugins.json` entry — add it with a
   reason in the same diff.

3. **The `eas.json` patch — one line per building profile.** Add a `channel` to
   every profile that produces an updatable binary (the template's `preview`
   and `production`; `base` is a shared parent and `development` builds a dev
   client — neither needs one):

   ```jsonc
   "preview":    { /* ...existing keys... */ "channel": "preview" },
   "production": { /* ...existing keys... */ "channel": "production" }
   ```

   A build made from a profile carries that channel; `eas update --channel X`
   publishes to it. Channel-per-profile means a preview binary can never
   receive a production update or vice versa.
   ([eas.json reference](https://docs.expo.dev/eas/json/))

4. **The app config patch.** Add to the `expo` object in
   `apps/mobile/app.config.ts`:

   ```ts
   // SOURCE: docs/modules/eas-update/README.md; https://docs.expo.dev/eas-update/getting-started/
   updates: {
     url: 'https://u.expo.dev/<easProjectId>', // the UUID pinned in tools/identity.lock.json
   },
   ```

   Keep the `// SOURCE:` line — `app.config.ts` is provenance-checked, and a
   bare `url:` decision site reds the base `provenance` gate.

   (`eas update:configure` writes the equivalent of steps 3 and 4 for you —
   review its diff against the lock before committing.
   [Getting started](https://docs.expo.dev/eas-update/getting-started/))

5. **Wire the gate.** Append to `VALIDATE_STEPS` in `tools/harness.config.mjs`
   (harness-protected: a human edits it, or an agent with
   `HARNESS_ALLOW_SELF_EDIT=1`):

   ```js
   ['eas-update', 'node tools/check-eas-update.mjs'],
   ```

   The `docs-sync` gate then requires the docs to keep step: in `AGENTS.md`,
   update the "The N gates, in order: …" sentence (count +1, `eas-update`
   appended) **and** the "the N-step chain" phrase, and add a numbered section
   to `docs/harness/gates-catalog.md`:

   ```markdown
   ### 22. eas-update — `node tools/check-eas-update.mjs`

   OTA surface sanity (opt-in module): expo-updates installed, runtimeVersion
   exactly appVersion, updates.url exactly the locked EAS project, every
   building eas.json profile channeled. Fail it: flip the runtimeVersion
   policy, or delete one `"channel"` line from eas.json.
   ```

   (Renumber `22` to match your chain.) Do steps 2-5 in **one PR**: the gate
   skips loudly while the surface is absent but **fails closed in CI**, so a
   half-adopted surface on the default branch is a red, not a shrug.

6. **`EXPO_TOKEN` secret** for the publish workflow: create a **robot** access
   token (expo.dev → Access tokens) and add it as an Actions secret named
   `EXPO_TOKEN`. The publish job runs in the `release` environment
   (auto-created, unprotected, on first dispatch) — scope the secret there and
   add required reviewers to that environment once publishes need sign-off.
   Without the secret the workflow still runs — loudly degraded (below).

## What the gate checks (`tools/check-eas-update.mjs`)

Over the **resolved** config (`expo config --json --type public` — dynamic
config executed, plugins expanded):

1. `expo-updates` is a dependency of `apps/mobile` — an `updates.url` with no
   client library is a surface no shipped binary ever polls.
2. `runtimeVersion` is exactly `{ "policy": "appVersion" }` — every delivery
   claim in this document is false under any other policy.
3. `updates.url` is **exactly** `https://u.expo.dev/<easProjectId>` for the id
   pinned in `tools/identity.lock.json` (and the lock pins a real UUID, not
   `TBD`). Stronger than `expo-policy`'s embeds-the-id check: an update URL
   pointing anywhere else is a hijacked — or dead — OTA channel.
4. Every `eas.json` build profile that produces an updatable binary resolves a
   non-empty `channel` (`extends`-aware). Shared parent profiles and
   `developmentClient` profiles are exempt (dev-client builds pick updates in
   the dev menu; `eas update:configure` itself only channels the non-dev
   profiles).

No OTA signal at all (no `updates.url`, no dependency, no channels) → **loud
SKIP locally, FAIL CLOSED in CI**. Any partial signal → real reds.

## Publishing

Dispatch **eas-update** (Actions → eas-update → Run workflow):

- **channel** — `preview` or `production` (a choice input, mirroring step 3's
  channels; extend both together — free text could mint a channel no binary
  polls).
- **message** — the audit line shown in the EAS dashboard.
- **rollout-percentage** — optional staged rollout (1-100, empty = everyone).

The run then: re-proves the harness floor (`node tools/validate.mjs
--min-floor`, toolchains required — a red tree cannot ship over the air), runs
the OTA sanity gate (fail-closed), and publishes from `apps/mobile` with
`eas update --channel <ch> --message <msg> --non-interactive --json`
(auth via `EXPO_TOKEN`; under the hood the command runs `npx expo export` on
the runner and uploads the bundle —
[getting started](https://docs.expo.dev/eas-update/getting-started/)). The JSON
receipt is uploaded as the `eas-update-evidence` artifact (90 days).

**Honest degrade:** without `EXPO_TOKEN` the run stays green but LOUD — a
workflow warning, a credential-free `npx expo export`, and a
`NOT-PUBLISHED.txt` marker naming the requested channel/message/commit uploaded
beside the export metadata. Nothing is published; nothing pretends otherwise.

**Staged rollout runbook** (operator commands, authenticated locally):
publish with `rollout-percentage`, watch crash/error telemetry, then raise via
`eas update:edit`, or abandon via `eas update:revert-update-rollout`.
Branch-level rollouts exist as `eas channel:rollout`. There is no
`eas update:roll-out` command. ([Rollouts](https://docs.expo.dev/eas-update/rollouts/))

## Rollback = republish (doctrine: never a special rollback verb)

The workflow has **no rollback input on purpose**. A rollback is a publish:

1. **Preferred:** `git revert` the offending change (or check out the last
   known-good ref), merge green, dispatch the same publish workflow. The
   rollback rides the exact same validate floor, sanity gate, and audit trail
   as every other publish — nothing special-cased, nothing unaudited.
2. **When the bad update must disappear NOW** (skips the re-export, not the
   audit — run authenticated from a workstation):

   ```
   eas update:republish --group <update-group-id>
   ```

   re-publishes a known-good update **group** — the exact bytes you already
   shipped. `--channel <ch>` / `--branch <br>` instead select from that
   channel/branch's recent groups; `--destination-channel` republishes across
   channels (e.g. promote the preview bytes to production).
   ([Rollbacks](https://docs.expo.dev/eas-update/rollbacks/),
   [Deployment](https://docs.expo.dev/eas-update/deployment/))

Recorded honestly: `eas update:rollback` (an interactive menu over republish /
roll-back-to-embedded) and roll-back-to-embedded (instructs clients to fall
back to the bundle embedded in the binary) both exist. This module wires
neither: an interactive verb cannot run `--non-interactive`, and a rollback
verb that bypasses the publish path would be an unaudited state mutation.
Roll-back-to-embedded is the last resort when *every* published update is bad —
after any rollback, the next regular publish reaches all clients again
(a rollback is not a pin).

## Store policy: Apple guideline 2.5.2 (and Play)

OTA updates are store-compliant **only inside these constraints** — record them
in your release process, not just here:

- **Mechanism:** Apple's [App Review Guideline 2.5.2](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
  requires apps to be self-contained and not "download, install, or execute
  code which introduces or changes features or functionality of the app". OTA
  updates stay inside the line because they replace only the interpreted JS
  bundle executed by the runtime already shipped in the reviewed binary — never
  native code. ([What EAS Update can and cannot change](https://docs.expo.dev/eas-update/introduction/))
- **Behavior:** the limit is behavioral, not just technical. Expo's own rule:
  updates "need to follow the App Store and Play Store guidelines … This
  usually means changes to your app's behavior need to be reviewed."
  In practice: bug fixes, crash mitigation, copy/style corrections, and asset
  swaps are what OTA is for; **new product surfaces, purchase-flow changes,
  anything touching permissions, or anything that alters the app's advertised
  purpose ships as a store build through review** — over-the-air feature drops
  risk removal.
- **Hard technical limits** (enforced by what an update *is*): no native code
  or dependency changes, no permission changes, no SDK upgrade, nothing that
  needs a new binary. The `native-deps` and `expo-policy` gates red these
  before an export can even be attempted.

## How this can FAIL (anti-vacuity)

A gate you have never seen fail is a decoration. Cheap injections:

- **gate / runtime policy**: set `runtimeVersion: { policy: 'sdkVersion' }` in
  `app.config.ts` → red naming the policy and the design record.
- **gate / channels**: delete the `"channel"` line from `build.preview` → red
  naming the profile and the one-line patch.
- **gate / identity**: change one hex digit of the `updates.url` UUID → red
  naming the lock ("hijacked OTA channel").
- **gate / library**: remove `expo-updates` from `apps/mobile/package.json` →
  red with the `expo install` hint.
- **workflow / degrade**: unset `EXPO_TOKEN` and dispatch → green run with a
  warning annotation and a `NOT-PUBLISHED.txt` in the evidence artifact —
  the proof the degrade is loud, never silent.
- **workflow / floor**: dispatch from a branch with any validate gate red → the
  floor step stops the run before `eas update` is reached.
- **workflow / input**: dispatch with `rollout-percentage: 0` (or `101`) → the
  preflight validation step errors before anything is spent.

## Honest limits

- **No adoption proof.** No lane installs a binary and asserts it actually
  fetched an update; the gate is static sanity and the receipt is EAS's word.
  On-device update-adoption proof would need store-credentialed builds in CI —
  rejected for the same credential-free-selftest doctrine as everywhere else.
- **Dev-client profiles are channel-exempt** in the gate; if you want dev
  builds pinned to a channel anyway, add the line — the gate only requires,
  never forbids, a channel.
- **`u.expo.dev` only.** A custom/self-hosted update server fails check 3 by
  design; adopting one means retiring this module's gate, a reviewed decision.
- **The workflow trusts the dispatched ref** (plus its own validate floor). The
  `release` environment starts unprotected — adding required reviewers to it is
  the sign-off mechanism, and until you do, anyone who can dispatch can
  publish.
- **`EXPO_TOKEN` validity is only proven by a real dispatch** — the degrade
  path proves absence handling, not token freshness.
