#!/usr/bin/env node
// tools/measure-startup.mjs — the MEASUREMENT half of the mobile-perf floor: cold-start
// every ROUTES entry on the lane emulator and write artifacts/perf-results.json, the
// artifact `HARNESS_PERF_LANE=1 node tools/check-mobile-perf.mjs` enforces against
// tools/startup-budget.json. This script MEASURES and RECORDS; the gate JUDGES — the
// split keeps the budget arithmetic (and its fail-closed rules) in exactly one place.
//
// Per route, COLD_RUNS true cold starts: `adb shell am force-stop <appId>` (a real
// cold start, not a resume), `adb logcat -c` (so a Fully-drawn line can only come
// from THIS start), then
// `adb shell am start -W -a android.intent.action.VIEW -d <scheme>://<path> <appId>` —
// the -W TotalTime is approximately the logcat Displayed TTID (design record:
// CI-LANE-FACTS). totalTimeMs is the MEDIAN of the cold runs (0.1.2 — a single
// emulator start on a shared runner is one scheduler roll; three rolls make the
// step-function detector honest without meaningfully lengthening the lane), and
// coldSamplesMs records every roll. fullyDrawnMs is recorded only when the app
// actually called reportFullyDrawn() (`adb logcat -d` → "Fully drawn <appId>/…:
// +1s54ms"). HONEST LIMIT: the managed scaffold CANNOT call reportFullyDrawn() —
// no RN core or Expo SDK module binds Activity.reportFullyDrawn, and injecting
// native source would break CNG purity — so fullyDrawnMs stays absent here by
// construction; the parse stays armed for consumers that add a native binding,
// and check-mobile-perf enforces a fullyDrawn cap only for rows that declare one.
//
// After the cold runs, ONE warm start (0.1.2): HOME (keyevent 3, so the process
// survives but the activity leaves the foreground) then the same `am start -W`.
// A warm/hot launch does not always print TotalTime (a delivery to the existing
// top activity reports only WaitTime) — when it does not, warmTotalTimeMs is
// simply omitted and the lane notes it: check-mobile-perf reds a declared
// maxWarmTotalTimeMs with no reported number (the maxFullyDrawnMs convention),
// and rows that never declare one lose nothing.
// SOURCE: https://developer.android.com/topic/performance/vitals/launch-time (am start -W / TTID / warm-hot launch states / reportFullyDrawn)
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { fail, MAX_BUFFER, ok, skipOrFail } from './lib/gate.mjs'
import { deepLink, parseRoutes, readAppIdentity } from './lib/mobile-app-meta.mjs'

const GATE = 'measure-startup'
const ROUTES_FILE = 'apps/mobile/src/routes.ts'
const IDENTITY_LOCK = 'tools/identity.lock.json'
const RESULTS = 'artifacts/perf-results.json'
// The launch itself is bounded by -W; this bounds a wedged adb.
const ADB_TIMEOUT_MS = 3 * 60 * 1000
// Median-of-3: enough rolls to shrug one scheduler spike, cheap enough that the
// lane's wall clock stays dominated by the emulator boot, not the measurement.
const COLD_RUNS = 3

const quoted = (s) => JSON.stringify(String(s))
function sh(command) {
  return spawnSync(command, {
    shell: true, // adb resolves as adb.exe everywhere, but the test suite's stub is a .cmd shim on Windows
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: ADB_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
}

function adbOrDie(command, context) {
  const res = sh(command)
  if (res.error !== undefined || res.status !== 0) {
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    console.error(out.split('\n').slice(-30).join('\n'))
    fail(
      GATE,
      `${context}: \`${command}\` failed — no device answer means no measurement, and an unmeasured lane must red, never skip`,
    )
  }
  return res.stdout ?? ''
}

/** "Fully drawn <pkg>/...: +1s54ms" -> 1054 (ms); null when the app never reported. */
export function parseFullyDrawnMs(logcat, appId) {
  const line = logcat
    .split('\n')
    .reverse()
    .find((l) => l.includes('Fully drawn') && l.includes(appId))
  if (line === undefined) return null
  const m = line.match(/\+(?:(\d+)s)?(\d+)ms/)
  if (m === null) return null
  return Number(m[1] ?? '0') * 1000 + Number(m[2])
}

/** The -W block's "TotalTime: <ms>" — the cold-start number the budgets cap. */
export function parseTotalTimeMs(amOutput) {
  const m = amOutput.match(/^TotalTime:\s*(\d+)\s*$/m)
  return m === null ? null : Number(m[1])
}

// Import-safe: the parsers above are unit-tested by importing this module; the
// measurement run only starts when invoked as a script.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (invokedDirectly) {
  let routes
  let identity
  try {
    routes = parseRoutes(ROUTES_FILE)
    identity = readAppIdentity(IDENTITY_LOCK)
  } catch (e) {
    fail(GATE, e instanceof Error ? e.message : String(e))
  }

  const probe = sh('adb get-state')
  if (probe.error !== undefined || probe.status !== 0 || !(probe.stdout ?? '').includes('device')) {
    skipOrFail(GATE, 'no adb device answers — the startup measurement needs the lane emulator')
  }

  /** @type {Record<string, { totalTimeMs: number, coldSamplesMs: number[], warmTotalTimeMs?: number, fullyDrawnMs?: number }>} */
  const screens = {}
  const settleMs = Number(process.env.HARNESS_SETTLE_MS ?? '') || 2000
  const settle = () => {
    // A short settle so a reportFullyDrawn() fired just after the -W return still
    // lands (HARNESS_SETTLE_MS trims it in the stub-adb test harness).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleMs)
  }
  for (const route of routes) {
    const uri = deepLink(identity.scheme, route.path)
    const startCmd = `adb shell am start -W -a android.intent.action.VIEW -d ${quoted(uri)} ${quoted(identity.appId)}`
    const coldSamplesMs = []
    let fullyDrawnMs = null
    for (let run = 0; run < COLD_RUNS; run += 1) {
      adbOrDie(`adb shell am force-stop ${quoted(identity.appId)}`, route.id)
      adbOrDie('adb logcat -c', route.id)
      const out = adbOrDie(startCmd, route.id)
      const sampleMs = parseTotalTimeMs(out)
      if (sampleMs === null) {
        console.error(out.split('\n').slice(-20).join('\n'))
        fail(
          GATE,
          `route '${route.id}' (cold run ${String(run + 1)}/${String(COLD_RUNS)}): \`am start -W\` printed no TotalTime — the launch did not complete (wrong appId? unresolved deep link ${uri}?), so this screen is UNMEASURED and the lane must red`,
        )
      }
      coldSamplesMs.push(sampleMs)
      settle()
      // Each run clears logcat, so the LAST run's Fully-drawn line (when the app
      // ever gains a native reportFullyDrawn binding) is unambiguous.
      fullyDrawnMs = parseFullyDrawnMs(sh('adb logcat -d').stdout ?? '', identity.appId)
    }
    const totalTimeMs = [...coldSamplesMs].sort((a, b) => a - b)[Math.floor(COLD_RUNS / 2)]

    // The warm split: process alive (no force-stop), activity backgrounded via
    // HOME, then the same launch. TotalTime is not guaranteed on a warm/hot
    // delivery — absence is recorded as absence, never invented.
    adbOrDie('adb shell input keyevent 3', route.id)
    const warmOut = adbOrDie(startCmd, route.id)
    const warmTotalTimeMs = parseTotalTimeMs(warmOut)
    if (warmTotalTimeMs === null) {
      console.log(
        `${GATE}: NOTE — route '${route.id}': the warm start printed no TotalTime (delivered to the existing activity); warmTotalTimeMs omitted`,
      )
    }

    screens[route.id] = {
      totalTimeMs,
      coldSamplesMs,
      ...(warmTotalTimeMs === null ? {} : { warmTotalTimeMs }),
      ...(fullyDrawnMs === null ? {} : { fullyDrawnMs }),
    }
    console.log(
      `${GATE}: ${route.id.padEnd(16)} cold median ${String(totalTimeMs).padStart(6)}ms (${coldSamplesMs.map(String).join('/')}ms)${warmTotalTimeMs === null ? '' : `  warm ${String(warmTotalTimeMs)}ms`}${fullyDrawnMs === null ? '' : `  fully-drawn ${String(fullyDrawnMs)}ms`}`,
    )
  }

  mkdirSync(dirname(RESULTS), { recursive: true })
  writeFileSync(RESULTS, `${JSON.stringify({ screens }, null, 2)}\n`)
  ok(
    GATE,
    `${String(routes.length)} route(s) cold-started ×${String(COLD_RUNS)} (median) + 1 warm start each; wrote ${RESULTS} (enforce with: HARNESS_PERF_LANE=1 node tools/check-mobile-perf.mjs)`,
  )
}
