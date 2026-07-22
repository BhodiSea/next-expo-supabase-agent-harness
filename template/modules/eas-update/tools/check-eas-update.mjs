#!/usr/bin/env node
// Gate: eas-update (opt-in module) — sanity over the OTA surface this module's
// README wires up. The module ships NO eas.json/app.config edits (the installer
// never clobbers consumer-owned files): the channel config is a documented
// one-line-per-profile addition, and THIS gate is the check that the documented
// patch was actually applied — completely and consistently. What it enforces:
//   1. expo-updates is a dependency of apps/mobile — an updates.url with no
//      expo-updates library is an OTA surface no shipped binary ever polls
//   2. runtimeVersion stays exactly { policy: 'appVersion' } — the
//      deterministic, PR-reviewable OTA compatibility boundary (an update
//      reaches ONLY binaries whose runtime version exactly matches; a version
//      bump fences off older binaries by design)
//   3. updates.url is EXACTLY https://u.expo.dev/<easProjectId> for the
//      projectId pinned in tools/identity.lock.json (stronger than the
//      expo-policy gate's embeds-the-id check: an update URL pointing anywhere
//      else is a hijacked — or dead — OTA channel), and the lock must pin a
//      real id, not TBD
//   4. every eas.json build profile that produces an updatable binary declares
//      an EAS Update channel (extends-aware). Exempt: profiles other profiles
//      extend (shared parents) and dev-client profiles (developmentClient
//      builds pick updates in the dev menu; `eas update:configure` itself only
//      channels the non-dev profiles)
// Wiring: the consumer appends ['eas-update', 'node tools/check-eas-update.mjs']
// to VALIDATE_STEPS in tools/harness.config.mjs per the module README (a
// harness-protected human edit, plus the AGENTS.md / gates-catalog lockstep the
// docs-sync gate enforces). Until the OTA surface exists the gate SKIPS LOUDLY
// locally and FAILS CLOSED in CI — adopt the surface and the gate in one PR.
// SOURCE: docs/modules/eas-update/README.md; https://docs.expo.dev/eas-update/getting-started/
// [corpus: expo/app-config] [corpus: expo/runtime-versions]
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'

const GATE = 'eas-update'
const APP = 'apps/mobile'
const CONFIG = `${APP}/app.config.ts`
const PKG_FILE = `${APP}/package.json`
const EAS_FILE = `${APP}/eas.json`
const LOCK = 'tools/identity.lock.json'

if (!existsSync(CONFIG)) skipOrFail(GATE, `${CONFIG} not found (no mobile app surface yet)`)
if (!existsSync(`${APP}/node_modules`)) {
  skipOrFail(
    GATE,
    `${APP}/node_modules missing — run pnpm install (config resolution needs the expo CLI)`,
  )
}
if (!existsSync(`${APP}/node_modules/.bin/expo`) && !existsSync('node_modules/.bin/expo')) {
  skipOrFail(
    GATE,
    'expo CLI not installed — run pnpm install (the gate resolves config through it)',
  )
}

// Stamp inputs are declared HERE, not in tools/lib/stamp-inputs.mjs (that
// registry is base-owned and its selftest mutation coverage tracks base gates):
// the resolved-config surface this gate reads is app.config.ts + the packages
// that resolve it, plus eas.json, the identity lock, and the lockfile — the
// expo-policy input set minus the token/styleguide surfaces this gate never
// touches. CI always re-runs (stampGate is a local convenience, never proof).
const recordGreen = stampGate(GATE, [
  `${APP}/app.config.ts`,
  `${APP}/package.json`,
  `${APP}/eas.json`,
  'tools/identity.lock.json',
  'pnpm-lock.yaml',
])

// --type public is the credential-free resolution: what an OTA update or a
// build actually embeds, with EAS-private fields stripped. Package-manager
// banners can precede the JSON on some setups — parse from the first brace.
// SOURCE: https://docs.expo.dev/workflow/configuration/
let cfg
try {
  const out = runCmd('pnpm exec expo config --json --type public', {
    cwd: APP,
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
  })
  const start = out.indexOf('{')
  if (start === -1) throw new Error(`no JSON object in output:\n${out.slice(0, 500)}`)
  cfg = JSON.parse(out.slice(start))
} catch (e) {
  const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message
  fail(
    GATE,
    `could not resolve the Expo config (pnpm exec expo config --json --type public in ${APP}):\n${detail.slice(-3000)}`,
  )
}

const errs = []

function readJson(path) {
  if (!existsSync(path)) {
    errs.push(`${path} missing — the scaffold ships it; restore it (this gate is never vacuous)`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    errs.push(`${path} is not valid JSON: ${e.message}`)
    return null
  }
}

const pkg = readJson(PKG_FILE)
const eas = readJson(EAS_FILE)
const lock = readJson(LOCK)
const hasUpdatesUrl = typeof cfg.updates?.url === 'string'
const hasExpoUpdates = typeof pkg?.dependencies?.['expo-updates'] === 'string'
const declaredChannels = Object.values(eas?.build ?? {}).some((p) => p?.channel !== undefined)

// Surface detection: with NO signal at all the module is enabled but the
// documented setup has not started — loud local skip, fail-closed in CI (wire
// this gate into harness.config.mjs in the SAME PR that adds the surface). Any
// PARTIAL signal is exactly the misconfiguration this gate exists to red.
if (!hasUpdatesUrl && !hasExpoUpdates && !declaredChannels) {
  skipOrFail(
    GATE,
    'no OTA surface yet (no updates.url, no expo-updates dependency, no eas.json channels) — run the eas-update module setup: docs/modules/eas-update/README.md',
  )
}

// 1. the expo-updates library — the client half of the OTA surface.
// SOURCE: https://docs.expo.dev/versions/latest/sdk/updates/ (expo-updates manages remote updates)
function checkLibrary() {
  if (!hasExpoUpdates) {
    errs.push(
      `${PKG_FILE} has no "expo-updates" dependency — binaries built from this tree will never check the update URL; run \`npx expo install expo-updates\` in ${APP}`,
    )
  }
}

// 2. runtime version policy — the OTA compatibility boundary. Re-asserted here
// (expo-policy also pins it) because every delivery claim in the module README
// is FALSE under any other policy.
function checkRuntimeVersion() {
  const rv = cfg.runtimeVersion
  const exact =
    rv !== null &&
    typeof rv === 'object' &&
    !Array.isArray(rv) &&
    rv.policy === 'appVersion' &&
    Object.keys(rv).length === 1
  if (!exact) {
    // SOURCE: EAS Update runtime versions — the appVersion policy [corpus: expo/runtime-versions]
    errs.push(
      `runtimeVersion must be exactly { "policy": "appVersion" } (got ${JSON.stringify(rv)}) — the deterministic OTA boundary; the fingerprint policy is a computed hash no PR can review (rejected in the design record)`,
    )
  }
}

// 3. updates.url ↔ identity lock, exact equality. A consumer on a custom
// (self-hosted) update server is out of this module's scope — see the README's
// honest limits.
function checkUpdatesUrl() {
  if (lock === null) return
  const id = lock.easProjectId
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    errs.push(
      `${LOCK} pins easProjectId ${JSON.stringify(id)} — OTA needs the real EAS project UUID: run \`eas init\`, update the lock (a reviewed human edit), then \`eas update:configure\``,
    )
    return
  }
  const want = `https://u.expo.dev/${id}`
  const got = cfg.updates?.url
  if (got === undefined) {
    errs.push(
      `updates.url missing from the resolved config — add updates: { url: '${want}' } to ${CONFIG} (or run \`eas update:configure\`); without it no binary ever polls for updates`,
    )
    return
  }
  if (got !== want) {
    errs.push(
      `updates.url is ${JSON.stringify(got)} but ${LOCK} pins easProjectId ${JSON.stringify(id)} (expected exactly "${want}") — an update URL pointing at another project is a hijacked OTA channel`,
    )
  }
}

// extends-aware field resolution over eas.json build profiles: a profile
// inherits every field it does not set from its `extends` parent.
// SOURCE: https://docs.expo.dev/eas/json/ (build profiles: extends, channel)
function resolveField(profiles, name, field, seen = new Set()) {
  if (seen.has(name)) return { err: `extends cycle involving "${name}"` }
  seen.add(name)
  const profile = profiles[name]
  if (profile === null || typeof profile !== 'object') {
    return { err: `extends target "${name}" does not exist` }
  }
  if (field in profile) return { value: profile[field] }
  if (typeof profile.extends === 'string') {
    return resolveField(profiles, profile.extends, field, seen)
  }
  return { value: undefined }
}

// 4. channels declared for the profiles that build. Leaf = not extended by any
// other profile; shared parents describe no build of their own. Dev-client
// profiles are exempt (see header).
function checkChannels() {
  if (eas === null) return
  const profiles = eas.build ?? {}
  const names = Object.keys(profiles)
  if (names.length === 0) {
    errs.push(`${EAS_FILE} declares no build profiles — nothing can build, so nothing can update`)
    return
  }
  const parents = new Set(
    names.map((n) => profiles[n]?.extends).filter((e) => typeof e === 'string'),
  )
  for (const name of names) {
    if (parents.has(name)) continue
    const dev = resolveField(profiles, name, 'developmentClient')
    if (dev.err !== undefined) {
      errs.push(`${EAS_FILE}: build.${name}: ${dev.err}`)
      continue
    }
    if (dev.value === true) continue
    const ch = resolveField(profiles, name, 'channel')
    if (ch.err !== undefined) {
      errs.push(`${EAS_FILE}: build.${name}: ${ch.err}`)
      continue
    }
    if (typeof ch.value !== 'string' || ch.value.trim() === '') {
      errs.push(
        `${EAS_FILE}: build.${name} resolves no EAS Update channel — a binary from this profile can never receive an update; add the documented one-line patch ("channel": "${name}") per docs/modules/eas-update/README.md`,
      )
    }
  }
}

checkLibrary()
checkRuntimeVersion()
checkUpdatesUrl()
checkChannels()

failures(GATE, errs)
recordGreen()
ok(
  GATE,
  'expo-updates installed, appVersion runtime, updates.url locked to the EAS project, every building profile channeled',
)
