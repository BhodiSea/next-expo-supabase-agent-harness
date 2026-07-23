// Can-fail proofs for the boundaries gate (the two census consumers,
// template/base/tools/check-exports-walls.mjs + check-workspace-deps.mjs). Both derive
// from the ONE census tools/exports-walls.json. Fixture-driven: build a scaffold-shaped
// workspace, run the real gate with cwd inside it, assert the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const EXPORTS_WALLS = fileURLToPath(
  new URL('../../template/base/tools/check-exports-walls.mjs', import.meta.url),
)
const WORKSPACE_DEPS = fileURLToPath(
  new URL('../../template/base/tools/check-workspace-deps.mjs', import.meta.url),
)

const R = (reason = 'x') => reason
const CENSUS = {
  comment: 'test census',
  sanctioned: [
    { package: '@app/supabase', reason: R() },
    { package: '@app/notes', reason: R() },
  ],
}
// [relPathUnderPackages, manifest]
const PACKAGES = [
  ['platform/errors', { name: '@app/errors', exports: { '.': './src/index.ts' } }],
  [
    'platform/supabase',
    {
      name: '@app/supabase',
      exports: { '.': './src/index.ts', './client': './src/client.ts' },
      dependencies: { '@app/errors': 'workspace:*' },
    },
  ],
  [
    'verticals/notes',
    {
      name: '@app/notes',
      exports: { '.': './src/index.ts', './client': './src/client.ts' },
      dependencies: { '@app/errors': 'workspace:*', '@app/supabase': 'workspace:*' },
    },
  ],
]
const MOBILE = {
  name: 'mobile',
  dependencies: { '@app/errors': 'workspace:*', '@app/supabase': 'workspace:*' },
  devDependencies: { '@app/api': 'workspace:*' },
}
const WEB = {
  name: 'web',
  dependencies: {
    '@app/errors': 'workspace:*',
    '@app/supabase': 'workspace:*',
    '@app/notes': 'workspace:*',
  },
}

function fixture({ census = CENSUS, packages = PACKAGES, mobile = MOBILE, web = WEB } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-bounds-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/exports-walls.json'), JSON.stringify(census, null, 2))
  for (const [rel, manifest] of packages) {
    const p = join(dir, 'packages', rel, 'package.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(manifest, null, 2))
  }
  for (const [name, manifest] of [
    ['mobile', mobile],
    ['web', web],
  ]) {
    if (manifest === null) continue
    const p = join(dir, 'apps', name, 'package.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(manifest, null, 2))
  }
  return dir
}

function run(gate, dir) {
  const res = spawnSync('node', [gate], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── check-exports-walls (the ./client census wall) ──────────────────────────────

test('GREEN: every ./client barrel is sanctioned; no stale sanction', () => {
  const r = run(EXPORTS_WALLS, fixture())
  assert.equal(r.code, 0, r.out)
})

test('RED: a package ships ./client without a census entry', () => {
  const packages = [
    ...PACKAGES,
    [
      'platform/rogue',
      { name: '@app/rogue', exports: { '.': './src/index.ts', './client': './src/client.ts' } },
    ],
  ]
  const r = run(EXPORTS_WALLS, fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/rogue') && r.out.includes('NOT sanctioned'), r.out)
})

test('RED: a census entry names a package that does not exist (stale sanction, two-way)', () => {
  const census = {
    comment: 'x',
    sanctioned: [...CENSUS.sanctioned, { package: '@app/ghost', reason: R() }],
  }
  const r = run(EXPORTS_WALLS, fixture({ census }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/ghost') && r.out.includes('stale sanction'), r.out)
})

test('RED: a sanction with an empty reason fails LOUD (the census cannot fail open)', () => {
  const census = {
    comment: 'x',
    sanctioned: [
      { package: '@app/supabase', reason: '' },
      { package: '@app/notes', reason: R() },
    ],
  }
  const r = run(EXPORTS_WALLS, fixture({ census }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('non-empty'), r.out)
})

test('GREEN: a sanctioned package that ships only "." is fine (MAY, not MUST)', () => {
  // @app/observability shape: sanctioned, single "." barrel.
  const census = {
    comment: 'x',
    sanctioned: [...CENSUS.sanctioned, { package: '@app/observability', reason: R() }],
  }
  const packages = [
    ...PACKAGES,
    ['platform/observability', { name: '@app/observability', exports: { '.': './src/index.ts' } }],
  ]
  const r = run(EXPORTS_WALLS, fixture({ census, packages }))
  assert.equal(r.code, 0, r.out)
})

// ── check-workspace-deps (the declared-dependency allow-matrix) ──────────────────

test('GREEN: mobile carries only sanctioned/universal deps; verticals isolated', () => {
  const r = run(WORKSPACE_DEPS, fixture())
  assert.equal(r.code, 0, r.out)
})

test('RED: @app/api as a RUNTIME dependency of apps/mobile', () => {
  const mobile = {
    name: 'mobile',
    dependencies: { '@app/errors': 'workspace:*', '@app/api': 'workspace:*' },
  }
  const r = run(WORKSPACE_DEPS, fixture({ mobile }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/api') && r.out.includes('import type'), r.out)
})

test('RED: apps/mobile depends on a package that is neither sanctioned nor universal', () => {
  const mobile = {
    name: 'mobile',
    dependencies: { '@app/errors': 'workspace:*', '@app/notes': 'workspace:*' },
  }
  // @app/notes is sanctioned so that is fine — use an unsanctioned one:
  mobile.dependencies['@app/observability'] = 'workspace:*'
  const r = run(WORKSPACE_DEPS, fixture({ mobile }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/observability') && r.out.includes('absent from the census'), r.out)
})

test('RED: apps/mobile depends on the web-only design system', () => {
  const packages = [
    ...PACKAGES,
    ['design-system', { name: '@app/design-system', exports: { '.': './src/index.ts' } }],
  ]
  const mobile = {
    name: 'mobile',
    dependencies: { '@app/errors': 'workspace:*', '@app/design-system': 'workspace:*' },
  }
  const r = run(WORKSPACE_DEPS, fixture({ packages, mobile }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/design-system') && r.out.includes('web-only'), r.out)
})

test('RED: apps/web depends on the mobile-only design system', () => {
  const packages = [
    ...PACKAGES,
    [
      'design-system-native',
      { name: '@app/design-system-native', exports: { '.': './src/index.ts' } },
    ],
  ]
  const web = {
    name: 'web',
    dependencies: { '@app/errors': 'workspace:*', '@app/design-system-native': 'workspace:*' },
  }
  const r = run(WORKSPACE_DEPS, fixture({ packages, web }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/design-system-native') && r.out.includes('RN-only'), r.out)
})

test('RED: a vertical depends on another vertical', () => {
  const packages = [
    ...PACKAGES,
    ['verticals/orders', { name: '@app/orders', exports: { '.': './src/index.ts' } }],
  ]
  // make notes depend on orders
  packages[2] = [
    'verticals/notes',
    {
      name: '@app/notes',
      exports: { '.': './src/index.ts', './client': './src/client.ts' },
      dependencies: { '@app/errors': 'workspace:*', '@app/orders': 'workspace:*' },
    },
  ]
  const r = run(WORKSPACE_DEPS, fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('another vertical'), r.out)
})

test('RED: a shared package depends on a vertical', () => {
  const packages = [
    ...PACKAGES,
    [
      'shared/pricing',
      {
        name: '@app/pricing',
        exports: { '.': './src/index.ts' },
        dependencies: { '@app/notes': 'workspace:*' },
      },
    ],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('shared') && r.out.includes('never the reverse'), r.out)
})
