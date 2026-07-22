# Module: device-e2e

The DEEP on-device lane. The base `quality-gate.yml` mobile-e2e job stays the fast
device lane — one emulator image (api-33 `aosp_atd`), the release sweeps at one
font-scale point, and the RTL journey on the *debug* binary. This module adds a
nightly matrix that walks the **release** binary — minified Hermes bytecode, the
build where New-Architecture view flattening actually detaches careless testIDs —
across the claims the fast lane cannot afford per PR:

| Leg | Image | What runs |
| --- | --- | --- |
| api-33 | `aosp_atd` (root-capable AOSP; the base lane's image family) | route flows + generated sweep, **RTL journey against the release binary**, **cold-start measurement** enforced against `tools/startup-budget.json` |
| api-34 | `google_apis` | route flows + generated sweep, **font-scale sweep at 1.3 and the 200% maximum** |
| api-35 | `google_apis` | same as api-34, one OS vintage ahead |

The release APK is built **once** (a `build` job: `expo prebuild` +
`gradlew assembleRelease`, no store credentials of any kind) and every leg installs
the same artifact — one binary, three OS vintages, so a testID that survives api-33
but detaches on api-35 is a red with a name on it.

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/device-e2e.yml` | the nightly/dispatch matrix lane (build once + three emulator legs) |

That is deliberately the whole module. Every check it runs is a base-harness tool
driven against a different binary and a wider matrix — `tools/check-e2e-device.mjs`
(flows / sweep / journey phases), `tools/measure-startup.mjs`,
`tools/check-mobile-perf.mjs`, the committed `maestro/flows/*.yaml`, and
`maestro/journeys/i18n-rtl.yaml` — so there is no second test surface to drift from
the first. A route added to `apps/mobile/src/routes.ts` is swept by this lane on its
next run with zero edits here.

## Prerequisites

- GitHub-hosted `ubuntu-latest` runners (KVM-capable; the workflow installs the udev
  rule itself). Roughly 2–3 emulator-hours per night across the matrix.
- A stock base install: the lane reads `apps/mobile/src/routes.ts`,
  `tools/identity.lock.json`, `tools/startup-budget.json`, `maestro/flows/`, and
  `maestro/journeys/i18n-rtl.yaml` exactly where `init` put them.
- **No credentials.** No EAS, Apple, or Google secret is read anywhere in this
  workflow; the release build is unsigned `assembleRelease` output installed
  straight onto emulators.

## How enabling works

```
npx next-expo-supabase-agent-harness enable device-e2e
```

copies the workflow and records it in `.harness/manifest.json`. It is live
immediately (nightly cron + `workflow_dispatch`) — the workflow IS the gate; no
`tools/harness.config.mjs` change. `disable device-e2e` removes it again.

## How each leg seeds and measures (the two non-obvious moves)

- **RTL on a release binary.** The app boots into `ar-XB` only from a stored kv
  preference (pseudo-locales are never negotiated from the device locale — by
  design, see `apps/mobile/src/i18n/index.ts`), and a release build is not debuggable, so the
  base lane's `run-as` seeding path does not exist. The api-33 leg uses `adb root`
  instead — documented as available on AOSP emulator images (Play-store images are
  release-key-signed and refuse it) — and overwrites the kv database's *bytes
  through its existing inode* (`cat >`), never creating the file as root: the
  flows/sweep phases have already booted the app, so the file exists with the app's
  own ownership and SELinux label, and the workflow reds loudly if it does not.
- **Cold-start budgets on release.** `tools/measure-startup.mjs` cold-starts every
  `ROUTES` entry on the api-33 leg (after `pm clear`, so the RTL seed never rides
  into a measured boot) and `HARNESS_PERF_LANE=1 node tools/check-mobile-perf.mjs`
  enforces `tools/startup-budget.json`, failing closed if the artifact is missing.
  Measurement is confined to the api-33 `aosp_atd` leg on purpose: that is the image
  family the base perf-lane measures on — the numbers the budget doctrine says to
  ratchet from — and wall clock from a different image would compare apples to a
  slower orchard. The 34/35 legs are functional coverage, not timers.

## How this lane can FAIL (anti-vacuity)

- **flows / sweep**: remove a screen container's `testID` (or break its route's
  registration) → every leg reds on that route. A regression that only appears
  under minification reds here while the base jest lane stays green — that is the
  class this module exists for.
- **font-scale sweep**: give a route surface a fixed-height container that clips at
  200% → the api-34/35 legs red on that route's sweep step while the plain sweep
  stays green.
- **RTL journey**: delete the seed block from the workflow in a scratch branch → the
  `.*⟦.*` pseudo-locale assertion fails on the home surface, proving the journey
  really depends on the seeded `ar-XB` boot and not on luck. Break
  `initI18n()`/`allowRTL` in the app → the mirrored boot itself fails.
- **measurement**: put blocking work on the startup path (a sync call in a root
  layout module) → the api-33 leg's `check-mobile-perf` reds against the budget.
  Delete a `screens[]` row from `tools/startup-budget.json` → the closure half of
  `check-mobile-perf` reds regardless of what the measured numbers say.
- **empty run**: every phase goes through `tools/check-e2e-device.mjs`, which exits
  red when it executed zero flows — a lane that ran nothing can never read as
  device coverage.

## Honest limits

- **Nightly, not a merge gate.** A regression lands the evening before you hear
  about it. The per-PR floor is the base mobile-e2e/perf-lane pair; this matrix is
  the wider net behind it.
- **Android only.** iOS simulator coverage is a separate (macOS-runner) concern and
  is not part of this module; the verified recipe for a consumer who wants one is
  recorded in the design record (CI-LANE-FACTS, iOS simulator lane: `expo prebuild
  -p ios` + `xcodebuild ... CODE_SIGNING_ALLOWED=NO`, nightly with a retry).
- **200% only on api-34/35.** Font scaling to 200% is an Android 14+ feature; the
  api-33 leg keeps the base lane's 1.3 point via the base lane itself and does not
  duplicate it here.
- **`adb root` is emulator-only.** The RTL-under-release proof holds on AOSP
  emulator images; there is no physical-device or Play-image equivalent of this
  seeding path.
- **Wall clock is a step-function detector.** The budgets are generous absolute
  milliseconds on shared runners (see `tools/startup-budget.json`'s doctrine);
  ratchet them down from this lane's printed numbers, not up from hope.
- **Cost dial.** Nightly × (1 gradle build + 3 emulator legs) is the default; edit
  the cron to weekly or delete a matrix leg if runner budget is tight — each leg is
  an independent `include:` entry.
