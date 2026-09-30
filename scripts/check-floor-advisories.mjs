#!/usr/bin/env node
// scripts/check-floor-advisories.mjs — does a published advisory affect the SHIPPED framework
// floor or catalog pin without the floor recording it? (1.1.0, #81)
//
// WHY THIS EXISTS. The floor in template/base/tools/framework-floor.json and the pin in
// template/base/pnpm-workspace.yaml are the seeds every new scaffold is rendered from, and
// until this lane nothing compared either with a published advisory. `registers-clockful`
// reads only the review DATES; `version-sync` compares the pin with the floor, not the floor
// with a feed; `factory-sca` scans the factory's own lockfile, which resolves no `next`, and
// a consumer's `scan-full` covers only that consumer's lockfile. So the vendor's security
// release of 2026-08-25 sat inside a live review window, and the floor was noticed only when
// the window lapsed on 2026-09-06 — in a nightly run that was already red (the 1.0.2
// CHANGELOG entry names this check as the missing control).
//
// WHY IT IS A SCHEDULED FACTORY LANE AND NOT A GATE. The verdict changes as the feeds change,
// so it is not hermetic: it rides hygiene.yml's schedule/dispatch block beside
// `registers-clockful`, never a pull request or a push, and nothing under template/ runs it.
// Nor does it run at agent time: network flake must never red a turn, so the factory Stop
// hook leaves it out, as it leaves out check-corpus-fidelity. The judgement itself is a
// pure function of the answers (scripts/lib/floor-advisories.mjs), which is how
// tests/gates/floor-advisories.test.mjs proves it red without a network.
//
// ACTING ON A RED. The remedy changes template files, with their release obligations:
// framework-floor.json is OWNED (`node scripts/generate-released-shas.mjs --current`, the
// template/migrations.json record, the CHANGELOG), and pnpm-workspace.yaml is SEEDED, so
// existing installs get a new pin through a note in docs/runbooks/harness-upgrade.md.
// 1.0.2 is the worked example.
//
//   usage: node scripts/check-floor-advisories.mjs [--responses=<file>] [--floor=<path>] [--workspace=<path>]
//   --responses loads recorded answers keyed by feed and probe (`osv:next@16.3.3`,
//   `upstream:next`, `<key>#<cursor>` for a later page, and `osv-id:<GHSA id>` for OSV's
//   record of an upstream advisory) and sends no request at all.
//   GITHUB_TOKEN, when set, authenticates the upstream listing (the unauthenticated REST
//   limit is 60 requests an hour); the job passes its read-only token.
// SOURCE: scripts/lib/floor-advisories.mjs · scripts/check-register-freshness.mjs (the
// structure) · scripts/check-corpus-fidelity.mjs (the timeout and user-agent) ·
// template/base/tools/check-patch-window.mjs (the OSV request, copied: importing it runs it)
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  checkFloorAdvisories,
  OSV_QUERY_URL,
  OSV_VULN_URL,
  parseArgs,
  recordedTransport,
  USAGE,
} from './lib/floor-advisories.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const TIMEOUT_MS = 15_000
const USER_AGENT =
  'Mozilla/5.0 (compatible; next-expo-supabase-agent-harness/floor-advisories; +https://github.com/BhodiSea/next-expo-supabase-agent-harness)'
// Whole-string shapes for everything that reaches a request, checked immediately before it
// is sent: the upstream listing's first page and every next-page link GitHub hands back
// (which may name the repository by id), the package name and version in an OSV body, and
// the advisory id in an OSV record URL (it comes from the upstream feed).
const UPSTREAM_URL =
  /^https:\/\/api\.github\.com\/(?:repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+|repositories\/\d+)\/security-advisories\?[\w.~%&=+-]*$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const GHSA_ID = /^GHSA(?:-[0-9a-z]{4}){3}$/

const parsed = parseArgs(process.argv.slice(2))
if (parsed.error !== undefined) {
  process.stderr.write(`${USAGE}\n  ${parsed.error}\n`)
  process.exit(2)
}
const options = parsed.options

/** @param {string} what @param {() => unknown} read */
function load(what, read) {
  try {
    return { value: read() }
  } catch (e) {
    return { problem: `${what} is missing or unreadable (${e instanceof Error ? e.message : String(e)}).` }
  }
}

const floorPath = resolve(options.floor ?? join(ROOT, 'template/base/tools/framework-floor.json'))
const workspacePath = resolve(options.workspace ?? join(ROOT, 'template/base/pnpm-workspace.yaml'))
const floor = load(floorPath, () => JSON.parse(readFileSync(floorPath, 'utf8')))
const workspace = load(workspacePath, () => readFileSync(workspacePath, 'utf8'))
const responses =
  options.responses === undefined
    ? { value: null }
    : load(options.responses, () => {
        const doc = JSON.parse(readFileSync(resolve(options.responses), 'utf8'))
        if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('not a JSON object')
        return doc
      })

// Fail closed BEFORE any request: an input this lane cannot read is not a clean floor, and a
// broken recording must never fall through to the live feeds.
const unreadable = [floor, workspace, responses].flatMap((r) => (r.problem === undefined ? [] : [r.problem]))
if (unreadable.length > 0) report(unreadable, [])

/** @param {Response} res */
async function jsonBody(res) {
  if (!res.ok) return null
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('the body is not JSON')
  }
}

/** @param {string | null} link @returns {string | null} */
function nextLink(link) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')
  return m === null ? null : m[1]
}

/** @type {import('./lib/floor-advisories.mjs').FetchPage} */
async function osvQuery(request) {
  const pkg = /** @type {any} */ (request.payload)?.package?.name
  const version = /** @type {any} */ (request.payload)?.version
  if (!PACKAGE_NAME.test(String(pkg)) || !EXACT_VERSION.test(String(version))) {
    throw new Error(`refusing to query OSV for ${JSON.stringify(pkg)}@${JSON.stringify(version)}: not a package name and exact version`)
  }
  const token = /** @type {any} */ (request.payload)?.page_token
  const body = { package: { name: pkg, ecosystem: 'npm' }, version, ...(typeof token === 'string' ? { page_token: token } : {}) }
  const res = await fetch(OSV_QUERY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { status: res.status, body: await jsonBody(res), next: null }
}

/** @type {import('./lib/floor-advisories.mjs').FetchPage} */
async function osvRecord(request) {
  const id = request.url.startsWith(OSV_VULN_URL) ? request.url.slice(OSV_VULN_URL.length) : ''
  if (!GHSA_ID.test(id)) {
    throw new Error(`refusing to request ${JSON.stringify(request.url)}: not an OSV record URL for a GHSA id`)
  }
  const res = await fetch(`${OSV_VULN_URL}${id}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, body: await jsonBody(res), next: null }
}

/** @type {import('./lib/floor-advisories.mjs').FetchPage} */
async function upstreamListing(request) {
  if (!UPSTREAM_URL.test(request.url)) {
    throw new Error(`refusing to request ${JSON.stringify(request.url)}: not a GitHub repository-advisories URL`)
  }
  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  }
  const token = process.env.GITHUB_TOKEN
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  const res = await fetch(request.url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, body: await jsonBody(res), next: nextLink(res.headers.get('link')) }
}

/** The live transport: one sender per feed. */
const LIVE = { osv: osvQuery, 'osv-id': osvRecord, upstream: upstreamListing }

/** @type {import('./lib/floor-advisories.mjs').FetchPage} */
function livePage(request) {
  return LIVE[request.feed](request)
}

/**
 * Print the verdict and exit: 1 on any failure, 0 otherwise.
 * @param {string[]} failures
 * @param {string[]} notes
 * @param {import('./lib/floor-advisories.mjs').Counts} [counts]
 * @returns {never}
 */
function report(failures, notes, counts) {
  for (const n of notes) process.stdout.write(`FLOOR ADVISORIES: ${n}\n`)
  if (failures.length > 0 || counts === undefined) {
    process.stderr.write(`FLOOR ADVISORIES: ${String(failures.length)} problem(s):\n`)
    for (const f of failures) process.stderr.write(`  - ${f}\n`)
    process.stderr.write(
      '\nThe floor holds one row per advisory a maintainer has read and decided about. The remedy changes template files: framework-floor.json is owned (node scripts/generate-released-shas.mjs --current, the template/migrations.json record, the CHANGELOG), and pnpm-workspace.yaml is seeded, so existing installs get a new pin through a note in docs/runbooks/harness-upgrade.md. 1.0.2 is the worked example.\n',
    )
    process.exit(1)
  }
  process.stdout.write(
    `FLOOR ADVISORIES: CLEAN (${String(counts.probes)} probe(s) with no unrecorded advisory; ${String(counts.canaries)} canary(ies) answered with advisories; ${String(counts.recordedRows)} recorded row(s) found upstream; ${String(counts.upstreamOnly)} upstream-only advisory(ies) judged on their own ranges)\n`,
  )
  process.exit(0)
}

const result = await checkFloorAdvisories({
  floor: floor.value,
  workspaceText: String(workspace.value),
  fetchPage: responses.value === null ? livePage : recordedTransport(/** @type {Record<string, unknown>} */ (responses.value)),
})
report(result.failures, result.notes, result.counts)
