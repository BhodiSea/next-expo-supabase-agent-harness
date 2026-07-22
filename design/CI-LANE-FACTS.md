# CI-LANE-FACTS — verified facts the device/e2e CI lanes are written against

Verified 2026-07-18 (web research against official sources; not model memory).
Companion to EXPO-FACTS.md. Re-verify on Maestro/action major bumps.

## Maestro CLI

- Current: **cli-2.6.1** (~monthly cadence). Java **17+** required (ubuntu-24.04
  runners preinstall Temurin 17 — free on Linux).
- **No official setup GitHub Action** for local runs (the official action is
  Cloud-only and needs an API key). Hardened install for our SHA-pinned CI:
  download the pinned release zip directly and verify —
  `https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.6.1/maestro.zip`,
  sha256 `3440825f514f537c6a96bcf5de995780c2a4a7f83a43208fdc95d4f1fecfad3b`
  (each release ships `checksums_sha256.txt`; the official install script does
  NOT verify checksums — never use it in CI).
- Flag churn: `--android-api-level`/`--ios-version`/`--os-version` are
  deprecated → use **`--device-os` / `--device-model`** from day one. JS in
  flows runs on GraalJS (Rhino removed in 2.6.0). No flow-YAML schema break.

## Android emulator lane (ubuntu)

- **reactivecircus/android-emulator-runner** is standard; pin
  `@a421e43855164a8197daf9d8d40fe71c6996bb0d # v2.38.0`.
- KVM udev step still required on GH-hosted ubuntu:
  `echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules`
  then `sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm`.
- Image choice: `arch: x86_64` always. **ATD images cap at API 33** — use
  `api-level: 33, target: aosp_atd` for the fastest lane, or `api-level: 34/35,
  target: google_apis` for current-API coverage. AVD caching per the action
  README (`~/.android/avd/*` + `~/.android/adb*`, snapshot on miss,
  `-no-snapshot-save` on runs).

## Credential-free Expo build + Maestro

- Recipe (community-standard; Expo's own E2E docs are EAS-only):
  `npx expo prebuild -p android` → `./gradlew assembleDebug|assembleRelease` →
  install APK on emulator → `maestro test flows/`. A **built binary, not Expo
  Go**, is the reliable CI path (Expo Go needs openLink dev-URLs and can't
  launchApp by appId).
- **New Architecture caveat (affects component authoring, not just CI):**
  Fabric view flattening can detach `testID`s on nested plain `View`s — put
  `testID` on interactive/accessible LEAF elements; never rely on a deep
  testID inside an unstyled wrapper View. (RN #49857, Maestro #2202.)

## iOS simulator lane (macOS, nightly)

- Runner images: `macos-15` (default Xcode 16.4) and `macos-26` (default Xcode
  26.5). **Pin the explicit label** — the `macos-latest` 15→26 migration is
  completing mid-July 2026. RN 0.86 needs Xcode ≥ 16.1 (both fine).
- Build: `npx expo prebuild -p ios` (runs pod install on macOS) →
  `xcodebuild -workspace ios/<App>.xcworkspace -scheme <App> -configuration
  Release -sdk iphonesimulator -derivedDataPath build CODE_SIGNING_ALLOWED=NO`
  — no signing identity needed.
- Maestro drives simulators via its own bundled XCTest driver (no manual
  runner install); fine on Apple-Silicon runners. Historically flakier than
  Android — keep this lane nightly with a retry.

## Toolchain + perf probes

- **JDK 17** for RN 0.86 (official support matrix; "you may encounter problems
  using higher JDK versions"). `actions/setup-java` temurin 17 +
  `gradle/actions/setup-gradle` caching.
- assembleDebug wall-time on a 4-core ubuntu runner: roughly 10–20 min cold,
  5–10 min warm-cache (LOW confidence — measure on the real repo before
  deciding PR vs nightly placement; treat cold builds as nightly until then).
- Cold-start timing: `adb shell am force-stop <pkg>` then
  `adb shell am start -W -n <pkg>/.MainActivity` → `TotalTime` (≈ logcat
  `Displayed` TTID). TTFD: app calls `reportFullyDrawn()`; extract via
  `adb logcat -d | grep "Fully drawn"` (`Fully drawn <pkg>/...: +1s54ms`).
