// Can-fail proofs for the boundaries gate (the two census consumers,
// template/base/tools/check-exports-walls.mjs + check-workspace-deps.mjs). Both derive
// from the ONE census tools/exports-walls.json. Fixture-driven: build a scaffold-shaped
// workspace, run the real gate with cwd inside it, assert the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
/** @type {[string, any][]} */
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
/** @returns {[string, string][]} */
const COMPLIANT_BARRELS = (rel) => [
  [`packages/${rel}/src/index.ts`, "export * from './client.js'\n"],
  [`packages/${rel}/src/client.ts`, "export { thing } from './things.js'\n"],
]

/**
 * Fixture manifests are deliberately arbitrary shapes — each test varies one field to
 * make one wall red — so they are typed loosely on purpose. `files` are extra
 * [repoRelPath, content] pairs written verbatim AFTER the default vertical barrels,
 * so a test can overwrite a barrel with a violating body.
 * @param {{ census?: any, packages?: [string, any][], mobile?: any, web?: any, files?: [string, string][], modules?: any }} [opts]
 */
function fixture({
  census = CENSUS,
  packages = PACKAGES,
  mobile = MOBILE,
  web = WEB,
  files = [],
  modules = { modules: ['e2ee'], retired: [] },
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-bounds-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, 'tools/exports-walls.json'), JSON.stringify(census, null, 2))
  // The owned module list (1.0.0) — staged by default because a real tree always
  // has it (it ships with the release); `modules: null` simulates the broken tree.
  if (modules !== null) writeFileSync(join(dir, 'tools/modules.json'), JSON.stringify(modules, null, 2))
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
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES,
    [
      'platform/rogue',
      { name: '@app/rogue', exports: { '.': './src/index.ts', './client': './src/client.ts' } },
    ],
  ])
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

// ── module-provided packages (0.9.5) ────────────────────────────────────────────
// A census entry may name a package that only exists when its opt-in module is
// enabled. Without this, censusing a module package would red `boundaries` on
// every install that skipped the module — a gate punishing a consumer for a
// choice the harness offered them. The manifest is the module-state authority.

const MODULE_CENSUS = {
  comment: 'x',
  sanctioned: [
    ...CENSUS.sanctioned,
    { package: '@app/crypto', module: 'e2ee', reason: R('provided by the opt-in e2ee module') },
  ],
}

test('GREEN: a module-provided sanction is DORMANT while its module is disabled', () => {
  const dir = fixture({ census: MODULE_CENSUS })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: '0.9.5', harnessVersion: '0.9.5', modules: [] }),
  )
  const r = run(EXPORTS_WALLS, dir)
  assert.equal(r.code, 0, r.out)
})

test('RED: the same sanction is STALE once its module is ENABLED but the package is absent', () => {
  const dir = fixture({ census: MODULE_CENSUS })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: '0.9.5', harnessVersion: '0.9.5', modules: ['e2ee'] }),
  )
  const r = run(EXPORTS_WALLS, dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/crypto') && r.out.includes("'e2ee' module"), r.out)
})

test('RED: a sanction with a blank module value cannot silently disable the stale arm', () => {
  const census = {
    comment: 'x',
    sanctioned: [...CENSUS.sanctioned, { package: '@app/ghost', module: '  ', reason: R() }],
  }
  const r = run(EXPORTS_WALLS, fixture({ census }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not a non-empty string'), r.out)
})

test('GREEN: a plain (module-less) sanction whose package EXISTS is unaffected by module state', () => {
  const r = run(EXPORTS_WALLS, fixture())
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a sanctioned package that ships only "." is fine (MAY, not MUST)', () => {
  // @app/observability shape: sanctioned, single "." barrel.
  const census = {
    comment: 'x',
    sanctioned: [...CENSUS.sanctioned, { package: '@app/observability', reason: R() }],
  }
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES,
    ['platform/observability', { name: '@app/observability', exports: { '.': './src/index.ts' } }],
  ])
  const r = run(EXPORTS_WALLS, fixture({ census, packages }))
  assert.equal(r.code, 0, r.out)
})

// ── the module-name closure (1.0.0, the exports-walls-module-name-validation discharge) ──

test('RED: a sanction naming a module no release ships — the typo can no longer park the stale arm', () => {
  const census = {
    comment: 'x',
    sanctioned: [
      ...CENSUS.sanctioned,
      { package: '@app/ghost', module: 'e2e', reason: R('a typo of e2ee — the defect the closure exists for') },
    ],
  }
  const r = run(EXPORTS_WALLS, fixture({ census }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("'e2e'") && r.out.includes('no release of this harness ships'), r.out)
})

test('RED: a sanction naming a RETIRED module is told the module is gone, not that it never existed', () => {
  const census = {
    comment: 'x',
    sanctioned: [...CENSUS.sanctioned, { package: '@app/old', module: 'legacy-sync', reason: R() }],
  }
  const r = run(
    EXPORTS_WALLS,
    fixture({ census, modules: { modules: ['e2ee'], retired: ['legacy-sync'] } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RETIRED'), r.out)
})

test('NOTE: an unknown module name ramps for a pre-1.0.0 install until 1.1.0', () => {
  const census = {
    comment: 'x',
    sanctioned: [...CENSUS.sanctioned, { package: '@app/ghost', module: 'e2e', reason: R() }],
  }
  const dir = fixture({ census })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: '0.11.1', harnessVersion: '0.11.1', modules: [] }),
  )
  const r = run(EXPORTS_WALLS, dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE') && r.out.includes("'e2e'"), r.out)
})

test('RED: a missing tools/modules.json is a broken tree — the owned list fails closed naming update', () => {
  const r = run(EXPORTS_WALLS, fixture({ modules: null }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/modules.json') && r.out.includes('update'), r.out)
})

test('RED: a malformed module list cannot close the census', () => {
  const r = run(EXPORTS_WALLS, fixture({ modules: { modules: 'e2ee', retired: [] } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('non-empty strings'), r.out)
})

test('LOCKSTEP: the shipped tools/modules.json is set-equal to the installer MODULES list', async () => {
  const layout = await import('../../installer/lib/layout.mjs')
  const shipped = JSON.parse(
    readFileSync(new URL('../../template/base/tools/modules.json', import.meta.url), 'utf8'),
  )
  assert.deepEqual(
    [...shipped.modules].sort(),
    [...layout.MODULES].sort(),
    'tools/modules.json is the shipped copy of installer/lib/layout.mjs MODULES — they move in one diff',
  )
  assert.deepEqual(
    [...shipped.retired].sort(),
    [...layout.RETIRED_MODULES.keys()].sort(),
    'the retired list mirrors RETIRED_MODULES the same way',
  )
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
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES,
    ['design-system', { name: '@app/design-system', exports: { '.': './src/index.ts' } }],
  ])
  const mobile = {
    name: 'mobile',
    dependencies: { '@app/errors': 'workspace:*', '@app/design-system': 'workspace:*' },
  }
  const r = run(WORKSPACE_DEPS, fixture({ packages, mobile }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/design-system') && r.out.includes('web-only'), r.out)
})

test('RED: apps/web depends on the mobile-only design system', () => {
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES,
    [
      'design-system-native',
      { name: '@app/design-system-native', exports: { '.': './src/index.ts' } },
    ],
  ])
  const web = {
    name: 'web',
    dependencies: { '@app/errors': 'workspace:*', '@app/design-system-native': 'workspace:*' },
  }
  const r = run(WORKSPACE_DEPS, fixture({ packages, web }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@app/design-system-native') && r.out.includes('RN-only'), r.out)
})

test('RED: a vertical depends on another vertical', () => {
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES,
    ['verticals/orders', { name: '@app/orders', exports: { '.': './src/index.ts' } }],
  ])
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
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES,
    [
      'shared/pricing',
      {
        name: '@app/pricing',
        exports: { '.': './src/index.ts' },
        dependencies: { '@app/notes': 'workspace:*' },
      },
    ],
  ])
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
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('domain-purity') && r.out.includes('node:fs'), r.out)
})

test('RED anatomy: a domain file importing the error kernel (domain returns values)', () => {
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/domain/note.ts`, "import { appError } from '@app/errors'\nexport const x = 1\n"],
  ])
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

test('RED anatomy: a PostgREST caller with no port import (port discipline); a call-free data file owes nothing', () => {
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/data/notes.ts`, "export const list = (db) => db.from('notes').select('id')\n"],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('port-presence'), r.out)

  // The 1.0.0 correction of the directory keying's inversion: a src/data/ file that
  // never speaks PostgREST owes no port — it has nothing to receive through one.
  const callFree = fixture({
    files: /** @type {[string, string][]} */ ([[`packages/${N}/src/data/notes.ts`, 'export const q = 1\n']]),
  })
  const green = run(WORKSPACE_DEPS, callFree)
  assert.equal(green.code, 0, green.out)
})

test('RED anatomy: a vertical missing the ./client export key (dual barrel)', () => {
  /** @type {[string, any][]} */
  const packages = PACKAGES.map((p) =>
    p[0] === N ? [N, { ...p[1], exports: { '.': './src/index.ts' } }] : p,
  )
  const r = run(WORKSPACE_DEPS, fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('dual-barrel') && r.out.includes('./client'), r.out)
})

test('RED anatomy: logic in a barrel (pure barrel)', () => {
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/client.ts`, "export { thing } from './things.js'\nconst leaked = 1\n"],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('pure-barrel'), r.out)
})

test('RED anatomy: events.ts importing from the vertical (events purity)', () => {
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/events.ts`, "import { defineEventCatalog } from '@app/events'\nimport { toNoteView } from './domain/note.js'\nexport const e = 1\n"],
  ])
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
        [
          `packages/${N}/src/data/notes.ts`,
          "import type { Db } from './port.js'\nexport const q = (db) => db.from(T).select('*')\n",
        ],
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

// ── the 1.0.0 behavior keying (the folder-name-coupling discharge) ───────────────

test('RED anatomy: a module-scope service-role client in src/repo/ — the folder-name escape, closed', () => {
  // The adversarial fixture from the discharged register row, verbatim in spirit: the
  // 0.9.5 directory keying reported ZERO findings on this tree.
  const files = /** @type {[string, string][]} */ ([
    [
      `packages/${N}/src/repo/db.ts`,
      "import { createServiceRoleClient_BYPASSES_RLS } from '@app/supabase'\nconst db = createServiceRoleClient_BYPASSES_RLS('w')\nexport const q = db.from('notes').select('id')\n",
    ],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('dal-client-value-import') && r.out.includes('src/repo/db.ts'), r.out)
  assert.ok(r.out.includes('port-presence'), r.out)
})

test('GREEN anatomy: a DAL living outside src/data/ with its port beside it (behavior, not names)', () => {
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/repo/port.ts`, 'export interface Db { from(t: string): unknown }\n'],
    [
      `packages/${N}/src/repo/notes.ts`,
      "import type { Db } from './port.js'\nexport const list = (db) => db.from('notes')\n",
    ],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 0, r.out)
})

test('RED anatomy: a PostgREST caller whose port import resolves to no file', () => {
  const files = /** @type {[string, string][]} */ ([
    [
      `packages/${N}/src/repo/notes.ts`,
      "import type { Db } from './port.js'\nexport const list = (db) => db.from('notes')\n",
    ],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('port-presence'), r.out)
})

test('the vintage partition: widened findings NOTE for a 0.9.5-vintage install while armed laws stay hard', () => {
  // baseVersion 0.10.0: at or above the 0.9.5 ramp (inert — domain-purity reds hard),
  // below the 1.0.0 widening (harness 0.11.1 < until 1.1.0 — the src/repo reach NOTEs).
  const files = /** @type {[string, string][]} */ ([
    [
      `packages/${N}/src/repo/db.ts`,
      "import { createBrowserSupabaseClient } from '@app/supabase/client'\nexport const q = 1\n",
    ],
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
    ['.harness/manifest.json', JSON.stringify({ baseVersion: '0.10.0', harnessVersion: '0.11.1' })],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('NOTE — anatomy: @app/notes [dal-client-value-import]'), r.out)
  assert.ok(r.out.includes('domain-purity'), r.out)
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
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
    ['tools/vertical-anatomy-allow.json', JSON.stringify(allow, null, 2)],
  ])
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
  const packages = /** @type {[string, any][]} */ ([
    ...PACKAGES.filter((p) => !p[0].startsWith('verticals/')),
    ['verticals/hollow', { name: '@app/hollow', exports: { '.': './src/index.ts', './client': './src/client.ts' } }],
  ])
  const dir = fixture({ packages })
  rmSync(join(dir, 'packages/verticals/hollow/src'), { recursive: true, force: true })
  const r = run(WORKSPACE_DEPS, dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ZERO files') && r.out.includes('anti-vacuity'), r.out)
})

test('NOTE: a pre-0.9.5 install sees anatomy findings as advisory NOTEs (the ramp)', () => {
  const files = /** @type {[string, string][]} */ ([
    [`packages/${N}/src/domain/note.ts`, "import { readFileSync } from 'node:fs'\nexport const x = 1\n"],
    ['.harness/manifest.json', JSON.stringify({ baseVersion: '0.9.0', harnessVersion: '0.9.0' })],
  ])
  const r = run(WORKSPACE_DEPS, fixture({ files }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE') && r.out.includes('domain-purity'), r.out)
})
