// tools/lib/observability.mjs — pure helpers for the observability containment gate
// (tools/check-observability.mjs). Split out so each half is unit-testable without a
// fixture tree and the gate script stays under the complexity ceiling.
//
// WHAT "VENDOR TELEMETRY" MEANS HERE: an SDK whose purpose is to TRANSPORT operational
// data (logs, traces, crashes, analytics events) off the device or server. The seam
// header (packages/platform/observability/src/index.ts, "NO VENDOR SDK, on purpose")
// is the invariant this file makes decidable: a vendor transport attaches at a SINK,
// behind the redaction pass, so by the time it sees a record no raw value is left in it.
// An import of one of these packages anywhere else is a second, unredacted egress path.
//
// THE FLOOR IS DATA THE GATE OWNS. tools/observability.json (seeded — the consumer
// registers their own sinks in it) carries the working vendorSpecifiers list, but the
// gate reds when that list is missing any entry below: a detector a consumer can narrow
// is an escape, and this file rides `update`, so detector improvements reach installs.
// SOURCE: docs/harness/gates-catalog.md ("observability") [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toPosix, walkFiles } from './fs-walk.mjs'
import { blankComments, lineOf } from './source-text.mjs'

// Package names (exact, subpath-inclusive) and scope/name prefixes (trailing `/`)
// of telemetry transports. Sorted; every entry is a real published npm name — a
// misspelled entry is a hole shaped exactly like coverage. Extending is a reviewed
// edit here (factory) or in the seeded policy (consumer, extend-only).
export const REQUIRED_VENDOR_FLOOR = [
  '@amplitude/',
  '@bugsnag/',
  '@datadog/',
  '@fullstory/',
  '@grafana/faro-react-native',
  '@grafana/faro-web-sdk',
  '@highlight-run/',
  '@honeycombio/',
  '@microsoft/applicationinsights-web',
  '@newrelic/',
  '@opentelemetry/',
  '@react-native-firebase/analytics',
  '@react-native-firebase/crashlytics',
  '@react-native-firebase/perf',
  '@segment/',
  '@sentry/',
  '@vercel/otel',
  'analytics-node',
  'applicationinsights',
  'dd-trace',
  'expo-insights',
  'firebase/analytics',
  'logrocket',
  'mixpanel',
  'mixpanel-browser',
  'mixpanel-react-native',
  'newrelic',
  'posthog-js',
  'posthog-node',
  'posthog-react-native',
]

// Build outputs and prebuild-generated native dirs — never source this gate judges.
// `android`/`ios` are CNG output (generated, uncommitted) at any depth.
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.expo',
  '.turbo',
  'android',
  'ios',
])

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/
const TEST_PATH = /(?:^|\/)(?:__tests__|e2e)\/|\.(?:test|spec)\.|\.d\.ts$/

/**
 * Every scannable source file under the given roots, as POSIX paths relative to
 * the project root (`apps/web/lib/log.ts`). Test files are excluded: the gate's
 * subject is shipped egress paths, and a vendor SDK exercised by a test never
 * transports a production value.
 * @param {string[]} roots
 * @returns {string[]}
 */
export function scanFiles(roots) {
  const out = []
  for (const root of roots) {
    for (const rel of walkFiles(root, {
      excludeDirs: EXCLUDE_DIRS,
      filter: (p) => SOURCE_EXT.test(p) && !TEST_PATH.test(p),
    })) {
      out.push(`${toPosix(root)}/${rel}`)
    }
  }
  return out
}

/**
 * Normalize an import specifier to the package coordinate the floor entries are
 * written against: `npm:`/`jsr:` prefixes stripped, URL specifiers (Deno edge
 * functions import over https) reduced to their path, and a pinned `@version`
 * suffix removed — `npm:posthog-node@4` and `https://esm.sh/@sentry/deno@8`
 * both normalize to a matchable name.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSpecifier(raw) {
  let s = raw.replace(/^(?:npm|jsr):\/?/, '')
  s = s.replace(/^https?:\/\/[^/]+\//, '')
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@')
  if (at > 0) s = s.slice(0, at)
  return s
}

/**
 * Whether a normalized specifier names the vendor entry: exact, a subpath of it
 * (`posthog-js/react`), or — for a trailing-`/` prefix entry like `@sentry/` —
 * anything under the scope. Package-boundary rule throughout, so `@sentryfoo/x`
 * never matches `@sentry/`.
 * @param {string} specifier
 * @param {string} entry
 * @returns {boolean}
 */
export function matchesVendor(specifier, entry) {
  if (entry.endsWith('/')) return specifier === entry.slice(0, -1) || specifier.startsWith(entry)
  return specifier === entry || specifier.startsWith(`${entry}/`)
}

/** First matching detector entry for a specifier, or null. */
export function vendorFor(rawSpecifier, entries) {
  const s = normalizeSpecifier(rawSpecifier)
  return entries.find((e) => matchesVendor(s, e)) ?? null
}

// The four ways a module reference enters a file. Character classes match
// newlines, so a wrapped named-import list still resolves to its specifier.
const IMPORT_FORMS = [
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // dynamic import('x')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // require('x')
  /\b(?:import|export)\s+[^'"();]*?from\s*['"]([^'"\n]+)['"]/g, // import … from 'x'
  /\bimport\s*['"]([^'"\n]+)['"]/g, // side-effect import 'x'
]

/**
 * Every import specifier in one source text, with its 1-based line. Comments are
 * blanked FIRST (a commented-out import is not an egress path); string context is
 * deliberately not modelled — a specifier-shaped string over-detects, and
 * over-detection reds where failing open would not (lib/source-text.mjs doctrine).
 * @param {string} src
 * @returns {{ specifier: string, line: number }[]}
 */
export function extractImports(src) {
  const blanked = blankComments(src)
  const seen = new Set()
  const out = []
  for (const form of IMPORT_FORMS) {
    for (const m of blanked.matchAll(form)) {
      const key = `${String(m.index)}:${m[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ specifier: m[1], line: lineOf(blanked, m.index ?? 0) })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/**
 * Every vendor-telemetry import across the scanned files.
 * @param {string[]} files POSIX paths relative to cwd
 * @param {string[]} detector vendorSpecifiers in force
 * @returns {{ file: string, specifier: string, entry: string, line: number }[]}
 */
export function collectVendorImports(files, detector) {
  const out = []
  for (const file of files) {
    const src = readFileSync(join(...file.split('/')), 'utf8')
    for (const { specifier, line } of extractImports(src)) {
      const entry = vendorFor(specifier, detector)
      if (entry !== null) out.push({ file, specifier, entry, line })
    }
  }
  return out
}

/**
 * Whether the file's code (comments blanked) references the named symbol — the
 * "behind the redaction pass" half, held to the same standard as docs-sync's
 * `closes:` probe: a symbol a sink merely mentions in prose satisfies nothing.
 * @param {string} src
 * @param {string} symbol
 * @returns {boolean}
 */
export function referencesSymbol(src, symbol) {
  return blankComments(src).includes(symbol)
}
