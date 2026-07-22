// Cheap, install-free can-fail proofs for the gates without a dedicated fixture
// suite — every gate in the chain must be provably able to fail (a gate that
// cannot go red is decoration). Mirrors the source harness's misc canary minus
// the rust/tauri legs; the version-sync/contracts/build/perf-budget/styleguide
// legs the SRC misc file carried live in their own dedicated suites here, so
// this file owns exactly the two steps tests/canary/injections.json points at
// it for: prompts and licenses. The licenses leg drives the REAL license
// verdict through a fake `pnpm licenses list` shim (with a .cmd twin for the
// Windows selftest matrix): a disallowed license reds naming package + license,
// and tools/license-exceptions.json is the reviewed escape (malformed = loud).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function fixture(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-canary-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

// A fake `pnpm` on PATH for the licenses leg: prints the canned license tree.
const IMPL = `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const spec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'behavior.json'), 'utf8'),
)
const args = process.argv.slice(2).join(' ')
if (args.includes('licenses list')) {
  console.log(JSON.stringify(spec.licenses))
  process.exit(0)
}
console.error('fake pnpm: unexpected invocation: ' + args)
process.exit(1)
`

function writeShims(dir, behavior) {
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'impl.mjs'), IMPL)
  writeFileSync(join(bin, 'behavior.json'), JSON.stringify(behavior))
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/impl.mjs" "$@"\n`,
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  writeFileSync(join(bin, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0impl.mjs" %*\r\n`)
}

function runGate(script, dir, { shim = false } = {}) {
  cpSync(join(TOOLS, script), join(dir, 'tools', script))
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  env.CI = 'true'
  if (shim) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = `${join(dir, 'fakebin')}${delimiter}${env[pathKey] ?? ''}`
  }
  const res = spawnSync(process.execPath, [join('tools', script)], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ---- prompts ---------------------------------------------------------------------

const PROMPT = 'packages/eval/prompts/extract.v1.md'

test('RED prompts: a corrupt lock file fails loud, never open', () => {
  const dir = fixture({ 'tools/prompts.lock.json': '{nope' })
  const r = runGate('check-prompts-lock.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not valid JSON'), r.out)
})

test('prompts: a tampered hash-locked prompt reds; the true hash greens; stale/unlocked entries red', () => {
  const locked = 'Extract the entities.\n'
  const lock = JSON.stringify({ [PROMPT]: sha256(locked) })

  const tampered = runGate(
    'check-prompts-lock.mjs',
    fixture({ 'tools/prompts.lock.json': lock, [PROMPT]: 'TAMPERED PROMPT\n' }),
  )
  assert.equal(tampered.code, 1, tampered.out)
  assert.ok(tampered.out.includes(`${PROMPT} hash mismatch`), tampered.out)
  assert.ok(tampered.out.includes('changed without a lock update'), tampered.out)

  const green = runGate(
    'check-prompts-lock.mjs',
    fixture({ 'tools/prompts.lock.json': lock, [PROMPT]: locked }),
  )
  assert.equal(green.code, 0, green.out)
  assert.ok(green.out.includes('1 prompt(s) hash-locked and versioned'), green.out)

  // An unlocked prompt file and a lock entry whose file is gone both red.
  const unlocked = runGate(
    'check-prompts-lock.mjs',
    fixture({
      'tools/prompts.lock.json': lock,
      [PROMPT]: locked,
      'packages/eval/prompts/rank.v1.md': 'Rank them.\n',
    }),
  )
  assert.equal(unlocked.code, 1, unlocked.out)
  assert.ok(
    unlocked.out.includes('packages/eval/prompts/rank.v1.md is not in tools/prompts.lock.json'),
    unlocked.out,
  )

  const stale = runGate(
    'check-prompts-lock.mjs',
    fixture({ 'tools/prompts.lock.json': lock }),
  )
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes(`references missing file ${PROMPT}`), stale.out)
})

test('RED prompts: a lock-true prompt WITHOUT a .vN version in its filename still reds', () => {
  const body = 'Versionless.\n'
  const rel = 'packages/eval/prompts/extract.md'
  const r = runGate(
    'check-prompts-lock.mjs',
    fixture({ 'tools/prompts.lock.json': JSON.stringify({ [rel]: sha256(body) }), [rel]: body }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must carry an explicit version in its filename'), r.out)
})

// ---- licenses --------------------------------------------------------------------

test('RED licenses: CI with no install fails closed (skip is not a pass)', () => {
  const dir = fixture({})
  const r = runGate('check-licenses.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FAIL'), r.out)
})

// A citeability-clean project root, so the license-tree verdict is the only variable.
const CITEABLE = {
  'package.json': '{ "name": "fixture", "version": "0.0.0", "license": "MIT" }',
  LICENSE: 'MIT License\n',
  'CITATION.cff': 'cff-version: 1.2.0\ntitle: Fixture\nversion: 0.0.0\nlicense: MIT\n',
  'node_modules/.keep': '',
}

test('licenses: a disallowed license reds naming package + license; an exception entry greens it', () => {
  const licenses = { 'GPL-3.0-only': [{ name: 'evil-pkg', versions: ['1.0.0'] }] }

  const red = fixture(CITEABLE)
  writeShims(red, { licenses })
  const r = runGate('check-licenses.mjs', red, { shim: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('evil-pkg@1.0.0 — license "GPL-3.0-only" not in allowlist'), r.out)
  assert.ok(r.out.includes('license-exceptions.json'), r.out)

  const excused = fixture({
    ...CITEABLE,
    'tools/license-exceptions.json': JSON.stringify({
      comment: 'x',
      exceptions: [{ package: 'evil-pkg', reason: 'GPL tool used at build time only, reviewed' }],
    }),
  })
  writeShims(excused, { licenses })
  const g = runGate('check-licenses.mjs', excused, { shim: true })
  assert.equal(g.code, 0, g.out)
  assert.ok(g.out.includes('within the allowlist'), g.out)
})

test('RED licenses: a malformed exception entry fails LOUD (the escape hatch cannot fail open)', () => {
  const dir = fixture({
    ...CITEABLE,
    'tools/license-exceptions.json': JSON.stringify({ exceptions: [{ package: 'evil-pkg' }] }),
  })
  writeShims(dir, { licenses: {} })
  const r = runGate('check-licenses.mjs', dir, { shim: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('every exception must be'), r.out)
})

test('RED licenses: a citeability hole (version drift between CITATION.cff and package.json) reds', () => {
  const dir = fixture({
    ...CITEABLE,
    'CITATION.cff': 'cff-version: 1.2.0\ntitle: Fixture\nversion: 9.9.9\nlicense: MIT\n',
  })
  writeShims(dir, { licenses: {} })
  const r = runGate('check-licenses.mjs', dir, { shim: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('CITATION.cff version "9.9.9" != package.json version "0.0.0"'), r.out)
})
