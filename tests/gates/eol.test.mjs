// The end-of-life closure (0.9.9) — the control that asks whether a dependency's VENDOR
// still supports it, which nothing in the chain asked before. `framework-floor.json` asks
// whether a pin is PATCHED; a package below a floor has a fix waiting for it, and a package
// whose vendor has walked away has none, ever.
//
// Three halves, and the split between them IS the design:
//   - parseDeprecations / productionClosure / judgeDeprecations are CLOCKLESS and OFFLINE.
//     They read the npm registry's own `deprecated` message out of the RESOLVED lockfile,
//     which pnpm copies in at resolve time — a committed third-party artefact, so the check
//     rides chain step 12 without asking a live endpoint anything.
//   - judgeSupported is REVIEWED DATA, because there is nothing to derive: Expo publishes no
//     per-SDK end-of-life date in any machine-readable form, so a computed date would be
//     this repo's arithmetic behind a vendor's name.
//   - staleEolReview is CLOCKFUL. It rides the scheduled `floor-review` job only, and its
//     `today` is a parameter so this file can backdate a review without owning a calendar.
//
// THE LOAD-BEARING TEST IS THE PEER-EDGE ONE. `expo-router` peer-depends on
// `@testing-library/react-native`, pnpm records a resolved peer as an ordinary snapshot edge,
// and without the correction that drags jest 29 — and the deprecated `glob@7` and `inflight`
// inside it — into the "production" closure of a tree where the testing library is a
// devDependency. A control that reds a correct tree is a control somebody deletes.
// SOURCE: template/base/tools/lib/eol.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  arrivedAcceptances,
  eolReviewWindow,
  judgeDeprecations,
  judgeSupported,
  parseDeprecations,
  productionClosure,
  staleEolReview,
} from '../../template/base/tools/lib/eol.mjs'
import {
  MAX_REVIEW_WINDOW_DAYS,
  parseLockVersions,
} from '../../template/base/tools/lib/framework-floor.mjs'
import { cmpDotted } from '../../template/base/tools/lib/gate.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHIPPED = join(ROOT, 'template/base/tools/eol.json')
const shipped = () => JSON.parse(readFileSync(SHIPPED, 'utf8'))
const PATH = 'tools/eol.json'

// A lockfile fixture in the real v9 shape, small enough to reason about completely.
//
// `dev-tool` is a devDependency that pulls the deprecated `old-glob`; `app-runtime` is a
// production dependency that pulls the deprecated `old-uuid` through `build-helper`. And
// `app-runtime` PEER-depends on `dev-tool`, which is the shape that produced a live false
// positive before productionClosure learned to read peerDependencies: the peer edge makes
// `old-glob` look production-reachable when the only thing supplying `dev-tool` is a
// devDependency.
const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      app-runtime:
        specifier: ^1.0.0
        version: 1.2.0
    devDependencies:
      dev-tool:
        specifier: ^2.0.0
        version: 2.1.0

packages:

  app-runtime@1.2.0:
    resolution: {integrity: sha512-aaa}
    peerDependencies:
      dev-tool: '*'

  build-helper@3.0.0:
    resolution: {integrity: sha512-bbb}

  dev-tool@2.1.0:
    resolution: {integrity: sha512-ccc}

  old-glob@7.2.3:
    resolution: {integrity: sha512-ddd}
    deprecated: Old versions of glob are not supported, and contain widely publicized security vulnerabilities

  old-uuid@7.0.3:
    resolution: {integrity: sha512-eee}
    deprecated: uuid@10 and below is no longer supported.

snapshots:

  app-runtime@1.2.0(dev-tool@2.1.0):
    dependencies:
      build-helper: 3.0.0
      dev-tool: 2.1.0

  build-helper@3.0.0:
    dependencies:
      old-uuid: 7.0.3

  dev-tool@2.1.0:
    dependencies:
      old-glob: 7.2.3

  old-glob@7.2.3: {}

  old-uuid@7.0.3: {}
`

const REGISTER = {
  reviewedOn: '2026-08-12',
  reviewedUntil: '2026-09-12',
  products: [
    {
      id: 'app-runtime',
      package: 'app-runtime',
      match: 'major',
      supported: ['1'],
      policy: 'The vendor supports the latest two major lines, and says so on this page.',
      source: 'https://example.invalid/support',
    },
  ],
  deprecated: [
    {
      package: 'old-glob',
      majors: ['7'],
      scope: 'development',
      reason: 'the test runner picks it, nothing here selects it, and it discharges with that runner',
    },
    {
      package: 'old-uuid',
      majors: ['7'],
      scope: 'production',
      removalTarget: '0.10.0',
      reason: 'reached through the build helper in the production closure; re-reviewed at 0.10.0',
    },
  ],
}

const clone = (o) => JSON.parse(JSON.stringify(o))

/** Judge a register against the fixture lockfile. */
const judge = (register, over = {}) => {
  const { deprecated, scanned } = parseDeprecations(LOCK)
  const { production, dependents } = productionClosure(LOCK)
  return judgeDeprecations({
    register,
    path: PATH,
    deprecated,
    scanned,
    production,
    dependents,
    haveLock: true,
    ...over,
  })
}

// ---- the artefact this whole closure rests on -----------------------------------------
test('the registry deprecation message is read out of the lockfile verbatim', () => {
  const { deprecated, scanned } = parseDeprecations(LOCK)
  assert.equal(scanned, 5)
  assert.deepEqual([...deprecated.keys()].sort(), ['old-glob@7.2.3', 'old-uuid@7.0.3'])
  // Verbatim, not paraphrased: the entire evidentiary value is that a third party wrote it.
  assert.match(deprecated.get('old-glob@7.2.3'), /^Old versions of glob are not supported/)
})

test('a folded block scalar is gathered, not truncated to an empty deprecation', () => {
  const folded = LOCK.replace(
    '    deprecated: uuid@10 and below is no longer supported.',
    '    deprecated: >-\n      uuid@10 and below is\n      no longer supported.',
  )
  const { deprecated } = parseDeprecations(folded)
  assert.equal(deprecated.get('old-uuid@7.0.3'), 'uuid@10 and below is no longer supported.')
})

// ---- the production closure, and the peer edge that made it wrong ----------------------
test('the production closure follows real edges and excludes devDependencies', () => {
  const { production } = productionClosure(LOCK)
  assert.ok(production.has('app-runtime@1.2.0'))
  assert.ok(production.has('build-helper@3.0.0'))
  assert.ok(production.has('old-uuid@7.0.3'), 'reached through a production dependency')
  assert.ok(!production.has('dev-tool@2.1.0'), 'a devDependency root is not production')
})

test('a peer satisfied by a devDependency is NOT a production edge — the false positive', () => {
  const { production } = productionClosure(LOCK)
  // Without the peerDependencies correction, app-runtime -> dev-tool -> old-glob puts a
  // deprecated test-only package in the production closure and reds a correct tree.
  assert.ok(!production.has('old-glob@7.2.3'))
})

test('a peer satisfied by a PRODUCTION dependency stays an edge — the correction is narrow', () => {
  // dev-tool promoted to a production root: old-glob is now genuinely production-reachable,
  // and dropping every peer edge indiscriminately would have hidden it.
  const promoted = LOCK.replace(
    '    devDependencies:\n      dev-tool:\n        specifier: ^2.0.0\n        version: 2.1.0',
    '      dev-tool:\n        specifier: ^2.0.0\n        version: 2.1.0',
  )
  const { production } = productionClosure(promoted)
  assert.ok(production.has('old-glob@7.2.3'))
})

test('dependents name what pulls a package in, so the message can say what to do about it', () => {
  const { dependents } = productionClosure(LOCK)
  assert.deepEqual([...dependents.get('old-glob@7.2.3')], ['dev-tool@2.1.0'])
})

// ---- the census, both directions -------------------------------------------------------
test('the fixture register agrees with the fixture census — the clean case is real', () => {
  const { problems, judged, unsupportedInProduction } = judge(REGISTER)
  assert.deepEqual(problems, [])
  assert.equal(judged, 2)
  assert.equal(unsupportedInProduction, 1)
})

test('a deprecated package with no row reds, quoting the vendor and naming the parent', () => {
  const reg = clone(REGISTER)
  reg.deprecated = reg.deprecated.filter((r) => r.package !== 'old-glob')
  const { problems } = judge(reg)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /old-glob@7\.2\.3 is DEPRECATED BY ITS VENDOR/)
  assert.match(problems[0], /Old versions of glob are not supported/)
  assert.match(problems[0], /arrives through dev-tool@2\.1\.0/)
})

test('a row whose subject the lockfile no longer deprecates reds — acceptances cannot rot', () => {
  const reg = clone(REGISTER)
  reg.deprecated.push({ package: 'gone', majors: ['1'], scope: 'development', reason: 'x'.repeat(20) })
  assert.match(judge(reg).problems.join('\n'), /which this lockfile does not resolve as deprecated/)
})

test('acceptance is per MAJOR LINE — the vendor’s next major is a new decision', () => {
  const reg = clone(REGISTER)
  reg.deprecated.find((r) => r.package === 'old-glob').majors = ['6']
  assert.match(judge(reg).problems.join('\n'), /old-glob@7\.2\.3 is DEPRECATED BY ITS VENDOR/)
})

// ---- scope is computed, not believed --------------------------------------------------
test('scope UNDERSTATED reds — a production dependency called development', () => {
  const reg = clone(REGISTER)
  const row = reg.deprecated.find((r) => r.package === 'old-uuid')
  row.scope = 'development'
  delete row.removalTarget
  assert.match(
    judge(reg).problems.join('\n'),
    /recorded as `development` scope, but the lockfile puts it in the PRODUCTION dependency closure/,
  )
})

test('scope OVERSTATED reds too — the register must agree with the tree both ways', () => {
  const reg = clone(REGISTER)
  const row = reg.deprecated.find((r) => r.package === 'old-glob')
  row.scope = 'production'
  row.removalTarget = '0.10.0'
  assert.match(
    judge(reg).problems.join('\n'),
    /recorded as `production` scope, but the lockfile reaches it only through devDependencies/,
  )
})

test('a production acceptance with no removalTarget reds — a debt with no date is permanent', () => {
  const reg = clone(REGISTER)
  delete reg.deprecated.find((r) => r.package === 'old-uuid').removalTarget
  assert.match(judge(reg).problems.join('\n'), /`removalTarget` is undefined/)
})

test('a removalTarget on a development row reds — nothing would ever judge it', () => {
  const reg = clone(REGISTER)
  reg.deprecated.find((r) => r.package === 'old-glob').removalTarget = '0.10.0'
  assert.match(judge(reg).problems.join('\n'), /belongs to production acceptances/)
})

test('an empty reason reds — an undocumented decision is indistinguishable from an oversight', () => {
  const reg = clone(REGISTER)
  reg.deprecated.find((r) => r.package === 'old-glob').reason = '   '
  assert.match(judge(reg).problems.join('\n'), /empty `reason`/)
})

// ---- anti-vacuity --------------------------------------------------------------------
test('a broken scanner is a hard finding, not a silent green', () => {
  const { problems } = judge(REGISTER, { deprecated: new Map(), scanned: 0 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /matched ZERO package entries/)
})

test('a CLEAN tree is not an error — zero deprecations is a legitimate state', () => {
  const clean = LOCK.replace(/^ {4}deprecated:.*$/gm, '    engines: {node: ">=18"}')
  const { deprecated, scanned } = parseDeprecations(clean)
  assert.equal(deprecated.size, 0)
  const { production, dependents } = productionClosure(clean)
  const { problems } = judgeDeprecations({
    register: { deprecated: [] },
    path: PATH,
    deprecated,
    scanned,
    production,
    dependents,
    haveLock: true,
  })
  assert.deepEqual(problems, [])
})

// ---- the arrival half, clockless ------------------------------------------------------
test('a production acceptance ARRIVES at its removalTarget and not before', () => {
  const rows = REGISTER.deprecated
  const at = (running) => arrivedAcceptances({ rows, path: PATH, running, cmp: cmpDotted })
  assert.deepEqual(at('0.9.9'), [], 'cmpDotted is numeric per segment, so 0.9.9 < 0.10.0')
  assert.deepEqual(at(null), [], 'no installed release means nothing to compare against')
  assert.match(at('0.10.0').join('\n'), /it has ARRIVED/)
  assert.match(at('1.0.0').join('\n'), /it has ARRIVED/)
})

test('a development acceptance never arrives — only production rows carry the debt', () => {
  const rows = [{ package: 'old-glob', scope: 'development', removalTarget: '0.1.0' }]
  assert.deepEqual(arrivedAcceptances({ rows, path: PATH, running: '9.9.9', cmp: cmpDotted }), [])
})

// ---- the vendor support floor ---------------------------------------------------------
const support = (register, pins) =>
  judgeSupported({
    register,
    path: PATH,
    catalogPins: new Map(Object.entries(pins)),
    resolved: parseLockVersions(LOCK),
  })

test('a pin on a supported line passes and is COUNTED — judged is reported, not implied', () => {
  const { problems, judged } = support(REGISTER, { 'app-runtime': '1.2.0' })
  assert.deepEqual(problems, [])
  assert.equal(judged, 1)
})

test('a pin on a line the vendor no longer supports reds, quoting the vendor and the URL', () => {
  const { problems } = support(REGISTER, { 'app-runtime': '0.9.0' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /is on the 0 line, which tools\/eol\.json does not list/)
  assert.match(problems[0], /The vendor's own words: "The vendor supports the latest two major/)
  assert.match(problems[0], /https:\/\/example\.invalid\/support/)
})

test('a supported set with no vendor QUOTE reds — otherwise it is our opinion, not theirs', () => {
  const reg = clone(REGISTER)
  reg.products[0].policy = 'trust us'
  assert.match(support(reg, {}).problems.join('\n'), /must carry the VENDOR'S OWN WORDS/)
})

test('a supported set with no SOURCE URL reds — the next reviewer must be able to re-read it', () => {
  const reg = clone(REGISTER)
  reg.products[0].source = 'the docs'
  assert.match(support(reg, {}).problems.join('\n'), /must be the URL the policy was read from/)
})

test('an empty supported set reds — it would red every version including the right one', () => {
  const reg = clone(REGISTER)
  reg.products[0].supported = []
  assert.match(support(reg, {}).problems.join('\n'), /must be a non-empty array/)
})

test('minor-series matching is a distinct mode — a 0.x vendor policy needs it', () => {
  const reg = {
    products: [
      {
        id: 'rn',
        package: 'react-native',
        match: 'minor',
        supported: ['0.86'],
        policy: 'We are committed to maintaining the latest three minor series of this library.',
        source: 'https://example.invalid/releases',
      },
    ],
  }
  assert.deepEqual(support(reg, { 'react-native': '0.86.2' }).problems, [])
  assert.match(support(reg, { 'react-native': '0.83.1' }).problems.join('\n'), /on the 0\.83 line/)
})

test('a product absent from both the catalog and the lockfile is silent, not red', () => {
  // A scaffold that dropped apps/mobile has no `expo`, and demanding one would be this gate
  // asserting a product shape the harness does not require. Absent from BOTH sources — an
  // empty catalog is not enough, since the lockfile half would still find it.
  const { problems, judged } = judgeSupported({
    register: REGISTER,
    path: PATH,
    catalogPins: new Map(),
    resolved: new Map(),
  })
  assert.deepEqual(problems, [])
  assert.equal(judged, 0)
})

// ---- the review window: legitimacy (clockless) and lapse (clockful) -------------------
test('the review window is bounded, and the bound is the framework floor’s own constant', () => {
  const reg = clone(REGISTER)
  reg.reviewedUntil = '2099-01-01'
  const problems = eolReviewWindow({ register: reg, path: PATH, maxWindowDays: MAX_REVIEW_WINDOW_DAYS })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /over the 31-day maximum/)
})

test('a window that expired before it opened reds', () => {
  const reg = clone(REGISTER)
  reg.reviewedUntil = '2026-08-01'
  assert.match(
    eolReviewWindow({ register: reg, path: PATH, maxWindowDays: MAX_REVIEW_WINDOW_DAYS }).join('\n'),
    /is BEFORE reviewedOn/,
  )
})

test('a non-ISO review date reds rather than being silently unjudgeable', () => {
  const reg = clone(REGISTER)
  reg.reviewedOn = 'last Tuesday'
  assert.match(
    eolReviewWindow({ register: reg, path: PATH, maxWindowDays: MAX_REVIEW_WINDOW_DAYS }).join('\n'),
    /must both be ISO dates/,
  )
})

test('the CLOCKFUL half lapses on a date and not before — `today` is a parameter', () => {
  assert.deepEqual(staleEolReview({ register: REGISTER, path: PATH, today: '2026-09-12' }), [])
  assert.match(
    staleEolReview({ register: REGISTER, path: PATH, today: '2026-09-13' }).join('\n'),
    /its review lapsed on 2026-09-12/,
  )
})

// ---- the SHIPPED register, judged as shipped ------------------------------------------
test('the shipped register is internally well-formed and bounded', () => {
  const reg = shipped()
  assert.deepEqual(
    eolReviewWindow({ register: reg, path: PATH, maxWindowDays: MAX_REVIEW_WINDOW_DAYS }),
    [],
  )
  assert.ok(reg.deprecated.length > 0, 'a register with no rows proves nothing about this tree')
  assert.ok(reg.products.length > 0)
  // Every production acceptance carries a date, and every development one does not.
  for (const row of reg.deprecated) {
    if (row.scope === 'production') assert.match(String(row.removalTarget), /^\d+\.\d+\.\d+$/)
    else assert.equal(row.removalTarget, undefined)
  }
})

test('the shipped support rows quote a real vendor policy at a real URL', () => {
  const { problems } = judgeSupported({
    register: shipped(),
    path: PATH,
    catalogPins: new Map(),
    resolved: new Map(),
  })
  assert.deepEqual(problems, [])
})

test('the shipped support rows accept the catalog’s own expo and react-native pins', () => {
  const catalog = readFileSync(join(ROOT, 'template/base/pnpm-workspace.yaml'), 'utf8')
  const pin = (name) => new RegExp(`^  ${name}: (\\S+)`, 'm').exec(catalog)?.[1]
  const pins = new Map([
    ['expo', pin('expo')],
    ['react-native', pin('react-native')],
  ])
  assert.ok(pins.get('expo') !== undefined && pins.get('react-native') !== undefined)
  const { problems, judged } = judgeSupported({
    register: shipped(),
    path: PATH,
    catalogPins: pins,
    resolved: new Map(),
  })
  assert.deepEqual(problems, [], 'the shipped catalog must sit on lines its vendors still support')
  assert.equal(judged, 2)
})
