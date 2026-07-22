#!/usr/bin/env node
// Gate: e2e — the agent-time fast lane. Runs the WHOLE react-native suite in
// apps/mobile (jest-expo + React Native Testing Library: the states sweep over
// every ROUTES entry, screen flows, boot/layout, primitives a11y) — the shipped
// screens, expo-router navigation, api-client and error translation run for
// real against the in-process mock server. Seconds and laptop-complete, exactly
// what the quality-gate e2e job runs in CI, so an agent turn cannot end green
// while the screen suite is red. The ON-DEVICE proof (Maestro on an emulator)
// is a CI lane, deliberately not in this chain — stated honestly, see
// tools/check-mobile-perf.mjs.
//
// Runner detection is module resolution, not subprocess vibes: resolve
// jest-expo FROM apps/mobile (createRequire — under isolated installs the
// preset is only visible from the package that declares it). Resolvable → run;
// not resolvable → loud local skip with the install command; CI → fail closed.
//
// The lane must never wedge the validate chain: hard kill after TIMEOUT_MS
// (spawnSync's own kill timer — portable, no shell `timeout` needed) with a
// loud message, and the last TAIL_LINES of runner output surface on any failure
// so the red is debuggable from the gate log alone.
//
// This lane runs the RN suites ONLY: the pure suites (routes closure, i18n,
// kv, sse, fuzzy scorer…) run under the root vitest config, and jest.config.js
// testPathIgnorePatterns excludes them here in LOCKSTEP — no test ever runs
// under both runners, and this gate adds no --coverage (the Stop chain's
// mobile-unit step owns the coverage run; doubling it here would double the
// chain's cost for the same verdict).
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
// SOURCE: https://docs.expo.dev/develop/unit-testing/ (jest-expo preset)
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fail, MAX_BUFFER, ok, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'e2e'
const TIMEOUT_MS = 10 * 60 * 1000
const TAIL_LINES = 50

if (!existsSync('apps/mobile/jest.config.js')) {
  skipOrFail(GATE, 'no mobile e2e surface (apps/mobile/jest.config.js not found)')
}

// Content-addressed local skip BEFORE the (minutes-long) jest run — and even
// before resolving the preset, so a warm unchanged run skips in ms. The stamp
// records that a full real run (the whole RN suite + the anti-vacuity check
// below) went green for these exact inputs (declared in lib/stamp-inputs.mjs);
// unchanged inputs cannot change that verdict. recordGreen() fires ONLY after
// the run passes including anti-vacuity, so a vacuous run never stamps. CI
// always re-runs (inCI).
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

try {
  const requireFromMobile = createRequire(`${process.cwd()}/apps/mobile/package.json`)
  requireFromMobile.resolve('jest-expo')
} catch {
  skipOrFail(GATE, 'jest-expo not resolvable from apps/mobile (run pnpm install)')
}

// The CI-only / opt-in lanes must never run inside the gate chain: even with
// these exported in the agent's shell, this run strips them — the device perf
// lane is wall-clock (flaky by nature), and LIVE_PROOF flips the live-API suite
// from mocked to a real server + Postgres (unavailable on a plane). The
// agent-time lane provably runs exactly the fast mocked suites, keeping the
// chain deterministic and the warm-validate promise intact.
const env = { ...process.env }
delete env.HARNESS_PERF_LANE
delete env.HARNESS_INTEGRATION_LANE
delete env.LIVE_PROOF
// jest defaults NODE_ENV=test only when UNSET; an ambient 'development' (a CI
// job hosting the dev server exports it job-wide) flips the suite into the
// empty-route-tree failure jest.config.js documents. Forced at the gate seam
// too, so this gate's verdict never depends on config-load order.
env.NODE_ENV = 'test'

const res = spawnSync('pnpm --filter mobile exec jest --silent', {
  shell: true, // pnpm is a .cmd shim on Windows; jest.config.js decides workers/reporters
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
  killSignal: 'SIGKILL',
  maxBuffer: MAX_BUFFER,
  env,
})

const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
const tail = out.split('\n').slice(-TAIL_LINES).join('\n')

if (
  res.error !== undefined &&
  /** @type {NodeJS.ErrnoException} */ (res.error).code === 'ETIMEDOUT'
) {
  console.error(tail)
  fail(
    GATE,
    `jest run KILLED after ${String(TIMEOUT_MS / 60000)} minutes — the e2e lane must never hang the gate chain (a wedged worker or watch mode; last ${String(TAIL_LINES)} lines above)`,
  )
}
if (res.status !== 0) {
  console.error(tail)
  fail(GATE, `jest failed (exit ${String(res.status)}) — last ${String(TAIL_LINES)} lines above`)
}

// Anti-vacuity: a runner that ran nothing must never read as green. Parse the
// `Tests:` summary line (not `Test Suites:` — suites can pass while every test
// inside was skipped).
const passed = Number(/^Tests:\s[^\n]*?(\d+) passed/m.exec(out)?.[1] ?? '0')
if (passed === 0) {
  console.error(tail)
  fail(GATE, 'jest exited 0 but reported no passing tests — an empty e2e run is a vacuous pass')
}
recordGreen()
ok(GATE, `${String(passed)} RN test(s) green (jest-expo fast lane, the whole apps/mobile suite)`)
