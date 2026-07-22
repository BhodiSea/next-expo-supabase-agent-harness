// Unit tests for the seedOnInitOnly completeness gate's pure core
// (scripts/check-seeded-migrations.mjs, selftest-only — never shipped). The
// classification chain is entirely REUSED machinery (storageToInstall +
// fileMode + seedOnInitOnlyPatterns/matchSeedOnInitOnly), so these tests pin
// the composition: which ADDED template paths would be auto-planted into an
// existing install by `update` without a migrations.json registration. The git
// plumbing is CLI-only and exercised by the selftest job, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findUnregisteredSeededAdditions } from '../../scripts/check-seeded-migrations.mjs'

// A migrations.json shaped like the real one: patterns accumulate across ALL
// versions (timeless semantics), subtrees end in '/', exact files do not.
const MIGRATIONS = {
  '//': 'doc key — must be ignored',
  '0.1.4': { seedOnInitOnly: ['apps/desktop/src/features/matrix/', 'apps/desktop/src/router.ts'] },
  '0.1.5': { seedOnInitOnly: ['apps/desktop/src/features/notes/'] },
}

/** @param {string[]} paths @param {{ allowlist?: any[], migrations?: any }} [opts] */
const check = (paths, { allowlist = [], migrations = MIGRATIONS } = {}) =>
  findUnregisteredSeededAdditions({ addedTemplatePaths: paths, migrations, allowlist })

test('an added seeded file with no covering pattern is a violation naming its install path + mode', () => {
  const v = check(['template/stack/apps/desktop/src/features/graph/GraphPanel.tsx'])
  assert.equal(v.length, 1)
  assert.deepEqual(v[0], {
    templatePath: 'template/stack/apps/desktop/src/features/graph/GraphPanel.tsx',
    installPath: 'apps/desktop/src/features/graph/GraphPanel.tsx',
    mode: 'seeded',
  })
})

test('a covered addition is clean: subtree patterns, exact-file patterns, any registered version', () => {
  assert.deepEqual(
    check([
      'template/stack/apps/desktop/src/features/matrix/NewCell.tsx', // 0.1.4 subtree
      'template/stack/apps/desktop/src/features/notes/NoteComposer.tsx', // 0.1.5 subtree
      'template/stack/apps/desktop/src/router.ts', // exact-file pattern
    ]),
    [],
  )
})

test('an added CONFIG file is a violation too — update auto-plants absent config exactly like seeded', () => {
  const v = check(['template/base/tools/harness.config.mjs'])
  assert.equal(v.length, 1)
  assert.equal(v[0].mode, 'config')
  assert.equal(v[0].installPath, 'tools/harness.config.mjs')
})

test('owned files are ignored — planting them is what update is FOR', () => {
  assert.deepEqual(
    check([
      'template/base/tools/check-new-gate.mjs',
      'template/base/docs/runbooks/harness-upgrade.md',
      'template/base/github/workflows/new-lane.yml',
    ]),
    [],
  )
})

test('the deliberatePlant allowlist clears exactly the listed git path, nothing else', () => {
  const paths = [
    'template/stack/apps/desktop/src/features/graph/GraphPanel.tsx',
    'template/stack/apps/desktop/src/features/graph/useGraph.ts',
  ]
  const allowlist = [
    { file: 'template/stack/apps/desktop/src/features/graph/GraphPanel.tsx', reason: 'reviewed: referenced by an owned gate' },
  ]
  const v = check(paths, { allowlist })
  assert.equal(v.length, 1)
  assert.equal(v[0].templatePath, 'template/stack/apps/desktop/src/features/graph/useGraph.ts')
})

test('template→install mapping is the installer’s own: renames, .tmpl strip, module trees, metadata skipped', () => {
  // package.json.tmpl in a module → installs at package.json (seeded) — the
  // .tmpl strip and two-segment module prefix both come from installer/lib.
  const tmpl = check(['template/modules/ops-backup/package.json.tmpl'])
  assert.equal(tmpl.length, 1)
  assert.equal(tmpl[0].installPath, 'package.json')
  assert.equal(tmpl[0].mode, 'seeded')

  // Dotless-stored workflow files land under .github/ → owned → ignored; and
  // template/-root metadata (migrations.json itself) installs nowhere.
  assert.deepEqual(
    check(['template/modules/ci-macos/github/workflows/macos.yml', 'template/migrations.json']),
    [],
  )

  // Paths may arrive template-relative too (the pure core is git-agnostic).
  const rel = check(['stack/apps/desktop/src/features/graph/GraphPanel.tsx'])
  assert.equal(rel.length, 1)
  assert.equal(rel[0].installPath, 'apps/desktop/src/features/graph/GraphPanel.tsx')
})

test('empty inputs: no additions or no registrations behave honestly', () => {
  assert.deepEqual(check([]), [])
  // No migrations registered at all → every seeded addition violates.
  const v = check(['template/stack/apps/desktop/src/features/matrix/NewCell.tsx'], { migrations: {} })
  assert.equal(v.length, 1)
})
