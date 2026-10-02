// Behavioral tests for template/base/tools/validate.mjs: default first-failure
// stop vs --report-all (the Stop hook path must surface EVERY red at once),
// per-step elapsed-ms in the summary, and the --report-all concurrency pool
// (canonical-order buffered output, failure aggregation, exclusive non-pooled steps).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadStopChain } from '../../template/base/tools/lib/stop-chain.mjs'

const VALIDATE = fileURLToPath(new URL('../../template/base/tools/validate.mjs', import.meta.url))
const STOP_LIB = fileURLToPath(
  new URL('../../template/base/tools/lib/stop-chain.mjs', import.meta.url),
)

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.HARNESS_PARITY_REPORT_DIR
  delete env.GITHUB_BASE_REF
  return { ...env, ...extra }
}

// Stub config: red, green, red — distinguishes "stopped at first failure" from
// "ran everything" unambiguously.
const STUB_CONFIG = `export const VALIDATE_STEPS = [
  ['first-red', 'node -e "process.exit(1)"'],
  ['mid-green', 'node -e "process.exit(0)"'],
  ['last-red', 'node -e "process.exit(1)"'],
]
export const STOP_HOOK_STEPS = []
`

function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-validate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  writeFileSync(join(dir, 'tools/harness.config.mjs'), STUB_CONFIG)
  const res = spawnSync('node', ['tools/validate.mjs', ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv() })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('default run stops at the first failure and says what did not run', () => {
  const r = run([])
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('✗ first-red'), r.out)
  assert.ok(!r.out.includes('mid-green ('), r.out)
  assert.ok(r.out.includes('(2 later step(s) not run)'), r.out)
})

test('--report-all runs every step, reports every red, still exits 1', () => {
  const r = run(['--report-all'])
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('✗ first-red'), r.out)
  assert.ok(r.out.includes('✓ mid-green'), r.out)
  assert.ok(r.out.includes('✗ last-red'), r.out)
  assert.ok(!r.out.includes('not run'), r.out)
})

test('summary carries per-step elapsed ms and a total', () => {
  const r = run(['--report-all'])
  assert.match(r.out, /✓ mid-green \(\d+ms\)/, r.out)
  assert.match(r.out, /total \d+ms/, r.out)
})

// ── the --report-all concurrency pool ─────────────────────────────────────────
// Each stub step appends start:<name>/end:<name> to a shared log and echoes under
// its own header, so we can assert canonical output order and — deterministically,
// no sleep-timing — that exclusive steps serialize against the batches around them.
const STEP_RUNNER = `import { appendFileSync } from 'node:fs'
const [name, code] = process.argv.slice(2)
appendFileSync(process.env.STEP_LOG, \`start:\${name}\\n\`)
appendFileSync(process.env.STEP_LOG, \`end:\${name}\\n\`)
process.stdout.write(\`\${name} did work\\n\`)
process.exit(Number(code))
`

function poolConfig(steps) {
  const body = steps.map(([n, c]) => `  ['${n}', 'node tools/step.mjs ${n} ${c}'],`).join('\n')
  return `export const VALIDATE_STEPS = [\n${body}\n]\nexport const STOP_HOOK_STEPS = []\n`
}

// steps: [name, exitCode][]. provenance/version-sync/licenses/docs-sync are
// PARALLEL_SAFE (pooled); 'custom-step' stands in for a consumer step (exclusive).
function runPool(steps, args = ['--report-all']) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-validate-pool-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  writeFileSync(join(dir, 'tools/step.mjs'), STEP_RUNNER)
  writeFileSync(join(dir, 'tools/harness.config.mjs'), poolConfig(steps))
  const log = join(dir, 'steps.log')
  const res = spawnSync('node', ['tools/validate.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv({ STEP_LOG: log }),
  })
  const logLines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, log: logLines }
}

const POOL_STEPS = [
  ['provenance', 0], // batch 1 (PARALLEL_SAFE, shares the 'git' resource)
  ['version-sync', 0], // batch 1 (PARALLEL_SAFE)
  ['custom-step', 0], // EXCLUSIVE (not in PARALLEL_SAFE)
  ['licenses', 0], // batch 2 (PARALLEL_SAFE)
  ['docs-sync', 0], // batch 2 (PARALLEL_SAFE)
]
const POOL_ORDER = ['provenance', 'version-sync', 'custom-step', 'licenses', 'docs-sync']

test('--report-all: headers print in CANONICAL order, pooled output buffered under each', () => {
  const r = runPool(POOL_STEPS)
  assert.equal(r.code, 0, r.out)
  const positions = POOL_ORDER.map((n) => r.out.indexOf(`=== ${n}:`))
  for (const [i, p] of positions.entries()) assert.ok(p !== -1, `missing header ${POOL_ORDER[i]}: ${r.out}`)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `out of order: ${r.out}`)
  // captured pooled stdout is flushed under its own header, not lost
  assert.ok(r.out.includes('provenance did work'), r.out)
  assert.ok(r.out.includes('docs-sync did work'), r.out)
})

test('--report-all: per-step ms appears for pooled AND exclusive steps, plus a total', () => {
  const r = runPool(POOL_STEPS)
  for (const n of POOL_ORDER) {
    assert.match(r.out, new RegExp(`✓ ${n} \\(\\d+ms\\)`), `${n}: ${r.out}`)
  }
  assert.match(r.out, /total \d+ms/, r.out)
})

test('--report-all: a failing pooled step AND a failing exclusive step both aggregate (exit 1, every step ran)', () => {
  const r = runPool([
    ['provenance', 0],
    ['version-sync', 1], // red INSIDE a pooled batch
    ['custom-step', 1], // red EXCLUSIVE step
    ['licenses', 0],
    ['docs-sync', 0],
  ])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('✗ version-sync'), r.out)
  assert.ok(r.out.includes('✗ custom-step'), r.out)
  assert.ok(r.out.includes('✓ provenance'), r.out)
  assert.ok(r.out.includes('✓ docs-sync'), r.out)
  assert.ok(!r.out.includes('not run'), r.out) // report-all never stops early
})

test('--report-all: a non-PARALLEL_SAFE step runs EXCLUSIVE — serialized between its neighbor batches', () => {
  const r = runPool(POOL_STEPS)
  assert.equal(r.code, 0, r.out)
  const at = (line) => r.log.indexOf(line)
  // batch 1 fully finishes before the exclusive step starts
  assert.ok(at('end:provenance') < at('start:custom-step'), r.log.join(','))
  assert.ok(at('end:version-sync') < at('start:custom-step'), r.log.join(','))
  // the exclusive step's own markers are adjacent — nothing else runs during it
  assert.equal(at('end:custom-step'), at('start:custom-step') + 1, r.log.join(','))
  // and it finishes before the next batch starts
  assert.ok(at('end:custom-step') < at('start:licenses'), r.log.join(','))
  assert.ok(at('end:custom-step') < at('start:docs-sync'), r.log.join(','))
})

// ── --stop-chain: the STOP union as a resolution MODE ────────────────────────
// The Stop chain finally has a runner outside a live turn: `--stop-chain` swaps
// resolveSteps() for the floor∪config union computed by the SAME lib the hook imports
// (tools/lib/stop-chain.mjs), composing with --list and --report-all. Membership of both
// chains is untouched — this is a resolution mode, not a new chain.

/**
 * A scaffold-shaped fixture for the stop-chain mode: validate.mjs + the shared union lib,
 * marker-script STOP steps, a deliberately RED VALIDATE_STEPS decoy (so any leak of the
 * default resolution into --stop-chain reds the assertion), and a floor under our control.
 * @param {{ config: string[], floor: string[] | null, corruptFloor?: string }} spec
 */
function stopChainFixture({ config, floor, corruptFloor }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-validate-stop-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  copyFileSync(STOP_LIB, join(dir, 'tools/lib/stop-chain.mjs'))
  for (const n of new Set([...config, ...(floor ?? [])])) {
    writeFileSync(
      join(dir, `mark-${n}.mjs`),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync('ran-${n}', '1')\n`,
    )
  }
  const tuple = (n) => `['${n}', 'node mark-${n}.mjs']`
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = [['decoy', 'node -e "process.exit(1)"']]\nexport const STOP_HOOK_STEPS = [${config.map(tuple).join(', ')}]\n`,
  )
  if (corruptFloor !== undefined) {
    writeFileSync(join(dir, 'tools/stop.floor.json'), corruptFloor)
  } else if (floor !== null) {
    writeFileSync(
      join(dir, 'tools/stop.floor.json'),
      `${JSON.stringify({ comment: 'fixture', steps: floor.map((n) => [n, `node mark-${n}.mjs`]) }, null, 2)}\n`,
    )
  }
  return dir
}

function runStopChain(dir, args) {
  const res = spawnSync('node', ['tools/validate.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv(),
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('--stop-chain --list output EQUALS the union the shared lib computes (floor-first, config-append, no subtraction)', () => {
  const dir = stopChainFixture({
    config: ['validate', 'house-rule'],
    floor: ['validate', 'test-quality'],
  })
  const r = runStopChain(dir, ['--stop-chain', '--list'])
  assert.equal(r.code, 0, r.out)
  const lines = r.out.split(/\r?\n/).filter((l) => l.trim() !== '')
  // The expected union comes from the LIB ITSELF over the same fixture files — the pin is
  // that the CLI and the lib can never disagree, which is the whole point of one implementation.
  const expected = loadStopChain(
    [
      ['validate', 'node mark-validate.mjs'],
      ['house-rule', 'node mark-house-rule.mjs'],
    ],
    pathToFileURL(join(dir, 'tools/stop.floor.json')),
  )
  assert.equal(expected.floorNote, null)
  assert.deepEqual(
    lines,
    expected.steps.map(([n, c]) => `${n}  ${c}`),
  )
  assert.deepEqual(
    lines.map((l) => l.split('  ')[0]),
    ['validate', 'test-quality', 'house-rule'],
    'floor order first (the dropped test-quality is back), appended house-rule last',
  )
  assert.ok(!r.out.includes('decoy'), 'VALIDATE_STEPS must not leak into the stop-chain resolution')
})

test('--stop-chain RUNS the union and composes with --report-all: a floored step the config dropped still executes, and its red fails the run', () => {
  const dir = stopChainFixture({ config: ['validate'], floor: ['validate', 'boom'] })
  writeFileSync(join(dir, 'mark-boom.mjs'), 'process.exit(3)\n')
  const r = runStopChain(dir, ['--stop-chain', '--report-all'])
  assert.equal(r.code, 1, r.out)
  assert.ok(existsSync(join(dir, 'ran-validate')), 'the config step must run')
  assert.ok(r.out.includes('✗ boom'), `the floored step the config dropped must run and red: ${r.out}`)
  assert.ok(r.out.includes('✓ validate'), r.out)
  assert.ok(!r.out.includes('not run'), 'report-all never stops early')
})

test('--stop-chain FAILS CLOSED on a missing or corrupt floor — a runner asked to PROVE the chain must not prove a weakened one', () => {
  // The deliberate contrast with the hook (fail-open-with-NOTE): a corrupt floor must not
  // brick every live turn on a machine, but a CI runner deriving the canary baseline from
  // this mode must abort rather than quietly derive it from the config alone.
  const missing = runStopChain(stopChainFixture({ config: ['validate'], floor: null }), [
    '--stop-chain',
    '--list',
  ])
  assert.equal(missing.code, 1)
  assert.match(missing.out, /FAILING CLOSED/)

  const corrupt = runStopChain(
    stopChainFixture({ config: ['validate'], floor: [], corruptFloor: '{ not json' }),
    ['--stop-chain', '--list'],
  )
  assert.equal(corrupt.code, 1)
  assert.match(corrupt.out, /FAILING CLOSED/)
})

test('default mode (no --report-all) stays serial and stops at first failure even for PARALLEL_SAFE names', () => {
  const r = runPool(
    [
      ['provenance', 1], // a PARALLEL_SAFE name, but default mode never pools
      ['version-sync', 0],
      ['licenses', 0],
    ],
    [],
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('✗ provenance'), r.out)
  assert.ok(!r.out.includes('✓ version-sync'), r.out) // stopped at the first failure
  assert.ok(r.out.includes('(2 later step(s) not run)'), r.out)
  // serial + streamed: only provenance ran, so only its markers exist in the log
  assert.deepEqual(r.log, ['start:provenance', 'end:provenance'])
})

// ── --ci-parity: CI's no-skip, no-stamp posture for a local run (1.0.4, N04) ──────
// Local and CI verdicts split on one predicate, inCI() in tools/lib/gate.mjs: a missing
// prerequisite skips locally and fails in CI, and a warm stamp is honoured only locally.
// `--ci-parity` sets HARNESS_REQUIRE_TOOLCHAINS=1 for the run, prints a posture line, and
// closes with one line per missing prerequisite a gate recorded. Every stub below is a
// FILE (no nested `node -e` quoting, so the Windows leg runs the same commands), and the
// gate stubs import a copy of the real lib/gate.mjs, so what they record is what a
// shipped gate records.
const GATE_LIB_FILE = fileURLToPath(
  new URL('../../template/base/tools/lib/gate.mjs', import.meta.url),
)
const FS_WALK_FILE = fileURLToPath(
  new URL('../../template/base/tools/lib/fs-walk.mjs', import.meta.url),
)
const POSTURE_LINE =
  'validate --ci-parity: CI posture for this run (HARNESS_REQUIRE_TOOLCHAINS=1): a missing prerequisite fails, no stamp is honoured'
const NO_RECORDS_LINE = 'validate --ci-parity: no gate reported a missing prerequisite'

const PARITY_STUBS = {
  // Needs the predicate: red without it, green with it.
  'need.mjs': `import { fail, inCI, ok } from './lib/gate.mjs'
if (!inCI()) fail('need', 'the CI predicate is not set')
ok('need', 'the CI predicate is set')
`,
  // skipOrFail under a given gate name, with an optional delay so a pooled step can
  // finish LATE.
  'skip.mjs': `import { skipOrFail } from './lib/gate.mjs'
const [gate, delay] = process.argv.slice(2)
setTimeout(() => skipOrFail(gate, \`\${gate} prerequisite absent\`), Number(delay ?? 0))
`,
  // A stamped gate over one input file.
  'stamp.mjs': `import { ok, stampGate } from './lib/gate.mjs'
const recordGreen = stampGate('warm', ['input.txt'])
recordGreen()
ok('warm', 'ran the real check')
`,
  // Occupies its report directory's path with a regular file, then skips under a gate
  // name: the record cannot be written, and the runner cannot read the directory.
  'squat.mjs': `import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { skipOrFail } from './lib/gate.mjs'
writeFileSync(process.env.HARNESS_PARITY_REPORT_DIR, 'not a directory\\n')
skipOrFail('squatted', 'squatted prerequisite absent')
`,
  // Reports what the runner put in the step's environment.
  'show-vars.mjs': `import process from 'node:process'
const show = (k) => process.env[k] ?? '<unset>'
process.stdout.write(\`seen HARNESS_REQUIRE_TOOLCHAINS=\${show('HARNESS_REQUIRE_TOOLCHAINS')} HARNESS_PARITY_REPORT_DIR=\${show('HARNESS_PARITY_REPORT_DIR')}\\n\`)
`,
}

/** @param {[string, string][]} steps [name, command] */
function parityConfig(steps) {
  const body = steps.map(([n, c]) => `  ['${n}', '${c}'],`).join('\n')
  return `export const VALIDATE_STEPS = [\n${body}\n]\nexport const STOP_HOOK_STEPS = []\n`
}

/** @param {[string, string][]} steps [name, command] */
function parityFixture(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-validate-parity-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  copyFileSync(GATE_LIB_FILE, join(dir, 'tools/lib/gate.mjs'))
  copyFileSync(FS_WALK_FILE, join(dir, 'tools/lib/fs-walk.mjs'))
  for (const [file, src] of Object.entries(PARITY_STUBS)) writeFileSync(join(dir, 'tools', file), src)
  writeFileSync(join(dir, 'input.txt'), 'v1\n')
  writeFileSync(join(dir, 'tools/harness.config.mjs'), parityConfig(steps))
  return dir
}

/** @param {string} dir @param {string[]} args @param {Record<string, string>} [extra] */
function runParity(dir, args, extra = {}) {
  const res = spawnSync('node', ['tools/validate.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv(extra),
  })
  const stdout = res.stdout ?? ''
  return { code: res.status, out: `${stdout}${res.stderr ?? ''}`, stdout }
}

/** @param {string} out */
const parityLines = (out) =>
  out.split(/\r?\n/).filter((l) => l.startsWith('validate --ci-parity:'))

// Point every variable os.tmpdir() reads at one path (TMPDIR on POSIX, TEMP/TMP on Windows).
/** @param {string} path */
const tmpVars = (path) => ({ TMPDIR: path, TEMP: path, TMP: path })

test('--ci-parity: a step that needs the predicate fails without the flag and passes with it', () => {
  const dir = parityFixture([['need', 'node tools/need.mjs']])
  const without = runParity(dir, [])
  assert.equal(without.code, 1, without.out)
  assert.ok(without.out.includes('need: FAIL — the CI predicate is not set'), without.out)

  const withFlag = runParity(dir, ['--ci-parity'])
  assert.equal(withFlag.code, 0, withFlag.out)
  assert.ok(withFlag.out.includes('need: OK — the CI predicate is set'), withFlag.out)
  // The posture line comes FIRST, before any step header: a runner that predates the flag
  // ignores it silently, so a missing line means the flag was not applied.
  assert.ok(withFlag.stdout.startsWith(`${POSTURE_LINE}\n`), withFlag.stdout)
  assert.deepEqual(parityLines(withFlag.out), [POSTURE_LINE, NO_RECORDS_LINE])
})

test('--ci-parity: a skipOrFail stub skips without the flag, fails with it, and the closing block names step, gate and reason', () => {
  const dir = parityFixture([['db-lane', 'node tools/skip.mjs fake-db']])
  const without = runParity(dir, [])
  assert.equal(without.code, 0, without.out)
  assert.ok(without.out.includes('fake-db: SKIPPED — fake-db prerequisite absent'), without.out)
  assert.deepEqual(parityLines(without.out), [])

  const withFlag = runParity(dir, ['--ci-parity'])
  assert.equal(withFlag.code, 1, withFlag.out)
  assert.ok(withFlag.out.includes('fake-db: FAIL — fake-db prerequisite absent'), withFlag.out)
  assert.deepEqual(parityLines(withFlag.out), [
    POSTURE_LINE,
    'validate --ci-parity: db-lane: fake-db — fake-db prerequisite absent',
  ])
  // The closing block sits after the summary's total line.
  assert.ok(
    withFlag.out.indexOf('validate --ci-parity: db-lane:') > withFlag.out.search(/total \d+ms/),
    withFlag.out,
  )
})

test('--ci-parity: a warm stamp is not honoured under the flag', () => {
  const dir = parityFixture([['warm', 'node tools/stamp.mjs']])
  const cold = runParity(dir, [])
  assert.equal(cold.code, 0, cold.out)
  assert.ok(cold.out.includes('ran the real check'), cold.out)
  const warm = runParity(dir, [])
  assert.ok(warm.out.includes('inputs unchanged'), `precondition: the stamp must be warm: ${warm.out}`)

  const parity = runParity(dir, ['--ci-parity'])
  assert.equal(parity.code, 0, parity.out)
  assert.ok(parity.out.includes('ran the real check'), parity.out)
  assert.ok(!parity.out.includes('inputs unchanged'), parity.out)
})

test('--ci-parity --report-all: two skipOrFail stubs in one pooled batch are listed in STEP order, not finish order', () => {
  // provenance and version-sync are PARALLEL_SAFE, so they share a pooled batch. The first
  // one finishes last (a 400ms delay), so a report read in record order would invert them.
  const dir = parityFixture([
    ['provenance', 'node tools/skip.mjs late-gate 400'],
    ['version-sync', 'node tools/skip.mjs early-gate 0'],
  ])
  const r = runParity(dir, ['--ci-parity', '--report-all'])
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(parityLines(r.out), [
    POSTURE_LINE,
    'validate --ci-parity: provenance: late-gate — late-gate prerequisite absent',
    'validate --ci-parity: version-sync: early-gate — early-gate prerequisite absent',
  ])
})

test('--ci-parity: identical records from one step print once', () => {
  // `||` runs the second child after the first fails, in sh and in cmd alike: two
  // processes, two record files, one record.
  const dir = parityFixture([
    ['twice', 'node tools/skip.mjs same-gate || node tools/skip.mjs same-gate'],
  ])
  const r = runParity(dir, ['--ci-parity'])
  assert.equal(r.code, 1, r.out)
  assert.equal(r.out.split('same-gate: FAIL').length - 1, 2, `both children must fail: ${r.out}`)
  assert.deepEqual(parityLines(r.out), [
    POSTURE_LINE,
    'validate --ci-parity: twice: same-gate — same-gate prerequisite absent',
  ])
})

test('--stop-chain --ci-parity exits 1 before resolving or running any step, with or without --list', () => {
  for (const args of [
    ['--stop-chain', '--ci-parity'],
    ['--stop-chain', '--ci-parity', '--list'],
    ['--ci-parity', '--stop-chain', '--report-all'],
  ]) {
    const dir = stopChainFixture({ config: ['validate'], floor: ['validate', 'test-quality'] })
    const r = runStopChain(dir, args)
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`)
    assert.ok(r.out.includes('reviewer-verdicts'), r.out)
    assert.ok(r.out.includes('no single CI equivalent'), r.out)
    assert.ok(!r.out.includes('mark-'), `no step may be listed: ${r.out}`)
    assert.ok(!existsSync(join(dir, 'ran-validate')), 'no step may run')
    assert.ok(!existsSync(join(dir, 'ran-test-quality')), 'no step may run')
  }
  // It refuses BEFORE resolving: a corrupt floor would otherwise answer first.
  const corrupt = stopChainFixture({ config: ['validate'], floor: [], corruptFloor: '{ not json' })
  const r = runStopChain(corrupt, ['--stop-chain', '--ci-parity'])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('reviewer-verdicts'), r.out)
  assert.ok(!r.out.includes('FAILING CLOSED'), r.out)
})

test('--list --ci-parity prints exactly what --list prints, and runs nothing', () => {
  const dir = parityFixture([
    ['need', 'node tools/need.mjs'],
    ['vars', 'node tools/show-vars.mjs'],
  ])
  const list = runParity(dir, ['--list'])
  const parity = runParity(dir, ['--list', '--ci-parity'])
  assert.equal(list.code, 0, list.out)
  assert.equal(parity.code, 0, parity.out)
  assert.equal(parity.out, list.out)
  assert.ok(!parity.out.includes('seen '), 'nothing runs under --list')
})

test('without --ci-parity nothing changes: no parity line, and a step sees neither variable', () => {
  const dir = parityFixture([['vars', 'node tools/show-vars.mjs']])
  writeFileSync(
    join(dir, 'tools/validate.floor.json'),
    `${JSON.stringify({ steps: [['vars', 'node tools/show-vars.mjs']] })}\n`,
  )
  for (const args of [[], ['--report-all'], ['--min-floor']]) {
    const r = runParity(dir, args)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(parityLines(r.out), [], `${args.join(' ')}: ${r.out}`)
    assert.ok(
      r.out.includes('seen HARNESS_REQUIRE_TOOLCHAINS=<unset> HARNESS_PARITY_REPORT_DIR=<unset>'),
      `${args.join(' ')}: ${r.out}`,
    )
  }
})

test('--ci-parity: a step sees the predicate and its own per-step report directory, outside the project', () => {
  const dir = parityFixture([
    ['need', 'node tools/need.mjs'],
    ['vars', 'node tools/show-vars.mjs'],
  ])
  const r = runParity(dir, ['--ci-parity'])
  assert.equal(r.code, 0, r.out)
  const seen = /seen HARNESS_REQUIRE_TOOLCHAINS=(\S+) HARNESS_PARITY_REPORT_DIR=(\S+)/.exec(r.out)
  assert.ok(seen, r.out)
  assert.equal(seen[1], '1')
  // step index 1 in the resolved list, under a harness-parity- root in the temp dir
  assert.match(seen[2], /harness-parity-[^/\\]+[/\\]1$/, r.out)
  assert.ok(!seen[2].startsWith(dir), `the report must never be written into the project tree: ${seen[2]}`)
})

test('--ci-parity: VALIDATE_TIMINGS stays the last line, under --min-floor and --report-all too', () => {
  const dir = parityFixture([['db-lane', 'node tools/skip.mjs fake-db']])
  writeFileSync(
    join(dir, 'tools/validate.floor.json'),
    `${JSON.stringify({ steps: [['db-lane', 'node tools/skip.mjs fake-db']] })}\n`,
  )
  for (const args of [['--ci-parity'], ['--min-floor', '--ci-parity', '--report-all']]) {
    const r = runParity(dir, args)
    assert.equal(r.code, 1, r.out)
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
    assert.match(lines.at(-1) ?? '', /^VALIDATE_TIMINGS \{/, `${args.join(' ')}: ${r.stdout}`)
    assert.equal(
      lines.at(-2),
      'validate --ci-parity: db-lane: fake-db — fake-db prerequisite absent',
      r.stdout,
    )
  }
})

test('--ci-parity: the report root lives in the temp dir and is removed when the run ends', () => {
  const dir = parityFixture([
    ['db-lane', 'node tools/skip.mjs fake-db'],
    ['need', 'node tools/need.mjs'],
  ])
  const tmp = mkdtempSync(join(tmpdir(), 'epah-parity-tmp-'))
  for (const args of [['--ci-parity'], ['--ci-parity', '--report-all']]) {
    const r = runParity(dir, args, tmpVars(tmp))
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('validate --ci-parity: db-lane: fake-db'), r.out)
    assert.deepEqual(readdirSync(tmp), [], `the report root must be gone after the run: ${r.out}`)
  }
})

test('--ci-parity: a report root that cannot be created keeps the posture and says the report is unavailable', () => {
  const dir = parityFixture([['need', 'node tools/need.mjs']])
  writeFileSync(join(dir, 'not-a-dir'), 'a regular file\n')
  const r = runParity(dir, ['--ci-parity'], tmpVars(join(dir, 'not-a-dir', 'tmp')))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('need: OK — the CI predicate is set'), r.out)
  assert.ok(r.stdout.startsWith(`${POSTURE_LINE}\n`), r.stdout)
  assert.match(r.out, /validate --ci-parity: report unavailable \(.+\)/, r.out)
  assert.ok(!r.out.includes(NO_RECORDS_LINE), r.out)
})

test('--ci-parity: a step directory that cannot be read is named, never reported as "no records"', () => {
  const dir = parityFixture([
    ['squat', 'node tools/squat.mjs'],
    ['need', 'node tools/need.mjs'],
  ])
  const r = runParity(dir, ['--ci-parity', '--report-all'])
  // The verdicts are the gates' alone: squat's CI-posture skip fails, need passes.
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('squatted: FAIL — squatted prerequisite absent'), r.out)
  assert.ok(r.out.includes('✓ need'), r.out)
  const lines = parityLines(r.out)
  assert.equal(lines.length, 2, r.out)
  assert.match(lines[1], /^validate --ci-parity: squat: report unreadable \(.+\)$/)
})
