// The framework security floor (0.5.0) — the control that would have caught the harness
// shipping `next: 16.2.7` for two releases after the 2026-07-20 advisory put nine CVEs on
// that range, and which no lane in the tree could have caught before.
//
// Both halves are proved here, and the split between them IS the design:
//   - judgeFloor is CLOCKLESS. It rides chain step 11, so the same tree must produce the
//     same verdict on any machine on any day, offline.
//   - staleReviews is CLOCKFUL. It rides the scheduled `floor-review` job only, and its
//     `today` is a parameter so this file can backdate a review without owning a calendar.
//
// The last test spawns the shipped script: that is the `lanes['floor-review']` red-proof,
// and it is registered as one. Nothing else in the repo can make that lane go red.
// SOURCE: template/base/tools/lib/framework-floor.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  compareVersions,
  judgeFloor,
  MAX_REVIEW_WINDOW_DAYS,
  parseLockVersions,
  reviewWindowProblems,
  staleReviews,
} from '../../template/base/tools/lib/framework-floor.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHIPPED_FLOOR = join(ROOT, 'template/base/tools/framework-floor.json')
const floorJson = () => JSON.parse(readFileSync(SHIPPED_FLOOR, 'utf8'))

const FLOOR = {
  packages: {
    next: {
      why: 'the web half hosts the API.',
      minPatchByMajor: { 15: '15.5.21', 16: '16.2.11' },
      reviewedOn: '2026-08-06',
      reviewedUntil: '2026-11-06',
      source: 'https://nextjs.org/blog/july-2026-security-release',
      advisories: [
        { id: 'CVE-2026-64642', severity: 'High', summary: 'middleware bypass' },
        { id: 'CVE-2026-64644', severity: 'Medium', summary: 'image DoS' },
      ],
    },
  },
}

const LOCK = (version) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  apps/web:
    dependencies:
      next:
        specifier: 'catalog:'
        version: ${version}

packages:

  '@alloc/quick-lru@5.2.0':
    resolution: {integrity: sha512-fake}

  next@${version}:
    resolution: {integrity: sha512-fake}

snapshots:

  next@${version}(react-dom@19.2.0(react@19.2.0))(react@19.2.0):
    dependencies:
      react: 19.2.0
`

// ── the lockfile scanner ──────────────────────────────────────────────────────────

test('parseLockVersions reads plain and scoped keys and strips the peer suffix', () => {
  const found = parseLockVersions(LOCK('16.2.7'))
  assert.deepEqual([...(found.get('next') ?? [])], ['16.2.7'])
  assert.deepEqual([...(found.get('@alloc/quick-lru') ?? [])], ['5.2.0'])
})

test('a NESTED peer suffix yields one clean version, not a version with a `)` on it', () => {
  // THE DEFECT THIS PINS, found by running the upgrade lane rather than by reading the
  // code. Real pnpm v9 snapshot keys nest — the shipped scaffold's is
  // `next@16.2.7(@babel/core@7.29.7)…(react-dom@19.2.3(react@19.2.3))(react@19.2.3)` — and
  // the parser stripped parenthesised groups with `/\([^)]*\)/g`, which cannot match a
  // nested pair. It removed the inner one and left the outer `)` stranded, so the version
  // parsed as `16.2.7)`. That is not merely cosmetic: it does not equal the `16.2.7` the
  // `packages:` block yields, so the Set held TWO members and step 11 printed the same
  // four CVEs twice, once against a version string that does not exist. The old fixture
  // used a flat `(react@19.2.0)` and passed throughout.
  const found = parseLockVersions(LOCK('16.2.7'))
  assert.deepEqual([...(found.get('next') ?? [])], ['16.2.7'], 'exactly one version, undecorated')
})

test('parseLockVersions ignores the importers block — a specifier is not a resolution', () => {
  // `importers:` names the SPECIFIER (`catalog:`) alongside the version, and reading that
  // block as if it were `packages:` is how a scanner starts inventing package names.
  const found = parseLockVersions(LOCK('16.2.11'))
  assert.equal(found.has('specifier'), false)
  assert.equal(found.has('resolution'), false)
})

test('compareVersions sorts a prerelease BELOW its own release', () => {
  // A canary carrying the fix is not the release the advisory names, so it must not
  // satisfy the floor.
  assert.ok(compareVersions('16.2.11-canary.92', '16.2.11') < 0)
  assert.ok(compareVersions('16.2.11', '16.2.11') === 0)
  assert.ok(compareVersions('16.2.12', '16.2.11') > 0)
  assert.ok(compareVersions('16.10.0', '16.9.0') > 0, 'numeric, not lexical')
})

// ── the clockless half: judgeFloor ────────────────────────────────────────────────

test('CANARY — a resolved version below the floor reds and names the HIGH advisories', () => {
  const { problems } = judgeFloor({
    floor: FLOOR,
    resolved: parseLockVersions(LOCK('16.2.7')),
    catalogPins: new Map([['next', '16.2.7']]),
    haveLock: true,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /next@16\.2\.7 is BELOW the reviewed security floor 16\.2\.11/)
  assert.match(problems[0], /CVE-2026-64642/)
  // The Medium row must not crowd out the High one in a one-line failure message.
  assert.ok(!problems[0].includes('CVE-2026-64644'), 'High advisories are cited first')
})

test('the SHIPPED pin passes its own SHIPPED floor', () => {
  // The regression this whole workstream exists for: the catalog and the floor are two
  // files, and nothing but this compares them.
  const workspace = readFileSync(join(ROOT, 'template/base/pnpm-workspace.yaml'), 'utf8')
  const catalogPins = new Map(
    [...workspace.matchAll(/^ {2}'?([@a-z0-9][@a-z0-9/.-]*)'?:\s*([^\s#]+)/gm)].map((m) => [
      m[1],
      m[2].replace(/^['"]|['"]$/g, ''),
    ]),
  )
  assert.ok(catalogPins.has('next'), 'the catalog scanner must find the pin it is judging')
  const { problems, judged } = judgeFloor({
    floor: floorJson(),
    resolved: new Map(),
    catalogPins,
    haveLock: false,
  })
  assert.deepEqual(problems, [])
  assert.ok(judged >= 1, 'a floor that judged nothing proves nothing')
})

test('CANARY — an UNSUPPORTED major line reds even though no minPatch names it', () => {
  const { problems } = judgeFloor({
    floor: FLOOR,
    resolved: new Map([['next', new Set(['14.2.30'])]]),
    catalogPins: new Map(),
    haveLock: true,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /major line 14, for which .* records NO patched release/)
  assert.match(problems[0], /Supported lines: 15, 16/)
})

test('a PATCHED older line is accepted — the floor is per major, not a single number', () => {
  // A flat `minPatch: 16.2.11` would red a consumer legitimately sitting on the
  // maintenance LTS, and a floor that reds correct trees is a floor people delete.
  const { problems } = judgeFloor({
    floor: FLOOR,
    resolved: new Map([['next', new Set(['15.5.21'])]]),
    catalogPins: new Map(),
    haveLock: true,
  })
  assert.deepEqual(problems, [])
})

test('ANTI-VACUITY — a lockfile the scanner matched NOTHING in is a RED, not a pass', () => {
  // The failure this guards is the one that matters: if parseLockVersions ever stops
  // matching (an upstream format change), every floor silently judges only the catalog
  // and the gate reports OK forever. Checked globally, because "this ONE package is
  // absent from the lock" is a legitimate state — a catalog pin nothing depends on
  // resolves to nothing — and redding on it would red correct trees.
  const { problems } = judgeFloor({
    floor: FLOOR,
    resolved: new Map(),
    catalogPins: new Map([['next', '16.2.11']]),
    haveLock: true,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /matched ZERO packages/)
  assert.match(problems[0], /pass vacuously/)
})

test('a floored package absent from a WORKING lock is skipped, not red', () => {
  // The other side of that boundary: the scanner is demonstrably alive (it found
  // something), and `next` genuinely is not in this tree.
  const { problems } = judgeFloor({
    floor: FLOOR,
    resolved: new Map([['@alloc/quick-lru', new Set(['5.2.0'])]]),
    catalogPins: new Map(),
    haveLock: true,
  })
  assert.deepEqual(problems, [])
})

test('an EMPTY floor reds rather than reporting a clean tree', () => {
  const { problems } = judgeFloor({
    floor: { packages: {} },
    resolved: new Map(),
    catalogPins: new Map(),
    haveLock: true,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /declares no packages/)
})

// ── the clockful half: staleReviews ───────────────────────────────────────────────

test('a review inside its window is clean; the day AFTER reviewedUntil is not', () => {
  assert.deepEqual(staleReviews({ floor: FLOOR, today: '2026-11-06' }), [])
  const lapsed = staleReviews({ floor: FLOOR, today: '2026-11-07' })
  assert.equal(lapsed.length, 1)
  assert.match(lapsed[0], /its review lapsed on 2026-11-06/)
})

test('a non-ISO reviewedUntil reds instead of comparing as a string', () => {
  const floor = { packages: { next: { reviewedOn: '2026-08-06', reviewedUntil: 'soon' } } }
  const problems = staleReviews({ floor, today: '2026-08-06' })
  assert.ok(problems.some((p) => /must be an ISO date/.test(p)))
})

test('the SHIPPED floor is well-formed and its window is forward-looking', () => {
  const floor = floorJson()
  const entries = Object.entries(floor.packages ?? {})
  assert.ok(entries.length >= 1)
  for (const [name, entry] of entries) {
    assert.ok(entry.reviewedOn < entry.reviewedUntil, `${name}: reviewedUntil must be later`)
    assert.ok(entry.advisories.length >= 1, `${name}: a floor with no advisory has no reason`)
    for (const a of entry.advisories) {
      assert.match(a.id, /^(?:CVE|GHSA)-/, `${name}: ${a.id} is not an advisory id`)
      assert.ok(['High', 'Medium', 'Low', 'Critical'].includes(a.severity), `${name}: ${a.id}`)
      // No CVSS field: the cited advisory publishes severity ratings and no scores, and a
      // number this file cannot source is a number that must not ship.
      assert.equal(Object.hasOwn(a, 'cvss'), false, `${name}: ${a.id} carries an unsourced score`)
    }
  }
  // Shape-only, deliberately: asserting the review is unlapsed TODAY would make this
  // suite red on a date, which is the non-determinism the split exists to avoid.
})

// ── the review WINDOW: clockless, and the half that can red at edit time (0.6.0) ──
//
// The defect this closes is an off switch reachable from inside the file it protects.
// `staleReviews` asks whether a review has lapsed; nothing asked how far ahead the reviewer
// was allowed to push the lapse date, so one edit writing a distant `reviewedUntil` retires
// the freshness control — and the only check that would object is the one that edit disarms.

test('the 92-day window this file ACTUALLY SHIPPED WITH is what the check reds on', () => {
  // Not a hypothetical: template/base/tools/framework-floor.json carried exactly these two
  // dates through 0.5.0. A red-proof written against an invented value would prove the
  // arithmetic and not the defect.
  const shipped = { packages: { next: { reviewedOn: '2026-08-06', reviewedUntil: '2026-11-06' } } }
  const problems = reviewWindowProblems({ floor: shipped })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /the review window is 92 days/)
  assert.match(problems[0], /over the 31-day maximum/)
  // The message must say WHAT WAS AT RISK, not just that a number is too big.
  assert.match(problems[0], /silently spans about 3 of them/)
})

test('CANARY — a distant reviewedUntil cannot silently retire the freshness control', () => {
  const offSwitch = {
    packages: { next: { reviewedOn: '2026-08-06', reviewedUntil: '2099-01-01' } },
  }
  assert.equal(reviewWindowProblems({ floor: offSwitch }).length, 1)
  // ...and it is INERT to the clockful half, which is the whole point: on any real calendar
  // date this passes `staleReviews`, so before 0.6.0 nothing in the repository objected.
  assert.deepEqual(staleReviews({ floor: offSwitch, today: '2026-08-06' }), [])
})

test('the boundary is inclusive at 31 days and reds at 32', () => {
  const at = (until) =>
    reviewWindowProblems({
      floor: { packages: { next: { reviewedOn: '2026-08-06', reviewedUntil: until } } },
    })
  assert.deepEqual(at('2026-09-06'), []) // exactly 31 — one calendar month, the honest cadence
  assert.equal(at('2026-09-07').length, 1) // 32
})

test('a reviewedUntil BEFORE reviewedOn is its own finding, not an under-long window', () => {
  const inverted = { packages: { next: { reviewedOn: '2026-08-06', reviewedUntil: '2026-08-01' } } }
  const problems = reviewWindowProblems({ floor: inverted })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /expired before it happened/)
})

test('a malformed date is left to staleReviews rather than reported twice', () => {
  const malformed = { packages: { next: { reviewedOn: 'yesterday', reviewedUntil: '2026-09-06' } } }
  assert.deepEqual(reviewWindowProblems({ floor: malformed }), [])
  assert.ok(staleReviews({ floor: malformed, today: '2026-08-06' }).some((p) => /ISO date/.test(p)))
})

test('the SHIPPED floor is inside the window bound', () => {
  assert.deepEqual(reviewWindowProblems({ floor: floorJson() }), [])
})

test('MAX_REVIEW_WINDOW_DAYS is one calendar month, matching the upstream cadence', () => {
  // 31, not 30: a maintainer who re-reads the feed every month and moves both dates together
  // lands on at most 31 days, so an honest monthly cadence must never red on month length.
  assert.equal(MAX_REVIEW_WINDOW_DAYS, 31)
})

// ── the lane red-proof ────────────────────────────────────────────────────────────

test('CANARY — the shipped floor-review script EXITS 1 on a backdated review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-floor-'))
  const path = join(dir, 'framework-floor.json')
  const floor = floorJson()
  for (const entry of Object.values(floor.packages)) entry.reviewedUntil = '2020-01-01'
  writeFileSync(path, JSON.stringify(floor))

  const script = join(ROOT, 'template/base/tools/check-framework-floor.mjs')
  const red = spawnSync(process.execPath, [script, `--floor=${path}`, '--today=2026-08-06'], {
    encoding: 'utf8',
  })
  assert.equal(
    red.status,
    1,
    `expected a red, got ${String(red.status)}: ${red.stdout}${red.stderr}`,
  )
  assert.match(red.stderr, /floor-review: FAIL \(1\)/)
  assert.match(red.stderr, /as of 2026-08-06: /)
  assert.match(red.stderr, /lapsed on 2020-01-01/)
  // The house contract: every gate failure carries a reproduce line.
  assert.match(red.stderr, /FIX\[floor-review\]:/)

  // ...and green on the SHIPPED dates, so the red above is the backdating and not the
  // script being broken.
  const green = spawnSync(
    process.execPath,
    [script, `--floor=${SHIPPED_FLOOR}`, '--today=2026-08-06'],
    { encoding: 'utf8' },
  )
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`)
  assert.match(green.stdout, /floor-review: OK — 1 floored package\(s\) \(next\)/)
})

test('CANARY — a MISSING floor file reds rather than passing as "nothing to check"', () => {
  const script = join(ROOT, 'template/base/tools/check-framework-floor.mjs')
  const r = spawnSync(process.execPath, [script, '--floor=tools/does-not-exist.json'], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /does not exist/)
})

test('CANARY — the vendor-support register rides the lane: a lapsed review reds naming the subject', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-support-'))
  const script = join(ROOT, 'template/base/tools/check-framework-floor.mjs')
  const path = join(dir, 'support-register.json')
  const shipped = JSON.parse(
    readFileSync(join(ROOT, 'template/base/tools/support-register.json'), 'utf8'),
  )
  shipped.platforms[0].reviewedUntil = '2020-01-01'
  writeFileSync(path, JSON.stringify(shipped))

  const red = spawnSync(
    process.execPath,
    [script, `--floor=${SHIPPED_FLOOR}`, '--today=2026-08-06', `--support-register=${path}`],
    { encoding: 'utf8' },
  )
  assert.equal(red.status, 1, `${red.stdout}${red.stderr}`)
  assert.match(red.stderr, /'postgres-17' lapsed on 2020-01-01/)

  // …and green on the SHIPPED register, so the red is the backdating.
  const green = spawnSync(
    process.execPath,
    [
      script,
      `--floor=${SHIPPED_FLOOR}`,
      '--today=2026-08-06',
      `--support-register=${join(ROOT, 'template/base/tools/support-register.json')}`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`)
  assert.match(green.stdout, /vendor-support register/)
})

test('CANARY — the security.txt bound rides the lane: expired and too-distant red, live passes, absent NOTEs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-stxt-'))
  const script = join(ROOT, 'template/base/tools/check-framework-floor.mjs')
  const stxt = (name, expires) => {
    const p = join(dir, `${name}.txt`)
    writeFileSync(p, `Contact: mailto:security@example.com\nExpires: ${expires}\n`)
    return p
  }
  const run = (path) =>
    spawnSync(
      process.execPath,
      [script, `--floor=${SHIPPED_FLOOR}`, '--today=2026-08-06', `--security-txt=${path}`],
      { encoding: 'utf8' },
    )

  const expired = run(stxt('expired', '2026-08-01T00:00:00.000Z'))
  assert.equal(expired.status, 1, `${expired.stdout}${expired.stderr}`)
  assert.match(expired.stderr, /EXPIRED at 2026-08-01/)

  const distant = run(stxt('distant', '2028-01-01T00:00:00.000Z'))
  assert.equal(distant.status, 1, `${distant.stdout}${distant.stderr}`)
  assert.match(distant.stderr, /more than 366 days out/)

  const live = run(stxt('live', '2026-12-31T23:59:59.000Z'))
  assert.equal(live.status, 0, `${live.stdout}${live.stderr}`)
  assert.match(live.stdout, /security\.txt bound/)

  // Absent stays a NOTE, never a red: the file is seedOnInitOnly, so an existing
  // install legitimately has no bound to have let lapse.
  const absent = run(join(dir, 'nope.txt'))
  assert.equal(absent.status, 0, `${absent.stdout}${absent.stderr}`)
  assert.match(absent.stdout, /NOTE — .*absent/)
})
