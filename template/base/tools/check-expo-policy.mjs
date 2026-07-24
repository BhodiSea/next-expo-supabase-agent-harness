#!/usr/bin/env node
// Gate: expo-policy — asserts over the RESOLVED Expo config, the store/security
// surface the app actually ships. Resolution runs through the expo CLI
// (`expo config --json --type public`: dynamic config executed, plugins
// expanded), so the gate needs apps/mobile/node_modules — loud SKIP locally
// without it, FAIL CLOSED in CI; unchanged inputs ride a content stamp. What it
// enforces (never vacuous: the scaffold ships every file it reads, so absence
// is a red, not a shrug):
//   1. store identity matches tools/identity.lock.json — ios.bundleIdentifier
//      == android.package == appIdentifier, scheme, EAS projectId, and
//      updates.url (when present) embeds that projectId; upgrade identity
//      never drifts after first release
//   2. runtimeVersion stays exactly { policy: 'appVersion' } — the
//      deterministic, PR-reviewable OTA compatibility boundary
//   3. engine floor: jsEngine absent-or-hermes, newArchEnabled absent-or-true,
//      useHermesV1 never false (SDK 57 forces the New Architecture on — an
//      explicit opt-out attempt still reds, because it documents wrong intent)
//   4. transport: no NSAllowsArbitraryLoads, ATS exception domains
//      loopback-only, no usesCleartextTraffic anywhere in the resolved config
//      (including an expo-build-properties plugin entry), extra.apiOrigin
//      https-or-loopback
//   5. android.permissions <-> tools/expo-permissions.json, bidirectional
//      (unreviewed grant AND stale entry both red)
//   6. resolved plugins <-> tools/expo-plugins.json, bidirectional, by name
//   7. no secret-shaped KEY in resolved `extra` (extra ships in the bundle by
//      design) and no secret-shaped EXPO_PUBLIC_* name in mobile source —
//      EXPO_PUBLIC_ vars compile into the shipped bundle
//   8. splash + adaptive-icon backgrounds both equal the GENERATED dark canvas
//      token — the native launch frame must paint the same pixel the first
//      React frame paints (anti-flash lockstep)
//   9. eas.json sanity: appVersionSource "local", production implies store
//      distribution, no autoIncrement, no secret-shaped env NAMES
//  10. CNG purity (shared assert): apps/mobile/{android,ios} untracked AND
//      ignored — prebuild output is generated, never committed
//  11. STORE READINESS (0.1.2, driven by tools/store-policy.json — reviewed
//      data, write-guard-protected; a malformed policy fails CLOSED): iOS
//      usage-description strings reviewed bidirectionally + non-placeholder +
//      plugin-implied keys present; ITSAppUsesNonExemptEncryption explicitly
//      declared (export compliance); ios.privacyManifests shape + reviewed
//      lockstep when declared (never required — SDK packages self-declare
//      their own manifests; absence gets a NOTE); App Tracking Transparency
//      consistency in BOTH directions (no tracking signal → no ATT claims;
//      a signal → all three declarations agree); Android targetSdk floor
//      (declared value, or the pinned per-SDK default — an unknown SDK major
//      fails closed); icon integrity (pure-node PNG parse: the marketing icon
//      1024×1024 opaque, adaptive-icon layers 1024×1024, splash parses;
//      solid-color placeholder art WARNs by default, reds when the policy
//      escalates); and the account-deletion closure (an app shipping an auth
//      surface must ship the deletion surface — Apple 5.1.1(v)).
// SOURCE: docs/harness/README.md (expo-policy gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { cngPurityErrors } from './lib/cng-purity.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { isSolidColor, readPngMeta } from './lib/png.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'expo-policy'
const APP = 'apps/mobile'
const CONFIG = `${APP}/app.config.ts`
const LOCK = 'tools/identity.lock.json'
const PERMS_FILE = 'tools/expo-permissions.json'
const PLUGINS_FILE = 'tools/expo-plugins.json'
// The dark canvas token is read from @app/design-tokens' committed RN adapter — the
// single source apps/mobile paints from (via @app/design-tokens/native). The styleguide
// gate regen-diffs it against the TypeScript token modules.
const TOKENS_FILE = 'packages/design-tokens/src/generated/native.ts'
const EAS_FILE = `${APP}/eas.json`
// The one secret-shape heuristic, shared with the eas.json env-name check and
// the EXPO_PUBLIC_ source scan below.
const SECRET_SHAPE = /(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i
const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

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

// CNG purity runs BEFORE the stamp: git index state is not a hashable stamp
// input, so a freshly-staged native dir must red even on a warm stamp.
failures(GATE, cngPurityErrors())

const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

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

// 1. identity lock — equality against the lock, nothing fancier: a fresh
// install may legitimately pin easProjectId "TBD" until `eas init` runs, and
// the lock<->config LOCKSTEP is the invariant, not the value's prettiness.
function checkIdentity() {
  const lock = readJson(LOCK)
  if (lock === null) return
  const pairs = [
    ['ios.bundleIdentifier', cfg.ios?.bundleIdentifier, lock.appIdentifier],
    ['android.package', cfg.android?.package, lock.appIdentifier],
    ['scheme', cfg.scheme, lock.scheme],
    ['extra.eas.projectId', cfg.extra?.eas?.projectId, lock.easProjectId],
  ]
  for (const [site, got, want] of pairs) {
    if (got !== want) {
      errs.push(
        `identity drift: ${site} is ${JSON.stringify(got)} but ${LOCK} pins ${JSON.stringify(want)} — store identity is immutable after first release; changing the lock is a reviewed human act`,
      )
    }
  }
  const updatesUrl = cfg.updates?.url
  if (typeof updatesUrl === 'string' && !updatesUrl.includes(String(lock.easProjectId))) {
    errs.push(
      `updates.url "${updatesUrl}" does not embed the locked EAS projectId ${JSON.stringify(lock.easProjectId)} — an update URL pointing at another project is a hijacked OTA channel`,
    )
  }
}

// 2 + 3. runtime version + engine floor.
function checkEngine() {
  const rv = cfg.runtimeVersion
  const exact =
    rv !== null &&
    typeof rv === 'object' &&
    !Array.isArray(rv) &&
    rv.policy === 'appVersion' &&
    Object.keys(rv).length === 1
  if (!exact) {
    // SOURCE: https://docs.expo.dev/eas-update/runtime-versions/
    errs.push(
      `runtimeVersion must be exactly { "policy": "appVersion" } (got ${JSON.stringify(rv)}) — the deterministic OTA boundary; the fingerprint policy is a computed hash no PR can review (rejected in the design record)`,
    )
  }
  // SOURCE: https://docs.expo.dev/guides/new-architecture/
  if (cfg.newArchEnabled !== undefined && cfg.newArchEnabled !== true) {
    errs.push(
      `newArchEnabled must be absent or true (got ${JSON.stringify(cfg.newArchEnabled)}) — SDK 57 forces the New Architecture on, so an explicit opt-out is dead config documenting the wrong intent`,
    )
  }
  for (const [prefix, obj] of [
    ['', cfg],
    ['ios.', cfg.ios ?? {}],
    ['android.', cfg.android ?? {}],
  ]) {
    if (obj.jsEngine !== undefined && obj.jsEngine !== 'hermes') {
      errs.push(
        `${prefix}jsEngine must be absent or "hermes" (got ${JSON.stringify(obj.jsEngine)}) — Hermes is the measured engine every perf budget assumes`,
      )
    }
    if (obj.useHermesV1 === false) {
      errs.push(
        `${prefix}useHermesV1: false — Hermes V1 is the SDK 57 default and the harness floor; do not opt back out`,
      )
    }
  }
}

// 4. transport policy.
function checkTransport() {
  const ats = cfg.ios?.infoPlist?.NSAppTransportSecurity
  if (ats !== null && typeof ats === 'object') {
    if (ats.NSAllowsArbitraryLoads === true) {
      errs.push(
        'ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads: true — blanket plaintext HTTP is banned; declare loopback NSExceptionDomains for local dev instead',
      )
    }
    for (const domain of Object.keys(ats.NSExceptionDomains ?? {})) {
      if (domain !== 'localhost' && domain !== '127.0.0.1') {
        errs.push(
          `ATS exception domain "${domain}" — exceptions are loopback-only (localhost, 127.0.0.1); a non-loopback API origin must be https`,
        )
      }
    }
  }
  scanCleartext(cfg, '')
  const origin = cfg.extra?.apiOrigin
  if (typeof origin !== 'string' || origin === '') {
    errs.push(
      'extra.apiOrigin missing from the resolved config — the committed transport target the one-door api client dials',
    )
  } else if (!origin.startsWith('https://') && !LOOPBACK_HTTP.test(origin)) {
    errs.push(
      `extra.apiOrigin "${origin}" — must be https:// or loopback http:// (it is committed transport policy and ships in the bundle by design)`,
    )
  }
}

// Deep-walk for android cleartext opt-ins: the key can appear under android.*
// OR inside an expo-build-properties plugin config entry — one recursive scan
// catches both spellings of the same hole.
function scanCleartext(node, path) {
  if (node === null || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'usesCleartextTraffic' && v === true) {
      errs.push(
        `${path}${k}: true — Android cleartext HTTP is banned everywhere in the resolved config; the API origin is https-or-loopback`,
      )
    }
    scanCleartext(v, `${path}${k}.`)
  }
}

// 5. permission allowlist, bidirectional.
function checkPermissions() {
  const file = readJson(PERMS_FILE)
  if (file === null) return
  const reviewed = new Set()
  for (const entry of file.permissions ?? []) {
    if (
      typeof entry?.name !== 'string' ||
      entry.name === '' ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      errs.push(
        `${PERMS_FILE}: entry ${JSON.stringify(entry)} — every permission needs { name, reason } with a non-empty reviewed reason`,
      )
      continue
    }
    reviewed.add(entry.name)
  }
  const resolved = cfg.android?.permissions ?? []
  for (const p of resolved) {
    if (!reviewed.has(p)) {
      errs.push(
        `android.permissions grants "${p}" with no reviewed reason in ${PERMS_FILE} — a permission is a user-facing promise; add the entry in the same reviewed diff`,
      )
    }
  }
  for (const name of reviewed) {
    if (!resolved.includes(name)) {
      errs.push(
        `${PERMS_FILE} lists "${name}" but the resolved config no longer grants it — stale entries are RED so the allowlist can never quietly over-grant`,
      )
    }
  }
}

// 6. plugin allowlist, bidirectional, by name ([name, config] counts as name).
function checkPlugins() {
  const file = readJson(PLUGINS_FILE)
  if (file === null) return
  const reviewed = new Set()
  for (const entry of file.plugins ?? []) {
    if (
      typeof entry?.name !== 'string' ||
      entry.name === '' ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      errs.push(
        `${PLUGINS_FILE}: entry ${JSON.stringify(entry)} — every plugin needs { name, reason } with a non-empty reviewed reason`,
      )
      continue
    }
    reviewed.add(entry.name)
  }
  const resolvedNames = (cfg.plugins ?? [])
    .map((p) => (Array.isArray(p) ? p[0] : p))
    .filter((n) => typeof n === 'string')
  for (const n of resolvedNames) {
    if (!reviewed.has(n)) {
      errs.push(
        `plugin "${n}" resolves but has no entry in ${PLUGINS_FILE} — a config plugin rewrites the generated native project; review it in with a reason`,
      )
    }
  }
  for (const n of reviewed) {
    if (!resolvedNames.includes(n)) {
      errs.push(
        `${PLUGINS_FILE} lists "${n}" but it no longer resolves — stale entry (the lockstep is bidirectional, so the allowlist mirrors reality)`,
      )
    }
  }
}

// 7a. secret-shaped keys in resolved extra. extra ships in the bundle BY
// DESIGN, so a secret-shaped key there is a shipped secret regardless of value.
// The extra.eas subtree is excluded: EAS metadata (projectId) is public — it is
// printed by `eas init` and asserted against the identity lock above.
function scanExtraKeys(node, path) {
  if (node === null || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (path === 'extra.' && k === 'eas') continue
    if (SECRET_SHAPE.test(k)) {
      errs.push(
        `resolved ${path}${k} is a secret-shaped key in extra — secrets live server-side or in expo-secure-store, never in the config the bundle embeds`,
      )
    }
    scanExtraKeys(v, `${path}${k}.`)
  }
}

// 7b. secret-shaped EXPO_PUBLIC_* names anywhere in mobile source text.
// EXPO_PUBLIC_ vars are inlined into the shipped JS bundle at build time —
// same failure mode as any client-embedded env, so the same name-shape ban.
// SOURCE: https://docs.expo.dev/guides/environment-variables/
function checkPublicEnvNames() {
  const publicSecret = /EXPO_PUBLIC_[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)[A-Za-z0-9_]*/gi
  const files = [CONFIG]
  for (const root of [`${APP}/src`, `${APP}/app`]) {
    for (const rel of walkFiles(root, {
      filter: (p) => /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(p),
    })) {
      files.push(`${root}/${rel}`)
    }
  }
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const m of readFileSync(f, 'utf8').matchAll(publicSecret)) {
      errs.push(
        `${f}: ${m[0]} — EXPO_PUBLIC_ names compile into the shipped bundle; a secret-shaped name there is a shipped secret`,
      )
    }
  }
}

// 8. splash lockstep: both native launch-frame colors equal the GENERATED dark
// canvas token (parsed textually from @app/design-tokens' committed native adapter —
// the gate must not import app TS). Unparsable file fails closed rather than guessing.
function checkSplashLockstep() {
  if (!existsSync(TOKENS_FILE)) {
    errs.push(
      `${TOKENS_FILE} missing — cannot verify the launch-frame lockstep (fails closed); run \`pnpm --filter @app/design-tokens run gen\``,
    )
    return
  }
  const text = readFileSync(TOKENS_FILE, 'utf8')
  const dark = /dark:\s*\{([^}]*)\}/.exec(text)
  const canvas = dark === null ? null : /canvas:\s*'(#[0-9a-fA-F]{3,8})'/.exec(dark[1])
  if (canvas === null) {
    errs.push(
      `could not parse the dark canvas token out of ${TOKENS_FILE} — the lockstep check fails closed rather than guessing a color`,
    )
    return
  }
  const want = canvas[1].toLowerCase()
  const splash = (cfg.plugins ?? []).find(
    (p) => Array.isArray(p) && p[0] === 'expo-splash-screen',
  )?.[1]
  const sites = [
    ['expo-splash-screen plugin backgroundColor', splash?.backgroundColor],
    ['android.adaptiveIcon.backgroundColor', cfg.android?.adaptiveIcon?.backgroundColor],
  ]
  for (const [site, got] of sites) {
    if (typeof got !== 'string' || got.toLowerCase() !== want) {
      errs.push(
        `${site} is ${JSON.stringify(got)} but the generated dark canvas token is "${want}" — the native launch frame must paint the same pixel the first React frame paints, or every cold start flashes`,
      )
    }
  }
}

// 9. eas.json sanity — the committed build/version surface.
// SOURCE: https://docs.expo.dev/eas/json/
// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
function checkEasJson() {
  const eas = readJson(EAS_FILE)
  if (eas === null) return
  if (eas.cli?.appVersionSource !== 'local') {
    errs.push(
      `${EAS_FILE}: cli.appVersionSource must be "local" — the repo is the version source of truth; a remote counter is a version surface no gate can diff`,
    )
  }
  const prod = eas.build?.production
  if (prod === undefined) {
    errs.push(
      `${EAS_FILE}: build.production profile missing — the store path must be committed and reviewable`,
    )
  } else {
    if (prod.distribution !== undefined && prod.distribution !== 'store') {
      errs.push(
        `${EAS_FILE}: build.production.distribution must be absent or "store" (got ${JSON.stringify(prod.distribution)}) — production implies store distribution`,
      )
    }
    if (prod.autoIncrement !== undefined && prod.autoIncrement !== false) {
      errs.push(
        `${EAS_FILE}: build.production.autoIncrement must be false or absent (got ${JSON.stringify(prod.autoIncrement)}) — remote auto-increment moves versioning off the repo`,
      )
    }
  }
  for (const [profile, def] of Object.entries(eas.build ?? {})) {
    for (const name of Object.keys(def?.env ?? {})) {
      if (SECRET_SHAPE.test(name)) {
        errs.push(
          `${EAS_FILE}: build.${profile}.env.${name} — secret-shaped env NAME in a committed profile; secrets go through \`eas env:*\` with secret visibility, never eas.json`,
        )
      }
    }
  }
}

// ---- 11. store readiness (tools/store-policy.json — reviewed data) --------------
const STORE_FILE = 'tools/store-policy.json'
const PLACEHOLDER_STRING = /(TODO|TBD|FIXME|lorem|replace this|^xx+$)/i
// Apple's closed category vocabulary for required-reason APIs — spec data, not
// project policy, so it lives here rather than in the reviewed file.
// SOURCE: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
const PRIVACY_API_CATEGORIES = new Set([
  'NSPrivacyAccessedAPICategoryFileTimestamp',
  'NSPrivacyAccessedAPICategorySystemBootTime',
  'NSPrivacyAccessedAPICategoryDiskSpace',
  'NSPrivacyAccessedAPICategoryActiveKeyboards',
  'NSPrivacyAccessedAPICategoryUserDefaults',
])

/** The resolved plugin names, shared by several store checks. */
function resolvedPluginNames() {
  return (cfg.plugins ?? [])
    .map((p) => (Array.isArray(p) ? p[0] : p))
    .filter((n) => typeof n === 'string')
}

/** One legal accountDeletion shape per surface kind — the reviewed escapes included. */
function accountDeletionShapeOk(ad) {
  return (
    (ad?.surface === 'action' &&
      typeof ad.actionId === 'string' &&
      ad.actionId !== '' &&
      typeof ad.serverPath === 'string' &&
      ad.serverPath.startsWith('/')) ||
    (ad?.surface === 'route' &&
      typeof ad.routeId === 'string' &&
      ad.routeId !== '' &&
      typeof ad.serverPath === 'string') ||
    (ad?.surface === 'external' &&
      typeof ad.url === 'string' &&
      ad.url.startsWith('https://') &&
      typeof ad.reason === 'string' &&
      ad.reason.trim() !== '') ||
    (ad?.surface === 'none' && typeof ad.reason === 'string' && ad.reason.trim() !== '')
  )
}

// Load + shape-check the policy. Malformed fails CLOSED — the store checks can
// never silently disarm; a missing file is a red via readJson.
function loadStorePolicy() {
  const p = readJson(STORE_FILE)
  if (p === null) return null
  const badly = (what) => {
    fail(
      GATE,
      `${STORE_FILE} ${what} — the store-readiness checks cannot silently disarm; fix the policy in a reviewed diff`,
    )
  }
  const sdk = p.androidTargetSdk
  if (!Number.isInteger(sdk?.floor) || sdk.floor <= 0)
    badly('androidTargetSdk.floor must be a positive integer')
  if (
    sdk.expoSdkDefaults === null ||
    typeof sdk.expoSdkDefaults !== 'object' ||
    !Object.values(sdk.expoSdkDefaults).every((v) => Number.isInteger(v) && v > 0)
  ) {
    badly('androidTargetSdk.expoSdkDefaults must map SDK majors to positive integers')
  }
  if (typeof p.iosEncryption?.nonExemptAllowed !== 'boolean')
    badly('iosEncryption.nonExemptAllowed must be a boolean')
  if (
    p.iosEncryption.nonExemptAllowed === true &&
    (typeof p.iosEncryption.reason !== 'string' || p.iosEncryption.reason.trim() === '')
  ) {
    badly('iosEncryption.nonExemptAllowed: true requires a non-empty reason')
  }
  const keyMap = p.usageDescriptionKeysByPlugin
  if (
    keyMap === null ||
    typeof keyMap !== 'object' ||
    !Object.values(keyMap).every(
      (v) => Array.isArray(v) && v.every((k) => typeof k === 'string' && k !== ''),
    )
  ) {
    badly('usageDescriptionKeysByPlugin must map plugin names to arrays of InfoPlist keys')
  }
  if (
    !Array.isArray(p.trackingSdkSignals) ||
    !p.trackingSdkSignals.every((s) => typeof s === 'string' && s !== '')
  ) {
    badly('trackingSdkSignals must be an array of package names')
  }
  if (
    !Array.isArray(p.privacyAccessedApiTypes) ||
    !p.privacyAccessedApiTypes.every(
      (row) =>
        typeof row?.category === 'string' &&
        Array.isArray(row.reasons) &&
        row.reasons.length > 0 &&
        typeof row.why === 'string' &&
        row.why.trim() !== '',
    )
  ) {
    badly('privacyAccessedApiTypes must be an array of { category, reasons (non-empty), why }')
  }
  if (!accountDeletionShapeOk(p.accountDeletion))
    badly(
      'accountDeletion must be one of { surface: "action", actionId, serverPath } | { surface: "route", routeId, serverPath } | { surface: "external", url: https, reason } | { surface: "none", reason }',
    )
  if (p.icons?.solidColorPlaceholder !== 'warn' && p.icons?.solidColorPlaceholder !== 'error') {
    badly('icons.solidColorPlaceholder must be "warn" or "error"')
  }
  return p
}

// 11a. iOS usage-description strings: reviewed bidirectionally (the ios[] list
// in tools/expo-permissions.json — the android allowlist's sibling), never
// placeholder-shaped, and every plugin-implied key present. Pre-prebuild
// honesty: the reviewed map is keyed by PLUGIN because that is the only
// surface visible before prebuild; a bare npm dep touching a sensitive API is
// invisible here — Apple's post-submission validation is the backstop.
// SOURCE: https://developer.apple.com/documentation/bundleresources/information-property-list/protected-resources
function reviewedUsageKeys(file) {
  const reviewed = new Set()
  for (const entry of file.ios ?? []) {
    if (
      typeof entry?.key !== 'string' ||
      entry.key === '' ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      errs.push(
        `${PERMS_FILE}: ios[] entry ${JSON.stringify(entry)} — every usage-description key needs { key, reason } with a non-empty reviewed reason`,
      )
      continue
    }
    reviewed.add(entry.key)
  }
  return reviewed
}

function checkUsageDescriptions(policy) {
  const file = readJson(PERMS_FILE)
  if (file === null) return
  const infoPlist = cfg.ios?.infoPlist ?? {}
  const declared = Object.keys(infoPlist).filter((k) => k.endsWith('UsageDescription'))
  const reviewed = reviewedUsageKeys(file)
  for (const key of declared) {
    if (!reviewed.has(key)) {
      errs.push(
        `ios.infoPlist.${key} declared with no reviewed entry in ${PERMS_FILE} ios[] — a purpose string is a user-facing promise; review it in`,
      )
    }
    const value = infoPlist[key]
    if (typeof value !== 'string' || value.trim().length < 10 || PLACEHOLDER_STRING.test(value)) {
      errs.push(
        `ios.infoPlist.${key} is ${JSON.stringify(value)} — Apple rejects empty or boilerplate purpose strings; write the real sentence a user reads in the permission sheet`,
      )
    }
  }
  for (const key of reviewed) {
    if (!declared.includes(key)) {
      errs.push(
        `${PERMS_FILE} ios[] lists "${key}" but the resolved config declares no such usage string — stale entries are RED so the list mirrors reality`,
      )
    }
  }
  for (const name of resolvedPluginNames()) {
    for (const key of policy.usageDescriptionKeysByPlugin[name] ?? []) {
      if (infoPlist[key] === undefined) {
        errs.push(
          `plugin "${name}" implies ios.infoPlist.${key} but the resolved config declares none — the store build will prompt with a missing/system-default string (a rejection class); declare it in app.config.ts`,
        )
      }
    }
  }
}

// 11b. Export compliance: undeclared means App Store Connect re-asks the
// encryption question on every build — a question no agent can answer.
// SOURCE: https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption
function checkExportCompliance(policy) {
  const its = cfg.ios?.infoPlist?.ITSAppUsesNonExemptEncryption
  if (typeof its !== 'boolean') {
    errs.push(
      `ios.infoPlist.ITSAppUsesNonExemptEncryption is ${JSON.stringify(its)} — export compliance must be DECLARED as a boolean (https-only apps declare false: standard TLS is exempt); undeclared re-asks the question on every TestFlight/App Store build`,
    )
  } else if (its === true && policy.iosEncryption.nonExemptAllowed !== true) {
    errs.push(
      `ios.infoPlist.ITSAppUsesNonExemptEncryption: true but ${STORE_FILE} iosEncryption.nonExemptAllowed is false — shipping non-exempt cryptography is a reviewed decision (set nonExemptAllowed with a reason, and expect export documentation at submission)`,
    )
  }
}

// 11c. Privacy manifests: never REQUIRED (SDK 57 packages self-declare their
// own PrivacyInfo.xcprivacy; an empty guessed app-level block is dead config
// documenting wrong intent) — but whatever IS declared must be well-formed and
// in reviewed lockstep with the policy.
// SOURCE: https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
function checkPrivacyManifests(policy) {
  const pm = cfg.ios?.privacyManifests
  const rows = policy.privacyAccessedApiTypes
  if (pm === undefined) {
    if (rows.length > 0) {
      errs.push(
        `${STORE_FILE} reviews ${String(rows.length)} privacyAccessedApiTypes row(s) but the resolved config declares no ios.privacyManifests — reviewed-but-undeclared; declare the block or drop the rows`,
      )
    } else {
      console.log(
        `${GATE}: NOTE — no ios.privacyManifests declared (fine: SDK packages self-declare their own; the app code touches no required-reason API directly). Before FIRST submission run the dependency sweep in docs/store/ios-privacy-manifests.md (store-metadata module) — this gate validates the shape and lockstep of whatever you declare, it cannot compute the union for you`,
      )
    }
    return
  }
  const declared = pm?.NSPrivacyAccessedAPITypes ?? []
  const reviewedByCategory = new Map(rows.map((row) => [row.category, row]))
  for (const entry of declared) {
    const category = entry?.NSPrivacyAccessedAPIType
    const reasons = entry?.NSPrivacyAccessedAPITypeReasons
    if (typeof category !== 'string' || !PRIVACY_API_CATEGORIES.has(category)) {
      errs.push(
        `ios.privacyManifests NSPrivacyAccessedAPITypes declares category ${JSON.stringify(category)} — not one of Apple's required-reason categories`,
      )
      continue
    }
    if (
      !Array.isArray(reasons) ||
      reasons.length === 0 ||
      !reasons.every((r) => /^[A-Z0-9]{2,5}\.\d+$/.test(String(r)))
    ) {
      errs.push(
        `ios.privacyManifests category ${category}: reasons ${JSON.stringify(reasons)} — must be a non-empty array of Apple reason codes (e.g. "C617.1")`,
      )
    }
    if (!reviewedByCategory.has(category)) {
      errs.push(
        `ios.privacyManifests declares ${category} with no reviewed row in ${STORE_FILE} privacyAccessedApiTypes — declaring a required-reason API is a reviewed human act`,
      )
    }
  }
  const declaredCategories = new Set(declared.map((e) => e?.NSPrivacyAccessedAPIType))
  for (const row of rows) {
    if (!declaredCategories.has(row.category)) {
      errs.push(
        `${STORE_FILE} reviews privacy category "${row.category}" but the resolved config no longer declares it — stale row; remove it`,
      )
    }
  }
}

// 11d. App Tracking Transparency, consistent in BOTH directions.
// SOURCE: https://developer.apple.com/documentation/apptrackingtransparency
function checkTracking(policy) {
  const deps = readJson(`${APP}/package.json`)?.dependencies ?? {}
  const plugins = resolvedPluginNames()
  const signals = policy.trackingSdkSignals.filter(
    (s) => plugins.includes(s) || deps[s] !== undefined,
  )
  const att = cfg.ios?.infoPlist?.NSUserTrackingUsageDescription
  const pm = cfg.ios?.privacyManifests
  if (signals.length === 0) {
    if (att !== undefined) {
      errs.push(
        `ios.infoPlist.NSUserTrackingUsageDescription declared but no tracking SDK is present (${STORE_FILE} trackingSdkSignals) — an ATT string with nothing tracking is an unreviewed tracking claim and a reviewer-question magnet; remove it, or add the SDK signal in review`,
      )
    }
    if (pm?.NSPrivacyTracking === true || (pm?.NSPrivacyTrackingDomains ?? []).length > 0) {
      errs.push(
        'ios.privacyManifests claims NSPrivacyTracking/TrackingDomains but no tracking SDK is present — the three tracking declarations must agree',
      )
    }
    return
  }
  if (typeof att !== 'string' || att.trim().length < 10 || PLACEHOLDER_STRING.test(att)) {
    errs.push(
      `tracking SDK present (${signals.join(', ')}) but ios.infoPlist.NSUserTrackingUsageDescription is ${JSON.stringify(att)} — ATT requires a real purpose string before the prompt can show`,
    )
  }
  if (pm?.NSPrivacyTracking !== true) {
    errs.push(
      `tracking SDK present (${signals.join(', ')}) but ios.privacyManifests.NSPrivacyTracking is not true — the three tracking declarations must agree`,
    )
  }
}

// 11e. Android targetSdk floor — declared value, else the pinned per-SDK
// default; an unknown Expo SDK major fails CLOSED until a human pins it.
// SOURCE: https://developer.android.com/google/play/requirements/target-sdk
function checkTargetSdk(policy) {
  // Annotated, not bare: closure assignments are invisible to the checker's
  // evolving-type inference (the perf-subject-cli precedent) — a bare `let`
  // would read as plain `undefined` at every use below.
  /** @type {number | undefined} */
  let declared
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'targetSdkVersion' && typeof v === 'number') declared = v
      walk(v)
    }
  }
  walk(cfg)
  const { floor, expoSdkDefaults } = policy.androidTargetSdk
  // Copied to a const first: the closure-assigned `let` is exempt from
  // control-flow narrowing (the perf-subject-cli precedent).
  const declaredTarget = declared
  if (declaredTarget !== undefined) {
    if (declaredTarget < floor) {
      errs.push(
        `targetSdkVersion ${String(declaredTarget)} declared below the Play floor ${String(floor)} (${STORE_FILE}) — Play rejects new builds targeting stale API levels`,
      )
    }
    return
  }
  const major = String(cfg.sdkVersion ?? '').split('.')[0]
  const mapped = expoSdkDefaults[major]
  if (mapped === undefined) {
    errs.push(
      `no targetSdkVersion declared and ${STORE_FILE} androidTargetSdk.expoSdkDefaults has no entry for Expo SDK "${major}" — pin the SDK's default targetSdk in a reviewed diff (the check fails closed on an unknown SDK)`,
    )
  } else if (mapped < floor) {
    errs.push(
      `Expo SDK ${major} defaults to targetSdk ${String(mapped)}, below the Play floor ${String(floor)} — declare a compliant targetSdkVersion via expo-build-properties, or update the reviewed mapping`,
    )
  }
}

// 11f. Icon integrity — pure-node PNG parse over the RESOLVED asset paths.
// Solid-color placeholder art is a NOTE by default (the scaffold ships it
// deliberately); the policy escalates it to red as a pre-submission step.
// SOURCE: Apple HIG app icons — the 1024×1024 marketing icon must be opaque
// https://developer.apple.com/design/human-interface-guidelines/app-icons#App-icon-sizes
function iconSitesOf() {
  const sites = []
  if (typeof cfg.icon === 'string') sites.push(['icon', cfg.icon, { square: 1024, opaque: true }])
  else
    errs.push(
      `icon is ${JSON.stringify(cfg.icon)} — the app icon must be declared (Expo derives every store size from it)`,
    )
  const ios = cfg.ios?.icon
  for (const [k, v] of typeof ios === 'string' ? [['ios.icon', ios]] : Object.entries(ios ?? {})) {
    if (typeof v === 'string') sites.push([`ios.icon.${k}`, v, { square: 1024, opaque: true }])
  }
  const adaptive = cfg.android?.adaptiveIcon ?? {}
  for (const key of ['foregroundImage', 'monochromeImage', 'backgroundImage']) {
    if (typeof adaptive[key] === 'string')
      sites.push([`android.adaptiveIcon.${key}`, adaptive[key], { square: 1024 }])
  }
  const splashImage = (cfg.plugins ?? []).find(
    (p) => Array.isArray(p) && p[0] === 'expo-splash-screen',
  )?.[1]?.image
  if (typeof splashImage === 'string') sites.push(['expo-splash-screen image', splashImage, {}])
  return sites
}

function checkIconSite(site, rel, wants, escalate) {
  const path = `${APP}/${rel.replace(/^\.\//, '')}`
  if (!existsSync(path)) {
    errs.push(
      `${site} names "${rel}" but ${path} does not exist — a dangling asset fails the store build long after this chain went green`,
    )
    return
  }
  const buffer = readFileSync(path)
  const meta = readPngMeta(buffer)
  if (meta === null) {
    errs.push(`${site} (${path}) is not a structurally sound PNG — store pipelines reject it`)
    return
  }
  if (wants.square !== undefined && (meta.width !== wants.square || meta.height !== wants.square)) {
    errs.push(
      `${site} (${path}) is ${String(meta.width)}×${String(meta.height)} — must be ${String(wants.square)}×${String(wants.square)} (Expo derives every density from it)`,
    )
  }
  if (wants.opaque === true && meta.hasAlpha) {
    errs.push(
      `${site} (${path}) carries an alpha channel — App Store Connect rejects transparency in the marketing icon; flatten it onto a background`,
    )
  }
  if (isSolidColor(buffer) === true) {
    const line = `${site} (${path}) is a solid-color placeholder — ship real art before submission (flip ${STORE_FILE} icons.solidColorPlaceholder to "error" as the pre-submission step)`
    if (escalate) errs.push(line)
    else console.log(`${GATE}: NOTE — ${line}`)
  }
}

function checkIconIntegrity(policy) {
  const escalate = policy.icons.solidColorPlaceholder === 'error'
  for (const [site, rel, wants] of iconSitesOf()) {
    checkIconSite(site, rel, wants, escalate)
  }
}

// 11g. Account-deletion closure (Apple 5.1.1(v)): an app that ships an auth
// surface ships the deletion surface. The gate proves the surface and endpoint
// EXIST; completeness of the deletion is the RLS suite's live sweep case.
// SOURCE: https://developer.apple.com/app-store/review/guidelines/#5.1.1
function checkAccountDeletion(policy) {
  const authSurface =
    ['tsx', 'jsx', 'ts', 'js'].some((ext) => existsSync(`${APP}/app/sign-in.${ext}`)) ||
    existsSync(`${APP}/src/auth/providers`)
  if (!authSurface) return
  const ad = policy.accountDeletion
  if (ad.surface === 'external' || ad.surface === 'none') return // reviewed escapes, shape-checked above
  if (ad.surface === 'action') {
    const registry = `${APP}/src/features/actions/registry.ts`
    const text = existsSync(registry) ? readFileSync(registry, 'utf8') : ''
    if (!text.includes(`id: '${ad.actionId}'`)) {
      errs.push(
        `the app ships an auth surface but ${registry} registers no '${ad.actionId}' command — Apple 5.1.1(v): account creation requires in-app account deletion (worked pattern: the shipped session.deleteAccount action + DELETE /api/me)`,
      )
    }
  } else {
    const routes = `${APP}/src/routes.ts`
    const text = existsSync(routes) ? readFileSync(routes, 'utf8') : ''
    if (!text.includes(`id: '${ad.routeId}'`)) {
      errs.push(
        `the app ships an auth surface but ${routes} registers no '${ad.routeId}' route — Apple 5.1.1(v) requires an in-app deletion surface`,
      )
    }
  }
  const spec = readJson('apps/server/openapi.json')
  if (spec !== null && spec.paths?.[ad.serverPath]?.delete === undefined) {
    errs.push(
      `the deletion surface points at DELETE ${ad.serverPath} but apps/server/openapi.json declares no such operation — the surface must be backed by a real, contract-visible endpoint`,
    )
  }
}

const storePolicy = loadStorePolicy()

checkIdentity()
checkEngine()
checkTransport()
checkPermissions()
checkPlugins()
scanExtraKeys(cfg.extra ?? {}, 'extra.')
checkPublicEnvNames()
checkSplashLockstep()
checkEasJson()
if (storePolicy !== null) {
  checkUsageDescriptions(storePolicy)
  checkExportCompliance(storePolicy)
  checkPrivacyManifests(storePolicy)
  checkTracking(storePolicy)
  checkTargetSdk(storePolicy)
  checkIconIntegrity(storePolicy)
  checkAccountDeletion(storePolicy)
}

failures(GATE, errs)
recordGreen()
ok(
  GATE,
  'identity locked, appVersion runtime, hermes + new-arch floor, transport pinned, permissions/plugins reviewed, no secret-shaped extra, splash lockstep, eas.json sane, CNG pure; store-ready floor: usage strings reviewed, export compliance declared, privacy-manifest shape + ATT consistent, targetSdk floored, icons sound, account-deletion closed',
)
