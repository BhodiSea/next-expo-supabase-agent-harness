// The macOS scaffold lane's skip judgement (#168), and the lane's can-fail proof.
//
// The lane runs validate with CI unset, the way a developer's Mac without Docker runs it, so
// a gate with a missing prerequisite skips instead of failing closed. Only the database gates
// may do that there. These tests prove the judgement reds the moment any other gate skips,
// which is the canary tests/canary/injections.json registers for selftest.yml#macos-scaffold.
// SOURCE: scripts/lib/skip-verdict.mjs · .github/workflows/selftest.yml (macos-scaffold)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DATABASE_STEPS, judgeSkips, skipsByStep } from '../../scripts/lib/skip-verdict.mjs'

const RUNNER = fileURLToPath(new URL('../../scripts/ci/skip-verdict.mjs', import.meta.url))

const GREEN_LOG = `
=== format: pnpm exec biome ci .
Checked 412 files in 180ms. No fixes applied.

=== types-drift: node tools/check-types-drift.mjs
types-drift: SKIPPED — supabase is not running (enforced in the CI supabase lane; a skip is not a pass)

validate summary:
  ✓ format (900ms)
  ✓ types-drift (40ms)
  total 940ms
`

// The same run with one non-database gate made to skip: what a missing macOS toolchain looks
// like on a laptop. The chain still exits 0, which is exactly why the lane needs this check.
const INJECTED_LOG = GREEN_LOG.replace(
  'Checked 412 files in 180ms. No fixes applied.',
  'format: SKIPPED — biome is not installed (this gate FAILS CLOSED in CI)',
)

test('the database steps are the only ones allowed to skip', () => {
  assert.deepEqual([...DATABASE_STEPS], ['types-drift'])
})

test('skipsByStep attributes each skip to the step header it printed under', () => {
  assert.deepEqual(skipsByStep(INJECTED_LOG), [
    { step: 'format', line: 'format: SKIPPED — biome is not installed (this gate FAILS CLOSED in CI)' },
    {
      step: 'types-drift',
      line: 'types-drift: SKIPPED — supabase is not running (enforced in the CI supabase lane; a skip is not a pass)',
    },
  ])
})

test('skipsByStep is anchored: prose naming the word is not a skip', () => {
  const log = '=== docs-sync: x\n  the catalog says a gate SKIPPED locally fails in CI\ndocs-sync: OK\n'
  assert.deepEqual(skipsByStep(log), [])
})

test('a NOTE that says part of a gate was SKIPPED counts as a skip', () => {
  const log =
    '=== styleguide: node tools/check-styleguide-manifest.mjs\nstyleguide: NOTE — @app/design-tokens regen-diff SKIPPED locally\n'
  assert.deepEqual(
    skipsByStep(log).map((s) => s.step),
    ['styleguide'],
  )
})

test('green: only the database gate skipped and validate finished at 0', () => {
  const { problems, allowedSkips } = judgeSkips({ validateLog: GREEN_LOG, validateCode: 0 })
  assert.deepEqual(problems, [])
  assert.equal(allowedSkips.length, 1)
})

test('CANARY: a non-database gate made to skip reds the lane, though validate exited 0', () => {
  const { problems } = judgeSkips({ validateLog: INJECTED_LOG, validateCode: 0 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /step 'format' skipped and it does not need a database/)
})

test('a log that never reached its summary reds: silence from a dead run proves nothing', () => {
  const cut = GREEN_LOG.slice(0, GREEN_LOG.indexOf('validate summary:'))
  const { problems } = judgeSkips({ validateLog: cut, validateCode: 0 })
  assert.deepEqual(problems, ['the log has no `validate summary:` line, so the run did not finish'])
})

test('a red validate is reported beside the skips', () => {
  const { problems } = judgeSkips({ validateLog: GREEN_LOG, validateCode: 1 })
  assert.deepEqual(problems, ['validate exited 1'])
})

test('the runner exits 1 on the injected log and 0 on the green one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-verdict-'))
  const green = join(dir, 'green.log')
  const red = join(dir, 'red.log')
  writeFileSync(green, GREEN_LOG)
  writeFileSync(red, INJECTED_LOG)
  const ok = spawnSync(process.execPath, [RUNNER, green, '0'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /allowed \(database\): types-drift: SKIPPED/)
  const bad = spawnSync(process.execPath, [RUNNER, red, '0'], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /step 'format' skipped/)
  const usage = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8' })
  assert.equal(usage.status, 2)
})
