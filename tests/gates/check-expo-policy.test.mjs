// Can-fail proofs for the expo-policy gate (template/base/tools/check-expo-policy.mjs).
// The gate asserts over the RESOLVED Expo config, which it obtains by running
// `pnpm exec expo config --json --type public` in apps/mobile — so every fixture
// plants (a) a stub apps/mobile/node_modules/.bin/expo (the gate requires the CLI
// path to exist) and (b) a fake `pnpm` shim prepended to PATH that prints a canned
// resolved-config JSON (with a package-manager banner ahead of it: the gate parses
// from the first brace). The shim ships a .cmd twin for the Windows selftest
// matrix. CNG purity reads `git ls-files`, so fixtures are REAL scratch git repos.
// The data files (identity lock, permission/plugin allowlists, eas.json, the
// generated tokens module) are the SHIPPED templates, mutated per case.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-expo-policy.mjs', import.meta.url),
)
const SHIPPED_PERMS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/expo-permissions.json', import.meta.url)),
  'utf8',
)
const SHIPPED_PLUGINS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/expo-plugins.json', import.meta.url)),
  'utf8',
)
const SHIPPED_EAS = readFileSync(
  fileURLToPath(new URL('../../template/stack/apps/mobile/eas.json', import.meta.url)),
  'utf8',
)
const SHIPPED_STORE_POLICY = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/store-policy.json', import.meta.url)),
  'utf8',
)
const SHIPPED_STORE_TUNABLES = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/store-tunables.json', import.meta.url)),
  'utf8',
)
// @app/design-tokens' committed RN adapter is the single source apps/mobile paints from,
// and the one the splash lockstep reads the dark canvas token out of.
const NATIVE_MODULE_REL = 'packages/design-tokens/src/generated/native.ts'
const SHIPPED_TOKENS = readFileSync(
  fileURLToPath(new URL(`../../template/stack/${NATIVE_MODULE_REL}`, import.meta.url)),
  'utf8',
)

// The dark canvas token, parsed exactly the way the gate parses it — so the
// fixtures' launch-frame colors track the shipped palette instead of a literal.
const DARK_CANVAS = (() => {
  const dark = /dark:\s*\{([^}]*)\}/.exec(SHIPPED_TOKENS)
  const canvas = dark === null ? null : /canvas:\s*'(#[0-9a-fA-F]{3,8})'/.exec(dark[1])
  assert.ok(canvas, 'the shipped tokens module must carry a parsable dark canvas token')
  return canvas[1].toLowerCase()
})()

const LOCK = {
  appIdentifier: 'com.example.app',
  scheme: 'exampleapp',
  easProjectId: 'ab12cd34-0000-4000-8000-1234567890ab',
}

// Minimal REAL PNGs for the icon-integrity checks (fake CRCs — the gate's
// zero-dependency parser reads IHDR/IDAT and skips CRC validation). All-zero
// pixels = deliberately SOLID (the scaffold's placeholder posture; the policy
// default warns); `vary` flips one pixel for the not-solid cases.
function makePng(width, height, { alpha = false, vary = false } = {}) {
  const bpp = alpha ? 4 : 3
  const stride = width * bpp
  const raw = Buffer.alloc((stride + 1) * height)
  if (vary) raw[1 + bpp] = 0xff // second pixel's first channel differs
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = alpha ? 6 : 2
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function defaultAssets() {
  return {
    'apps/mobile/assets/icon.png': makePng(1024, 1024),
    'apps/mobile/assets/adaptive-icon.png': makePng(1024, 1024, { alpha: true }),
    'apps/mobile/assets/splash-icon.png': makePng(512, 512, { alpha: true }),
  }
}

// A resolved config that satisfies every rule against the fixture lock + the
// shipped allowlists (loopback ATS exceptions included, to pin their legality).
function baseConfig() {
  return {
    name: 'Example',
    slug: 'example',
    scheme: LOCK.scheme,
    version: '0.1.0',
    sdkVersion: '57.0.0',
    newArchEnabled: true,
    icon: './assets/icon.png',
    ios: {
      bundleIdentifier: LOCK.appIdentifier,
      buildNumber: '0.1.0',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSAppTransportSecurity: {
          NSExceptionDomains: { localhost: {}, '127.0.0.1': {} },
        },
      },
    },
    android: {
      package: LOCK.appIdentifier,
      versionCode: 1000,
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: DARK_CANVAS },
    },
    runtimeVersion: { policy: 'appVersion' },
    updates: { url: `https://u.expo.dev/${LOCK.easProjectId}` },
    extra: {
      apiOrigin: 'https://api.example.com',
      eas: { projectId: LOCK.easProjectId },
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-localization',
      ['expo-splash-screen', { image: './assets/splash-icon.png', backgroundColor: DARK_CANVAS }],
    ],
  }
}

function configWith(mutate) {
  const c = baseConfig()
  mutate(c)
  return c
}

// The fake package manager (see check-native-deps.test.mjs for the pattern): node
// implements the behavior; sh + .cmd wrappers make it PATH-callable everywhere.
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

function git(dir, ...args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** @param {{ config?: any, banner?: string, lock?: any, perms?: any, pluginsFile?: any, eas?: any, tokens?: any, storePolicy?: any, storeTunables?: any, assets?: Record<string, Buffer> | null, nodeModules?: boolean, sources?: Record<string, string | Buffer>, gitignore?: string }} [opts] */
function fixture({
  config = baseConfig(),
  banner = 'Scope: all 5 workspace projects',
  lock = LOCK,
  perms = SHIPPED_PERMS,
  pluginsFile = SHIPPED_PLUGINS,
  eas = SHIPPED_EAS,
  tokens = SHIPPED_TOKENS,
  storePolicy = SHIPPED_STORE_POLICY,
  storeTunables = SHIPPED_STORE_TUNABLES,
  assets = defaultAssets(),
  nodeModules = true,
  sources = {},
  gitignore = 'node_modules/\napps/mobile/android/\napps/mobile/ios/\n',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-expopolicy-'))
  mkdirSync(join(dir, 'apps/mobile/src/theme'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/mobile/app.config.ts'),
    '// resolved by the fake expo CLI in this fixture\nexport default {}\n',
  )
  // The tracking check reads the app package's dependency map.
  writeFileSync(join(dir, 'apps/mobile/package.json'), '{ "name": "mobile", "dependencies": {} }\n')
  if (nodeModules) {
    mkdirSync(join(dir, 'apps/mobile/node_modules/.bin'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/node_modules/.bin/expo'), '')
  }
  if (lock !== null) writeFileSync(join(dir, 'tools/identity.lock.json'), asText(lock))
  if (perms !== null) writeFileSync(join(dir, 'tools/expo-permissions.json'), asText(perms))
  if (pluginsFile !== null) writeFileSync(join(dir, 'tools/expo-plugins.json'), asText(pluginsFile))
  if (eas !== null) writeFileSync(join(dir, 'apps/mobile/eas.json'), asText(eas))
  if (tokens !== null) {
    mkdirSync(join(dir, 'packages/design-tokens/src/generated'), { recursive: true })
    writeFileSync(join(dir, NATIVE_MODULE_REL), asText(tokens))
  }
  if (storePolicy !== null) writeFileSync(join(dir, 'tools/store-policy.json'), asText(storePolicy))
  if (storeTunables !== null)
    writeFileSync(join(dir, 'tools/store-tunables.json'), asText(storeTunables))
  for (const [rel, content] of Object.entries(assets ?? {})) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  writeFileSync(join(dir, '.gitignore'), gitignore)
  for (const [rel, content] of Object.entries(sources)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  git(dir, 'init', '-q')
  writeShims(dir, { config, banner })
  return dir
}

function storePolicyWith(mutate) {
  const p = JSON.parse(SHIPPED_STORE_POLICY)
  mutate(p)
  return p
}

function storeTunablesWith(mutate) {
  const p = JSON.parse(SHIPPED_STORE_TUNABLES)
  mutate(p)
  return p
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

// ---- baseline -------------------------------------------------------------------

test('GREEN: a lock-true resolved config passes every rule (banner before the JSON tolerated)', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('expo-policy: OK'), r.out)
  assert.ok(r.out.includes('identity locked, appVersion runtime'), r.out)
})

// ---- 1. identity lock -----------------------------------------------------------

test('RED: identity drift names the site, both values, and the immutability doctrine', () => {
  const r = runGate(
    fixture({ config: configWith((c) => (c.android.package = 'com.evil.other')) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('identity drift: android.package is "com.evil.other"'), r.out)
  assert.ok(r.out.includes(`tools/identity.lock.json pins "${LOCK.appIdentifier}"`), r.out)
  assert.ok(r.out.includes('immutable after first release'), r.out)
})

test('RED: an updates.url that does not embed the locked EAS projectId is a hijacked OTA channel', () => {
  const r = runGate(
    fixture({ config: configWith((c) => (c.updates.url = 'https://u.expo.dev/someone-else')) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not embed the locked EAS projectId'), r.out)
  assert.ok(r.out.includes('hijacked OTA channel'), r.out)
})

test('RED: a missing or unreadable identity lock is never vacuous', () => {
  const missing = runGate(fixture({ lock: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(
    missing.out.includes('tools/identity.lock.json missing — the scaffold ships it'),
    missing.out,
  )

  const broken = runGate(fixture({ lock: '{ nope' }))
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('tools/identity.lock.json is not valid JSON'), broken.out)
})

// ---- 2 + 3. runtime version + engine floor ---------------------------------------

test('RED: runtimeVersion must be EXACTLY { policy: "appVersion" } — string and extra-key forms red', () => {
  const str = runGate(fixture({ config: configWith((c) => (c.runtimeVersion = '1.2.3')) }))
  assert.equal(str.code, 1, str.out)
  assert.ok(str.out.includes('runtimeVersion must be exactly { "policy": "appVersion" }'), str.out)
  assert.ok(str.out.includes('(got "1.2.3")'), str.out)

  const extraKey = runGate(
    fixture({
      config: configWith((c) => (c.runtimeVersion = { policy: 'appVersion', fingerprint: true })),
    }),
  )
  assert.equal(extraKey.code, 1, extraKey.out)
  assert.ok(extraKey.out.includes('runtimeVersion must be exactly'), extraKey.out)
})

test('RED: newArchEnabled: false is dead config documenting the wrong intent', () => {
  const r = runGate(fixture({ config: configWith((c) => (c.newArchEnabled = false)) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('newArchEnabled must be absent or true (got false)'), r.out)
})

test('RED: a non-hermes jsEngine reds at every site, and useHermesV1: false reds', () => {
  const top = runGate(fixture({ config: configWith((c) => (c.jsEngine = 'jsc')) }))
  assert.equal(top.code, 1, top.out)
  assert.ok(top.out.includes('jsEngine must be absent or "hermes" (got "jsc")'), top.out)

  const android = runGate(fixture({ config: configWith((c) => (c.android.jsEngine = 'jsc')) }))
  assert.equal(android.code, 1, android.out)
  assert.ok(android.out.includes('android.jsEngine must be absent or "hermes"'), android.out)

  const hermesV1 = runGate(fixture({ config: configWith((c) => (c.ios.useHermesV1 = false)) }))
  assert.equal(hermesV1.code, 1, hermesV1.out)
  assert.ok(hermesV1.out.includes('ios.useHermesV1: false — Hermes V1 is the SDK 57 default'), hermesV1.out)
})

// ---- 4. transport ---------------------------------------------------------------

test('RED: NSAllowsArbitraryLoads is banned outright', () => {
  const r = runGate(
    fixture({
      config: configWith(
        (c) => (c.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads = true),
      ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('NSAllowsArbitraryLoads: true — blanket plaintext HTTP is banned'), r.out)
})

test('RED: a non-loopback ATS exception domain reds (loopback ones pass in the GREEN case)', () => {
  const r = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.infoPlist.NSAppTransportSecurity.NSExceptionDomains['api.internal.example'] = {}
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ATS exception domain "api.internal.example"'), r.out)
  assert.ok(r.out.includes('loopback-only'), r.out)
})

test('RED: usesCleartextTraffic reds anywhere — android.* AND inside a plugins entry', () => {
  const direct = runGate(
    fixture({ config: configWith((c) => (c.android.usesCleartextTraffic = true)) }),
  )
  assert.equal(direct.code, 1, direct.out)
  assert.ok(direct.out.includes('android.usesCleartextTraffic: true'), direct.out)

  // Inside an expo-build-properties entry: the deep walk must find it. The plugin
  // gets an allowlist row so THIS red (not the plugin lockstep) is what fires.
  const pluginsFile = JSON.parse(SHIPPED_PLUGINS)
  pluginsFile.plugins.push({ name: 'expo-build-properties', reason: 'test fixture' })
  const nested = runGate(
    fixture({
      pluginsFile,
      config: configWith((c) =>
        c.plugins.push(['expo-build-properties', { android: { usesCleartextTraffic: true } }]),
      ),
    }),
  )
  assert.equal(nested.code, 1, nested.out)
  assert.ok(nested.out.includes('plugins.4.1.android.usesCleartextTraffic: true'), nested.out)
  assert.ok(nested.out.includes('Android cleartext HTTP is banned everywhere'), nested.out)
})

test('extra.apiOrigin: missing and non-https red; loopback http is GREEN', () => {
  const missing = runGate(fixture({ config: configWith((c) => delete c.extra.apiOrigin) }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('extra.apiOrigin missing from the resolved config'), missing.out)

  const plaintext = runGate(
    fixture({ config: configWith((c) => (c.extra.apiOrigin = 'http://api.internal.example')) }),
  )
  assert.equal(plaintext.code, 1, plaintext.out)
  assert.ok(plaintext.out.includes('must be https:// or loopback http://'), plaintext.out)

  const loopback = runGate(
    fixture({ config: configWith((c) => (c.extra.apiOrigin = 'http://localhost:8787')) }),
  )
  assert.equal(loopback.code, 0, loopback.out)
})

// ---- 5. permission allowlist, bidirectional --------------------------------------

test('permissions: an unreviewed grant reds, a reviewed one greens, a stale entry reds', () => {
  const grant = configWith((c) => (c.android.permissions = ['android.permission.CAMERA']))
  const unreviewed = runGate(fixture({ config: grant }))
  assert.equal(unreviewed.code, 1, unreviewed.out)
  assert.ok(
    unreviewed.out.includes(
      'android.permissions grants "android.permission.CAMERA" with no reviewed reason',
    ),
    unreviewed.out,
  )

  const perms = JSON.parse(SHIPPED_PERMS)
  perms.permissions.push({ name: 'android.permission.CAMERA', reason: 'scan QR codes on join' })
  const reviewed = runGate(fixture({ config: grant, perms }))
  assert.equal(reviewed.code, 0, reviewed.out)

  const stale = runGate(fixture({ perms }))
  assert.equal(stale.code, 1, stale.out)
  assert.ok(
    stale.out.includes('lists "android.permission.CAMERA" but the resolved config no longer grants it'),
    stale.out,
  )
})

test('RED: a reasonless permission entry is a gate bypass, named verbatim', () => {
  const perms = JSON.parse(SHIPPED_PERMS)
  perms.permissions.push({ name: 'android.permission.CAMERA', reason: '  ' })
  const r = runGate(fixture({ perms }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('every permission needs { name, reason }'), r.out)
})

// ---- 6. plugin allowlist, bidirectional ------------------------------------------

test('plugins: an unreviewed [name, config] entry reds by NAME; a stale allowlist row reds', () => {
  const unreviewed = runGate(
    fixture({ config: configWith((c) => c.plugins.push(['expo-camera', { mode: 'auto' }])) }),
  )
  assert.equal(unreviewed.code, 1, unreviewed.out)
  assert.ok(
    unreviewed.out.includes('plugin "expo-camera" resolves but has no entry in tools/expo-plugins.json'),
    unreviewed.out,
  )

  const pluginsFile = JSON.parse(SHIPPED_PLUGINS)
  pluginsFile.plugins.push({ name: 'expo-image-picker', reason: 'was reviewed once' })
  const stale = runGate(fixture({ pluginsFile }))
  assert.equal(stale.code, 1, stale.out)
  assert.ok(
    stale.out.includes('tools/expo-plugins.json lists "expo-image-picker" but it no longer resolves'),
    stale.out,
  )
})

// ---- 7. secret shapes ------------------------------------------------------------

test('RED: a secret-shaped KEY in resolved extra is a shipped secret; extra.eas is exempt', () => {
  const r = runGate(
    fixture({ config: configWith((c) => (c.extra.SUPER_API_KEY = 'not-even-a-real-one')) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('resolved extra.SUPER_API_KEY is a secret-shaped key in extra'), r.out)

  // The EAS metadata subtree is public by design — a secret-shaped name under it
  // must NOT red (it is printed by `eas init` and asserted against the lock).
  const exempt = runGate(
    fixture({ config: configWith((c) => (c.extra.eas.previewToken = 'public-metadata')) }),
  )
  assert.equal(exempt.code, 0, exempt.out)
})

test('RED: a secret-shaped EXPO_PUBLIC_* name in mobile source reds naming file and var', () => {
  const r = runGate(
    fixture({
      sources: {
        'apps/mobile/src/lib/env.ts': 'export const k = process.env.EXPO_PUBLIC_API_TOKEN\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/mobile/src/lib/env.ts: EXPO_PUBLIC_API_TOKEN'), r.out)
  assert.ok(r.out.includes('compile into the shipped bundle'), r.out)
})

// ---- 8. splash lockstep ----------------------------------------------------------

test('RED: splash and adaptive-icon backgrounds must EQUAL the generated dark canvas token', () => {
  const splash = runGate(
    fixture({
      config: configWith((c) => (c.plugins[3][1].backgroundColor = '#000000')),
    }),
  )
  assert.equal(splash.code, 1, splash.out)
  assert.ok(
    splash.out.includes(
      `expo-splash-screen plugin backgroundColor is "#000000" but the generated dark canvas token is "${DARK_CANVAS}"`,
    ),
    splash.out,
  )

  const icon = runGate(
    fixture({
      config: configWith((c) => (c.android.adaptiveIcon.backgroundColor = '#ffffff')),
    }),
  )
  assert.equal(icon.code, 1, icon.out)
  assert.ok(icon.out.includes('android.adaptiveIcon.backgroundColor is "#ffffff"'), icon.out)
})

test('RED: an unparsable or missing tokens module fails CLOSED — the lockstep never guesses', () => {
  const unparsable = runGate(fixture({ tokens: 'export const palettes = 42\n' }))
  assert.equal(unparsable.code, 1, unparsable.out)
  assert.ok(
    unparsable.out.includes(`could not parse the dark canvas token out of ${NATIVE_MODULE_REL}`),
    unparsable.out,
  )

  const missing = runGate(fixture({ tokens: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(
    missing.out.includes(`${NATIVE_MODULE_REL} missing — cannot verify the launch-frame lockstep`),
    missing.out,
  )
})

// ---- 9. eas.json sanity ----------------------------------------------------------

test('RED: eas.json sanity — remote version source, internal production, autoIncrement, secret env NAME', () => {
  const easWith = (mutate) => {
    const e = JSON.parse(SHIPPED_EAS)
    mutate(e)
    return e
  }

  const remote = runGate(fixture({ eas: easWith((e) => (e.cli.appVersionSource = 'remote')) }))
  assert.equal(remote.code, 1, remote.out)
  assert.ok(remote.out.includes('cli.appVersionSource must be "local"'), remote.out)

  const noProd = runGate(fixture({ eas: easWith((e) => delete e.build.production) }))
  assert.equal(noProd.code, 1, noProd.out)
  assert.ok(noProd.out.includes('build.production profile missing'), noProd.out)

  const internal = runGate(
    fixture({ eas: easWith((e) => (e.build.production.distribution = 'internal')) }),
  )
  assert.equal(internal.code, 1, internal.out)
  assert.ok(
    internal.out.includes('build.production.distribution must be absent or "store" (got "internal")'),
    internal.out,
  )

  const autoInc = runGate(
    fixture({ eas: easWith((e) => (e.build.production.autoIncrement = true)) }),
  )
  assert.equal(autoInc.code, 1, autoInc.out)
  assert.ok(
    autoInc.out.includes('build.production.autoIncrement must be false or absent (got true)'),
    autoInc.out,
  )

  const secretEnv = runGate(
    fixture({ eas: easWith((e) => (e.build.production.env = { SENTRY_TOKEN: 'oops' })) }),
  )
  assert.equal(secretEnv.code, 1, secretEnv.out)
  assert.ok(
    secretEnv.out.includes('build.production.env.SENTRY_TOKEN — secret-shaped env NAME'),
    secretEnv.out,
  )
})

// ---- never vacuous: the data files the gate reads must exist ----------------------

test('RED: missing allowlist / eas files are restore-it reds, never silent passes', () => {
  for (const [key, name] of [
    ['perms', 'tools/expo-permissions.json'],
    ['pluginsFile', 'tools/expo-plugins.json'],
    ['eas', 'apps/mobile/eas.json'],
  ]) {
    const r = runGate(fixture({ [key]: null }))
    assert.equal(r.code, 1, `${name}: ${r.out}`)
    assert.ok(
      r.out.includes(`${name} missing — the scaffold ships it; restore it (this gate is never vacuous)`),
      `${name}: ${r.out}`,
    )
  }
})

// ---- 10. CNG purity --------------------------------------------------------------

test('RED: a git-tracked apps/mobile/android file is committed native output (purity beats resolution)', () => {
  const dir = fixture()
  mkdirSync(join(dir, 'apps/mobile/android'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/android/build.gradle'), '// prebuild output\n')
  git(dir, 'add', '-f', 'apps/mobile/android/build.gradle')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/mobile/android/build.gradle is committed native output'), r.out)
})

// ---- skip asymmetry --------------------------------------------------------------

test('skip asymmetry: apps/mobile/node_modules missing → loud local SKIP, CI fail-closed', () => {
  const dir = fixture({ nodeModules: false })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('node_modules missing'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('skips are not allowed in CI'), ci.out)
})

// ---- 11. store readiness (0.1.2, tools/store-policy.json) -----------------------

const REGISTRY_WITH_DELETE = `export const ACTION_COMMANDS = [
  { id: 'session.deleteAccount', titleKey: 'command.deleteAccount', group: 'session' },
]
`
const AUTH_SOURCES = {
  'apps/mobile/app/sign-in.tsx': 'export default function SignIn() { return null }\n',
  'apps/mobile/src/features/actions/registry.ts': REGISTRY_WITH_DELETE,
  // The account-deletion backing is a Supabase Edge Function: its index.ts on
  // disk AND a [functions.<name>] block in config.toml (store-policy points at it
  // via accountDeletion.edgeFunction = 'delete-account').
  'supabase/functions/delete-account/index.ts': 'Deno.serve(() => new Response("ok"))\n',
  'supabase/config.toml': '[functions.delete-account]\nverify_jwt = true\n',
}

test('GREEN store floor: the base fixture passes with the placeholder-icon NOTE (warn posture)', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('store-ready floor'), r.out)
  assert.ok(r.out.includes('solid-color placeholder'), r.out)
  assert.ok(r.out.includes('NOTE'), r.out)
})

test('RED 11b: export compliance must be DECLARED; true without the reviewed escape reds', () => {
  const undeclared = runGate(
    fixture({
      config: configWith((c) => {
        delete c.ios.infoPlist.ITSAppUsesNonExemptEncryption
      }),
    }),
  )
  assert.equal(undeclared.code, 1, undeclared.out)
  assert.ok(undeclared.out.includes('export compliance must be DECLARED'), undeclared.out)

  const unreviewed = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.infoPlist.ITSAppUsesNonExemptEncryption = true
      }),
    }),
  )
  assert.equal(unreviewed.code, 1, unreviewed.out)
  assert.ok(unreviewed.out.includes('nonExemptAllowed is false'), unreviewed.out)
})

test('11a usage strings: unreviewed + placeholder red; reviewed real string greens; stale entry reds', () => {
  const red = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.infoPlist.NSCameraUsageDescription = 'TODO: fill this in'
      }),
    }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('NSCameraUsageDescription declared with no reviewed entry'), red.out)
  assert.ok(red.out.includes('boilerplate purpose strings'), red.out)

  const reviewedPerms = JSON.parse(SHIPPED_PERMS)
  reviewedPerms.ios = [{ key: 'NSCameraUsageDescription', reason: 'document scanning' }]
  const green = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.infoPlist.NSCameraUsageDescription =
          'Scans your paper notes into the app using the camera.'
      }),
      perms: reviewedPerms,
    }),
  )
  assert.equal(green.code, 0, green.out)

  const stale = runGate(fixture({ perms: reviewedPerms }))
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes('declares no such usage string'), stale.out)
})

test('RED 11a: a plugin-implied usage key missing from the config reds naming the plugin', () => {
  const pluginsAllow = JSON.parse(SHIPPED_PLUGINS)
  pluginsAllow.plugins.push({ name: 'expo-camera', reason: 'test fixture' })
  const r = runGate(
    fixture({
      config: configWith((c) => {
        c.plugins.push('expo-camera')
      }),
      pluginsFile: pluginsAllow,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('plugin "expo-camera" implies ios.infoPlist.NSCameraUsageDescription'), r.out)
})

test('11c privacy manifests: malformed category and unreviewed declaration red; reviewed lockstep greens', () => {
  const malformed = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.privacyManifests = {
          NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyMadeUp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] }],
        }
      }),
    }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('not one of Apple'), malformed.out)

  const unreviewed = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.privacyManifests = {
          NSPrivacyAccessedAPITypes: [
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          ],
        }
      }),
    }),
  )
  assert.equal(unreviewed.code, 1, unreviewed.out)
  assert.ok(unreviewed.out.includes('no reviewed row'), unreviewed.out)

  const reviewed = storeTunablesWith((p) => {
    p.privacyAccessedApiTypes = [
      { category: 'NSPrivacyAccessedAPICategoryUserDefaults', reasons: ['CA92.1'], why: 'kv seam persists preferences' },
    ]
  })
  const green = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.privacyManifests = {
          NSPrivacyAccessedAPITypes: [
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          ],
        }
      }),
      storeTunables: reviewed,
    }),
  )
  assert.equal(green.code, 0, green.out)

  const staleRow = runGate(fixture({ storeTunables: reviewed }))
  assert.equal(staleRow.code, 1, staleRow.out)
  assert.ok(staleRow.out.includes('no ios.privacyManifests'), staleRow.out)
})

test('11d ATT: an ATT string with no tracking SDK reds; with the SDK all three declarations must agree', () => {
  const claim = runGate(
    fixture({
      config: configWith((c) => {
        c.ios.infoPlist.NSUserTrackingUsageDescription = 'We would like to track you.'
      }),
    }),
  )
  assert.equal(claim.code, 1, claim.out)
  assert.ok(claim.out.includes('no tracking SDK is present'), claim.out)

  const pluginsAllow = JSON.parse(SHIPPED_PLUGINS)
  pluginsAllow.plugins.push({ name: 'expo-tracking-transparency', reason: 'test fixture' })
  const reviewedPerms = JSON.parse(SHIPPED_PERMS)
  reviewedPerms.ios = [{ key: 'NSUserTrackingUsageDescription', reason: 'ads attribution' }]
  const disagree = runGate(
    fixture({
      config: configWith((c) => {
        c.plugins.push('expo-tracking-transparency')
        c.ios.infoPlist.NSUserTrackingUsageDescription =
          'Used to attribute installs to ad campaigns.'
      }),
      pluginsFile: pluginsAllow,
      perms: reviewedPerms,
    }),
  )
  assert.equal(disagree.code, 1, disagree.out)
  assert.ok(disagree.out.includes('NSPrivacyTracking is not true'), disagree.out)
})

test('11e targetSdk: a declared value below the floor reds; an unknown Expo SDK major fails CLOSED', () => {
  const low = runGate(
    fixture({
      config: configWith((c) => {
        c.android.targetSdkVersion = 30
      }),
    }),
  )
  assert.equal(low.code, 1, low.out)
  assert.ok(low.out.includes('below the Play floor'), low.out)

  const unknown = runGate(
    fixture({
      config: configWith((c) => {
        c.sdkVersion = '99.0.0'
      }),
    }),
  )
  assert.equal(unknown.code, 1, unknown.out)
  assert.ok(unknown.out.includes('no entry for Expo SDK "99"'), unknown.out)
})

test('11f icons: wrong dimensions, alpha in the marketing icon, and a dangling asset each red', () => {
  const small = runGate(
    fixture({ assets: { ...defaultAssets(), 'apps/mobile/assets/icon.png': makePng(512, 512) } }),
  )
  assert.equal(small.code, 1, small.out)
  assert.ok(small.out.includes('512×512 — must be 1024×1024'), small.out)

  const alpha = runGate(
    fixture({
      assets: { ...defaultAssets(), 'apps/mobile/assets/icon.png': makePng(1024, 1024, { alpha: true }) },
    }),
  )
  assert.equal(alpha.code, 1, alpha.out)
  assert.ok(alpha.out.includes('carries an alpha channel'), alpha.out)

  const missing = runGate(
    fixture({
      assets: (() => {
        const a = defaultAssets()
        delete a['apps/mobile/assets/icon.png']
        return a
      })(),
    }),
  )
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('does not exist'), missing.out)
})

test('11f icons: the solid-placeholder posture escalates from NOTE to red via the policy', () => {
  const escalated = runGate(
    fixture({ storeTunables: storeTunablesWith((p) => (p.icons.solidColorPlaceholder = 'error')) }),
  )
  assert.equal(escalated.code, 1, escalated.out)
  assert.ok(escalated.out.includes('solid-color placeholder'), escalated.out)

  // Real (non-solid) art passes even under the escalated posture.
  const realArt = runGate(
    fixture({
      storeTunables: storeTunablesWith((p) => (p.icons.solidColorPlaceholder = 'error')),
      assets: {
        'apps/mobile/assets/icon.png': makePng(1024, 1024, { vary: true }),
        'apps/mobile/assets/adaptive-icon.png': makePng(1024, 1024, { alpha: true, vary: true }),
        'apps/mobile/assets/splash-icon.png': makePng(512, 512, { alpha: true, vary: true }),
      },
    }),
  )
  assert.equal(realArt.code, 0, realArt.out)
})

test('11g account deletion: an auth surface without the registered action or the backing Edge Function reds', () => {
  const noAction = runGate(
    fixture({
      sources: {
        ...AUTH_SOURCES,
        'apps/mobile/src/features/actions/registry.ts': 'export const ACTION_COMMANDS = []\n',
      },
    }),
  )
  assert.equal(noAction.code, 1, noAction.out)
  assert.ok(noAction.out.includes("registers no 'session.deleteAccount' command"), noAction.out)
  assert.ok(noAction.out.includes('5.1.1(v)'), noAction.out)

  // The action is registered but the backing Edge Function is absent on disk.
  const authNoFn = { ...AUTH_SOURCES }
  delete authNoFn['supabase/functions/delete-account/index.ts']
  const noEndpoint = runGate(fixture({ sources: authNoFn }))
  assert.equal(noEndpoint.code, 1, noEndpoint.out)
  assert.ok(noEndpoint.out.includes('does not exist'), noEndpoint.out)

  const closed = runGate(fixture({ sources: AUTH_SOURCES }))
  assert.equal(closed.code, 0, closed.out)

  // The reviewed 'none' escape self-disables the closure with its reason on file.
  const escaped = runGate(
    fixture({
      sources: {
        ...AUTH_SOURCES,
        'apps/mobile/src/features/actions/registry.ts': 'export const ACTION_COMMANDS = []\n',
      },
      storeTunables: storeTunablesWith((p) => {
        p.accountDeletion = { surface: 'none', reason: 'SSO-only enterprise app; accounts are organization-managed' }
      }),
    }),
  )
  assert.equal(escaped.code, 0, escaped.out)
})

test('RED store policy: a malformed policy FAILS CLOSED; a missing one is a restore-it red', () => {
  const malformed = runGate(
    fixture({ storePolicy: storePolicyWith((p) => (p.androidTargetSdk.floor = 'thirty-five')) }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('cannot silently disarm'), malformed.out)

  const missing = runGate(fixture({ storePolicy: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('tools/store-policy.json missing'), missing.out)

  // The tunables half (1.0.0 split) fails closed the same way, naming the seeded pull —
  // it is planted-when-absent, so a missing file is a deleted one.
  const missingTunables = runGate(fixture({ storeTunables: null }))
  assert.equal(missingTunables.code, 1, missingTunables.out)
  assert.ok(
    missingTunables.out.includes('--refresh-seeded tools/store-tunables.json'),
    missingTunables.out,
  )
})
