// Can-fail proofs for the route-manifest gate (template/base/tools/check-route-manifest.mjs).
// Fixture-driven: build a scaffold-shaped tree (the GREEN case uses the SHIPPED
// routes.ts + route-allowlist.json + i18n catalog verbatim plus the scaffold's app/
// files, so template drift reds here), run the real gate with cwd inside it, assert
// the exact red/green. Pins the expo-router port's rules: id/titleKey/path/file +
// states per entry, the app/ closure BOTH ways (every route file claimed by exactly
// one entry, orphans red), the file→URL derivation ((group) elided, index→parent,
// [param]→:param, [...param]→*param), plumbing exclusions (_layout/+not-found/+html/
// api routes), the REQUIRED +not-found chrome, the reviewed allowlist (reasons,
// malformed/stale = red), and titleKey resolution against the i18n catalog.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-route-manifest.mjs', import.meta.url),
)
const SHIPPED_ROUTES = readFileSync(
  fileURLToPath(new URL('../../template/stack/apps/mobile/src/routes.ts', import.meta.url)),
  'utf8',
)
const SHIPPED_ALLOWLIST = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/route-allowlist.json', import.meta.url)),
  'utf8',
)
const SHIPPED_CATALOG = readFileSync(
  fileURLToPath(new URL('../../template/stack/apps/mobile/src/i18n/catalog.ts', import.meta.url)),
  'utf8',
)

// The scaffold's app/ tree, plumbing included: _layout/+html/api are pattern-excluded
// from enumeration, sign-in/+not-found/perf-harness are the allowlisted chrome
// (perf-harness is the W6 dev measurement screen the device lane deep-links).
const SCAFFOLD_APP_FILES = [
  '(tabs)/_layout.tsx',
  '(tabs)/index.tsx',
  '(tabs)/matrix.tsx',
  '_layout.tsx',
  '+html.tsx',
  '+not-found.tsx',
  'actions.tsx',
  'api/health+api.ts',
  'perf-harness.tsx',
  'sign-in.tsx',
]

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** @param {{ routes?: any, allowlist?: any, appFiles?: string[], catalog?: any, srcDir?: boolean }} [opts] */
function fixture({
  routes = SHIPPED_ROUTES,
  allowlist = SHIPPED_ALLOWLIST,
  appFiles = SCAFFOLD_APP_FILES,
  catalog = SHIPPED_CATALOG,
  srcDir = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-routegate-'))
  if (srcDir) mkdirSync(join(dir, 'apps/mobile/src'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (routes !== null) writeFileSync(join(dir, 'apps/mobile/src/routes.ts'), asText(routes))
  if (allowlist !== null) writeFileSync(join(dir, 'tools/route-allowlist.json'), asText(allowlist))
  if (catalog !== null) {
    mkdirSync(join(dir, 'apps/mobile/src/i18n'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/src/i18n/catalog.ts'), asText(catalog))
  }
  for (const rel of appFiles) {
    const abs = join(dir, 'apps/mobile/app', rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'export default function Screen() {\n  return null\n}\n')
  }
  return dir
}

function allowlistWith(mutate) {
  const a = JSON.parse(SHIPPED_ALLOWLIST)
  mutate(a)
  return a
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped scaffold shape passes (routes + allowlist + catalog + app/ files verbatim)', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('route-manifest: OK'), r.out)
  assert.ok(r.out.includes('closure holds both ways'), r.out)
  assert.ok(r.out.includes('+not-found present'), r.out)
})

test('RED: an EMPTY ROUTES array is a vacuous manifest', () => {
  const r = runGate(
    fixture({ routes: 'export const ROUTES = [] as const\n', appFiles: ['+not-found.tsx'] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ROUTES is EMPTY'), r.out)
})

test('RED: entries missing id/titleKey/path/file are each named', () => {
  const r = runGate(
    fixture({
      routes:
        "export const ROUTES = [\n  {\n    states: { loading: 'x', empty: 'y', error: 'z' },\n  },\n] as const\n",
      appFiles: ['+not-found.tsx'],
      allowlist: { comment: 'x', allow: [] },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing `id`'), r.out)
  assert.ok(r.out.includes('missing `titleKey`'), r.out)
  assert.ok(r.out.includes('missing `path`'), r.out)
  assert.ok(r.out.includes('missing `file`'), r.out)
})

test('RED: a ROUTES entry missing `states` (or one state key) fails naming the entry and key', () => {
  const noStates = runGate(
    fixture({ routes: SHIPPED_ROUTES.replace(/,\n {4}states: \{[\s\S]*?\},\n {2}\}/, ',\n  }') }),
  )
  assert.equal(noStates.code, 1, noStates.out)
  assert.ok(noStates.out.includes('home: missing `states`'), noStates.out)

  const noError = runGate(
    fixture({ routes: SHIPPED_ROUTES.replace(/\n\s*error: 'home-error',/, '') }),
  )
  assert.equal(noError.code, 1, noError.out)
  assert.ok(noError.out.includes('states.error missing or empty'), noError.out)
})

test('RED: an orphan app/ route file (claimed by no entry) reds with its derived URL; allowlisting it greens', () => {
  const orphan = runGate(fixture({ appFiles: [...SCAFFOLD_APP_FILES, 'settings.tsx'] }))
  assert.equal(orphan.code, 1, orphan.out)
  assert.ok(orphan.out.includes('apps/mobile/app/settings: route file claimed by NO ROUTES entry'), orphan.out)
  assert.ok(orphan.out.includes('expo-router serves it at "/settings"'), orphan.out)

  const allowed = runGate(
    fixture({
      appFiles: [...SCAFFOLD_APP_FILES, 'settings.tsx'],
      allowlist: allowlistWith((a) =>
        a.allow.push({ name: 'settings', reason: 'debug chrome, no canonical data states' }),
      ),
    }),
  )
  assert.equal(allowed.code, 0, allowed.out)
})

test('RED: one app/ file claimed by TWO entries is a duplicate; content AND chrome is a conflict', () => {
  const dupFile = runGate(
    fixture({ routes: SHIPPED_ROUTES.replace("file: '(tabs)/matrix'", "file: '(tabs)/index'") }),
  )
  assert.equal(dupFile.code, 1, dupFile.out)
  assert.ok(dupFile.out.includes('duplicate file'), dupFile.out)
  assert.ok(dupFile.out.includes('also claimed by "home"'), dupFile.out)

  const both = runGate(
    fixture({
      allowlist: allowlistWith((a) =>
        a.allow.push({ name: 'actions', reason: 'pretending a content screen is chrome' }),
      ),
    }),
  )
  assert.equal(both.code, 1, both.out)
  assert.ok(both.out.includes('content or chrome, never both'), both.out)
})

test('GREEN: the expo-router derivation accepts [param]→:param and [...param]→*param entries', () => {
  const extra =
    "  {\n    id: 'note-detail',\n    titleKey: 'route.home',\n    path: '/notes/:id',\n    file: 'notes/[id]',\n    states: { loading: 'nd-l', empty: 'nd-e', error: 'nd-r' },\n  },\n" +
    "  {\n    id: 'doc-catch',\n    titleKey: 'route.home',\n    path: '/docs/*slug',\n    file: 'docs/[...slug]',\n    states: { loading: 'dc-l', empty: 'dc-e', error: 'dc-r' },\n  },\n"
  const routes = SHIPPED_ROUTES.replace('\n] as const', `\n${extra}] as const`)
  assert.notEqual(routes, SHIPPED_ROUTES, 'fixture replacement must hit')
  const r = runGate(
    fixture({ routes, appFiles: [...SCAFFOLD_APP_FILES, 'notes/[id].tsx', 'docs/[...slug].tsx'] }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('5 route(s)'), r.out)
})

test('RED: a manifest path disagreeing with the derived URL reds — the manifest is lying', () => {
  // (tabs)/matrix derives "/matrix" ((group) elided); declaring "/grid" is a lie.
  const routes = SHIPPED_ROUTES.replace("path: '/matrix'", "path: '/grid'")
  assert.notEqual(routes, SHIPPED_ROUTES, 'fixture replacement must hit')
  const r = runGate(fixture({ routes }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('matrix: path "/grid" disagrees with the URL expo-router serves'), r.out)
  assert.ok(r.out.includes('"/matrix"'), r.out)
})

test('RED: app/+not-found.* is REQUIRED chrome — its absence is a red, not a note', () => {
  const r = runGate(
    fixture({
      appFiles: SCAFFOLD_APP_FILES.filter((f) => f !== '+not-found.tsx'),
      // Drop its allow entry too, so THIS red (not allowlist staleness) is what fires.
      allowlist: allowlistWith((a) => {
        a.allow = a.allow.filter((e) => e.name !== '+not-found')
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/mobile/app/+not-found.tsx is MISSING'), r.out)
})

test('RED: a ROUTES entry naming a missing app/ file is a stale manifest entry', () => {
  const r = runGate(fixture({ appFiles: SCAFFOLD_APP_FILES.filter((f) => f !== 'actions.tsx') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("actions: file 'actions' does not exist under apps/mobile/app/"), r.out)
  assert.ok(r.out.includes('stale manifest entry'), r.out)
})

test('RED: malformed allowlist fails LOUD, never open (bad JSON / wrong shape / missing reason)', () => {
  const badJson = runGate(fixture({ allowlist: '{ not json' }))
  assert.equal(badJson.code, 1, badJson.out)
  assert.ok(badJson.out.includes('not valid JSON'), badJson.out)

  const wrongShape = runGate(fixture({ allowlist: { dirs: ['sign-in'] } }))
  assert.equal(wrongShape.code, 1, wrongShape.out)
  assert.ok(wrongShape.out.includes('"allow" ARRAY'), wrongShape.out)

  const noReason = runGate(
    fixture({ allowlist: allowlistWith((a) => a.allow.push({ name: 'sign-in' })) }),
  )
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('every allow entry must be'), noReason.out)
})

test('RED: an allowlist entry naming a missing app/ file is stale', () => {
  const r = runGate(
    fixture({
      allowlist: allowlistWith((a) => a.allow.push({ name: 'ghost', reason: 'long gone chrome' })),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('allowlists "ghost"'), r.out)
  assert.ok(r.out.includes('stale allowlist entry'), r.out)
})

test('RED: a titleKey the catalog does not carry reds — the tab bar would render the key itself', () => {
  const routes = SHIPPED_ROUTES.replace("titleKey: 'route.home'", "titleKey: 'route.hoem'")
  assert.notEqual(routes, SHIPPED_ROUTES, 'fixture replacement must hit')
  const r = runGate(fixture({ routes }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("titleKey 'route.hoem' is not a key"), r.out)
})

test('GREEN: without the locale seam, titleKeys go unchecked (a project is not forced onto i18n)', () => {
  const routes = SHIPPED_ROUTES.replace("titleKey: 'route.home'", "titleKey: 'route.hoem'")
  const r = runGate(fixture({ routes, catalog: null }))
  assert.equal(r.code, 0, r.out)
})

test('RED: duplicate paths and reused state test ids red naming both owners', () => {
  const dupPath = runGate(
    fixture({ routes: SHIPPED_ROUTES.replace("path: '/matrix'", "path: '/'") }),
  )
  assert.equal(dupPath.code, 1, dupPath.out)
  assert.ok(dupPath.out.includes('duplicate path'), dupPath.out)
  assert.ok(dupPath.out.includes('also declared by "home"'), dupPath.out)

  const reusedId = runGate(
    fixture({ routes: SHIPPED_ROUTES.replace("loading: 'matrix-loading'", "loading: 'home-loading'") }),
  )
  assert.equal(reusedId.code, 1, reusedId.out)
  assert.ok(reusedId.out.includes('already used by home.loading'), reusedId.out)
  assert.ok(reusedId.out.includes('globally unique'), reusedId.out)
})

test('unreachableStates: a null state needs a reviewed row; the row goes stale when the state returns', () => {
  const nullState = SHIPPED_ROUTES.replace("error: 'actions-error'", 'error: null')
  assert.notEqual(nullState, SHIPPED_ROUTES, 'fixture replacement must hit')

  // (a) null with no documented reason — red.
  const undocumented = runGate(fixture({ routes: nullState }))
  assert.equal(undocumented.code, 1, undocumented.out)
  assert.ok(undocumented.out.includes('states.error is null with no documented reason'), undocumented.out)

  // (b) the same null with a reviewed {route, state, reason} row — green.
  const documented = allowlistWith((a) => {
    a.unreachableStates.push({
      route: 'actions',
      state: 'error',
      reason: 'static in-process registry: the query cannot fail',
    })
  })
  const green = runGate(fixture({ routes: nullState, allowlist: documented }))
  assert.equal(green.code, 0, green.out)

  // (c) the row against a REAL test id — the state became reachable, the row is stale.
  const stale = runGate(fixture({ allowlist: documented }))
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes('the state became reachable'), stale.out)
})

test('skip asymmetry: no mobile surface → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-routegate-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
