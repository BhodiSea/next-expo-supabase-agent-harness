// The ramp LEDGER (0.4.0) — the primitives scripts/check-ramp-ledger.mjs and the upgrade
// lane both rest on. Three properties, and the middle one is why the module exists:
//
//   1. the scanner reads a real call site, including the multi-line and const-indirected
//      spellings the shipped gates actually use;
//   2. a ramp whose minVersion predates the lineage's oldest release can NEVER fire, so it
//      is decoration rather than an escape — six shipped for three releases before anything
//      counted, and three surveys of this release called them "expiring";
//   3. the classification mirrors gate.mjs's own order, so the lane's expectation and the
//      gate's behaviour cannot disagree.
//
// 0.5.0 adds the fourth: the DEADLINE RATCHET. A promise the runbook makes to consumers in
// writing — "there is no flag that extends a deadline" — was, until this release, prose.
// SOURCE: scripts/lib/ramp-sites.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  classifyForInstall,
  cmpDotted,
  deadlineRegressions,
  LINEAGE_FLOOR,
  neverArmed,
  rampNoteCalls,
  rampSitesFromSources,
  shippedRampSites,
} from '../../scripts/lib/ramp-sites.mjs'

test('rampNoteCalls reads a multi-line call and skips a commented mention', () => {
  const src = `
// rampNote(GATE, '9.9.9', 'a mention in prose', { until: '9.9.9' })
 * rampNote(GATE, '8.8.8', 'a jsdoc mention', { until: '8.8.8' })
if (
  rampNote(GATE, '0.2.0', \`\${errs.length} finding(s) (with (nested) parens)\`, {
    until: '0.5.0',
  })
) {
  ok(GATE, 'held')
}
`
  const calls = rampNoteCalls(src)
  assert.equal(calls.length, 1, `prose mentions must not count as call sites: ${JSON.stringify(calls)}`)
  assert.match(calls[0].args, /until: '0\.5\.0'/)
  // The balanced-paren scan is the point: a regex would stop at the first `)` inside the
  // template literal and lose the `until` entirely.
  assert.match(calls[0].args, /nested/)
  assert.equal(src.slice(calls[0].at, calls[0].at + 9), 'rampNote(')
})

test('the shipped fleet is fully parseable — no site is silently exempt', () => {
  const sites = shippedRampSites()
  assert.ok(sites.length >= 15, `expected the ramp fleet, found ${String(sites.length)}`)
  const unresolved = sites.filter((s) => s.minVersion === null || s.until === null)
  assert.deepEqual(
    unresolved.map((s) => `${s.file}: ${s.args.slice(0, 60)}`),
    [],
    'a site whose minVersion/until cannot be resolved is a site the ledger does not cover',
  )
})

test('no shipped ramp sits below the lineage floor — a never-armed ramp is decoration', () => {
  // The 0.4.0 finding, kept as a standing assertion. `neverArmed` is what the factory gate
  // reds on; this is the same claim at authoring time.
  assert.deepEqual(
    neverArmed(shippedRampSites()).map((s) => `${s.file} (minVersion ${s.minVersion})`),
    [],
    `a rampNote whose minVersion is below v${LINEAGE_FLOOR} can never fire: gate.mjs returns false at \`base >= minVersion\` for every install that has ever existed`,
  )
})

test('an unconsumed rampNote() is detected — the expiry that rings into a green run', () => {
  // THE 0.4.0 DEFECT, kept as a fixture. rampNote signals expiry by printing RAMP EXPIRED
  // and returning FALSE — the same value it returns when the check is simply live. So a
  // site that discards the result takes the identical path on both sides of the deadline,
  // and check-rate-limits.mjs's ended in ok(): the alarm printed to stderr and the gate
  // exited 0. It shipped that way for three releases and the release notes counted it.
  const dir = mkdtempSync(join(tmpdir(), 'ramp-consumed-'))
  writeFileSync(
    join(dir, 'check-discarded.mjs'),
    `const RAMP = '0.2.0'\nif (!existsSync(BUDGET)) {\n  rampNote(GATE, RAMP, 'missing', { until: '0.4.0' })\n  ok(GATE, 'nothing to judge')\n}\n`,
  )
  writeFileSync(
    join(dir, 'check-guarded.mjs'),
    `if (\n  rampNote(GATE, '0.2.0', 'missing', { until: '0.4.0' })\n) {\n  ok(GATE, 'ramped')\n}\nskipOrFail(GATE, 'missing')\n`,
  )
  writeFileSync(
    join(dir, 'check-assigned.mjs'),
    `const ramped = rampNote(GATE, '0.2.0', 'findings', { until: '0.4.0' })\nif (!ramped) errs.push(...)\n`,
  )
  writeFileSync(
    join(dir, 'check-negated.mjs'),
    `if (!rampNote(GATE, '0.2.0', 'findings', { until: '0.4.0' })) errs.push('x')\n`,
  )

  const byFile = new Map(shippedRampSites(dir).map((s) => [s.file, s]))
  assert.equal(byFile.size, 4, 'every fixture must be scanned')
  assert.equal(byFile.get('check-discarded.mjs').consumed, false)
  assert.equal(byFile.get('check-guarded.mjs').consumed, true)
  assert.equal(byFile.get('check-assigned.mjs').consumed, true)
  assert.equal(byFile.get('check-negated.mjs').consumed, true)
  // The line number is what the ledger prints, so a maintainer can open the site.
  assert.equal(byFile.get('check-discarded.mjs').line, 3)
})

test('every shipped ramp consumes its result — no gate rings into a green run', () => {
  assert.deepEqual(
    shippedRampSites()
      .filter((s) => !s.consumed)
      .map((s) => `${s.file}:${String(s.line)}`),
    [],
    'a discarded rampNote() result means the deadline changes nothing: expiry and already-live are both `false`',
  )
})

test('classifyForInstall mirrors gate.mjs — inert BEFORE expired, expired before noting', () => {
  const sites = [
    { file: 'a.mjs', minVersion: '0.2.0', until: '0.4.0', args: '' },
    { file: 'b.mjs', minVersion: '0.4.0', until: '0.5.0', args: '' },
    { file: 'c.mjs', minVersion: '0.1.3', until: '0.4.0', args: '' },
  ]

  // A 0.1.3 install on harness 0.4.0: `a` has reached its deadline; `b` is not yet ramped
  // in; `c` is already live because base >= minVersion — and that INERT check is evaluated
  // first, exactly as gate.mjs does, so a site can never be reported expired when its
  // escape was never open.
  const old = classifyForInstall('0.1.3', '0.4.0', sites)
  assert.deepEqual(old.expired.map((s) => s.file), ['a.mjs'])
  assert.deepEqual(old.noting.map((s) => s.file), ['b.mjs'])
  assert.deepEqual(old.inert.map((s) => s.file), ['c.mjs'])

  // A current install meets no deadline at all — the property that makes an upgrade from
  // the previous release a no-op, and the reason the lane needs a `--from` older than it.
  const fresh = classifyForInstall('0.4.0', '0.4.0', sites)
  assert.equal(fresh.expired.length, 0)
  assert.equal(fresh.noting.length, 0)
  assert.equal(fresh.inert.length, 3)
})

test('cmpDotted orders releases numerically, not lexically', () => {
  // '0.10.0' > '0.9.0' is the case a string compare gets wrong, and it is one minor away.
  assert.equal(cmpDotted('0.10.0', '0.9.0'), 1)
  assert.equal(cmpDotted('0.4.0', '0.4.0'), 0)
  assert.equal(cmpDotted('0.1.3', '0.2.0'), -1)
})

// ── the deadline ratchet (0.5.0) ──────────────────────────────────────────────────────

const site = (file, minVersion, until) => ({ file, minVersion, until })
const EXT = (file, minVersion, from, to) => ({
  file,
  minVersion,
  from,
  to,
  why: 'a reason long enough to be a reason rather than a rubber stamp, naming the finding.',
})

test('rampSitesFromSources reads injected sources — the seam the ratchet needs', () => {
  // The previous release's tree exists only as `git show` output. A directory-only scanner
  // could not read it, which is why this seam exists rather than being decoration.
  const sites = rampSitesFromSources([
    {
      file: 'check-x.mjs',
      src: "const GATE = 'x'\nif (rampNote(GATE, '0.3.0', 'a finding', { until: '0.5.0' })) ok(GATE)\n",
    },
    { file: 'check-none.mjs', src: 'const GATE = "none"\n' },
  ])
  assert.equal(sites.length, 1)
  assert.deepEqual(
    { gate: sites[0].gate, min: sites[0].minVersion, until: sites[0].until },
    { gate: 'x', min: '0.3.0', until: '0.5.0' },
  )
})

test('CANARY — a deadline moved LATER reds, naming both dates', () => {
  const { problems, regressions } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    current: [site('check-wiring.mjs', '0.3.0', '0.6.0')],
  })
  assert.equal(regressions.length, 1)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /moved its deadline from 0\.5\.0 to 0\.6\.0/)
  assert.match(problems[0], /there is no flag that extends a deadline/)
})

test('CANARY — moving ONE of four sites that share a group is caught', () => {
  // check-docs-sync.mjs really does carry four sites at minVersion 0.3.0. Grouping by
  // (file, minVersion) is only safe if a single move inside the group still reds, which is
  // what the pointwise-sorted comparison buys.
  const four = (a, b, c, d) =>
    [a, b, c, d].map((u) => site('check-docs-sync.mjs', '0.3.0', u))
  const { problems } = deadlineRegressions({
    previous: four('0.5.0', '0.5.0', '0.5.0', '0.5.0'),
    current: four('0.5.0', '0.6.0', '0.5.0', '0.5.0'),
  })
  assert.equal(problems.length, 1, `expected one regression, got ${JSON.stringify(problems)}`)
  assert.match(problems[0], /check-docs-sync\.mjs/)
})

test('an EARLIER deadline is never a regression — tightening is always allowed', () => {
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.6.0')],
    current: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
  })
  assert.deepEqual(problems, [])
})

test('a DELETED ramp group is not a regression — an unconditional check is stricter', () => {
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    current: [],
  })
  assert.deepEqual(problems, [])
})

test('a matching rampExtensions entry excuses the move; a thin `why` still reds', () => {
  const previous = [site('check-wiring.mjs', '0.3.0', '0.5.0')]
  const current = [site('check-wiring.mjs', '0.3.0', '0.6.0')]

  const excused = deadlineRegressions({
    previous,
    current,
    extensions: [EXT('check-wiring.mjs', '0.3.0', '0.5.0', '0.6.0')],
  })
  assert.deepEqual(excused.problems, [])
  assert.equal(excused.regressions.length, 1, 'excused, but still counted and reported')

  const thin = deadlineRegressions({
    previous,
    current,
    extensions: [{ file: 'check-wiring.mjs', minVersion: '0.3.0', from: '0.5.0', to: '0.6.0', why: 'later' }],
  })
  assert.equal(thin.problems.length, 1)
  assert.match(thin.problems[0], /is the only thing a consumer reads/)
})

test('CANARY — a STALE rampExtensions entry reds: a standing permission slip', () => {
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    current: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    extensions: [EXT('check-wiring.mjs', '0.3.0', '0.5.0', '0.6.0')],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /stale extension is a standing permission slip/)
})

test('the ratchet excuse must match EXACTLY — a near-miss entry does not launder the move', () => {
  // Two problems, and that is correct: the real move is unexcused, and the entry that was
  // meant to excuse it names a move nobody made.
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    current: [site('check-wiring.mjs', '0.3.0', '0.6.0')],
    extensions: [EXT('check-wiring.mjs', '0.4.0', '0.5.0', '0.6.0')], // wrong minVersion
  })
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => /moved its deadline/.test(p)))
  assert.ok(problems.some((p) => /stale extension/.test(p)))
})

test('THE DOCUMENTED HOLE — move-one-and-add-one is NOT caught, and the header says so', () => {
  // Pinned deliberately. Ramp sites carry no stable id, so a group's deadlines are compared
  // as sorted lists; adding a site at the old deadline in the same commit that moves
  // another one makes the lists line up. Closing it needs a per-site id, which this release
  // did not take. Asserting the limit is how the limit stays stated rather than forgotten —
  // if a later release adds ids, this test fails and is DELETED, which is the signal.
  const { problems } = deadlineRegressions({
    previous: [site('check-docs-sync.mjs', '0.3.0', '0.5.0')],
    current: [
      site('check-docs-sync.mjs', '0.3.0', '0.6.0'),
      site('check-docs-sync.mjs', '0.3.0', '0.5.0'),
    ],
  })
  assert.deepEqual(problems, [], 'the residual hole is documented in scripts/lib/ramp-sites.mjs')
  const header = readFileSync(new URL('../../scripts/lib/ramp-sites.mjs', import.meta.url), 'utf8')
  assert.match(header, /ADDING a new site to the same group at the old deadline/)
})

// ── the affected population, as data (0.5.0) ──────────────────────────────────────────

test('the SHIPPED 0.5.0 rampExpiry record equals what the shipped call sites compute', () => {
  // check-ramp-ledger.mjs makes this assertion at the CURRENT package version, so the
  // 0.5.0 record is unread until the release bump. Verifying it here means the record is
  // proven the moment it is written, not the moment it ships.
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const record = migrations['0.5.0']?.rampExpiry
  assert.ok(record, 'the release that closes eight escapes must say whose')

  const sites = shippedRampSites()
  const VINTAGES = [LINEAGE_FLOOR, '0.2.0', '0.2.1', '0.3.0', '0.4.0']
  const computed = VINTAGES.filter((v) => cmpDotted(v, '0.5.0') < 0).filter(
    (base) => classifyForInstall(base, '0.5.0', sites).expired.length > 0,
  )
  assert.deepEqual(record.affects, computed)

  // The other half of the claim: 0.4.0 is the ONE released vintage this release does not
  // red, which is why the upgrade lane keeps its default leg.
  assert.equal(classifyForInstall('0.4.0', '0.5.0', sites).expired.length, 0)
})

test('EIGHT escapes close in 0.5.0, and they are the eight the record describes', () => {
  const expiring = shippedRampSites().filter((s) => s.until === '0.5.0')
  assert.equal(expiring.length, 8, `the release note is derived from this set: ${JSON.stringify(expiring.map((s) => `${s.file}:${String(s.line)}`))}`)
  assert.deepEqual(
    [...new Set(expiring.map((s) => s.gate))].sort(),
    ['diff-coverage', 'docs-sync', 'gate-integrity', 'wiring'],
  )
  // Kept, not deleted. Dropping the wrappers would take the fleet from 20 to 12 against
  // three separate anti-vacuity floors that hard-fail below 15.
  assert.ok(shippedRampSites().length >= 15, 'the fleet floor the ledger and both tests pin')
})
