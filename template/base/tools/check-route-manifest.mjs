#!/usr/bin/env node
// Gate: route-manifest — every screen the mobile app ships is REGISTERED. The
// canonical manifest (apps/mobile/src/routes.ts, `export const ROUTES`) must be
// non-empty; every entry must carry id / titleKey / path / file plus the three
// canonical state test ids (states.loading/empty/error — the RNTL states sweep
// drives each one, the Maestro device flows and startup budgets iterate the
// same array); and every route file under apps/mobile/app/ must be claimed by
// EXACTLY ONE entry (file AND path agreeing with what expo-router actually
// serves) or be allowlisted chrome in tools/route-allowlist.json
// (write-guard-protected, human-reviewed, reasons required) — so a screen can
// never ship outside the states/device-flow/startup-budget closure. Closure
// runs BOTH ways: manifest entries naming missing files and allowlist entries
// naming missing files are stale data and fail too. Static and <100ms:
// entry-level parsing of the ROUTES array literal (brace-depth split +
// per-field regex on each entry), not substring vibes.
//
// The file→URL derivation mirrors expo-router's own rules, so the manifest's
// `path` cannot silently disagree with the URL the router serves: "(group)"
// segments contribute nothing to the URL, a trailing `index` file maps to its
// parent path, `[param]` is a dynamic segment (declared `:param` here) and
// `[...param]` a catch-all (declared `*param`). Layout files (_layout.*),
// the unmatched-route surface (+not-found.*), +html.* and API routes (an api/
// directory or *+api.* files) are router plumbing, not screens — excluded from
// enumeration by pattern. app/+not-found.* itself is REQUIRED: without it a
// bad deep link lands on the router's default screen instead of the app's.
// SOURCE: https://docs.expo.dev/router/basics/notation/ (groups, index, [param], +not-found)
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'route-manifest'
const ROUTES_FILE = 'apps/mobile/src/routes.ts'
const APP_DIR = 'apps/mobile/app'
const ALLOWLIST = 'tools/route-allowlist.json'
const CATALOG_FILE = 'apps/mobile/src/i18n/catalog.ts'

// The message keys a route's titleKey may name. `null` when the locale seam is not installed —
// a project that has not adopted i18n keeps the older `title:` prose form and is not forced onto it.
const catalogKeys = existsSync(CATALOG_FILE)
  ? new Set(
      [...readFileSync(CATALOG_FILE, 'utf8').matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]),
    )
  : null
const STATE_KEYS = ['loading', 'empty', 'error']
// A canonical expo-router URL path: root `/`, or `/`-led lowercase kebab
// segments — `:param` for a dynamic segment, `*param` for a catch-all — with
// no trailing slash, whitespace, query (`?`) or hash (`#`). The router matches
// these literally, so a stray space or capital is a silently-dead route.
const PATH_RE = /^\/$|^\/[:*]?[a-z0-9-]+(?:\/[:*]?[a-z0-9-]+)*$/
// A manifest `file`: an app/-relative module path, extension omitted — plain
// segments, "(group)" segments, "[param]" / "[...param]" segments.
const FILE_SEG = String.raw`(?:\([a-z0-9-]+\)|\[(?:\.\.\.)?[a-z0-9-]+\]|[a-z0-9-]+)`
const FILE_RE = new RegExp(`^${FILE_SEG}(?:/${FILE_SEG})*$`)
// Router plumbing, never a screen: layouts, the unmatched-route surface, the
// html shell, API routes (an api/ directory or the *+api.* file convention).
const EXCLUDED_FILE_RE = /(?:^|\/)(?:_layout|\+not-found|\+html)\.[jt]sx?$|\+api\.[jt]sx?$/
const CODE_FILE_RE = /\.[jt]sx?$/

if (!existsSync('apps/mobile/src')) {
  skipOrFail(GATE, 'apps/mobile/src not found (no mobile surface yet)')
}
if (!existsSync(ROUTES_FILE)) {
  skipOrFail(
    GATE,
    `${ROUTES_FILE} not found (no route manifest yet) — export ROUTES entries {id, titleKey, path, file, states:{loading,empty,error}}`,
  )
}

// 1. Allowlist — the ONE escape hatch, so its parse fails LOUD, never open.
//    Canonical shape: { "comment": string,
//                       "allow": [{ "name": <app/ file, ext omitted>, "reason": string }],
//                       "unreachableStates": [{ "route": id, "state": key, "reason": string }] }
//    `allow` names chrome (shell surfaces with no canonical data states);
//    `unreachableStates` is the honest escape for a `states` value of null —
//    a state a screen provably cannot enter (e.g. a static in-process data
//    source has no loading or error), documented instead of faked.
const allow = new Set()
const unreachable = new Map() // `${route}.${state}` -> reason
if (existsSync(ALLOWLIST)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOWLIST} is not valid JSON (${e.message}) — the allowlist must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.allow)) {
    fail(
      GATE,
      `${ALLOWLIST} must carry an "allow" ARRAY of {name, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed.allow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.name === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${ALLOWLIST}: every allow entry must be {"name": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    allow.add(entry.name)
  }
  for (const entry of parsed.unreachableStates ?? []) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.route === 'string' &&
      STATE_KEYS.includes(entry.state) &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${ALLOWLIST}: every unreachableStates entry must be {"route": id, "state": loading|empty|error, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    unreachable.set(`${entry.route}.${entry.state}`, entry.reason)
  }
}

// 2. Extract the ROUTES array literal (comments stripped first — they legally
//    contain field names and braces).
const src = readFileSync(ROUTES_FILE, 'utf8')
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n')
const arr = code.match(/export const ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const/)
if (arr === null) {
  fail(
    GATE,
    `${ROUTES_FILE} must export \`const ROUTES = [ … ] as const satisfies …\` — the canonical route manifest is gone`,
  )
}

// 3. Entry-level split: top-level { … } groups by brace depth. The `states`
//    sub-object nests one level, so entries are the depth-0 groups.
function splitEntries(body) {
  const entries = []
  let depth = 0
  let start = -1
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        entries.push(body.slice(start, i + 1))
        start = -1
      }
    }
  }
  return entries
}

const entries = splitEntries(arr[1])
if (entries.length === 0) {
  fail(
    GATE,
    `${ROUTES_FILE}: ROUTES is EMPTY — an empty manifest makes every routes-driven test lane a vacuous pass; register the app's screens`,
  )
}

const errs = []
const ids = new Set()
// path -> first entry that claimed it; file -> first entry that claimed it;
// test-id -> `${entry}.${key}`. All closures are GLOBAL across the manifest: a
// duplicate path routes two screens to one URL, a duplicate file registers one
// screen twice, and a reused state test id makes the sweeps assert against the
// wrong screen's tree.
const pathOwners = new Map()
const fileOwners = new Map()
const stateIdOwners = new Map()

// A route's title is its most visible copy — the tab label and the header on
// every screen. So the manifest carries a message KEY, not the prose:
// `titleKey: 'route.home'`. Prose here would be a hardcoded English string in
// the one file every screen must register in — the last place it should be
// possible. The key must RESOLVE: a manifest naming a key the catalog does not
// carry (a misspelled 'route.home', say) would render the raw key itself in
// the tab bar — visible, but only to whoever looked. Checked
// against the catalog when the locale seam is installed; without it (a project
// that has not adopted i18n) the older `title:` prose form is still accepted,
// so this gate does not force the seam on anyone.
function checkTitle(entry, name) {
  const titleKey = entry.match(/\btitleKey:\s*['"]([^'"]+)['"]/)?.[1]
  if (titleKey === undefined) {
    if (entry.match(/\btitle:\s*['"]([^'"]+)['"]/) === null) {
      errs.push(
        `${name}: missing \`titleKey\` (a message key in ${CATALOG_FILE}, e.g. titleKey: 'route.home'). A route's title is copy: it renders in the tab bar and the header, so it belongs in the catalog, not in the manifest.`,
      )
    }
  } else if (catalogKeys !== null && !catalogKeys.has(titleKey)) {
    errs.push(
      `${name}: titleKey '${titleKey}' is not a key in ${CATALOG_FILE} — the tab bar would render the key itself. Add the message, or fix the key.`,
    )
  }
}

function checkPath(entry, name) {
  const pathMatch = entry.match(/\bpath:\s*['"]([^'"]*)['"]/)
  if (pathMatch === null) {
    errs.push(`${name}: missing \`path\` (the URL expo-router serves the screen at)`)
    return
  }
  const path = pathMatch[1]
  if (!PATH_RE.test(path)) {
    errs.push(
      `${name}: path ${JSON.stringify(path)} is not a canonical route path — need a leading slash and lowercase [a-z0-9-] segments (\`/\`, \`/foo\`, \`/foo/:id\`), no trailing slash, whitespace, query, or hash`,
    )
  }
  if (pathOwners.has(path)) {
    errs.push(
      `${name}: duplicate path ${JSON.stringify(path)} — also declared by "${pathOwners.get(path)}"; each screen needs a distinct route path`,
    )
  } else {
    pathOwners.set(path, name)
  }
}

function checkFile(entry, name) {
  const fileMatch = entry.match(/\bfile:\s*['"]([^'"]+)['"]/)
  if (fileMatch === null) {
    errs.push(
      `${name}: missing \`file\` (the app/-relative module that renders the screen, extension omitted — e.g. file: '(tabs)/index')`,
    )
    return
  }
  const file = fileMatch[1]
  if (!FILE_RE.test(file)) {
    errs.push(
      `${name}: file ${JSON.stringify(file)} is not an app/-relative module path — lowercase [a-z0-9-] segments, "(group)" or "[param]" segments, no extension, no leading slash`,
    )
  }
  if (fileOwners.has(file)) {
    errs.push(
      `${name}: duplicate file ${JSON.stringify(file)} — also claimed by "${fileOwners.get(file)}"; one screen file, one manifest entry`,
    )
  } else {
    fileOwners.set(file, name)
  }
}

// Each canonical state declares the test id its surface exposes — or `null`,
// the HONEST form for a state the screen provably cannot enter, legal ONLY
// with a reviewed {route, state, reason} row in the allowlist. A fabricated
// spinner would satisfy a dumber gate; a documented null satisfies this one.
function checkStates(entry, name, id) {
  const states = entry.match(/\bstates:\s*\{([\s\S]*?)\}/)
  if (states === null) {
    errs.push(
      `${name}: missing \`states\` — declare the loading/empty/error test ids (the states sweep drives each one)`,
    )
    return
  }
  const seenInEntry = new Map() // test-id -> the key that first used it in THIS entry
  for (const key of STATE_KEYS) {
    const sel = states[1].match(new RegExp(`\\b${key}:\\s*(null|'[^']*'|"[^"]*")`))
    if (sel === null || sel[1] === "''" || sel[1] === '""') {
      errs.push(
        `${name}: states.${key} missing or empty — every screen declares a ${key}-state test id (or a documented null, see ${ALLOWLIST})`,
      )
      continue
    }
    if (sel[1] === 'null') {
      if (!unreachable.has(`${id}.${key}`)) {
        errs.push(
          `${name}: states.${key} is null with no documented reason — a null state is legal ONLY with a reviewed {route: "${id}", state: "${key}", reason} entry in ${ALLOWLIST} unreachableStates (why can this screen never be ${key}?)`,
        )
      }
      continue
    }
    const testId = sel[1].slice(1, -1).trim()
    if (seenInEntry.has(testId)) {
      errs.push(
        `${name}: states.${key} test id ${JSON.stringify(testId)} duplicates states.${seenInEntry.get(testId)} in the same entry — each state needs a distinct test id`,
      )
      continue
    }
    seenInEntry.set(testId, key)
    if (stateIdOwners.has(testId)) {
      errs.push(
        `${name}: states.${key} test id ${JSON.stringify(testId)} is already used by ${stateIdOwners.get(testId)} — state test ids must be globally unique across the manifest`,
      )
    } else {
      stateIdOwners.set(testId, `${name}.${key}`)
    }
  }
}

entries.forEach((entry, i) => {
  const id = entry.match(/\bid:\s*['"]([a-z0-9-]+)['"]/)?.[1]
  const name = id ?? `ROUTES[${i}]`
  if (id === undefined) {
    errs.push(`${name}: missing \`id\` (a lowercase [a-z0-9-] string literal)`)
  } else if (ids.has(id)) {
    errs.push(`${name}: duplicate route id`)
  }
  if (id !== undefined) ids.add(id)
  checkTitle(entry, name)
  checkPath(entry, name)
  checkFile(entry, name)
  checkStates(entry, name, id ?? name)
})

// 4. The app/ closure, both directions — the router's file tree IS the set of
//    screens the app ships, so every route file must be claimed by exactly one
//    entry (with the path the router will actually serve) or be reviewed chrome.

// expo-router's file→URL derivation (see the SOURCE line in the header):
// "(group)" contributes nothing, trailing `index` maps to the parent path,
// [param] -> :param, [...param] -> *param.
function deriveRoutePath(fileKey) {
  const segments = []
  for (const raw of fileKey.split('/')) {
    if (raw.startsWith('(') && raw.endsWith(')')) continue
    const catchAll = /^\[\.\.\.([a-z0-9-]+)\]$/.exec(raw)
    if (catchAll !== null) {
      segments.push(`*${catchAll[1]}`)
      continue
    }
    const param = /^\[([a-z0-9-]+)\]$/.exec(raw)
    segments.push(param === null ? raw : `:${param[1]}`)
  }
  if (segments.at(-1) === 'index') segments.pop()
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

const appFileExists = (key) =>
  ['tsx', 'ts', 'jsx', 'js'].some((ext) => existsSync(`${APP_DIR}/${key}.${ext}`))

// The unmatched-route surface is REQUIRED chrome: without app/+not-found.* a
// bad deep link renders the router's default screen — unbranded, untranslated,
// outside every test lane. Its absence is a red, not a note.
if (!appFileExists('+not-found')) {
  errs.push(
    `${APP_DIR}/+not-found.tsx is MISSING — the unmatched-route surface is required chrome (a bad deep link must land on the app's own screen, not the router default)`,
  )
}

const routeFiles = walkFiles(APP_DIR, {
  filter: (rel) => CODE_FILE_RE.test(rel) && !EXCLUDED_FILE_RE.test(rel) && !/^api\//.test(rel),
}).map((rel) => rel.replace(CODE_FILE_RE, ''))

for (const fileKey of routeFiles) {
  const owner = fileOwners.get(fileKey)
  const derived = deriveRoutePath(fileKey)
  if (owner === undefined) {
    if (allow.has(fileKey)) continue
    errs.push(
      `${APP_DIR}/${fileKey}: route file claimed by NO ROUTES entry — the screen ships outside the states/device-flow/startup-budget closure (expo-router serves it at ${JSON.stringify(derived)}). Register it in ${ROUTES_FILE}, or (human decision) allowlist it as chrome with a reason in ${ALLOWLIST}.`,
    )
    continue
  }
  if (allow.has(fileKey)) {
    errs.push(
      `${APP_DIR}/${fileKey}: claimed by ROUTES entry "${owner}" AND allowlisted as chrome in ${ALLOWLIST} — a screen is content or chrome, never both; remove one`,
    )
  }
  const declared = [...pathOwners].find(([, n]) => n === owner)?.[0]
  if (declared !== undefined && declared !== derived) {
    errs.push(
      `${owner}: path ${JSON.stringify(declared)} disagrees with the URL expo-router serves for file '${fileKey}' (${JSON.stringify(derived)}) — the manifest is lying about how the screen is reached`,
    )
  }
}

const routeFileSet = new Set(routeFiles)
for (const [file, owner] of [...fileOwners].sort()) {
  if (!routeFileSet.has(file)) {
    errs.push(
      `${owner}: file '${file}' does not exist under ${APP_DIR}/ (or is router plumbing excluded by pattern) — stale manifest entry`,
    )
  }
}
for (const name of [...allow].sort()) {
  if (!appFileExists(name)) {
    errs.push(
      `${ALLOWLIST} allowlists "${name}" but ${APP_DIR}/${name}.* does not exist — stale allowlist entry (remove it)`,
    )
  }
}
for (const [key, reason] of [...unreachable].sort()) {
  const dot = key.lastIndexOf('.')
  const route = key.slice(0, dot)
  const state = key.slice(dot + 1)
  if (!ids.has(route)) {
    errs.push(
      `${ALLOWLIST} unreachableStates documents "${key}" but no ROUTES entry has id '${route}' — stale entry (remove it). Reason on record: ${JSON.stringify(reason)}`,
    )
    continue
  }
  const entry = entries.find((e) => new RegExp(`\\bid:\\s*['"]${route}['"]`).test(e))
  if (entry !== undefined && !new RegExp(`\\b${state}:\\s*null\\b`).test(entry)) {
    errs.push(
      `${ALLOWLIST} unreachableStates documents "${key}" but ${ROUTES_FILE} declares states.${state} with a real test id — stale entry (the state became reachable; remove the row)`,
    )
  }
}

failures(
  GATE,
  errs,
  `Register the screen in ${ROUTES_FILE} (id/titleKey/path/file/states) or (human decision) allowlist the chrome file — or document a provably-unreachable state — with a reason in ${ALLOWLIST}.`,
)
ok(
  GATE,
  `${entries.length} route(s), ${routeFiles.length} route file(s): ids unique, states declared (or documented unreachable), file↔path↔manifest closure holds both ways, +not-found present`,
)
