// The rls runner stamps its own step (1.0.4, #42), and runs on the workspace Supabase CLI
// with the stack's own database URL (1.0.4, #43).
//
// THE STAMP (#42). `rls-isolation` is a Stop step, not a validate gate, so through 1.0.3
// nothing stamped it: with the local stack up, every turn end ran the pgTAP suite and the
// supabase-js suite, even when nothing either suite reads had changed. The runner now rides a
// stamp the way the gates do, with two things no file carries mixed into the digest as a
// salt: the `supabase --version` output (a CLI float has changed this suite's verdict on an
// unchanged tree before) and the running database's identity, its server start time plus its
// applied migration versions. A reset, a restart or a migration applied from the command line
// edits no file, and each must re-run both suites.
//
// WHICH CLI, WHICH DATABASE (#43). Through 1.0.3 the runner spawned a bare `supabase`. The
// Stop hook starts it with plain `node` and passes the session's PATH through, so on a
// machine with no global CLI the `rls-isolation` step failed closed with "supabase CLI not
// installed" while `pnpm test:rls` passed against the same running stack, and on a machine
// with a different global CLI it ran the suite with that version. It also never handed vitest
// the stack's database URL, so auth-trail.test.ts hardcoded the default Postgres port.
//
// The runner takes its root from its own path, so the fixture is a copy of it and of every
// tools/lib module it reaches through static imports (read from the files themselves, so the
// copy follows the runner), with `supabase` and `pnpm` replaced by fakes (the fakebin pattern
// of check-e2e-device.test.mjs). A working fake can sit in node_modules/.bin (the workspace
// copy) and another on PATH, and every call records which one answered. The fakes are
// #!/bin/sh scripts and the runner spawns them with no shell, which Windows cannot do for a
// .cmd shim, so this file runs on POSIX only and says so loudly on win32. The stamp logic
// itself (gate.mjs's salt) is also proven in-process by tests/gates/gate-helpers.test.mjs, and
// the CLI helper's win32 branch by tests/gates/supabase-cli.test.mjs, both on both legs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, posix } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const RUNNER = 'tests/rls/run-rls.mjs'
const POSIX = process.platform !== 'win32'
const SKIP = POSIX ? false : 'POSIX-only: the fakes are #!/bin/sh scripts and the runner spawns them without a shell'
if (!POSIX) console.log(`# SKIPPED run-rls.test.mjs on ${process.platform}: ${SKIP}`)

const STAMPED_LINE =
  'rls-isolation: STAMPED — inputs unchanged since last green run (.harness/rls-isolation.ok; CI always re-runs)'
const STAMP_FILE = join('.harness', 'rls-isolation.ok')
const FAKE_DB_URL = 'postgresql://fake:fake@127.0.0.1:65001/fake'

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

// One node impl behind every fake; argv[2] is the fake's role. `workspace` and `path` are
// working CLIs, `broken` fails every command, `pnpm` records the environment it was started
// with into FAKE_ENV_OUT. Every call is appended to FAKE_CALLS with its role, so a case can
// prove a suite did NOT run and which CLI answered. The fake database answers `db query` with
// a fresh random boundary each time, as the real CLI does, so a runner that hashed the raw
// output would never hit a stamp.
const IMPL = `import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
const e = process.env
const role = process.argv[2]
const args = process.argv.slice(3)
appendFileSync(e.FAKE_CALLS, JSON.stringify([role, ...args]) + '\\n')
if (role === 'broken') { console.error('broken supabase on PATH'); process.exit(1) }
if (role === 'pnpm') {
  if (e.FAKE_ENV_OUT) writeFileSync(e.FAKE_ENV_OUT, JSON.stringify(e))
  process.exit(e.FAKE_VITEST === 'fail' ? 1 : 0)
}
const cmd = args.slice(0, 2).join(' ')
if (args[0] === '--version') { console.log(e.FAKE_VERSION ?? '2.118.0'); process.exit(0) }
if (args[0] === 'status') {
  if (e.FAKE_STACK === 'down') { console.error('supabase local development setup is not running.'); process.exit(1) }
  if (args[1] === '-o') {
    console.log('API_URL="http://127.0.0.1:65000"')
    console.log('ANON_KEY="anon-fake"')
    console.log('SERVICE_ROLE_KEY="service-fake"')
    console.log('DB_URL="${FAKE_DB_URL}"')
  }
  process.exit(0)
}
if (cmd === 'test db') process.exit(e.FAKE_TEST_DB === 'fail' ? 1 : 0)
if (cmd === 'db query') {
  if (e.FAKE_QUERY === 'fail') { console.error('unknown command "query" for "supabase db"'); process.exit(1) }
  console.error('Connecting to local database...')
  const rows = [{ started: e.FAKE_STARTED ?? '2026-09-29 09:14:01.431385+00', versions: e.FAKE_MIGRATIONS ?? '0001' }]
  console.log(JSON.stringify({ boundary: randomUUID(), rows, warning: 'untrusted data' }, null, 2))
  process.exit(0)
}
console.error('fake supabase: unexpected ' + args.join(' '))
process.exit(2)
`

/** @param {string} path @param {string} impl @param {string} role */
function shim(path, impl, role) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${impl}" ${role} "$@"\n`)
  chmodSync(path, 0o755)
}

/**
 * Every template/base module `rel` reaches through relative static imports, itself included,
 * as template-relative POSIX paths. Read from the files, so the fixture copies what the
 * runner imports today (#42's stamp libs, #43's CLI helper) without a list to keep in step.
 * @param {string} rel
 * @param {Set<string>} [seen]
 */
function importClosure(rel, seen = new Set()) {
  if (seen.has(rel)) return seen
  seen.add(rel)
  const src = readFileSync(join(TEMPLATE, rel), 'utf8')
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    importClosure(posix.normalize(posix.join(posix.dirname(rel), m[1])), seen)
  }
  return seen
}

/**
 * A scaffold-shaped fixture: the runner and its import closure, the inputs the rls stamp
 * declares (one migration, one pgTAP file, one suite file), a fake `pnpm` on PATH, and the
 * Supabase CLIs the case asks for.
 * @param {{ workspace?: boolean, pathCli?: 'path' | 'broken' }} [opts]
 *   `workspace`: a working fake at node_modules/.bin/supabase. `pathCli`: the `supabase` on
 *   PATH, working (the default) or failing every command.
 */
function fixture({ workspace = false, pathCli = 'path' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-rls-'))
  made.push(dir)
  for (const rel of importClosure(RUNNER)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    copyFileSync(join(TEMPLATE, rel), join(dir, rel))
  }
  for (const d of ['supabase/migrations', 'supabase/tests', 'fakes', 'bin']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, 'supabase/migrations/0001_init.sql'), 'create table notes (id int);\n')
  writeFileSync(join(dir, 'supabase/tests/rls.test.sql'), 'select plan(1);\n')
  writeFileSync(join(dir, 'tests/rls/cross-tenant-isolation.test.ts'), 'export {}\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n')
  const impl = join(dir, 'fakes/impl.mjs')
  writeFileSync(impl, IMPL)
  if (workspace) shim(join(dir, 'node_modules/.bin/supabase'), impl, 'workspace')
  shim(join(dir, 'bin/supabase'), impl, pathCli)
  shim(join(dir, 'bin/pnpm'), impl, 'pnpm')
  return dir
}

const SUPABASE_ROLES = new Set(['workspace', 'path', 'broken'])

/**
 * Run the runner the way the Stop hook does (HARNESS_STOP_GATE=1), with an environment built
 * from nothing: this suite itself runs under CI=true, which must not reach the runner unless
 * a case says so, and a stray global `supabase` must sit behind the fakes.
 * @param {string} dir @param {Record<string, string>} [env] @param {string} [cwd]
 */
function runRls(dir, env = {}, cwd = dir) {
  const calls = join(dir, 'calls.jsonl')
  const envOut = join(dir, 'pnpm-env.json')
  writeFileSync(calls, '')
  rmSync(envOut, { force: true })
  const res = spawnSync(process.execPath, [join(dir, RUNNER)], {
    cwd,
    env: {
      PATH: [join(dir, 'bin'), '/usr/bin', '/bin'].join(delimiter),
      HOME: dir,
      HARNESS_STOP_GATE: '1',
      FAKE_CALLS: calls,
      FAKE_ENV_OUT: envOut,
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const logged = readFileSync(calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => /** @type {string[]} */ (JSON.parse(l)))
  const ran = logged.map(([role, ...args]) => [SUPABASE_ROLES.has(role) ? 'supabase' : role, ...args].join(' '))
  return {
    code: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    /** true when both suites were started */
    suites: ran.includes('supabase test db') && ran.some((c) => c.startsWith('pnpm exec vitest')),
    pgtap: ran.includes('supabase test db'),
    /** which fake CLIs answered a `supabase` call */
    clis: new Set(logged.map(([role]) => role).filter((role) => SUPABASE_ROLES.has(role))),
    /** the environment the fake `pnpm` (vitest) was started with, or null when it never ran */
    recorded: existsSync(envOut) ? /** @type {Record<string, string>} */ (JSON.parse(readFileSync(envOut, 'utf8'))) : null,
    stamp: existsSync(join(dir, STAMP_FILE)) ? readFileSync(join(dir, STAMP_FILE), 'utf8') : null,
  }
}

/**
 * A fixture whose second run rode the stamp: the precondition of every "forces a re-run" case.
 * @param {Record<string, string>} [env] @param {Parameters<typeof fixture>[0]} [shape]
 */
function warmFixture(env = {}, shape = {}) {
  const dir = fixture(shape)
  const cold = runRls(dir, env)
  assert.equal(cold.code, 0, cold.out)
  assert.ok(cold.suites, `the cold run must run both suites:\n${cold.out}`)
  assert.match(cold.out, /\[rls\] OK/, cold.out)
  assert.match(cold.stamp ?? '', /^[0-9a-f]{64}$/, `a green run records the stamp:\n${cold.out}`)
  const warm = runRls(dir, env)
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes(STAMPED_LINE), `the warm run must ride the stamp:\n${warm.out}`)
  return dir
}

// ── Which CLI, which database (#43) ─────────────────────────────────────────────────────

test('under the Stop hook the runner uses the workspace CLI, names it, passes SUPABASE_DB_URL and ends [rls] OK', { skip: SKIP }, () => {
  const r = runRls(fixture({ workspace: true, pathCli: 'broken' }))
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes('not installed'), r.out)
  assert.deepEqual([...r.clis], ['workspace'], `only the workspace copy may answer:\n${r.out}`)
  assert.match(r.out, /\[rls\] Supabase CLI 2\.118\.0: node_modules\/\.bin\/supabase \(the workspace copy\)/, r.out)
  assert.ok(r.recorded, `the fake pnpm never ran:\n${r.out}`)
  assert.equal(r.recorded.SUPABASE_DB_URL, FAKE_DB_URL)
  assert.equal(r.recorded.SUPABASE_URL, 'http://127.0.0.1:65000')
  assert.equal(r.recorded.RLS_SUITE_READY, '1')
  assert.match(r.out, /\[rls\] OK/, r.out)
  // The Stop hook collects every line holding this word; the CLI line must never be one.
  assert.ok(!r.out.includes('SKIPPED'), r.out)
})

test('the stamp reads the database identity through the workspace CLI too', { skip: SKIP }, () => {
  // Every spawn uses the resolved CLI, `db query` included: a runner that sent the identity
  // probe to the PATH copy would lose the stamp on exactly the machine #43 is about.
  const dir = warmFixture({}, { workspace: true, pathCli: 'broken' })
  const warm = runRls(dir)
  assert.ok(warm.out.includes(STAMPED_LINE), warm.out)
  assert.deepEqual([...warm.clis], ['workspace'], warm.out)
})

test('with no workspace copy the runner falls back to the PATH CLI and says so', { skip: SKIP }, () => {
  const r = runRls(fixture({ workspace: false, pathCli: 'path' }))
  assert.equal(r.code, 0, r.out)
  assert.deepEqual([...r.clis], ['path'], r.out)
  assert.match(r.out, /\[rls\] Supabase CLI 2\.118\.0: `supabase` from PATH/, r.out)
  assert.ok(!r.out.includes('node_modules/.bin/supabase'), r.out)
  assert.equal(r.recorded?.SUPABASE_DB_URL, FAKE_DB_URL)
  assert.match(r.out, /\[rls\] OK/, r.out)
  assert.ok(!r.out.includes('SKIPPED'), r.out)
})

test('with no workspace copy and a broken PATH CLI the fail-closed rule is unchanged', { skip: SKIP }, () => {
  const r = runRls(fixture({ workspace: false, pathCli: 'broken' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /supabase CLI not installed/, r.out)
  assert.equal(r.recorded, null, 'vitest must not run without a stack')
})

test('no file under template/base/tests/rls names the default Postgres port', () => {
  // The suites reach the stack through the values `supabase status -o env` reports (#43): a
  // literal port reaches another database, or none, once a project moves it in config.toml.
  const dir = join(TEMPLATE, 'tests/rls')
  const hits = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && readFileSync(join(d.parentPath, d.name), 'utf8').includes('54322'))
    .map((d) => d.name)
  assert.deepEqual(hits, [])
})

// ── The stamp (#42) ───────────────────────────────────────────────────────────────────────

test('a warm stamp prints rls-isolation: STAMPED and runs neither suite', { skip: SKIP }, () => {
  const dir = warmFixture()
  const warm = runRls(dir)
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes(STAMPED_LINE), warm.out)
  assert.equal(warm.pgtap, false, `supabase test db ran on a stamp hit:\n${warm.out}`)
  assert.equal(warm.suites, false, warm.out)
  assert.ok(!warm.out.includes('[rls] OK'), 'a stamp hit is not a re-proof and must not print the OK line')
  // The line the Stop hook lists as stamped, never the word it lists as skipped.
  assert.ok(!warm.out.includes('SKIPPED'), warm.out)
})

test('an edited migration forces a real run', { skip: SKIP }, () => {
  const dir = warmFixture()
  appendFileSync(join(dir, 'supabase/migrations/0001_init.sql'), '-- edited\n')
  const r = runRls(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.suites, r.out)
  assert.ok(!r.out.includes('STAMPED'), r.out)
})

test('an edited CLI helper forces a real run', { skip: SKIP }, () => {
  // tools/lib/supabase-cli.mjs decides which binary both suites run under (#43), so it is in
  // the runner's stamp inputs (#42's import closure) and an edit to it re-proves the tree.
  const dir = warmFixture()
  appendFileSync(join(dir, 'tools/lib/supabase-cli.mjs'), '// edited\n')
  const r = runRls(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.suites, r.out)
  assert.ok(!r.out.includes('STAMPED'), r.out)
})

/** @type {Array<[string, Record<string, string>]>} */
const SALT_MOVES = [
  ['a different `supabase --version`', { FAKE_VERSION: '2.119.0' }],
  ['a changed database start time (a reset or a restart)', { FAKE_STARTED: '2026-09-29 10:00:00.000000+00' }],
  ['a changed applied-migration list (a migration applied without a restart)', { FAKE_MIGRATIONS: '0001,0002' }],
]
for (const [what, env] of SALT_MOVES) {
  test(`${what} forces a real run`, { skip: SKIP }, () => {
    const dir = warmFixture()
    const r = runRls(dir, env)
    assert.equal(r.code, 0, r.out)
    assert.ok(r.suites, `expected both suites to run:\n${r.out}`)
    assert.ok(!r.out.includes('STAMPED'), r.out)
    // ...and the new state is then the stamp.
    assert.ok(runRls(dir, env).out.includes(STAMPED_LINE))
  })
}

/** @type {Array<Record<string, string>>} */
const CI_SHAPES = [{ CI: 'true' }, { CI: '1' }, { CI: 'false' }, { HARNESS_REQUIRE_TOOLCHAINS: '1' }]
for (const env of CI_SHAPES) {
  const name = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  test(`${name} ignores the stamp and runs both suites`, { skip: SKIP }, () => {
    const dir = warmFixture()
    const r = runRls(dir, env)
    assert.equal(r.code, 0, r.out)
    assert.ok(r.suites, `${name} must never ride a stamp:\n${r.out}`)
    assert.ok(!r.out.includes('STAMPED'), r.out)
  })
}

test('a SKIPPED run writes no stamp', { skip: SKIP }, () => {
  const dir = fixture()
  // Not under the Stop hook and not in CI: the one posture where a down stack is a loud skip.
  const r = runRls(dir, { FAKE_STACK: 'down', HARNESS_STOP_GATE: '' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\[rls\] SKIPPED/, r.out)
  assert.equal(r.stamp, null, 'a skip proves nothing and must record nothing')
})

test('a FAIL run writes no stamp: a down stack under the Stop hook, a red pgTAP suite, a red client suite', { skip: SKIP }, () => {
  for (const env of [{ FAKE_STACK: 'down' }, { FAKE_TEST_DB: 'fail' }, { FAKE_VITEST: 'fail' }]) {
    const dir = fixture()
    const r = runRls(dir, env)
    assert.equal(r.code, 1, `${JSON.stringify(env)}:\n${r.out}`)
    assert.equal(r.stamp, null, `${JSON.stringify(env)} recorded a stamp:\n${r.out}`)
  }
})

test('a FAIL after a green run keeps the old stamp from counting: the next run re-runs', { skip: SKIP }, () => {
  const dir = warmFixture()
  appendFileSync(join(dir, 'supabase/tests/rls.test.sql'), '-- a new assertion\n')
  const red = runRls(dir, { FAKE_TEST_DB: 'fail' })
  assert.equal(red.code, 1, red.out)
  const again = runRls(dir)
  assert.ok(again.suites, `the red run's inputs were never proven green:\n${again.out}`)
})

test('a database identity that cannot be read means no stamp: both suites run and nothing is recorded', { skip: SKIP }, () => {
  const dir = fixture()
  for (let i = 0; i < 2; i += 1) {
    const r = runRls(dir, { FAKE_QUERY: 'fail' })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.suites, r.out)
    assert.match(r.out, /\[rls\] OK/, r.out)
    assert.equal(r.stamp, null, r.out)
    assert.ok(!r.out.includes('STAMPED') && !r.out.includes('SKIPPED'), r.out)
  }
})

test('the runner works from any cwd: the stamp lands under the project root', { skip: SKIP }, () => {
  const dir = fixture({ workspace: true, pathCli: 'broken' })
  const r = runRls(dir, {}, join(dir, 'supabase'))
  assert.equal(r.code, 0, r.out)
  // The workspace copy is found from the runner's own root, never from the caller's cwd.
  assert.deepEqual([...r.clis], ['workspace'], r.out)
  assert.ok(existsSync(join(dir, STAMP_FILE)), 'the stamp is written under the root the runner resolved')
  assert.ok(!existsSync(join(dir, 'supabase', STAMP_FILE)), 'never under the caller\'s cwd')
})

test('beside a parked older tools/lib the runner never stamps: a register without the entry, a stampGate with no salt', { skip: SKIP }, () => {
  // `update` parks an owned file the install changed, so the new runner can meet 1.0.3's libs.
  // 1.0.3's stampGate takes (gate, inputs): it would drop the salt and ride a stamp across a
  // reset. Modelled by a wrapper with that signature over today's gate.mjs.
  const olderGate = fixture()
  copyFileSync(join(olderGate, 'tools/lib/gate.mjs'), join(olderGate, 'tools/lib/gate-today.mjs'))
  writeFileSync(
    join(olderGate, 'tools/lib/gate.mjs'),
    "export * from './gate-today.mjs'\nimport { stampGate as today } from './gate-today.mjs'\nexport function stampGate(gate, inputs) {\n  return today(gate, inputs)\n}\n",
  )
  const olderRegister = fixture()
  writeFileSync(join(olderRegister, 'tools/lib/stamp-inputs.mjs'), 'export const STAMP_INPUTS = {}\n')
  for (const dir of [olderGate, olderRegister]) {
    for (let i = 0; i < 2; i += 1) {
      const r = runRls(dir)
      assert.equal(r.code, 0, r.out)
      assert.ok(r.suites, `both suites must run:\n${r.out}`)
      assert.match(r.out, /\[rls\] no stamp this run: .*predates the rls stamp/, r.out)
      assert.equal(r.stamp, null, r.out)
    }
  }
})
