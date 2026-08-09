// scripts/ci/run-stop-chain.mjs (0.7.0) — the DERIVED canary baseline.
//
// The selftest canary job used to open with sixteen hand-typed gate invocations titled
// "Baseline — every canaried gate PASSES on the clean scaffold". A hand-typed list can
// drift from the chain it claims to prove; the runner replaces it with the union
// `validate --stop-chain --list` reports (the SAME lib the Stop hook imports), minus a
// reviewed exclusions file whose every entry must name a reason AND a `provenBy` string
// that still exists in the selftest workflow — skip-with-declaration, machine-checked for
// staleness, never silent. These tests pin the subtract/staleness logic pure, the shipped
// exclusions file against the REAL union and workflow, and the runner end-to-end on a
// marker fixture.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseStepList, subtractExclusions } from '../../scripts/ci/run-stop-chain.mjs'
import { STOP_HOOK_STEPS } from '../../template/base/tools/harness.config.mjs'
import { loadStopChain } from '../../template/base/tools/lib/stop-chain.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RUNNER = join(ROOT, 'scripts/ci/run-stop-chain.mjs')
const VALIDATE = join(ROOT, 'template/base/tools/validate.mjs')
const STOP_LIB = join(ROOT, 'template/base/tools/lib/stop-chain.mjs')

// ── parseStepList ────────────────────────────────────────────────────────────

test('parseStepList round-trips the `validate --stop-chain --list` format', () => {
  const text = 'validate  node tools/validate.mjs --report-all\nrls-isolation  node tests/rls/run-rls.mjs\n'
  assert.deepEqual(parseStepList(text), [
    ['validate', 'node tools/validate.mjs --report-all'],
    ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  ])
})

test('parseStepList refuses garbage and refuses a VACUOUS list', () => {
  assert.throws(() => parseStepList('no-two-space-separator here\n'), /unparseable/)
  assert.throws(() => parseStepList('\n\n'), /no steps/)
})

// ── subtractExclusions: the reviewed skip-with-declaration ───────────────────

const UNION = [
  ['validate', 'node tools/validate.mjs --report-all'],
  ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  ['unit', 'pnpm exec vitest run --coverage --silent'],
]
const SELFTEST_TEXT = 'jobs:\n  bootstrap-linux:\n    steps:\n      - name: THE STOP CHAIN — as a chain, via the real hook\n'

test('subtractExclusions subtracts a declared step and reports it as SKIPPED, never silently', () => {
  const { run, skipped, problems } = subtractExclusions(
    UNION,
    [{ step: 'rls-isolation', reason: 'no database in this job', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' }],
    SELFTEST_TEXT,
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(run.map(([n]) => n), ['validate', 'unit'])
  assert.deepEqual(skipped.map((s) => s.step), ['rls-isolation'])
})

test('a STALE exclusion naming a step not in the union REDS — a skip may not outlive its subject', () => {
  const { problems } = subtractExclusions(
    UNION,
    [{ step: 'ghost-step', reason: 'was once real', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' }],
    SELFTEST_TEXT,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /ghost-step/)
  assert.match(problems[0], /STALE/)
})

test('a provenBy string absent from the selftest workflow REDS — the cross-reference is machine-checked', () => {
  const { problems } = subtractExclusions(
    UNION,
    [{ step: 'rls-isolation', reason: 'no database in this job', provenBy: 'a step title that was renamed away' }],
    SELFTEST_TEXT,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /provenBy/)
  assert.match(problems[0], /not found/)
})

test('an exclusion with no reason, no provenBy, or a duplicate step REDS', () => {
  const noReason = subtractExclusions(
    UNION,
    [{ step: 'unit', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' }],
    SELFTEST_TEXT,
  )
  assert.equal(noReason.problems.length, 1)
  assert.match(noReason.problems[0], /reason/)

  const noProof = subtractExclusions(UNION, [{ step: 'unit', reason: 'time' }], SELFTEST_TEXT)
  assert.equal(noProof.problems.length, 1)
  assert.match(noProof.problems[0], /provenBy/)

  const dup = subtractExclusions(
    UNION,
    [
      { step: 'unit', reason: 'time', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' },
      { step: 'unit', reason: 'time again', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' },
    ],
    SELFTEST_TEXT,
  )
  assert.equal(dup.problems.length, 1)
  assert.match(dup.problems[0], /twice/)

  const nameless = subtractExclusions(UNION, [{ reason: 'r', provenBy: 'x' }], SELFTEST_TEXT)
  assert.equal(nameless.problems.length, 1)
  assert.match(nameless.problems[0], /step/)
})

// ── the SHIPPED exclusions file, against the REAL union and the REAL workflow ─

test('every SHIPPED exclusion names a real union member, a reason, and a provenBy still present in selftest.yml', () => {
  const shipped = JSON.parse(readFileSync(join(ROOT, 'scripts/ci/stop-chain-exclusions.json'), 'utf8'))
  const selftest = readFileSync(join(ROOT, '.github/workflows/selftest.yml'), 'utf8')
  const { steps, floorNote } = loadStopChain(
    STOP_HOOK_STEPS,
    pathToFileURL(join(ROOT, 'template/base/tools/stop.floor.json')),
  )
  assert.equal(floorNote, null)
  const { problems } = subtractExclusions(steps, shipped.exclusions, selftest)
  assert.deepEqual(problems, [], 'the shipped exclusions file has gone stale')
  assert.ok(shipped.exclusions.length > 0, 'the canary job needs at least the rls-isolation exclusion')
  // …and the union members the canary job MUST still execute are not excludable en masse:
  // `validate` is the member that subsumes the sixteen hand-typed baseline gates this
  // runner replaced, so excluding it would hollow the derived baseline into decoration.
  assert.ok(
    !shipped.exclusions.some((e) => e.step === 'validate'),
    'excluding `validate` would gut the derived baseline — the exclusions file is for steps a job CANNOT run',
  )
})

// ── end-to-end on a marker fixture ───────────────────────────────────────────

/**
 * A scaffold-shaped fixture the runner can drive for real: validate.mjs + the shared
 * union lib, marker STOP steps (each writes ran-<name>), and one `probe` step that FAILS
 * unless the runner's child env is the declared shape (CI=true, synthetic turn identity,
 * GITHUB_BASE_REF and HARNESS_ALLOW_SELF_EDIT scrubbed) — the exact env contract that
 * makes reviewer-verdicts EXECUTE with owed=[] instead of skipping.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-runstop-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  copyFileSync(STOP_LIB, join(dir, 'tools/lib/stop-chain.mjs'))
  for (const n of ['validate', 'rls-isolation', 'unit']) {
    writeFileSync(
      join(dir, `mark-${n}.mjs`),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync('ran-${n}', '1')\n`,
    )
  }
  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      "if (process.env.CI !== 'true') process.exit(11)",
      "if (!process.env.HARNESS_SESSION_ID || !process.env.HARNESS_PROMPT_ID) process.exit(12)",
      "if (process.env.GITHUB_BASE_REF !== undefined) process.exit(13)",
      "if (process.env.HARNESS_ALLOW_SELF_EDIT !== undefined) process.exit(14)",
      "writeFileSync('ran-probe', '1')",
      '',
    ].join('\n'),
  )
  const steps = [
    ['validate', 'node mark-validate.mjs'],
    ['rls-isolation', 'node mark-rls-isolation.mjs'],
    ['unit', 'node mark-unit.mjs'],
    ['probe', 'node probe.mjs'],
  ]
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [${steps.map(([n, c]) => `['${n}', '${c}']`).join(', ')}]\n`,
  )
  writeFileSync(
    join(dir, 'tools/stop.floor.json'),
    `${JSON.stringify({ comment: 'fixture', steps }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'fake-selftest.yml'), SELFTEST_TEXT)
  return dir
}

function runRunner(dir, exclusions) {
  writeFileSync(join(dir, 'exclusions.json'), JSON.stringify({ exclusions }, null, 2))
  const res = spawnSync(
    process.execPath,
    [RUNNER, dir, '--exclusions', join(dir, 'exclusions.json'), '--selftest', join(dir, 'fake-selftest.yml')],
    {
      cwd: dir,
      encoding: 'utf8',
      // The scrub is exercised for real: both leak candidates are SET going in.
      env: { ...process.env, GITHUB_BASE_REF: 'main', HARNESS_ALLOW_SELF_EDIT: '1', CI: 'true' },
    },
  )
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('e2e: the runner derives the union, PRINTS the declared skip, runs the rest under the contract env', () => {
  const dir = fixture()
  const r = runRunner(dir, [
    { step: 'rls-isolation', reason: 'no database in this fixture', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' },
  ])
  assert.equal(r.code, 0, r.out)
  assert.ok(existsSync(join(dir, 'ran-validate')), r.out)
  assert.ok(existsSync(join(dir, 'ran-unit')), r.out)
  assert.ok(existsSync(join(dir, 'ran-probe')), `the env contract must hold (probe exit codes 11-14 name the broken clause): ${r.out}`)
  assert.ok(!existsSync(join(dir, 'ran-rls-isolation')), 'the excluded step must NOT run')
  assert.match(r.out, /SKIP \(declared\): rls-isolation — no database in this fixture/)
  assert.match(r.out, /3 step\(s\) green/)
})

test('e2e: a red union member fails the run NAMING the step', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'mark-unit.mjs'), 'process.exit(3)\n')
  const r = runRunner(dir, [
    { step: 'rls-isolation', reason: 'no database in this fixture', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' },
  ])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /unit/)
  assert.match(r.out, /FAILED/)
})

test('e2e: a stale exclusion reds the whole run before anything executes', () => {
  const dir = fixture()
  const r = runRunner(dir, [
    { step: 'ghost-step', reason: 'gone', provenBy: 'THE STOP CHAIN — as a chain, via the real hook' },
  ])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /ghost-step/)
  assert.ok(!existsSync(join(dir, 'ran-validate')), 'a broken exclusions file must stop the baseline cold')
})
