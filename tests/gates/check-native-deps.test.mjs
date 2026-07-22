// Can-fail proofs for the native-deps gate (template/base/tools/check-native-deps.mjs).
// Fixture-driven: build a scaffold-shaped tree with a REAL scratch git repo (CNG
// purity reads `git ls-files`), a stub apps/mobile/node_modules/.bin/expo (the gate
// requires the CLI's presence) and a fake `pnpm` shim prepended to PATH that stands
// in for `pnpm exec expo install --check` (a .cmd twin rides along so the shim works
// on the Windows selftest matrix). Pins: version drift surfaced verbatim, CNG purity
// red BEFORE the content stamp (a warm stamp cannot hide a staged native dir), the
// expo-plugins.json integrity half, the local config-plugin test closure, and the
// skip-local/fail-closed-CI asymmetry.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-native-deps.mjs', import.meta.url),
)
const SHIPPED_PLUGINS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/expo-plugins.json', import.meta.url)),
  'utf8',
)

// The fake package manager: reads fakebin/behavior.json and impersonates the one
// command this gate runs (`pnpm exec expo install --check`). Node implements the
// behavior so the same shim works on POSIX (sh wrapper) and Windows (.cmd twin).
const IMPL = `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const spec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'behavior.json'), 'utf8'),
)
const args = process.argv.slice(2).join(' ')
if (args.includes('expo config')) {
  if (spec.banner) console.log(spec.banner)
  console.log(JSON.stringify(spec.config))
  process.exit(0)
}
if (args.includes('expo install')) {
  if (spec.installDrift) {
    console.error(spec.installDrift)
    process.exit(1)
  }
  console.log('Dependencies are up to date')
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
  return bin
}

function git(dir, ...args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** @param {{ nodeModules?: boolean, expoBin?: boolean, pluginsFile?: any, gitignore?: any, behavior?: Record<string, any>, files?: Record<string, string> }} [opts] */
function fixture({
  nodeModules = true,
  expoBin = true,
  pluginsFile = SHIPPED_PLUGINS,
  gitignore = 'node_modules/\napps/mobile/android/\napps/mobile/ios/\n',
  behavior = {},
  files = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-nativedeps-'))
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/package.json'), '{ "name": "mobile" }\n')
  if (nodeModules) {
    mkdirSync(join(dir, 'apps/mobile/node_modules/.bin'), { recursive: true })
    if (expoBin) writeFileSync(join(dir, 'apps/mobile/node_modules/.bin/expo'), '')
  }
  if (pluginsFile !== null) writeFileSync(join(dir, 'tools/expo-plugins.json'), asText(pluginsFile))
  if (gitignore !== null) writeFileSync(join(dir, '.gitignore'), gitignore)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  git(dir, 'init', '-q')
  writeShims(dir, behavior)
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${join(dir, 'fakebin')}${delimiter}${env[pathKey] ?? ''}`
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: clean versions, pure CNG, reasoned allowlist, zero local plugins (with the arming note)', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('native-deps: OK'), r.out)
  assert.ok(r.out.includes('expo-managed versions clean'), r.out)
  assert.ok(r.out.includes('zero local config plugins found (test closure arms with the first)'), r.out)
})

test('RED: `expo install --check` drift is surfaced VERBATIM with the --fix command', () => {
  const drift =
    'expo@54.0.10 - expected version: 57.0.3\nreact-native-svg@15.0.0 - expected version: 16.1.1'
  const r = runGate(fixture({ behavior: { installDrift: drift } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('expo install --check found version drift'), r.out)
  assert.ok(r.out.includes('expo@54.0.10 - expected version: 57.0.3'), r.out)
  assert.ok(r.out.includes('react-native-svg@15.0.0 - expected version: 16.1.1'), r.out)
  assert.ok(r.out.includes('pnpm --filter mobile exec expo install --fix'), r.out)
})

test('RED: CNG purity runs BEFORE the stamp — a staged native dir reds even on a warm green stamp', () => {
  const dir = fixture()
  // Warm the stamp with a real local green run first.
  const warm = runGate(dir, { ci: false })
  assert.equal(warm.code, 0, warm.out)
  // Stage prebuild output; none of the stamp's declared inputs change.
  mkdirSync(join(dir, 'apps/mobile/android'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/android/build.gradle'), '// prebuild output\n')
  git(dir, 'add', '-f', 'apps/mobile/android/build.gradle')
  const r = runGate(dir, { ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/mobile/android/build.gradle is committed native output'), r.out)
  assert.ok(r.out.includes('git rm -r --cached'), r.out)
})

test('RED: a .gitignore that stops ignoring a native dir reds — purity must not be one git add away', () => {
  const r = runGate(fixture({ gitignore: 'node_modules/\napps/mobile/android/\n' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('.gitignore does not ignore apps/mobile/ios/'), r.out)
})

test('RED: tools/expo-plugins.json missing / malformed / hollow all fail loud', () => {
  const missing = runGate(fixture({ pluginsFile: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('tools/expo-plugins.json missing'), missing.out)

  const malformed = runGate(fixture({ pluginsFile: '{ nope' }))
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('not valid JSON'), malformed.out)

  const notArray = runGate(fixture({ pluginsFile: { plugins: 'expo-router' } }))
  assert.equal(notArray.code, 1, notArray.out)
  assert.ok(notArray.out.includes('"plugins" must be an array'), notArray.out)

  const reasonless = runGate(
    fixture({ pluginsFile: { plugins: [{ name: 'expo-router', reason: '   ' }] } }),
  )
  assert.equal(reasonless.code, 1, reasonless.out)
  assert.ok(reasonless.out.includes('every plugin needs { name, reason }'), reasonless.out)
  assert.ok(reasonless.out.includes('gate bypass'), reasonless.out)
})

test('local plugin closure: an untested apps/mobile/plugins/*.js reds; its .test.* twin greens it', () => {
  const red = runGate(
    fixture({ files: { 'apps/mobile/plugins/withFoo.js': 'module.exports = (c) => c\n' } }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('apps/mobile/plugins/withFoo.js has no withFoo.test.* beside it'), red.out)

  const green = runGate(
    fixture({
      files: {
        'apps/mobile/plugins/withFoo.js': 'module.exports = (c) => c\n',
        'apps/mobile/plugins/withFoo.test.js': 'test("noop", () => {})\n',
      },
    }),
  )
  assert.equal(green.code, 0, green.out)
  assert.ok(green.out.includes('1 local config plugin(s), each tested'), green.out)
})

test('skip asymmetry: node_modules missing → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = fixture({ nodeModules: false })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('node_modules missing'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('skips are not allowed in CI'), ci.out)
})

test('skip asymmetry: node_modules present but no expo CLI → SKIP local, fail CI', () => {
  const dir = fixture({ expoBin: false })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('expo CLI not installed'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
