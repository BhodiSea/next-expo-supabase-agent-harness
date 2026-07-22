#!/usr/bin/env node
// Gate: store-config — structural validation of the EAS Metadata store config
// (store-metadata module). This is the credential-free leg of the
// store-metadata-push workflow: it runs on EVERY dispatch, EXPO_TOKEN or not,
// so even a degraded (no-token) run proves the committed listing is pushable.
// Deliberately dependency-free (node:fs + tools/lib only) — the degraded CI leg
// runs it without a pnpm install.
//
// Two layers:
//   1. schema-lite bounds — the field lengths/shapes the published
//      store.config.json schema enforces, so a red lands HERE with a named
//      field instead of inside `eas metadata:push` output;
//   2. sentinel refusal — the module ships example.com URLs and "Replace ..."
//      prose; pushing those to App Store Connect would be publishing a lie, so
//      the gate fails until the listing is really written. The FIRST dispatch
//      after enabling therefore fails BY DESIGN — that red is the module's
//      anti-vacuity proof (see docs/modules/store-metadata/README.md).
//   node tools/check-store-config.mjs                     # apps/mobile/store.config.json
//   node tools/check-store-config.mjs path/to/config.json # another copy
// SOURCE: docs/harness/gates-catalog.md (store-metadata module)
// Field bounds mirror the published store config schema (EAS Metadata, beta):
// SOURCE: https://docs.expo.dev/eas/metadata/schema/
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok } from './lib/gate.mjs'

const GATE = 'store-config'
const CONFIG_PATH = process.argv[2] ?? 'apps/mobile/store.config.json'

// Scaffold sentinels. example.com is IANA-reserved documentation space, so a
// real listing never legitimately carries it; "Replace ..." is the module's own
// placeholder prose; a surviving double-brace installer token means the file
// was never rendered (a broken copy, not a listing).
const SENTINELS = [/example\.com/i, /^Replace /, /\{\{[A-Z0-9_]+\}\}/]

const problems = []

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Bounds check for OPTIONAL string fields: undefined passes (the schema marks
// most fields optional); a present field must be a string inside [min, max].
function checkLen(where, value, min, max) {
  if (value === undefined) return
  if (typeof value !== 'string') {
    problems.push(`${where}: must be a string`)
    return
  }
  if (value.length < min || value.length > max) {
    problems.push(`${where}: length ${String(value.length)} outside ${String(min)}-${String(max)}`)
  }
}

function checkUrl(where, value) {
  if (value === undefined) return
  checkLen(where, value, 1, 255)
  if (typeof value !== 'string') return
  let protocol = null
  try {
    protocol = new URL(value).protocol
  } catch {
    // unparseable — reported below
  }
  if (protocol !== 'https:') {
    problems.push(`${where}: must be an https:// URL (got ${JSON.stringify(value)})`)
  }
}

function checkKeywords(where, keywords) {
  if (keywords === undefined) return
  if (!Array.isArray(keywords)) {
    problems.push(`${where}.keywords: must be an array of strings`)
    return
  }
  const seen = new Set()
  keywords.forEach((k, i) => {
    const at = `${where}.keywords[${String(i)}]`
    if (typeof k !== 'string' || k.length < 1 || k.length > 100) {
      problems.push(`${at}: must be a 1-100 character string`)
      return
    }
    if (seen.has(k.toLowerCase())) problems.push(`${at}: duplicate keyword ${JSON.stringify(k)}`)
    seen.add(k.toLowerCase())
  })
}

function checkLocale(tag, info) {
  const where = `apple.info[${JSON.stringify(tag)}]`
  if (!isPlainObject(info)) {
    problems.push(`${where}: must be an object of listing fields`)
    return
  }
  if (info.title === undefined) problems.push(`${where}.title: required`)
  checkLen(`${where}.title`, info.title, 2, 30)
  checkLen(`${where}.subtitle`, info.subtitle, 0, 30)
  checkLen(`${where}.description`, info.description, 10, 4000)
  checkLen(`${where}.releaseNotes`, info.releaseNotes, 0, 4000)
  checkLen(`${where}.promoText`, info.promoText, 0, 170)
  if (info.privacyPolicyUrl === undefined) {
    problems.push(
      `${where}.privacyPolicyUrl: required — App Store listings must link a privacy policy`,
    )
  }
  checkUrl(`${where}.privacyPolicyUrl`, info.privacyPolicyUrl)
  checkUrl(`${where}.supportUrl`, info.supportUrl)
  checkUrl(`${where}.marketingUrl`, info.marketingUrl)
  checkKeywords(where, info.keywords)
}

function checkReview(review) {
  if (review === undefined) return
  const where = 'apple.review'
  if (!isPlainObject(review)) {
    problems.push(`${where}: must be an object`)
    return
  }
  for (const field of ['firstName', 'lastName', 'email', 'phone']) {
    checkLen(`${where}.${field}`, review[field], 1, 255)
  }
  if (typeof review.email === 'string' && !review.email.includes('@')) {
    problems.push(`${where}.email: not an email address`)
  }
  checkLen(`${where}.notes`, review.notes, 2, 4000)
  // A committed demo credential is a leaked credential. EAS Metadata supports a
  // DYNAMIC config (store.config.js reading env) for exactly this case — or run
  // `eas metadata:push` from an operator machine. Both are documented in
  // docs/store/app-review-notes.md.
  if (review.demoPassword !== undefined) {
    problems.push(
      `${where}.demoPassword: never commit a demo credential — inject it at push time via a dynamic store config or an operator-run push`,
    )
  }
}

// Depth-first sweep over every string in the parsed config, so a sentinel
// hiding in ANY field (not just the ones the bounds checks name) is refused.
function sweepSentinels(node, path) {
  if (typeof node === 'string') {
    if (SENTINELS.some((re) => re.test(node))) {
      problems.push(
        `${path}: still carries a scaffold sentinel (${JSON.stringify(node.slice(0, 60))}) — write the real listing before pushing`,
      )
    }
    return
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      sweepSentinels(v, `${path}[${String(i)}]`)
    })
    return
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) sweepSentinels(v, path === '' ? k : `${path}.${k}`)
  }
}

if (!existsSync(CONFIG_PATH)) {
  fail(
    GATE,
    `${CONFIG_PATH} not found — the store-metadata module plants it there (or pass an explicit path)`,
  )
}

let config
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
} catch (e) {
  fail(GATE, `${CONFIG_PATH} is not valid JSON (${e instanceof Error ? e.message : String(e)})`)
}

if (!isPlainObject(config)) fail(GATE, `${CONFIG_PATH}: top level must be a JSON object`)

if (config.configVersion !== 0) {
  problems.push('configVersion: must be the number 0 (the current store.config schema version)')
}
if (!isPlainObject(config.apple)) {
  problems.push(
    'apple: required object — EAS Metadata is Apple-only; the Play side is docs/store/play-data-safety.md',
  )
} else {
  const info = config.apple.info
  if (!isPlainObject(info) || Object.keys(info).length === 0) {
    problems.push('apple.info: at least one locale entry (e.g. "en-US") is required')
  } else {
    for (const [tag, entry] of Object.entries(info)) checkLocale(tag, entry)
  }
  checkReview(config.apple.review)
}

sweepSentinels(config, '')

failures(
  GATE,
  problems,
  `HINT: edit ${CONFIG_PATH} (schema: https://docs.expo.dev/eas/metadata/schema/ — the Expo Tools VS Code extension autocompletes it)`,
)
const locales =
  isPlainObject(config.apple) && isPlainObject(config.apple.info)
    ? Object.keys(config.apple.info).length
    : 0
ok(GATE, `${CONFIG_PATH} structurally valid (${String(locales)} locale(s), no sentinel values)`)
