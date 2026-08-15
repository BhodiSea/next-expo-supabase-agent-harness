// The obligations register (0.9.0) must be TRUE about the release's debts and must be
// able to RED. The release's obligations lived in three unjoined sources — the ramp fleet
// (template/migrations.json + the rampNote call sites), tools/deferrals.json, and prose —
// and gates-catalog.md's own docs-sync section recorded the factory-side gap in writing:
// "a factory-side dated sentence needs a factory-side reader". scripts/obligations.json is
// that reader's subject, and these are its death-tests.
//
// The kind discriminator is the whole design: `release` rows are judged CLOCKLESSLY
// against package.json (check-ramp-ledger.mjs's version authority) so they ride the
// per-PR machinery block; `calendar` rows are judged ONLY under an explicit --clockful
// flag wired into the SCHEDULED hygiene lane (a verdict that changes with the date must
// never red someone's PR — the corpus-fidelity split, applied to time); `condition` rows
// never red on time at all — shape + evidence is their whole bar, and discharging one is
// deleting it in a reviewed diff.
//
// scripts/check-obligations.mjs takes no positional overrides — every input path is
// import.meta.url-relative — so the red cases run byte-identical COPIES of the script and
// its pure lib inside a fixture tree that mirrors the repo layout, exactly like
// tests/gates/check-claims.test.mjs. The live repo is pinned green as-is (clockless only:
// a --clockful spawn against the LIVE register would make this suite red on the calendar,
// which is precisely the property the flag exists to keep out of the per-PR path).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  censusProblems,
  rampObligationProblems,
  rowShapeProblems,
  timeProblems,
} from '../../scripts/lib/obligations.mjs'
import { cmpDotted, shippedRampSites } from '../../scripts/lib/ramp-sites.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/check-obligations.mjs')
const SCRIPT_BYTES = readFileSync(SCRIPT, 'utf8')
const LIB_BYTES = readFileSync(join(ROOT, 'scripts/lib/obligations.mjs'), 'utf8')
const RAMP_LIB_BYTES = readFileSync(join(ROOT, 'scripts/lib/ramp-sites.mjs'), 'utf8')

const GOOD_REASON =
  'a reason long enough to clear the forty-character floor, stating the debt honestly'

// One consumed rampNote call site with a FUTURE deadline — the shape the union check
// derives obligations from. `const ramped =` consumes the result, so the site is a real
// escape rather than the decoration check-ramp-ledger reds on.
const WIDGET_GATE = [
  "const GATE = 'widget'",
  '// a fixture gate carrying one future-until ramp',
  "const ramped = rampNote(GATE, '0.9.0', 'the widget adoption escape', { until: '0.10.0' })",
  'if (ramped) process.exit(0)',
  '',
].join('\n')

/** The smallest register that is CLEAN at version 0.9.0 against the fixture tree. */
const baseRegister = () => ({
  comment: 'fixture register',
  obligations: [
    {
      id: 'widget-census',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
      evidence: 'https://example.com/upstream/1',
    },
    {
      id: 'widget-ramp-expiry',
      kind: 'release',
      target: '0.10.0',
      // The 0.11.0 keying: a ramp row is matched to its ramp by this ANCHOR — the file the
      // ramp lives in plus a `mustContain` that appears in the ramp's own detail — never by
      // the gate name appearing somewhere in the row id. Before that change this row needed
      // no sites at all, which is precisely why two ramps of one gate were indistinguishable.
      sites: [{ file: 'template/base/tools/check-widget.mjs', mustContain: 'the widget adoption escape' }],
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
    },
    {
      id: 'future-regime',
      kind: 'calendar',
      target: '2999-01-01',
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
    },
  ],
})

/**
 * Mirror the repo layout the script's import.meta.url-relative reads expect, then run the
 * copied script from inside it.
 * @param {{
 *   register?: unknown, registerText?: string, version?: string, clockful?: boolean,
 *   deferrals?: unknown, tools?: Record<string, string>, files?: Record<string, string>,
 * }} parts
 */
function runFixture({
  register = baseRegister(),
  registerText,
  version = '0.9.0',
  clockful = false,
  deferrals = {
    deferrals: [
      {
        id: 'widget-census',
        file: 'tools/widget.json',
        target: '0.10.0',
        reason: GOOD_REASON,
        reviewedOn: '2026-08-10',
      },
    ],
  },
  tools = { 'check-widget.mjs': WIDGET_GATE },
  files = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-obligations-'))
  const contents = {
    'scripts/check-obligations.mjs': SCRIPT_BYTES,
    'scripts/lib/obligations.mjs': LIB_BYTES,
    'scripts/lib/ramp-sites.mjs': RAMP_LIB_BYTES,
    'scripts/obligations.json': registerText ?? JSON.stringify(register, null, 2),
    'package.json': JSON.stringify({ version }),
    'template/migrations.json': JSON.stringify({ '0.9.0': {} }),
    'template/base/tools/deferrals.json': JSON.stringify(deferrals),
    ...files,
  }
  for (const [name, src] of Object.entries(tools)) {
    contents[`template/base/tools/${name}`] = src
  }
  for (const [rel, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const r = spawnSync(
    'node',
    [join(dir, 'scripts/check-obligations.mjs'), ...(clockful ? ['--clockful'] : [])],
    { encoding: 'utf8' },
  )
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** A register whose obligations array had one row replaced/added. */
function withRow(row) {
  const reg = baseRegister()
  reg.obligations.push(row)
  return reg
}

test('GREEN: the seeded register passes the clockless gate on the live repo (no overrides)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 0, out)
  assert.match(out, /OBLIGATIONS: CLEAN/)
  // The clockful half must be declared deferred, never silently skipped.
  assert.match(out, /calendar .*clockful/i)
})

test('GREEN: the seeded register holds at the version being cut — release rows, census and ramp union all close (pure)', () => {
  // BOTH VERSIONS ARE DERIVED, and 0.10.0 is why. This test hardcoded '0.9.0' for the
  // version AND for the ramp union's `base`, and the second one broke the moment the 0.10.0
  // migrations record landed: `base` is the NEWEST of package.json and the highest
  // migrations key (check-obligations.mjs), so writing that record moved base to 0.10.0 and
  // correctly retired the six `until: '0.10.0'` rows — while this test, still pretending
  // base was 0.9.0, reported all six as missing debt. A pinned number here does not test
  // the register against the tree; it tests it against a release that has already shipped.
  const register = JSON.parse(readFileSync(join(ROOT, 'scripts/obligations.json'), 'utf8'))
  const rows = register.obligations
  const kinds = { release: 0, calendar: 0, condition: 0 }
  for (const row of rows) kinds[row.kind] += 1
  assert.ok(kinds.release > 0 && kinds.calendar > 0 && kinds.condition > 0, JSON.stringify(kinds))
  assert.deepEqual(rowShapeProblems(rows), [])

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  // The release being cut: no release row may have ARRIVED at it. This is the assertion the
  // bump commit has to satisfy, and deriving the version is what makes it survive the bump
  // rather than having to be edited by the same diff it is supposed to police.
  assert.deepEqual(timeProblems(rows, { version, clockful: false }), [])

  const deferrals = JSON.parse(
    readFileSync(join(ROOT, 'template/base/tools/deferrals.json'), 'utf8'),
  )
  assert.deepEqual(
    censusProblems(
      rows,
      deferrals.deferrals.map((d) => d.id),
    ),
    [],
  )

  const migrations = JSON.parse(readFileSync(join(ROOT, 'template/migrations.json'), 'utf8'))
  const base = Object.keys(migrations)
    .filter((k) => /^\d+\.\d+\.\d+$/.test(k))
    .reduce((hi, k) => (cmpDotted(k, hi) > 0 ? k : hi), version)
  assert.deepEqual(rampObligationProblems(rows, shippedRampSites(), base), [])
})

test('GREEN: a clean fixture register is CLEAN, and says what it counted', () => {
  const r = runFixture({})
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /OBLIGATIONS: CLEAN \(1 release \/ 1 calendar \/ 1 condition row/)
})

test('RED (shape): a reason below the 40-char floor fails closed, naming the row', () => {
  const r = runFixture({
    register: withRow({
      id: 'thin-reason',
      kind: 'condition',
      target: null,
      reason: 'too short',
      reviewedOn: '2026-08-10',
      evidence: 'https://example.com/x',
    }),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'thin-reason'.*reason.*40/s)
})

test('RED (shape): an unknown kind fails closed — a row the reader cannot classify is a red, not a skip', () => {
  const r = runFixture({
    register: withRow({
      id: 'mystery',
      kind: 'someday',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
    }),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'mystery'.*kind/s)
})

test('RED (shape): a condition row carrying a target fails — a dated condition is a calendar row hiding', () => {
  const r = runFixture({
    register: withRow({
      id: 'dated-condition',
      kind: 'condition',
      target: '0.11.0',
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
      evidence: 'https://example.com/x',
    }),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'dated-condition'.*target must be null/s)
})

test('RED (shape): a condition row with NO evidence fails — a condition nobody can check is a wish', () => {
  const r = runFixture({
    register: withRow({
      id: 'unevidence',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
    }),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'unevidence'.*evidence/s)
})

test('RED (shape): a release row whose target is not x.y.z, and a calendar row whose target is not a date', () => {
  const r = runFixture({
    register: {
      comment: 'fixture',
      obligations: [
        ...baseRegister().obligations,
        {
          id: 'bad-release',
          kind: 'release',
          target: '2026-08-31',
          reason: GOOD_REASON,
          reviewedOn: '2026-08-10',
        },
        {
          id: 'bad-calendar',
          kind: 'calendar',
          target: '0.10.0',
          reason: GOOD_REASON,
          reviewedOn: '2026-08-10',
        },
      ],
    },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'bad-release'.*x\.y\.z/s)
  assert.match(r.out, /'bad-calendar'.*YYYY-MM-DD/s)
})

test('RED (shape): duplicate ids fail — two rows under one name is how a discharge deletes the wrong one', () => {
  const r = runFixture({ register: withRow(baseRegister().obligations[0]) })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /duplicate id 'widget-census'/)
})

test('RED (shape): an unparseable register fails CLOSED rather than un-dating every obligation', () => {
  const r = runFixture({ registerText: '{ not json' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not valid JSON/)
})

test('RED (shape): a register with no obligations array fails closed', () => {
  const r = runFixture({ registerText: JSON.stringify({ comment: 'nothing here' }) })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no `obligations` array/)
})

test('RED (arrival): a release row reds CLOCKLESSLY the moment package.json reaches its target', () => {
  const r = runFixture({ version: '0.10.0' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'widget-ramp-expiry'.*0\.10\.0.*package\.json is 0\.10\.0/s)
  assert.match(r.out, /ARRIVED/)
})

test('GREEN/RED (calendar): a past-dated calendar row is judged ONLY under --clockful', () => {
  const register = withRow({
    id: 'past-regime',
    kind: 'calendar',
    target: '2020-01-01',
    reason: GOOD_REASON,
    reviewedOn: '2026-08-10',
  })
  const clockless = runFixture({ register })
  assert.equal(clockless.code, 0, `clockless must NOT judge the calendar:\n${clockless.out}`)
  const clockful = runFixture({ register, clockful: true })
  assert.equal(clockful.code, 1, clockful.out)
  assert.match(clockful.out, /'past-regime'.*2020-01-01/s)
})

test('GREEN (calendar): a future calendar row is green even under --clockful', () => {
  const r = runFixture({ clockful: true })
  assert.equal(r.code, 0, r.out)
})

test('GREEN (condition): a condition row never reds on time, however old its review', () => {
  const r = runFixture({
    register: withRow({
      id: 'old-condition',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2020-01-01',
      evidence: 'https://example.com/still-open',
    }),
    clockful: true,
  })
  assert.equal(r.code, 0, r.out)
})

test('RED (census): a deferrals.json entry with no register row naming its id reds', () => {
  const reg = baseRegister()
  reg.obligations = reg.obligations.filter((row) => row.id !== 'widget-census')
  const r = runFixture({ register: reg })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /deferrals\.json entry 'widget-census' has no register row/)
})

test('RED (ramp union): a future-until ramp with no release row at its expiry version reds, naming the gate', () => {
  const reg = baseRegister()
  reg.obligations = reg.obligations.filter((row) => row.id !== 'widget-ramp-expiry')
  const r = runFixture({ register: reg })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /gate 'widget'.*until: '0\.10\.0'/s)
})

test("RED (ramp union): a release row at the WRONG target does not satisfy the ramp's expiry version", () => {
  const reg = baseRegister()
  const row = reg.obligations.find((x) => x.id === 'widget-ramp-expiry')
  row.target = '0.11.0'
  const r = runFixture({ register: reg })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /gate 'widget'/)
})

// ── THE 0.11.0 PER-SITE KEYING (ramp-union-per-site-keying) ─────────────────────────────
// Two ramps in ONE gate, both dated the same version. Through 0.10.0 the union matched a
// ramp to a row with `row.id.includes(site.gate)`, so the two were indistinguishable and
// deleting EITHER row left the survivor covering both — reproduced against the real register
// at 0.10.0, where dropping either docs-sync row yielded zero problems. These are FIXTURE
// tests on purpose: after this release's bump no shipped ramp has an `until` above the
// current version, so a live-register assertion would go vacuous and prove nothing.
const TWO_RAMP_GATE = [
  "const GATE = 'widget'",
  '// a fixture gate carrying TWO future-until ramps at the same expiry',
  "const a = rampNote(GATE, '0.9.0', 'the widget adoption escape', { until: '0.10.0' })",
  "const b = rampNote(GATE, '0.9.0', 'the widget rollout escape', { until: '0.10.0' })",
  'if (a || b) process.exit(0)',
  '',
].join('\n')

/** The base register plus a SECOND, correctly anchored row for the second widget ramp. */
const twoRampRegister = () => {
  const reg = baseRegister()
  reg.obligations.push({
    id: 'widget-rollout-ramp-expiry',
    kind: 'release',
    target: '0.10.0',
    sites: [{ file: 'template/base/tools/check-widget.mjs', mustContain: 'the widget rollout escape' }],
    reason: GOOD_REASON,
    reviewedOn: '2026-08-10',
  })
  return reg
}

test('GREEN: two ramps of one gate, each with its OWN anchored row, close the union', () => {
  const r = runFixture({ register: twoRampRegister(), tools: { 'check-widget.mjs': TWO_RAMP_GATE } })
  assert.equal(r.code, 0, r.out)
})

test('RED (per-site keying): deleting ONE of two same-gate rows reds — the sibling no longer covers it', () => {
  const reg = twoRampRegister()
  reg.obligations = reg.obligations.filter((row) => row.id !== 'widget-rollout-ramp-expiry')
  const r = runFixture({ register: reg, tools: { 'check-widget.mjs': TWO_RAMP_GATE } })
  assert.equal(r.code, 1, `the surviving same-gate row must NOT cover the deleted one's ramp:\n${r.out}`)
  // The detail is what names WHICH ramp is uncovered — the old message could not say.
  assert.match(r.out, /the widget rollout escape/)
  assert.ok(
    !r.out.includes('the widget adoption escape'),
    `only the uncovered ramp may be reported; the anchored one is covered:\n${r.out}`,
  )
})

test('RED (per-site keying): a row whose id merely CONTAINS the gate name does not satisfy a ramp', () => {
  // The other half of the same defect, and it ran unnoticed for a release:
  // `auth-posture-consumer-tunable-split` is not a ramp row at all, yet its id contains
  // "auth-posture" and it satisfied an auth-posture ramp by accident. An id substring is not
  // an identifier — only the anchor is.
  const reg = baseRegister()
  const row = reg.obligations.find((x) => x.id === 'widget-ramp-expiry')
  row.id = 'widget-something-else-entirely'
  delete row.sites
  const r = runFixture({ register: reg })
  assert.equal(r.code, 1, `a gate-name substring must not cover a ramp:\n${r.out}`)
  assert.match(r.out, /a row that merely names the gate in its id cannot tell two ramps of one gate apart/)
})

test('RED (anti-vacuity): a tools tree with NO ramp sites makes the union check vacuous, so it reds', () => {
  const r = runFixture({ tools: { 'check-widget.mjs': "const GATE = 'widget'\n" } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no rampNote\(\) call sites/i)
})

test('RED (anchor): a sites[] entry whose mustContain is absent from the named file reds', () => {
  const r = runFixture({
    register: withRow({
      id: 'anchored',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
      evidence: 'https://example.com/x',
      sites: [{ file: 'docs/note.md', mustContain: 'the sentence the row indexes' }],
    }),
    files: { 'docs/note.md': 'a file that says something else entirely\n' },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'anchored'.*docs\/note\.md.*does not contain/s)
})

test('GREEN (anchor): a sites[] anchor whose sentence is present is clean — one-way by design', () => {
  const r = runFixture({
    register: withRow({
      id: 'anchored',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
      evidence: 'https://example.com/x',
      sites: [{ file: 'docs/note.md', mustContain: 'the sentence the row indexes' }],
    }),
    files: { 'docs/note.md': 'here is the sentence the row indexes, verbatim\n' },
  })
  assert.equal(r.code, 0, r.out)
})

test('RED (anchor): a sites[] entry naming a file the tree does not carry reds', () => {
  const r = runFixture({
    register: withRow({
      id: 'ghost-site',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
      evidence: 'https://example.com/x',
      sites: [{ file: 'docs/gone.md' }],
    }),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'ghost-site'.*docs\/gone\.md.*does not exist/s)
})

test('RED (evidence): a condition whose evidence is a file ref that resolves nowhere reds', () => {
  const r = runFixture({
    register: withRow({
      id: 'ghost-evidence',
      kind: 'condition',
      target: null,
      reason: GOOD_REASON,
      reviewedOn: '2026-08-10',
      evidence: 'docs/missing-evidence.md',
    }),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'ghost-evidence'.*evidence.*does not exist/s)
})
