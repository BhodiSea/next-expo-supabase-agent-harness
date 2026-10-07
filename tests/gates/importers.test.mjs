// The importer index (template/base/tools/lib/importers.mjs, 2.1.0, #186): who imports each
// export, read textually over comment-blanked source. No parser, so every case runs in every
// lane. The forms: named, aliased, default, namespace, through a barrel, `import type`,
// dynamic `import()`, and test-only importers, which do not count.
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
    assert.deepEqual(
      idx.importersOf('packages/p/src/m.ts', 'Shape').map((i) => i.file),
      ['packages/p/src/use.ts'],
    )
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
