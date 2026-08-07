// dependencyObligations (0.5.0) — the channel that carries a harness-owned config's new
// dependency to an EXISTING install, without `update` writing a seeded manifest.
//
// The behaviour under test is deliberately narrow and the narrowness is the design: an
// obligation is EMITTED, never applied. Three costs killed the apply-it design and each is
// asserted here by its absence — pnpm-workspace.yaml and package.json are untouched, the
// obligation self-clears once met, and the parked file is machine-readable.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEPENDENCY_OBLIGATIONS_PATH,
  applyDependencyObligations,
  unmetDependencyObligations,
} from '../../installer/lib/migrations.mjs'

const MIGRATIONS = {
  '//': 'doc key, must be ignored',
  '0.4.0': { seedOnInitOnly: ['apps/mobile/src/routes.ts'] },
  '0.5.0': {
    dependencyObligations: [
      {
        name: 'eslint-plugin-jsx-a11y',
        catalog: '^6.10.2',
        devDependency: true,
        why: 'eslint.config.mjs resolves it dynamically and applies every rule at error over apps/web.',
      },
    ],
  },
  '0.6.0': {
    dependencyObligations: [{ name: 'not-yet', catalog: '^1.0.0', why: 'a future release' }],
  },
}

const CATALOG_WITH = `packages:\n  - 'apps/*'\ncatalog:\n  next: 16.2.11\n  eslint-plugin-jsx-a11y: ^6.10.2\n`
const CATALOG_WITHOUT = `packages:\n  - 'apps/*'\ncatalog:\n  next: 16.2.11\n`
const PKG_WITH = JSON.stringify({ devDependencies: { 'eslint-plugin-jsx-a11y': 'catalog:' } })
const PKG_WITHOUT = JSON.stringify({ devDependencies: {} })

let seq = 0
function scratch() {
  const dir = join(tmpdir(), `harness-oblig-${String(process.pid)}-${String(seq++)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('an obligation from a FUTURE release is not demanded yet', () => {
  const unmet = unmetDependencyObligations(MIGRATIONS, '0.5.0', {
    workspaceYaml: CATALOG_WITH,
    packageJson: PKG_WITH,
  })
  assert.deepEqual(unmet, [])
})

test('a tree missing the catalog pin owes the obligation', () => {
  const unmet = unmetDependencyObligations(MIGRATIONS, '0.5.0', {
    workspaceYaml: CATALOG_WITHOUT,
    packageJson: PKG_WITH,
  })
  assert.equal(unmet.length, 1)
  assert.equal(unmet[0].name, 'eslint-plugin-jsx-a11y')
  assert.equal(unmet[0].since, '0.5.0')
})

test('a tree with the pin but no devDependency still owes it — both halves are required', () => {
  // The catalog entry alone does not install anything: `catalog:` is a protocol a
  // dependency declaration resolves THROUGH. A pin nothing references is not installed.
  const unmet = unmetDependencyObligations(MIGRATIONS, '0.5.0', {
    workspaceYaml: CATALOG_WITH,
    packageJson: PKG_WITHOUT,
  })
  assert.equal(unmet.length, 1)
})

test('devDependency:false asks only for the catalog pin', () => {
  const m = {
    '0.5.0': {
      dependencyObligations: [
        { name: 'some-tool', catalog: '^2.0.0', devDependency: false, why: 'a long enough reason.' },
      ],
    },
  }
  const yaml = `catalog:\n  some-tool: ^2.0.0\n`
  assert.deepEqual(unmetDependencyObligations(m, '0.5.0', { workspaceYaml: yaml, packageJson: PKG_WITHOUT }), [])
})

test('the catalog probe is anchored — a bare mention in a comment does not satisfy it', () => {
  const decoy = `catalog:\n  next: 16.2.11\n# see eslint-plugin-jsx-a11y for the web half\n`
  const unmet = unmetDependencyObligations(MIGRATIONS, '0.5.0', {
    workspaceYaml: decoy,
    packageJson: PKG_WITH,
  })
  assert.equal(unmet.length, 1, 'a comment naming the package must not read as a catalog entry')
})

test('an unparseable package.json cannot report the obligation as MET', () => {
  const unmet = unmetDependencyObligations(MIGRATIONS, '0.5.0', {
    workspaceYaml: CATALOG_WITH,
    packageJson: '{ this is not json',
  })
  assert.equal(unmet.length, 1, 'unreadable must mean "cannot prove it is met", never "met"')
})

test('applying parks a machine-readable file and NEVER writes a seeded manifest', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), CATALOG_WITHOUT)
  writeFileSync(join(dir, 'package.json'), PKG_WITHOUT)
  const report = { notes: [] }

  const unmet = applyDependencyObligations({
    targetDir: dir,
    report,
    migrations: MIGRATIONS,
    version: '0.5.0',
    dryRun: false,
  })

  assert.equal(unmet.length, 1)
  // THE BOUNDARY: both seeded manifests are byte-identical afterwards.
  assert.equal(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), CATALOG_WITHOUT)
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), PKG_WITHOUT)

  const parked = JSON.parse(readFileSync(join(dir, DEPENDENCY_OBLIGATIONS_PATH), 'utf8'))
  assert.equal(parked.harnessVersion, '0.5.0')
  assert.equal(parked.obligations[0].name, 'eslint-plugin-jsx-a11y')
  assert.match(parked['//'], /does NOT edit pnpm-workspace\.yaml or package\.json/)

  assert.equal(report.notes.length, 1)
  assert.match(report.notes[0], /DEPENDENCY OBLIGATION \(0\.5\.0\)/)
  assert.match(report.notes[0], /this install is INCOMPLETE/)
  assert.match(report.notes[0], /commit pnpm-lock\.yaml/)
})

test('a dry run writes nothing at all', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), CATALOG_WITHOUT)
  writeFileSync(join(dir, 'package.json'), PKG_WITHOUT)
  applyDependencyObligations({
    targetDir: dir,
    report: { notes: [] },
    migrations: MIGRATIONS,
    version: '0.5.0',
    dryRun: true,
  })
  assert.equal(existsSync(join(dir, DEPENDENCY_OBLIGATIONS_PATH)), false)
})

test('the parked file SELF-CLEARS once the tree meets the obligation', () => {
  // A channel that keeps reporting a satisfied obligation is a warning people learn to
  // ignore, and the next real one arrives into that habit.
  const dir = scratch()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), CATALOG_WITHOUT)
  writeFileSync(join(dir, 'package.json'), PKG_WITHOUT)
  applyDependencyObligations({
    targetDir: dir,
    report: { notes: [] },
    migrations: MIGRATIONS,
    version: '0.5.0',
    dryRun: false,
  })
  assert.equal(existsSync(join(dir, DEPENDENCY_OBLIGATIONS_PATH)), true)

  writeFileSync(join(dir, 'pnpm-workspace.yaml'), CATALOG_WITH)
  writeFileSync(join(dir, 'package.json'), PKG_WITH)
  const report = { notes: [] }
  const unmet = applyDependencyObligations({
    targetDir: dir,
    report,
    migrations: MIGRATIONS,
    version: '0.5.0',
    dryRun: false,
  })
  assert.deepEqual(unmet, [])
  assert.equal(existsSync(join(dir, DEPENDENCY_OBLIGATIONS_PATH)), false)
  assert.deepEqual(report.notes, [])
})

test('a tree with no manifests at all owes the obligation rather than crashing', () => {
  const dir = scratch()
  const unmet = applyDependencyObligations({
    targetDir: dir,
    report: { notes: [] },
    migrations: MIGRATIONS,
    version: '0.5.0',
    dryRun: false,
  })
  assert.equal(unmet.length, 1)
})

test('the SHIPPED template/migrations.json carries the 0.4.0 jsx-a11y gap', () => {
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const names = Object.entries(migrations)
    .filter(([v]) => /^\d+\.\d+\.\d+/.test(v))
    .flatMap(([, e]) => (e.dependencyObligations ?? []).map((o) => o.name))
  assert.ok(
    names.includes('eslint-plugin-jsx-a11y'),
    'the one dependency proven to break every upgraded install must have a channel',
  )
})
