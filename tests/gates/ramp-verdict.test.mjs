// The upgrade lane's expiry judgement (0.5.0) — including THIS RELEASE'S NAMED CANARY.
//
// Until now this logic was fifteen lines of grep/cut/case inside scripts/ci/upgrade-lane.sh,
// reachable only by a 45-minute CI job that scaffolds a whole project. It is the single
// assertion separating "an expiry fired" from "an expiry was supposed to fire and silently
// did not" — the defect v0.4.0 shipped to fix, where check-rate-limits.mjs printed RAMP
// EXPIRED to stderr and the gate then called ok() and exited 0 for three releases.
//
// THE CANARY, and why leg D is the leg that carries it. The lane's expectation set is an
// UPPER BOUND: most gates call rampNote only when they have a finding to withhold, so an
// expected-but-silent gate is reported and never asserted. That makes a "neutralise one
// expiry" canary unfalsifiable on any leg with several expected gates — the survivors keep
// `fired` non-empty and nothing notices. A 0.3.0 baseline at HEAD 0.5.0 narrows to exactly
// ONE chain gate (`wiring`; `diff-coverage` is Stop-chain and drops out), and with one
// expected gate, neutralising it empties `fired` and the assertion has to bite.
// SOURCE: scripts/lib/ramp-verdict.mjs · scripts/ci/upgrade-lane.sh (§7a)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { firedExpiries, judgeExpiries } from '../../scripts/lib/ramp-verdict.mjs'

const RED_LOG = `format: OK
wiring: RAMP EXPIRED — the web a11y lint plugin was ramped from baseVersion 0.4.0 with a deadline of 0.5.0, and this install runs harness 0.5.0.
wiring: FAIL (1)
`
// The same run with the alarm silenced: the gate still reds, but nothing announces that a
// deadline is what did it.
const NEUTRALISED_LOG = `format: OK
wiring: FAIL (1)
`

test('firedExpiries is anchored — prose that NAMES the phrase is not a gate that fired', () => {
  const log = `docs-sync: NOTE — see the RAMP EXPIRED section of docs/runbooks/harness-upgrade.md
wiring: RAMP EXPIRED — the web a11y lint plugin
  a wrapped continuation mentioning RAMP EXPIRED again
`
  assert.deepEqual(firedExpiries(log), ['wiring'])
})

test('firedExpiries de-duplicates and sorts — a gate firing twice is one gate', () => {
  const log = 'wiring: RAMP EXPIRED — a\nwiring: RAMP EXPIRED — b\ndocs-sync: RAMP EXPIRED — c\n'
  assert.deepEqual(firedExpiries(log), ['docs-sync', 'wiring'])
})

test('the happy path: the one expected gate fired and the chain is red', () => {
  const { problems, fired, silent } = judgeExpiries({
    expected: ['wiring'],
    validateLog: RED_LOG,
    validateCode: 1,
    baseVersion: '0.3.0',
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(fired, ['wiring'])
  assert.deepEqual(silent, [])
})

test('THE CANARY — an expiry that FIRED into a green chain kills the lane', () => {
  // The v0.4.0 defect, verbatim: check-rate-limits.mjs printed RAMP EXPIRED, discarded
  // rampNote's return value, called ok() and exited 0 for three releases. This is the one
  // dynamic assertion the lane can make soundly, because a fired expiry means the gate
  // stopped withholding — so it MUST have failed.
  const { problems, fired } = judgeExpiries({
    expected: ['wiring'],
    validateLog: 'format: OK\nwiring: RAMP EXPIRED — the web a11y lint plugin\nwiring: OK\n',
    validateCode: 0,
    baseVersion: '0.3.0',
  })
  assert.deepEqual(fired, ['wiring'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /expiries FIRED \(wiring\) and yet validate exited 0/)
  assert.match(problems[0], /discarded rampNote's result/)
})

test('ALL-SILENT is reported and NOT asserted — the rule this file broke on its first run', () => {
  // WHAT WAS WRONG. The shipped draft demanded that at least one expiry fire whenever a
  // deadline was met. Leg D's single expectation is `wiring`, whose expiring site is
  // guarded by `if (!declared)` on eslint-plugin-jsx-a11y — and the lane's own dependency-
  // obligation step applies that pin before validate runs. The lane remedied the condition
  // and then demanded an alarm about it, so leg D could never have gone green. Two correct
  // features; only executing them showed the interaction.
  //
  // The discarded-result case this used to claim to catch is decided statically over every
  // shipped site by scripts/check-ramp-ledger.mjs, which is why nothing replaces it.
  const { problems, fired, silent } = judgeExpiries({
    expected: ['wiring'],
    validateLog: NEUTRALISED_LOG,
    validateCode: 1,
    baseVersion: '0.3.0',
  })
  assert.deepEqual(fired, [])
  assert.deepEqual(silent, ['wiring'], 'silent is REPORTED — never hidden')
  assert.deepEqual(problems, [], 'and never asserted')
})

test('a partially-silent expectation is clean — one gate fired, the other had no finding', () => {
  // The upper bound in practice, and what leg C measured: baseVersion 0.2.1 expects four
  // gates, `docs-sync` and `gate-integrity` fired, and the rest had nothing to withhold on
  // that tree. Silence is reported per gate and asserted on none of them.
  const { problems, silent } = judgeExpiries({
    expected: ['docs-sync', 'wiring'],
    validateLog: RED_LOG,
    validateCode: 1,
    baseVersion: '0.2.1',
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(silent, ['docs-sync'])
})

test('a met deadline, nothing fired, and a GREEN chain is legitimate — not a finding', () => {
  // The state leg D actually reaches once the lane applies the jsx-a11y obligation: the
  // deadline is met, the gate has nothing to withhold, so it never calls rampNote and the
  // chain is green. The shipped draft raised TWO problems here and would have held the
  // release red on a correct tree.
  const { problems, fired, silent } = judgeExpiries({
    expected: ['wiring'],
    validateLog: 'format: OK\nwiring: OK\n',
    validateCode: 0,
    baseVersion: '0.3.0',
  })
  assert.deepEqual(fired, [])
  assert.deepEqual(silent, ['wiring'])
  assert.deepEqual(problems, [])
})

test('CANARY — a SURPRISE expiry means the classifier and gate.mjs disagree', () => {
  const { problems } = judgeExpiries({
    expected: ['wiring'],
    validateLog: `${RED_LOG}tenancy: RAMP EXPIRED — something nobody predicted\n`,
    validateCode: 1,
    baseVersion: '0.3.0',
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /gate `tenancy` printed RAMP EXPIRED but the classifier did not predict it/)
})

test('an EMPTY expectation with a red chain is a REGRESSION, not an expiry', () => {
  // Leg A's shape. Letting "the upgrade broke the install" pass as "a ramp closed" would
  // turn the one leg that proves the unbroken path into the one that hides a break.
  const { problems } = judgeExpiries({
    expected: [],
    validateLog: 'types: FAIL (3)\n',
    validateCode: 1,
    baseVersion: '0.4.0',
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /this is a regression, not an expiry/)
})

test('an EMPTY expectation with a green chain is clean — leg A must stay reachable', () => {
  const { problems } = judgeExpiries({
    expected: [],
    validateLog: 'format: OK\ntypes: OK\n',
    validateCode: 0,
    baseVersion: '0.4.0',
  })
  assert.deepEqual(problems, [])
})

test('an expiry firing against an EMPTY expectation is the loudest disagreement', () => {
  const { problems } = judgeExpiries({
    expected: [],
    validateLog: RED_LOG,
    validateCode: 1,
    baseVersion: '0.4.0',
  })
  assert.equal(problems.length, 2, 'the regression message AND the unpredicted-expiry message')
  assert.ok(problems.some((p) => /predicted NO expiry at all/.test(p)))
})

test('the shipped runner exits 1 on the canary and 0 on the happy path', () => {
  const script = fileURLToPath(new URL('../../scripts/ci/ramp-verdict.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'ramp-verdict-'))
  const run = (log, code) => {
    const path = join(dir, `v-${String(code)}-${String(log.length)}.log`)
    writeFileSync(path, log)
    return spawnSync(process.execPath, [script, 'wiring', path, String(code), '0.3.0'], {
      encoding: 'utf8',
    })
  }

  // The canary is now "it fired and the chain stayed green", which is the discarded-result
  // defect. NEUTRALISED_LOG (nothing fired at all) is the legitimate all-silent case and
  // must exit 0 — asserted below, because that is the direction this file got wrong.
  const red = run(`${RED_LOG}\n`, 0)
  assert.equal(red.status, 1, `${red.stdout}${red.stderr}`)
  assert.match(red.stderr, /upgrade-lane: 1 expiry problem\(s\)/)
  assert.match(red.stderr, /and yet validate exited 0/)

  const green = run(RED_LOG, 1)
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`)
  assert.match(green.stdout, /expired: {3}wiring/)

  const silent = run(NEUTRALISED_LOG, 1)
  assert.equal(silent.status, 0, `${silent.stdout}${silent.stderr}`)
})
