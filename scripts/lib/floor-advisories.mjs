// scripts/lib/floor-advisories.mjs — the SHIPPED framework floor and catalog pin, judged
// against the published advisory feeds (1.1.0, #81). The pure half of
// scripts/check-floor-advisories.mjs.
//
// WHAT IT ANSWERS. Does a published, non-withdrawn advisory affect a version the seeds put
// on every new scaffold — each `minPatchByMajor` floor in template/base/tools/
// framework-floor.json, and the exact catalog pin in template/base/pnpm-workspace.yaml —
// without the floor recording a decision about it? An affected range can include the pin
// without including the floor, so both are probed.
//
// WHY TWO FEEDS. They list the same advisory at different times. The upstream repository's
// published advisories carried GHSA-2xp9-vwfh-vxw4 on the vendor's release day, 2026-08-25;
// OSV's record of it is `published` 2026-09-08, after the floor's review had already lapsed
// on 2026-09-06. A lane reading only OSV would have gone red after `registers-clockful` did,
// for the very release this lane exists to catch. OSV adds what was published elsewhere,
// and it matches the version itself.
//
// WHICH FEED DECIDES. OSV, for every advisory it lists; the upstream range, only for one it
// does not list yet. The first live run (hygiene.yml run 36711735348) read the vendor's real
// listing: its `vulnerable_version_range` is free text — whitespace-joined comparators,
// commas meaning "or", x-ranges, `=>` — so 141 ranges over 49 advisories failed the syntax
// check, and six advisories whose upper bound lives in `patched_versions` ("< 16.3.3"
// beside patched "15.5.24, 16.3.3") read as covering patched probes. OSV listed all 54 of
// them with normalised ranges, and answered nothing for any probe. So an upstream advisory
// OSV lists (its id appeared in an OSV answer, or GET /v1/vulns/<id> returns a record naming
// the package under npm) is judged by OSV's per-version answer and only lends its earlier
// date; one OSV answers 404 for is the head start this feed exists for, and is judged on its
// own range, where a syntax no test covers fails. That run's one such advisory,
// GHSA-vcvr-r3jv-pc5j, is a real unrecorded advisory on the floor and the pin.
//
// WHY NOT "PUBLISHED AFTER reviewedOn". That filter misses an advisory the review
// overlooked, and it fails on advisories the floor already fixes. The verdict is "affects a
// probe and is not recorded", and the published date is printed, never filtered on.
//
// FAIL CLOSED, every way. A non-2xx status, a timeout, a body of the wrong shape, a `vulns`
// that is not an array, a page token still unfollowed at the cap, a missing recorded
// response, an upstream range whose syntax no test covers: each is a failure, never "no
// advisories". Anti-vacuity: zero probes fails; each floored package needs a canary — a
// version the repository records as affected — on which OSV must return at least one
// advisory; and the upstream listing must hold at least one of the package's recorded rows
// under npm, or a wrong repository or a changed response shape would look clean.
//
// PURE apart from the injected `fetchPage`: no fs, no process, no clock. The script owns
// every read, every request and the exit code; recorded responses are data here.
// SOURCE: https://docs.github.com/en/rest/security-advisories/repository-advisories ·
// https://google.github.io/osv.dev/post-v1-query/ · https://ossf.github.io/osv-schema/ ·
// https://docs.github.com/en/code-security/tutorials/fix-reported-vulnerabilities/write-security-advisories
// (the affected-versions syntax) · template/base/tools/lib/framework-floor.mjs (compareVersions)
import { compareVersions } from '../../template/base/tools/lib/framework-floor.mjs'

/**
 * Each floored package's upstream repository: the one that publishes its advisories. For
 * `next` it is the repository GHSA-2xp9-vwfh-vxw4 was published in. A floored package with
 * no entry is a failure, because it would be probed on one feed only.
 * @type {Readonly<Record<string, string>>}
 */
export const UPSTREAM_REPOS = Object.freeze({ next: 'vercel/next.js' })

/**
 * Each floored package's canary: a version the repository records as affected, so OSV must
 * return at least one advisory for it. For `next` it is 16.2.7, which the harness shipped
 * after the 2026-07-20 security release put nine advisories on it (framework-floor.mjs's
 * header). Zero advisories there means a wrong name, ecosystem or endpoint.
 * @type {Readonly<Record<string, string>>}
 */
export const CANARIES = Object.freeze({ next: '16.2.7' })

/** Pages read per feed and probe before an unfollowed next page is a failure. */
export const MAX_PAGES = 10

export const OSV_QUERY_URL = 'https://api.osv.dev/v1/query'
export const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/'

const FLOOR_PATH = 'template/base/tools/framework-floor.json'
// Anchored, whole-string shapes, checked before any value reaches a request.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REPO_SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const FLAGS = new Set(['responses', 'floor', 'workspace'])

export const USAGE =
  'FLOOR ADVISORIES: usage: node scripts/check-floor-advisories.mjs [--responses=<file>] [--floor=<path>] [--workspace=<path>]'

/**
 * @typedef {{ name: string, version: string, role: 'floor' | 'pin' | 'canary', label: string }} Probe
 * @typedef {{ status?: unknown, body?: unknown, next?: unknown }} Page
 * @typedef {{ feed: 'osv' | 'osv-id' | 'upstream', key: string, url: string, payload?: Record<string, unknown> }} PageRequest
 * @typedef {(request: PageRequest) => Promise<Page>} FetchPage
 */

/**
 * `--name=value` flags only, each once, each non-empty. Anything else is a usage error.
 * @param {string[]} argv
 * @returns {{ options: Record<string, string>, error?: undefined } | { error: string, options?: undefined }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {}
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.+)$/.exec(arg)
    if (m === null || !FLAGS.has(m[1])) return { error: `unrecognised argument ${JSON.stringify(arg)}` }
    if (Object.hasOwn(options, m[1])) return { error: `--${m[1]} given twice` }
    options[m[1]] = m[2]
  }
  return { options }
}

/**
 * The `catalog:` block's pins, with the key-and-value pattern check-version-sync.mjs uses,
 * read from that block only: a same-named key under `allowBuilds:` is not a pin.
 * @param {string} workspaceText
 * @returns {Map<string, string>}
 */
export function catalogPins(workspaceText) {
  const pins = new Map()
  const head = /^catalog:[ \t]*$/m.exec(workspaceText)
  if (head === null) return pins
  const rest = workspaceText.slice(head.index + head[0].length)
  const end = /^[A-Za-z_'"]/m.exec(rest)
  const block = end === null ? rest : rest.slice(0, end.index)
  for (const m of block.matchAll(/^ {2}'?([@a-z0-9][@a-z0-9/.-]*)'?:\s*([^\s#]+)/gm)) {
    pins.set(m[1], m[2].replace(/^['"]|['"]$/g, ''))
  }
  return pins
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * @param {unknown} floor
 * @param {string[]} problems
 * @returns {Array<[string, Record<string, any>]>}
 */
function floorPackages(floor, problems) {
  const packages = isObject(floor) && isObject(floor.packages) ? Object.entries(floor.packages) : []
  if (packages.length === 0) {
    problems.push(
      `${FLOOR_PATH} has no floored package — this lane probes the floor, so a floor with nothing in it is a failure, not a clean result.`,
    )
  }
  return packages.filter(([name, entry]) => {
    if (PACKAGE_NAME.test(name) && isObject(entry)) return true
    problems.push(`${FLOOR_PATH}: \`${name}\` is not a valid npm package name with an object entry.`)
    return false
  })
}

/** @param {string} name @param {Record<string, any>} entry @param {string[]} problems @returns {Probe[]} */
function floorProbes(name, entry, problems) {
  const lines = isObject(entry.minPatchByMajor) ? Object.entries(entry.minPatchByMajor) : []
  if (lines.length === 0) problems.push(`${FLOOR_PATH}: \`${name}\` has no minPatchByMajor entries.`)
  /** @type {Probe[]} */
  const probes = []
  for (const [major, version] of lines) {
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      problems.push(`${FLOOR_PATH}: \`${name}\` line ${major}'s floor ${JSON.stringify(version)} is not an exact version.`)
      continue
    }
    probes.push({ name, version, role: 'floor', label: `${name}@${version} (floor, ${major}.x line)` })
  }
  return probes
}

/** @param {string} name @param {string | undefined} pin @param {string[]} problems @returns {Probe[]} */
function pinProbe(name, pin, problems) {
  if (pin === undefined) {
    problems.push(
      `\`${name}\` has no catalog pin in template/base/pnpm-workspace.yaml's \`catalog:\` block — a probe this lane cannot make is not a clean result.`,
    )
    return []
  }
  if (!EXACT_VERSION.test(pin)) {
    problems.push(
      `\`${name}\`'s catalog pin ${pin} is not an exact version — a ranged pin cannot be probed, and the floor treats only an exact pin as the version shipped.`,
    )
    return []
  }
  return [{ name, version: pin, role: 'pin', label: `${name}@${pin} (catalog pin)` }]
}

/** @param {string} name @param {Record<string, any>} entry @param {string[]} problems @returns {Probe[]} */
function canaryProbe(name, entry, problems) {
  const canary = Object.hasOwn(CANARIES, name) ? CANARIES[name] : undefined
  if (canary === undefined) {
    problems.push(
      `\`${name}\` has no canary in scripts/lib/floor-advisories.mjs — without a known-affected version, an empty answer cannot be told from a wrong query.`,
    )
    return []
  }
  const lineFloor = isObject(entry.minPatchByMajor) ? entry.minPatchByMajor[canary.split('.')[0]] : undefined
  if (typeof lineFloor === 'string' && compareVersions(canary, lineFloor) >= 0) {
    problems.push(
      `canary ${name}@${canary} is not below the floor of its line (${lineFloor}) — a canary must be a version the repository records as affected.`,
    )
    return []
  }
  return [{ name, version: canary, role: 'canary', label: `${name}@${canary} (canary)` }]
}

/**
 * Every probe the seeds imply: each `minPatchByMajor` version, the exact catalog pin and the
 * canary, per floored package. A floored package with no upstream repository is named here
 * too, so every configuration failure is reported before any request is sent.
 * @param {{ floor: unknown, workspaceText: string }} input
 * @returns {{ probes: Probe[], problems: string[] }}
 */
export function deriveProbes({ floor, workspaceText }) {
  /** @type {string[]} */
  const problems = []
  /** @type {Probe[]} */
  const probes = []
  const pins = catalogPins(workspaceText)
  for (const [name, entry] of floorPackages(floor, problems)) {
    probes.push(...floorProbes(name, entry, problems), ...pinProbe(name, pins.get(name), problems))
    probes.push(...canaryProbe(name, entry, problems))
    const slug = Object.hasOwn(UPSTREAM_REPOS, name) ? UPSTREAM_REPOS[name] : undefined
    if (slug === undefined || !REPO_SLUG.test(slug)) {
      problems.push(
        `\`${name}\` has no upstream repository in scripts/lib/floor-advisories.mjs — it would be probed on OSV alone, which lists a vendor's advisory days after the vendor does.`,
      )
    }
  }
  if (!probes.some((p) => p.role !== 'canary')) {
    problems.push('zero probes — a lane that asked about no version has proven nothing.')
  }
  return { probes, problems }
}

const OPERATORS = /** @type {const} */ ({
  '<': (/** @type {number} */ c) => c < 0,
  '<=': (/** @type {number} */ c) => c <= 0,
  '>': (/** @type {number} */ c) => c > 0,
  '>=': (/** @type {number} */ c) => c >= 0,
  '=': (/** @type {number} */ c) => c === 0,
})

// One comparator: an operator (optional only when it stands alone) and an EXACT version.
// Sticky, so a run of them must cover the text with nothing unread between.
const COMPARATOR = /\s*(<=|>=|<|>|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*/y

/**
 * Whitespace-joined comparators, all of which must hold — the vendor's own form, as in
 * ">= 16.2.0 < 16.3.6". A bare version is an equality, and only when it stands alone.
 * @param {string} text
 * @returns {Array<{ op: keyof typeof OPERATORS, version: string }> | null}
 */
function conjunction(text) {
  /** @type {Array<{ op: keyof typeof OPERATORS, version: string, bare: boolean }>} */
  const parts = []
  COMPARATOR.lastIndex = 0
  while (COMPARATOR.lastIndex < text.length) {
    const m = COMPARATOR.exec(text)
    if (m === null) return null
    parts.push({ op: /** @type {keyof typeof OPERATORS} */ (m[1] ?? '='), version: m[2], bare: m[1] === undefined })
  }
  if (parts.length === 0 || (parts.length > 1 && parts.some((p) => p.bare))) return null
  return parts
}

/** @param {{ op: string }} c */
const isLower = (c) => c.op === '>' || c.op === '>='
/** @param {{ op: string }} c */
const isUpper = (c) => c.op === '<' || c.op === '<='

/**
 * Does an upstream `vulnerable_version_range` include `version`? Two joiners, each read
 * only where its meaning is not in doubt:
 *   - whitespace between comparators is a conjunction (">= 16.2.0 < 16.3.6");
 *   - `||`, and a comma, separate ALTERNATIVES, as the vendor writes them
 *     (">=13.0.0 <15.0.8, >=16.0.0 <16.1.5"; ">=15.0.0, >=16.0.0") — except GitHub's
 *     documented pair, exactly one lower bound, a comma, then one upper bound above it
 *     (">= 16.0.0, < 16.3.3"), which is one conjunction. Read as alternatives, any other
 *     comma can only cover MORE versions than its author meant, never fewer.
 * Every comparator names an exact version (a prerelease allowed). Anything else — x-ranges,
 * `^`, `~`, hyphen ranges, partial versions, `and`, `=>`, an empty alternative — returns
 * null, which the caller reports as a failure, because a range this function guessed at
 * could silently exclude the version it was asked about.
 * @param {unknown} range
 * @param {string} version
 * @returns {boolean | null}
 */
export function rangeIncludes(range, version) {
  const alternatives = typeof range === 'string' ? alternativesOf(range) : null
  if (alternatives === null) return null
  return alternatives.some((all) => all.every((c) => OPERATORS[c.op](compareVersions(version, c.version))))
}

/** @param {string} range */
function alternativesOf(range) {
  const pieces = range.split(/\|\||,/).map(conjunction)
  if (pieces.some((p) => p === null)) return null
  const alternatives = /** @type {Array<Array<{ op: keyof typeof OPERATORS, version: string }>>} */ (pieces)
  const [lo, hi] = alternatives
  const documentedPair =
    !range.includes('||') &&
    alternatives.length === 2 &&
    lo.length === 1 &&
    hi.length === 1 &&
    isLower(lo[0]) &&
    isUpper(hi[0]) &&
    compareVersions(lo[0].version, hi[0].version) < 0
  return documentedPair ? [[lo[0], hi[0]]] : alternatives
}

/**
 * Does the advisory's `patched_versions` list a fix on the probe's own major.minor line, at
 * or below the probe? The vendor lists one patched release per line ("15.5.24, 16.3.3"), and
 * writes the matching range loosely ("< 16.3.3" covers 15.5.24 as written). Only the probe's
 * own line counts: a fix on another line says nothing certain about this one. A part that is
 * not an exact version (optionally after `>=`) patches nothing, so an unreadable list can
 * only make the lane report more, never less.
 * @param {unknown} patched
 * @param {string} version
 * @returns {boolean}
 */
export function patchedOnLine(patched, version) {
  if (typeof patched !== 'string') return false
  const line = version.split('.').slice(0, 2).join('.')
  return patched.split(',').some((part) => {
    const m = /^\s*(?:>=\s*)?(\d+\.\d+)(\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(part)
    return m !== null && m[1] === line && compareVersions(`${m[1]}${m[2]}`, version) <= 0
  })
}

/**
 * One request, with a thrown transport failure turned into a sentence.
 * @param {FetchPage} fetchPage
 * @param {PageRequest} request
 * @returns {Promise<{ page: Page, problem?: undefined } | { problem: string, page?: undefined }>}
 */
async function send(fetchPage, request) {
  try {
    const page = await fetchPage(request)
    return { page: isObject(page) ? page : {} }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    return { problem: `${request.key}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}` }
  }
}

/**
 * One request that must answer 2xx: any other status is a failure, never "no advisories".
 * @param {FetchPage} fetchPage
 * @param {PageRequest} request
 * @returns {Promise<{ page: Page, problem?: undefined } | { problem: string, page?: undefined }>}
 */
async function getPage(fetchPage, request) {
  const got = await send(fetchPage, request)
  if (got.problem !== undefined) return got
  const status = got.page.status
  if (typeof status !== 'number' || status < 200 || status > 299) {
    return { problem: `${request.key}: HTTP ${String(status)} — a feed that did not answer has not said "no advisories".` }
  }
  return got
}

/**
 * Does OSV list this advisory under this package on npm? GET /v1/vulns/<id>: a record naming
 * the package is yes, 404 is "not yet", and anything else fails closed, because an answer
 * that is neither cannot tell the lane which feed decides. A record under another package is
 * not OSV answering for this one, so it counts as "not yet".
 * @param {FetchPage} fetchPage
 * @param {string} name
 * @param {string} id
 * @returns {Promise<{ listed: boolean, problem?: undefined } | { problem: string, listed?: undefined }>}
 */
async function osvLists(fetchPage, name, id) {
  const key = `osv-id:${id}`
  const got = await send(fetchPage, { feed: 'osv-id', key, url: `${OSV_VULN_URL}${id}` })
  if (got.problem !== undefined) return { problem: got.problem }
  const { status, body } = got.page
  if (status === 404) return { listed: false }
  if (status !== 200) {
    return { problem: `${key}: HTTP ${String(status)} — neither a record nor "not listed", so the lane cannot tell which feed decides.` }
  }
  if (!isObject(body) || typeof body.id !== 'string') return { problem: `${key}: the body is not an OSV record.` }
  const affected = Array.isArray(body.affected) ? body.affected : []
  return {
    listed: affected.some(
      (/** @type {unknown} */ a) => isObject(a) && isObject(a.package) && a.package.ecosystem === 'npm' && a.package.name === name,
    ),
  }
}

/**
 * @param {unknown} body
 * @param {string} key
 * @returns {{ vulns: Array<Record<string, any>>, next: string | null, problem?: undefined } | { problem: string }}
 */
function osvPage(body, key) {
  if (!isObject(body)) return { problem: `${key}: the body is not a JSON object.` }
  const vulns = body.vulns === undefined ? [] : body.vulns
  if (!Array.isArray(vulns)) return { problem: `${key}: \`vulns\` is present but is not an array.` }
  if (!vulns.every((v) => isObject(v) && typeof v.id === 'string')) {
    return { problem: `${key}: a vuln with no string id.` }
  }
  const token = body.next_page_token
  if (token !== undefined && (typeof token !== 'string' || token === '')) {
    return { problem: `${key}: next_page_token is not a non-empty string.` }
  }
  return { vulns, next: token ?? null }
}

/**
 * @param {unknown} body
 * @param {string} key
 * @returns {{ advisories: Array<Record<string, any>>, problem?: undefined } | { problem: string }}
 */
function upstreamPage(body, key) {
  if (!Array.isArray(body)) return { problem: `${key}: the body is not a JSON array.` }
  if (!body.every((a) => isObject(a) && typeof a.ghsa_id === 'string')) {
    return { problem: `${key}: an advisory with no string ghsa_id.` }
  }
  if (!body.every((a) => a.vulnerabilities === null || a.vulnerabilities === undefined || Array.isArray(a.vulnerabilities))) {
    return { problem: `${key}: an advisory whose vulnerabilities is not an array.` }
  }
  return { advisories: body }
}

/**
 * Read one feed to its last page. `parse` returns the page's items and its onward cursor
 * (null at the end), `follow` turns a cursor into the next request, and a page still
 * pointing onward at MAX_PAGES is a failure.
 * @template T
 * @param {FetchPage} fetchPage
 * @param {PageRequest} first
 * @param {(page: Page, key: string) => ({ items: T[], next: string | null } | { problem: string })} parse
 * @param {(cursor: string) => PageRequest} follow
 * @returns {Promise<{ items: T[], problem: string | null }>}
 */
async function readPages(fetchPage, first, parse, follow) {
  /** @type {T[]} */
  const items = []
  let request = first
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const got = await getPage(fetchPage, request)
    if (got.problem !== undefined) return { items, problem: got.problem }
    const parsed = parse(got.page, request.key)
    if ('problem' in parsed) return { items, problem: parsed.problem }
    items.push(...parsed.items)
    if (parsed.next === null) return { items, problem: null }
    request = follow(parsed.next)
  }
  return {
    items,
    problem: `${first.key}: still had a next page after ${String(MAX_PAGES)} page(s) — the page cap was reached with a page unread, so the answer is incomplete.`,
  }
}

/**
 * Every OSV vuln for one probe, following `next_page_token`.
 * @param {FetchPage} fetchPage
 * @param {Probe} probe
 */
function readOsv(fetchPage, probe) {
  const base = `osv:${probe.name}@${probe.version}`
  /** @param {string | null} token @returns {PageRequest} */
  const request = (token) => ({
    feed: 'osv',
    key: token === null ? base : `${base}#${token}`,
    url: OSV_QUERY_URL,
    payload: {
      package: { name: probe.name, ecosystem: 'npm' },
      version: probe.version,
      ...(token === null ? {} : { page_token: token }),
    },
  })
  return readPages(
    fetchPage,
    request(null),
    (page, key) => {
      const r = osvPage(page.body, key)
      return 'problem' in r ? { problem: r.problem } : { items: r.vulns, next: r.next }
    },
    request,
  )
}

/**
 * Every published advisory in a package's upstream repository, following the listing's
 * next-page link (the transport reports it as `next`).
 * @param {FetchPage} fetchPage
 * @param {string} name
 */
function readUpstream(fetchPage, name) {
  const base = `upstream:${name}`
  const slug = UPSTREAM_REPOS[name]
  return readPages(
    fetchPage,
    {
      feed: 'upstream',
      key: base,
      url: `https://api.github.com/repos/${slug}/security-advisories?state=published&per_page=100`,
    },
    (page, key) => {
      const r = upstreamPage(page.body, key)
      if ('problem' in r) return { problem: r.problem }
      return { items: r.advisories, next: typeof page.next === 'string' && page.next !== '' ? page.next : null }
    },
    (cursor) => ({ feed: 'upstream', key: `${base}#${cursor}`, url: cursor }),
  )
}

/** Replace control characters in a feed-supplied string before it reaches a log line. */
const printable = (/** @type {unknown} */ s) =>
  [...String(s)]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : c
    })
    .join('')

/**
 * @typedef {{ name: string, ids: Set<string>, feeds: Set<string>, probes: Set<string>, published: Array<{ date: string, feed: string }> }} Hit
 */

/** @param {Hit} hit @param {unknown} published @param {string} feed */
function addDate(hit, published, feed) {
  if (typeof published === 'string' && /^\d{4}-\d{2}-\d{2}/.test(published)) {
    hit.published.push({ date: published.slice(0, 10), feed })
  }
}

/**
 * Fold one feed's sighting of an advisory into the hit table, merging on any shared id so an
 * advisory both feeds list is reported once.
 * @param {Map<string, Hit>} hits
 * @param {{ name: string, ids: string[], feed: string, probe: Probe, published: unknown }} sighting
 */
function addHit(hits, { name, ids, feed, probe, published }) {
  const existing = ids.map((id) => hits.get(`${name}\u0000${id}`)).find((h) => h !== undefined)
  /** @type {Hit} */
  const hit = existing ?? { name, ids: new Set(), feeds: new Set(), probes: new Set(), published: [] }
  for (const id of ids) {
    hit.ids.add(id)
    hits.set(`${name}\u0000${id}`, hit)
  }
  hit.feeds.add(feed)
  hit.probes.add(probe.label)
  addDate(hit, published, feed)
}

/**
 * An upstream sighting of an advisory OSV decides: it adds its feed and its date, often the
 * earlier one, to OSV's hit, and never a probe — OSV's per-version answer said which probes
 * the advisory affects.
 * @param {Map<string, Hit>} hits
 * @param {{ name: string, ids: string[], published: unknown }} sighting
 */
function lendDate(hits, { name, ids, published }) {
  const hit = ids.map((id) => hits.get(`${name}\u0000${id}`)).find((h) => h !== undefined)
  if (hit === undefined) return
  hit.feeds.add('upstream')
  addDate(hit, published, 'upstream')
}

/** @param {Record<string, any>} vuln @returns {string[]} */
const osvIds = (vuln) => [vuln.id, ...(Array.isArray(vuln.aliases) ? vuln.aliases : [])].filter((x) => typeof x === 'string')

/** @param {Record<string, any>} advisory @returns {string[]} */
const upstreamIds = (advisory) => [advisory.ghsa_id, advisory.cve_id].filter((x) => typeof x === 'string' && x !== '')

/** @param {Record<string, any>} advisory @param {string} name @returns {Array<Record<string, any>>} */
const npmEntries = (advisory, name) =>
  (advisory.vulnerabilities ?? []).filter(
    (/** @type {any} */ v) => isObject(v) && isObject(v.package) && v.package.ecosystem === 'npm' && v.package.name === name,
  )

/**
 * One upstream advisory: skipped when withdrawn or not about this package on npm; judged by
 * OSV when OSV lists it (see the header); judged on its own ranges when OSV does not list it
 * yet, which is the head start the upstream feed is read for.
 * @param {Context} ctx
 * @param {{ name: string, advisory: Record<string, any>, probes: Probe[], recorded: Set<string> }} input
 */
async function judgeUpstream(ctx, { name, advisory, probes, recorded }) {
  const entries = npmEntries(advisory, name)
  if ((advisory.withdrawn_at !== null && advisory.withdrawn_at !== undefined) || entries.length === 0) return
  const ids = upstreamIds(advisory)
  const seen = ids.some((id) => ctx.osvSeen.has(`${name}\u0000${id}`))
  const lookup = seen ? { listed: true } : await osvLists(ctx.fetchPage, name, advisory.ghsa_id)
  if (lookup.problem !== undefined) {
    ctx.problems.push(lookup.problem)
    return
  }
  if (lookup.listed) {
    lendDate(ctx.hits, { name, ids, published: advisory.published_at })
    return
  }
  ctx.counts.upstreamOnly += 1
  const isRecorded = ids.some((id) => recorded.has(id))
  for (const entry of entries) judgeRange(ctx, { name, advisory, entry, probes, isRecorded })
}

/**
 * One entry of an advisory OSV does not list yet. The syntax is judged once, before any
 * probe, so an unreadable range fails even where no probe would have been asked about —
 * unless the floor records the advisory, whose decision stands whatever the range says (a
 * NOTE). A probe inside the range is cleared only by a patched version on its own line.
 * @param {Context} ctx
 * @param {{ name: string, advisory: Record<string, any>, entry: Record<string, any>, probes: Probe[], isRecorded: boolean }} input
 */
function judgeRange(ctx, { name, advisory, entry, probes, isRecorded }) {
  const range = entry.vulnerable_version_range
  if (rangeIncludes(range, '0.0.0') === null) {
    const id = printable(advisory.ghsa_id)
    const shown = printable(JSON.stringify(range))
    if (isRecorded) {
      ctx.notes.push(
        `NOTE — ${id} (upstream, not yet in OSV) is recorded in the floor; its range ${shown} could not be read, and the decision on record stands.`,
      )
    } else {
      ctx.problems.push(
        `${id} (upstream, not yet in OSV) gives \`${name}\` the range ${shown}, a range syntax no test covers — read the advisory, and teach rangeIncludes() the syntax, with a test, rather than guess.`,
      )
    }
    return
  }
  for (const probe of probes) {
    if (rangeIncludes(range, probe.version) === true && !patchedOnLine(entry.patched_versions, probe.version)) {
      addHit(ctx.hits, { name, ids: upstreamIds(advisory), feed: 'upstream', probe, published: advisory.published_at })
    }
  }
}

/** @param {Array<Record<string, any>>} advisories @param {string} name @param {Set<string>} recorded */
const recordedRowsUpstream = (advisories, name, recorded) =>
  advisories.filter((a) => upstreamIds(a).some((id) => recorded.has(id)) && npmEntries(a, name).length > 0).length

/**
 * The earliest published date any feed gave, and where it falls against `reviewedOn`. Printed
 * for the reader, never filtered on (see the header).
 * @param {Hit} hit @param {string} reviewedOn
 */
function dating(hit, reviewedOn) {
  const first = hit.published.reduce(
    (/** @type {{ date: string, feed: string } | undefined} */ best, p) => (best === undefined || p.date < best.date ? p : best),
    undefined,
  )
  if (first === undefined) return 'published date unknown'
  let when = 'on'
  if (first.date < reviewedOn) when = 'before'
  if (first.date > reviewedOn) when = 'after'
  return `published ${first.date} (${first.feed}), ${when} reviewedOn ${printable(reviewedOn)}`
}

/** @param {Hit} hit */
function describe(hit) {
  const [id, ...aliases] = [...hit.ids].map(printable)
  const alias = aliases.length > 0 ? ` (aliases: ${aliases.join(', ')})` : ''
  return `${id}${alias} listed by ${[...hit.feeds].sort().join(', ')}`
}

const REMEDY =
  `Re-read the advisory, then raise minPatchByMajor and the pin, or record the row with the decision, in ${FLOOR_PATH}. Move both review dates in the same commit.`

/**
 * Turn the hit table into failures (unrecorded) and notes (recorded).
 * @param {Map<string, Hit>} hits
 * @param {Map<string, { recorded: Set<string>, reviewedOn: string }>} floorRows
 */
function verdicts(hits, floorRows) {
  /** @type {string[]} */
  const failures = []
  /** @type {string[]} */
  const notes = []
  for (const hit of new Set(hits.values())) {
    const row = floorRows.get(hit.name) ?? { recorded: new Set(), reviewedOn: '' }
    const recordedAs = [...hit.ids].filter((id) => row.recorded.has(id))
    const probes = [...hit.probes].join(', ')
    if (recordedAs.length > 0) {
      notes.push(
        `NOTE — ${describe(hit)} affects ${probes} and is recorded in the floor as ${recordedAs.map(printable).join(', ')}; the decision on record stands until the next review.`,
      )
      continue
    }
    failures.push(`${describe(hit)} — ${dating(hit, row.reviewedOn)} — affects ${probes} — not recorded in the floor. ${REMEDY}`)
  }
  return { failures, notes }
}

/**
 * @param {unknown} floor
 * @returns {Map<string, { recorded: Set<string>, reviewedOn: string }>}
 */
function floorRowsOf(floor) {
  const rows = new Map()
  const packages = isObject(floor) && isObject(floor.packages) ? Object.entries(floor.packages) : []
  for (const [name, entry] of packages) {
    const advisories = isObject(entry) && Array.isArray(entry.advisories) ? entry.advisories : []
    rows.set(name, {
      recorded: new Set(advisories.map((/** @type {any} */ a) => a?.id).filter((/** @type {unknown} */ id) => typeof id === 'string')),
      reviewedOn: isObject(entry) && typeof entry.reviewedOn === 'string' ? entry.reviewedOn : '',
    })
  }
  return rows
}

/**
 * Query both feeds for every probe and judge the answers. The whole lane, given a transport.
 * @param {{ floor: unknown, workspaceText: string, fetchPage: FetchPage }} input
 * @returns {Promise<{ failures: string[], notes: string[], counts: Counts }>}
 */
export async function checkFloorAdvisories({ floor, workspaceText, fetchPage }) {
  const { probes, problems } = deriveProbes({ floor, workspaceText })
  const ctx = {
    fetchPage,
    probes,
    problems,
    floorRows: floorRowsOf(floor),
    /** @type {Map<string, Hit>} */
    hits: new Map(),
    /** @type {Set<string>} every `<package>\0<id>` an OSV answer named: OSV lists it */
    osvSeen: new Set(),
    /** @type {string[]} */
    notes: [],
    counts: { probes: 0, canaries: 0, recordedRows: 0, upstreamOnly: 0 },
  }
  await osvHalf(ctx)
  await upstreamHalf(ctx)
  const { failures, notes } = verdicts(ctx.hits, ctx.floorRows)
  // Every line passes through printable(): a request key carries a feed-supplied page
  // cursor, and a transport error its message, as well as the ids handled above.
  return {
    failures: [...problems, ...failures].map(printable),
    notes: [...ctx.notes, ...notes].map(printable),
    counts: ctx.counts,
  }
}

/**
 * @typedef {{ probes: number, canaries: number, recordedRows: number, upstreamOnly: number }} Counts
 * @typedef {{ fetchPage: FetchPage, probes: Probe[], problems: string[], notes: string[], floorRows: Map<string, { recorded: Set<string>, reviewedOn: string }>, hits: Map<string, Hit>, osvSeen: Set<string>, counts: Counts }} Context
 */

/**
 * OSV, once per distinct version: a pin equal to a floor is one request with two labels.
 * @param {Context} ctx
 */
async function osvHalf(ctx) {
  /** @type {Map<string, { items: Array<Record<string, any>>, problem: string | null }>} */
  const answers = new Map()
  for (const probe of ctx.probes) {
    const key = `${probe.name}@${probe.version}`
    const cached = answers.get(key)
    const answer = cached ?? (await readOsv(ctx.fetchPage, probe))
    answers.set(key, answer)
    if (cached === undefined && answer.problem !== null) ctx.problems.push(answer.problem)
    markSeen(ctx, probe.name, answer.items)
    if (probe.role === 'canary') judgeCanary(ctx, probe, answer)
    else foldOsv(ctx, probe, answer.items)
  }
}

/**
 * Every id an OSV answer names, withdrawn or not, is one OSV lists for that package: the
 * upstream half lets OSV decide it (see the header).
 * @param {Context} ctx
 * @param {string} name
 * @param {Array<Record<string, any>>} items
 */
function markSeen(ctx, name, items) {
  for (const vuln of items) for (const id of osvIds(vuln)) ctx.osvSeen.add(`${name}\u0000${id}`)
}

/**
 * One probe's OSV answer, folded into the hit table: every advisory OSV matched to the
 * version, unless withdrawn.
 * @param {Context} ctx
 * @param {Probe} probe
 * @param {Array<Record<string, any>>} items
 */
function foldOsv(ctx, probe, items) {
  ctx.counts.probes += 1
  for (const vuln of items) {
    if (vuln.withdrawn !== undefined && vuln.withdrawn !== null) continue
    addHit(ctx.hits, { name: probe.name, ids: osvIds(vuln), feed: 'osv', probe, published: vuln.published })
  }
}

/**
 * @param {Context} ctx
 * @param {Probe} probe
 * @param {{ items: unknown[], problem: string | null }} answer
 */
function judgeCanary(ctx, probe, answer) {
  if (answer.items.length > 0) {
    ctx.counts.canaries += 1
  } else if (answer.problem === null) {
    ctx.problems.push(
      `canary ${probe.name}@${probe.version} returned no advisory from OSV — on a version recorded as affected, that means a wrong name, ecosystem or endpoint, not a clean package.`,
    )
  }
}

/**
 * The upstream listing, once per floored package that has a repository, each advisory judged
 * by the feed that can answer for it.
 * @param {Context} ctx
 */
async function upstreamHalf(ctx) {
  const names = [...new Set(ctx.probes.map((p) => p.name))].filter((n) => Object.hasOwn(UPSTREAM_REPOS, n))
  for (const name of names) {
    const { items, problem } = await readUpstream(ctx.fetchPage, name)
    if (problem !== null) ctx.problems.push(problem)
    const probes = ctx.probes.filter((p) => p.name === name && p.role !== 'canary')
    const recorded = ctx.floorRows.get(name)?.recorded ?? new Set()
    for (const advisory of items) await judgeUpstream(ctx, { name, advisory, probes, recorded })
    const found = recordedRowsUpstream(items, name, recorded)
    ctx.counts.recordedRows += found
    if (found === 0 && problem === null) {
      ctx.problems.push(
        `the upstream listing for \`${name}\` (${UPSTREAM_REPOS[name]}) holds none of its recorded rows under npm — a wrong repository or a changed response shape would otherwise look clean.`,
      )
    }
  }
}

/**
 * The recorded-response transport behind `--responses=<file>`: a lookup by request key, and
 * a missing key is a failure. `{ "error": "TimeoutError" }` records a transport error.
 * @param {Record<string, unknown>} responses
 * @returns {FetchPage}
 */
export function recordedTransport(responses) {
  return (request) => {
    if (!Object.hasOwn(responses, request.key)) {
      return Promise.reject(new Error(`no recorded response for ${request.key} — a recording that does not cover a request is not an answer`))
    }
    const r = responses[request.key]
    if (isObject(r) && typeof r.error === 'string') {
      const err = new Error(r.error)
      err.name = r.error
      return Promise.reject(err)
    }
    if (!isObject(r)) return Promise.reject(new Error(`the recorded response for ${request.key} is not an object`))
    return Promise.resolve({ status: r.status, body: r.body, next: typeof r.next === 'string' ? r.next : null })
  }
}
