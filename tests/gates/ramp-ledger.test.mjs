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
// SOURCE: scripts/lib/ramp-sites.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  classifyForInstall,
  cmpDotted,
  LINEAGE_FLOOR,
  neverArmed,
  rampNoteCalls,
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
