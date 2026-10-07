// The importer index (template/base/tools/lib/importers.mjs, 2.1.0, #186): who imports each
// export, read textually over comment-blanked source. No parser, so every case runs in every
// lane. The forms: named, aliased, default, namespace, through a barrel, `import type`,
// dynamic `import()`, and test-only importers, which do not count. Also the names a module
// exports its own binding under, and conditional `exports` maps.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildImporters } from '../../template/base/tools/lib/importers.mjs'
import { inTree, pkg } from './helpers/single-home.mjs'

const TREE = {
  'packages/p/package.json': pkg('@app/p', [], { '.': './src/index.ts', './client': { types: './src/client.ts', default: './src/client.js' } }),
  'packages/p/src/m.ts': `
export function alpha(): number { return 1 }
export function beta(): number { return 2 }
export interface Shape { readonly id: string }
export default function Main(): number { return 3 }
`,
  'packages/p/src/n.ts': 'export const gamma = (): number => 4\n',
  'packages/p/src/index.ts': "export { alpha, beta as renamed } from './m'\nexport * from './n'\n",
  'packages/p/src/client.ts': "export { gamma } from './n'\n",
  'packages/p/src/use.ts': `
// import { beta } from './m' is a comment, not an import
import { alpha as first } from './m.js'
import Main, { type Shape } from './m'
import * as everything from './n'
export const run = (s: Shape) => first() + Main() + everything.gamma() + s.id.length
`,
  'packages/p/src/kinds.ts': "import type { Shape } from './m'\nexport const k = (s: Shape): string => s.id\n",
  'packages/p/src/lazy.ts': "export async function later() { return (await import('./n')).gamma() }\n",
  'packages/p/src/m.test.ts': "import { beta } from './m'\nexport const t = beta()\n",
  'packages/p/src/__tests__/x.ts': "import { beta } from '../m'\nexport const x = beta()\n",
  'apps/web/package.json': pkg('web', ['@app/p']),
  'apps/web/lib/a.ts': "import { renamed } from '@app/p'\nimport type { Shape } from '@app/p/m'\nexport const a = renamed()\n",
  'apps/web/e2e/flow.ts': "import { alpha } from '@app/p'\nexport const f = alpha()\n",
}

test('importers: named, aliased, default and type imports count, each with its local name', () => {
  inTree(TREE, () => {
    const idx = buildImporters()
    assert.deepEqual(idx.importersOf('packages/p/src/m.ts', 'alpha'), [
      { file: 'packages/p/src/use.ts', workspace: '@app/p', locals: ['first'] },
    ])
    assert.deepEqual(idx.importersOf('packages/p/src/m.ts', 'default'), [
      { file: 'packages/p/src/use.ts', workspace: '@app/p', locals: ['Main'] },
    ])
    // `import type { Shape }` (kinds.ts) and the inline `import Main, { type Shape }` (use.ts).
    assert.deepEqual(idx.importersOf('packages/p/src/m.ts', 'Shape'), [
      { file: 'packages/p/src/kinds.ts', workspace: '@app/p', locals: ['Shape'] },
      { file: 'packages/p/src/use.ts', workspace: '@app/p', locals: ['Shape'] },
    ])
  })
})

test('importers: a re-export through a barrel counts at the defining module, not the barrel', () => {
  inTree(TREE, () => {
    const idx = buildImporters()
    assert.deepEqual(idx.importersOf('packages/p/src/m.ts', 'beta'), [
      { file: 'apps/web/lib/a.ts', workspace: 'web', locals: ['renamed'] },
    ])
    assert.equal(idx.isBarrel('packages/p/src/index.ts'), true)
    assert.equal(idx.isBarrel('packages/p/src/use.ts'), false)
  })
})

test('importers: a namespace import and a dynamic import() import every export', () => {
  inTree(TREE, () => {
    const idx = buildImporters()
    assert.deepEqual(idx.importersOf('packages/p/src/n.ts', 'gamma'), [
      { file: 'packages/p/src/lazy.ts', workspace: '@app/p', locals: ['gamma'] },
      { file: 'packages/p/src/use.ts', workspace: '@app/p', locals: ['everything.gamma'] },
    ])
  })
})

test('importers: test files, __tests__/ and e2e/ are not importers', () => {
  inTree(TREE, () => {
    const idx = buildImporters()
    assert.ok(idx.importersOf('packages/p/src/m.ts', 'beta').every((i) => !/test|e2e/.test(i.file)))
    assert.deepEqual(
      idx.importersOf('packages/p/src/m.ts', 'alpha').map((i) => i.file),
      ['packages/p/src/use.ts'],
    )
  })
})

test('importers: @app specifiers resolve through the exports map; an unmapped subpath does not', () => {
  inTree(TREE, () => {
    const idx = buildImporters()
    assert.equal(idx.resolve('apps/web/lib/a.ts', '@app/p'), 'packages/p/src/index.ts')
    assert.equal(idx.resolve('apps/web/lib/a.ts', '@app/p/client'), 'packages/p/src/client.ts')
    assert.equal(idx.resolve('apps/web/lib/a.ts', '@app/p/m'), null)
    assert.equal(idx.resolve('apps/web/lib/a.ts', 'react'), null)
    assert.deepEqual(idx.exposedVia('packages/p/src/n.ts', 'gamma'), [
      { pkg: '@app/p', spec: '@app/p', name: 'gamma' },
      { pkg: '@app/p', spec: '@app/p/client', name: 'gamma' },
    ])
    assert.deepEqual(idx.exposedVia('packages/p/src/m.ts', 'beta'), [
      { pkg: '@app/p', spec: '@app/p', name: 'renamed' },
    ])
    assert.equal(idx.workspaceOf('apps/web/lib/a.ts')?.deps.has('@app/p'), true)
  })
})

test('importers: the name a default export binds', () => {
  inTree(
    {
      'packages/q/package.json': pkg('@app/q'),
      'packages/q/src/a.ts': 'function local() { return 1 }\nexport default local\n',
      'packages/q/src/b.ts': 'export default async function named() { return 1 }\n',
      'packages/q/src/c.ts': 'export default () => 1\n',
    },
    () => {
      const idx = buildImporters()
      assert.equal(idx.defaultName('packages/q/src/a.ts'), 'local')
      assert.equal(idx.defaultName('packages/q/src/b.ts'), 'named')
      assert.equal(idx.defaultName('packages/q/src/c.ts'), null)
    },
  )
})

test('importers: the names a module exports its own binding under, and their importers merged', () => {
  inTree(
    {
      'packages/q/package.json': pkg('@app/q'),
      'packages/q/src/alias.ts': 'function impl() { return 1 }\nexport { impl as renamed }\n',
      'packages/q/src/as-default.ts': 'function impl() { return 1 }\nexport { impl as default }\n',
      'packages/q/src/default-of.ts': 'const impl = () => 1\nexport default impl\n',
      'packages/q/src/both.ts': 'export function both() { return 1 }\nexport default both\n',
      'packages/q/src/anon.ts': 'export default class { run() { return 1 } }\n',
      'packages/q/src/plain.ts': 'export function plain() { return 1 }\nfunction hidden() { return 2 }\n',
      'packages/q/src/u1.ts': "import both from './both'\nexport const u = both()\n",
      'packages/q/src/u2.ts': "import { both } from './both'\nimport { renamed } from './alias'\nexport const u = both() + renamed()\n",
      'packages/q/src/u3.ts': "import b, { both as again } from './both'\nexport const u = b() + again()\n",
    },
    () => {
      const idx = buildImporters()
      assert.deepEqual(idx.exportedAs('packages/q/src/alias.ts', 'impl'), ['renamed'])
      assert.deepEqual(idx.exportedAs('packages/q/src/as-default.ts', 'impl'), ['default'])
      assert.deepEqual(idx.exportedAs('packages/q/src/default-of.ts', 'impl'), ['default'])
      assert.deepEqual(idx.exportedAs('packages/q/src/both.ts', 'both'), ['both', 'default'])
      assert.deepEqual(idx.exportedAs('packages/q/src/anon.ts', 'default'), ['default'])
      assert.deepEqual(idx.exportedAs('packages/q/src/plain.ts', 'plain'), ['plain'])
      assert.deepEqual(idx.exportedAs('packages/q/src/plain.ts', 'hidden'), [])
      assert.equal(idx.defaultName('packages/q/src/as-default.ts'), 'impl')
      // A default importer and two named ones: three files, one binding.
      assert.deepEqual(idx.importersOfLocal('packages/q/src/both.ts', 'both'), [
        { file: 'packages/q/src/u1.ts', workspace: '@app/q', locals: ['both'] },
        { file: 'packages/q/src/u2.ts', workspace: '@app/q', locals: ['both'] },
        { file: 'packages/q/src/u3.ts', workspace: '@app/q', locals: ['again', 'b'] },
      ])
      assert.deepEqual(
        idx.importersOfLocal('packages/q/src/alias.ts', 'impl').map((i) => i.file),
        ['packages/q/src/u2.ts'],
      )
    },
  )
})

test('importers: a module that imports a name and re-exports it is followed, and is not its importer', () => {
  const tree = {
    'packages/a/package.json': pkg('@app/a'),
    'packages/a/src/m.ts': 'export function eventOf() { return 1 }\nexport default function Main() { return 2 }\n',
    'packages/a/src/ns.ts': 'export const one = () => 1\n',
    'packages/a/src/index.ts':
      "import { eventOf } from './m'\nimport Main from './m'\nimport * as spaced from './ns'\nexport { eventOf, spaced }\nexport default Main\n",
    'packages/a/src/uses.ts': "import { eventOf } from './m'\nexport { eventOf as again }\nexport const n = eventOf()\n",
    'packages/b/package.json': pkg('@app/b', ['@app/a']),
    'packages/b/src/u1.ts': "import Main, { eventOf, spaced } from '@app/a'\nexport const u = eventOf() + Main() + spaced.one()\n",
    'packages/b/src/u2.ts': "import { eventOf } from '@app/a'\nexport const u = eventOf()\n",
  }
  inTree(tree, () => {
    const idx = buildImporters()
    // index.ts only forwards; uses.ts forwards AND calls it, so it is an importer.
    assert.deepEqual(
      idx.importersOf('packages/a/src/m.ts', 'eventOf').map((i) => i.file),
      ['packages/a/src/uses.ts', 'packages/b/src/u1.ts', 'packages/b/src/u2.ts'],
    )
    assert.deepEqual(idx.importersOf('packages/a/src/index.ts', 'eventOf'), [])
    assert.deepEqual(
      idx.importersOf('packages/a/src/m.ts', 'default').map((i) => i.file),
      ['packages/b/src/u1.ts'],
    )
    assert.deepEqual(idx.importersOf('packages/a/src/ns.ts', 'one'), [
      { file: 'packages/b/src/u1.ts', workspace: '@app/b', locals: ['spaced'] },
    ])
    assert.deepEqual(idx.exposedVia('packages/a/src/m.ts', 'eventOf'), [
      { pkg: '@app/a', spec: '@app/a', name: 'eventOf' },
    ])
  })
})

test('importers: a forwarded name with a `$` counts as used only where it stands as a whole identifier', () => {
  const tree = {
    'packages/a/package.json': pkg('@app/a'),
    'packages/a/src/m.ts': 'export const $store = { get: () => 1 }\nexport const a$b = () => 2\n',
    // Only forwards: each name appears again only as a property or inside a longer name.
    'packages/a/src/index.ts':
      "import { $store, a$b } from './m'\nexport { $store, a$b }\nexport const k = obj.$store + x$store + a$bc\n",
    // Forwards AND uses each, so it is an importer of both.
    'packages/a/src/uses.ts': "import { $store, a$b } from './m'\nexport { $store as s, a$b as ab }\nexport const v = $store.get() + a$b()\n",
  }
  inTree(tree, () => {
    const idx = buildImporters()
    for (const name of ['$store', 'a$b']) {
      assert.deepEqual(
        idx.importersOf('packages/a/src/m.ts', name).map((i) => i.file),
        ['packages/a/src/uses.ts'],
        name,
      )
    }
  })
})

test('importers: an exports map of top-level conditions is the `.` entry, and a .d.ts target falls through', () => {
  const tree = {
    'packages/a/package.json': pkg('@app/a', [], { types: './src/index.ts', default: './src/index.ts' }),
    'packages/a/src/index.ts': "export { eventOf } from './m'\n",
    'packages/a/src/m.ts': 'export function eventOf() { return 1 }\n',
    'packages/c/package.json': pkg('@app/c', [], { '.': { types: './dist/index.d.ts', import: './src/index.ts' } }),
    'packages/c/src/index.ts': 'export function g() { return 1 }\n',
    'packages/b/package.json': pkg('@app/b', ['@app/a', '@app/c']),
    'packages/b/src/u.ts': "import { eventOf } from '@app/a'\nimport { g } from '@app/c'\nexport const u = eventOf() + g()\n",
  }
  inTree(tree, () => {
    const idx = buildImporters()
    assert.equal(idx.resolve('packages/b/src/u.ts', '@app/a'), 'packages/a/src/index.ts')
    assert.equal(idx.resolve('packages/b/src/u.ts', '@app/c'), 'packages/c/src/index.ts')
    assert.deepEqual(idx.importersOf('packages/a/src/m.ts', 'eventOf').map((i) => i.file), ['packages/b/src/u.ts'])
    assert.deepEqual(idx.importersOf('packages/c/src/index.ts', 'g').map((i) => i.file), ['packages/b/src/u.ts'])
    assert.deepEqual(idx.exposedVia('packages/a/src/m.ts', 'eventOf'), [
      { pkg: '@app/a', spec: '@app/a', name: 'eventOf' },
    ])
  })
})

test('importers: the module graph: what a module reaches through imports, type-only and re-exports included', () => {
  const tree = {
    'packages/c/package.json': pkg('@app/c'),
    'packages/c/src/x.ts': "import { helper } from './y'\nexport const x = helper\n",
    'packages/c/src/y.ts': "import type { Z } from './z'\nexport const helper = (z: Z) => z\n",
    'packages/c/src/z.ts': "export * from './w'\nexport interface Z { readonly id: string }\n",
    'packages/c/src/w.ts': 'export const w = 1\n',
  }
  inTree(tree, () => {
    const idx = buildImporters()
    assert.equal(idx.reaches('packages/c/src/x.ts', 'packages/c/src/w.ts'), true)
    assert.equal(idx.reaches('packages/c/src/y.ts', 'packages/c/src/z.ts'), true)
    assert.equal(idx.reaches('packages/c/src/w.ts', 'packages/c/src/x.ts'), false)
    assert.equal(idx.reaches('packages/c/src/x.ts', 'packages/c/src/x.ts'), true)
  })
})
