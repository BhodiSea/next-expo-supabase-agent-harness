#!/usr/bin/env bash
# tools/ci/device-lane.sh — the consumer mobile-e2e emulator script (flows, sweeps, journeys, dev half)
# A FILE, not an inline `script:` input: reactivecircus/android-emulator-runner
# executes its script input with /usr/bin/sh (dash on ubuntu), which rejects
# `set -o pipefail` (proven live in the harness's own selftest dispatch).
# Invoked as `bash tools/ci/device-lane.sh` so bash strictness is real.
set -euo pipefail

# ---- RELEASE half: route flows, generated sweep, theme + font-scale sweeps ----
adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
node tools/check-e2e-device.mjs --phase flows --out-dir artifacts/maestro/flows
node tools/check-e2e-device.mjs --phase sweep --out-dir artifacts/maestro/sweep
# Theme sweep: flip the OS scheme — the theme store's default `system`
# preference tracks Appearance live, so every surface must survive both.
adb shell cmd uimode night no
node tools/check-e2e-device.mjs --phase sweep --out-dir artifacts/maestro/sweep-light
adb shell cmd uimode night yes
# Font-scale sweep: the OS accessibility text scale must not detach any
# asserted surface (clipped/overflowed layouts lose their leaves).
adb shell settings put system font_scale 1.3
node tools/check-e2e-device.mjs --phase sweep --out-dir artifacts/maestro/sweep-fontscale
adb shell settings put system font_scale 1.0

# ---- DEV half: Metro-served debug build for the __DEV__-only flows ----
adb uninstall {{APP_IDENTIFIER}}
adb install apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
# 3000 = the Next app, which HOSTS the tRPC API; 54321 = the Supabase local stack the
# mobile client reaches directly for its session and its `./client` reads.
adb reverse tcp:3000 tcp:3000
adb reverse tcp:54321 tcp:54321
CI=1 pnpm --filter mobile exec expo start --port 8081 > /tmp/metro.log 2>&1 &
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:8081/status" > /dev/null; then break; fi
  sleep 2
done
# Pre-warm the bundle so the first launchApp is not a cold Metro compile.
curl -fsS -m 600 "http://127.0.0.1:8081/index.bundle?platform=android&dev=true" -o /dev/null || true

# i18n/RTL journey precondition: pre-seed the kv store BEFORE launch
# (locale ar-XB + theme light) — expo-sqlite's kv database is
# files/SQLite/ExpoSQLiteStorage with a (key,value) `storage` table,
# reachable via run-as on the debuggable build. Never an in-run
# switch: layout direction snapshots at startup.
sqlite3 /tmp/kv-seed.db "CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT); INSERT INTO storage VALUES ('locale','ar-XB'),('theme','light');"
adb push /tmp/kv-seed.db /data/local/tmp/kv-seed.db
adb shell run-as {{APP_IDENTIFIER}} mkdir -p files/SQLite
adb shell run-as {{APP_IDENTIFIER}} cp /data/local/tmp/kv-seed.db files/SQLite/ExpoSQLiteStorage
node tools/check-e2e-device.mjs --phase journey --file maestro/journeys/i18n-rtl.yaml --out-dir artifacts/maestro/i18n

# Mutation flow: REAL sign-in -> create note -> relaunch -> persists
# (clearState inside the flow resets the seeded locale first — order matters).
# The identity is minted here, against the job's Supabase stack, with its personal
# org (tools/ci/mint-device-user.mjs — admin createUser + ensure_personal_org as
# that user), and handed to Maestro as flow variables; the workflow publishes
# SUPABASE_SERVICE_ROLE_KEY for exactly this step. Fixed address, idempotent minter.
DEVICE_EMAIL="device-mutation@example.com"
DEVICE_PASSWORD="device-mutation-pw-1"
node tools/ci/mint-device-user.mjs "$DEVICE_EMAIL" "$DEVICE_PASSWORD"
node tools/check-e2e-device.mjs --phase journey --file maestro/journeys/mutation.yaml --out-dir artifacts/maestro/mutation \
  --env "DEVICE_EMAIL=$DEVICE_EMAIL" --env "DEVICE_PASSWORD=$DEVICE_PASSWORD"

# Interaction budgets: the dev perf-harness screen self-measures against
# tools/interaction-budget.json and the flow asserts its perf-pass marker.
node tools/check-e2e-device.mjs --phase perf-harness --out-dir artifacts/maestro/perf
