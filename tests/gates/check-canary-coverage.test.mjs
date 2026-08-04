// The canary-coverage checker must itself be falsifiable: red when a step loses
// its proof, a hook grows an untested rule, or a CI lane loses its red-proof.
//
// PORT NOTE (W5b): the source harness's headline case spawned the checker with NO
// overrides and asserted the live tree green. Here that live spawned-green run
// belongs to the machinery CI lane (which runs the checker itself over the real
// registry once the whole W5 test wave is on disk) — this suite was authored
// while sibling W5 workstreams were still landing registry-referenced fixture
// files, so it pins the live half STATICALLY (the registry's step/lane closure
// against the real harness.config.mjs + quality-gate.yml, in-process) and drives
// every behavioral case through the checker's two positional overrides (fixture
// registry path + fixture hook-contract path), --no-spawn where the SRC suite
// used it. That keeps the suite hermetic: it can never flake on wave ordering,
// and it still proves every red/green the checker owns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECKER = fileURLToPath(new URL('../../scripts/check-canary-coverage.mjs', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url))
const REGISTRY = fileURLToPath(new URL('../canary/injections.json', import.meta.url))

const realRegistry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const config = await import(
  pathToFileURL(join(ROOT_DIR, 'template/base/tools/harness.config.mjs')).href
)
const stepNames = [...config.VALIDATE_STEPS, ...config.STOP_HOOK_STEPS].map(([name]) => name)

// The same job-id parse the checker itself performs over the shipped workflow.
const qgText = readFileSync(join(ROOT_DIR, 'template/base/github/workflows/quality-gate.yml'), 'utf8')
const jobsAt = qgText.indexOf('\njobs:')
const jobIds = [...qgText.slice(jobsAt).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])

const guardRules = await import(
  pathToFileURL(join(ROOT_DIR, 'template/base/.claude/hooks/lib/guard-rules.mjs')).href
)
// The same table list the checker itself walks — kept in lockstep by hand, and the
// LIVE LOCKSTEP test below reds if a table exists in guard-rules but is missing here.
const RULE_TABLES = ['BASH_RULES', 'WRITE_PROTECTED', 'WRITE_GLOBAL_CHECKS', 'WRITE_SQL_CHECKS']
const ruleIds = RULE_TABLES.flatMap((t) => guardRules[t].map((r) => r.id))

// A hook-contract stand-in carrying every rule id as a quoted literal (what the
// per-rule closure greps for); tests strip ids from it to force reds.
const CONTRACT_TEXT = `${ruleIds.map((id) => `'${id}'`).join('\n')}\n`

// A green fixture registry: every real step and every real quality-gate job
// carries a proof. The fixture-proof ref only needs to EXIST for the static
// path — the spawn cases below build their own registries.
function greenRegistry() {
  return {
    steps: Object.fromEntries(
      stepNames.map((n) => [n, [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }]]),
    ),
    lanes: Object.fromEntries(jobIds.map((j) => [j, [{ kind: 'steps', note: 'fixture note' }]])),
  }
}

/**
 * Run the checker via its two positional overrides. Defaults to --no-spawn: these tests
 * exercise the STATIC lockstep, and spawning would recurse — the suite is already running
 * proof files the checker would spawn. The spawn cases opt in to prove the G28 execution
 * path itself reds/greens.
 * @param {string} registryPath @param {string} hookContractPath @param {{ spawn?: boolean }} [opts]
 */
function run(registryPath, hookContractPath, { spawn = false } = {}) {
  const args = [registryPath, hookContractPath]
  if (!spawn) args.push('--no-spawn')
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  const res = spawnSync('node', [CHECKER, ...args], { encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** Write a registry (+ contract) into a fresh tmp dir; returns their paths. */
function fixture(registry, contract = CONTRACT_TEXT) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-cancov-'))
  const registryPath = join(dir, 'registry.json')
  const contractPath = join(dir, 'hook-contract.test.mjs')
  writeFileSync(registryPath, JSON.stringify(registry))
  writeFileSync(contractPath, contract)
  return { registryPath, contractPath }
}

test('LIVE LOCKSTEP (static): RULE_TABLES names every rule table guard-rules.mjs exports', () => {
  // Both this file and scripts/check-canary-coverage.mjs carry the table list. A new
  // table added to guard-rules.mjs and to the checker but NOT here would silently
  // stop being covered by the per-rule closure tests below — the ids would simply
  // never appear in CONTRACT_TEXT, and every assertion would still pass.
  const exported = Object.entries(guardRules)
    .filter(([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0]?.id === 'string')
    .map(([k]) => k)
  assert.deepEqual(
    [...exported].sort(),
    [...RULE_TABLES].sort(),
    'guard-rules.mjs exports a rule table this test does not know about — add it to RULE_TABLES here AND to ruleTables in scripts/check-canary-coverage.mjs',
  )
})

test('LIVE LOCKSTEP (static): the shipped registry covers exactly the real steps and quality-gate jobs', () => {
  assert.ok(stepNames.length > 0 && jobIds.length > 0)
  assert.deepEqual(
    [...Object.keys(realRegistry.steps)].sort(),
    [...stepNames].sort(),
    'tests/canary/injections.json#steps must equal VALIDATE_STEPS ∪ STOP_HOOK_STEPS, bidirectionally',
  )
  assert.deepEqual(
    [...Object.keys(realRegistry.lanes)].sort(),
    [...jobIds].sort(),
    'tests/canary/injections.json#lanes must equal the quality-gate.yml jobs, bidirectionally',
  )
  // Every registered proof kind is one the checker knows.
  for (const proofs of [...Object.values(realRegistry.steps), ...Object.values(realRegistry.lanes)]) {
    for (const proof of proofs) {
      assert.ok(['fixture', 'runner', 'selftest', 'steps'].includes(proof.kind), JSON.stringify(proof))
    }
  }
})

test('GREEN: a registry covering every step and lane, with every rule id canaried, is CLEAN', () => {
  const { registryPath, contractPath } = fixture(greenRegistry())
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('CANARY COVERAGE: CLEAN'), r.out)
  assert.ok(r.out.includes('each carry a red-proof'), r.out)
  assert.ok(r.out.includes('existence-checked only (--no-spawn)'), r.out)
})

test('RED: a missing step proof or a stale registry entry fails', () => {
  const missing = greenRegistry()
  delete missing.steps.styleguide
  const missingFx = fixture(missing)
  const m = run(missingFx.registryPath, missingFx.contractPath)
  assert.equal(m.code, 1, m.out)
  assert.ok(m.out.includes("step 'styleguide' has NO red-proof"), m.out)

  const stale = greenRegistry()
  stale.steps['no-such-gate'] = [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }]
  const { registryPath, contractPath } = fixture(stale)
  const s = run(registryPath, contractPath)
  assert.equal(s.code, 1, s.out)
  assert.ok(s.out.includes("registry covers 'no-such-gate'"), s.out)
  assert.ok(s.out.includes('stale entry'), s.out)
})

test('RED: a proof reference that does not exist on disk fails naming step and ref', () => {
  const reg = greenRegistry()
  reg.steps.styleguide = [{ kind: 'fixture', ref: 'tests/gates/does-not-exist.test.mjs' }]
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("step 'styleguide': fixture proof tests/gates/does-not-exist.test.mjs does not exist"), r.out)
})

test('RED: a CI lane with no red-proof, and a stale lane entry, both fail (the lanes closure)', () => {
  const noLane = greenRegistry()
  delete noLane.lanes.mutation
  const { registryPath: p1, contractPath: c1 } = fixture(noLane)
  const r1 = run(p1, c1)
  assert.equal(r1.code, 1, r1.out)
  assert.ok(r1.out.includes("quality-gate.yml job 'mutation' has NO red-proof"), r1.out)

  const staleLane = greenRegistry()
  staleLane.lanes['no-such-lane'] = [{ kind: 'steps', note: 'x' }]
  const { registryPath: p2, contractPath: c2 } = fixture(staleLane)
  const r2 = run(p2, c2)
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes("lanes registry covers 'no-such-lane'"), r2.out)
})

test('RED: a guard rule id with no behavioral canary fails, naming the rule', () => {
  // Strip one REAL rule id from the contract stand-in — the per-rule closure
  // must red and name exactly that id.
  assert.ok(ruleIds.includes('rm-rf'), `expected the rm-rf guard rule, got: ${ruleIds.join(', ')}`)
  const { registryPath, contractPath } = fixture(
    greenRegistry(),
    CONTRACT_TEXT.replaceAll("'rm-rf'", "'rm-XX'"),
  )
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("guard rule id 'rm-rf'"), r.out)
})

test('RED: a registry denyExample absent from the hook-contract fails', () => {
  const reg = greenRegistry()
  reg.hookRules = {
    'pretool-bash-guard.mjs': { denyExamples: ['this command has no deny test'] },
  }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not found in tests/hooks/hook-contract.test.mjs'), r.out)
})

test('RED: a drifted denyTool( call-site count pins the path-scoped in-hook checks', () => {
  const reg = greenRegistry()
  reg.hookRules = {
    'pretool-bash-guard.mjs': { denyToolCallSites: 999, denyExamples: [] },
  }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /pretool-bash-guard\.mjs: \d+ denyTool\( call sites but the registry pins 999/, r.out)
})

test('RED (spawn, G28): a proof that RUNS but declares zero tests fails — empty is not a proof', () => {
  // The value spawning adds over existsSync: a fixture could exist, run green, and be EMPTY
  // (tests deleted or all commented out). A minimal registry keeps this to a single spawn — the
  // proof points at a real library module (scripts/lib/complexity.mjs) that has no `node --test`
  // tests. Other closure gaps in the minimal registry are noise; we assert the spawn verdict.
  // The checker strips NODE_TEST_* from its child env, so this reds identically standalone and
  // under `node --test` — which running it as part of this suite exercises.
  const bad = { steps: { styleguide: [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }] } }
  const { registryPath, contractPath } = fixture(bad)
  const r = run(registryPath, contractPath, { spawn: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('declares ZERO tests'), r.out)
})

test('GREEN (spawn, G28): a real proof whose test is TITLED after a .mjs file is NOT falsely called empty', () => {
  // Regression guard against a false-RED: the emptiness signal must match the EXACT proof ref
  // (which has a directory), not any `ok N - <something>.mjs` line — node renders
  // `test('check-route-manifest.mjs', ...)` as exactly that, and titling a test after the file
  // it exercises is idiomatic in this repo.
  const titledRel = 'tests/gates/.tmp-titled-proof.test.mjs'
  writeFileSync(
    join(ROOT_DIR, titledRel),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n" +
      "test('check-route-manifest.mjs', () => assert.equal(1, 1))\ntest('second', () => assert.equal(2, 2))\n",
  )
  try {
    const reg = { steps: { styleguide: [{ kind: 'fixture', ref: titledRel }] } }
    const { registryPath, contractPath } = fixture(reg)
    const r = run(registryPath, contractPath, { spawn: true })
    // Other closure gaps are expected noise; the point is this proof is NOT called empty.
    assert.ok(!r.out.includes(`${titledRel} runs but declares ZERO tests`), r.out)
  } finally {
    rmSync(join(ROOT_DIR, titledRel), { force: true })
  }
})

test('RED (spawn, G28): a proof BROKEN so it fails when run reds, naming the proof', () => {
  // The other spawn verdict: a proof the gate-under-test's refactor has broken now fails at
  // runtime. Write a throwaway failing test file under the repo (so its ref resolves under
  // ROOT), then assert the checker surfaces "FAILS when run".
  const brokenRel = 'tests/gates/.tmp-broken-proof.test.mjs'
  writeFileSync(
    join(ROOT_DIR, brokenRel),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('deliberately fails', () => assert.equal(1, 2))\n",
  )
  try {
    const bad = { steps: { styleguide: [{ kind: 'fixture', ref: brokenRel }] } }
    const { registryPath, contractPath } = fixture(bad)
    const r = run(registryPath, contractPath, { spawn: true })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('FAILS when run'), r.out)
  } finally {
    rmSync(join(ROOT_DIR, brokenRel), { force: true })
  }
})
