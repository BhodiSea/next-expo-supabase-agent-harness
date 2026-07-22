// Can-fail proofs for the mobile-perf gate (template/base/tools/check-mobile-perf.mjs).
// Fixture-driven like the route-manifest suite: build a scaffold-shaped tree (the GREEN
// closure case uses the SHIPPED routes.ts + startup-budget.json + maestro flow names
// verbatim, so template drift reds here), run the real gate with cwd inside it, assert
// the exact red/green. Two modes are pinned: --closure (the Stop-chain triangle —
// routes ↔ flows ↔ budget rows, stale entries red both ways) and measurement (the CI
// device lane's artifacts/perf-results.json enforced against the budgets, absent
// artifact = loud local skip, absent artifact under HARNESS_PERF_LANE=1 = fail closed).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-mobile-perf.mjs', import.meta.url),
)
const SHIPPED_ROUTES = readFileSync(
  fileURLToPath(new URL('../../template/stack/apps/mobile/src/routes.ts', import.meta.url)),
  'utf8',
)
const SHIPPED_BUDGET = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/startup-budget.json', import.meta.url)),
  'utf8',
)

// The shipped scaffold's route ids — flows are seeded one per id.
const SCAFFOLD_IDS = ['home', 'matrix', 'actions']

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

// routes/budget: string = verbatim body, object = serialized, null = absent.
// flows: array of flow file basenames (no extension); results: the device-lane
// artifact; manifest: .harness/manifest.json (the version-ramp input).
/** @param {{ routes?: any, budget?: any, flows?: string[], results?: any, manifest?: any }} [opts] */
function fixture({
  routes = SHIPPED_ROUTES,
  budget = SHIPPED_BUDGET,
  flows = SCAFFOLD_IDS,
  results,
  manifest,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-mobileperf-'))
  mkdirSync(join(dir, 'apps/mobile/src'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'maestro/flows'), { recursive: true })
  if (routes !== null) writeFileSync(join(dir, 'apps/mobile/src/routes.ts'), asText(routes))
  if (budget !== null) writeFileSync(join(dir, 'tools/startup-budget.json'), asText(budget))
  for (const id of flows) {
    writeFileSync(join(dir, 'maestro/flows', `${id}.yaml`), 'appId: example\n---\n- launchApp\n')
  }
  if (results !== undefined) {
    mkdirSync(join(dir, 'artifacts'), { recursive: true })
    writeFileSync(join(dir, 'artifacts/perf-results.json'), asText(results))
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), asText(manifest))
  }
  return dir
}

function budgetWith(mutate) {
  const b = JSON.parse(SHIPPED_BUDGET)
  mutate(b)
  return b
}

/** @param {string} dir @param {{ closure?: boolean, lane?: boolean }} [opts] */
function runGate(dir, { closure = false, lane = false } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_PERF_LANE
  env.CI = 'true'
  if (lane) env.HARNESS_PERF_LANE = '1'
  const res = spawnSync(process.execPath, [GATE, ...(closure ? ['--closure'] : [])], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// A ROUTES mutation that appends one entry (only the id set matters to this gate).
function routesPlus(id) {
  const entry = `  { id: '${id}', titleKey: 'route.${id}', path: '/${id}', file: '${id}', states: { loading: '${id}-l', empty: '${id}-e', error: '${id}-r' } },`
  const routes = SHIPPED_ROUTES.replace('\n] as const', `\n${entry}\n] as const`)
  assert.notEqual(routes, SHIPPED_ROUTES, 'fixture replacement must hit')
  return routes
}

// ---- closure mode ---------------------------------------------------------------

test('GREEN --closure: the shipped triangle (routes + flows + budget rows) passes verbatim', () => {
  const r = runGate(fixture(), { closure: true })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('mobile-perf: OK'), r.out)
  assert.ok(r.out.includes('closure OK — 3 route(s)'), r.out)
})

test('RED --closure: a new route with no Maestro flow AND no budget row reds naming both gaps', () => {
  const r = runGate(fixture({ routes: routesPlus('settings') }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("route 'settings' has no Maestro flow"), r.out)
  assert.ok(r.out.includes('maestro/flows/settings.yaml'), r.out)
  assert.ok(r.out.includes('has no screens["settings"] row'), r.out)
})

test('RED --closure: a stale flow file (no such route id) reds naming the file', () => {
  const r = runGate(fixture({ flows: [...SCAFFOLD_IDS, 'ghost'] }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("maestro/flows/ghost.yaml: no ROUTES entry has id 'ghost'"), r.out)
  assert.ok(r.out.includes('stale flow'), r.out)
})

test('RED --closure: a stale budget row (route id gone from the manifest) reds', () => {
  const budget = budgetWith((b) => {
    b.screens.ghost = { maxTotalTimeMs: 15000 }
  })
  const r = runGate(fixture({ budget }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('screens["ghost"] names a route id that is not in'), r.out)
  assert.ok(r.out.includes('stale row'), r.out)
})

test('RED --closure: a budget row without a positive maxTotalTimeMs is a budget in name only', () => {
  const budget = budgetWith((b) => {
    b.screens.home.maxTotalTimeMs = 0
  })
  const r = runGate(fixture({ budget }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes('screens["home"].maxTotalTimeMs must be a positive number'),
    r.out,
  )
})

test('OK: no routes.ts at all is an honest OK — the route-manifest gate owns that surface', () => {
  const r = runGate(fixture({ routes: null }), { closure: true })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('apps/mobile/src/routes.ts not found'), r.out)
})

test('OK: an EMPTY ROUTES array defers to the route-manifest gate (nothing to time yet)', () => {
  const r = runGate(fixture({ routes: 'export const ROUTES = [] as const\n', flows: [] }), {
    closure: true,
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('ROUTES is empty'), r.out)
})

test('RED: a routes.ts without the ROUTES literal fails — the canonical manifest is gone', () => {
  const r = runGate(fixture({ routes: 'export const ROUTES = 42\n' }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has no `export const ROUTES = [ … ] as const` literal'), r.out)
})

// ---- the budget file itself -------------------------------------------------------

test('RED: budget absent with no install manifest fails — the floor cannot be disarmed by deletion', () => {
  const r = runGate(fixture({ budget: null }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/startup-budget.json is missing'), r.out)
  assert.ok(r.out.includes('restore it from git history'), r.out)
})

test('NOTE: budget absent on a pre-0.1.0 baseVersion install self-disables with the adoption ramp', () => {
  const r = runGate(
    fixture({ budget: null, manifest: { harnessVersion: '0.1.0', baseVersion: '0.0.1' } }),
    { closure: true },
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('mobile-perf: NOTE'), r.out)
  assert.ok(r.out.includes('ramp: live from baseVersion 0.1.0'), r.out)
  assert.ok(r.out.includes('pre-0.1.0 install; adopt it to arm the startup floor'), r.out)
})

test('RED: budget absent on a CURRENT baseVersion install fails (the ramp has passed)', () => {
  const r = runGate(
    fixture({ budget: null, manifest: { harnessVersion: '0.1.0', baseVersion: '0.1.0' } }),
    { closure: true },
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/startup-budget.json is missing'), r.out)
})

test('RED: a budget without a "screens" object fails naming the contract', () => {
  const r = runGate(fixture({ budget: { screens: [] } }), { closure: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('declares no "screens" object'), r.out)
})

// ---- measurement mode -------------------------------------------------------------

const GREEN_RESULTS = {
  screens: {
    home: { totalTimeMs: 900 },
    matrix: { totalTimeMs: 1100 },
    actions: { totalTimeMs: 800 },
  },
}

test('GREEN measurement: results within every budget pass, printing the measured table', () => {
  const r = runGate(fixture({ results: GREEN_RESULTS }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('measured (am start -W'), r.out)
  assert.ok(r.out.includes('3 screen(s) within startup budget'), r.out)
})

test('RED measurement: a cold-start over its cap fails naming the screen and both numbers', () => {
  const results = structuredClone(GREEN_RESULTS)
  results.screens.home.totalTimeMs = 99999
  const r = runGate(fixture({ results }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('home: cold-start 99999ms exceeds its 15000ms budget'), r.out)
  assert.ok(r.out.includes('<-- OVER'), r.out)
})

test('RED measurement: a budgeted screen the lane never measured is a silently-off gate', () => {
  const results = structuredClone(GREEN_RESULTS)
  delete results.screens.actions
  const r = runGate(fixture({ results }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('actions: budgeted but the device lane produced no totalTimeMs'), r.out)
})

test('RED measurement: a measured screen with no budget row is naming drift', () => {
  const results = structuredClone(GREEN_RESULTS)
  results.screens.ghost = { totalTimeMs: 1 }
  const r = runGate(fixture({ results }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes('reports screens["ghost"] which has no tools/startup-budget.json row'),
    r.out,
  )
})

test('RED measurement: fullyDrawn caps enforce both halves — over-cap, and cap-with-no-report', () => {
  const budget = budgetWith((b) => {
    b.screens.home.maxFullyDrawnMs = 100
    b.screens.matrix.maxFullyDrawnMs = 100
  })
  const results = structuredClone(GREEN_RESULTS)
  results.screens.home.fullyDrawnMs = 500 // over the cap
  // matrix reports none while the budget caps it
  const r = runGate(fixture({ budget, results }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('home: fully-drawn 500ms exceeds its 100ms budget'), r.out)
  assert.ok(r.out.includes('matrix: tools/startup-budget.json caps fullyDrawn (100ms)'), r.out)
  assert.ok(r.out.includes('reportFullyDrawn()'), r.out)
})

test('RED measurement: warm caps (0.1.2) enforce both halves — over-cap, and cap-with-no-report', () => {
  const budget = budgetWith((b) => {
    b.screens.home.maxWarmTotalTimeMs = 100
    b.screens.matrix.maxWarmTotalTimeMs = 100
  })
  const results = structuredClone(GREEN_RESULTS)
  results.screens.home.warmTotalTimeMs = 500 // over the cap
  // matrix reports none while the budget caps it — a warm launch does not
  // always print TotalTime; a declared cap enforced against nothing must red.
  const r = runGate(fixture({ budget, results }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('home: warm start 500ms exceeds its 100ms budget'), r.out)
  assert.ok(r.out.includes('matrix: tools/startup-budget.json caps warm starts (100ms)'), r.out)

  // Undeclared caps ignore the reported warm numbers entirely.
  const green = runGate(
    fixture({
      results: (() => {
        const ok = structuredClone(GREEN_RESULTS)
        ok.screens.home.warmTotalTimeMs = 999999
        return ok
      })(),
    }),
  )
  assert.equal(green.code, 0, green.out)
})

test('RED measurement: a corrupt artifact fails loud, and a screens-less one names the contract', () => {
  const corrupt = runGate(fixture({ results: '{ not json' }))
  assert.equal(corrupt.code, 1, corrupt.out)
  assert.ok(corrupt.out.includes('artifacts/perf-results.json is not valid JSON'), corrupt.out)

  const shapeless = runGate(fixture({ results: { screens: [] } }))
  assert.equal(shapeless.code, 1, shapeless.out)
  assert.ok(shapeless.out.includes("declares no \"screens\" object"), shapeless.out)
  assert.ok(shapeless.out.includes('artifact contract drifted'), shapeless.out)
})

test('skip asymmetry: artifact absent → loud SKIP even in CI; HARNESS_PERF_LANE=1 → fail closed', () => {
  // Bare CI must not red: the quality-gate job runs --closure, never measurement.
  const skip = runGate(fixture())
  assert.equal(skip.code, 0, skip.out)
  assert.ok(skip.out.includes('SKIPPED'), skip.out)
  assert.ok(skip.out.includes('no artifacts/perf-results.json'), skip.out)
  assert.ok(skip.out.includes('FAILS CLOSED when HARNESS_PERF_LANE=1'), skip.out)

  // The lane env with no artifact is a broken lane — it must never skip-green.
  const lane = runGate(fixture(), { lane: true })
  assert.equal(lane.code, 1, lane.out)
  assert.ok(lane.out.includes('HARNESS_PERF_LANE=1 but artifacts/perf-results.json is missing'), lane.out)
})

test('GREEN measurement under the lane env reports fail-closed arming', () => {
  const r = runGate(fixture({ results: GREEN_RESULTS }), { lane: true })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('(device lane: fail-closed)'), r.out)
})
