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
  parseLockVersions,
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
  assert.equal(red.status, 1, `expected a red, got ${String(red.status)}: ${red.stdout}${red.stderr}`)
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
