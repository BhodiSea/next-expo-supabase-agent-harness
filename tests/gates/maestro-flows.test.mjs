// The Maestro flow GENERATION surface (tools/lib/maestro-flows.mjs +
// tools/lib/mobile-app-meta.mjs): the W6 rule is that flow-shaped YAML derived from
// committed data is built by a unit-tested function, never hand-copied N times — so
// these tests ARE that rule's enforcement. Pins: the parsers' fail-loud branches (a
// half-read manifest silently shrinks the device sweep), every builder's structural
// output (appId, one step block per route, the container-testID selector doctrine),
// and the budget reader's fail-closed rejection of malformed budget files.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  budgetsFromInteractionFile,
  buildPerfHarnessYaml,
  buildRouteFlowYaml,
  buildSweepYaml,
  perfHarnessUrl,
} from '../../template/base/tools/lib/maestro-flows.mjs'
import {
  deepLink,
  parseRoutes,
  readAppIdentity,
} from '../../template/base/tools/lib/mobile-app-meta.mjs'

const IDENTITY = { appId: 'com.example.canary', scheme: 'canaryapp' }
const ROUTES = [
  { id: 'home', path: '/' },
  { id: 'matrix', path: '/matrix' },
  { id: 'actions', path: '/actions' },
]

function tempFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-maestro-'))
  const file = join(dir, name)
  mkdirSync(join(dir), { recursive: true })
  writeFileSync(file, content)
  return file
}

// ---------------------------------------------------------------------------
// mobile-app-meta: parseRoutes
// ---------------------------------------------------------------------------

const ROUTES_TS = `
// comment with a decoy id: 'ghost'
export const ROUTES = [
  { id: 'home', titleKey: 'route.home', path: '/', states: { loading: 'x' } },
  /* { id: 'dead', path: '/dead' } */
  { id: 'matrix', titleKey: 'route.matrix', path: '/matrix', states: {} },
] as const satisfies readonly RouteEntry[]
`

test('parseRoutes lifts id+path pairs in order, ignoring commented-out entries', () => {
  const routes = parseRoutes(tempFile('routes.ts', ROUTES_TS))
  assert.deepEqual(routes, [
    { id: 'home', path: '/' },
    { id: 'matrix', path: '/matrix' },
  ])
})

test('parseRoutes THROWS on a missing ROUTES literal (the manifest is gone, not empty)', () => {
  assert.throws(
    () => parseRoutes(tempFile('routes.ts', 'export const NOPE = 1')),
    /no `export const ROUTES/,
  )
})

test('parseRoutes THROWS on an empty manifest — nothing for the device lane to drive', () => {
  assert.throws(
    () => parseRoutes(tempFile('routes.ts', 'export const ROUTES = [] as const')),
    /ROUTES is empty/,
  )
})

test('parseRoutes THROWS on an id/path count mismatch — every entry carries both', () => {
  const src = `export const ROUTES = [ { id: 'home', path: '/' }, { id: 'matrix' } ] as const`
  assert.throws(() => parseRoutes(tempFile('routes.ts', src)), /2 id field\(s\) but 1 path/)
})

// ---------------------------------------------------------------------------
// mobile-app-meta: readAppIdentity + deepLink
// ---------------------------------------------------------------------------

test('readAppIdentity reads the identity lock pins', () => {
  const file = tempFile(
    'identity.lock.json',
    JSON.stringify({ appIdentifier: 'com.x.y', scheme: 'xy', easProjectId: 'p' }),
  )
  assert.deepEqual(readAppIdentity(file), { appId: 'com.x.y', scheme: 'xy' })
})

test('readAppIdentity THROWS when either pin is missing or empty', () => {
  for (const bad of [{}, { appIdentifier: 'com.x' }, { appIdentifier: 'com.x', scheme: '' }]) {
    const file = tempFile('identity.lock.json', JSON.stringify(bad))
    assert.throws(() => readAppIdentity(file), /appIdentifier\/scheme pins/)
  }
})

test('deepLink maps the root path to the bare scheme and strips one leading slash', () => {
  assert.equal(deepLink('app', '/'), 'app://')
  assert.equal(deepLink('app', '/matrix'), 'app://matrix')
})

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

test('buildSweepYaml: appId header, one deep-link + container assert per route, no clearState', () => {
  const yaml = buildSweepYaml(ROUTES, IDENTITY)
  assert.ok(yaml.startsWith('# GENERATED route sweep'), yaml)
  assert.ok(yaml.includes('appId: "com.example.canary"'), yaml)
  for (const route of ROUTES) {
    assert.ok(yaml.includes(`- openLink: "${deepLink(IDENTITY.scheme, route.path)}"`), yaml)
    assert.ok(yaml.includes(`id: "${route.id}-screen"`), yaml)
  }
  // One launch for the whole sweep, and NEVER clearState — the i18n/theme phases
  // re-run this sweep over pre-seeded app state.
  assert.equal(yaml.match(/- launchApp/g)?.length, 1)
  assert.ok(!yaml.includes('clearState'), yaml)
})

test('buildRouteFlowYaml scaffolds a closure-satisfying per-route flow', () => {
  const yaml = buildRouteFlowYaml({ id: 'reports', path: '/reports' }, IDENTITY)
  assert.ok(yaml.includes('maestro/flows/reports.yaml'), yaml)
  assert.ok(yaml.includes('- openLink: "canaryapp://reports"'), yaml)
  assert.ok(yaml.includes('id: "reports-screen"'), yaml)
})

test('perf-harness journey asserts the markers and carries NO openLink — the runner delivers the link', () => {
  const budgets = { tabSwitchMs: 400, actionsOpenMs: 600, frameDropMax: 12, runs: 7 }
  const yaml = buildPerfHarnessYaml(IDENTITY, budgets)
  // The query-string link must NEVER ride Maestro's openLink: the device shell
  // splits it at the first '&' and the intent silently never fires (proven live
  // on the emulator lane). The journey is assert-only.
  assert.ok(!/^- openLink:/m.test(yaml), yaml)
  assert.ok(yaml.includes('id: "perf-pass"'), yaml)
  assert.ok(yaml.includes('id: "perf-harness-screen"'), yaml)
})

test('perfHarnessUrl carries every budget cap as a query param on the app scheme', () => {
  const url = perfHarnessUrl(IDENTITY, { tabSwitchMs: 400, actionsOpenMs: 600, frameDropMax: 12, runs: 7 })
  assert.equal(
    url,
    'canaryapp://perf-harness?tabSwitchMs=400&actionsOpenMs=600&frameDropMax=12&runs=7',
  )
})

// ---------------------------------------------------------------------------
// budgetsFromInteractionFile — fail-closed on malformed budget data
// ---------------------------------------------------------------------------

const GOOD_BUDGET = {
  tabSwitchMs: { median: 400 },
  actionsOpenMs: { median: 600 },
  listScrollFrameDropMax: 12,
  runs: 7,
}

test('budgetsFromInteractionFile maps the seeded budget shape', () => {
  assert.deepEqual(budgetsFromInteractionFile(GOOD_BUDGET), {
    tabSwitchMs: 400,
    actionsOpenMs: 600,
    frameDropMax: 12,
    runs: 7,
  })
})

test('budgetsFromInteractionFile THROWS on malformed budgets — never relaxes them', () => {
  assert.throws(() => budgetsFromInteractionFile(null), /not an object/)
  assert.throws(
    () => budgetsFromInteractionFile({ ...GOOD_BUDGET, tabSwitchMs: { median: 0 } }),
    /tabSwitchMs\.median/,
  )
  assert.throws(
    () => budgetsFromInteractionFile({ ...GOOD_BUDGET, actionsOpenMs: 600 }),
    /actionsOpenMs\.median/,
  )
  assert.throws(
    () => budgetsFromInteractionFile({ ...GOOD_BUDGET, listScrollFrameDropMax: '12' }),
    /listScrollFrameDropMax/,
  )
  assert.throws(() => budgetsFromInteractionFile({ ...GOOD_BUDGET, runs: -1 }), /runs/)
})

// ---------------------------------------------------------------------------
// The generator CLI (tools/gen-maestro-flows.mjs) — thin over the builders above,
// but its refusal semantics are behavior: --flow must never clobber a hand-tuned
// flow, and an unregistered id must point at the manifest, not scaffold blindly.
// ---------------------------------------------------------------------------

test('gen-maestro-flows --flow scaffolds a missing flow and REFUSES to overwrite it', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { readFileSync, existsSync } = await import('node:fs')
  const cli = fileURLToPath(
    new URL('../../template/base/tools/gen-maestro-flows.mjs', import.meta.url),
  )
  const dir = mkdtempSync(join(tmpdir(), 'epah-genflows-'))
  mkdirSync(join(dir, 'apps/mobile/src'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/mobile/src/routes.ts'),
    `export const ROUTES = [ { id: 'home', path: '/' } ] as const`,
  )
  writeFileSync(
    join(dir, 'tools/identity.lock.json'),
    JSON.stringify({ appIdentifier: IDENTITY.appId, scheme: IDENTITY.scheme }),
  )
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' })
  const scaffold = run('--flow', 'home')
  assert.equal(scaffold.status, 0, scaffold.stderr)
  assert.ok(existsSync(join(dir, 'maestro/flows/home.yaml')))
  assert.ok(readFileSync(join(dir, 'maestro/flows/home.yaml'), 'utf8').includes('id: "home-screen"'))
  const clobber = run('--flow', 'home')
  assert.equal(clobber.status, 1)
  assert.ok(clobber.stderr.includes('already exists'), clobber.stderr)
  const ghost = run('--flow', 'ghost')
  assert.equal(ghost.status, 1)
  assert.ok(ghost.stderr.includes("no ROUTES entry has id 'ghost'"), ghost.stderr)
  const sweep = run('--sweep', '--out', 'out/sweep.yaml')
  assert.equal(sweep.status, 0, sweep.stderr)
  assert.ok(readFileSync(join(dir, 'out/sweep.yaml'), 'utf8').includes('GENERATED route sweep'))
})

// The SHIPPED interaction-budget.json must parse through the same reader the lane
// uses — a template edit that breaks the shape reds here, not on the first CI run.
test('the shipped tools/interaction-budget.json satisfies the lane reader', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const shipped = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../template/base/tools/interaction-budget.json', import.meta.url)),
      'utf8',
    ),
  )
  const budgets = budgetsFromInteractionFile(shipped)
  assert.ok(budgets.tabSwitchMs > 0 && budgets.runs > 0)
})
