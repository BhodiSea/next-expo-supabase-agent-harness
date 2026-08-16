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
//
// 0.6.0 adds the fifth, and it is a correction rather than an addition. The ratchet keyed
// sites by (file, minVersion), so a re-opened ramp — new minVersion, new deadline — retired
// one key and created another, which reads as a deletion plus a new escape and passes. This
// release did exactly that to check-docs-sync.mjs and nothing noticed. The key is now the
// DETAIL STRING, and the tests below are the proof for both the evasion that was open and
// the one 0.5.0 documented as residual.
// SOURCE: scripts/lib/ramp-sites.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkDetailIds,
  checkVintages,
  classifyForInstall,
  cmpDotted,
  deadlineRegressions,
  highestReleaseBelow,
  LINEAGE_FLOOR,
  neverArmed,
  rampNoteCalls,
  rampSitesFromSources,
  shippedRampSites,
  VINTAGES,
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

// `detail` defaults so the tests that are ABOUT the deadline arithmetic stay about it. The
// tests that are about identity name their details explicitly, because that is the subject.
const site = (file, minVersion, until, detail = 'the escape') => ({
  file,
  minVersion,
  until,
  detail,
})
const EXT = (file, detail, from, to) => ({
  file,
  detail,
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

test('CANARY — moving ONE of four sites in the same file is caught, and NAMED', () => {
  // check-docs-sync.mjs really does carry four sites. Under the (file, minVersion) key they
  // were one group compared as a sorted list, and the finding could only say "this file".
  // Under the detail key each is its own slot, so the finding says WHICH escape moved —
  // which is also what makes the rampExtensions record copyable from the message.
  const DETAILS = ['gate-list lockstep', 'approved-tools pair', 'doctrine token map', 'tiers shape']
  const four = (untils) =>
    DETAILS.map((d, i) => site('check-docs-sync.mjs', '0.3.0', untils[i], d))
  const { problems, regressions } = deadlineRegressions({
    previous: four(['0.5.0', '0.5.0', '0.5.0', '0.5.0']),
    current: four(['0.5.0', '0.6.0', '0.5.0', '0.5.0']),
  })
  assert.equal(problems.length, 1, `expected one regression, got ${JSON.stringify(problems)}`)
  assert.match(problems[0], /check-docs-sync\.mjs/)
  assert.equal(regressions[0].detail, 'approved-tools pair')
})

test('two sites SHARING a detail still ratchet pointwise — the previous tree gets no vote', () => {
  // checkDetailIds reds on a duplicate detail in the CURRENT tree, but a previous release
  // tag is read as it was. The sorted-list fallback is what stops that degrading to nothing.
  const pair = (a, b) =>
    [a, b].map((u) => site('check-wiring.mjs', '0.3.0', u, 'the same words twice'))
  const { problems } = deadlineRegressions({
    previous: pair('0.5.0', '0.5.0'),
    current: pair('0.5.0', '0.6.0'),
  })
  assert.equal(problems.length, 1)
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
    extensions: [EXT('check-wiring.mjs', 'the escape', '0.5.0', '0.6.0')],
  })
  assert.deepEqual(excused.problems, [])
  assert.equal(excused.regressions.length, 1, 'excused, but still counted and reported')

  const thin = deadlineRegressions({
    previous,
    current,
    extensions: [
      { file: 'check-wiring.mjs', detail: 'the escape', from: '0.5.0', to: '0.6.0', why: 'later' },
    ],
  })
  assert.equal(thin.problems.length, 1)
  assert.match(thin.problems[0], /is the only thing a consumer reads/)
})

test('CANARY — a STALE rampExtensions entry reds: a standing permission slip', () => {
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    current: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    extensions: [EXT('check-wiring.mjs', 'the escape', '0.5.0', '0.6.0')],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /stale extension is a standing permission slip/)
})

test('the ratchet excuse must match EXACTLY — a near-miss entry does not launder the move', () => {
  // Two problems, and that is correct: the real move is unexcused, and the entry that was
  // meant to excuse it names a move nobody made. The near-miss is a wrong DETAIL now, not a
  // wrong minVersion — minVersion is deliberately not matched on, because a re-opened ramp
  // changes it and an excuse keyed to it would go stale in the act it was written for.
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0')],
    current: [site('check-wiring.mjs', '0.3.0', '0.6.0')],
    extensions: [EXT('check-wiring.mjs', 'a different escape', '0.5.0', '0.6.0')],
  })
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => /moved its deadline/.test(p)))
  assert.ok(problems.some((p) => /stale extension/.test(p)))
})

test('an excuse keyed to the OLD minVersion still works — the id is the words, not the version', () => {
  // The point of re-keying. 0.6.0's real record extends a site whose minVersion moved
  // 0.3.0 -> 0.6.0 in the same edit; an excuse that had to name a minVersion could name
  // neither the before nor the after without being wrong about the other.
  const { problems } = deadlineRegressions({
    previous: [site('check-docs-sync.mjs', '0.3.0', '0.5.0', 'gate-list lockstep')],
    current: [site('check-docs-sync.mjs', '0.6.0', '0.7.0', 'gate-list lockstep')],
    extensions: [EXT('check-docs-sync.mjs', 'gate-list lockstep', '0.5.0', '0.7.0')],
  })
  assert.deepEqual(problems, [])
})

test('CANARY — RE-OPENING a ramp at a higher minVersion is a deadline move (the 0.6.0 hole)', () => {
  // THE EVASION THIS RELEASE PERFORMED. Under the (file, minVersion) key the old slot
  // vanished (read as a deletion, which is stricter, so allowed) and a new one appeared
  // (read as a new escape, so allowed). Two permitted acts composing into the one act the
  // runbook promises consumers cannot happen. It is a canary because the fix is a KEY —
  // one line — and a key is exactly the kind of thing a later refactor reverts by accident.
  const { problems, regressions } = deadlineRegressions({
    previous: [site('check-docs-sync.mjs', '0.3.0', '0.5.0', 'gate-list lockstep')],
    current: [site('check-docs-sync.mjs', '0.6.0', '0.7.0', 'gate-list lockstep')],
  })
  assert.equal(problems.length, 1, `re-opening must red: ${JSON.stringify(problems)}`)
  assert.match(problems[0], /moved its deadline from 0\.5\.0 to 0\.7\.0/)
  assert.match(problems[0], /now opens at minVersion 0\.6\.0/)
  assert.deepEqual(regressions[0], {
    file: 'check-docs-sync.mjs',
    detail: 'gate-list lockstep',
    minVersion: '0.6.0',
    from: '0.5.0',
    to: '0.7.0',
  })
})

test("0.5.0's DOCUMENTED HOLE is closed — move-one-and-add-one no longer lines up", () => {
  // The 0.5.0 suite pinned this as a known limit, with the instruction that a later release
  // adding per-site ids should DELETE that test — "which is the signal". This is the
  // replacement: the same fixture, the opposite expectation. Adding a sibling at the old
  // deadline cannot mask a move any more, because the sibling has its own name.
  const { problems } = deadlineRegressions({
    previous: [site('check-docs-sync.mjs', '0.3.0', '0.5.0', 'gate-list lockstep')],
    current: [
      site('check-docs-sync.mjs', '0.3.0', '0.6.0', 'gate-list lockstep'),
      site('check-docs-sync.mjs', '0.3.0', '0.5.0', 'a freshly invented sibling'),
    ],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /moved its deadline from 0\.5\.0 to 0\.6\.0/)

  // And the residual hole that replaces it, stated in the header rather than implied.
  const header = readFileSync(new URL('../../scripts/lib/ramp-sites.mjs', import.meta.url), 'utf8')
  assert.match(header, /Rewording the detail in the same commit that moves\n\/\/ the deadline/)
})

test('REWORDING the detail is the residual hole — pinned so it stays stated', () => {
  const { problems } = deadlineRegressions({
    previous: [site('check-wiring.mjs', '0.3.0', '0.5.0', 'the CODEOWNERS finding set')],
    current: [site('check-wiring.mjs', '0.3.0', '0.6.0', 'every CODEOWNERS finding')],
  })
  assert.deepEqual(problems, [], 'documented in scripts/lib/ramp-sites.mjs — not claimed shut')
})

// ── the detail string as an ID (0.6.0) ────────────────────────────────────────────────

test('checkDetailIds: the SHIPPED fleet has a parseable, unique detail at every site', () => {
  assert.deepEqual(checkDetailIds(shippedRampSites()), [])
})

test('CANARY — two sites in one file sharing a detail reds: the key stops being a key', () => {
  const problems = checkDetailIds([
    { file: 'check-x.mjs', line: 10, detail: "'the same words'" },
    { file: 'check-x.mjs', line: 40, detail: "'the same words'" },
    { file: 'check-y.mjs', line: 10, detail: "'the same words'" },
  ])
  assert.equal(problems.length, 1, 'same words in a DIFFERENT file is a different site')
  assert.match(problems[0], /check-x\.mjs:40 and check-x\.mjs:10 share the detail string/)
})

test('CANARY — a site with no readable detail reds rather than grouping under an empty key', () => {
  const problems = checkDetailIds([{ file: 'check-x.mjs', line: 10, detail: null }])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no readable third argument/)
})

test('the detail survives commas and parens inside the string — a split(",") would not', () => {
  // check-gate-integrity.mjs:152 is the real one: five commas and a paren pair inside a
  // single quoted literal. Splitting on every comma yields a fragment, and a fragment used
  // as an id changes whenever the prose around it does.
  const [only] = rampSitesFromSources([
    {
      file: 'check-x.mjs',
      src: "const GATE = 'x'\nif (rampNote(GATE, '0.3.0', 'configs (.mcp.json, lefthook.yml, renovate.json) and the rule', { until: '0.5.0' })) ok(GATE)\n",
    },
  ])
  assert.equal(only.detail, "'configs (.mcp.json, lefthook.yml, renovate.json) and the rule'")
  assert.equal(only.minVersion, '0.3.0')
})

test('a detail reflowed across lines is not a rename — whitespace is collapsed', () => {
  const one = rampSitesFromSources([
    { file: 'a.mjs', src: "if (rampNote(G, '0.3.0', 'a long finding name', { until: '0.5.0' })) x()\n" },
  ])
  const two = rampSitesFromSources([
    {
      file: 'a.mjs',
      src: "if (\n  rampNote(G, '0.3.0',\n    'a long finding name',\n    { until: '0.5.0' })\n) x()\n",
    },
  ])
  assert.equal(one[0].detail, two[0].detail)
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
  // IMPORTED, not retyped. This line was a second hand-written copy of VINTAGES through
  // 0.5.0, under a comment in check-ramp-ledger.mjs claiming "the test below pins" that the
  // list grows. It did not: two literals nobody compared, and a missing vintage would have
  // passed here and there. One definition now, and `checkVintages` is the growth control.
  const computed = VINTAGES.filter((v) => cmpDotted(v, '0.5.0') < 0).filter(
    (base) => classifyForInstall(base, '0.5.0', sites).expired.length > 0,
  )
  assert.deepEqual(record.affects, computed)

  // The other half of the claim: 0.4.0 is the ONE released vintage this release does not
  // red, which is why the upgrade lane keeps its default leg.
  assert.equal(classifyForInstall('0.4.0', '0.5.0', sites).expired.length, 0)
})

test('0.5.0 closed EIGHT escapes; seven still stand and the eighth is a recorded extension', () => {
  // THIS TEST CAUGHT THE 0.6.0 EXTENSION, and the arithmetic is the point rather than the
  // number. It asserted a flat 8 through 0.5.0. Re-opening check-docs-sync.mjs's gate-list
  // ramp at 0.6.0/0.7.0 took the live count to 7 — a released version's escape population
  // changing at HEAD, which is a thing that should never happen silently. It is derived
  // now: seven live, plus every rampExtensions entry moving a deadline OFF 0.5.0, is eight.
  const expiring = shippedRampSites().filter((s) => s.until === '0.5.0')
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const movedOff = Object.values(migrations)
    .flatMap((m) => m.rampExtensions ?? [])
    .filter((e) => e.from === '0.5.0')
  assert.equal(
    expiring.length + movedOff.length,
    8,
    `the 0.5.0 release note is derived from this set: ${JSON.stringify(expiring.map((s) => `${s.file}:${String(s.line)}`))} plus ${String(movedOff.length)} recorded extension(s)`,
  )
  assert.deepEqual(
    [...new Set(expiring.map((s) => s.gate))].sort(),
    ['diff-coverage', 'docs-sync', 'gate-integrity', 'wiring'],
    'the four gates 0.5.0 named — the extension moved one of docs-sync’s four, not the last',
  )
  // Kept, not deleted. Dropping the wrappers would take the fleet from 23 to 15 against
  // three separate anti-vacuity floors that hard-fail below 15.
  assert.ok(shippedRampSites().length >= 15, 'the fleet floor the ledger and both tests pin')
})

// ── the vintage closure (0.6.0) ───────────────────────────────────────────────────────
//
// The control 0.5.0's comment already claimed. `check-ramp-ledger.mjs` carried "The list
// must grow with every release, which is what the test below pins" over a literal VINTAGES
// array — while the test below it retyped the array by hand and compared the two copies to
// nothing. A release that forgot its predecessor would have been green in both places, and
// the ledger would have reported that whole population as unaffected without ever asking.

test('VINTAGES has exactly one definition, and the ledger and this suite share it', () => {
  // If this ever becomes possible to satisfy with a local literal again, the drift is back.
  assert.ok(Array.isArray(VINTAGES) && VINTAGES.length >= 5)
  assert.equal(VINTAGES[0], LINEAGE_FLOOR)
  // Sorted ascending and unique — the classify loop and every message read in this order.
  const sorted = [...VINTAGES].sort(cmpDotted)
  assert.deepEqual(VINTAGES, sorted, 'VINTAGES must be ascending')
  assert.equal(new Set(VINTAGES).size, VINTAGES.length, 'no duplicate vintage')
})

test('RED: a released vintage missing from VINTAGES is a hard finding, not a silent gap', () => {
  // The exact defect 0.6.0 would have shipped: v0.5.0 released, VINTAGES stopped at 0.4.0.
  const problems = checkVintages(
    ['v0.1.3', 'v0.2.0', 'v0.2.1', 'v0.3.0', 'v0.4.0', 'v0.5.0'],
    '0.6.0',
    ['0.1.3', '0.2.0', '0.2.1', '0.3.0', '0.4.0'],
  )
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /v0\.5\.0 is a released vintage below 0\.6\.0 and is absent from VINTAGES/)
})

test('RED: a VINTAGES entry this lineage never released is a stale entry', () => {
  const problems = checkVintages(['v0.1.3', 'v0.2.0'], '0.6.0', ['0.1.3', '0.2.0', '0.9.9'])
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /VINTAGES names '0\.9\.9', which is not a released tag/)
})

test('tags at or above the version being cut, and below the lineage floor, are not owed', () => {
  // v0.6.0 itself is not a population an upgrade TO 0.6.0 can affect; 0.1.2 belongs to the
  // ancestor (see the CHANGELOG lineage note) and no install of this harness ever carried it.
  assert.deepEqual(
    checkVintages(['v0.1.2', 'v0.1.3', 'v0.6.0'], '0.6.0', ['0.1.3']),
    [],
  )
})

test('the GROWN list (0.11.1): v0.11.0 released means VINTAGES carries it, judged as the bump will', () => {
  // The live-tag test below asks checkVintages about the CURRENT package version, and
  // checkVintages skips tags >= the version being cut — so at package 0.9.5 the entry
  // '0.9.5' is never demanded and its absence would stay green right up to the bump commit,
  // where the same test reds with no code having changed. This is that wire, pulled early
  // (0.8.0 pulled it for v0.7.0, 0.9.5 for v0.9.0, 0.9.9 for v0.9.5, 0.10.0 for v0.9.9,
  // 0.11.0 for v0.10.0, and 0.11.1 for v0.11.0): the real released-tag set, judged as the
  // 0.11.1 release will judge
  // it, against the
  // SHIPPED VINTAGES (the default argument — a local literal here would be the drift the
  // one-definition test above exists to prevent).
  //
  // 0.10.0 WAS THE HOP THIS TEST WARNED ABOUT from 0.9.5 onward — 0.9.9 -> 0.10.0 is the
  // first minor to cross a two-digit segment, where a string compare would order '0.10.0'
  // BELOW '0.9.9' and silently drop every vintage from the ledger at once. It crossed
  // cleanly, and the cmpDotted assertions below are kept rather than retired: the hazard is
  // permanent for every version above 0.9.x, so the case that names it stays.
  const tags = [
    'v0.1.3',
    'v0.2.0',
    'v0.2.1',
    'v0.3.0',
    'v0.4.0',
    'v0.5.0',
    'v0.6.0',
    'v0.7.0',
    'v0.8.0',
    'v0.9.0',
    'v0.9.5',
    'v0.9.9',
    'v0.10.0',
    'v0.11.0',
  ]
  assert.deepEqual(checkVintages(tags, '0.11.1'), [])

  // And the defect shape it guards: the list stopped at 0.9.0 — exactly the forgotten-entry
  // red the bump would otherwise be the first to surface. The comparison underneath is
  // cmpDotted, numeric per segment, which is what makes 0.9.5 a population BELOW 0.9.9 and
  // will make 0.9.9 a population below 0.10.0 — the hop where a segment-wise string compare
  // would silently drop every vintage from the ledger at once.
  const stopped = [
    '0.1.3',
    '0.2.0',
    '0.2.1',
    '0.3.0',
    '0.4.0',
    '0.5.0',
    '0.6.0',
    '0.7.0',
    '0.8.0',
    '0.9.0',
    '0.9.5',
    '0.9.9',
  ]
  const problems = checkVintages(tags, '0.11.0', stopped)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(
    problems[0],
    /v0\.10\.0 is a released vintage below 0\.11\.0 and is absent from VINTAGES/,
  )

  // The two-digit hop, asserted directly rather than left to the reader: a string compare
  // would place '0.10.0' below '0.9.9' and report every vintage as at-or-above the version
  // being cut, which checkVintages skips — turning the whole closure into a silent no-op in
  // exactly the release it matters most. Numeric per segment means v0.9.9 is BELOW 0.10.0.
  assert.equal(cmpDotted('0.9.9', '0.10.0'), -1)
  assert.ok('0.9.9' > '0.10.0', 'a string compare really does invert this — hence cmpDotted')
})

test('GREEN: the SHIPPED VINTAGES is closed against this repository real tags', () => {
  const tags = execFileSync('git', ['tag', '--list', 'v*.*.*'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  // AN INCOMPLETE TAG SET CANNOT CORROBORATE ANYTHING, and "none at all" is not the only way
  // to be incomplete. The old guard was `tags.length === 0`, which covers a template copy —
  // and misses the case that actually happened: on a TAG PUSH, `actions/checkout` at its
  // default depth fetches exactly the ref being built, so `git tag --list` returns
  // ["v0.6.0"] and nothing else. Every VINTAGES entry then looks like a release that never
  // happened, and this assertion reported all six as stale on the release build of the very
  // version it was tagging. The set that matters is the tags BELOW this version — the
  // populations an upgrade to it can affect — so skip when that set is empty rather than
  // assert against a truncated view of history. (Workflows that need the real answer supply
  // it: fetch-depth: 0.)
  const below = tags.filter((t) => cmpDotted(t.slice(1), pkg.version) < 0)
  if (below.length === 0) return
  assert.deepEqual(checkVintages(tags, pkg.version), [])
})

test('the SHIPPED 0.6.0 rampExpiry record equals what the shipped call sites compute', () => {
  // Same reasoning as the 0.5.0 test above: check-ramp-ledger.mjs asserts this only at the
  // CURRENT package version, so a record written for a future release is unread until the
  // bump. Proving it here means it is proven the moment it is written.
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const record = migrations['0.6.0']?.rampExpiry
  assert.ok(record, 'a release that reds an existing install must say which installs')

  const sites = shippedRampSites()
  const computed = VINTAGES.filter((v) => cmpDotted(v, '0.6.0') < 0).filter(
    (base) => classifyForInstall(base, '0.6.0', sites).expired.length > 0,
  )
  assert.deepEqual(record.affects, computed)

  // THE CLAIM THAT MAKES THIS RECORD DIFFERENT from 0.4.0's and 0.5.0's, and the one worth
  // pinning: nothing newly EXPIRES here. The release opens three ramps, all at 0.7.0, so
  // the population above is carried forward rather than declared. If a later edit adds a
  // site with `until: '0.6.0'`, the record's prose becomes false and this fails — the signal.
  assert.deepEqual(
    sites.filter((s) => s.until === '0.6.0').map((s) => `${s.file}:${String(s.line)}`),
    [],
    'the 0.6.0 record states that nothing newly expires here; a site dated 0.6.0 contradicts it',
  )

  // The one deadline this release moves, recorded rather than quiet. Its `detail` must be
  // BYTE-EQUAL to a shipped call site's — an extension naming words no site says is a
  // permission slip for a move nobody can find, and deadlineRegressions' stale-entry check
  // only catches it while the previous tag is readable (it skips outside CI on a shallow
  // clone). This closes it against the tree itself.
  const [ext, ...rest] = migrations['0.6.0'].rampExtensions
  assert.equal(rest.length, 0, 'one extension in this release, and it is the docs-sync re-open')
  assert.deepEqual(
    { file: ext.file, from: ext.from, to: ext.to },
    { file: 'check-docs-sync.mjs', from: '0.5.0', to: '0.7.0' },
  )
  assert.ok(
    sites.some((s) => s.file === ext.file && s.detail === ext.detail),
    `no shipped site in ${ext.file} carries the detail ${ext.detail} — the extension names an escape that is not there`,
  )

  // 0.4.0 AND 0.5.0 are both untouched — the property leg A of the upgrade lane rests on.
  // (AT 0.6.0. The two lines below are pinned to a HISTORICAL harness version and stay true
  // forever; the 0.7.0 test that follows is where the same populations flip, deliberately.)
  assert.equal(classifyForInstall('0.4.0', '0.6.0', sites).expired.length, 0)
  assert.equal(classifyForInstall('0.5.0', '0.6.0', sites).expired.length, 0)
})

test('the SHIPPED 0.7.0 rampExpiry record equals what the shipped call sites compute', () => {
  // Same reasoning as the 0.5.0 and 0.6.0 tests above: check-ramp-ledger.mjs reads only the
  // CURRENT package version's record, so this record is latent until the bump commit.
  // Proving it here means the bump is a pure lockstep edit whose expiry accounting was
  // already established at 0.6.0 — the moment the record was written, not the moment it ships.
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const record = migrations['0.7.0']?.rampExpiry
  assert.ok(record, 'the release that reds six vintages at once must say which, in data')

  const sites = shippedRampSites()
  const computed = VINTAGES.filter((v) => cmpDotted(v, '0.7.0') < 0).filter(
    (base) => classifyForInstall(base, '0.7.0', sites).expired.length > 0,
  )
  assert.deepEqual(record.affects, computed)

  // The population's mechanism, not just its members. At 0.7.0's own release these were the
  // SEVEN sites of the whole 0.6.0 fleet; the 0.8.0 re-open then moved the docs-sync
  // gate-list site to (0.8.0 → 0.9.0) — recorded as 0.8.0's rampExtensions entry — so the
  // CURRENT fleet carries SIX sites dated 0.7.0. These pins read the current fleet at a
  // historical version, and they moved with the reviewed move, in the same diff (the same
  // discipline as the gate-list ramp's own tests in check-docs-sync.test.mjs).
  const expiring = sites.filter((s) => s.until === '0.7.0')
  assert.equal(
    expiring.length,
    6,
    `the six 0.6.0-era sites still dated 0.7.0: ${JSON.stringify(expiring.map((s) => `${s.file}:${String(s.line)}`))}`,
  )
  assert.deepEqual(
    [...new Set(expiring.map((s) => s.gate))].sort(),
    [
      'auth-posture',
      'data-flow',
      'reviewer-verdicts',
      'route-manifest',
      'schema-rls',
      'web-e2e',
    ],
    'the 0.6.0 fleet minus the re-opened gate-list site — its move is 0.8.0\'s rampExtensions record',
  )

  // THE DELIBERATE INVERSION. Every release through 0.6.0 pinned `expired.length === 0` for
  // its recent predecessors. 0.7.0 was the FIRST release that redded them — seven sites at
  // its own release; six under the current fleet, the re-opened gate-list site having moved
  // out of this dated set (see above).
  assert.equal(classifyForInstall('0.4.0', '0.7.0', sites).expired.length, 6)
  assert.equal(classifyForInstall('0.5.0', '0.7.0', sites).expired.length, 6)

  // The previous release's vintage meets nothing — leg A of the 0.7.0 lane upgraded a
  // v0.6.0 scaffold and reached graduate's SUCCESS branch on the strength of this line. Its
  // NOTING was four at 0.7.0's release; under the current fleet it is ELEVEN — the four
  // ramps 0.7.0 opened, the two 0.8.0 opens (observability, and the re-opened gate-list
  // site), the two 0.9.0 opens (the version-sync lockfile floor and the wiring lefthook
  // floor), and the three 0.9.5 opens (boundaries' vertical-anatomy laws and docs-sync's
  // agent-surface and ADR-shape checks), all advisory for a 0.6.0-vintage install running
  // harness 0.7.0.
  // These pins read the CURRENT fleet at a historical version and move with each reviewed
  // ramp addition, in the same diff — the discipline the header states. THIRTEEN since 0.9.9
  // added TWO ramps: auth-posture's [auth.mfa] posture and version-sync's absent
  // end-of-life register, both due 0.10.0. SEVENTEEN since 0.10.0 added FOUR, all due
  // 0.11.0: docs-sync's AGENTS.md Stop-chain list lockstep (leg B), web-e2e's axe tag
  // ladder and rate-limits' outage-rung fallback declaration (leg F), and version-sync's
  // ARRIVAL of a harness-authored eol.json removalTarget — the fourth added after
  // upgrade-lane leg A red on it. Only the axe and fallback ramps widen the gate set
  // below: docs-sync and version-sync were both already carrying ramps at this vintage,
  // those two gates were not. EIGHTEEN since 0.11.0 added ONE — data-flow's erase.surface
  // record and its two-surface clients closure, due 0.12.0 — and it does NOT widen the gate
  // set, because data-flow already carried its 0.6.0 closure ramp at this vintage.
  // TWENTY-THREE since 1.0.0 added FIVE, all at minVersion 1.0.0 due 1.1.0 — the injected
  // suppressions census and the resilience register closure (both WIDEN the gate set
  // below, because neither gate existed before the 1.0.0 injections), boundaries'
  // behavior-keyed widening of the vertical-anatomy DAL laws, the census module-name
  // closure over the shipped tools/modules.json, and auth-posture's [auth.hook] trail
  // posture (the last three do NOT widen the set — boundaries and auth-posture already
  // carry ramps at this vintage).
  const fresh = classifyForInstall('0.6.0', '0.7.0', sites)
  assert.equal(fresh.expired.length, 0)
  assert.equal(fresh.noting.length, 23)
  assert.deepEqual(
    [...new Set(fresh.noting.map((s) => s.gate))].sort(),
    [
      'auth-posture',
      'boundaries',
      'data-flow',
      'docs-sync',
      'observability',
      'rate-limits',
      'resilience',
      'reviewer-verdicts',
      'suppressions',
      'version-sync',
      'web-e2e',
      'wiring',
    ],
    'what 0.7.0 opened plus what 0.8.0, 0.9.0, 0.9.5, 0.9.9, 0.10.0, 0.11.0 and 1.0.0 open, all advisory for this vintage at harness 0.7.0',
  )

  // The why is a pointer a consumer follows, so its three load-bearing references are pinned
  // as substrings: the runbook section that is the sweep, the parked channel `update` writes,
  // and the honest-count rule (the number is computed on THEIR install, not quoted from here).
  assert.match(record.why, /## 0\.7\.0/)
  assert.match(record.why, /\.harness\/pending\/source-fixes\.json/)
  assert.match(record.why, /RAMP EXPIRED/)
})

test('the SHIPPED 0.8.0 rampExpiry record equals what the shipped call sites compute', () => {
  // Same reasoning as every predecessor above: check-ramp-ledger.mjs reads only the CURRENT
  // package version's record, so this record is latent until the bump commit. Proving it
  // here means the bump is a pure lockstep edit whose expiry accounting was already
  // established the moment the record was written.
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const record = migrations['0.8.0']?.rampExpiry
  assert.ok(record, 'the release that reds seven vintages at once must say which, in data')

  const sites = shippedRampSites()
  const computed = VINTAGES.filter((v) => cmpDotted(v, '0.8.0') < 0).filter(
    (base) => classifyForInstall(base, '0.8.0', sites).expired.length > 0,
  )
  assert.deepEqual(record.affects, computed)

  // The population's mechanism: the four sites dated 0.8.0 are everything 0.7.0 opened —
  // each at minVersion 0.7.0 — so the affected set is every released vintage below 0.7.0,
  // and the sweep rows were already written in the 0.7.0 runbook section.
  const expiring = sites.filter((s) => s.until === '0.8.0')
  assert.equal(
    expiring.length,
    4,
    `the four 0.7.0-opened sites: ${JSON.stringify(expiring.map((s) => `${s.file}:${String(s.line)}`))}`,
  )
  assert.deepEqual(
    [...new Set(expiring.map((s) => s.gate))].sort(),
    ['data-flow', 'docs-sync', 'reviewer-verdicts', 'version-sync'],
    'the four gates the record names — exactly what the 0.7.0 record promised would fall due',
  )

  // A 0.6.0-vintage install meets exactly the four, with no older debt — 0.8.0's echo of
  // the claim 0.7.0 made about 0.5.0, and the property the new leg G isolates.
  assert.equal(classifyForInstall('0.6.0', '0.8.0', sites).expired.length, 4)

  // The previous release's vintage meets nothing — leg A upgrades a v0.7.0 scaffold and
  // reaches graduate's refusal branch on NOTEs alone. Its NOTING at 0.8.0's release was the
  // two ramps that release opened (observability, and the re-opened docs-sync gate-list
  // escape); under the current fleet the two 0.9.0 opens (version-sync lockfile, wiring
  // lefthook) and the three 0.9.5 opens (boundaries' anatomy laws, docs-sync's
  // agent-surface and ADR-shape checks) are already advisory for this vintage too — moved
  // in the same diff that opened them, per the header's discipline.
  const fresh = classifyForInstall('0.7.0', '0.8.0', sites)
  assert.equal(fresh.expired.length, 0)
  assert.deepEqual(
    [...new Set(fresh.noting.map((s) => s.gate))].sort(),
    ['auth-posture', 'boundaries', 'data-flow', 'docs-sync', 'observability', 'rate-limits', 'resilience', 'suppressions', 'version-sync', 'web-e2e', 'wiring'],
    'what 0.8.0 opened (the 0.9.0 record owes those two) plus what 0.9.0, 0.9.5, 0.9.9, 0.10.0, 0.11.0 and 1.0.0 open (the later records owe these)',
  )

  // The one deadline this release moves, recorded rather than quiet — the second entry of
  // its kind in the lineage, same site as the first. Its `detail` must be byte-equal to a
  // shipped call site's (the 0.6.0 test's closure, re-applied).
  const [ext, ...rest] = migrations['0.8.0'].rampExtensions
  assert.equal(rest.length, 0, 'one extension in this release, and it is the gate-list re-open')
  assert.deepEqual(
    { file: ext.file, from: ext.from, to: ext.to },
    { file: 'check-docs-sync.mjs', from: '0.7.0', to: '0.9.0' },
  )
  assert.ok(
    sites.some((s) => s.file === ext.file && s.detail === ext.detail),
    `no shipped site in ${ext.file} carries the detail ${ext.detail} — the extension names an escape that is not there`,
  )

  // The why is a pointer a consumer follows: the runbook section that is the sweep, and the
  // honest-count rule.
  assert.match(record.why, /0\.8\.0 — the fourth alarm/)
  assert.match(record.why, /RAMP EXPIRED/)
})

test('the SHIPPED 0.9.0 rampExpiry record equals what the shipped call sites compute', () => {
  // Same reasoning as every predecessor above: check-ramp-ledger.mjs reads only the CURRENT
  // package version's record, so this record is latent until the bump commit. Proving it
  // here means the bump is a pure lockstep edit whose expiry accounting was already
  // established the moment the record was written.
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const record = migrations['0.9.0']?.rampExpiry
  assert.ok(record, 'the release that reds eight vintages at once must say which, in data')

  const sites = shippedRampSites()
  const computed = VINTAGES.filter((v) => cmpDotted(v, '0.9.0') < 0).filter(
    (base) => classifyForInstall(base, '0.9.0', sites).expired.length > 0,
  )
  assert.deepEqual(record.affects, computed)

  // The population's mechanism: the two sites dated 0.9.0 are everything 0.8.0 opened —
  // each at minVersion 0.8.0 — so the affected set is every released vintage below 0.8.0,
  // exactly what the 0.8.0 record promised would fall due ('the 0.9.0 record will owe
  // their expiry').
  const expiring = sites.filter((s) => s.until === '0.9.0')
  assert.equal(
    expiring.length,
    2,
    `the two 0.8.0-opened sites: ${JSON.stringify(expiring.map((s) => `${s.file}:${String(s.line)}`))}`,
  )
  assert.deepEqual(
    [...new Set(expiring.map((s) => s.gate))].sort(),
    ['docs-sync', 'observability'],
    'the two gates the record names — the containment closure and the re-opened gate-list escape',
  )

  // A 0.7.0-vintage install meets exactly the two, with no older debt — the property the
  // new leg H isolates (base v0.7.0: EXPIRED docs-sync + observability, both in-chain).
  assert.equal(classifyForInstall('0.7.0', '0.9.0', sites).expired.length, 2)

  // The previous release's vintage meets NOTHING expired — the first release in the
  // lineage whose leg A can reach graduate's SUCCESS branch un-swept. Its NOTING at
  // 0.9.0's release was the two ramps that release opened (the version-sync lockfile
  // floor and the wiring lefthook floor) — both QUIET on a lane scaffold (the lane
  // installs, so the lockfile exists and lefthook is installed), which is why the
  // un-swept graduate still succeeds: a quiet ramp is the honest answer, per the lane's
  // §7b doctrine. Under the current fleet the three 0.9.5 opens join them, advisory for
  // this vintage too — moved in the same diff that opened them.
  const fresh = classifyForInstall('0.8.0', '0.9.0', sites)
  assert.equal(fresh.expired.length, 0)
  assert.deepEqual(
    [...new Set(fresh.noting.map((s) => s.gate))].sort(),
    ['auth-posture', 'boundaries', 'data-flow', 'docs-sync', 'rate-limits', 'resilience', 'suppressions', 'version-sync', 'web-e2e', 'wiring'],
    'what 0.9.0 OPENS (the 0.10.0 record owes those two) plus what 0.9.5, 0.9.9, 0.10.0, 0.11.0 and 1.0.0 open',
  )
  // …and the 0.9.0-opened pair in isolation, which is the assertion that does NOT drift
  // as later releases open their own ramps: filter by the minVersion that names them.
  assert.deepEqual(
    [...new Set(fresh.noting.filter((s) => s.minVersion === '0.9.0').map((s) => s.gate))].sort(),
    ['version-sync', 'wiring'],
    'exactly what 0.9.0 itself opened — the 0.10.0 record owes these two',
  )

  // ZERO INJECTION, as data: no configSteps and no rampExtensions under "0.9.0" — the
  // chain is byte-identical for every install, the gate-list escape expires rather than
  // re-opens, and the deadline ratchet needs no excuse list (the 0.7.0 record set the
  // absent-not-empty precedent this record follows).
  assert.ok(!('configSteps' in migrations['0.9.0']), '0.9.0 injects no chain step')
  assert.ok(!('rampExtensions' in migrations['0.9.0']), '0.9.0 moves no deadline')

  // The why is a pointer a consumer follows: the runbook section that is the sweep — which
  // this release extends with the RECOVERY section, because the expiry is what forces every
  // older install through `update` — and the honest-count rule.
  assert.match(record.why, /0\.9\.0 — the fifth alarm/)
  assert.match(record.why, /RAMP EXPIRED/)
  assert.match(record.why, /update --rollback/)
})

// ── highestReleaseBelow (0.6.1) ──────────────────────────────────────────────────
//
// The release-history question every "compare against the previous release" check asks, with
// one home. The bug it exists to prevent shipped in 0.6.0 and fired the moment that release
// was tagged: the caller took the HIGHEST tag, which IS this version's tag once the release
// is cut, so the deadline ratchet compared HEAD against its own tree and reported the
// release's own reviewed rampExtensions record as a stale permission slip. Green through
// development, red on `main` from the tag onward.
test('highestReleaseBelow: the release being cut is NOT its own predecessor', () => {
  const tags = ['v0.1.3', 'v0.2.0', 'v0.5.0', 'v0.6.0']
  assert.equal(highestReleaseBelow(tags, '0.6.0'), 'v0.5.0')
  // The pre-tag state and the post-tag state must give the SAME answer — that is the whole
  // property. Before the tag exists the list simply lacks v0.6.0.
  assert.equal(highestReleaseBelow(['v0.1.3', 'v0.2.0', 'v0.5.0'], '0.6.0'), 'v0.5.0')
})

test('highestReleaseBelow: a tag set with nothing below the version answers null, never a guess', () => {
  // The tag-push checkout: `actions/checkout` at its default depth fetches exactly the ref
  // being built, so this is the real shape, not a hypothetical.
  assert.equal(highestReleaseBelow(['v0.6.0'], '0.6.0'), null)
  assert.equal(highestReleaseBelow([], '0.6.0'), null)
  // A FUTURE tag never counts either — a release cannot be compared against its successor.
  assert.equal(highestReleaseBelow(['v0.7.0', 'v1.0.0'], '0.6.0'), null)
})

test('highestReleaseBelow: ordering is numeric and non-release refs are ignored', () => {
  // 0.10.0 > 0.9.0 lexically fails; this is the ordering bug that hides for nine releases.
  assert.equal(highestReleaseBelow(['v0.9.0', 'v0.10.0'], '0.11.0'), 'v0.10.0')
  assert.equal(highestReleaseBelow(['v0.5.0', 'v0.6.0-rc.1', 'nightly', ''], '0.6.0'), 'v0.5.0')
  // Prefix is preserved as given, because callers hand the result to `git`.
  assert.equal(highestReleaseBelow(['0.5.0', '0.4.0'], '0.6.0'), '0.5.0')
})

// ── 0.11.1: the escape that was live for exactly the population it could not help ─────
// The v0.11.0 tag's upgrade lane leg A went red on this and nothing before it could have.
// rampNote is INERT when baseVersion >= minVersion, so an arrival escape opened at
// minVersion 0.10.0 never covered a 0.10.0-vintage install — and that install is the only
// one whose SEEDED tools/eol.json carries a removalTarget the harness itself wrote as
// "0.11.0". The date arrived hard, on a file `update` may never rewrite, with no deadline of
// theirs met. This is the regression proof: it fails against minVersion 0.10.0.
const ARRIVAL = "the arrival of tools/eol.json's removalTarget dates"

test('0.11.1 — the eol ARRIVAL escape reaches the 0.10.0 vintage it used to exclude', () => {
  const sites = shippedRampSites()
  const arrival = sites.filter((s) => s.detail?.includes(ARRIVAL))
  assert.equal(arrival.length, 1, `expected exactly one arrival site, got ${arrival.length}`)

  // At baseVersion 0.10.0 on this harness the site must be ADVISORY. Under the old
  // (minVersion 0.10.0) shape it classified as INERT — which is the hard red leg A met.
  const at010 = classifyForInstall('0.10.0', '0.11.1', arrival)
  assert.equal(at010.noting.length, 1, 'the 0.10.0 vintage is not covered by the arrival ramp')
  assert.equal(at010.inert.length, 0)
  assert.equal(at010.expired.length, 0)

  // A FRESH install of this harness is judged immediately — the escape is for installs
  // seeded before the demand, never for trees that ship with the re-dated register.
  assert.equal(classifyForInstall('0.11.1', '0.11.1', arrival).inert.length, 1)

  // And it is still an escape with an expiry, not an open-ended one.
  assert.equal(arrival[0].until, '0.12.0')
})

test('0.11.1 — the extension is RECORDED, and matches the site byte-for-byte', () => {
  const migrations = JSON.parse(
    readFileSync(new URL('../../template/migrations.json', import.meta.url), 'utf8'),
  )
  const exts = migrations['0.11.1'].rampExtensions
  assert.equal(exts.length, 1, 'one move, one record')
  const [ext] = exts
  assert.equal(ext.from, '0.11.0')
  assert.equal(ext.to, '0.12.0')
  assert.equal(ext.file, 'check-version-sync.mjs')
  // The ratchet keys on `detail` byte-for-byte — a paraphrase here would leave the real
  // move unexcused (and red) while this record pre-authorised a move that does not exist.
  assert.ok(ext.detail.includes(ARRIVAL), `detail does not name the site: ${ext.detail}`)
  // The `why` is the only thing a consumer reads to learn why a deadline they were told was
  // fixed has moved; deadlineRegressions reds below 40 chars, and a real one is far longer.
  assert.ok(ext.why.length > 200, `thin why (${String(ext.why.length)} chars)`)
})
