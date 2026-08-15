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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Static relative specifiers, deliberately (0.8.0): the computed file:// dynamic
// imports these replaced were opaque to `knip --strict` and carried a Windows
// workaround a static specifier does not need (check-query-shapes precedent).
import * as guardRules from '../../template/base/.claude/hooks/lib/guard-rules.mjs'
import * as config from '../../template/base/tools/harness.config.mjs'

const CHECKER = fileURLToPath(new URL('../../scripts/check-canary-coverage.mjs', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url))
const REGISTRY = fileURLToPath(new URL('../canary/injections.json', import.meta.url))

const realRegistry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const stepNames = [...config.VALIDATE_STEPS, ...config.STOP_HOOK_STEPS].map(([name]) => name)

// The same job-id parse the checker itself performs — over ALL EIGHT shipped workflows
// since 0.3.0, not just the merge gate. The single hardcoded filename is what made codeql,
// gitleaks, osv-scan, actions-lint, adr-guard, migration-safety and mutation invisible to
// the lane closure: seven blocking lanes a reviewer reads as enforcement, none of which had
// to carry a red-proof.
const WORKFLOW_DIR = join(ROOT_DIR, 'template/base/github/workflows')
const jobIds = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .flatMap((f) => {
    const text = readFileSync(join(WORKFLOW_DIR, f), 'utf8')
    const at = text.indexOf('\njobs:')
    return at === -1 ? [] : [...text.slice(at).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
  })

// The FACTORY universes (0.7.0), derived the same way the checker derives them. The gate
// scripts: every scripts/check-*.mjs plus hygiene.mjs and generate-floor.mjs. The hook
// members: the STEPS/TOOLCHAIN_STEPS tables of .claude/hooks/stop-factory-gate.mjs, PARSED
// rather than imported — the hook executes on import (top-level readHookInput() + the gate
// spawns), so a text parse is the only honest mechanism. A hook step invoking a
// scripts/*.mjs identifies with that script member; a toolchain step (eslint, tests, …)
// stands alone under its own name.
function parseFactoryHookMembers(src) {
  const members = []
  for (const table of ['STEPS', 'TOOLCHAIN_STEPS']) {
    const open = src.indexOf(`const ${table} = [`)
    const close = src.indexOf('\n]', open)
    assert.notEqual(open, -1, `stop-factory-gate.mjs lost its ${table} table`)
    for (const m of src.slice(open, close).matchAll(/\[\s*'([a-z][a-z0-9-]+)',\s*\[([^\]]*)\]/g)) {
      const script = /scripts\/([A-Za-z0-9._-]+\.mjs)/.exec(m[2])
      members.push(script === null ? m[1] : script[1])
    }
  }
  return members
}
const factoryGateMembers = [
  ...new Set([
    ...readdirSync(join(ROOT_DIR, 'scripts'))
      .filter((f) => /^check-[a-z0-9-]+\.mjs$/.test(f) || f === 'hygiene.mjs' || f === 'generate-floor.mjs')
      .sort(),
    ...parseFactoryHookMembers(
      readFileSync(join(ROOT_DIR, '.claude/hooks/stop-factory-gate.mjs'), 'utf8'),
    ),
  ]),
]
// The factory's own workflows, keyed '<file>#<job>' — never bare ids, because the consumer
// lanes registry above already claims 'actionlint' and 'zizmor'.
const factoryJobKeys = readdirSync(join(ROOT_DIR, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .flatMap((f) => {
    const text = readFileSync(join(ROOT_DIR, '.github/workflows', f), 'utf8')
    const at = text.indexOf('\njobs:')
    return at === -1
      ? []
      : [...text.slice(at).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => `${f}#${m[1]}`)
  })

// The same table list the checker itself walks — kept in lockstep by hand, and the
// LIVE LOCKSTEP test below reds if a table exists in guard-rules but is missing here.
const RULE_TABLES = [
  'BASH_RULES',
  'WRITE_PROTECTED',
  'WRITE_GLOBAL_CHECKS',
  'WRITE_SQL_CHECKS',
  'WRITE_CONFIG_CHECKS',
  'MCP_RULES',
]
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
    factoryGates: Object.fromEntries(
      factoryGateMembers.map((m) => [m, [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }]]),
    ),
    factoryLanes: Object.fromEntries(
      factoryJobKeys.map((k) => [k, [{ kind: 'steps', note: 'fixture note' }]]),
    ),
    hookRules: greenHookRules(),
  }
}

// A fully-synthetic factory universe: a scripts dir, a hook file carrying the two step
// tables, and a workflows dir — everything the three factory positional overrides accept.
const SYNTHETIC_HOOK = `const STEPS = [
  ['alpha', ['scripts/check-alpha.mjs']],
]
const TOOLCHAIN_STEPS = [
  ['fmt', ['exec', 'fmt', '.']],
]
`
function factoryFixture({ scripts = ['check-alpha.mjs'], workflows = { 'ci.yml': ['build'] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-cancov-factory-'))
  const scriptsDir = join(dir, 'scripts')
  mkdirSync(scriptsDir)
  for (const name of scripts) writeFileSync(join(scriptsDir, name), '// synthetic gate\n')
  const hookPath = join(dir, 'stop-factory-gate.mjs')
  writeFileSync(hookPath, SYNTHETIC_HOOK)
  const workflowsDir = join(dir, 'workflows')
  mkdirSync(workflowsDir)
  for (const [file, jobs] of Object.entries(workflows)) {
    writeFileSync(
      join(workflowsDir, file),
      `name: x\non: push\njobs:\n${jobs.map((j) => `  ${j}:\n    runs-on: ubuntu-latest\n    steps: []\n`).join('')}`,
    )
  }
  return { scriptsDir, hookPath, workflowsDir }
}
/** Registry factory sections covering exactly the SYNTHETIC universe above. */
function syntheticFactorySections() {
  return {
    factoryGates: {
      'check-alpha.mjs': [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }],
      fmt: [{ kind: 'lane', ref: 'ci.yml#build', note: 'synthetic' }],
    },
    factoryLanes: { 'ci.yml#build': [{ kind: 'steps', note: 'synthetic note' }] },
  }
}

/**
 * Run the checker via its positional overrides. Defaults to --no-spawn: these tests
 * exercise the STATIC lockstep, and spawning would recurse — the suite is already running
 * proof files the checker would spawn. The spawn cases opt in to prove the G28 execution
 * path itself reds/greens.
 *
 * `hooksDir` (0.11.0) becomes the --hooks-dir= flag. The hook -> registry direction walks a
 * DIRECTORY, so a fixture must present its own or it is judged against the real seven
 * shipped hooks, which no synthetic registry covers. A flag rather than a positional so a
 * case needing only a hook universe does not have to supply the factory paths first.
 * @param {string} registryPath @param {string} hookContractPath
 * @param {{ spawn?: boolean, factory?: { scriptsDir: string, hookPath: string, workflowsDir: string }, hooksDir?: string }} [opts]
 */
function run(registryPath, hookContractPath, { spawn = false, factory, hooksDir = GREEN_HOOKS_DIR } = {}) {
  const args = [registryPath, hookContractPath]
  if (factory !== undefined) args.push(factory.scriptsDir, factory.hookPath, factory.workflowsDir)
  if (hooksDir !== undefined) args.push(`--hooks-dir=${hooksDir}`)
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

/**
 * A synthetic hook universe: one .mjs per name, each carrying `count` denyTool( sites so the
 * call-site pin has something real to count. Returns the directory.
 */
function hookDir(hooks) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-cancov-hooks-'))
  for (const [name, count] of Object.entries(hooks)) {
    writeFileSync(join(dir, name), `${'denyTool(1)\n'.repeat(count)}export const x = 1\n`)
  }
  return dir
}

// The synthetic hook universe every fixture is judged against (0.11.0). Two shapes, because
// the closure admits exactly two: a deny-shaped hook with a pinned denyTool( call-site count,
// and one exempted by a reasoned {kind:'steps'} declaration. Fixtures must never be judged
// against the REAL seven shipped hooks — no synthetic registry covers them, and a test that
// reds for that reason is testing the wrong thing.
const GREEN_HOOKS = { 'guard-alpha.mjs': 2, 'guard-beta.mjs': 0 }
const GREEN_HOOKS_DIR = hookDir(GREEN_HOOKS)
const greenHookRules = () => ({
  'guard-alpha.mjs': { denyToolCallSites: 2, denyExamples: [] },
  'guard-beta.mjs': { kind: 'steps', note: 'fixture exemption note naming what already proves it' },
})

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
    'tests/canary/injections.json#lanes must equal the jobs of EVERY shipped workflow, bidirectionally',
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

test('LIVE LOCKSTEP (static): the shipped registry closes over the factory gates and factory lanes', () => {
  // The 0.7.0 closure: the gates that guard the guards, and the factory's own CI lanes,
  // were the last enforcement surfaces with no falsifiability ledger — 'hygiene had none'.
  assert.ok(factoryGateMembers.length > 0 && factoryJobKeys.length > 0)
  assert.deepEqual(
    [...Object.keys(realRegistry.factoryGates ?? {})].sort(),
    [...factoryGateMembers].sort(),
    'tests/canary/injections.json#factoryGates must equal the scripts/check-*.mjs ∪ hygiene.mjs ∪ generate-floor.mjs ∪ stop-factory-gate step universe, bidirectionally',
  )
  assert.deepEqual(
    [...Object.keys(realRegistry.factoryLanes ?? {})].sort(),
    [...factoryJobKeys].sort(),
    "tests/canary/injections.json#factoryLanes must equal every '<file>#<job>' of the factory's own .github/workflows, bidirectionally",
  )
  for (const proofs of Object.values(realRegistry.factoryGates ?? {})) {
    for (const proof of proofs) {
      assert.ok(['fixture', 'lane'].includes(proof.kind), JSON.stringify(proof))
      if (proof.kind === 'lane') {
        assert.ok(
          factoryJobKeys.includes(proof.ref),
          `factoryGates lane declaration ${proof.ref} names no real factory workflow job`,
        )
      }
    }
  }
  for (const proofs of Object.values(realRegistry.factoryLanes ?? {})) {
    for (const proof of proofs) assert.ok(['fixture', 'steps'].includes(proof.kind), JSON.stringify(proof))
  }
})

test('GREEN: a synthetic factory universe fully covered by the registry is CLEAN', () => {
  const reg = { ...greenRegistry(), ...syntheticFactorySections() }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath, { factory: factoryFixture() })
  assert.equal(r.code, 0, r.out)
})

test('RED: a factory gate script with no factoryGates entry fails, naming the gate', () => {
  const reg = { ...greenRegistry(), ...syntheticFactorySections() }
  const { registryPath, contractPath } = fixture(reg)
  const factory = factoryFixture({ scripts: ['check-alpha.mjs', 'check-new-gate.mjs'] })
  const r = run(registryPath, contractPath, { factory })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("factory gate 'check-new-gate.mjs'"), r.out)
  assert.ok(r.out.includes('NO red-proof'), r.out)
})

test('RED: a stale factoryGates entry naming a vanished gate fails', () => {
  const reg = { ...greenRegistry(), ...syntheticFactorySections() }
  reg.factoryGates['check-vanished.mjs'] = [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }]
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath, { factory: factoryFixture() })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("factoryGates registry covers 'check-vanished.mjs'"), r.out)
  assert.ok(r.out.includes('stale entry'), r.out)
})

test('RED: a factory workflow job with no factoryLanes entry fails, keyed <file>#<job>', () => {
  const reg = { ...greenRegistry(), ...syntheticFactorySections() }
  const { registryPath, contractPath } = fixture(reg)
  const factory = factoryFixture({ workflows: { 'ci.yml': ['build', 'deploy'] } })
  const r = run(registryPath, contractPath, { factory })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("factory workflow job 'ci.yml#deploy'"), r.out)
})

test("RED: a bare-id factoryLanes key is rejected — '<file>#<job>' keying is mandatory", () => {
  // A bare id would silently share one proof across two workflows: the consumer lanes
  // registry already claims 'actionlint' and 'zizmor', so the factory copy of either
  // would be covered by a proof written for the template's workflow.
  const reg = { ...greenRegistry(), ...syntheticFactorySections() }
  reg.factoryLanes.build = [{ kind: 'steps', note: 'a bare id' }]
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath, { factory: factoryFixture() })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("factoryLanes key 'build' is a bare job id"), r.out)
})

test('RED: a factoryGates lane declaration naming a nonexistent workflow job fails', () => {
  const reg = { ...greenRegistry(), ...syntheticFactorySections() }
  reg.factoryGates.fmt = [{ kind: 'lane', ref: 'ci.yml#no-such-job', note: 'dangling' }]
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath, { factory: factoryFixture() })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("factory gate 'fmt': lane declaration \"ci.yml#no-such-job\""), r.out)
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
    ...greenHookRules(),
    'guard-alpha.mjs': { denyToolCallSites: 2, denyExamples: ['this command has no deny test'] },
  }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not found in tests/hooks/hook-contract.test.mjs'), r.out)
})

test('RED: a drifted denyTool( call-site count pins the path-scoped in-hook checks', () => {
  const reg = greenRegistry()
  reg.hookRules = {
    ...greenHookRules(),
    'guard-alpha.mjs': { denyToolCallSites: 999, denyExamples: [] },
  }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /guard-alpha\.mjs: \d+ denyTool\( call sites but the registry pins 999/, r.out)
})

// ── the hook -> registry direction (0.11.0) ──────────────────────────────────────────
// Every loop above iterates the REGISTRY, so through 0.10.0 a hook with no entry was
// required by nothing — no deny example, no call-site pin, no proof — and nothing noticed.
// Measured then: seven hooks shipped, three were named, and the four uncovered included the
// TURN-FATAL stop-validate-gate.mjs.

test('RED (hook closure): a shipped hook with NO registry entry reds, naming the file', () => {
  const reg = greenRegistry()
  const dir = hookDir({ ...GREEN_HOOKS, 'guard-unregistered.mjs': 1 })
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath, { hooksDir: dir })
  assert.equal(r.code, 1, `an unregistered hook must red:\n${r.out}`)
  assert.ok(r.out.includes("hook 'guard-unregistered.mjs'"), r.out)
  assert.ok(r.out.includes('NO entry'), r.out)
})

test('RED (hook closure): a STALE entry naming a deleted hook is a FINDING, not an ENOENT crash', () => {
  // The inverse direction, and its old failure mode was worse than absence: the entry reached
  // an uncaught readFileSync, so the gate died with a stack trace instead of reporting. A
  // crash is the one outcome a reader cannot tell from infrastructure trouble, so this asserts
  // the MESSAGE SHAPE — exit code alone cannot distinguish a crash from a finding.
  const reg = greenRegistry()
  reg.hookRules = { ...greenHookRules(), 'guard-deleted.mjs': { denyToolCallSites: 1, denyExamples: [] } }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("hookRules registry covers 'guard-deleted.mjs'"), r.out)
  assert.ok(r.out.includes('stale entry'), r.out)
  assert.ok(!r.out.includes('ENOENT'), `a stale entry must not surface as a crash:\n${r.out}`)
  assert.ok(!r.out.includes('at Object.readFileSync'), `no stack trace:\n${r.out}`)
})

test('RED (hook closure): a note-less {kind:"steps"} exemption is a silent skip wearing an entry', () => {
  const reg = greenRegistry()
  reg.hookRules = { ...greenHookRules(), 'guard-beta.mjs': { kind: 'steps' } }
  const { registryPath, contractPath } = fixture(reg)
  const r = run(registryPath, contractPath)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("hook 'guard-beta.mjs'"), r.out)
  assert.ok(r.out.includes('non-empty note'), r.out)
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
