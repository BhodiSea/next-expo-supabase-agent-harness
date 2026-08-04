// Unit tests for the seedOnInitOnly completeness gate's pure core
// (scripts/check-seeded-migrations.mjs, selftest-only — never shipped). The
// classification chain is entirely REUSED machinery (storageToInstall +
// fileMode + seedOnInitOnlyPatterns/matchSeedOnInitOnly), so these tests pin
// the composition: which ADDED template paths would be auto-planted into an
// existing install by `update` without a migrations.json registration. The git
// plumbing is CLI-only and exercised by the selftest job, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findUngroundedPatterns,
  findUnregisteredSeededAdditions,
} from '../../scripts/check-seeded-migrations.mjs'

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
  const tmpl = check(['template/modules/push-notifications/package.json.tmpl'])
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

test('preset storage paths (template/presets/**) are exempt by construction — update never walks them', () => {
  // The design-token preset trees live outside base/stack/modules, so their
  // files can never be auto-planted by `update` — the classifier skips them
  // even with zero migrations registered. This is the invariant the 0.2.1
  // migrations record relies on to carry no seedOnInitOnly entries for the
  // metal overlay.
  assert.deepEqual(
    check(
      [
        'template/presets/tokens-metal/packages/design-tokens/src/color.ts',
        'template/presets/tokens-metal/apps/web/styles/metal/rims.css',
      ],
      { migrations: {} },
    ),
    [],
  )
})

// ── pattern GROUNDEDNESS ────────────────────────────────────────────────────────
// The completeness half above asks "is every addition registered?". This half asks the
// opposite and equally silent question: "does every registration name something real?".
// A seedOnInitOnly pattern is read by a prefix/exact matcher, so a typo or a path left
// behind by a rename withholds NOTHING while reading as protection — and `update` then
// plants the very file the entry was written to hold back. Both failures are valid JSON,
// which is why nothing else in the repo can see them.

test('grounding: a pattern must name a file, or a directory some file installs under', () => {
  const shipped = [
    'supabase/seeds/scale.sql',
    'supabase/migrations/20260202000000_audit.sql',
    'tools/tenancy.json',
    'apps/web/app/(protected)/layout.tsx',
  ]
  const g = (patterns) => findUngroundedPatterns({ patterns, shippedInstallPaths: shipped })

  // Exact file, subtree, and a NESTED subtree prefix all resolve.
  assert.deepEqual(g(['tools/tenancy.json', 'supabase/seeds/', 'apps/web/app/(protected)/']), [])
  assert.deepEqual(g(['supabase/', 'apps/', 'apps/web/app/']), [])
})

test('grounding: typos, stale renames and stray comment strings are all reported', () => {
  const shipped = ['supabase/seeds/scale.sql', 'tools/tenancy.json']
  const g = (patterns) => findUngroundedPatterns({ patterns, shippedInstallPaths: shipped })

  // A typo in a subtree, a file that no longer ships, and the shape that motivated this
  // check: a human-readable comment accidentally left in the array. The last one is the
  // dangerous case — one ending in '/' would have withheld an entire subtree in silence.
  assert.deepEqual(g(['supabase/seedz/']), ['supabase/seedz/'])
  assert.deepEqual(g(['tools/renamed-away.json']), ['tools/renamed-away.json'])
  assert.deepEqual(g(['//: DDL — the headline hazard.']), ['//: DDL — the headline hazard.'])

  // An exact-file pattern must not be satisfied by a DIRECTORY of that name, nor a
  // subtree pattern by a file — the matcher treats the trailing slash as meaningful, so
  // the grounding check has to as well.
  assert.deepEqual(g(['supabase/seeds']), ['supabase/seeds'])
  assert.deepEqual(g(['tools/tenancy.json/']), ['tools/tenancy.json/'])
})

test('grounding: nothing registered, or nothing shipped, is reported honestly', () => {
  assert.deepEqual(findUngroundedPatterns({ patterns: [], shippedInstallPaths: ['a/b.ts'] }), [])
  // A tree that ships nothing grounds nothing — vacuous truth is not the answer here.
  assert.deepEqual(findUngroundedPatterns({ patterns: ['a/b.ts'], shippedInstallPaths: [] }), [
    'a/b.ts',
  ])
})
