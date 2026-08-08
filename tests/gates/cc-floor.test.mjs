// THE CLAUDE CODE VERSION FLOOR (0.6.0).
//
// Every framework this scaffold ships is held to a cited security floor. Through 0.5.0 the
// tool doing the holding was held to nothing — and it is the one dependency whose compromise
// compromises every other control, because the enforcement layer IS `.claude/settings.json`
// plus hooks. The published record is not hypothetical: 28 npm-scoped advisories, including
// settings-file configuration injection, two git-worktree escapes, and two command-injection
// bypasses of file-write restrictions.
//
// THE HEADLINE PROOF is the last test: deleting an advisory ROW silently lowers the floor.
// That is the edit worth catching, and it is the one a scalar-only floor cannot see — the
// number and the evidence move together, so nothing looks wrong.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cmpVersion, judgeCcFloor, staleCcReview } from '../../template/base/tools/lib/cc-floor.mjs'

const SHIPPED = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../template/base/tools/cc-floor.json', import.meta.url)), 'utf8'),
)

/** A structurally-valid advisory row; every test below breaks exactly one thing. */
const adv = (over = {}) => ({
  id: 'CVE-2026-00001',
  ghsa: 'GHSA-aaaa-bbbb-cccc',
  severity: 'high',
  published: '2026-01-01',
  patched: '2.0.0',
  summary: 'a thing',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  whyItMattersHere: 'It lands on the settings file, which is this harness entire enforcement layer.',
  ...over,
})

const floorOf = (advisories, over = {}) => ({
  checkedOn: '2026-08-07',
  advisoryCount: advisories.length,
  required: {
    version: advisories.map((a) => a.patched).sort(cmpVersion).at(-1),
    setBy: advisories
      .filter((a) => a.patched === advisories.map((x) => x.patched).sort(cmpVersion).at(-1))
      .map((a) => a.id),
  },
  surfaceAdvisories: advisories,
  ...over,
})

test('GREEN: the SHIPPED floor is internally honest', () => {
  const r = judgeCcFloor({ floor: SHIPPED })
  assert.deepEqual(r.problems, [])
  assert.equal(r.derived, SHIPPED.required.version)
  assert.ok(r.judged >= 10, 'the shipped file must cite the advisories that land on this surface')
})

test('the shipped floor clears every advisory it cites, and cites the ones that set it', () => {
  for (const a of SHIPPED.surfaceAdvisories) {
    assert.ok(
      cmpVersion(SHIPPED.required.version, a.patched) >= 0,
      `${a.id} is patched at ${a.patched}, above the floor ${SHIPPED.required.version}`,
    )
  }
  // Not a tautology with the check above: this asserts the floor is TIGHT, i.e. that at least
  // one cited advisory actually requires it. A floor above all its evidence would pass the
  // loop and still be a number nobody can defend.
  assert.ok(
    SHIPPED.surfaceAdvisories.some((a) => a.patched === SHIPPED.required.version),
    'some cited advisory must actually set the floor',
  )
})

test('RED: the floor scalar BELOW its own evidence', () => {
  const f = floorOf([adv({ patched: '2.0.0' }), adv({ id: 'CVE-2', patched: '2.1.163' })])
  f.required.version = '2.0.0'
  const r = judgeCcFloor({ floor: f })
  assert.match(r.problems.join('\n'), /only all patched at 2\.1\.163/)
  assert.match(r.problems.join('\n'), /still runs a version with a published escape/)
})

test('RED: the floor scalar ABOVE its evidence with nothing justifying the gap', () => {
  const f = floorOf([adv({ patched: '2.1.0' })])
  f.required.version = '2.9.9'
  const r = judgeCcFloor({ floor: f })
  assert.match(r.problems.join('\n'), /ABOVE its own evidence/)
})

test('RED: `setBy` must agree with the evidence in BOTH directions', () => {
  // Forward: a named advisory that no longer sets the floor.
  const stale = floorOf([adv({ patched: '2.1.163' })])
  stale.required.setBy = ['CVE-2026-99999']
  const a = judgeCcFloor({ floor: stale })
  assert.match(a.problems.join('\n'), /names CVE-2026-99999, but no listed advisory/)

  // Reverse — the direction a one-way check never notices: an advisory that QUIETLY starts
  // setting the floor because a later one was added at the same patched version.
  const quiet = floorOf([adv({ id: 'CVE-A', patched: '2.1.163' }), adv({ id: 'CVE-B', patched: '2.1.163' })])
  quiet.required.setBy = ['CVE-A']
  const b = judgeCcFloor({ floor: quiet })
  assert.match(b.problems.join('\n'), /CVE-B is patched at 2\.1\.163, which is the floor, but/)
})

test('RED: a citation nobody can open, and a row that never says why it is here', () => {
  const bare = judgeCcFloor({ floor: floorOf([adv({ url: 'https://some-blog.example/post' })]) })
  assert.match(bare.problems.join('\n'), /A blog post about an advisory is not the advisory/)

  const why = judgeCcFloor({ floor: floorOf([adv({ whyItMattersHere: 'bad' })]) })
  assert.match(why.problems.join('\n'), /stale copy of a vulnerability database/)
})

test('RED: an empty advisory list — a bare version number is what this file exists to refuse', () => {
  const r = judgeCcFloor({ floor: { required: { version: '2.1.163' }, surfaceAdvisories: [] } })
  assert.equal(r.judged, 0)
  assert.match(r.problems.join('\n'), /a maintainer lowers the first time a teammate's CLI is old/)
})

test('RED: a recommendation weaker than the requirement, or one that misses its own feature', () => {
  const weak = floorOf([adv({ patched: '2.1.163' })], {
    recommended: { version: '2.1.0' },
  })
  assert.match(judgeCcFloor({ floor: weak }).problems.join('\n'), /BELOW `required.version`/)

  const short = floorOf([adv({ patched: '2.1.163' })], {
    recommended: { version: '2.1.163', featureFloors: [{ version: '2.1.219', feature: 'x' }] },
  })
  assert.match(judgeCcFloor({ floor: short }).problems.join('\n'), /needs 2\.1\.219/)
})

test('the SHIPPED recommendation covers every feature it lists', () => {
  for (const f of SHIPPED.recommended.featureFloors) {
    assert.ok(
      cmpVersion(SHIPPED.recommended.version, f.version) >= 0,
      `${f.version} (${f.feature}) is above the recommendation ${SHIPPED.recommended.version}`,
    )
  }
})

test('the freshness half is CLOCKFUL and lives on the scheduled job, not in the chain', () => {
  // Same split framework-floor.mjs argues for: `pnpm validate` must give the same verdict on
  // the same tree forever, so a wall-clock comparison cannot ride it.
  assert.deepEqual(staleCcReview({ floor: SHIPPED, today: SHIPPED.checkedOn }), [])
  const lapsed = staleCcReview({ floor: SHIPPED, today: '2026-12-01' })
  assert.equal(lapsed.length, 1)
  assert.match(lapsed[0], /Re-run/)
  assert.match(lapsed[0], /moving the date alone is the one edit this control cannot tell/)
})

test('RED: a checkedOn that is not a date at all cannot be judged, and says so', () => {
  const r = staleCcReview({ floor: { checkedOn: 'recently' }, today: '2026-08-07' })
  assert.match(r[0], /must be an ISO date/)
})

test('THE HEADLINE: deleting an advisory ROW silently lowers the floor — and is caught', () => {
  // The edit a scalar-only floor cannot see. Drop the row that sets the number and the number
  // has to move with it; leave the number and the file contradicts itself. Either way this
  // reds, which is the whole reason the floor is DERIVED from the evidence rather than
  // written beside it.
  const trimmed = {
    ...SHIPPED,
    surfaceAdvisories: SHIPPED.surfaceAdvisories.filter(
      (a) => a.patched !== SHIPPED.required.version,
    ),
  }
  const r = judgeCcFloor({ floor: trimmed })
  assert.ok(r.problems.length > 0, 'removing the floor-setting advisories must red')
  assert.match(r.problems.join('\n'), /ABOVE its own evidence|does not name it|no listed advisory/)
  assert.ok(
    cmpVersion(r.derived, SHIPPED.required.version) < 0,
    'and the derived floor must actually have fallen — that is the silent part',
  )
})
