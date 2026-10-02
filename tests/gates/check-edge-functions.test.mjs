// EDGE FUNCTIONS TYPECHECK (1.1.0, #78).
//
// supabase/functions/<fn>/index.ts runs on Deno, and nothing Node-side could load it: `tsc -b`
// never reached supabase/, and vitest, coverage and Stryker cannot import a file that imports a
// jsr: specifier and starts a server as it loads. So a type error in the one piece of code that
// holds the service-role key passed `validate`, the Stop chain and CI alike.
//
// This file is the can-fail proof of the CI-only `edge-functions` lane
// (tests/canary/injections.json#lanes) and of its ramp's expiry
// (scripts/ci/stop-side-expiries.json). It spawns the REAL gate,
// template/base/tools/check-edge-functions.mjs, on fixture installs:
//   - the cases that need no deno at all (no function, a missing or ranged deno.json, no
//     deno.lock, deno missing locally and in CI, the ramp and its expiry) run on every OS:
//     PATH is pointed at an empty directory, so no deno on the machine can answer;
//   - the cases that need deno to ANSWER use a POSIX shell stub and skip loudly on Windows;
//   - one case runs a REAL deno over the shipped delete-account function, when one is on PATH,
//     and skips loudly otherwise (the selftest canary is its CI twin).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const GATE = join(REPO, 'template', 'base', 'tools', 'check-edge-functions.mjs')
const SHIPPED_FN = join(REPO, 'template', 'stack', 'supabase', 'functions', 'delete-account')
const DETAIL = 'the Edge Function surface'
const POSIX = process.platform !== 'win32'
const NEEDS_STUB = !POSIX && 'the deno stub is a POSIX shell script; this case cannot run on win32'

const INDEX = "import { createClient } from '@supabase/supabase-js'\nDeno.serve(() => new Response('ok'))\n"
const DENO_JSON = `${JSON.stringify({ imports: { '@supabase/supabase-js': 'jsr:@supabase/supabase-js@2.117.2' } }, null, 2)}\n`
const DENO_LOCK = '{\n  "version": "5"\n}\n'
const TYPE_ERROR = "const n: number = 'x'\n"

/** Every fixture this file makes, removed when it ends. @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/**
 * @param {Record<string, string>} files
 * @param {{ baseVersion: string, harnessVersion: string }} [manifest]
 */
function install(files, manifest) {
  const dir = scratch('nsah-edge-')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  if (manifest) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'manifest.json'), JSON.stringify(manifest, null, 2))
  }
  return dir
}

/** One well-formed function, `fn`, with index.ts, deno.json and deno.lock. */
const FUNCTION = {
  'supabase/functions/fn/index.ts': INDEX,
  'supabase/functions/fn/deno.json': DENO_JSON,
  'supabase/functions/fn/deno.lock': DENO_LOCK,
}

/** A directory holding nothing: as PATH, no deno on this machine can answer. */
const NO_DENO = () => scratch('nsah-edge-nodeno-')

/**
 * A POSIX `deno` that answers --version, fails `check` on an index.ts holding TYPE_ERROR the way
 * deno does, and records every check's arguments in $STUB_LOG.
 */
function stubDeno() {
  const dir = scratch('nsah-edge-stub-')
  const bin = join(dir, 'deno')
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "deno 2.9.6 (stub)"; exit 0; fi',
      'if [ "$1" = "check" ]; then',
      '  echo "$*" >> "$STUB_LOG"',
      '  for last; do :; done',
      `  if grep -q "const n: number" "$last"; then`,
      `    echo "TS2322 [ERROR]: Type 'string' is not assignable to type 'number'." >&2`,
      '    echo "error: Type checking failed." >&2',
      '    exit 1',
      '  fi',
      '  exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return dir
}

/**
 * @param {string} cwd
 * @param {{ path: string, ci?: boolean, log?: string }} opts
 */
function runGate(cwd, { path, ci = false, log }) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, PATH: path }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.HARNESS_PARITY_REPORT_DIR
  if (ci) env.CI = 'true'
  if (log) env.STUB_LOG = log
  const res = spawnSync(process.execPath, [GATE], { cwd, env, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const stubPath = (stub) => [stub, '/usr/bin', '/bin'].join(delimiter)

// ── nothing to check ─────────────────────────────────────────────────────────────────────

test('no supabase/functions at all: OK with the count, and deno is never needed', () => {
  const res = runGate(install({ 'README.md': 'x\n' }), { path: NO_DENO(), ci: true })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /^edge-functions: OK — 0 Edge Function\(s\) under supabase\/functions/m, res.out)
})

test('a _shared directory and a README are not functions: still 0', () => {
  const res = runGate(
    install({
      'supabase/functions/README.md': 'x\n',
      'supabase/functions/_shared/index.ts': 'export const x = 1\n',
    }),
    { path: NO_DENO(), ci: true },
  )
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /0 Edge Function\(s\)/, res.out)
})

// ── the pinned config: findings that need no deno ──────────────────────────────────────────

test('RED: a function with no deno.json fails naming it, deno or not', () => {
  const res = runGate(install({ 'supabase/functions/fn/index.ts': INDEX }), { path: NO_DENO() })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /^edge-functions: FAIL \(2\)/m, res.out)
  assert.match(res.out, /supabase\/functions\/fn: no deno\.json/, res.out)
  assert.match(res.out, /supabase\/functions\/fn: no deno\.lock — write it with `deno check --frozen=false --config supabase\/functions\/fn\/deno\.json supabase\/functions\/fn\/index\.ts`/, res.out)
})

test('RED: a jsr: import pinned to a range fails naming the import', () => {
  const ranged = `${JSON.stringify({ imports: { '@supabase/supabase-js': 'jsr:@supabase/supabase-js@2', 'std/': 'jsr:@std/assert@^1.0.0/', local: './local.ts' } })}\n`
  const res = runGate(install({ ...FUNCTION, 'supabase/functions/fn/deno.json': ranged }), { path: NO_DENO() })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /imports\["@supabase\/supabase-js"\] is "jsr:@supabase\/supabase-js@2", a range/, res.out)
  assert.match(res.out, /imports\["std\/"\] is "jsr:@std\/assert@\^1\.0\.0\/", a range/, res.out)
  assert.doesNotMatch(res.out, /imports\["local"\]/, res.out)
})

test('RED: a deno.json that does not parse is a finding, never a pass', () => {
  const res = runGate(install({ ...FUNCTION, 'supabase/functions/fn/deno.json': '{ not json' }), {
    path: NO_DENO(),
  })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /supabase\/functions\/fn\/deno\.json: cannot be parsed/, res.out)
})

// ── deno itself: skip loudly locally, fail closed in CI ─────────────────────────────────────

test('no deno on PATH: SKIPPED locally, FAIL under CI=true (the toolchain doctrine)', () => {
  const dir = install(FUNCTION)
  const local = runGate(dir, { path: NO_DENO() })
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /^edge-functions: SKIPPED — deno is not on PATH — 1 Edge Function\(s\) under supabase\/functions were not typechecked/m, local.out)
  assert.match(local.out, /this gate FAILS CLOSED in CI/, local.out)
  const ci = runGate(dir, { path: NO_DENO(), ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.match(ci.out, /^edge-functions: FAIL — deno is not on PATH/m, ci.out)
  assert.match(ci.out, /skips are not allowed in CI/, ci.out)
})

// ── deno answering (a POSIX stub) ─────────────────────────────────────────────────────────

test('GREEN: a pinned function typechecks with --frozen against its own deno.json and deno.lock', { skip: NEEDS_STUB }, () => {
  const dir = install(FUNCTION)
  const log = join(scratch('nsah-edge-log-'), 'calls.log')
  const res = runGate(dir, { path: stubPath(stubDeno()), log, ci: true })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /^edge-functions: OK — 1 Edge Function\(s\) typecheck against their deno\.json and frozen deno\.lock \(deno 2\.9\.6 \(stub\)\)/m, res.out)
  assert.equal(
    readFileSync(log, 'utf8').trim(),
    'check --frozen --config supabase/functions/fn/deno.json --lock=supabase/functions/fn/deno.lock supabase/functions/fn/index.ts',
  )
})

test('RED: a type error in index.ts fails the gate with deno\'s own output', { skip: NEEDS_STUB }, () => {
  const dir = install({ ...FUNCTION, 'supabase/functions/fn/index.ts': `${INDEX}${TYPE_ERROR}` })
  const res = runGate(dir, { path: stubPath(stubDeno()), log: join(dir, 'calls.log') })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /^edge-functions: FAIL \(1\)/m, res.out)
  assert.match(res.out, /supabase\/functions\/fn: deno check failed/, res.out)
  assert.match(res.out, /TS2322 \[ERROR\]: Type 'string' is not assignable to type 'number'\./, res.out)
  assert.match(res.out, /FIX\[edge-functions\]: reproduce with `node tools\/check-edge-functions\.mjs`/, res.out)
})

test('two functions: each is checked on its own config, and one red is named alone', { skip: NEEDS_STUB }, () => {
  const dir = install({
    ...FUNCTION,
    'supabase/functions/other/index.ts': `${INDEX}${TYPE_ERROR}`,
    'supabase/functions/other/deno.json': DENO_JSON,
    'supabase/functions/other/deno.lock': DENO_LOCK,
  })
  const log = join(dir, 'calls.log')
  const res = runGate(dir, { path: stubPath(stubDeno()), log })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /supabase\/functions\/other: deno check failed/, res.out)
  assert.doesNotMatch(res.out, /supabase\/functions\/fn: deno check failed/, res.out)
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2)
})

// ── the ramp: pre-1.1.0 installs get NOTEs until 1.2.0 ─────────────────────────────────────

const PRE = { baseVersion: '1.0.3', harnessVersion: '1.1.0' }
const V103_INDEX = readFileSync(join(REPO, 'tests', 'fixtures', 'released', '1.0.3', 'delete-account-index.ts.txt'), 'utf8')

test('RAMP: the unchanged v1.0.3 function with no deno.json on a 1.0.3 install is a NOTE, even in CI', () => {
  const dir = install({ 'supabase/functions/delete-account/index.ts': V103_INDEX }, PRE)
  const res = runGate(dir, { path: NO_DENO(), ci: true })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /^edge-functions: NOTE — the Edge Function surface \(deno check of supabase\/functions\/\*\/index\.ts against its own deno\.json and frozen deno\.lock\) \(ramp: live from baseVersion 1\.1\.0; this install's baseVersion is 1\.0\.3; expires in 1\.2\.0\)/m, res.out)
  assert.match(res.out, /^edge-functions: NOTE — \(ramp\) supabase\/functions\/delete-account: no deno\.json/m, res.out)
  assert.match(res.out, /^edge-functions: NOTE — \(ramp\) supabase\/functions\/delete-account: no deno\.lock/m, res.out)
  assert.match(res.out, /^edge-functions: NOTE — \(ramp\) deno is not on PATH/m, res.out)
  assert.match(res.out, /^edge-functions: OK — NOTE-only on this pre-1\.1\.0 install — 3 finding\(s\) above/m, res.out)
})

test('RAMP: a missing deno alone is a NOTE on a 1.0.3 install, not a skipOrFail', () => {
  const res = runGate(install(FUNCTION, PRE), { path: NO_DENO(), ci: true })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /NOTE — \(ramp\) deno is not on PATH/, res.out)
  assert.doesNotMatch(res.out, /skips are not allowed in CI/, res.out)
})

test('RAMP EXPIRED: at harness 1.2.0 the same install fails, and the banner names this ramp', () => {
  const dir = install({ 'supabase/functions/delete-account/index.ts': V103_INDEX }, { baseVersion: '1.0.3', harnessVersion: '1.2.0' })
  const res = runGate(dir, { path: NO_DENO() })
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /^edge-functions: RAMP EXPIRED — the Edge Function surface/m, res.out)
  assert.ok(res.out.includes(DETAIL), res.out)
  assert.match(res.out, /deadline of 1\.2\.0/, res.out)
  assert.match(res.out, /supabase\/functions\/delete-account: no deno\.json/, res.out)
})

test('a 1.1.0 install is held at once: no deno.json fails', () => {
  const dir = install({ 'supabase/functions/fn/index.ts': INDEX }, { baseVersion: '1.1.0', harnessVersion: '1.1.0' })
  const res = runGate(dir, { path: NO_DENO() })
  assert.equal(res.code, 1, res.out)
  assert.doesNotMatch(res.out, /NOTE/, res.out)
  assert.match(res.out, /no deno\.json/, res.out)
})

// ── a real deno over the shipped function ─────────────────────────────────────────────────

const REAL_DENO = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
const NEEDS_REAL = !REAL_DENO && 'no deno on PATH: the real typecheck of the shipped function runs in the selftest canary instead'

test('REAL deno: the shipped delete-account function typechecks, and a type error in index.ts reds', { skip: NEEDS_REAL, timeout: 600_000 }, () => {
  const dir = scratch('nsah-edge-real-')
  cpSync(SHIPPED_FN, join(dir, 'supabase', 'functions', 'delete-account'), { recursive: true })
  const path = process.env.PATH ?? ''
  const green = runGate(dir, { path, ci: true })
  assert.equal(green.code, 0, green.out)
  assert.match(green.out, /^edge-functions: OK — 1 Edge Function\(s\) typecheck/m, green.out)
  const index = join(dir, 'supabase', 'functions', 'delete-account', 'index.ts')
  writeFileSync(index, `${readFileSync(index, 'utf8')}${TYPE_ERROR}`)
  const red = runGate(dir, { path, ci: true })
  assert.equal(red.code, 1, red.out)
  assert.match(red.out, /TS2322/, red.out)
})
