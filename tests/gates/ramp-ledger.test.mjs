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
  // Kept, not deleted. Dropping the wrappers would take the fleet from 20 to 12 against
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

test('GREEN: the SHIPPED VINTAGES is closed against this repository real tags', () => {
  const tags = execFileSync('git', ['tag', '--list', 'v*.*.*'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length === 0) return // a template copy has no tags; the ledger fails closed in CI
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
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
  assert.equal(classifyForInstall('0.4.0', '0.6.0', sites).expired.length, 0)
  assert.equal(classifyForInstall('0.5.0', '0.6.0', sites).expired.length, 0)
})
