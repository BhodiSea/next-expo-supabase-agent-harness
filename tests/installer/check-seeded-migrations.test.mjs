// Unit tests for the seedOnInitOnly completeness gate's pure core
// (scripts/check-seeded-migrations.mjs, selftest-only — never shipped). The
// classification chain is entirely REUSED machinery (storageToInstall +
// fileMode + seedOnInitOnlyPatterns/matchSeedOnInitOnly), so these tests pin
// the composition: which ADDED template paths would be auto-planted into an
// existing install by `update` without a migrations.json registration. The git
// plumbing is CLI-only and exercised by the selftest job, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findUngroundedPatterns,
  findUnregisteredSeededAdditions,
  seededSourceFixProblems,
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

// ── seededSourceFixes (0.6.0) ────────────────────────────────────────────────────
//
// The record that tells a consumer to edit their OWN source, because `update` cannot: the
// files are seeded, and 0.6.0 corrected the sign-in loop inside them. Nothing copies these
// into a real install, which is precisely why the declaration needs a reader — the runbook
// prints the table, the sweep leg adopts the paths, and `adopt()` skips a missing source in
// SILENCE, so a path that stops existing degrades both of them without a symptom.
const REAL_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GOOD = {
  gate: 'auth-posture',
  why: 'a reason long enough to say what actually broke and why the consumer must act on it',
  paths: ['apps/web/lib/supabase/client.ts'],
  // A well-formed probe: names a path inside `paths`, one predicate, and describes the
  // PRE-fix shape (the shipped template CONTAINS the symbol, so `lacks` does not match it).
  probes: [{ path: 'apps/web/lib/supabase/client.ts', brokenWhen: { lacks: 'cookieSessionStorage' } }],
}

test('seededSourceFixes: the shipped record resolves against the template', () => {
  const migrations = JSON.parse(readFileSync(join(REAL_ROOT, 'template/migrations.json'), 'utf8'))
  assert.deepEqual(seededSourceFixProblems(migrations, REAL_ROOT), [])
  // Positive control: the assertion above is vacuous if the key is absent entirely.
  const declared = Object.entries(migrations)
    .filter(([v]) => v !== '//')
    .flatMap(([, e]) => e.seededSourceFixes ?? [])
  assert.ok(declared.length > 0, 'no seededSourceFixes record exists, so the green above proves nothing')
})

test('seededSourceFixes: a path the template does not ship is named, not skipped', () => {
  // The typo'd path is APPENDED so GOOD's probe still samples the record's own `paths` —
  // this test isolates the missing-template problem, not the probe-aim one.
  const problems = seededSourceFixProblems(
    { '0.6.0': { seededSourceFixes: [{ ...GOOD, paths: [...GOOD.paths, 'apps/web/lib/supabase/clientt.ts'] }] } },
    REAL_ROOT,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /clientt\.ts, which is in neither template\/stack nor template\/base/)
})

test('seededSourceFixes: an unreasoned, ungated or empty record is a review reject', () => {
  const p = (fix) => seededSourceFixProblems({ '0.6.0': { seededSourceFixes: [fix] } }, REAL_ROOT)
  assert.match(p({ ...GOOD, why: 'localStorage' }).join('\n'), /carries no usable `why`/)
  assert.match(p({ ...GOOD, gate: '' }).join('\n'), /names no `gate`/)
  assert.match(p({ ...GOOD, paths: [] }).join('\n'), /lists no `paths`/)
  // The doc key is not a version and must never be walked as one.
  assert.deepEqual(seededSourceFixProblems({ '//': 'prose' }, REAL_ROOT), [])
})

// ── probes (0.7.0) ──────────────────────────────────────────────────────────────
//
// The runtime channel (`update` parks .harness/pending/source-fixes.json, `doctor` warns)
// decides "is this fix APPLIED" from the probes and nothing else — so a record whose probes
// are missing, mis-aimed, or aimed at the FIXED shape produces a parked artifact that either
// never appears or can never self-clear. Both are silent in every other check, because both
// are perfectly valid JSON. These reds are what keep future entries honest.
const p = (fix) => seededSourceFixProblems({ '0.6.0': { seededSourceFixes: [fix] } }, REAL_ROOT)

test('probes: an entry WITHOUT probes reds — a channel that cannot self-clear must be unauthorable', () => {
  const { probes: _dropped, ...probeless } = GOOD
  assert.match(p(probeless).join('\n'), /carries no `probes`/)
})

test('probes: a probe naming a path outside the record’s own `paths` reds', () => {
  const stray = {
    ...GOOD,
    probes: [{ path: 'apps/web/lib/supabase/server.ts', brokenWhen: { lacks: 'cookieSessionStorage' } }],
  }
  assert.match(p(stray).join('\n'), /not in the record's own `paths`/)
})

test('probes: a probe path the template does not ship reds on the probe, not only on `paths`', () => {
  const typo = {
    ...GOOD,
    paths: ['apps/web/lib/supabase/clientt.ts'],
    probes: [{ path: 'apps/web/lib/supabase/clientt.ts', brokenWhen: { lacks: 'cookieSessionStorage' } }],
  }
  assert.match(p(typo).join('\n'), /probes\[0\][^\n]*neither template\/stack nor template\/base/)
})

test('probes: brokenWhen must be exactly one of contains/lacks, non-empty', () => {
  const probeAt = (brokenWhen) =>
    p({ ...GOOD, probes: [{ path: 'apps/web/lib/supabase/client.ts', brokenWhen }] }).join('\n')
  assert.match(probeAt({ contains: 'x', lacks: 'y' }), /exactly one of `contains` or `lacks`/)
  assert.match(probeAt({}), /exactly one of `contains` or `lacks`/)
  assert.match(probeAt({ lacks: '' }), /exactly one of `contains` or `lacks`/)
  assert.match(probeAt({ lacks: 'cookieSessionStorage', typo: 'z' }), /exactly one of `contains` or `lacks`/)
})

test('probes: a broken shape that matches the FIXED template reds — it could never self-clear', () => {
  // The template ships the CORRECTED files, so a probe is honest only when it does NOT
  // match them. `contains cookieSessionStorage` matches the fix itself: every install that
  // took the fix would hold the obligation open forever.
  const inverted = {
    ...GOOD,
    probes: [{ path: 'apps/web/lib/supabase/client.ts', brokenWhen: { contains: 'cookieSessionStorage' } }],
  }
  assert.match(p(inverted).join('\n'), /matches the CURRENT template copy/)
  // Same inversion, lacks-shaped: the template lacks this marker, so "broken = lacks it"
  // is a predicate the fixed tree satisfies.
  const nonsense = {
    ...GOOD,
    probes: [{ path: 'apps/web/lib/supabase/client.ts', brokenWhen: { lacks: 'zz-no-such-marker-zz' } }],
  }
  assert.match(p(nonsense).join('\n'), /matches the CURRENT template copy/)
})
