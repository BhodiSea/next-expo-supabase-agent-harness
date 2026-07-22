#!/usr/bin/env node
// Gate: mobile-perf — the shipped binary's startup cost, measured on a REAL device lane.
//
// Nothing else in this harness observes the installed app at all: the jest fast lane renders
// under Node with the network mocked, so native module init, Hermes bytecode load and the
// first-frame path are invisible to every other check. A screen could get 100x slower to
// reach and the whole gate chain and the RN suite stayed green.
//
// Two modes, because the two halves have very different costs:
//
//   --closure   Static. Every route in apps/mobile/src/routes.ts must have a Maestro flow
//               (maestro/flows/<id>.yaml) AND a budget row in tools/startup-budget.json —
//               and stale flows/rows (naming a route id the manifest no longer has) red.
//               ~10ms (it reads three files), so it runs in the STOP CHAIN: an agent cannot
//               end a turn having added a screen that no machine check will ever time. This
//               is the half that makes the gate a FLOOR rather than a note about the seed
//               screens — without it, the screen an agent adds next week is unmeasured
//               startup cost, which is exactly how the native side stays unmeasured in a
//               mocked-lane-only harness.
//
//   (default)   Closure + measurement. Reads artifacts/perf-results.json — written by the
//               CI device lane, which installs the built APK on an emulator, cold-starts
//               straight into each route (adb shell am start -W on the app's deep-link
//               scheme; TotalTime ≈ the logcat Displayed TTID) — and enforces the budgets.
//               Needs an emulator (minutes), so it lives in the CI device lane under
//               HARNESS_PERF_LANE=1, never in the turn chain: artifact absent → loud local
//               skip; artifact absent WITH the lane env set → the lane is broken, fail
//               closed (a mis-wired lane must never skip-green).
//
// Budgets are GENEROUS ABSOLUTE MILLISECONDS, not ratios — the opposite of the in-chain
// perf gates, for a stated reason: emulator wall clock on a shared runner is a step-function
// detector (a sync network call at boot, a blocking module eval), not a drift ratchet. See
// startup-budget.json for the doctrine and the ratchet-down instruction.
// SOURCE: https://developer.android.com/topic/performance/vitals/launch-time (am start -W / TTID / reportFullyDrawn)
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote } from './lib/gate.mjs'

const GATE = 'mobile-perf'
const CLOSURE_ONLY = process.argv.includes('--closure')

const ROUTES_FILE = 'apps/mobile/src/routes.ts'
const FLOWS_DIR = 'maestro/flows'
const BUDGET = 'tools/startup-budget.json'
const RESULTS = 'artifacts/perf-results.json'

// No route manifest (a project that dropped the mobile app): nothing to time. Not a
// skip-shaped hole — the route-manifest gate owns that surface's presence, and a manifest
// that exists but is empty reds THERE, so this gate cannot be disarmed by emptying it.
if (!existsSync(ROUTES_FILE))
  ok(GATE, `${ROUTES_FILE} not found (no mobile route manifest in this project)`)

if (!existsSync(BUDGET)) {
  // The budget names THIS project's screens, so `update` withholds it (seedOnInitOnly)
  // rather than planting the template's three rows into a repo with five screens of its
  // own. An upgraded install therefore has no budget, and the floor self-disables with an
  // adoption NOTE instead of ambushing the upgrade with a red turn.
  //
  // rampNote returns TRUE only while the install predates the version below. Once it is on
  // it the budget is mandatory: falling through to `ok()` here would mean an agent could
  // disarm the entire startup floor by deleting one file. (This lineage seeds the budget
  // from 0.1.0, so today no install can be pre-ramp and absence always fails — the ramp is
  // the established channel for any LATER vintage of seeded budget surface.)
  const adopt =
    `${BUDGET} absent — the installed app's startup is unmeasured. Adopt it: ` +
    '`update --refresh-seeded tools/startup-budget.json maestro/flows/`, then write one ' +
    'screens[] row per src/routes.ts id (generous maxTotalTimeMs; ratchet down from the ' +
    'device lane’s printed numbers). See docs/harness/gates-catalog.md ("mobile-perf")'
  if (rampNote(GATE, '0.1.0', adopt)) {
    ok(GATE, `${BUDGET} absent (pre-0.1.0 install; adopt it to arm the startup floor)`)
  }
  fail(
    GATE,
    `${BUDGET} is missing, so every screen's startup is unmeasured. It is ` +
      'write-guard-protected — restore it from git history, or seed one with ' +
      '`npx next-expo-supabase-agent-harness update --refresh-seeded tools/startup-budget.json`.',
  )
}

const budget = JSON.parse(readFileSync(BUDGET, 'utf8'))
const screens = budget.screens
if (screens === null || typeof screens !== 'object' || Array.isArray(screens)) {
  fail(GATE, `${BUDGET} declares no "screens" object (route id -> {maxTotalTimeMs, …})`)
}

// ---------------------------------------------------------------------------
// Closure: the route manifest, the flow directory and the budget must agree.
// ---------------------------------------------------------------------------

// The ROUTES ids, parsed the way the route-manifest gate parses them (comments
// stripped, the `export const ROUTES = [ … ] as const` literal, id fields) —
// only the id set is needed here; full entry validation is that gate's job.
const code = readFileSync(ROUTES_FILE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n')
const arr = code.match(/export const ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const/)
if (arr === null) {
  fail(
    GATE,
    `${ROUTES_FILE} has no \`export const ROUTES = [ … ] as const\` literal — the canonical route manifest is gone`,
  )
}
const ids = [...arr[1].matchAll(/\bid:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
if (ids.length === 0) {
  ok(GATE, 'ROUTES is empty (the route-manifest gate reds that) — nothing to time yet')
}

const closure = []
for (const id of ids) {
  if (!existsSync(`${FLOWS_DIR}/${id}.yaml`)) {
    closure.push(
      `${ROUTES_FILE}: route '${id}' has no Maestro flow — add ${FLOWS_DIR}/${id}.yaml (launchApp + reach the route + assertVisible its surface). ` +
        'A screen without a flow is a screen the device lane will never open.',
    )
  }
  if (screens[id] === undefined) {
    closure.push(
      `${BUDGET}: route '${id}' has no screens["${id}"] row — add one with a generous maxTotalTimeMs. ` +
        'An unbudgeted screen is startup cost no machine check will ever look at.',
    )
  } else if (typeof screens[id].maxTotalTimeMs !== 'number' || !(screens[id].maxTotalTimeMs > 0)) {
    closure.push(
      `${BUDGET}: screens["${id}"].maxTotalTimeMs must be a positive number of milliseconds — a row without an enforceable cap is a budget in name only.`,
    )
  }
}
// Inverse: a flow or budget row naming a route the manifest no longer has is
// stale data — it would keep measuring (or pretending to measure) a screen
// that does not ship. Route flows live ONLY in maestro/flows/, one per ROUTES
// id; keep hand-written non-route journeys elsewhere (e.g. maestro/journeys/).
for (const rel of walkFiles(FLOWS_DIR, { filter: (r) => /\.ya?ml$/.test(r) })) {
  const flowId = rel.replace(/\.ya?ml$/, '')
  if (!ids.includes(flowId)) {
    closure.push(
      `${FLOWS_DIR}/${rel}: no ROUTES entry has id '${flowId}' — stale flow (or a non-route journey; those live outside ${FLOWS_DIR}/).`,
    )
  }
}
for (const id of Object.keys(screens).sort()) {
  if (!ids.includes(id)) {
    closure.push(
      `${BUDGET}: screens["${id}"] names a route id that is not in ${ROUTES_FILE} — stale row (remove it).`,
    )
  }
}
failures(
  GATE,
  closure,
  `every route must have a Maestro flow (${FLOWS_DIR}/<id>.yaml) and a startup budget (${BUDGET})`,
)

if (CLOSURE_ONLY) {
  ok(
    GATE,
    `closure OK — ${String(ids.length)} route(s), each with a Maestro flow and a startup budget ` +
      '(measurement runs in the CI device lane: emulator + am start -W + `node tools/check-mobile-perf.mjs`)',
  )
}

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

// The lane env is the fail-closed trigger, NOT plain CI: the quality-gate job
// never runs measurement mode (the Stop chain runs --closure), so a bare
// CI=true must not red here — but a device lane that set HARNESS_PERF_LANE=1
// and produced no artifact is a broken lane, and a broken lane must never
// skip-green.
const IN_LANE = process.env.HARNESS_PERF_LANE === '1'
if (!existsSync(RESULTS)) {
  if (IN_LANE) {
    fail(
      GATE,
      `HARNESS_PERF_LANE=1 but ${RESULTS} is missing — the device lane ran without producing measurements; fix the lane, do not let it skip`,
    )
  }
  console.log(
    `${GATE}: SKIPPED — no ${RESULTS} (the CI device lane writes it: install the APK on an emulator, ` +
      'cold-start each route via `adb shell am start -W`, record TotalTime/fullyDrawn ms). ' +
      'This gate FAILS CLOSED when HARNESS_PERF_LANE=1 is set.',
  )
  process.exit(0)
}

let results
try {
  results = JSON.parse(readFileSync(RESULTS, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${RESULTS} is not valid JSON (${e.message}) — the device lane wrote a corrupt artifact`,
  )
}
const measured = results.screens
if (measured === null || typeof measured !== 'object' || Array.isArray(measured)) {
  fail(
    GATE,
    `${RESULTS} declares no "screens" object (route id -> {totalTimeMs, fullyDrawnMs}) — the device lane's artifact contract drifted`,
  )
}

const rows = []
const bad = []
const isMs = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

for (const [id, spec] of Object.entries(screens)) {
  const r = measured[id]
  if (r === undefined || !isMs(r.totalTimeMs)) {
    bad.push(
      `${id}: budgeted but the device lane produced no totalTimeMs — the screen was not measured. ` +
        'A budgeted subject that silently stops being measured is a gate that has quietly turned itself off.',
    )
    continue
  }
  const overTotal = r.totalTimeMs > spec.maxTotalTimeMs
  rows.push(
    `  ${id.padEnd(16)} cold-start ${String(r.totalTimeMs).padStart(7)}ms (cap ${String(spec.maxTotalTimeMs)}ms)` +
      `${isMs(r.warmTotalTimeMs) ? `  warm ${String(r.warmTotalTimeMs)}ms (cap ${String(spec.maxWarmTotalTimeMs ?? '—')}ms)` : ''}` +
      `${isMs(r.fullyDrawnMs) ? `  fully-drawn ${String(r.fullyDrawnMs)}ms (cap ${String(spec.maxFullyDrawnMs ?? '—')}ms)` : ''}` +
      `${overTotal ? '  <-- OVER' : ''}`,
  )
  if (overTotal) {
    bad.push(
      `${id}: cold-start ${String(r.totalTimeMs)}ms exceeds its ${String(spec.maxTotalTimeMs)}ms budget. The budget is generous ` +
        'wall clock on a shared emulator, so this is a step function, not noise — find the blocking work that landed on the ' +
        `startup path, or raise the cap in ${BUDGET} in a reviewed commit if it is deliberate.`,
    )
  }
  if (typeof spec.maxFullyDrawnMs === 'number') {
    if (!isMs(r.fullyDrawnMs)) {
      bad.push(
        `${id}: ${BUDGET} caps fullyDrawn (${String(spec.maxFullyDrawnMs)}ms) but the lane reported none — the app stopped calling ` +
          'reportFullyDrawn(), so the cap is enforced against nothing. Restore the call, or null the cap in a reviewed commit.',
      )
    } else if (r.fullyDrawnMs > spec.maxFullyDrawnMs) {
      bad.push(
        `${id}: fully-drawn ${String(r.fullyDrawnMs)}ms exceeds its ${String(spec.maxFullyDrawnMs)}ms budget — content readiness regressed ` +
          'even if the first frame stayed fast.',
      )
    }
  }
  // The warm split (0.1.2): enforced ONLY for rows that declare the cap — the
  // exact maxFullyDrawnMs convention, including the declared-but-unreported
  // red (a warm start does not always print TotalTime; a declared cap that
  // silently measures nothing is a gate that turned itself off).
  if (typeof spec.maxWarmTotalTimeMs === 'number') {
    if (!isMs(r.warmTotalTimeMs)) {
      bad.push(
        `${id}: ${BUDGET} caps warm starts (${String(spec.maxWarmTotalTimeMs)}ms) but the lane reported no warmTotalTimeMs — the warm launch printed no TotalTime, so the cap is enforced against nothing. Investigate the lane, or null the cap in a reviewed commit.`,
      )
    } else if (r.warmTotalTimeMs > spec.maxWarmTotalTimeMs) {
      bad.push(
        `${id}: warm start ${String(r.warmTotalTimeMs)}ms exceeds its ${String(spec.maxWarmTotalTimeMs)}ms budget — the resume path regressed (cold-start numbers cannot see it).`,
      )
    }
  }
}
for (const id of Object.keys(measured).sort()) {
  if (screens[id] === undefined) {
    bad.push(
      `${RESULTS} reports screens["${id}"] which has no ${BUDGET} row — a naming drift between the lane and the budget ` +
        '(a rename here is a measurement silently detaching from its cap).',
    )
  }
}

process.stdout.write(
  `${GATE}: measured (am start -W, ms wall clock on the lane emulator)\n${rows.join('\n')}\n`,
)
failures(GATE, bad, `startup budgets (${BUDGET})`)

ok(
  GATE,
  `${String(Object.keys(screens).length)} screen(s) within startup budget${IN_LANE ? ' (device lane: fail-closed)' : ''}`,
)
