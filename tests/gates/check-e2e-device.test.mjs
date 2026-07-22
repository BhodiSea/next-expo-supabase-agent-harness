// Can-fail proofs for the device e2e runner (template/base/tools/check-e2e-device.mjs).
// Fixture-driven with STUB maestro/adb shims on PATH (sh wrapper + .cmd twin, the
// Windows-matrix pattern every stub-CLI gate test here uses): the runner's failure
// propagation, per-flow evidence capture, flow discovery from the ROUTES manifest,
// the generated sweep/perf-harness phases, and the skip-local/fail-closed-CI
// asymmetry are all pinned by spawning the REAL script. What no repo test can prove
// — a real emulator honoring a real flow — is the maestro-smoke selftest job's job.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(
  new URL('../../template/base/tools/check-e2e-device.mjs', import.meta.url),
)

// One node implementation impersonates BOTH tools (argv[2] carries which name the
// shell shim was invoked as): `maestro test …` logs its invocation and exits per
// behavior.json; `adb …` answers logcat/screencap so evidence capture has bytes.
const IMPL = `import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(readFileSync(join(here, 'behavior.json'), 'utf8'))
const tool = process.argv[2]
const args = process.argv.slice(3)
if (tool === 'maestro') {
  if (args.includes('--version')) { console.log('stub 0.0.0'); process.exit(0) }
  const flow = args[args.length - 1]
  appendFileSync(join(here, 'invocations.log'), 'maestro ' + args.join(' ') + '\\n')
  const name = flow.split(/[\\\\/]/).pop()
  if ((spec.failFlows ?? []).some((f) => name === f)) {
    console.error('stub maestro: flow assertion failed in ' + name)
    process.exit(1)
  }
  process.exit(0)
}
if (tool === 'adb') {
  appendFileSync(join(here, 'invocations.log'), 'adb ' + args.join(' ') + '\\n')
  if (args.join(' ').startsWith('logcat -d')) { console.log(spec.logcat ?? 'stub logcat line'); process.exit(0) }
  process.exit(0)
}
console.error('stub impl: unknown tool ' + String(tool))
process.exit(1)
`

function writeShims(dir, behavior) {
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'impl.mjs'), IMPL)
  writeFileSync(join(bin, 'behavior.json'), JSON.stringify(behavior))
  for (const tool of ['maestro', 'adb']) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/impl.mjs" ${tool} "$@"\n`,
    )
    chmodSync(join(bin, tool), 0o755)
    writeFileSync(
      join(bin, `${tool}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0impl.mjs" ${tool} %*\r\n`,
    )
  }
  return bin
}

const ROUTES_TS = `export const ROUTES = [
  { id: 'home', titleKey: 'route.home', path: '/', states: {} },
  { id: 'matrix', titleKey: 'route.matrix', path: '/matrix', states: {} },
] as const satisfies readonly RouteEntry[]
`
const IDENTITY_JSON = JSON.stringify({
  appIdentifier: 'com.example.stub',
  scheme: 'stubapp',
  easProjectId: 'x',
})
const BUDGET_JSON = JSON.stringify({
  tabSwitchMs: { median: 400 },
  actionsOpenMs: { median: 600 },
  listScrollFrameDropMax: 12,
  runs: 7,
})

/** @param {{ behavior?: Record<string, any>, flows?: string[], files?: Record<string, string> }} [opts] */
function fixture({ behavior = {}, flows = ['home', 'matrix'], files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-e2edevice-'))
  mkdirSync(join(dir, 'apps/mobile/src'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'maestro/flows'), { recursive: true })
  mkdirSync(join(dir, 'maestro/journeys'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/src/routes.ts'), ROUTES_TS)
  writeFileSync(join(dir, 'tools/identity.lock.json'), IDENTITY_JSON)
  writeFileSync(join(dir, 'tools/interaction-budget.json'), BUDGET_JSON)
  for (const id of flows) {
    writeFileSync(join(dir, `maestro/flows/${id}.yaml`), `appId: com.example.stub\n---\n- launchApp\n`)
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  writeShims(dir, behavior)
  return dir
}

function run(dir, args, { ci = false, shims = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.GITHUB_ACTIONS
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  // Shims OFF: an empty PATH forces the maestro-absent branch deterministically —
  // and HOME/USERPROFILE point into the fixture so a developer machine's real
  // ~/.maestro/bin install cannot satisfy the fallback probe.
  if (shims) {
    env[pathKey] = `${join(dir, 'fakebin')}${delimiter}${env[pathKey] ?? ''}`
  } else {
    env[pathKey] = join(dir, 'nowhere')
    env.HOME = dir
    env.USERPROFILE = dir
  }
  const res = spawnSync(process.execPath, [RUNNER, ...args], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const invocations = (dir) => {
  const file = join(dir, 'fakebin/invocations.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

test('GREEN --phase flows: every ROUTES flow discovered and executed, count reported', () => {
  const dir = fixture()
  const r = run(dir, ['--phase', 'flows'])
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes("phase 'flows' — 2 flow(s) green"), r.out)
  const log = invocations(dir)
  assert.ok(log.includes('home.yaml'), log)
  assert.ok(log.includes('matrix.yaml'), log)
})

test('RED --phase flows: a ROUTES id with no committed flow file reds naming the scaffold command', () => {
  const dir = fixture({ flows: ['home'] })
  const r = run(dir, ['--phase', 'flows'])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("route 'matrix' has no maestro/flows/matrix.yaml"), r.out)
  assert.ok(r.out.includes('gen-maestro-flows.mjs --flow matrix'), r.out)
})

test('RED: a failing flow propagates AND leaves evidence (logcat tail artifact)', () => {
  const dir = fixture({
    flows: ['home', 'matrix'],
    behavior: { failFlows: ['matrix.yaml'], logcat: 'FATAL EXCEPTION: main (stub)' },
  })
  const r = run(dir, ['--phase', 'flows'])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('maestro/flows/matrix.yaml FAILED'), r.out)
  assert.ok(r.out.includes('flow assertion failed'), r.out)
  const logcat = join(dir, 'artifacts/maestro/matrix-logcat.txt')
  assert.ok(existsSync(logcat), r.out)
  assert.ok(readFileSync(logcat, 'utf8').includes('FATAL EXCEPTION'), r.out)
})

test('--phase sweep: generates the route sweep from the manifest and runs it once', () => {
  const dir = fixture()
  const r = run(dir, ['--phase', 'sweep'])
  assert.equal(r.code, 0, r.out)
  const sweep = readFileSync(join(dir, 'artifacts/maestro/route-sweep.yaml'), 'utf8')
  assert.ok(sweep.includes('stubapp://matrix'), sweep)
  assert.ok(sweep.includes('id: "home-screen"'), sweep)
  assert.ok(invocations(dir).includes('route-sweep.yaml'), r.out)
  assert.ok(r.out.includes("phase 'sweep' — 2 flow(s) green"), r.out)
})

test('--phase journey runs exactly the named file; a missing file reds', () => {
  const dir = fixture({
    files: { 'maestro/journeys/mutation.yaml': 'appId: com.example.stub\n---\n- launchApp\n' },
  })
  const green = run(dir, ['--phase', 'journey', '--file', 'maestro/journeys/mutation.yaml'])
  assert.equal(green.code, 0, green.out)
  assert.ok(invocations(dir).includes('mutation.yaml'), green.out)
  const red = run(dir, ['--phase', 'journey', '--file', 'maestro/journeys/ghost.yaml'])
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('--phase journey needs --file'), red.out)
})

test('--phase perf-harness: assert-only journey; the FULL query-string link is delivered via adb am start', () => {
  const dir = fixture()
  const r = run(dir, ['--phase', 'perf-harness'])
  assert.equal(r.code, 0, r.out)
  const journey = readFileSync(join(dir, 'artifacts/maestro/perf-harness.yaml'), 'utf8')
  // openLink would hand the URL to the device shell unquoted and lose everything
  // after the first '&' (proven live on the emulator lane) — the journey must be
  // assert-only, with the runner delivering the link itself.
  assert.ok(!/^- openLink:/m.test(journey), journey)
  assert.ok(journey.includes('id: "perf-pass"'), journey)
  const invocations = readFileSync(join(dir, 'fakebin', 'invocations.log'), 'utf8')
  assert.ok(
    invocations.includes(
      "am start -W -a android.intent.action.VIEW -d 'stubapp://perf-harness?tabSwitchMs=400&actionsOpenMs=600&frameDropMax=12&runs=7'",
    ),
    invocations,
  )
  // Cold-start discipline: the phase must force-stop BEFORE delivering the link
  // (a warm re-delivery shows an earlier measurement's verdict — proven live).
  const stopAt = invocations.indexOf('am force-stop')
  const startAt = invocations.indexOf('am start -W')
  assert.ok(stopAt !== -1, invocations)
  assert.ok(stopAt < startAt, `force-stop must precede am start:\n${invocations}`)
})

test('RED --phase perf-harness: a malformed budget file fails closed, never relaxes', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'tools/interaction-budget.json'), '{ "tabSwitchMs": { "median": 0 } }')
  const r = run(dir, ['--phase', 'perf-harness'])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tabSwitchMs.median'), r.out)
})

test('unknown phase reds; a broken ROUTES manifest reds before any tool runs', () => {
  const dir = fixture()
  const bad = run(dir, ['--phase', 'everything'])
  assert.equal(bad.code, 1, bad.out)
  assert.ok(bad.out.includes('unknown --phase'), bad.out)
  writeFileSync(join(dir, 'apps/mobile/src/routes.ts'), 'export const ROUTES = [] as const')
  const empty = run(dir, ['--phase', 'flows'])
  assert.equal(empty.code, 1, empty.out)
  assert.ok(empty.out.includes('ROUTES is empty'), empty.out)
})

test('maestro absent: loud SKIP locally, FAIL CLOSED in CI (the gate asymmetry)', () => {
  const dir = fixture()
  const local = run(dir, ['--phase', 'flows'], { shims: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('maestro CLI not found'), local.out)
  const ci = run(dir, ['--phase', 'flows'], { shims: false, ci: true })
  assert.equal(ci.code, 1, ci.out)
})
