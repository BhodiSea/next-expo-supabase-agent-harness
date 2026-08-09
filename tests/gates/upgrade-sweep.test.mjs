// The multi-version sweep set (0.7.0) — leg E's file list, computed per crossed version.
//
// Through 0.6.0, scripts/ci/upgrade-sweep.mjs adopted only migrations[headVersion]. At head
// 0.6.0 that happened to BE the whole sweep, because no in-range predecessor withheld
// anything a swept leg must adopt. At head 0.7.0 the same code reads migrations['0.7.0'] —
// a record that withholds no files — so the sweep goes empty, the done-guard fires, and the
// one lane that executes graduate's SUCCESS branch dies on the release whose expiries most
// need it. The rewrite iterates versionsBetween(base, head) over a reviewed in-file SWEEPS
// table, and these tests pin the two edges that keep that honest:
//   - the (0.3.0, 0.6.0) set is BYTE-IDENTICAL to the single-version behavior it replaces
//     (the backward pin — provable pre-bump, on the head that ships today), and
//   - a blind union across versions stays impossible: every 0.4.0 withheld path is OUT,
//     because adopting apps/web/lib/action-outcome.ts replants the orphan the 0.4.0 record
//     itself documents (its only callers are the consumer's Server Actions — RED dead-code),
//     and 0.2.0's set would put unapplied DDL in front of the scaffold's applied history.
// The closure is fail-closed: a crossed version that withholds files with NO SWEEPS entry
// (absent, not empty) throws naming the version, so a future release cannot silently skip
// the review that decides its sweep posture.
// SOURCE: scripts/ci/upgrade-sweep.mjs (computeSweepSet + SWEEPS) · template/migrations.json
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { computeSweepSet } from '../../scripts/ci/upgrade-sweep.mjs'

const MIGRATIONS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../template/migrations.json', import.meta.url)), 'utf8'),
)

// Today's sweep at (0.3.0, 0.6.0) as a LITERAL, in the shipped order: §1 the 0.6.0
// seedOnInitOnly set (record order), §1b the page body that renders the meta ids, §1c the
// nine-file seeded-source fix set, then the §2 toml rename. Frozen here rather than derived
// from migrations.json because shipped records are history — if this pin moves, the sweep
// changed for a hop that already ran green in CI, which is exactly what this test must catch.
const SWEEP_0_6_0 = [
  'apps/web/lib/i18n/',
  'apps/web/lib/routes.ts',
  'apps/web/lib/routes.generated.ts',
  'apps/web/app/not-found.tsx',
  'apps/web/app/(protected)/o/page.meta.ts',
  'apps/web/app/(protected)/o/loading.tsx',
  'apps/web/app/(protected)/o/[orgSlug]/notes/page.meta.ts',
  'apps/web/app/(protected)/o/[orgSlug]/notes/loading.tsx',
  'apps/web/__tests__/routes.test.ts',
  'apps/web/e2e/authenticated.spec.ts',
  'apps/web/app/(protected)/o/page.tsx',
  'apps/web/lib/supabase/client.ts',
  'apps/web/lib/supabase/server.ts',
  'apps/web/app/sign-in/page.tsx',
  'apps/web/app/sign-in/sign-in-form.tsx',
  'packages/platform/supabase/src/client.ts',
  'packages/platform/supabase/src/cookies.ts',
  'packages/platform/supabase/src/cookies.test.ts',
  'packages/platform/supabase/src/cookie-server.ts',
  'packages/platform/supabase/src/index.ts',
]
const RENAMES_0_6_0 = [['[inbucket]', '[local_smtp]']]

// The head-0.7.0 world, pre-bump: the real records plus the shape Wave 2's 0.7.0 record
// takes — rampExpiry only, no seedOnInitOnly, no seededSourceFixes (the expiry release
// withholds nothing; everything it reds was seeded by the versions before it).
const AT_0_7_0 = { ...MIGRATIONS, '0.7.0': { rampExpiry: { affects: [], why: 'fixture' } } }

test('backward pin — (0.3.0, 0.6.0) is byte-identical to the single-version sweep it replaces', () => {
  const { adopt, tomlSectionRenames } = computeSweepSet(MIGRATIONS, '0.3.0', '0.6.0')
  assert.deepEqual(adopt, SWEEP_0_6_0)
  assert.deepEqual(tomlSectionRenames, RENAMES_0_6_0)
})

test('head 0.7.0 — the 0.6.0 seams survive, and every 0.4.0 withheld path stays OUT', () => {
  const { adopt, tomlSectionRenames } = computeSweepSet(AT_0_7_0, '0.3.0', '0.7.0')
  assert.deepEqual(adopt, SWEEP_0_6_0, 'the hop crosses 0.4.0/0.5.0/0.6.0/0.7.0 and only 0.6.0 contributes')
  assert.deepEqual(tomlSectionRenames, RENAMES_0_6_0)
  // The dead-code regression pin: a blind union of seedOnInitOnly across crossed versions
  // would include these nine and replant the 0.4.0 record's own documented orphan.
  for (const rel of MIGRATIONS['0.4.0'].seedOnInitOnly) {
    assert.ok(!adopt.includes(rel), `0.4.0 withheld path swept back in: ${rel}`)
  }
  assert.ok(
    MIGRATIONS['0.4.0'].seedOnInitOnly.includes('apps/web/lib/action-outcome.ts'),
    'the exclusion above still covers the documented orphan — if it left the record, this pin is vacuous',
  )
})

test('the full lineage hop (0.1.3, 0.7.0) adopts the same set — 0.2.x DDL and data stay out', () => {
  // 0.2.0's withheld set is unapplied DDL, reviewed data naming the template's own tables,
  // and generated artifacts describing a database the scaffold does not have; 0.2.1's is the
  // token-rendered preset contract. Both cross this hop with explicit EMPTY entries.
  const { adopt } = computeSweepSet(AT_0_7_0, '0.1.3', '0.7.0')
  assert.deepEqual(adopt, SWEEP_0_6_0)
  for (const rel of MIGRATIONS['0.2.0'].seedOnInitOnly) {
    assert.ok(!adopt.includes(rel), `0.2.0 withheld path swept back in: ${rel}`)
  }
})

test('the 0.6.0 -> 0.7.0 hop sweeps NOTHING — the expiry release withholds no files', () => {
  assert.deepEqual(computeSweepSet(AT_0_7_0, '0.6.0', '0.7.0'), { adopt: [], tomlSectionRenames: [] })
})

test('FAIL-CLOSED — a crossed version withholding files with NO SWEEPS entry throws naming it', () => {
  const withSeeds = { ...MIGRATIONS, '0.6.5': { seedOnInitOnly: ['apps/web/lib/example.ts'] } }
  assert.throws(() => computeSweepSet(withSeeds, '0.3.0', '0.7.0'), /0\.6\.5/)
  const withFixes = {
    ...MIGRATIONS,
    '0.6.5': { seededSourceFixes: [{ paths: ['apps/web/lib/example.ts'], gate: 'x', why: 'y' }] },
  }
  assert.throws(() => computeSweepSet(withFixes, '0.3.0', '0.7.0'), /0\.6\.5/)
  // A version that withholds nothing needs no entry — absent is only a defect when there
  // is something to decide about.
  const inert = { ...MIGRATIONS, '0.6.5': { configSteps: [] } }
  assert.deepEqual(computeSweepSet(inert, '0.3.0', '0.6.5').adopt, SWEEP_0_6_0)
})
