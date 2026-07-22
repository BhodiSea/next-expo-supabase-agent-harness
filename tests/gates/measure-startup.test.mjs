// Can-fail proofs for the startup measurer (template/base/tools/measure-startup.mjs)
// — the script that turns `adb shell am start -W` output into the
// artifacts/perf-results.json contract check-mobile-perf's measurement mode enforces.
// The parsers are pinned by direct import; the end-to-end runs spawn the REAL script
// against a stub adb (sh + .cmd shims, Windows-matrix safe). The artifact SHAPE
// assertions matter most: a drift here would detach every startup budget from its
// measurement while both sides stayed individually green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseFullyDrawnMs,
  parseTotalTimeMs,
} from '../../template/base/tools/measure-startup.mjs'

const SCRIPT = fileURLToPath(
  new URL('../../template/base/tools/measure-startup.mjs', import.meta.url),
)

const AM_OUTPUT = `Starting: Intent { act=android.intent.action.VIEW dat=stubapp://matrix pkg=com.example.stub }
Status: ok
LaunchState: COLD
Activity: com.example.stub/.MainActivity
TotalTime: 843
WaitTime: 851
Complete
`

test('parseTotalTimeMs lifts the -W TotalTime line and rejects output without one', () => {
  assert.equal(parseTotalTimeMs(AM_OUTPUT), 843)
  assert.equal(parseTotalTimeMs('Status: ok\nComplete\n'), null)
})

test('parseFullyDrawnMs handles +XsYms, bare +Yms, and absence', () => {
  const pkg = 'com.example.stub'
  assert.equal(
    parseFullyDrawnMs(`I ActivityTaskManager: Fully drawn ${pkg}/.MainActivity: +1s54ms`, pkg),
    1054,
  )
  assert.equal(
    parseFullyDrawnMs(`I ActivityTaskManager: Fully drawn ${pkg}/.MainActivity: +540ms`, pkg),
    540,
  )
  // Another app's Fully-drawn line must not be read as ours.
  assert.equal(parseFullyDrawnMs('Fully drawn com.other.app/.Main: +2s0ms', pkg), null)
  assert.equal(parseFullyDrawnMs('nothing here', pkg), null)
})

// ---------------------------------------------------------------------------
// End-to-end against the stub adb.
// ---------------------------------------------------------------------------

const IMPL = `import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(readFileSync(join(here, 'behavior.json'), 'utf8'))
const args = process.argv.slice(2).join(' ')
if (args === 'get-state') { console.log(spec.device === false ? 'unknown' : 'device'); process.exit(spec.device === false ? 1 : 0) }
if (args.startsWith('shell am start')) {
  let out = spec.amOutput
  if (Array.isArray(spec.amOutputs)) {
    // Sequenced outputs across invocations (fresh process each time — a counter
    // file carries the position), so median arithmetic is testable.
    const counter = join(here, 'am-count.txt')
    let n = 0
    try { n = Number(readFileSync(counter, 'utf8')) } catch { n = 0 }
    out = spec.amOutputs[Math.min(n, spec.amOutputs.length - 1)]
    writeFileSync(counter, String(n + 1))
  }
  console.log(out); process.exit(0)
}
if (args === 'logcat -d') { console.log(spec.logcat ?? ''); process.exit(0) }
process.exit(0)
`

/** @param {Record<string, any>} behavior */
function fixture(behavior) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-measure-'))
  mkdirSync(join(dir, 'apps/mobile/src'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/mobile/src/routes.ts'),
    `export const ROUTES = [
  { id: 'home', titleKey: 'route.home', path: '/', states: {} },
  { id: 'matrix', titleKey: 'route.matrix', path: '/matrix', states: {} },
] as const satisfies readonly RouteEntry[]
`,
  )
  writeFileSync(
    join(dir, 'tools/identity.lock.json'),
    JSON.stringify({ appIdentifier: 'com.example.stub', scheme: 'stubapp', easProjectId: 'x' }),
  )
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'impl.mjs'), IMPL)
  writeFileSync(join(bin, 'behavior.json'), JSON.stringify(behavior))
  writeFileSync(join(bin, 'adb'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/impl.mjs" "$@"\n`)
  chmodSync(join(bin, 'adb'), 0o755)
  writeFileSync(join(bin, 'adb.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0impl.mjs" %*\r\n`)
  return dir
}

function run(dir, { ci = false } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  env.HARNESS_SETTLE_MS = '1'
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${join(dir, 'fakebin')}${delimiter}${env[pathKey] ?? ''}`
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: 3 cold starts (median) + 1 warm start per route, writes the perf-results contract', () => {
  const dir = fixture({
    amOutput: AM_OUTPUT,
    logcat: 'I ActivityTaskManager: Fully drawn com.example.stub/.MainActivity: +1s54ms',
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  const results = JSON.parse(readFileSync(join(dir, 'artifacts/perf-results.json'), 'utf8'))
  assert.deepEqual(results, {
    screens: {
      home: {
        totalTimeMs: 843,
        coldSamplesMs: [843, 843, 843],
        warmTotalTimeMs: 843,
        fullyDrawnMs: 1054,
      },
      matrix: {
        totalTimeMs: 843,
        coldSamplesMs: [843, 843, 843],
        warmTotalTimeMs: 843,
        fullyDrawnMs: 1054,
      },
    },
  })
  assert.ok(r.out.includes('2 route(s) cold-started ×3 (median) + 1 warm start each'), r.out)
})

const amOut = (ms) =>
  `Status: ok\nLaunchState: COLD\nTotalTime: ${ms}\nWaitTime: ${ms + 8}\nComplete\n`

test('median arithmetic: totalTimeMs is the middle cold roll, every roll recorded in order', () => {
  // 2 routes × (3 cold + 1 warm) = 8 sequenced outputs.
  const dir = fixture({
    amOutputs: [
      amOut(900),
      amOut(400),
      amOut(500),
      amOut(100), // home: cold median 500, warm 100
      amOut(700),
      amOut(300),
      amOut(600),
      amOut(50), // matrix: cold median 600, warm 50
    ],
    logcat: '',
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  const results = JSON.parse(readFileSync(join(dir, 'artifacts/perf-results.json'), 'utf8'))
  assert.deepEqual(results.screens.home, {
    totalTimeMs: 500,
    coldSamplesMs: [900, 400, 500],
    warmTotalTimeMs: 100,
  })
  assert.deepEqual(results.screens.matrix, {
    totalTimeMs: 600,
    coldSamplesMs: [700, 300, 600],
    warmTotalTimeMs: 50,
  })
})

test('GREEN: a warm start with no TotalTime records honest absence with a NOTE; fullyDrawn absence too', () => {
  const warmless = 'Warning: Activity not started, intent delivered to the running activity\n'
  const dir = fixture({
    amOutputs: [
      amOut(843),
      amOut(843),
      amOut(843),
      warmless,
      amOut(843),
      amOut(843),
      amOut(843),
      warmless,
    ],
    logcat: '',
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('the warm start printed no TotalTime'), r.out)
  const results = JSON.parse(readFileSync(join(dir, 'artifacts/perf-results.json'), 'utf8'))
  assert.deepEqual(results.screens.home, { totalTimeMs: 843, coldSamplesMs: [843, 843, 843] })
})

test('RED: am output without TotalTime reds naming the route — unmeasured must not pass', () => {
  const dir = fixture({ amOutput: 'Status: ok\nError: activity not started\n' })
  const r = run(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("route 'home'"), r.out)
  assert.ok(r.out.includes('no TotalTime'), r.out)
  assert.ok(!existsSync(join(dir, 'artifacts/perf-results.json')), 'no partial artifact on red')
})

test('no device: loud SKIP locally, FAIL CLOSED in CI', () => {
  const dir = fixture({ device: false, amOutput: AM_OUTPUT })
  const local = run(dir)
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = run(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('no adb device'), ci.out)
})
