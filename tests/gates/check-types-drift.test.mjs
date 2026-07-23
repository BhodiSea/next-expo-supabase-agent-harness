// Can-fail proofs for the types-drift gate (template/base/tools/check-types-drift.mjs).
// The gate shells out to the `supabase` CLI, so the suite stubs a fake `supabase` on
// PATH whose behaviour is steered by env flags — hermetic, no Docker, no real stack.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const FAKE = `#!/bin/sh
case "$1" in
  --version) [ "\${FAKE_CLI:-1}" = "0" ] && exit 1; echo "supabase 1.0.0"; exit 0 ;;
  status)    [ "\${FAKE_UP:-1}" = "0" ] && exit 1; exit 0 ;;
  gen)       [ "\${FAKE_GEN_FAIL:-0}" = "1" ] && exit 1; cat "$FAKE_GEN_FILE"; exit 0 ;;
esac
exit 0
`

// { committed?: string, genOutput?: string, ...envFlags } → { code, out }
function run({ committed, genOutput = GEN_OUTPUT, ...flags } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-typesdrift-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'supabase'), FAKE)
  chmodSync(join(bin, 'supabase'), 0o755)

  const genFile = join(dir, 'gen-output.ts')
  writeFileSync(genFile, genOutput)

  if (committed !== undefined) {
    mkdirSync(join(dir, 'packages/platform/supabase/src'), { recursive: true })
    writeFileSync(join(dir, COMMITTED), committed)
  }

  const res = spawnSync('node', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GEN_FILE: genFile,
      ...flags,
    },
  })
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
})

test('GREEN: trailing-whitespace-only differences are normalized away', () => {
  const r = run({ committed: `${GEN_OUTPUT.trimEnd()}\n\n`, genOutput: GEN_OUTPUT })
  assert.equal(r.code, 0, r.out)
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
