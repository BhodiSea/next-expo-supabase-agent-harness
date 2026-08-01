// Can-fail proofs for the native-deps gate (template/base/tools/check-native-deps.mjs).
// Fixture-driven: build a scaffold-shaped tree with a REAL scratch git repo (CNG purity
// reads `git ls-files`) plus the two things the version half actually reads — the
// installed expo package's bundledNativeModules.json and each dependency's own
// package.json. No PATH shim and no fake package manager: the gate reaches nothing but
// the filesystem, and the HERMETIC test below is what holds it to that. Pins: version
// drift named with both versions, CNG purity red BEFORE the content stamp (a warm stamp
// cannot hide a staged native dir), the expo-plugins.json integrity half, the local
// config-plugin test closure, and the skip-local/fail-closed-CI asymmetry.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-native-deps.mjs', import.meta.url),
)
const SHIPPED_PLUGINS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/expo-plugins.json', import.meta.url)),
  'utf8',
)

function git(dir, ...args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

// The SDK-blessed map the gate reads out of the installed expo package, and the
// versions actually on disk. Keeping them equal is the GREEN case; skewing one entry
// is the RED case. This is the whole input surface of the version half now that the
// gate no longer shells out to Expo's live versions service.
const BLESSED = { expo: '57.0.9', 'expo-crypto': '~57.0.1', 'react-native': '0.86.2' }
const INSTALLED = { expo: '57.0.9', 'expo-crypto': '57.0.4', 'react-native': '0.86.2' }

/** @param {{ nodeModules?: boolean, blessed?: Record<string,string> | null, installed?: Record<string,string>, pluginsFile?: any, gitignore?: any, files?: Record<string, string> }} [opts] */
function fixture({
  nodeModules = true,
  blessed = BLESSED,
  installed = INSTALLED,
  pluginsFile = SHIPPED_PLUGINS,
  gitignore = 'node_modules/\napps/mobile/android/\napps/mobile/ios/\n',
  files = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-nativedeps-'))
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  // Every dep is `catalog:` in the real scaffold — the gate reads the NAMES here and
  // the VERSIONS off disk, exactly as pnpm lays them out.
  writeFileSync(
    join(dir, 'apps/mobile/package.json'),
    JSON.stringify({
      name: 'mobile',
      dependencies: Object.fromEntries(Object.keys(installed).map((k) => [k, 'catalog:'])),
    }),
  )
  if (nodeModules) {
    mkdirSync(join(dir, 'apps/mobile/node_modules/.bin'), { recursive: true })
    for (const [name, version] of Object.entries(installed)) {
      mkdirSync(join(dir, `apps/mobile/node_modules/${name}`), { recursive: true })
      writeFileSync(
        join(dir, `apps/mobile/node_modules/${name}/package.json`),
        JSON.stringify({ name, version }),
      )
    }
    if (blessed !== null) {
      mkdirSync(join(dir, 'apps/mobile/node_modules/expo'), { recursive: true })
      writeFileSync(
        join(dir, 'apps/mobile/node_modules/expo/bundledNativeModules.json'),
        JSON.stringify(blessed),
      )
    }
  }
  if (pluginsFile !== null) writeFileSync(join(dir, 'tools/expo-plugins.json'), asText(pluginsFile))
  if (gitignore !== null) writeFileSync(join(dir, '.gitignore'), gitignore)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  git(dir, 'init', '-q')
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
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

test('RED: an installed version outside the SDK-blessed range is named with both versions', () => {
  const r = runGate(
    fixture({ installed: { ...INSTALLED, 'expo-crypto': '56.0.1', 'react-native': '0.86.0' } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('expo-managed version drift'), r.out)
  assert.ok(r.out.includes('expo-crypto@56.0.1 - expected version: ~57.0.1'), r.out)
  assert.ok(r.out.includes('react-native@0.86.0 - expected version: 0.86.2'), r.out)
  // The fix is a CATALOG edit — the app manifests are all `catalog:`, so pointing a
  // reader at the manifest would send them to a file with no version in it.
  assert.ok(r.out.includes('pnpm-workspace.yaml'), r.out)
})

test('the version half is HERMETIC — no network, no CLI, just the installed blessed map', () => {
  // The regression this encodes: the gate used to shell out to `expo install --check`,
  // which resolves the blessed map from Expo's LIVE versions service. The identical
  // commit went green→red overnight when Expo published a patch. Deleting the map is
  // now the ONLY way to lose the answer; nothing reaches the network.
  const r = runGate(fixture({ blessed: null }))
  assert.equal(r.code, 1, r.out) // CI: fail closed
  assert.ok(r.out.includes('bundledNativeModules.json'), r.out)
})

test('a `~` range accepts a higher PATCH but not a higher MINOR', () => {
  const ok = runGate(fixture({ installed: { ...INSTALLED, 'expo-crypto': '57.0.99' } }))
  assert.equal(ok.code, 0, ok.out)
  const bad = runGate(fixture({ installed: { ...INSTALLED, 'expo-crypto': '57.1.0' } }))
  assert.equal(bad.code, 1, bad.out)
  assert.ok(bad.out.includes('expo-crypto@57.1.0'), bad.out)
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

test('skip asymmetry: node_modules present but no blessed map → SKIP local, fail CI', () => {
  const dir = fixture({ blessed: null })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('bundledNativeModules.json'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
