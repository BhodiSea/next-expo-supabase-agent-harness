// Can-fail proofs for the version-sync gate (template/base/tools/check-version-sync.mjs).
// Ported from the tauri harness's suite and re-aimed at the mobile rewrite: the gate now
// has a STATIC half (root+mobile version lockstep, apps/web-major == @app/api-major,
// node-major agreement, eas.json build.base toolchain pins, SDK-lockstep catalog pins)
// that runs without an install, and a RESOLVED half (re-computing app.config.ts's
// derivation formulas through `pnpm exec expo config`, the versionCode encoding bound, and
// the single-zod-instance + single-React-per-surface walks over `pnpm list`) that only runs
// when node_modules exists. Fixtures without node_modules exercise the static half exactly
// as a bare scaffold would; the resolved half is driven by a fake `pnpm` shim on PATH (sh +
// .cmd twins, so the selftest matrix can run this file on windows-latest) that serves canned
// `expo config` / `pnpm list … zod` / `pnpm list … react` output from files beside the shim.
// Dropped vs SRC: tauri.conf.json drift and the rc-churn tools (babel-plugin-react-compiler,
// @tauri-apps/cli) — neither surface exists here. Added: every mobile-only rule (eas.json
// pins, resolved-config derivation, near-999 bound NOTE/red, zod + react walks incl. their
// build-tool-subtree exemptions, banner-tolerant JSON parse). W8: apps/server dropped from
// this lineage — the version machinery now targets apps/web (independent cadence, major-
// bounded) and @app/api instead.
// 0.7.0 adds the iOS BUILD-TOOLCHAIN floor to the static half: the production profile's
// ios.image, resolved through the eas.json `extends` chain, must be a CONCRETE name whose
// -xcode-<major> meets the reviewed tools/store-policy.json#iosToolchain floor — absent and
// alias pins (auto/latest/sdk-NN) red as unverifiable, ramped 0.7.0 → until 0.8.0 for
// pre-0.7.0 installs. Facts: design/CONFORMANCE-FACTS.md §3.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-version-sync.mjs', import.meta.url),
)
const TEMPLATE_EAS = fileURLToPath(
  new URL('../../template/stack/apps/mobile/eas.json', import.meta.url),
)
// The SHIPPED reviewed floor record — the green fixtures ride it so they can only be green
// while the template actually carries the iosToolchain record the tier-row probe names.
const shippedStorePolicy = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../template/base/tools/store-policy.json', import.meta.url)),
    'utf8',
  ),
)
const PINNED_IMAGE = 'macos-tahoe-26.5-xcode-26.6'

const versionCode = (v) => {
  const [maj = 0, min = 0, pat = 0] = v.split('.').map(Number)
  return maj * 1_000_000 + min * 1_000 + pat
}

// The resolved config a faithful app.config.ts would produce for `version`.
const derivedConfig = (version) => ({
  name: 'fixture',
  version,
  ios: { buildNumber: version },
  android: { versionCode: versionCode(version) },
  runtimeVersion: { policy: 'appVersion' },
})

const EXACT_CATALOG = [
  'catalog:',
  '  expo: 55.0.9',
  '  expo-router: 7.0.3',
  '  react-native: 0.83.1',
  '  babel-preset-expo: 15.0.0',
  '',
].join('\n')

// Every knob is optional; an undefined field means "do not write that file", which is
// exactly how a real scaffold looks before the corresponding surface exists.
/**
 * @param {{ version?: string, mobileVersion?: string, webVersion?: string,
 *   apiVersion?: string, packageManager?: string, nvmrc?: string, nodeVersion?: string,
 *   enginesNode?: string, eas?: Record<string, unknown>, workspace?: string,
 *   storePolicy?: Record<string, unknown>, manifest?: Record<string, unknown> }} [knobs]
 */
function fixture({
  version = '1.2.3',
  mobileVersion,
  webVersion,
  apiVersion,
  packageManager,
  nvmrc,
  nodeVersion,
  enginesNode,
  eas,
  workspace,
  storePolicy,
  manifest,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-versionsync-'))
  const root = { name: 'root', private: true }
  if (version !== undefined) root.version = version
  if (packageManager !== undefined) root.packageManager = packageManager
  if (enginesNode !== undefined) root.engines = { node: enginesNode }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(root, null, 2))
  if (mobileVersion !== undefined) {
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/mobile/package.json'),
      JSON.stringify({ name: 'mobile', version: mobileVersion }),
    )
  }
  // apps/web (independent cadence) + @app/api (the major web must track). Both are
  // written only when their knob is set, mirroring a scaffold before either surface lands.
  if (webVersion !== undefined) {
    mkdirSync(join(dir, 'apps/web'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/web/package.json'),
      JSON.stringify({ name: 'web', version: webVersion }),
    )
  }
  if (apiVersion !== undefined) {
    mkdirSync(join(dir, 'packages/api'), { recursive: true })
    writeFileSync(
      join(dir, 'packages/api/package.json'),
      JSON.stringify({ name: '@app/api', version: apiVersion }),
    )
  }
  if (eas !== undefined) {
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/eas.json'), JSON.stringify(eas))
  }
  if (nvmrc !== undefined) writeFileSync(join(dir, '.nvmrc'), nvmrc)
  if (nodeVersion !== undefined) writeFileSync(join(dir, '.node-version'), nodeVersion)
  if (workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  // The reviewed toolchain floor (tools/store-policy.json) and the install record the
  // 0.7.0 ramp reads — both written only when set, like every other knob.
  if (storePolicy !== undefined) {
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(join(dir, 'tools/store-policy.json'), JSON.stringify(storePolicy))
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

// eas.json with a production profile extending base: the image (when given) rides the
// PRODUCTION profile, which is what the toolchain floor resolves through the extends chain.
/** @param {string} [image] */
const easWith = (image) => ({
  build: {
    base: { node: '22.14.0', pnpm: '11.11.0' },
    production: {
      extends: 'base',
      autoIncrement: false,
      ...(image === undefined ? {} : { ios: { image } }),
    },
  },
})

// Arm the RESOLVED half: node_modules present plus a fake `pnpm` on PATH (sh + .cmd twin
// for Windows) serving canned `expo config` / `pnpm list -r … zod` output. The canned
// expo output deliberately carries a package-manager banner line before the JSON — the
// gate promises to parse from the first brace.
/**
 * @param {string} dir
 * @param {{ resolved?: Record<string, unknown>, banner?: string,
 *   zodList?: object[]|string, reactList?: object[]|string,
 *   expoExit?: number, zodExit?: number, reactExit?: number }} [knobs]
 */
function armResolved(
  dir,
  {
    resolved,
    banner = 'Scope: all 3 workspace projects',
    zodList = [{ name: 'root', dependencies: { zod: { version: '4.1.0' } } }],
    // Default: the deliberate two-surface split — web on its own patch, mobile on Expo's
    // bundled pin. Each project resolves ONE react, so the per-surface walk stays green.
    reactList = [
      { name: 'web', dependencies: { react: { version: '19.2.4' } } },
      { name: 'mobile', dependencies: { react: { version: '19.2.3' } } },
    ],
    expoExit = 0,
    zodExit = 0,
    reactExit = 0,
  } = {},
) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  const expoOut =
    typeof resolved === 'string' ? resolved : `${banner}\n${JSON.stringify(resolved)}\n`
  writeFileSync(join(bin, 'expo-config.out'), expoOut)
  writeFileSync(
    join(bin, 'zod-list.json'),
    typeof zodList === 'string' ? zodList : JSON.stringify(zodList),
  )
  writeFileSync(
    join(bin, 'react-list.json'),
    typeof reactList === 'string' ? reactList : JSON.stringify(reactList),
  )
  // The gate now issues TWO `pnpm list` calls (…zod…, …react…). The shim discriminates on
  // the package name in the argv so each walk reads its own canned tree; expo config stays
  // first. Order matters in the sh `case`: the zod pattern is checked before react.
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"expo config"*) cat "$(dirname "$0")/expo-config.out"; exit ${expoExit} ;;`,
      `  *"list"*"zod"*) cat "$(dirname "$0")/zod-list.json"; exit ${zodExit} ;;`,
      `  *"list"*"react"*) cat "$(dirname "$0")/react-list.json"; exit ${reactExit} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  writeFileSync(
    join(bin, 'pnpm.cmd'),
    [
      '@echo off',
      'echo %* | findstr /C:"expo config" >nul',
      'if not errorlevel 1 (',
      '  type "%~dp0expo-config.out"',
      `  exit /b ${expoExit}`,
      ')',
      'echo %* | findstr /C:"list" >nul',
      'if errorlevel 1 goto done',
      'echo %* | findstr /C:"zod" >nul',
      'if not errorlevel 1 (',
      '  type "%~dp0zod-list.json"',
      `  exit /b ${zodExit}`,
      ')',
      'echo %* | findstr /C:"react" >nul',
      'if not errorlevel 1 (',
      '  type "%~dp0react-list.json"',
      `  exit /b ${reactExit}`,
      ')',
      ':done',
      'exit /b 0',
      '',
    ].join('\r\n'),
  )
  return bin
}

// Windows names the variable Path; override THAT key or the child gets two PATHs.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/** @param {string} dir @param {{ ci?: boolean, bin?: string }} [opts] */
function runGate(dir, { ci = true, bin } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  if (bin !== undefined) env[PATH_KEY] = `${bin}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// A fully-green resolved fixture: one version everywhere, agreeing toolchains, faithful
// derivation, single zod. Each red test perturbs exactly one knob of this.
/**
 * @param {string} [version]
 * @param {{ fixture?: Record<string, unknown>, resolved?: Record<string, unknown> }} [overrides]
 */
function greenFixture(version = '1.2.3', overrides = {}) {
  const dir = fixture({
    version,
    mobileVersion: version,
    // web + api ride their own cadence (major 0), deliberately unequal to root/mobile —
    // a green greenFixture is itself proof that web's version floating free stays green.
    webVersion: '0.1.0',
    apiVersion: '0.1.0',
    packageManager: 'pnpm@11.11.0',
    nvmrc: '22\n',
    nodeVersion: '22\n',
    enginesNode: '>=22',
    // 0.7.0: green now REQUIRES the toolchain floor to be satisfiable — a pinned
    // -xcode->=26 production image plus the shipped reviewed floor record.
    eas: easWith(PINNED_IMAGE),
    storePolicy: shippedStorePolicy,
    workspace: EXACT_CATALOG,
    ...overrides.fixture,
  })
  const bin = armResolved(dir, { resolved: derivedConfig(version), ...overrides.resolved })
  return { dir, bin }
}

// ── the static half (no node_modules: reds still report, greens skip loudly) ─────

test('RED: version drift between root and apps/mobile reds naming the drift', () => {
  const r = runGate(fixture({ version: '1.2.3', mobileVersion: '1.2.2' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(r.out.includes('apps/mobile=1.2.2'), r.out)
  assert.ok(r.out.includes('bump them together'), r.out)
})

test('GREEN static: apps/web version far from root/mobile does NOT red — independent cadence', () => {
  // root+mobile locked at 1.2.3; web at 4.9.1, api at 4.0.0 (same MAJOR 4). The version
  // lockstep excludes web, and the major check passes — no install, static half only.
  const r = runGate(
    fixture({ version: '1.2.3', mobileVersion: '1.2.3', webVersion: '4.9.1', apiVersion: '4.0.0' }),
    { ci: false },
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(!r.out.includes('version drift'), r.out)
})

test('RED: apps/web MAJOR diverges from @app/api MAJOR — the skew contract reds', () => {
  const r = runGate(
    fixture({ version: '1.2.3', mobileVersion: '1.2.3', webVersion: '3.0.0', apiVersion: '2.7.1' }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/web major (3.0.0) != @app/api major (2.7.1)'), r.out)
  assert.ok(r.out.includes('share a MAJOR'), r.out)
})

test('RED: node major disagreement (.nvmrc vs .node-version; .nvmrc vs engines.node)', () => {
  const files = runGate(fixture({ nvmrc: '22\n', nodeVersion: '20\n' }))
  assert.equal(files.code, 1, files.out)
  assert.ok(files.out.includes('node version disagreement'), files.out)
  const engines = runGate(fixture({ nvmrc: '22\n', enginesNode: '>=20' }))
  assert.equal(engines.code, 1, engines.out)
  assert.ok(engines.out.includes('node version disagreement'), engines.out)
})

test('GREEN majors: 22.11.0 vs >=22 <23 vs 22 agree — static half stays silent (loud install skip)', () => {
  const r = runGate(fixture({ nvmrc: '22.11.0\n', nodeVersion: '22\n', enginesNode: '>=22 <23' }), {
    ci: false,
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(r.out.includes('node_modules absent'), r.out)
  assert.ok(r.out.includes('cannot resolve apps/mobile/app.config.ts'), r.out)
})

test('RED: eas.json build.base.node present but .node-version missing — no local source of truth', () => {
  const r = runGate(fixture({ eas: { build: { base: { node: '22.14.0', pnpm: '11.11.0' } } } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('.node-version is missing'), r.out)
})

test("RED: eas.json build.base.node on a different major than .node-version's", () => {
  const r = runGate(
    fixture({
      nodeVersion: '22\n',
      packageManager: 'pnpm@11.11.0',
      eas: { build: { base: { node: '20.11.1', pnpm: '11.11.0' } } },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("does not share .node-version's major (22)"), r.out)
  assert.ok(r.out.includes('the cloud build would run a different Node'), r.out)
})

test('RED: root packageManager is not a pnpm pin — eas.json has nothing to mirror', () => {
  const r = runGate(
    fixture({
      nodeVersion: '22\n',
      eas: { build: { base: { node: '22.14.0', pnpm: '11.11.0' } } },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('is not a pnpm pin'), r.out)
})

test('RED: eas.json build.base.pnpm drifts from packageManager — EAS ignores packageManager', () => {
  const r = runGate(
    fixture({
      nodeVersion: '22\n',
      packageManager: 'pnpm@11.11.0',
      eas: { build: { base: { node: '22.14.0', pnpm: '10.9.0' } } },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("build.base.pnpm=10.9.0 != packageManager's 11.11.0"), r.out)
  assert.ok(r.out.includes('EAS ignores packageManager'), r.out)
})

test('RED: a caret/tilde on any SDK-lockstep catalog tool reds naming the tool + EXACT-pinned', () => {
  for (const tool of ['expo', 'expo-router', 'react-native', 'babel-preset-expo']) {
    const workspace = EXACT_CATALOG.replace(`  ${tool}: `, `  ${tool}: ^`)
    const r = runGate(fixture({ workspace }))
    assert.equal(r.code, 1, `${tool} must red\n${r.out}`)
    assert.ok(r.out.includes(`catalog pin for ${tool}`), r.out)
    assert.ok(r.out.includes('EXACT-pinned'), r.out)
  }
  const tilde = runGate(
    fixture({ workspace: ['catalog:', '  expo: ~57.0.0', ''].join('\n') }),
  )
  assert.equal(tilde.code, 1, tilde.out)
  assert.ok(tilde.out.includes('expo'), tilde.out)
})

test('skip asymmetry: no root package.json → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-versionsync-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

test('CI fail-closed: a static-green tree without node_modules cannot pass in CI', () => {
  const r = runGate(fixture({ version: '1.2.3', mobileVersion: '1.2.3' }), { ci: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('node_modules absent'), r.out)
})

// ── the resolved half (fake pnpm shim serves expo config + pnpm list) ─────────────

test('GREEN: full lockstep — derivation re-computed through the banner-prefixed expo config JSON', () => {
  const { dir, bin } = greenFixture('1.2.3')
  const r = runGate(dir, { bin })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
  assert.ok(r.out.includes('buildNumber 1.2.3'), r.out)
  assert.ok(r.out.includes('versionCode 1002003'), r.out)
})

test('RED: literal-carrying app.config.ts — version, buildNumber, versionCode, runtimeVersion all red', () => {
  const { dir, bin } = greenFixture('1.2.3', {
    resolved: {
      resolved: {
        version: '9.9.9',
        ios: { buildNumber: '9.9.9' },
        android: { versionCode: 9009009 },
        runtimeVersion: { policy: 'fingerprint' },
      },
    },
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('resolved expo config version=9.9.9'), r.out)
  assert.ok(r.out.includes('never carry a literal'), r.out)
  assert.ok(r.out.includes('resolved ios.buildNumber=9.9.9'), r.out)
  assert.ok(r.out.includes('resolved android.versionCode=9009009'), r.out)
  assert.ok(r.out.includes('!= 1002003 (maj*1e6 + min*1e3 + pat of 1.2.3)'), r.out)
  assert.ok(r.out.includes("must stay 'appVersion'"), r.out)
})

test('NOTE: minor/patch at 900+ warns about the versionCode encoding bound but stays green', () => {
  const { dir, bin } = greenFixture('1.950.2')
  const r = runGate(dir, { bin })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE'), r.out)
  assert.ok(r.out.includes('versionCode encoding bound'), r.out)
  assert.ok(r.out.includes('versionCode 1950002'), r.out)
})

test('RED: minor past 999 breaks the encoding monotonicity — hard red, not a NOTE', () => {
  const { dir, bin } = greenFixture('1.1000.0')
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no longer monotonic'), r.out)
})

test('RED: two zod versions in the app graph red naming both versions', () => {
  const { dir, bin } = greenFixture('1.2.3', {
    resolved: {
      zodList: [
        {
          name: 'root',
          dependencies: {
            zod: { version: '4.1.0' },
            '@hono/zod-openapi': {
              version: '1.0.0',
              dependencies: { zod: { version: '3.23.8' } },
            },
          },
        },
      ],
    },
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('zod resolves to 2 versions'), r.out)
  assert.ok(r.out.includes('4.1.0'), r.out)
  assert.ok(r.out.includes('3.23.8'), r.out)
})

test("GREEN: a second zod inside the expo build-tool subtree is exempt (the CLI's own copy)", () => {
  const { dir, bin } = greenFixture('1.2.3', {
    resolved: {
      zodList: [
        {
          name: 'root',
          dependencies: {
            zod: { version: '4.1.0' },
            expo: {
              version: '55.0.9',
              dependencies: {
                '@expo/cli': { version: '1.0.0', dependencies: { zod: { version: '3.1.0' } } },
              },
            },
          },
        },
      ],
    },
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
})

test('zod walk failure: loud NOTE locally, red in CI — the invariant never silently vacates', () => {
  const local = greenFixture('1.2.3', { resolved: { zodExit: 1, zodList: '' } })
  const l = runGate(local.dir, { bin: local.bin, ci: false })
  assert.equal(l.code, 0, l.out)
  assert.ok(l.out.includes('zod single-instance check skipped'), l.out)
  const ci = greenFixture('1.2.3', { resolved: { zodExit: 1, zodList: '' } })
  const c = runGate(ci.dir, { bin: ci.bin, ci: true })
  assert.equal(c.code, 1, c.out)
  assert.ok(c.out.includes('cannot verify the single-zod-instance invariant'), c.out)
})

test('RED: a failing `expo config` reds naming the command — never a silent half-gate', () => {
  const { dir, bin } = greenFixture('1.2.3', { resolved: { expoExit: 1, resolved: '' } })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('`expo config --json --type public` failed'), r.out)
})

// ── single-React-instance walk (per surface; the deliberate web/mobile split is green) ──

test('GREEN: two React versions across DIFFERENT surfaces is correct — the split does not red', () => {
  // web@19.2.4 (Next's floor), mobile@19.2.3 (Expo's pin): two projects, each resolving one
  // react. Separate bundles never share a process, so this is the intended state, not a bug.
  const { dir, bin } = greenFixture('1.2.3', {
    resolved: {
      reactList: [
        { name: 'web', dependencies: { react: { version: '19.2.4' } } },
        { name: 'mobile', dependencies: { react: { version: '19.2.3' } } },
      ],
    },
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
})

test('RED: two React versions WITHIN one surface red naming the project + versions', () => {
  const { dir, bin } = greenFixture('1.2.3', {
    resolved: {
      reactList: [
        {
          name: 'mobile',
          dependencies: {
            react: { version: '19.2.3' },
            'some-rogue-lib': {
              version: '1.0.0',
              dependencies: { react: { version: '18.3.1' } },
            },
          },
        },
      ],
    },
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('react resolves to multiple versions within a single surface'), r.out)
  assert.ok(r.out.includes('mobile → 19.2.3, 18.3.1'), r.out)
  assert.ok(r.out.includes('break the hooks dispatcher'), r.out)
})

test("GREEN: a second React inside the test renderer subtree is exempt (never ships in a bundle)", () => {
  const { dir, bin } = greenFixture('1.2.3', {
    resolved: {
      reactList: [
        {
          name: 'mobile',
          dependencies: {
            react: { version: '19.2.3' },
            'react-test-renderer': {
              version: '19.2.5',
              dependencies: { react: { version: '19.2.5' } },
            },
          },
        },
      ],
    },
  })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
})

test('react walk failure: loud NOTE locally, red in CI — the invariant never silently vacates', () => {
  const local = greenFixture('1.2.3', { resolved: { reactExit: 1, reactList: '' } })
  const l = runGate(local.dir, { bin: local.bin, ci: false })
  assert.equal(l.code, 0, l.out)
  assert.ok(l.out.includes('react single-instance check skipped'), l.out)
  const ci = greenFixture('1.2.3', { resolved: { reactExit: 1, reactList: '' } })
  const c = runGate(ci.dir, { bin: ci.bin, ci: true })
  assert.equal(c.code, 1, c.out)
  assert.ok(c.out.includes('cannot verify the single-React-instance invariant'), c.out)
})

// ── the iOS build-toolchain floor (0.7.0, static half; design/CONFORMANCE-FACTS.md §3) ──
// Apple requires uploads to build against Xcode 26 / iOS 26 SDK or later (in force since
// 2026-04-28, a FIXED floor). Only a concrete pinned image name is statically checkable, so
// absent and alias pins red rather than read green — a check that passes an unpinned
// profile passes every profile.

/**
 * A static-half fixture whose every OTHER check is green, so a toolchain red is
 * attributable to the toolchain half alone.
 * @param {{ image?: string, storePolicy?: Record<string, unknown>,
 *   manifest?: Record<string, unknown> }} [knobs]
 */
const toolchainFixture = ({ image, storePolicy = shippedStorePolicy, manifest } = {}) =>
  fixture({
    nodeVersion: '22\n',
    nvmrc: '22\n',
    packageManager: 'pnpm@11.11.0',
    eas: easWith(image),
    storePolicy,
    manifest,
  })

test('RED: no ios.image on the production profile (nor via extends) — no pin means nothing can red', () => {
  const r = runGate(toolchainFixture())
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('pins no ios.image on the production profile'), r.out)
  assert.ok(r.out.includes('no pin means nothing can red'), r.out)
})

test('RED: auto / latest / sdk-52 are UNVERIFIABLE aliases — none may read as green', () => {
  for (const image of ['auto', 'latest', 'sdk-52']) {
    const r = runGate(toolchainFixture({ image }))
    assert.equal(r.code, 1, `${image} must red\n${r.out}`)
    assert.ok(r.out.includes(`"${image}"`), r.out)
    assert.ok(r.out.includes('UNVERIFIABLE'), r.out)
    assert.ok(r.out.includes('must not read as green'), r.out)
  }
})

test('RED: an image below the floor names both majors, the in-force date and the source', () => {
  const r = runGate(toolchainFixture({ image: 'macos-sonoma-14.5-xcode-25.1' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('builds with Xcode 25, below the floor of 26'), r.out)
  assert.ok(r.out.includes('2026-04-28'), r.out)
  assert.ok(r.out.includes('developer.apple.com'), r.out)
})

test('GREEN: -xcode-26.0 meets the floor — the static half stays silent about the toolchain', () => {
  const r = runGate(toolchainFixture({ image: 'macos-sequoia-15.6-xcode-26.0' }), { ci: false })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(!r.out.includes('ios.image'), r.out)
})

test('RED: a store-policy.json without the iosToolchain record reds while eas.json exists', () => {
  // A floor nobody reviewed: the file is harness-owned, so a missing record is a stale or
  // tampered tree — even a fully-pinned image cannot green over it.
  const unfloored = { ...shippedStorePolicy }
  delete unfloored.iosToolchain
  const r = runGate(toolchainFixture({ image: PINNED_IMAGE, storePolicy: unfloored }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('carries no iosToolchain record'), r.out)
})

test('RAMP: a pre-0.7.0 baseVersion install gets dated NOTEs naming the 0.8.0 deadline, not reds', () => {
  // Seeded eas.json is the consumer's file, so the floor arrives as a ramp: findings are
  // withheld as NOTEs until 0.8.0 (the seededSourceFixes channel carries the pin itself).
  const r = runGate(
    toolchainFixture({ manifest: { baseVersion: '0.6.0', harnessVersion: '0.7.0', files: {} } }),
    { ci: false },
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('the iOS build-toolchain floor over eas.json'), r.out)
  assert.ok(r.out.includes('expires in 0.8.0'), r.out)
  assert.ok(r.out.includes('(ramp)'), r.out)
  assert.ok(r.out.includes('no pin means nothing can red'), r.out)
})

test('RAMP: a 0.7.0 baseVersion install is LIVE — the identical tree reds', () => {
  const r = runGate(
    toolchainFixture({ manifest: { baseVersion: '0.7.0', harnessVersion: '0.7.0', files: {} } }),
    { ci: false },
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no pin means nothing can red'), r.out)
  // Narrowed from a bare `(ramp)` search in 0.9.9. That proxy was exact only while this gate
  // held ONE ramp; it now holds two, and the end-of-life register's ramp is legitimately
  // live for a 0.7.0-baseVersion install, so the bare search asserts something this test
  // never meant. The claim is that THE TOOLCHAIN RAMP is over — so it names it.
  assert.ok(!r.out.includes('the iOS build-toolchain floor over eas.json'), r.out)
})

test('REAL TREE: the shipped eas.json pin + the shipped store-policy floor satisfy the shipped gate', () => {
  // The discharge must be sufficient, not plausible: the template's own production profile
  // is judged against the template's own reviewed record, byte-for-byte as shipped.
  const realEas = JSON.parse(readFileSync(TEMPLATE_EAS, 'utf8'))
  const r = runGate(
    fixture({
      nodeVersion: '22\n',
      nvmrc: '22\n',
      packageManager: 'pnpm@11.11.0',
      eas: realEas,
      storePolicy: shippedStorePolicy,
    }),
    { ci: false },
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(!r.out.includes('ios.image'), r.out)
  assert.ok(!r.out.includes('iosToolchain'), r.out)
})

test('DOCS-SYNC at 0.7.0: the version-sync Target discharges through the iosToolchain probe', () => {
  // Assembled the way tests/gates/check-docs-sync.test.mjs builds tiersFixture({ allTools,
  // allWorkflows }): the REAL tools/ (this gate referencing iosToolchain on a non-comment
  // line + the shipped store-policy.json carrying the record), the real roster, catalog,
  // tiers table, security docs and workflows, and a manifest at 0.7.0 so the row's Target
  // has ARRIVED. Before this item the row carried a plain `0.7.0` and this exact run red
  // with "STILL scans one product surface" — a floor changes no scan root, which is why
  // the row now declares its evidence via the `closes:` probe instead.
  const base = fileURLToPath(new URL('../../template/base', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'epah-versionsync-docs-'))
  cpSync(join(base, 'tools'), join(dir, 'tools'), { recursive: true })
  cpSync(join(base, '.claude/agents'), join(dir, '.claude/agents'), { recursive: true })
  cpSync(join(base, 'github/workflows'), join(dir, '.github/workflows'), { recursive: true })
  mkdirSync(join(dir, 'docs/harness'), { recursive: true })
  cpSync(join(base, 'docs/harness/gates-catalog.md'), join(dir, 'docs/harness/gates-catalog.md'))
  cpSync(
    join(base, 'docs/harness/enforcement-tiers.md'),
    join(dir, 'docs/harness/enforcement-tiers.md'),
  )
  cpSync(join(base, 'docs/security'), join(dir, 'docs/security'), { recursive: true })
  cpSync(join(base, 'AGENTS.md'), join(dir, 'AGENTS.md'))
  writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
  const scripts = JSON.parse(
    readFileSync(join(base, 'package.json.tmpl'), 'utf8').replace(/\{\{[A-Z0-9_]+\}\}/g, 'x'),
  ).scripts
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: '0.7.0', harnessVersion: '0.7.0', files: {} }),
  )
  const res = spawnSync('node', ['tools/check-docs-sync.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  assert.equal(res.status, 0, out)
  assert.match(out, /every arrived Target discharged/)
  assert.doesNotMatch(out, /gate `version-sync`/)
})

// ── content-addressed stamp: kills both subprocesses on a warm unchanged run ──────

test('stamp: a green run records .harness/version-sync.ok; a warm re-run skips WITHOUT the shim', () => {
  const { dir, bin } = greenFixture('1.2.3')
  const cold = runGate(dir, { bin, ci: false })
  assert.equal(cold.code, 0, cold.out)
  assert.ok(cold.out.includes('in lockstep'), cold.out)
  assert.ok(existsSync(join(dir, '.harness/version-sync.ok')), 'a green run must record the stamp')
  // No shim on PATH: had the warm run spawned `pnpm exec expo config` in this fixture it
  // would red — the inputs-unchanged short-circuit is the only green path left.
  const warm = runGate(dir, { ci: false })
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes('inputs unchanged'), warm.out)
})

test('stamp: CI=true ignores a present stamp and re-runs the real check', () => {
  const { dir, bin } = greenFixture('1.2.3')
  runGate(dir, { bin, ci: false }) // record a stamp
  const inCi = runGate(dir, { bin, ci: true })
  assert.equal(inCi.code, 0, inCi.out)
  assert.ok(inCi.out.includes('in lockstep'), inCi.out)
  assert.ok(!inCi.out.includes('inputs unchanged'), inCi.out)
})

test('stamp: mutating apps/web (a new input class) invalidates the stamp — warm run re-checks and reds', () => {
  // Retargeted off the dropped apps/server: apps/web/package.json + packages/api/package.json
  // are now declared version-sync inputs. Bumping web's MAJOR past @app/api's must (1) bust
  // the warm stamp and (2) re-run the major check — proving both the input coverage and the
  // new assertion, exactly as the stamp doctrine's "mutate a representative of each class".
  const { dir, bin } = greenFixture('1.2.3')
  assert.equal(runGate(dir, { bin, ci: false }).code, 0)
  writeFileSync(
    join(dir, 'apps/web/package.json'),
    JSON.stringify({ name: 'web', version: '9.0.0' }),
  )
  const r = runGate(dir, { bin, ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/web major (9.0.0) != @app/api major (0.1.0)'), r.out)
  assert.ok(!r.out.includes('inputs unchanged'), r.out)
})
