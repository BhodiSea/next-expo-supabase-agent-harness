// Can-fail proofs for the boundaries gate (the two census consumers,
// template/base/tools/check-exports-walls.mjs + check-workspace-deps.mjs). Both derive
// from the ONE census tools/exports-walls.json. Fixture-driven: build a scaffold-shaped
// workspace, run the real gate with cwd inside it, assert the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// The minimal anatomy-law-compliant barrels every fixture vertical gets by default —
// the anatomy section (0.9.5) reds a vertical with no barrels, and these tests are
// about OTHER walls unless they opt into anatomy fixtures via `files`.
const COMPLIANT_BARRELS = (rel) => [
  [`packages/${rel}/src/index.ts`, "export * from './client.js'\n"],
  [`packages/${rel}/src/client.ts`, "export { thing } from './things.js'\n"],
]

/**
 * Fixture manifests are deliberately arbitrary shapes — each test varies one field to
 * make one wall red — so they are typed loosely on purpose. `files` are extra
 * [repoRelPath, content] pairs written verbatim AFTER the default vertical barrels,
 * so a test can overwrite a barrel with a violating body.
 * @param {{ census?: any, packages?: any[][], mobile?: any, web?: any, files?: [string, string][] }} [opts]
 */
function fixture({ census = CENSUS, packages = PACKAGES, mobile = MOBILE, web = WEB, files = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-bounds-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/exports-walls.json'), JSON.stringify(census, null, 2))
  for (const [rel, manifest] of packages) {
    const p = join(dir, 'packages', rel, 'package.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(manifest, null, 2))
    if (rel.startsWith('verticals/')) {
      for (const [f, content] of COMPLIANT_BARRELS(rel)) {
        mkdirSync(join(dir, dirname(f)), { recursive: true })
        writeFileSync(join(dir, f), content)
      }
    }
  }
  for (const [f, content] of files) {
    mkdirSync(join(dir, dirname(f)), { recursive: true })
    writeFileSync(join(dir, f), content)
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

// ── vertical anatomy + intra-vertical layering (0.9.5, boundaries part 3) ────────
// No .harness/manifest.json in these fixtures, so the ramp runs LIVE (the check-live
// arm of rampNote) — findings are fatal, which is the fresh-scaffold posture.

const N = 'verticals/notes'

test('GREEN: the default compliant vertical passes anatomy (the witness shape)', () => {
  const r = run(WORKSPACE_DEPS, fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('anatomy-clean'), r.out)
})

test('RED anatomy: a domain file importing node:fs (domain purity)', () => {
  const files = [
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('domain-purity') && r.out.includes('node:fs'), r.out)
})

test('RED anatomy: a domain file importing the error kernel (domain returns values)', () => {
  const files = [
    [`packages/${N}/src/domain/note.ts`, "import { appError } from '@app/errors'\nexport const x = 1\n"],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('domain-purity') && r.out.includes('@app/errors'), r.out)
})

test('RED anatomy: a DAL file value-importing @app/supabase; import type stays clean', () => {
  const violating = fixture({
    files: [
      [`packages/${N}/src/data/port.ts`, 'export interface Db { from(t: string): unknown }\n'],
      [`packages/${N}/src/data/notes.ts`, "import { createBrowserSupabaseClient } from '@app/supabase/client'\nexport const q = 1\n"],
    ],
  })
  const red = run(WORKSPACE_DEPS, violating)
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('dal-client-value-import'), red.out)

  const typeOnly = fixture({
    files: [
      [`packages/${N}/src/data/port.ts`, 'export interface Db { from(t: string): unknown }\n'],
      [`packages/${N}/src/data/notes.ts`, "import type { SupabaseServerClient } from '@app/supabase'\nexport const q = 1\n"],
    ],
  })
  const green = run(WORKSPACE_DEPS, typeOnly)
  assert.equal(green.code, 0, green.out)
})

test('RED anatomy: src/data without a port (port presence)', () => {
  const files = [[`packages/${N}/src/data/notes.ts`, 'export const q = 1\n']]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('port-presence'), r.out)
})

test('RED anatomy: a vertical missing the ./client export key (dual barrel)', () => {
  const packages = PACKAGES.map((p) =>
    p[0] === N ? [N, { ...p[1], exports: { '.': './src/index.ts' } }] : p,
  )
  const r = run(WORKSPACE_DEPS, fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('dual-barrel') && r.out.includes('./client'), r.out)
})

test('RED anatomy: logic in a barrel (pure barrel)', () => {
  const files = [
    [`packages/${N}/src/client.ts`, "export { thing } from './things.js'\nconst leaked = 1\n"],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('pure-barrel'), r.out)
})

test('RED anatomy: events.ts importing from the vertical (events purity)', () => {
  const files = [
    [`packages/${N}/src/events.ts`, "import { defineEventCatalog } from '@app/events'\nimport { toNoteView } from './domain/note.js'\nexport const e = 1\n"],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('events-purity'), r.out)
})

test("RED anatomy: select('*') in a DAL file; the same text in a COMMENT stays clean", () => {
  const red = run(
    WORKSPACE_DEPS,
    fixture({
      files: [
        [`packages/${N}/src/data/port.ts`, 'export interface Db { x: 1 }\n'],
        [`packages/${N}/src/data/notes.ts`, "export const q = db.from(T).select('*')\n"],
      ],
    }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('select-star'), red.out)

  const green = run(
    WORKSPACE_DEPS,
    fixture({
      files: [
        [`packages/${N}/src/data/port.ts`, 'export interface Db { x: 1 }\n'],
        [`packages/${N}/src/data/notes.ts`, "// select('*') is banned here\nexport const q = 1\n"],
      ],
    }),
  )
  assert.equal(green.code, 0, green.out)
})

test('GREEN anatomy: a reviewed allow entry suppresses exactly its finding', () => {
  const allow = {
    comment: 'x',
    allow: [
      {
        package: '@app/notes',
        law: 'domain-purity',
        path: 'src/domain/note.ts',
        reason: 'fixture-only escape proving the allow file suppresses a single reviewed finding',
        reviewedOn: '2026-08-11',
      },
    ],
  }
  const files = [
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
    ['tools/vertical-anatomy-allow.json', JSON.stringify(allow, null, 2)],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 0, r.out)
})

test('RED anatomy: a stale allow entry (matches nothing) reds — closed both ways', () => {
  const allow = {
    comment: 'x',
    allow: [
      {
        package: '@app/notes',
        law: 'select-star',
        reason: 'this entry matches no live finding and must red as stale, proving two-way closure',
        reviewedOn: '2026-08-11',
      },
    ],
  }
  const r = run(
    WORKSPACE_DEPS,
    fixture({ files: [['tools/vertical-anatomy-allow.json', JSON.stringify(allow, null, 2)]] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('stale'), r.out)
})

test('RED anatomy: an allow entry with a short reason fails loud', () => {
  const allow = { comment: 'x', allow: [{ package: '@app/notes', law: 'select-star', reason: 'meh', reviewedOn: '2026-08-11' }] }
  const r = run(
    WORKSPACE_DEPS,
    fixture({ files: [['tools/vertical-anatomy-allow.json', JSON.stringify(allow, null, 2)]] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('40 characters'), r.out)
})

test('RED anatomy: verticals present but zero files scanned is vacuous (anti-vacuity, never ramped)', () => {
  // A vertical whose package.json exists with NO src files at all: fixture() writes
  // compliant barrels for every vertical by default, so strip them back off — if every
  // vertical is hollow the scan sees 0 files and must hard-fail, ramp or no ramp.
  const packages = [
    ...PACKAGES.filter((p) => !p[0].startsWith('verticals/')),
    ['verticals/hollow', { name: '@app/hollow', exports: { '.': './src/index.ts', './client': './src/client.ts' } }],
  ]
  const dir = fixture({ packages })
  rmSync(join(dir, 'packages/verticals/hollow/src'), { recursive: true, force: true })
  const r = run(WORKSPACE_DEPS, dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ZERO files') && r.out.includes('anti-vacuity'), r.out)
})

test('NOTE: a pre-0.9.5 install sees anatomy findings as advisory NOTEs (the ramp)', () => {
  const files = [
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
    ['.harness/manifest.json', JSON.stringify({ baseVersion: '0.9.0', harnessVersion: '0.9.0' })],
  ]
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE') && r.out.includes('domain-purity'), r.out)
})
