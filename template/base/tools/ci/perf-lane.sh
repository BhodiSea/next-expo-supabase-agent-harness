#!/usr/bin/env bash
# tools/ci/perf-lane.sh — the consumer perf-lane emulator script (cold starts + budget enforcement)
# A FILE, not an inline `script:` input: reactivecircus/android-emulator-runner
# executes its script input with /usr/bin/sh (dash on ubuntu), which rejects
# `set -o pipefail` (proven live in the harness's own selftest dispatch).
# Invoked as `bash tools/ci/perf-lane.sh` so bash strictness is real.
set -euo pipefail
adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
HARNESS_PERF_LANE=1 node tools/measure-startup.mjs
HARNESS_PERF_LANE=1 node tools/check-mobile-perf.mjs
