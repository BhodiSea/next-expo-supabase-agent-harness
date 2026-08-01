// Can-fail proofs for the types-drift gate (template/base/tools/check-types-drift.mjs).
// The gate shells out to the `supabase` CLI, so the suite stubs a fake `supabase` on
// PATH whose behaviour is steered by env flags — hermetic, no Docker, no real stack.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-types-drift.mjs', import.meta.url),
)
const COMMITTED = 'packages/platform/supabase/src/database.types.ts'
const GEN_OUTPUT =
  'export type Database = { public: { Tables: { notes: { Row: { id: string } } } } }\n'

// A fake `supabase` CLI. FAKE_CLI=0 → `--version` fails (CLI absent); FAKE_UP=0 →
// `status` fails (stack down); FAKE_GEN_FAIL=1 → `gen` exits 1; otherwise `gen` prints
// the contents of FAKE_GEN_FILE.
//
// The behaviour lives in a node IMPL and the two shims delegate to it — the house
// pattern (check-native-deps, check-expo-policy, gate-canary-misc, measure-startup all
// do this), because the selftest matrix runs this file on windows-latest too. cmd.exe
// cannot execute an extensionless `#!/bin/sh` script: there is no PATHEXT match and no
// shebang handling, so a POSIX-only fake makes the gate take its CLI-absent SKIP branch
// on Windows and every test that needs a non-skip outcome fails.
const IMPL = `import { readFileSync } from 'node:fs'
import process from 'node:process'
const [cmd] = process.argv.slice(2)
const flag = (name, dflt) => process.env[name] ?? dflt
if (cmd === '--version') {
  if (flag('FAKE_CLI', '1') === '0') process.exit(1)
  console.log('supabase 1.0.0')
} else if (cmd === 'status') {
  if (flag('FAKE_UP', '1') === '0') process.exit(1)
} else if (cmd === 'gen') {
  if (flag('FAKE_GEN_FAIL', '0') === '1') process.exit(1)
  process.stdout.write(readFileSync(process.env.FAKE_GEN_FILE, 'utf8'))
}
process.exit(0)
`

/**
 * @param {{ committed?: string, genOutput?: string } & Record<string, string>} [opts]
 *   Anything beyond `committed`/`genOutput` is passed through as an env flag.
 * @returns {{ code: number | null, out: string }}
 */
function run({ committed, genOutput = GEN_OUTPUT, ...flags } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-typesdrift-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'impl.mjs'), IMPL)
  writeFileSync(
    join(bin, 'supabase'),
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/impl.mjs" "$@"\n`,
  )
  chmodSync(join(bin, 'supabase'), 0o755)
  // CRLF: cmd.exe mis-parses a .cmd file with bare LF line endings.
  writeFileSync(join(bin, 'supabase.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0impl.mjs" %*\r\n`)

  const genFile = join(dir, 'gen-output.ts')
  writeFileSync(genFile, genOutput)

  if (committed !== undefined) {
    mkdirSync(join(dir, 'packages/platform/supabase/src'), { recursive: true })
    writeFileSync(join(dir, COMMITTED), committed)
  }

  const env = { ...process.env, FAKE_GEN_FILE: genFile, ...flags }
  // Windows spells the variable `Path`; a hard-coded `PATH` key would sit BESIDE the
  // real one rather than replacing it, and `:` is not the separator there either.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`

  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('SKIP: no supabase CLI installed', () => {
  const r = run({ FAKE_CLI: '0', committed: GEN_OUTPUT })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
})

test('SKIP: CLI present but the stack is down', () => {
  const r = run({ FAKE_UP: '0', committed: GEN_OUTPUT })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
})

test('SKIP: stack up but the mirror was never generated (opt-in)', () => {
  const r = run({}) // no committed file
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('not generated yet'), r.out)
})

test('GREEN: the committed mirror matches the generated types', () => {
  const r = run({ committed: GEN_OUTPUT })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('OK'), r.out)
  assert.ok(!r.out.includes('SKIPPED'), r.out)
})

test('GREEN: trailing-whitespace-only differences are normalized away', () => {
  const r = run({ committed: `${GEN_OUTPUT.trimEnd()}\n\n`, genOutput: GEN_OUTPUT })
  assert.equal(r.code, 0, r.out)
  // Exit 0 alone cannot tell a real GREEN from a SKIP — and the gate's own skip line
  // says so ("a skip is not a pass"). Pin the pass, and pin the absence of the skip.
  assert.ok(r.out.includes('OK'), r.out)
  assert.ok(!r.out.includes('SKIPPED'), r.out)
})

test('RED: a stale committed mirror drifts from the live schema', () => {
  const r = run({ committed: 'export type Database = { public: { Tables: {} } }\n' })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('stale'), r.out)
})

test('RED: `gen types` fails while the stack is up (a migration broke generation)', () => {
  const r = run({ FAKE_GEN_FAIL: '1', committed: GEN_OUTPUT })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('failed while the stack is up'), r.out)
})
