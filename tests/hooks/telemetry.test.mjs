// THE TELEMETRY LOG (1.0.4, #41): `.harness/telemetry.jsonl`, append-only and never trimmed.
//
// What was missing. The turn ledger records THAT a turn blocked and which gates did it, keeps
// the last 200 rows across every session, and records nothing else: no step durations, no
// in-turn events. A PreToolUse deny left only its JSON on stdout and a PostToolUse block only
// its stderr, so a red fixed inside the same turn left no trace at all. This file proves the
// log that fills the gap, and proves the four properties that make it safe to ship in a patch:
//
//   1. BOOKKEEPING NEVER DECIDES AN OUTCOME. With the log path obstructed, every exit code and
//      every stdout byte is what it was without the log.
//   2. IT IS WRITTEN ONLY INSIDE AN INSTALL. No `.harness/manifest.json` in the working
//      directory, no write and no `.harness/` created: the factory runs the shipped hooks from
//      its own root and with `template/base/` as cwd, and a file written there would ship.
//   3. A FORKED `hookio.mjs` STILL LOADS. `update` parks rather than replaces a forked owned
//      file, so an install can run the new hooks over the 1.0.3 library. Every new export is
//      reached through a namespace import and a guarded call, and the old file simply writes
//      nothing.
//   4. NO GATE READS IT. The allowlist below is empty; a later reader that is not a gate has
//      to be added to it on purpose.
//
// Every case spawns its hook in its OWN mkdtemp directory as cwd, so no case can see another's
// log.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyVerdict } from '../../template/base/tools/lib/reviewer-verdicts.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TEMPLATE = join(REPO, 'template/base')
const LOG = '.harness/telemetry.jsonl'
const TURN_LEDGER = '.harness/turn-outcomes.jsonl'
const RELEASED_103_HOOKIO = readFileSync(
  new URL('../fixtures/released/1.0.3/hookio.mjs.txt', import.meta.url),
  'utf8',
)

/** Same reasoning as hook-contract.test.mjs's LEAKY: a maintainer's shell must not steer a guard. */
const LEAKY = ['HARNESS_ALLOW_SELF_EDIT', 'HARNESS_REQUIRE_TOOLCHAINS', 'GITHUB_BASE_REF', 'CI']
function cleanEnv() {
  const e = { ...process.env }
  for (const k of LEAKY) delete e[k]
  return e
}

// Every fixture directory this file makes, removed when the file finishes: each one holds a
// copy of the hooks and tools/lib, and a shared machine's /tmp is not an archive.
const made = []
/** @param {string} prefix */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/**
 * A rendered install layout: the shipped hooks and agents, the tools/lib the hooks import,
 * an MCP registry with a wildcard readOnly server (hook-contract.test.mjs's MCP fixture), and
 * — unless the case says otherwise — the manifest that marks the directory as an install.
 * @param {{ manifest?: boolean }} [opts]
 */
function install({ manifest = true } = {}) {
  const dir = tempDir('epah-telemetry-')
  cpSync(join(TEMPLATE, '.claude'), join(dir, '.claude'), { recursive: true })
  cpSync(join(TEMPLATE, 'tools/lib'), join(dir, 'tools/lib'), { recursive: true })
  writeFileSync(
    join(dir, 'tools/approved-tools.json'),
    `${JSON.stringify({
      servers: [{ server: 'wide', version: 'x', readOnly: true, reason: 'fixture', tools: ['*'] }],
    })}\n`,
  )
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase/migrations/0000_init.sql'), '-- existing migration\n')
  if (manifest) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), '{"fixture":true}\n')
  }
  return dir
}

/**
 * Give the install a Stop chain. Each step is `node <file>` over a script this writes, so the
 * chain runs on Windows too. The floor mirrors the config, so the union adds nothing.
 * @param {string} dir @param {Array<[string, string]>} steps  [name, script body]
 */
function stopChain(dir, steps) {
  const chain = steps.map(([name, body]) => {
    const file = `step-${name}.mjs`
    writeFileSync(join(dir, file), body)
    return [name, `node ${file}`]
  })
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = ${JSON.stringify(chain)}\n`,
  )
  writeFileSync(join(dir, 'tools/stop.floor.json'), `${JSON.stringify({ comment: 'fixture', steps: chain })}\n`)
}

/**
 * @param {string} dir @param {string} hook @param {unknown} input
 * @param {{ env?: Record<string, string>, launch?: boolean }} [opts]
 */
function runHook(dir, hook, input, { env = {}, launch = false } = {}) {
  const args = launch
    ? [join(dir, '.claude/hooks/launch.mjs'), hook]
    : [join(dir, '.claude/hooks', hook)]
  // process.execPath, not 'node': a case that empties PATH must still start the hook.
  const res = spawnSync(process.execPath, args, {
    cwd: dir,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, ...env },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** @param {string} dir @returns {any[]} */
const readLog = (dir) =>
  existsSync(join(dir, LOG))
    ? readFileSync(join(dir, LOG), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l))
    : []

const IDS = { session_id: 'sess-1', prompt_id: 'prompt-1' }
const TIMINGS = (steps) =>
  `console.log('VALIDATE_TIMINGS ' + ${JSON.stringify(JSON.stringify({ totalMs: 9, notRun: 0, steps }))})\n`

// A green step that prints a SKIPPED layer, a NESTED member's timings line first (which the
// last-line rule must ignore), then its own. A red step that prints the same shapes and exits 1.
const GREEN_TIMED = `console.log('rls: SKIPPED - database unreachable')\n${TIMINGS({ nested: 1 })}${TIMINGS({ format: 3, lint: 4.6 })}`
const RED_TIMED = `console.log('mobile: SKIPPED - no simulator')\n${TIMINGS({ format: 5, types: 7 })}process.exit(1)\n`
const GREEN_PLAIN = 'process.exit(0)\n'
const RED_PLAIN = "console.error('boom')\nprocess.exit(1)\n"

// ── the Stop hook ───────────────────────────────────────────────────────────────

test('Stop: a GREEN run appends one stop-step record per chain step, and validate-gate records from the LAST timings line', () => {
  const dir = install()
  stopChain(dir, [
    ['alpha', GREEN_TIMED],
    ['beta', GREEN_PLAIN],
  ])
  const r = runHook(dir, 'stop-validate-gate.mjs', { stop_hook_active: false, ...IDS })
  assert.equal(r.code, 0, r.stderr)

  const log = readLog(dir)
  const steps = log.filter((x) => x.kind === 'stop-step')
  assert.deepEqual(
    steps.map((s) => [s.step, s.status, s.skips]),
    [
      ['alpha', 'ok', 1],
      ['beta', 'ok', 0],
    ],
  )
  for (const s of steps) {
    assert.equal(s.v, 1)
    assert.ok(Number.isInteger(s.ms) && s.ms >= 0, `ms must be an integer: ${JSON.stringify(s)}`)
    assert.equal(s.session_id, 'sess-1')
    assert.equal(s.prompt_id, 'prompt-1')
    assert.ok(!Number.isNaN(Date.parse(s.at)), s.at)
    assert.deepEqual(Object.keys(s), ['v', 'kind', 'at', 'session_id', 'prompt_id', 'step', 'status', 'ms', 'skips', 'stamps'])
  }
  const gates = log.filter((x) => x.kind === 'validate-gate')
  assert.deepEqual(
    gates.map((g) => [g.step, g.gate, g.ms]),
    [
      ['alpha', 'format', 3],
      ['alpha', 'lint', 5],
    ],
    'only the LAST VALIDATE_TIMINGS line counts — the nested one is a different chain',
  )
  for (const g of gates) {
    assert.deepEqual(Object.keys(g), ['v', 'kind', 'at', 'session_id', 'prompt_id', 'step', 'gate', 'ms'])
  }
})

test('Stop: a RED run records the red step as fail, counts ITS SKIPPED lines too, and keeps its validate-gate records — without changing what the hook prints', () => {
  const dir = install()
  stopChain(dir, [
    ['alpha', RED_TIMED],
    ['beta', GREEN_PLAIN],
  ])
  const r = runHook(dir, 'stop-validate-gate.mjs', { stop_hook_active: false, ...IDS })
  assert.equal(r.code, 2, r.stderr)
  // A red step's SKIPPED line is COUNTED, never PRINTED as a skipped layer: that list is
  // still built from green steps only, exactly as before.
  assert.ok(!r.stderr.includes('Skipped layers'), r.stderr)

  const log = readLog(dir)
  assert.deepEqual(
    log.filter((x) => x.kind === 'stop-step').map((s) => [s.step, s.status, s.skips, Number.isInteger(s.ms)]),
    [
      ['alpha', 'fail', 1, true],
      ['beta', 'ok', 0, true],
    ],
  )
  assert.deepEqual(
    log.filter((x) => x.kind === 'validate-gate').map((g) => [g.step, g.gate, g.ms]),
    [
      ['alpha', 'format', 5],
      ['alpha', 'types', 7],
    ],
  )
})

test('Stop: validate-gate records are read from the FULL output, before spill() elides the middle of a long red one', () => {
  const dir = install()
  // 2000 characters of stdout, then the timings line, then 6000 characters of stderr: the
  // block message keeps a head and a tail, and the timings line is in neither.
  stopChain(dir, [
    [
      'alpha',
      `console.log('y'.repeat(2000))\n${TIMINGS({ format: 2, types: 9 })}process.stderr.write('x'.repeat(6000))\nprocess.exit(1)\n`,
    ],
  ])
  const r = runHook(dir, 'stop-validate-gate.mjs', { ...IDS })
  assert.equal(r.code, 2, r.stderr)
  assert.ok(!r.stderr.includes('VALIDATE_TIMINGS'), 'precondition: the block message elided the timings line')
  assert.deepEqual(
    readLog(dir)
      .filter((x) => x.kind === 'validate-gate')
      .map((g) => [g.gate, g.ms]),
    [
      ['format', 2],
      ['types', 9],
    ],
  )
})

// Stamps (1.0.4, #42): `stamps` counts a step's `<gate>: STAMPED — ` lines, red or green, the
// way `skips` counts SKIPPED ones; a GREEN step whose own line is STAMPED (the rls runner riding
// its stamp) records `stamped`, because nothing in it re-ran. A step whose output merely carries
// member gates' stamps (validate) is still `ok`: it ran the rest.
const STAMP_LINE = (gate) => `console.log(${JSON.stringify(`${gate}: STAMPED — inputs unchanged since last green run (.harness/${gate}.ok; CI always re-runs)`)})\n`

test('Stop: a step riding its own stamp records `stamped`; member stamps are counted in `stamps`, red or green', () => {
  const dir = install()
  stopChain(dir, [
    ['validate', `${STAMP_LINE('e2e')}${STAMP_LINE('build')}console.log('lint: OK')\n`],
    ['rls-isolation', STAMP_LINE('rls-isolation')],
    ['unit', GREEN_PLAIN],
  ])
  assert.equal(runHook(dir, 'stop-validate-gate.mjs', { ...IDS }).code, 0)
  assert.deepEqual(
    readLog(dir)
      .filter((x) => x.kind === 'stop-step')
      .map((s) => [s.step, s.status, s.skips, s.stamps]),
    [
      ['validate', 'ok', 0, 2],
      ['rls-isolation', 'stamped', 0, 1],
      ['unit', 'ok', 0, 0],
    ],
  )

  const red = install()
  stopChain(red, [['validate', `${STAMP_LINE('e2e')}process.exit(1)\n`]])
  assert.equal(runHook(red, 'stop-validate-gate.mjs', { ...IDS }).code, 2)
  assert.deepEqual(
    readLog(red)
      .filter((x) => x.kind === 'stop-step')
      .map((s) => [s.step, s.status, s.stamps]),
    [['validate', 'fail', 1]],
  )
})

test('Stop: a timings line that does not parse yields no validate-gate record', () => {
  const dir = install()
  stopChain(dir, [['alpha', "console.log('VALIDATE_TIMINGS {not json}')\n"]])
  assert.equal(runHook(dir, 'stop-validate-gate.mjs', { ...IDS }).code, 0)
  const log = readLog(dir)
  assert.equal(log.filter((x) => x.kind === 'stop-step').length, 1)
  assert.equal(log.filter((x) => x.kind === 'validate-gate').length, 0)
})

test('Stop: the log is NEVER trimmed — 201 seeded lines survive and the run appends after them, while the turn ledger ends at 200', () => {
  const dir = install()
  stopChain(dir, [['alpha', GREEN_PLAIN]])
  const seeded = Array.from({ length: 201 }, (_, i) => JSON.stringify({ v: 1, kind: 'seed', n: i }))
  writeFileSync(join(dir, LOG), `${seeded.join('\n')}\n`)
  const ledger = Array.from({ length: 201 }, (_, i) =>
    JSON.stringify({ kind: 'green', at: '2026-09-01T00:00:00.000Z', session_id: 's0', prompt_id: `p${i}` }),
  )
  writeFileSync(join(dir, TURN_LEDGER), `${ledger.join('\n')}\n`)

  assert.equal(runHook(dir, 'stop-validate-gate.mjs', { ...IDS }).code, 0)

  const lines = readFileSync(join(dir, LOG), 'utf8').split('\n').filter((l) => l !== '')
  assert.deepEqual(lines.slice(0, 201), seeded, 'every seeded line is kept, in order')
  assert.ok(lines.length > 201, 'the run appended after them')
  assert.equal(JSON.parse(lines.at(-1)).kind, 'stop-step')
  const ledgerLines = readFileSync(join(dir, TURN_LEDGER), 'utf8').split('\n').filter((l) => l !== '')
  assert.equal(ledgerLines.length, 200, 'the turn ledger is still trimmed to KEEP')
})

// ── bookkeeping never decides an outcome ────────────────────────────────────────

test('OBSTRUCTED log (a directory at its path): every exit code and every stdout byte is unchanged', () => {
  const obstruct = (dir) => mkdirSync(join(dir, LOG), { recursive: true })

  const green = install()
  obstruct(green)
  stopChain(green, [['alpha', GREEN_TIMED]])
  const g = runHook(green, 'stop-validate-gate.mjs', { ...IDS })
  assert.equal(g.code, 0, g.stderr)

  const red = install()
  obstruct(red)
  stopChain(red, [['alpha', RED_PLAIN]])
  assert.equal(runHook(red, 'stop-validate-gate.mjs', { ...IDS }).code, 2)

  const deny = { tool_name: 'Write', tool_input: { file_path: 'tools/harness.config.mjs', content: 'x' }, ...IDS }
  const clear = runHook(install(), 'pretool-write-guard.mjs', deny)
  const blocked = install()
  obstruct(blocked)
  const w = runHook(blocked, 'pretool-write-guard.mjs', deny)
  assert.equal(w.code, 0, w.stderr)
  assert.equal(w.stdout, clear.stdout, 'the deny JSON is byte-identical with and without the obstruction')
  assert.match(w.stdout, /"permissionDecision":"deny"/)
  assert.equal(w.stderr, '', 'a failed append prints nothing')

  const src = install()
  obstruct(src)
  const file = join(src, 'apps/server/src/auth.ts')
  mkdirSync(join(src, 'apps/server/src'), { recursive: true })
  writeFileSync(file, 'const claims = await jwtVerify(token, jwks)\n')
  const s = runHook(src, 'posttool-source-check.mjs', { tool_name: 'Edit', tool_input: { file_path: file } })
  assert.equal(s.code, 2, s.stderr)
})

// ── in-turn hook events ─────────────────────────────────────────────────────────

/** @param {string} dir @returns {any} the ONE hook-event this run wrote */
function onlyEvent(dir) {
  const log = readLog(dir)
  assert.equal(log.length, 1, JSON.stringify(log))
  assert.equal(log[0].kind, 'hook-event')
  assert.equal(log[0].v, 1)
  assert.deepEqual(Object.keys(log[0]), ['v', 'kind', 'at', 'session_id', 'prompt_id', 'hook', 'tool', 'rule', 'outcome'])
  return log[0]
}

test('a write deny, a bash deny and an MCP deny each record the rule that fired', () => {
  const write = install()
  const w = runHook(write, 'pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: 'tools/harness.config.mjs', content: 'export const X = 1\n' },
    ...IDS,
  })
  assert.match(w.stdout, /"permissionDecision":"deny"/)
  assert.deepEqual(
    (({ hook, tool, rule, outcome, session_id, prompt_id }) => ({ hook, tool, rule, outcome, session_id, prompt_id }))(onlyEvent(write)),
    { hook: 'pretool-write-guard', tool: 'Write', rule: 'harness-config', outcome: 'deny', ...IDS },
  )

  const bash = install()
  const b = runHook(bash, 'pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' }, ...IDS })
  assert.match(b.stdout, /"permissionDecision":"deny"/)
  const be = onlyEvent(bash)
  assert.deepEqual([be.hook, be.tool, be.rule, be.outcome], ['pretool-bash-guard', 'Bash', 'rm-rf', 'deny'])

  const mcp = install()
  const m = runHook(mcp, 'pretool-mcp-guard.mjs', { tool_name: 'mcp__wide__apply_migration', tool_input: {}, ...IDS })
  assert.match(m.stdout, /"permissionDecision":"deny"/)
  const me = onlyEvent(mcp)
  assert.deepEqual(
    [me.hook, me.tool, me.rule, me.outcome],
    ['pretool-mcp-guard', 'mcp__wide__apply_migration', 'mcp-write-on-readonly', 'deny'],
  )
})

test('inline deny sites record a telemetry LABEL (not a rule id): append-only migrations, an unregistered MCP server', () => {
  const mig = install()
  runHook(mig, 'pretool-write-guard.mjs', {
    tool_name: 'Edit',
    tool_input: { file_path: 'supabase/migrations/0000_init.sql', new_string: 'select 1;' },
  })
  assert.equal(onlyEvent(mig).rule, 'migrations-append-only')

  const mcp = install()
  runHook(mcp, 'pretool-mcp-guard.mjs', { tool_name: 'mcp__nobody__list_things', tool_input: {} })
  assert.equal(onlyEvent(mcp).rule, 'mcp-server-unregistered')
})

test('a source-check block records block/provenance', () => {
  const dir = install()
  const file = join(dir, 'apps/server/src/auth.ts')
  mkdirSync(join(dir, 'apps/server/src'), { recursive: true })
  writeFileSync(file, 'const claims = await jwtVerify(token, jwks)\n')
  const r = runHook(dir, 'posttool-source-check.mjs', { tool_name: 'Edit', tool_input: { file_path: file }, ...IDS })
  assert.equal(r.code, 2, r.stderr)
  const e = onlyEvent(dir)
  assert.deepEqual([e.hook, e.tool, e.rule, e.outcome], ['posttool-source-check', 'Edit', 'provenance', 'block'])
  assert.ok(!readFileSync(join(dir, LOG), 'utf8').includes('auth.ts'), 'no path in the record')
})

test('a SubagentStop bounce records bounce with the verdict SHAPE, and an unparseable payload records unparseable-payload', () => {
  const message = 'looks broadly fine to me'
  const dir = install()
  const r = runHook(dir, 'subagent-verdict.mjs', {
    hook_event_name: 'SubagentStop',
    agent_type: 'security-reviewer',
    last_assistant_message: message,
    ...IDS,
  })
  assert.equal(r.code, 2, r.stderr)
  const e = onlyEvent(dir)
  assert.deepEqual(
    [e.hook, e.tool, e.rule, e.outcome, e.session_id],
    ['subagent-verdict', null, classifyVerdict(message).shape, 'bounce', 'sess-1'],
  )

  const nul = install()
  assert.equal(runHook(nul, 'subagent-verdict.mjs', 'null').code, 2)
  const n = onlyEvent(nul)
  assert.deepEqual([n.rule, n.outcome, n.session_id, n.prompt_id, n.tool], ['unparseable-payload', 'bounce', null, null, null])
})

test('fast-check records warn/biome when `pnpm exec biome` exits non-zero (POSIX: a stub pnpm first on PATH)', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX-only: the stub is a shell script, and installer-unit runs every test on Windows')
    return
  }
  const stubPath = (code) => {
    const bin = tempDir('epah-telemetry-bin-')
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexit ${String(code)}\n`)
    chmodSync(join(bin, 'pnpm'), 0o755)
    return { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  }
  const red = install()
  const file = join(red, 'x.ts')
  writeFileSync(file, 'export const x = 1\n')
  const r = runHook(red, 'posttool-fast-check.mjs', { tool_name: 'Edit', tool_input: { file_path: file }, ...IDS }, { env: stubPath(1) })
  assert.equal(r.code, 0, 'fast-check never blocks')
  const e = onlyEvent(red)
  assert.deepEqual([e.hook, e.tool, e.rule, e.outcome], ['posttool-fast-check', 'Edit', 'biome', 'warn'])

  // A clean biome run is an allowed call: it writes nothing.
  const green = install()
  const gfile = join(green, 'x.ts')
  writeFileSync(gfile, 'export const x = 1\n')
  runHook(green, 'posttool-fast-check.mjs', { tool_input: { file_path: gfile } }, { env: stubPath(0) })
  assert.equal(existsSync(join(green, LOG)), false)

  // A spawn failure (no pnpm on PATH at all) has no exit status: it writes nothing either.
  const none = install()
  const nfile = join(none, 'x.ts')
  writeFileSync(nfile, 'export const x = 1\n')
  const n = runHook(none, 'posttool-fast-check.mjs', { tool_input: { file_path: nfile } }, {
    env: { PATH: tempDir('epah-telemetry-empty-') },
  })
  assert.equal(n.code, 0, n.stderr)
  assert.equal(existsSync(join(none, LOG)), false, 'a spawn failure is not a Biome warning')
})

test('an ALLOWED call writes nothing, from every hook', () => {
  /** @type {Array<[string, object]>} */
  const cases = [
    ['pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls -la' } }],
    ['pretool-write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: 'docs/notes.md', content: 'hello\n' } }],
    ['pretool-mcp-guard.mjs', { tool_name: 'mcp__wide__list_tables', tool_input: {} }],
    ['posttool-source-check.mjs', { tool_name: 'Edit', tool_input: { file_path: 'docs/notes.md' } }],
    ['posttool-fast-check.mjs', { tool_name: 'Edit', tool_input: { file_path: 'docs/notes.md' } }],
    ['subagent-verdict.mjs', { agent_type: 'dal-author', last_assistant_message: 'done' }],
  ]
  for (const [hook, input] of cases) {
    const dir = install()
    const r = runHook(dir, hook, input)
    assert.equal(r.code, 0, `${hook}: ${r.stdout}${r.stderr}`)
    assert.ok(!r.stdout.includes('"deny"'), `${hook} allowed the call`)
    assert.equal(existsSync(join(dir, LOG)), false, `${hook} wrote telemetry for an allowed call`)
  }
})

test('no record carries the payload command or path, and a payload without ids records null for each', () => {
  const bash = install()
  runHook(bash, 'pretool-bash-guard.mjs', { tool_input: { command: 'rm -rf node_modules' } })
  const raw = readFileSync(join(bash, LOG), 'utf8')
  assert.ok(!raw.includes('node_modules') && !raw.includes('rm -rf'), raw)
  const e = onlyEvent(bash)
  assert.deepEqual([e.session_id, e.prompt_id, e.tool], [null, null, null])

  const write = install()
  runHook(write, 'pretool-write-guard.mjs', {
    tool_name: 'Write',
    session_id: 42,
    tool_input: { file_path: 'tools/harness.config.mjs', content: 'SECRET-CONTENT' },
  })
  const wraw = readFileSync(join(write, LOG), 'utf8')
  assert.ok(!wraw.includes('harness.config') && !wraw.includes('SECRET-CONTENT'), wraw)
  assert.equal(onlyEvent(write).session_id, null, 'a non-string id is not copied')
})

// ── outside an install ──────────────────────────────────────────────────────────

test('WITHOUT .harness/manifest.json a bash deny and a source-check block behave as today and create no .harness/', () => {
  const dir = install({ manifest: false })
  const b = runHook(dir, 'pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } })
  assert.equal(b.code, 0)
  assert.match(b.stdout, /"permissionDecision":"deny"/)

  const file = join(dir, 'apps/server/src/auth.ts')
  mkdirSync(join(dir, 'apps/server/src'), { recursive: true })
  writeFileSync(file, 'const claims = await jwtVerify(token, jwks)\n')
  assert.equal(runHook(dir, 'posttool-source-check.mjs', { tool_input: { file_path: file } }).code, 2)

  assert.equal(existsSync(join(dir, '.harness')), false, 'no .harness/ outside an install')
})

// ── the fork case ───────────────────────────────────────────────────────────────

test('FORK: over the 1.0.3 hookio.mjs every changed hook still loads, denies and gates as before, and no telemetry is written', () => {
  const table = JSON.parse(readFileSync(join(REPO, 'template/shas/1.0.3.json'), 'utf8'))
  const sha = createHash('sha256').update(RELEASED_103_HOOKIO).digest('hex')
  assert.ok(
    table.files['.claude/hooks/lib/hookio.mjs'].some((v) => v.sha256 === sha),
    'fixture precondition: the committed file is what template/shas/1.0.3.json says v1.0.3 shipped',
  )
  const forked = () => {
    const dir = install()
    writeFileSync(join(dir, '.claude/hooks/lib/hookio.mjs'), RELEASED_103_HOOKIO)
    return dir
  }

  // Every changed hook LOADS: through the launcher, a load failure would be exit 2 with
  // "FAILED TO LOAD". Each gets an allowed payload, so exit 0 is the only right answer.
  const dir = forked()
  stopChain(dir, [['alpha', GREEN_TIMED]])
  /** @type {Array<[string, object]>} */
  const allowed = [
    ['pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
    ['pretool-write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: 'docs/notes.md', content: 'x' } }],
    ['pretool-mcp-guard.mjs', { tool_name: 'mcp__wide__list_tables', tool_input: {} }],
    ['posttool-source-check.mjs', { tool_input: { file_path: 'docs/notes.md' } }],
    ['posttool-fast-check.mjs', { tool_input: { file_path: 'docs/notes.md' } }],
    ['subagent-verdict.mjs', { agent_type: 'dal-author', last_assistant_message: 'done' }],
    ['stop-validate-gate.mjs', { ...IDS }],
  ]
  for (const [hook, input] of allowed) {
    const r = runHook(dir, hook, input, { launch: true })
    assert.equal(r.code, 0, `${hook} over the forked hookio: ${r.stdout}${r.stderr}`)
  }

  const w = runHook(dir, 'pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: 'tools/harness.config.mjs', content: 'x' },
  }, { launch: true })
  assert.equal(w.code, 0, w.stderr)
  assert.match(w.stdout, /"permissionDecision":"deny"/)

  const red = forked()
  stopChain(red, [['alpha', RED_PLAIN]])
  assert.equal(runHook(red, 'stop-validate-gate.mjs', { ...IDS }, { launch: true }).code, 2)

  for (const d of [dir, red]) assert.equal(existsSync(join(d, LOG)), false, 'the 1.0.3 hookio writes no telemetry')
})

// ── no gate reads the log ───────────────────────────────────────────────────────

/**
 * Files under a gate tree that may name the log. EMPTY in 1.0.4: nothing reads it. A later
 * reader that is not a gate (a status command, say) is added here on purpose, with a reason.
 * @type {string[]}
 */
const TELEMETRY_READERS = []

/** @param {string} root @returns {string[]} */
function walk(root) {
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

test('NO GATE READS THE LOG: no file under template/base/tools/ or template/modules/*/tools/ names telemetry.jsonl', () => {
  const roots = [join(TEMPLATE, 'tools')]
  for (const m of readdirSync(join(REPO, 'template/modules'))) roots.push(join(REPO, 'template/modules', m, 'tools'))
  const hits = []
  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = relative(REPO, file).replaceAll('\\', '/')
      if (TELEMETRY_READERS.includes(rel)) continue
      if (readFileSync(file, 'utf8').includes('telemetry.jsonl')) hits.push(rel)
    }
  }
  assert.ok(roots.length > 1, 'the module tool trees were walked too')
  assert.deepEqual(hits, [], `a gate names the telemetry log: ${hits.join(', ')}`)
})
