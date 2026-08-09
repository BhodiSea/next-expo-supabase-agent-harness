// Behavioral tests for template/base/tools/validate.mjs: default first-failure
// stop vs --report-all (the Stop hook path must surface EVERY red at once),
// per-step elapsed-ms in the summary, and the --report-all concurrency pool
// (canonical-order buffered output, failure aggregation, exclusive non-pooled steps).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
