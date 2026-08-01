#!/usr/bin/env node
// Gate: native-deps — the native dependency floor for a CNG app. Loud SKIP
// locally without the toolchain, FAIL CLOSED in CI; the slow half rides a
// content stamp. What it enforces:
//   1. Every Expo-managed package sits at the SDK-blessed version (since SDK 55
//      an Expo package's MAJOR tracks the SDK number, so drift is a native ABI
//      risk, not a nit). Read OFFLINE from the installed expo package's own
//      bundledNativeModules.json — deliberately not `expo install --check`,
//      which resolves the same map from Expo's live versions service and would
//      make this gate's verdict depend on a third-party endpoint.
//   2. CNG purity (tools/lib/cng-purity.mjs, shared with expo-policy):
//      apps/mobile/{android,ios} stay untracked AND ignored.
//   3. tools/expo-plugins.json integrity: parses, every entry carries a
//      non-empty reviewed reason. expo-policy owns the config<->file lockstep;
//      this half makes the FILE itself un-hollowable.
//   4. local config-plugin closure: every apps/mobile/plugins/*.{js,ts} has a
//      same-basename .test.* file — a local plugin rewrites the generated
//      native project at prebuild time and must be unit-tested. Zero plugins
//      is an honest OK; the closure arms when the first one lands.
// `expo-doctor` is deliberately NOT run here: it talks to the network (SDK
// versions endpoint, the React Native directory), and this gate stays hermetic
// and laptop-fast — the native CI lane owns expo-doctor.
// SOURCE: https://docs.expo.dev/more/expo-cli/#install [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { cngPurityErrors } from './lib/cng-purity.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'native-deps'
const APP = 'apps/mobile'
const PLUGINS_FILE = 'tools/expo-plugins.json'
const PLUGIN_DIR = `${APP}/plugins`

if (!existsSync(`${APP}/package.json`))
  skipOrFail(GATE, `${APP}/package.json not found (no mobile surface yet)`)
if (!existsSync(`${APP}/node_modules`)) {
  skipOrFail(
    GATE,
    `${APP}/node_modules missing — run pnpm install (the version check reads the installed packages)`,
  )
}

// ---- cheap always-run half, BEFORE the stamp -----------------------------------
// Purity first: git index state is not a hashable stamp input, so a staged
// native dir must red on every invocation, warm stamp or not. The two file
// asserts ride along here because they cost ~1ms and reading them pre-stamp
// keeps every red visible in one run.
const errs = [...cngPurityErrors()]
checkAllowlistIntegrity()
const localPluginCount = checkLocalPluginClosure()
failures(GATE, errs)

function checkAllowlistIntegrity() {
  if (!existsSync(PLUGINS_FILE)) {
    errs.push(
      `${PLUGINS_FILE} missing — the reviewed plugin allowlist expo-policy locksteps against; the scaffold ships it`,
    )
    return
  }
  let file
  try {
    file = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8'))
  } catch (e) {
    errs.push(`${PLUGINS_FILE} is not valid JSON: ${e.message}`)
    return
  }
  if (!Array.isArray(file.plugins)) {
    errs.push(`${PLUGINS_FILE}: "plugins" must be an array of { name, reason } entries`)
    return
  }
  for (const entry of file.plugins) {
    if (
      typeof entry?.name !== 'string' ||
      entry.name === '' ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      errs.push(
        `${PLUGINS_FILE}: entry ${JSON.stringify(entry)} — every plugin needs { name, reason } with a non-empty reviewed reason (a reasonless allowlist row is a gate bypass)`,
      )
    }
  }
}

function checkLocalPluginClosure() {
  const files = walkFiles(PLUGIN_DIR)
  const sources = files.filter((f) => /\.(js|ts)$/.test(f) && !/\.test\.[^/.]+$/.test(f))
  for (const src of sources) {
    const base = src.replace(/\.(js|ts)$/, '')
    if (!files.some((f) => f.startsWith(`${base}.test.`))) {
      errs.push(
        `${PLUGIN_DIR}/${src} has no ${base}.test.* beside it — a local config plugin rewrites the generated native project at prebuild; ship its unit test in the same diff`,
      )
    }
  }
  return sources.length
}

// ---- stamped half: the actual version check ------------------------------------
//
// HERMETIC BY CONSTRUCTION. This used to shell out to `expo install --check`, which
// resolves the SDK-blessed version map from Expo's LIVE versions service. That made a
// release-gating, daily-scheduled job depend on a third-party endpoint: the identical
// commit went from green to red overnight, with no repo change, the day Expo published
// a patch — while this file's own header claimed the gate "stays hermetic".
//
// The blessed map is not remote data. It ships INSIDE the installed expo package as
// bundledNativeModules.json, which is exactly what the catalog is pinned against. Read
// it from disk and the answer changes only when the catalog changes — which is the
// property a gate needs. Expo bumps are Renovate's job, not a gate's.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])
const BNM = `${APP}/node_modules/expo/bundledNativeModules.json`

const parseVersion = (v) => String(v).split('.').map(Number)
const cmp = (a, b) => {
  const [x, y, z] = parseVersion(a)
  const [p, q, r] = parseVersion(b)
  return x - p || y - q || z - r
}

// bundledNativeModules only ever uses three range shapes: exact, `~`, and `^`.
function satisfies(version, range) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return true // prerelease/tag — not ours to judge
  const bare = range.replace(/^[~^]/, '')
  if (!/^\d+\.\d+\.\d+$/.test(bare)) return true
  if (cmp(version, bare) < 0) return false
  const [vMaj, vMin] = parseVersion(version)
  const [rMaj, rMin] = parseVersion(bare)
  if (range.startsWith('~')) return vMaj === rMaj && vMin === rMin
  if (range.startsWith('^')) return rMaj === 0 ? vMaj === 0 && vMin === rMin : vMaj === rMaj
  return cmp(version, bare) === 0
}

if (!existsSync(BNM)) {
  skipOrFail(
    GATE,
    `${BNM} missing — run pnpm install (the version check reads expo's own blessed map)`,
  )
}

const blessed = JSON.parse(readFileSync(BNM, 'utf8'))
const appManifest = JSON.parse(readFileSync(`${APP}/package.json`, 'utf8'))
const declared = { ...appManifest.dependencies, ...appManifest.devDependencies }
const drift = []

for (const name of Object.keys(declared)) {
  const range = blessed[name]
  if (range === undefined) continue // not an Expo-managed package
  const installed = `${APP}/node_modules/${name}/package.json`
  if (!existsSync(installed)) {
    drift.push(`${name} is declared but not installed — run pnpm install`)
    continue
  }
  const { version } = JSON.parse(readFileSync(installed, 'utf8'))
  if (!satisfies(version, range)) {
    drift.push(`${name}@${version} - expected version: ${range}`)
  }
}

if (drift.length > 0) {
  fail(
    GATE,
    `expo-managed version drift against expo@${blessed.expo ?? JSON.parse(readFileSync(`${APP}/node_modules/expo/package.json`, 'utf8')).version}'s bundledNativeModules — fix the CATALOG pins in pnpm-workspace.yaml (not the app manifests; they are all \`catalog:\`):\n  ${drift.join('\n  ')}`,
  )
}

recordGreen()
ok(
  GATE,
  `expo-managed versions clean; CNG pure; plugin allowlist reasoned; ${
    localPluginCount === 0
      ? 'zero local config plugins found (test closure arms with the first)'
      : `${localPluginCount} local config plugin(s), each tested`
  }`,
)
