#!/usr/bin/env bash
# tools/ci/device-e2e-matrix.sh — the device-e2e module's emulator script.
# A FILE, not an inline `script:` input: reactivecircus/android-emulator-runner
# executes its script input with /usr/bin/sh (dash on ubuntu), which rejects
# `set -o pipefail` (proven live in the harness selftest's first emulator
# dispatch). Invoked as `bash tools/ci/device-e2e-matrix.sh`.
set -euo pipefail

adb install -r apk/app-release.apk

# Committed per-route flows, then the generated route sweep — the
# minified-Hermes testID-survival floor on THIS image. The runner
# itself is anti-vacuous: a phase that executed zero flows exits red.
node tools/check-e2e-device.mjs --phase flows --out-dir artifacts/device-e2e/flows
node tools/check-e2e-device.mjs --phase sweep --out-dir artifacts/device-e2e/sweep

# Font-scale sweep (api-34/35 legs): re-run the sweep under each OS
# text scale, 200% included — Android 14+'s own guidance is to UI-test
# at that maximum. A layout that clips or overflows loses its asserted
# leaves, and the sweep reds on the exact route that lost one.
# SOURCE: https://developer.android.com/about/versions/14/features (test at 200% font scale)
for scale in $FONT_SCALES; do
  adb shell "settings put system font_scale ${scale}"
  node tools/check-e2e-device.mjs --phase sweep --out-dir "artifacts/device-e2e/sweep-font-scale-${scale}"
done
if [ -n "$FONT_SCALES" ]; then adb shell "settings put system font_scale 1.0"; fi

if [ "$RUN_RTL_RELEASE" = "true" ]; then
  # RTL under RELEASE: seed the kv store (locale ar-XB + theme light —
  # the same seed the base lane pushes into the DEBUG build) into the
  # release app's sandbox. A release build is not debuggable, so there
  # is no run-as; the seed rides `adb root` instead, which is available
  # on AOSP emulator images like this leg's aosp_atd (Play-store images
  # are release-key-signed and refuse elevated privileges).
  # SOURCE: https://developer.android.com/studio/run/managing-avds (AOSP images allow adb root/unroot)
  sqlite3 /tmp/kv-seed.db "CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT); INSERT INTO storage VALUES ('locale','ar-XB'),('theme','light');"
  adb shell "am force-stop {{APP_IDENTIFIER}}"
  adb root
  adb wait-for-device
  # The flows/sweep phases above already booted the app, so its kv
  # database exists with the app's own ownership and SELinux label.
  # Overwrite the BYTES through the existing inode (cat >) — a file
  # CREATED by root in the app sandbox would be unreadable to the app,
  # so an absent kv store must red here, loudly, not seed-and-pretend.
  KV="/data/data/{{APP_IDENTIFIER}}/files/SQLite/ExpoSQLiteStorage"
  adb shell "test -f ${KV}" || { echo "::error::${KV} missing — the app never created its kv store, so the RTL seed has nothing to overwrite"; exit 1; }
  adb push /tmp/kv-seed.db /data/local/tmp/kv-seed.db
  adb shell "rm -f ${KV}-wal ${KV}-shm && cat /data/local/tmp/kv-seed.db > ${KV}"
  adb unroot
  adb wait-for-device
  # Same journey YAML as the base lane — the assertions (every surface
  # mounts under an RTL boot, pseudo-locale copy actually on screen)
  # are unchanged; what changed is the binary making them true.
  node tools/check-e2e-device.mjs --phase journey --file maestro/journeys/i18n-rtl.yaml --out-dir artifacts/device-e2e/rtl-release
fi

if [ "$RUN_MEASURE" = "true" ]; then
  # Cold-start measurement on the release APK — this leg's image family
  # is the one the base perf-lane measures on (the numbers
  # tools/startup-budget.json's doctrine ratchets from), so the caps
  # judge like-for-like wall clock. `pm clear` ("delete all data
  # associated with a package") first: the RTL seed above must not ride
  # into the measured boots, and a cleared app matches the base
  # perf-lane's fresh-install measurement state.
  # SOURCE: https://developer.android.com/tools/adb (pm clear)
  adb shell "pm clear {{APP_IDENTIFIER}}"
  HARNESS_PERF_LANE=1 node tools/measure-startup.mjs
  HARNESS_PERF_LANE=1 node tools/check-mobile-perf.mjs
fi
