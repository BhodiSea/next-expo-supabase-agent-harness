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
//
// 0.9.9 adds the case the derived pass was never built for. Every earlier record's fix
// paths were harness-authored files whose template copy is right for any install, so
// copying them WAS the remedy. supabase/config.toml carries per-project rendering, so the
// remedy is the narrowest edit instead — an append of the reviewed [auth.mfa] block,
// guarded on absence — and the last test here holds that literal to tools/auth-posture.json
// in both directions, because a second copy of a register is a second copy that drifts.
// SOURCE: scripts/ci/upgrade-sweep.mjs (computeSweepSet + SWEEPS) · template/migrations.json
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { AUTH_MFA_BLOCK, computeSweepSet } from '../../scripts/ci/upgrade-sweep.mjs'

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
  assert.deepEqual(computeSweepSet(AT_0_7_0, '0.6.0', '0.7.0'), {
    adopt: [],
    tomlSectionRenames: [],
    tomlSectionAppends: [],
  })
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

// ── 0.9.9: the first seededSourceFixes path that must NOT be adopted by copy ─────────
//
// Every previous record's fix paths were harness-authored files whose template copy is
// correct for any install, so §1c copying them was the whole remedy. supabase/config.toml
// is not that: it carries per-project rendering, and adopting the template's copy would
// overwrite the install's project id, ports and every value the installer filled in with
// unrendered placeholders. So the path is withdrawn and the narrowest edit is made instead.

test('0.9.9 — supabase/config.toml is WITHDRAWN from the derived copy pass', () => {
  const { adopt, tomlSectionAppends } = computeSweepSet(MIGRATIONS, '0.9.5', '0.9.9')
  assert.ok(
    !adopt.includes('supabase/config.toml'),
    'copying the template config.toml over an install replaces its rendered values with placeholders',
  )
  // And the exemption is not vacuous: the record really does name that path, so without
  // skipDerivedAdopt the derived pass WOULD have copied it.
  const fixPaths = MIGRATIONS['0.9.9'].seededSourceFixes.flatMap((f) => f.paths)
  assert.ok(
    fixPaths.includes('supabase/config.toml'),
    'if the record stops naming this path the withdrawal above proves nothing — and computeSweepSet now throws on it',
  )
  assert.deepEqual(tomlSectionAppends, [['[auth.mfa]', AUTH_MFA_BLOCK]])
})

test("0.9.9 — the MFA migration and its proof are NOT adopted, by the record's own reasoning", () => {
  // The migration creates a RESTRICTIVE policy on public.notes. An install that renamed or
  // dropped that table takes a `db push` failure from a file it never asked for, and that
  // is true whether a human or a script did the copying.
  const { adopt } = computeSweepSet(MIGRATIONS, '0.9.5', '0.9.9')
  for (const rel of MIGRATIONS['0.9.9'].seedOnInitOnly) {
    assert.ok(!adopt.includes(rel), `0.9.9 withheld path swept back in: ${rel}`)
  }
  assert.ok(
    MIGRATIONS['0.9.9'].seedOnInitOnly.some((/** @type {string} */ p) => p.endsWith('_mfa_aal2.sql')),
    'the exclusion above still covers the migration it was written for',
  )
})

test('FAIL-CLOSED — a skipDerivedAdopt entry naming no real fix path throws', () => {
  // The failure this guards is quiet: a later release edits its seededSourceFixes paths,
  // the exemption stops matching anything, and it sits there cancelling nothing while
  // reading as a reviewed decision. Held to the record so it cannot outlive its fix.
  const stale = {
    ...MIGRATIONS,
    '0.9.9': {
      ...MIGRATIONS['0.9.9'],
      seededSourceFixes: [{ paths: ['apps/web/lib/example.ts'], gate: 'x', why: 'y' }],
    },
  }
  assert.throws(() => computeSweepSet(stale, '0.9.5', '0.9.9'), /skipDerivedAdopt/)
})

/** One TOML scalar, decoded. Only the three forms the reviewed block uses. */
const scalar = (text) => {
  if (text.startsWith('"')) return text.slice(1, -1)
  if (text === 'true' || text === 'false') return text === 'true'
  return Number(text)
}

/**
 * A flat TOML block as a Map of dotted `<section>.<key>` -> value. Enough for the reviewed
 * [auth.mfa] block and deliberately no more: a real parser here would be a second
 * implementation of the thing the gate under test already owns.
 * @param {string} block
 */
const dottedKeys = (block) => {
  const seen = new Map()
  let section = ''
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) {
      section = header[1]
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line)
    assert.ok(kv !== null, `unparseable line in the swept block: ${line}`)
    seen.set(`${section}.${kv[1]}`, scalar(kv[2].trim()))
  }
  return seen
}

test('the appended [auth.mfa] block IS the reviewed posture, in both directions', () => {
  // A literal copy of a register is a second copy, and a second copy drifts. This is the
  // closure that stops it: every auth.mfa.* key the posture reviews must appear in the
  // block with the same value, and the block must introduce no key the posture does not
  // review — which is the same both-ways discipline check-auth-posture.mjs applies to the
  // consumer's own config.toml, applied here to the text the sweep writes into it.
  // Since the 1.0.0 floor/tunable split the reviewed [auth.mfa] tree spans BOTH
  // registers: nine floor keys in auth-posture.json plus max_enrolled_factors, whose
  // seeded value lives in auth-tunables.json — the merged view is exactly what
  // check-auth-posture.mjs judges the consumer's config against.
  const posture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../template/base/tools/auth-posture.json', import.meta.url)),
      'utf8',
    ),
  ).posture
  const tunableValues = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../template/base/tools/auth-tunables.json', import.meta.url)),
      'utf8',
    ),
  ).values
  const merged = {
    ...posture,
    ...Object.fromEntries(Object.entries(tunableValues).map(([k, row]) => [k, row.value])),
  }

  const seen = dottedKeys(AUTH_MFA_BLOCK)
  const reviewed = Object.entries(merged).filter(([k]) => k.startsWith('auth.mfa'))
  assert.equal(reviewed.length, 10, 'the [auth.mfa] tree is exactly ten reviewed keys across the two registers')
  for (const [key, value] of reviewed) {
    assert.ok(seen.has(key), `the registers review ${key} and the swept block never writes it`)
    assert.deepEqual(seen.get(key), value, `${key}: the swept block disagrees with the registers`)
  }
  for (const key of seen.keys()) {
    assert.ok(
      Object.hasOwn(merged, key),
      `the swept block writes ${key}, which neither tools/auth-posture.json nor tools/auth-tunables.json reviews — an unreviewed key in a file the gate reads BOTH ways reds the install the sweep was meant to clear`,
    )
  }
})

// ── 0.11.1: the entry whose ABSENCE red the v0.11.0 tag ──────────────────────────────
// 0.11.0 withheld the web erase surface and the tools/eol.json re-date and shipped NO SWEEPS
// entry, so leg E threw on the tag — after every factory checker was clean and all 34 gates
// were green on a fresh scaffold. The fail-closed throw above is what caught it; these two
// pin the entry that answers it, so a later edit cannot quietly empty the posture back.
test('0.11.0 — the erase surface is adopted WITH the layout that renders it', () => {
  const { adopt } = computeSweepSet(MIGRATIONS, '0.10.0', '0.11.1')

  // The seam and its proof come from the record's own seedOnInitOnly set...
  assert.ok(adopt.includes('apps/web/lib/account/'), `seam missing: ${adopt.join(', ')}`)
  assert.ok(adopt.includes('apps/web/__tests__/delete-account.test.ts'))
  // ...the button does NOT, because apps/web/app/(protected)/ has been a seedOnInitOnly
  // subtree since 0.2.0 and 0.11.0's list does not repeat it — so extraAdopt carries it.
  assert.ok(adopt.includes('apps/web/app/(protected)/delete-account-button.tsx'))
  // THE ASSERTION THAT IS THE POINT. A component nothing imports is a dead-code red, which
  // is the trap 0.11.0's own seedOnInitOnlyWhy names as the reason the files travel together
  // or not at all. Adopting the button without its layout would satisfy every line above and
  // still red the post-sweep chain, which §7d requires to be GREEN.
  assert.ok(
    adopt.includes('apps/web/app/(protected)/layout.tsx'),
    'the button was adopted without the layout that renders it — dead-code red after the sweep',
  )
  // And the derived pass still carries the seeded-source fix unconditionally.
  assert.ok(adopt.includes('tools/eol.json'))
})

test('0.11.0 withholds files, so its posture may never go missing again', () => {
  // The record and the table are two files that must agree; this reds if either side moves.
  const record = MIGRATIONS['0.11.0']
  const withholds =
    (record.seedOnInitOnly ?? []).length > 0 || (record.seededSourceFixes ?? []).length > 0
  assert.equal(withholds, true, '0.11.0 no longer withholds — retire this test with the entry')
  // computeSweepSet throws when a crossed version withholds with no entry, so a hop that
  // spans 0.11.0 completing at all IS the assertion that the entry is present.
  assert.doesNotThrow(() => computeSweepSet(MIGRATIONS, '0.9.9', '0.11.1'))
})
