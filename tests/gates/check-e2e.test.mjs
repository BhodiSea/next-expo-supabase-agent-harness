// Proofs for the e2e gate (template/base/tools/check-e2e.mjs) — the jest-expo fast lane.
// The SRC (playwright) suite proved only the skip asymmetry + stamp; here the mechanics
// differ and MORE is provable without a real runner: the gate spawns
// `pnpm --filter mobile exec jest --silent` through the shell, so a fake `pnpm` shim
// earlier on PATH (sh + .cmd twins — the selftest matrix runs this file on
// windows-latest) prints a canned `Tests: … N passed` summary and exits with a chosen
// code, driving every leg for real:
//   exit 0 + passes → green; exit 1 → red with the output tail; exit 0 + `Tests: 0
//   total` → red naming the vacuous pass (and never stamping); jest.config.js absent →
//   loud local skip / CI fail-closed; jest-expo unresolvable from apps/mobile
//   (createRequire) → same asymmetry; the CI-only lane env (LIVE_PROOF,
//   HARNESS_PERF_LANE) is STRIPPED from the child, proven by a shim that tattles.
// The resolvable-jest-expo legs plant apps/mobile/node_modules/jest-expo/package.json
// (+ index.js main) so createRequire resolves without an install. The 10-minute kill
// timer is deliberately untested — proving it means hanging the suite for 10 minutes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hashInputs } from '../../template/base/tools/lib/gate.mjs'
import { STAMP_INPUTS } from '../../template/base/tools/lib/stamp-inputs.mjs'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-e2e.mjs', import.meta.url))

/** @param {{ surface?: boolean, jestExpo?: boolean }} [opts] */
function fixture({ surface = true, jestExpo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-e2egate-'))
  // Resolution boundary: a package.json without the dep, so createRequire can never
  // accidentally resolve a jest-expo from a parent directory.
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n')
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/package.json'), '{"name":"mobile","private":true}\n')
  if (surface) {
    writeFileSync(join(dir, 'apps/mobile/jest.config.js'), "module.exports = { preset: 'jest-expo' }\n")
  }
  if (jestExpo) {
    const pkg = join(dir, 'apps/mobile/node_modules/jest-expo')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'jest-expo', version: '0.0.0', main: 'index.js' }),
    )
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {}\n')
  }
  return dir
}

// A fake `pnpm` on PATH standing in for `pnpm --filter mobile exec jest --silent`:
// prints the given summary lines, tattles if a stripped lane variable leaked through,
// and exits with the chosen code. Written BOTH ways so cmd.exe finds pnpm.cmd on
// Windows while sh finds the extension-less shim everywhere else.
function fakePnpm(dir, { summary, exit = 0 }) {
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  const sh = [
    '#!/bin/sh',
    'if [ -n "$LIVE_PROOF$HARNESS_PERF_LANE$HARNESS_INTEGRATION_LANE" ]; then echo LANE_ENV_LEAKED; fi',
    ...summary.map((line) => `echo "${line}"`),
    `exit ${exit}`,
    '',
  ].join('\n')
  writeFileSync(join(bin, 'pnpm'), sh)
  chmodSync(join(bin, 'pnpm'), 0o755)
  const cmd = [
    '@echo off',
    'if defined LIVE_PROOF echo LANE_ENV_LEAKED',
    'if defined HARNESS_PERF_LANE echo LANE_ENV_LEAKED',
    'if defined HARNESS_INTEGRATION_LANE echo LANE_ENV_LEAKED',
    ...summary.map((line) => `echo ${line}`),
    `exit /b ${exit}`,
    '',
  ].join('\r\n')
  writeFileSync(join(bin, 'pnpm.cmd'), cmd)
  return bin
}

const GREEN_SUMMARY = ['Test Suites: 3 passed, 3 total', 'Tests:       12 passed, 12 total', 'Time:        2.5 s']

// Windows names the variable Path; override THAT key or the child gets two PATHs.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/** @param {string} dir @param {{ ci?: boolean, bin?: string, extraEnv?: Record<string, string> }} [opts] */
function runGate(dir, { ci = false, bin, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  delete env.NODE_PATH
  if (ci) env.CI = 'true'
  if (bin !== undefined) env[PATH_KEY] = `${bin}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// Write the exact digest a green run would record, so a warm run short-circuits WITHOUT
// any runner: hashInputs is cwd-relative, so compute it from inside the fixture.
function seedStamp(dir) {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/e2e.ok'), hashInputs(STAMP_INPUTS.e2e))
  } finally {
    process.chdir(prev)
  }
}

test('SKIP locally: surface present but jest-expo unresolvable → exit 0, loud skip naming the install', () => {
  const r = runGate(fixture(), { ci: false })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(r.out.includes('jest-expo not resolvable'), r.out)
  assert.ok(r.out.includes('pnpm install'), r.out)
})

test('FAIL CLOSED in CI: the same fixture exits non-zero with CI=true', () => {
  const r = runGate(fixture(), { ci: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FAIL'), r.out)
})

test('no e2e surface at all: loud local skip naming apps/mobile/jest.config.js; CI fail-closed', () => {
  const local = runGate(fixture({ surface: false }), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('no mobile e2e surface'), local.out)
  assert.ok(local.out.includes('apps/mobile/jest.config.js not found'), local.out)
  const ci = runGate(fixture({ surface: false }), { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

test('GREEN: exit-0 jest with passing tests — counted from the `Tests:` summary; lane env stripped', () => {
  const dir = fixture({ jestExpo: true })
  const bin = fakePnpm(dir, { summary: GREEN_SUMMARY })
  const r = runGate(dir, {
    bin,
    // The gate must strip the CI-only lane env before spawning; the shim tattles if not.
    extraEnv: { LIVE_PROOF: '1', HARNESS_PERF_LANE: '1', HARNESS_INTEGRATION_LANE: '1' },
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('12 RN test(s) green'), r.out)
  assert.ok(!r.out.includes('LANE_ENV_LEAKED'), r.out)
  assert.ok(existsSync(join(dir, '.harness/e2e.ok')), 'a green run must record the stamp')
})

test('RED: a failing jest run reds naming the exit code, with the output tail surfaced', () => {
  const dir = fixture({ jestExpo: true })
  const bin = fakePnpm(dir, {
    summary: [
      'FAIL __tests__/home.test.tsx',
      'Test Suites: 1 failed, 2 passed, 3 total',
      'Tests:       1 failed, 11 passed, 12 total',
    ],
    exit: 1,
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('jest failed (exit 1)'), r.out)
  assert.ok(r.out.includes('FAIL __tests__/home.test.tsx'), r.out) // the tail is the debug surface
  assert.ok(!existsSync(join(dir, '.harness/e2e.ok')), 'a red run must never stamp')
})

test('RED anti-vacuity: exit 0 with `Tests: 0 total` names the vacuous pass and never stamps', () => {
  const dir = fixture({ jestExpo: true })
  const bin = fakePnpm(dir, {
    summary: ['Test Suites: 0 total', 'Tests:       0 total', 'Time: 0.4 s'],
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('vacuous pass'), r.out)
  assert.ok(!existsSync(join(dir, '.harness/e2e.ok')), 'a vacuous run must never stamp')
})

test('RED anti-vacuity: suites can pass while every test is skipped — `Tests: 0 passed` still reds', () => {
  const dir = fixture({ jestExpo: true })
  const bin = fakePnpm(dir, {
    summary: ['Test Suites: 3 passed, 3 total', 'Tests:       0 passed, 12 skipped, 12 total'],
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('vacuous pass'), r.out)
})

// ── content-addressed stamp: the warm-path win ────────────────────────────────
test('warm re-run: a matching stamp reports inputs-unchanged before resolving/spawning jest', () => {
  const dir = fixture() // surface present, but NO jest-expo and NO shim at all
  seedStamp(dir)
  const r = runGate(dir, { ci: false })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('inputs unchanged'), r.out)
  // Proof it short-circuited BEFORE preset resolution: this fixture would otherwise
  // SKIP loudly with 'jest-expo not resolvable'.
  assert.ok(!r.out.includes('not resolvable'), r.out)
})

test('CI=true ignores a present stamp and fails closed on the missing preset', () => {
  const dir = fixture()
  seedStamp(dir)
  const r = runGate(dir, { ci: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FAIL'), r.out)
  assert.ok(!r.out.includes('inputs unchanged'), r.out)
})

test('green run stamps, then the warm re-run skips WITHOUT the pnpm shim on PATH', () => {
  const dir = fixture({ jestExpo: true })
  const bin = fakePnpm(dir, { summary: GREEN_SUMMARY })
  const cold = runGate(dir, { bin })
  assert.equal(cold.code, 0, cold.out)
  // Warm re-run with no shim: the stamp short-circuits before any spawn, so the absent
  // shim is never reached — proof jest was not run.
  const warm = runGate(dir, { ci: false })
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes('inputs unchanged'), warm.out)
})
