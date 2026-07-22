import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorkspaceYaml } from '../../installer/lib/merge-workspace-yaml.mjs'

const INCOMING = `packages:
  - 'apps/*'
  - 'packages/*'
catalog:
  typescript: 6.0.3
  zod: 4.1.8
`

test('missing globs are unioned in, existing preserved byte-for-byte', () => {
  const existing = `packages:\n  - 'apps/*'\n  - 'services/legacy'\n`
  const res = mergeWorkspaceYaml(existing, INCOMING)
  assert.ok(res)
  assert.match(res.merged, /- 'services\/legacy'/)
  assert.match(res.merged, /- 'packages\/\*'/)
  assert.equal((res.merged.match(/- 'apps\/\*'/g) ?? []).length, 1, 'no duplicate glob')
})

test('catalog pins added only when missing — never downgrades a project pin', () => {
  const existing = `packages:\n  - 'apps/*'\n  - 'packages/*'\ncatalog:\n  typescript: 6.1.0\n`
  const res = mergeWorkspaceYaml(existing, INCOMING)
  assert.ok(res)
  assert.match(res.merged, /typescript: 6\.1\.0/)
  assert.ok(!res.merged.includes('typescript: 6.0.3'), 'project pin kept')
  assert.match(res.merged, /zod: 4\.1\.8/)
  assert.ok(res.report.some((r) => r.kind === 'catalog-mismatch' && r.name === 'typescript'))
})

test('file without catalog section gains one', () => {
  const existing = `packages:\n  - 'apps/*'\n  - 'packages/*'\n`
  const res = mergeWorkspaceYaml(existing, INCOMING)
  assert.ok(res)
  assert.match(res.merged, /catalog:\n {2}typescript: 6\.0\.3\n {2}zod: 4\.1\.8/)
})

test('exotic YAML (anchors/flow style) refuses to merge instead of guessing', () => {
  assert.equal(mergeWorkspaceYaml(`packages: ['apps/*']\n`, INCOMING), null)
  assert.equal(mergeWorkspaceYaml(`defaults: &d\n  x: 1\npackages:\n  - 'apps/*'\n`, INCOMING), null)
})

test('comments and unknown scalar keys survive untouched', () => {
  const existing = `# team workspace\npackages:\n  - 'apps/*'\n  - 'packages/*'\nshared-workspace-lockfile: true\ncatalog:\n  zod: 4.1.8\n`
  const res = mergeWorkspaceYaml(existing, INCOMING)
  assert.ok(res)
  assert.match(res.merged, /# team workspace/)
  assert.match(res.merged, /shared-workspace-lockfile: true/)
  assert.match(res.merged, /typescript: 6\.0\.3/)
})
