#!/usr/bin/env bash
# scripts/ci/device-smoke.sh — the maestro-smoke emulator script.
# Lives in a FILE because reactivecircus/android-emulator-runner executes its
# `script:` input with /usr/bin/sh (dash on ubuntu), which rejects
# `set -o pipefail` — proven by the first dispatch (exit 2 on line 1). A file
# invoked as `bash <path>` gets real bash strictness; cwd stays the action's
# working-directory (.selftest/app).
set -euo pipefail
appid="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("tools/identity.lock.json","utf8")).appIdentifier)')"

# ---- RELEASE half: per-route flows + the generated route sweep ----
adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
node tools/check-e2e-device.mjs --phase flows --out-dir artifacts/maestro/flows
node tools/check-e2e-device.mjs --phase sweep --out-dir artifacts/maestro/sweep

# ---- DEV half: Metro-served debug build ----
adb uninstall "$appid"
adb install apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
# The device reaches the host over loopback via adb reverse: :3000 is the web app
# that hosts /api/trpc, and :54321 is the Supabase local stack (auth/GoTrue +
# PostgREST) the mobile client authenticates against.
adb reverse tcp:3000 tcp:3000
adb reverse tcp:54321 tcp:54321
# Metro must run in WATCH mode: Canaries 19/20 edit source on the runner and
# assert the DEVICE sees it, and Metro under CI=true disables the file watcher
# outright ("Metro is running in CI mode, reloads are disabled" — dispatch #6,
# where the C19 device sweep passed against the stale clean bundle and the
# canary correctly called the lane decoration). GitHub exports CI=true
# job-wide, so strip it (and GITHUB_ACTIONS, which ci-info also matches) for
# the Metro process alone; watch mode over a pnpm monorepo needs inotify
# headroom the runner default may not have.
sudo sysctl -q fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=1024 || true
env -u CI -u GITHUB_ACTIONS \
  EXPO_PUBLIC_WEB_ORIGIN=http://127.0.0.1:3000 \
  EXPO_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE="$NEXT_PUBLIC_SUPABASE_PUBLISHABLE" \
  pnpm --filter mobile exec expo start --port 8081 < /dev/null > /tmp/metro.log 2>&1 &
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:8081/status" > /dev/null; then break; fi
  sleep 2
done
# Prewarm the REAL bundle URL, fail-loud: debug builds request the Expo virtual
# entry — /index.bundle 404s on this SDK (dispatch #6 log; re-proven against a
# local Metro). This same URL is the canaries' premise probe below, so a dead
# URL here would make those asserts vacuous — no `|| true`.
bundle_url="http://127.0.0.1:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true"
curl -fsS -m 600 "$bundle_url" -o /dev/null

# ASSERT (never assume) the edit-reaches-device premise: poll the Metro-served
# bundle until the injected marker is present — or gone again after a revert.
# Curl to a file, then grep: `curl | grep -q` under pipefail turns an early
# grep match into a curl SIGPIPE failure and the condition lies.
await_bundle() { # <present|absent> <marker> <leg>
  mode="$1"; marker="$2"; leg="$3"
  for _ in $(seq 1 30); do
    if curl -fsS -m 120 -o /tmp/bundle-probe.js "$bundle_url"; then
      case "$mode" in
        present) if grep -q "$marker" /tmp/bundle-probe.js; then return 0; fi ;;
        absent) if ! grep -q "$marker" /tmp/bundle-probe.js; then return 0; fi ;;
      esac
    fi
    sleep 2
  done
  echo "::error::${leg}: the served bundle never went ${mode} for marker '${marker}' — the edit-reaches-device premise broke (watch mode dead? see /tmp/metro.log)"
  return 1
}

# i18n/RTL: pre-seed the kv store BEFORE launch (locale ar-XB + theme
# light) via run-as on the debuggable build — never an in-run switch.
sqlite3 /tmp/kv-seed.db "CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT); INSERT INTO storage VALUES ('locale','ar-XB'),('theme','light');"
adb push /tmp/kv-seed.db /data/local/tmp/kv-seed.db
adb shell run-as "$appid" mkdir -p files/SQLite
adb shell run-as "$appid" cp /data/local/tmp/kv-seed.db files/SQLite/ExpoSQLiteStorage
node tools/check-e2e-device.mjs --phase journey --file maestro/journeys/i18n-rtl.yaml --out-dir artifacts/maestro/i18n

# The mutation flow: stub sign-in -> create -> relaunch -> persists.
node tools/check-e2e-device.mjs --phase journey --file maestro/journeys/mutation.yaml --out-dir artifacts/maestro/mutation

# Baseline perf marker: green before the canary may claim red means anything.
node tools/check-e2e-device.mjs --phase perf-harness --out-dir artifacts/maestro/perf

# Canary 19: a broken route-surface testID → the device sweep must FAIL while the agent-time jest lane stays GREEN
# (lives inside this script because it needs the RUNNING emulator; the line
# above is the registry-greppable leg title — tests/canary/injections.json.)
# The dev build re-fetches its bundle from Metro on every launch, so a
# source edit reaches the DEVICE on the next flow launch — no rebuild.
node -e '
  const fs = require("node:fs");
  const f = "apps/mobile/app/(tabs)/index.tsx";
  let s = fs.readFileSync(f, "utf8");
  if (!s.includes("testID=\"home-screen\"")) { console.error("::error::canary injection did not apply — home-screen testID moved"); process.exit(1); }
  fs.writeFileSync(f, s.replace("testID=\"home-screen\"", "testID=\"home-screen-broken\""));
'
await_bundle present 'home-screen-broken' 'CANARY 19'
# Half one: the agent-time chain is BLIND to this (no jest test asserts
# the home container id) — that blindness is the honest loss the device
# lane exists to cover, asserted, not assumed.
if ! env -u GITHUB_BASE_REF node tools/check-e2e.mjs > c19-jest.log 2>&1; then
  cat c19-jest.log
  echo '::error::CANARY 19: the jest fast lane reddened on a device-only testID break — the blindness this canary proves no longer exists; re-scope it'
  exit 1
fi
# Half two: the device sweep must catch it.
if node tools/check-e2e-device.mjs --phase sweep --out-dir artifacts/maestro/c19 > c19-device.log 2>&1; then
  cat c19-device.log
  echo '::error::CANARY 19: the device sweep PASSED with a broken home-screen testID — the Maestro lane cannot fail, so it is decoration'
  exit 1
fi
if ! grep -Eq 'home-screen|FAILED' c19-device.log; then
  cat c19-device.log
  echo '::error::CANARY 19: the sweep reddened WITHOUT naming the broken surface — wrong failure path (log above)'
  exit 1
fi
git checkout -q -- 'apps/mobile/app/(tabs)/index.tsx'
await_bundle absent 'home-screen-broken' 'CANARY 19 (revert)'
echo 'canary OK: jest lane green, device sweep red — the on-device floor is real'

# Canary 20: a 300ms busy-loop on the actions ranking path → the perf-harness marker must go RED
# (same in-script placement as Canary 19: the emulator must be running.)
node -e '
  const fs = require("node:fs");
  const f = "apps/mobile/src/features/actions/fuzzyScore.ts";
  let s = fs.readFileSync(f, "utf8");
  const anchor = "  if (query === \x27\x27) return commands";
  if (!s.includes(anchor)) { console.error("::error::canary injection did not apply — rankCommands moved"); process.exit(1); }
  s = s.replace(anchor, "  const blockUntil = globalThis.performance.now() + 300\n  while (globalThis.performance.now() < blockUntil) {\n    // selftest perf canary: stall the ranking path 300ms per call\n  }\n" + anchor);
  fs.writeFileSync(f, s);
'
# `blockUntil` (an identifier, not the comment — Babel strips comments) is the
# marker; dev bundles are unminified so it survives verbatim.
await_bundle present 'blockUntil' 'CANARY 20'
if node tools/check-e2e-device.mjs --phase perf-harness --out-dir artifacts/maestro/c20 > c20.log 2>&1; then
  cat c20.log
  echo '::error::CANARY 20: the perf marker PASSED with a 300ms stall on every ranking call — the interaction floor cannot fail, so it is decoration'
  exit 1
fi
grep -E 'perf-pass|FAILED|Assertion' c20.log | tail -n 5 || true
git checkout -q -- apps/mobile/src/features/actions/fuzzyScore.ts
await_bundle absent 'blockUntil' 'CANARY 20 (revert)'
# Restore sanity: the marker is green again on clean source.
node tools/check-e2e-device.mjs --phase perf-harness --out-dir artifacts/maestro/perf-restored
echo 'canary OK: the perf marker went red under the stall and green again after the revert'
