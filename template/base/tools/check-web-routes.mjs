#!/usr/bin/env node
// Gate: route-manifest (web half) — every page apps/web/app serves is REGISTERED.
//
// It is the TWIN of check-route-manifest.mjs, not a second mode of it, and both run from the
// one `route-manifest` chain step the way `boundaries` runs check-exports-walls.mjs &&
// check-workspace-deps.mjs. The reason is that the two routers disagree at every rule the
// mobile gate encodes: expo-router maps a trailing `index` file to its parent path and the App
// Router has no `index` convention at all; the App Router has route groups, parallel routes,
// intercepting routes and private `_folder` exclusion, and expo-router has none of them.
// Forcing one parser to serve both would mean branching on surface at every rule, which is two
// parsers with worse names. Both scripts declare `GATE = 'route-manifest'`, so the chain, the
// canary registry and the tiers table all see one control.
//
// WHAT THIS GATE OWES, from docs/harness/enforcement-tiers.md's own words at 0.5.0: "the App
// Router has no equivalent registry, so a web page can land with no id, no title key and no
// declared loading/empty/error states." That is the whole commitment, and it is closed here:
//   1. every page has a page.meta.ts, or is reviewed chrome in tools/web-route-allowlist.json;
//   2. every meta's titleKey RESOLVES in the web catalog (a misspelled key renders itself);
//   3. every declared state test id is actually PRESENT in the route's segment source — the
//      web half has no RNTL states sweep to prove it at runtime, so the gate proves it
//      statically instead of trusting a declaration nothing reads;
//   4. a `null` state is legal only with a reviewed reason (the honest form, vs. a fabricated
//      spinner);
//   5. ids, URLs and state test ids are globally unique;
//   6. the committed apps/web/lib/routes.generated.ts matches what the file tree implies;
//   7. app/not-found.tsx exists — without it an unmatched URL renders Next's built-in 404,
//      which is unbranded, untranslated, and outside every lane this repo runs.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/not-found (the built-in
// not-found UI is used when no not-found.js is provided)
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import {
  discoverPages,
  META_FILE,
  readAllowlist,
  readMetas,
  renderRegistry,
  STATE_KEYS,
} from './lib/web-routes.mjs'

const GATE = 'route-manifest'
const APP_DIR = 'apps/web/app'
const REGISTRY = 'apps/web/lib/routes.generated.ts'
const ALLOWLIST = 'tools/web-route-allowlist.json'
const CATALOG_FILE = 'apps/web/lib/i18n/catalog.ts'

if (!existsSync(APP_DIR)) {
  skipOrFail(GATE, `${APP_DIR} not found (no web surface yet)`)
}

// The message keys a route's titleKey may name. `null` when the web locale seam is not
// installed — an install that predates 0.6.0's web catalog is not forced onto it by this gate.
const catalogKeys = existsSync(CATALOG_FILE)
  ? new Set(
      [...readFileSync(CATALOG_FILE, 'utf8').matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]),
    )
  : null

const { allow, unreachable, errors: allowErrs } = readAllowlist(ALLOWLIST)
if (allowErrs.length > 0) fail(GATE, allowErrs.join('; '))

const pages = discoverPages(APP_DIR)
const { entries, problems } = readMetas(pages, allow)

const errs = [...problems]

// ── the app/ closure, the other direction ────────────────────────────────────────────
// A meta whose page is gone, and an allowlist entry whose page is gone, are both stale DATA
// claiming a surface that does not exist. Closure runs both ways here for the same reason it
// does on the mobile side: a manifest nobody prunes is a manifest that stops describing the
// app one deletion at a time.
const pageDirs = new Set(pages.map((p) => p.dirKey))
for (const name of [...allow].sort()) {
  if (!pageDirs.has(name)) {
    errs.push(
      `${ALLOWLIST} allowlists ${JSON.stringify(name)} but ${APP_DIR}/${name ? `${name}/` : ''}page.* does not exist — stale allowlist entry (remove it)`,
    )
  }
}

const ids = new Set()
const pathOwners = new Map()
const stateIdOwners = new Map()

/** The files a route's own segment owns — its page, its loading/error boundaries, and the
 *  components colocated beside them.
 *
 *  NOT recursive: a nested route segment is a different route, and letting a child's markup
 *  satisfy a parent's declaration is how a state test id gets "found" in a screen the user
 *  never sees it on.
 *
 *  AND NOT the meta file itself. `page.meta.ts` is where the test id is DECLARED, so including
 *  it would make every declaration prove itself — the check would pass for every route,
 *  always, which is the precise shape of vacuous control this repo keeps finding and closing. */
function segmentSource(dirKey) {
  const dir = dirKey === '' ? APP_DIR : `${APP_DIR}/${dirKey}`
  let names = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.[jt]sx?$/.test(d.name) && d.name !== META_FILE)
      .map((d) => d.name)
      .sort()
  } catch {
    return ''
  }
  return names.map((n) => readFileSync(`${dir}/${n}`, 'utf8')).join('\n')
}

for (const entry of entries) {
  const name = entry.id
  if (ids.has(name)) {
    errs.push(`${entry.metaPath}: duplicate route id ${JSON.stringify(name)}`)
  }
  ids.add(name)

  if (catalogKeys !== null && !catalogKeys.has(entry.titleKey)) {
    errs.push(
      `${name}: titleKey '${entry.titleKey}' is not a key in ${CATALOG_FILE} — the browser tab would render the key itself. Add the message, or fix the key.`,
    )
  }

  if (pathOwners.has(entry.path)) {
    errs.push(
      `${name}: two pages resolve to the URL ${JSON.stringify(entry.path)} — also served by "${pathOwners.get(entry.path)}". Route groups do not create distinct URLs, so two pages under different groups at the same position are a build-time conflict, not two routes.`,
    )
  } else {
    pathOwners.set(entry.path, name)
  }

  const source = segmentSource(entry.dirKey)
  const seenInEntry = new Map()
  for (const key of STATE_KEYS) {
    const testId = entry.states[key]
    if (testId === undefined || testId === '') {
      errs.push(
        `${entry.metaPath}: states.${key} missing or empty — every route declares a ${key}-state test id (or a documented null, see ${ALLOWLIST})`,
      )
      continue
    }
    if (testId === null) {
      if (!unreachable.has(`${name}.${key}`)) {
        errs.push(
          `${entry.metaPath}: states.${key} is null with no documented reason — a null state is legal ONLY with a reviewed {route: "${name}", state: "${key}", reason} entry in ${ALLOWLIST} unreachableStates (why can this route never be ${key}?)`,
        )
      }
      continue
    }
    if (seenInEntry.has(testId)) {
      errs.push(
        `${entry.metaPath}: states.${key} test id ${JSON.stringify(testId)} duplicates states.${seenInEntry.get(testId)} in the same meta — each state needs a distinct test id`,
      )
      continue
    }
    seenInEntry.set(testId, key)
    if (stateIdOwners.has(testId)) {
      errs.push(
        `${name}: states.${key} test id ${JSON.stringify(testId)} is already used by ${stateIdOwners.get(testId)} — state test ids must be globally unique across the registry`,
      )
    } else {
      stateIdOwners.set(testId, `${name}.${key}`)
    }
    // The declaration must be TRUE. Either the segment renders the literal, or it renders the
    // declaration itself (`data-testid={meta.states.empty}`) — the second form is stronger,
    // because then the rendered id cannot drift from the declared one at all.
    if (!source.includes(testId) && !source.includes(`states.${key}`)) {
      errs.push(
        `${name}: states.${key} declares test id ${JSON.stringify(testId)} but nothing under ${APP_DIR}/${entry.dirKey} renders it — the web half has no runtime states sweep, so an undeclared-but-unrendered state is a claim nothing checks. Render it (\`data-testid={meta.states.${key}}\` is the form that cannot drift), or declare the state null with a reviewed reason.`,
      )
    }
  }
}

// ── required chrome ──────────────────────────────────────────────────────────────────
if (!['tsx', 'ts', 'jsx', 'js'].some((ext) => existsSync(`${APP_DIR}/not-found.${ext}`))) {
  errs.push(
    `${APP_DIR}/not-found.tsx is MISSING — the unmatched-route surface is required chrome. Without it Next renders its own built-in 404: unbranded, untranslated, and outside every lane this repo runs.`,
  )
}

// ── stale unreachableStates ──────────────────────────────────────────────────────────
const stateOf = new Map(entries.map((e) => [e.id, e.states]))
for (const [key, reason] of [...unreachable].sort()) {
  const dot = key.lastIndexOf('.')
  const route = key.slice(0, dot)
  const state = key.slice(dot + 1)
  const states = stateOf.get(route)
  if (states === undefined) {
    errs.push(
      `${ALLOWLIST} unreachableStates documents "${key}" but no page.meta.ts declares id '${route}' — stale entry (remove it). Reason on record: ${JSON.stringify(reason)}`,
    )
    continue
  }
  if (states[state] !== null) {
    errs.push(
      `${ALLOWLIST} unreachableStates documents "${key}" but that route declares states.${state} with a real test id — stale entry (the state became reachable; remove the row)`,
    )
  }
}

// ── the committed registry ───────────────────────────────────────────────────────────
// Checked LAST, and only when nothing above failed: a registry cannot be compared against a
// route set the gate has already reported as unreadable, and reporting "stale artifact" on top
// of "this page has no meta" buries the finding that has an action attached to it.
if (errs.length === 0) {
  const expected = renderRegistry(entries)
  const committed = existsSync(REGISTRY) ? readFileSync(REGISTRY, 'utf8') : null
  if (committed === null) {
    errs.push(
      `${REGISTRY} does not exist — the route registry is a COMMITTED artifact (apps/web imports it). Run \`node tools/gen-web-routes.mjs\` and commit it.`,
    )
  } else if (committed !== expected) {
    errs.push(
      `${REGISTRY} is stale — ${APP_DIR}'s route set changed without regenerating. Run \`pnpm gen\` and commit the diff.`,
    )
  }
}

// THE RAMP. An install created before 0.6.0 has pages and no page.meta.ts anywhere, so every
// finding above would land at once on an upgrade the consumer did not ask for. Projects grow
// into gates; gates never ambush an update. It expires at 0.7.0, after which the same findings
// are hard failures — see docs/runbooks/harness-upgrade.md.
//
// THE FINDINGS CONDITION COMES FIRST, and the order is load-bearing rather than stylistic.
// `rampNote` PRINTS its NOTE line on every armed call, findings or none, and `graduate`
// refuses while any line matching `NOTE —` and `ramp` stands. So a ramp evaluated before its
// findings are known announces itself on a CLEAN tree — and since only `graduate` advances
// baseVersion, and baseVersion is what disarms the ramp, that install could never graduate at
// all. This gate shipped that way for exactly one wave; the upgrade lane is what found it.
if (
  errs.length > 0 &&
  rampNote(
    GATE,
    '0.6.0',
    'the web route registry (apps/web/lib/routes.generated.ts + a page.meta.ts per page)',
    { until: '0.7.0' },
  )
) {
  console.log(
    `${GATE}: NOTE — ${String(errs.length)} web-route finding(s) withheld by the 0.6.0 ramp:`,
  )
  for (const e of errs) console.log(`  - ${e}`)
  ok(
    GATE,
    `web half NOTE-only on this pre-0.6.0 install (${String(errs.length)} finding(s) listed above; the ramp expires in 0.7.0)`,
  )
}

failures(
  GATE,
  errs,
  `Give the page a ${APP_DIR}/<segment>/page.meta.ts ({id, titleKey, states}) and regenerate with \`pnpm gen\` — or (human decision) allowlist the chrome page, or document a provably-unreachable state, with a reason in ${ALLOWLIST}.`,
)
ok(
  GATE,
  `web: ${String(entries.length)} route(s), ${String(pages.length)} page file(s), ${String(allow.size)} reviewed chrome — ids and URLs unique, every titleKey resolves, every declared state test id rendered, ${REGISTRY} in sync, not-found present`,
)
