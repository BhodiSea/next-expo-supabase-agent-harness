// Can-fail proofs for the version-sync gate (template/base/tools/check-version-sync.mjs).
// Ported from the tauri harness's suite and re-aimed at the mobile rewrite: the gate now
// has a STATIC half (version lockstep across package.json manifests, node-major agreement,
// eas.json build.base toolchain pins, SDK-lockstep catalog pins) that runs without an
// install, and a RESOLVED half (re-computing app.config.ts's derivation formulas through
// `pnpm exec expo config`, the versionCode encoding bound, and the single-zod-instance
// walk over `pnpm list`) that only runs when node_modules exists. Fixtures without
// node_modules exercise the static half exactly as a bare scaffold would; the resolved
// half is driven by a fake `pnpm` shim on PATH (sh + .cmd twins, so the selftest matrix
// can run this file on windows-latest) that serves canned `expo config` / `pnpm list`
// output from files beside the shim.
// Dropped vs SRC: tauri.conf.json drift and the rc-churn tools (babel-plugin-react-compiler,
// @tauri-apps/cli) — neither surface exists here. Added: every mobile-only rule (eas.json
// pins, resolved-config derivation, near-999 bound NOTE/red, zod walk incl. the
// build-tool-subtree exemption, banner-tolerant JSON parse).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-version-sync.mjs', import.meta.url),
)

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
  '  drizzle-kit: 0.30.0',
  '',
].join('\n')

// Every knob is optional; an undefined field means "do not write that file", which is
// exactly how a real scaffold looks before the corresponding surface exists.
/**
 * @param {{ version?: string, serverVersion?: string, mobileVersion?: string,
 *   packageManager?: string, nvmrc?: string, nodeVersion?: string, enginesNode?: string,
 *   eas?: Record<string, unknown>, workspace?: string }} [knobs]
 */
function fixture({
  version = '1.2.3',
  serverVersion,
  mobileVersion,
  packageManager,
  nvmrc,
  nodeVersion,
  enginesNode,
  eas,
  workspace,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-versionsync-'))
  const root = { name: 'root', private: true }
  if (version !== undefined) root.version = version
  if (packageManager !== undefined) root.packageManager = packageManager
  if (enginesNode !== undefined) root.engines = { node: enginesNode }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(root, null, 2))
  if (serverVersion !== undefined) {
    mkdirSync(join(dir, 'apps/server'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/server/package.json'),
      JSON.stringify({ name: 'server', version: serverVersion }),
    )
  }
  if (mobileVersion !== undefined) {
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/mobile/package.json'),
      JSON.stringify({ name: 'mobile', version: mobileVersion }),
    )
  }
  if (eas !== undefined) {
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/eas.json'), JSON.stringify(eas))
  }
  if (nvmrc !== undefined) writeFileSync(join(dir, '.nvmrc'), nvmrc)
  if (nodeVersion !== undefined) writeFileSync(join(dir, '.node-version'), nodeVersion)
  if (workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  return dir
}

// Arm the RESOLVED half: node_modules present plus a fake `pnpm` on PATH (sh + .cmd twin
// for Windows) serving canned `expo config` / `pnpm list -r … zod` output. The canned
// expo output deliberately carries a package-manager banner line before the JSON — the
// gate promises to parse from the first brace.
/**
 * @param {string} dir
 * @param {{ resolved?: Record<string, unknown>, banner?: string,
 *   zodList?: object[], expoExit?: number, zodExit?: number }} [knobs]
 */
function armResolved(
  dir,
  {
    resolved,
    banner = 'Scope: all 3 workspace projects',
    zodList = [{ name: 'root', dependencies: { zod: { version: '4.1.0' } } }],
    expoExit = 0,
    zodExit = 0,
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
    join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"expo config"*) cat "$(dirname "$0")/expo-config.out"; exit ${expoExit} ;;`,
      `  *"list"*) cat "$(dirname "$0")/zod-list.json"; exit ${zodExit} ;;`,
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
      'if not errorlevel 1 (',
      '  type "%~dp0zod-list.json"',
      `  exit /b ${zodExit}`,
      ')',
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
    serverVersion: version,
    mobileVersion: version,
    packageManager: 'pnpm@11.11.0',
    nvmrc: '22\n',
    nodeVersion: '22\n',
    enginesNode: '>=22',
    eas: { build: { base: { node: '22.14.0', pnpm: '11.11.0' } } },
    workspace: EXACT_CATALOG,
    ...overrides.fixture,
  })
  const bin = armResolved(dir, { resolved: derivedConfig(version), ...overrides.resolved })
  return { dir, bin }
}

// ── the static half (no node_modules: reds still report, greens skip loudly) ─────

test('RED: version drift between root and apps/mobile reds naming the drift', () => {
  const r = runGate(fixture({ version: '1.2.3', serverVersion: '1.2.3', mobileVersion: '1.2.2' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(r.out.includes('apps/mobile=1.2.2'), r.out)
  assert.ok(r.out.includes('bump them together'), r.out)
})

test('RED: an apps/server version behind root reds', () => {
  const r = runGate(fixture({ version: '1.2.3', serverVersion: '1.2.2' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(r.out.includes('apps/server=1.2.2'), r.out)
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
  for (const tool of ['expo', 'expo-router', 'react-native', 'babel-preset-expo', 'drizzle-kit']) {
    const workspace = EXACT_CATALOG.replace(`  ${tool}: `, `  ${tool}: ^`)
    const r = runGate(fixture({ workspace }))
    assert.equal(r.code, 1, `${tool} must red\n${r.out}`)
    assert.ok(r.out.includes(`catalog pin for ${tool}`), r.out)
    assert.ok(r.out.includes('EXACT-pinned'), r.out)
  }
  const tilde = runGate(
    fixture({ workspace: ['catalog:', '  drizzle-kit: ~0.30.0', ''].join('\n') }),
  )
  assert.equal(tilde.code, 1, tilde.out)
  assert.ok(tilde.out.includes('drizzle-kit'), tilde.out)
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
  const r = runGate(fixture({ version: '1.2.3', serverVersion: '1.2.3' }), { ci: true })
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

test('stamp: mutating a version input invalidates the stamp — the warm run re-checks and reds', () => {
  const { dir, bin } = greenFixture('1.2.3')
  assert.equal(runGate(dir, { bin, ci: false }).code, 0)
  writeFileSync(
    join(dir, 'apps/server/package.json'),
    JSON.stringify({ name: 'server', version: '1.2.2' }),
  )
  const r = runGate(dir, { bin, ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(!r.out.includes('inputs unchanged'), r.out)
})
