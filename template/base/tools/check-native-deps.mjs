#!/usr/bin/env node
// Gate: native-deps — the native dependency floor for a CNG app. Loud SKIP
// locally without the toolchain, FAIL CLOSED in CI; the slow half rides a
// content stamp. What it enforces:
//   1. `expo install --check` exits clean: every Expo-managed package sits at
//      the SDK-blessed version (since SDK 55 an Expo package's MAJOR tracks
//      the SDK number, so drift is a native ABI risk, not a nit). On mismatch
//      expo exits nonzero listing the exact fixes — surfaced verbatim.
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
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
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
    `${APP}/node_modules missing — run pnpm install (the version check needs the expo CLI)`,
  )
}
if (!existsSync(`${APP}/node_modules/.bin/expo`) && !existsSync('node_modules/.bin/expo')) {
  skipOrFail(
    GATE,
    'expo CLI not installed — run pnpm install (the gate runs `expo install --check` through it)',
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
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

try {
  runCmd('pnpm exec expo install --check', {
    cwd: APP,
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
  })
} catch (e) {
  // On mismatch expo exits nonzero and prints the exact package list — that
  // output IS the fix; `expo install --fix` applies it.
  const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message
  fail(
    GATE,
    `expo install --check found version drift — apply its list with \`pnpm --filter mobile exec expo install --fix\`:\n${detail.slice(-2000)}`,
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
