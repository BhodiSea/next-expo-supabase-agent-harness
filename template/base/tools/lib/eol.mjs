// tools/lib/eol.mjs — the END-OF-LIFE closure, as pure logic.
//
// WHAT PROBLEM THIS SOLVES. `tools/framework-floor.json` asks "is this pin PATCHED" and
// nothing anywhere asks "is this pin still SUPPORTED AT ALL". They are different failures:
// a package below a floor has a fix waiting for you, and a package whose vendor has walked
// away has none, ever. The second is the worse of the two and it was the unchecked one.
//
// THE ARTEFACT, and why this can be a chain step at all. pnpm's lockfile v9 records
// `deprecated: <message>` on a package entry, copied from the npm registry at RESOLVE time.
// So "the vendor says this is no longer supported" is already sitting in a committed file
// in the tree — offline, clockless, and not a claim anybody in this repo wrote. That is the
// only reason this check can ride `pnpm validate`: the hermeticity rule in CONTRIBUTING
// forbids a gate that resolves its expectations from a live third-party endpoint, and a
// gate that asked the registry directly would turn an untouched commit red overnight.
//
// WHAT IT COSTS: the lockfile learns of a new deprecation only when it is RE-RESOLVED. A
// tree that never reinstalls carries a stale census, exactly as a floor nobody re-reads
// carries a stale advisory list. That is what the register's review window is for, and it
// is why the freshness half rides the scheduled job rather than this one.
//
// PURE — no fs, no process, no clock of its own (`today` is a parameter). The gate owns
// every read and every exit.
// SOURCE: docs/harness/gates-catalog.md (the determinism rule that excluded `pnpm audit`)

/** Zero-padded ISO calendar date — the only shape either review half will judge. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** How many characters of a registry deprecation message a failure line quotes. */
const MESSAGE_CLIP = 160

/**
 * Split a pnpm lockfile into its top-level blocks.
 *
 * Hand-rolled rather than YAML-parsed for the same reason `parseLockVersions` is: adding a
 * YAML dependency to reach four fields in one file is a supply-chain cost paid to avoid
 * thirty lines, and this file is the last place to be relaxed about that.
 *
 * @param {string} lockText
 * @returns {(block: string) => string[]} lines of the named top-level block, indent intact
 */
function blockReader(lockText) {
  const blocks = new Map()
  let current = null
  for (const line of lockText.split('\n')) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      current = line.slice(0, line.indexOf(':'))
      blocks.set(current, [])
      continue
    }
    if (current !== null) blocks.get(current).push(line)
  }
  return (name) => blocks.get(name) ?? []
}

/** `name@1.2.3(peer@4)` -> `name@1.2.3`. An npm name can never contain `(`. */
const undecorate = (key) => key.replace(/\(.*$/, '')

/**
 * Every package the lockfile records as DEPRECATED BY ITS VENDOR, with the vendor's message.
 *
 * Keys are `name@version`. The message is the registry's own text — never this repo's
 * paraphrase of it, because the whole evidentiary value of this signal is that a third
 * party wrote it.
 *
 * A `deprecated:` value is a plain scalar in every lockfile pnpm 11 writes, but YAML permits
 * a folded/literal block, so a continuation is gathered rather than silently truncated: a
 * message clipped to `>-` would read as an empty deprecation and pass a row that says
 * nothing.
 *
 * @param {string} lockText
 * @returns {{ deprecated: Map<string, string>, scanned: number }}
 */
export function parseDeprecations(lockText) {
  const lines = blockReader(lockText)('packages')
  const deprecated = new Map()
  let scanned = 0
  let key = null
  for (let i = 0; i < lines.length; i += 1) {
    const entry = /^ {2}'?(\S+?)'?:\s*$/.exec(lines[i])
    if (entry !== null) {
      key = undecorate(entry[1])
      if (key.lastIndexOf('@') > 0) scanned += 1
      continue
    }
    const field = /^ {4}deprecated:\s*(.*)$/.exec(lines[i])
    if (field === null || key === null) continue
    let message = field[1].trim()
    if (message === '' || message === '>-' || message === '|' || message === '>') {
      const rest = []
      for (let j = i + 1; j < lines.length && /^ {6}\S/.test(lines[j]); j += 1)
        rest.push(lines[j].trim())
      message = rest.join(' ')
    }
    deprecated.set(key, message.replace(/^['"]|['"]$/g, ''))
  }
  return { deprecated, scanned }
}

/**
 * Read one `name: version` map nested under a lockfile section.
 *
 * `transitivePeerDependencies:` is a LIST, not a map, and lives at the same indent as the
 * dependency maps — walking it as one yields junk keys, so entries are matched positively
 * (`key: value`) rather than by "everything under the heading".
 *
 * @param {string[]} lines
 * @param {number} from index of the heading line
 * @param {number} indent column the map's entries start at
 * @returns {[string, string][]}
 */
function readMap(lines, from, indent) {
  /** @type {[string, string][]} */
  const pairs = []
  const entry = new RegExp(`^ {${String(indent)}}'?([^':#]+?)'?:\\s*(\\S+)\\s*$`)
  for (let i = from + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (!lines[i].startsWith(' '.repeat(indent))) break
    const m = entry.exec(lines[i])
    if (m !== null) pairs.push([m[1].trim(), m[2].trim()])
  }
  return pairs
}

/**
 * The workspace's declared roots, split into production and development.
 *
 * `dependencies` + `optionalDependencies` are production (an optional dependency that
 * installs is shipped); `devDependencies` are not. That split is the entire point.
 *
 * @param {string} lockText
 * @returns {{ prod: Set<string>, dev: Set<string> }}
 */
function importerRoots(lockText) {
  const lines = blockReader(lockText)('importers')
  const prod = new Set()
  const dev = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    // A dependency heading under an importer sits at 4 spaces; its entries are the 6-space
    // package names, each carrying `specifier:`/`version:` beneath at 8.
    const heading = /^ {4}(dependencies|optionalDependencies|devDependencies):\s*$/.exec(lines[i])
    if (heading === null) continue
    const into = heading[1] === 'devDependencies' ? dev : prod
    for (let j = i + 1; j < lines.length && !/^ {4}\S/.test(lines[j]); j += 1) {
      const name = /^ {6}'?([^':#]+?)'?:\s*$/.exec(lines[j])
      if (name === null) continue
      const version =
        /^ {8}version:\s*(\S+)\s*$/.exec(lines[j + 2] ?? '') ??
        /^ {8}version:\s*(\S+)\s*$/.exec(lines[j + 1] ?? '')
      if (version !== null) into.add(`${name[1].trim()}@${undecorate(version[1])}`)
    }
  }
  return { prod, dev }
}

/**
 * Each package's declared PEER dependency names, read from `packages:`.
 *
 * WHY THIS IS LOAD-BEARING, and what it cost to find out. pnpm's `snapshots:` block records
 * a RESOLVED peer as an ordinary entry in the parent's `dependencies:` map — there is no
 * marker distinguishing "I depend on this" from "my consumer must supply this". So a naive
 * graph walk treats every satisfied peer as an ownership edge, and the first run of this
 * function's absence produced a concrete false positive: `expo-router` peer-depends on
 * `@testing-library/react-native`, which depends on `jest`, so the whole of jest 29 — and
 * with it the deprecated `glob@7` and `inflight` — landed in the "production" closure of a
 * tree where the testing library is a devDependency. A control that reds a correct tree is
 * a control someone deletes.
 *
 * @param {string} lockText
 * @returns {Map<string, Set<string>>}
 */
function peerNames(lockText) {
  const lines = blockReader(lockText)('packages')
  const peers = new Map()
  let key = null
  for (let i = 0; i < lines.length; i += 1) {
    const entry = /^ {2}'?(\S+?)'?:\s*$/.exec(lines[i])
    if (entry !== null) {
      key = undecorate(entry[1])
      continue
    }
    if (key === null || !/^ {4}peerDependencies:\s*$/.test(lines[i])) continue
    peers.set(key, new Set(readMap(lines, i, 6).map(([name]) => name)))
  }
  return peers
}

/** `name@version` -> its direct dependencies, and the reverse map, from `snapshots:`. */
function snapshotGraph(lockText) {
  const lines = blockReader(lockText)('snapshots')
  const edges = new Map()
  const dependents = new Map()
  let key = null
  for (let i = 0; i < lines.length; i += 1) {
    const entry = /^ {2}'?(\S.*?)'?:\s*(\{\})?\s*$/.exec(lines[i])
    if (entry !== null) {
      key = undecorate(entry[1])
      if (!edges.has(key)) edges.set(key, new Set())
      continue
    }
    if (key === null) continue
    if (!/^ {4}(dependencies|optionalDependencies):\s*$/.test(lines[i])) continue
    for (const [name, version] of readMap(lines, i, 6)) {
      const child = `${name}@${undecorate(version)}`
      edges.get(key).add(child)
      if (!dependents.has(child)) dependents.set(child, new Set())
      dependents.get(child).add(key)
    }
  }
  return { edges, dependents }
}

/**
 * The PRODUCTION dependency closure, and who pulls each package in.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT. A register row saying "this deprecated package is
 * test-only" is prose, and prose is what this release exists to stop standing in for
 * evidence. This computes the answer from the lockfile instead — and the first time it ran
 * it disproved the note that was about to be written: five of the six deprecated packages a
 * fresh scaffold resolves are dev-only, and `uuid@7.0.3` is NOT, because it arrives through
 * `expo` -> `@expo/config-plugins` -> `xcode`, and `expo` is a production dependency.
 *
 * ITS STATED LIMIT, which the register must not overstate past: "in the production
 * dependency closure" is NOT "in the shipped bundle". `xcode` is prebuild tooling that Metro
 * never bundles, and nothing offline can prove that — bundling is decided by what is
 * IMPORTED, and the lockfile records what is DEPENDED ON. So this function's answer is a
 * ceiling on exposure, never a measurement of it, and a row may not claim the bundle
 * question is settled because this returned false.
 *
 * @param {string} lockText
 * @returns {{ production: Set<string>, dependents: Map<string, Set<string>> }}
 */
export function productionClosure(lockText) {
  const { edges, dependents } = snapshotGraph(lockText)
  const { prod, dev } = importerRoots(lockText)
  const peers = peerNames(lockText)
  // A peer satisfied by a DEV-declared package is not a production edge: the peer
  // declaration says "my consumer supplies this", and this consumer supplies it from its
  // devDependencies. Narrowed to dev-satisfied peers on purpose — with `autoInstallPeers`
  // a peer can have no declarer at all, and dropping every peer edge would then quietly
  // shrink the closure, which is the same defect pointed the safer-looking way.
  const devNames = new Set([...dev].map(nameOf))
  const skips = (parent, child) =>
    peers.get(parent)?.has(nameOf(child)) === true && devNames.has(nameOf(child))
  const production = new Set()
  const queue = [...prod]
  while (queue.length > 0) {
    const node = queue.pop()
    if (production.has(node)) continue
    production.add(node)
    for (const child of edges.get(node) ?? []) {
      if (!skips(node, child)) queue.push(child)
    }
  }
  return { production, dependents }
}

/** The major line of a `name@version` key, for register rows that accept a LINE not a build. */
const majorOf = (key) => key.slice(key.lastIndexOf('@') + 1).split('.')[0]

/** The name half of a `name@version` key (a scoped name carries its own `@`). */
const nameOf = (key) => key.slice(0, key.lastIndexOf('@'))

/** Does a register row cover this resolved `name@version`? */
const covers = (row, key) =>
  row.package === nameOf(key) && (row.majors ?? []).map(String).includes(majorOf(key))

const SCOPES = new Set(['development', 'production'])

/**
 * Validate one register row's SHAPE, before it is asked to judge anything.
 *
 * Split out to stay under the cognitive-complexity ceiling this harness holds every
 * consumer to.
 *
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @param {string} path
 * @returns {string[]}
 */
function rowShapeProblems(row, index, path) {
  const at = `${path} deprecated[${String(index)}]`
  const problems = []
  if (typeof row.package !== 'string' || row.package.trim() === '') {
    problems.push(`${at}: no \`package\` name — a row that names nothing accepts everything.`)
  }
  if (!Array.isArray(row.majors) || row.majors.length === 0) {
    problems.push(
      `${at} (${String(row.package)}): no \`majors\` array. Acceptance is per MAJOR LINE, so a vendor's NEXT major arriving deprecated is a new decision a human makes rather than one this row already made.`,
    )
  }
  if (!SCOPES.has(String(row.scope))) {
    problems.push(
      `${at} (${String(row.package)}): scope is ${JSON.stringify(row.scope)} — it must be one of ${[...SCOPES].join(', ')}, and it is CHECKED against the lockfile rather than believed.`,
    )
  }
  if (typeof row.reason !== 'string' || row.reason.trim() === '') {
    problems.push(
      `${at} (${String(row.package)}): empty \`reason\`. Carrying a package the vendor has abandoned is a decision; an undocumented decision is indistinguishable from an oversight.`,
    )
  }
  // A PRODUCTION-scope acceptance carries an EXPIRY, and a development-scope one does not.
  // Essential Eight PA-13 says unsupported products are REMOVED, so carrying abandoned code
  // in the production closure is a debt rather than a decision — and a debt with no date is
  // indistinguishable from a permanent acceptance six months later. The expiry lives in
  // THIS file rather than in tools/deferrals.json on purpose: the ledger's closure demands a
  // dated sentence in a harness-owned prose surface, which a consumer cannot write, so
  // routing consumer acceptances through it would make the honest path the impossible one.
  if (row.scope === 'production' && !/^\d+\.\d+\.\d+$/.test(String(row.removalTarget))) {
    problems.push(
      `${at} (${String(row.package)}): scope is \`production\` and \`removalTarget\` is ${JSON.stringify(row.removalTarget)} — it must be a release (x.y.z). An acceptance of vendor-abandoned code in the production closure needs a date at which somebody looks again; without one it is permanent by default.`,
    )
  }
  if (row.scope !== 'production' && row.removalTarget != null) {
    problems.push(
      `${at} (${String(row.package)}): \`removalTarget\` is set on a \`${String(row.scope)}\`-scope row. The expiry belongs to production acceptances; on a development row it reads as a commitment nothing will judge.`,
    )
  }
  return problems
}

/**
 * Has a production acceptance's re-review date ARRIVED?
 *
 * Clockless: it compares two committed version strings, never a calendar. Split out so the
 * gate can say so honestly when there is no installed release to compare against — the
 * template's own dev tree has no manifest, and that is exactly where stale dates get
 * written.
 *
 * @param {{ rows: Record<string, unknown>[], path: string, running: string | null, cmp: (a: string, b: string) => number }} input
 * @returns {string[]}
 */
export function arrivedAcceptances({ rows, path, running, cmp }) {
  if (running === null) return []
  const problems = []
  for (const row of rows) {
    const target = String(row.removalTarget ?? '')
    if (row.scope !== 'production' || !/^\d+\.\d+\.\d+$/.test(target)) continue
    if (cmp(running, target) < 0) continue
    problems.push(
      `${path}: the acceptance of ${String(row.package)} (vendor-deprecated, in the PRODUCTION dependency closure) committed to a re-review at ${target}, and this install runs harness ${running} — it has ARRIVED. Remove the dependency, or re-affirm the acceptance and move removalTarget to a release you mean, in a reviewed diff.`,
    )
  }
  return problems
}

/**
 * Judge ONE deprecated resolution against the row (if any) that accepts it.
 *
 * Split out of judgeDeprecations to stay under the cognitive-complexity ceiling this harness
 * holds every consumer to — the check that stops the harness exempting itself caught the
 * combined function at 19 against a bar of 15, which is exactly its job.
 *
 * @param {{
 *   key: string,
 *   message: string,
 *   row: Record<string, unknown> | undefined,
 *   path: string,
 *   production: Set<string>,
 *   dependents: Map<string, Set<string>>,
 * }} input
 * @returns {string[]}
 */
function judgeOneDeprecation({ key, message, row, path, production, dependents }) {
  const via = [...(dependents.get(key) ?? [])].sort().slice(0, 4)
  const reachedBy = via.length === 0 ? 'a direct dependency' : via.join(', ')
  if (row === undefined) {
    return [
      `${key} is DEPRECATED BY ITS VENDOR and no row in ${path} accepts it. The registry's own words: "${message.slice(0, MESSAGE_CLIP)}". It arrives through ${reachedBy}. Remove it, or record the decision to carry it — package, majors, scope, and a reason — in ${path}.`,
    ]
  }
  // THE LIE-DETECTOR. `scope` is the one field a reviewer is most tempted to write from
  // memory ("it's only a test dependency"), and it is the field that decides how much the
  // acceptance costs. So it is derived from the lockfile and compared, in BOTH directions:
  // understating exposure hides a production dependency on abandoned code, and overstating
  // it means the register disagrees with the tree, which is the same defect pointed the
  // other way.
  const inProduction = production.has(key)
  if (inProduction && row.scope === 'development') {
    return [
      `${path}: ${key} is recorded as \`development\` scope, but the lockfile puts it in the PRODUCTION dependency closure — it arrives through ${reachedBy}. Correct the row (and note that \`production\` scope requires a \`removalTarget\`).`,
    ]
  }
  if (!inProduction && row.scope === 'production') {
    return [
      `${path}: ${key} is recorded as \`production\` scope, but the lockfile reaches it only through devDependencies. The register must agree with the tree in both directions — over-stating exposure is the same drift as under-stating it.`,
    ]
  }
  return []
}

/**
 * Judge the lockfile's deprecation census against the reviewed register, BOTH WAYS.
 *
 * The two directions catch opposite failures and only one of them is obvious. Tree -> register
 * catches a newly deprecated package nobody has looked at. Register -> tree catches an
 * acceptance that has outlived its subject — the dependency was dropped, the row stayed, and
 * the register slowly became a list of decisions about packages this project does not have.
 * A file like that reads as a review having happened when none did.
 *
 * @param {{
 *   register: { deprecated?: Record<string, unknown>[] },
 *   path: string,
 *   deprecated: Map<string, string>,
 *   scanned: number,
 *   production: Set<string>,
 *   dependents: Map<string, Set<string>>,
 *   haveLock: boolean,
 * }} input
 * @returns {{ problems: string[], judged: number, unsupportedInProduction: number }}
 */
export function judgeDeprecations({
  register,
  path,
  deprecated,
  scanned,
  production,
  dependents,
  haveLock,
}) {
  const problems = []
  const rows = Array.isArray(register.deprecated) ? register.deprecated : []
  rows.forEach((row, i) => problems.push(...rowShapeProblems(row, i, path)))

  // ANTI-VACUITY, checked GLOBALLY and for the SCANNER rather than per row. The failure to
  // guard against is `parseDeprecations` matching nothing after an upstream lockfile-format
  // change: the census would then be empty, every row would look stale, and — worse — a
  // genuinely deprecated package would sail through. "Zero deprecated packages" is NOT that
  // failure; a clean tree is a legitimate and desirable state, so it is not an error.
  if (haveLock && scanned === 0) {
    problems.push(
      `pnpm-lock.yaml is present but the deprecation scanner matched ZERO package entries in it — the scanner has stopped working (an upstream lockfile-format change, most likely), so the end-of-life census would pass vacuously on any tree. Fix the scanner before trusting a green here.`,
    )
    return { problems, judged: 0, unsupportedInProduction: 0 }
  }

  let unsupportedInProduction = 0
  const matched = new Set()
  for (const [key, message] of [...deprecated].sort()) {
    const row = rows.find((r) => covers(r, key))
    if (row !== undefined) matched.add(row)
    if (row !== undefined && production.has(key)) unsupportedInProduction += 1
    problems.push(...judgeOneDeprecation({ key, message, row, path, production, dependents }))
  }

  for (const [i, row] of rows.entries()) {
    if (matched.has(row)) continue
    problems.push(
      `${path} deprecated[${String(i)}] accepts ${String(row.package)}@${(Array.isArray(row.majors) ? row.majors : []).map(String).join('/')}.x, which this lockfile does not resolve as deprecated at all. Either the dependency is gone (delete the row) or the vendor un-deprecated it (delete the row) — an acceptance that has outlived its subject makes the register read as reviewed when it is merely old.`,
    )
  }

  return { problems, judged: deprecated.size, unsupportedInProduction }
}

/** The version LINE a product's support policy is expressed in. */
const LINES = new Map([
  ['major', (v) => v.split('.')[0]],
  ['minor', (v) => v.split('.').slice(0, 2).join('.')],
])

/**
 * Validate one `products[]` row's shape.
 *
 * `policy` and `source` are required and non-empty because they are what stops this section
 * being the harness's own opinion wearing a vendor's clothes: the supported set must be a
 * quote from the vendor, at a URL, not a list somebody assembled. It is the only defence
 * against the obvious vacuity — appending the current line to `supported[]` to silence a red
 * — beyond the write guard, CODEOWNERS review and the review window that forces a re-read.
 *
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @param {string} path
 * @returns {string[]}
 */
function productShapeProblems(row, index, path) {
  const at = `${path} products[${String(index)}]`
  const problems = []
  if (typeof row.package !== 'string' || row.package.trim() === '') {
    problems.push(`${at}: no \`package\` — a support floor that names no package judges nothing.`)
  }
  if (!LINES.has(String(row.match))) {
    problems.push(
      `${at} (${String(row.package)}): \`match\` is ${JSON.stringify(row.match)} — it must be one of ${[...LINES.keys()].join(', ')}. Vendors express support per major line or per minor series, and guessing which reds a correct tree.`,
    )
  }
  if (!Array.isArray(row.supported) || row.supported.length === 0) {
    problems.push(
      `${at} (${String(row.package)}): \`supported\` must be a non-empty array of version lines — an empty set reds every version, including the right one.`,
    )
  }
  if (typeof row.policy !== 'string' || row.policy.trim().length < 40) {
    problems.push(
      `${at} (${String(row.package)}): \`policy\` must carry the VENDOR'S OWN WORDS (40+ characters). A supported-set list with no quote behind it is this repository's opinion about somebody else's product.`,
    )
  }
  if (typeof row.source !== 'string' || !/^https?:\/\//.test(row.source)) {
    problems.push(
      `${at} (${String(row.package)}): \`source\` must be the URL the policy was read from, so the next reviewer can check the reading rather than repeat the research.`,
    )
  }
  return problems
}

/**
 * Judge each pinned product against the version lines its VENDOR still supports.
 *
 * WHY THIS IS REVIEWED DATA AND NOT DERIVED. The npm deprecation census above needs no human
 * judgement — the registry flag is the vendor speaking. Platform support windows are not
 * like that, and the research behind this section is the evidence: Expo publishes NO per-SDK
 * end-of-life date in any form, its one versions API carries zero date fields across all 51
 * SDK entries, endoflife.date has no Expo product, and its written policy defines
 * "unsupported" operationally as *removed from the documentation*. So there is nothing to
 * derive and no feed to read — and computing "released June 2026 + approximately one year"
 * would be this file's arithmetic presented as a vendor's commitment, which is the one thing
 * a conformance artefact must never do.
 *
 * React Native is the exception that proves the rule: it publishes a numbered commitment
 * ("the latest 3 minor series") and a dated table with named support tiers, so its row is
 * the strongest here and its `supported` set is read straight off that table.
 *
 * Absent from BOTH the catalog and the lockfile is legitimate and silent — a scaffold that
 * dropped apps/mobile has no `expo`, and demanding one would be this gate asserting a
 * product shape the harness does not require. `judged` is returned so the caller can report
 * how much was actually looked at rather than implying it was everything.
 *
 * @param {{
 *   register: { products?: Record<string, unknown>[] },
 *   path: string,
 *   catalogPins: Map<string, string>,
 *   resolved: Map<string, Set<string>>,
 * }} input
 * @returns {{ problems: string[], judged: number }}
 */
export function judgeSupported({ register, path, catalogPins, resolved }) {
  const rows = Array.isArray(register.products) ? register.products : []
  const problems = []
  rows.forEach((row, i) => problems.push(...productShapeProblems(row, i, path)))
  if (problems.length > 0) return { problems, judged: 0 }

  let judged = 0
  for (const row of rows) {
    const line = LINES.get(String(row.match))
    const supported = (Array.isArray(row.supported) ? row.supported : []).map(String)
    const name = String(row.package)
    const candidates = new Set(resolved.get(name) ?? [])
    const pin = catalogPins.get(name)
    if (pin !== undefined && /^\d/.test(pin)) candidates.add(pin)
    for (const version of [...candidates].sort()) {
      judged += 1
      if (supported.includes(line(version))) continue
      problems.push(
        `${name}@${version} is on the ${line(version)} line, which ${path} does not list among the lines its VENDOR still supports (${supported.join(', ')}). An unsupported product receives no fixes of any kind, security or otherwise — Essential Eight PA-13/POS-16 say such products are removed. The vendor's own words: "${String(row.policy).slice(0, MESSAGE_CLIP)}" — ${String(row.source)}. Upgrade, or move the supported set in a reviewed commit that re-reads that page and moves reviewedOn/reviewedUntil with it.`,
      )
    }
  }
  return { problems, judged }
}

/**
 * The CLOCKLESS review-discipline half: is the window the reviewer granted themselves bounded?
 *
 * Identical in shape and in reasoning to the framework floor's, and it deliberately borrows
 * that file's constant rather than inventing a second number. The two registers are re-read
 * on the SAME maintenance pass and ride the SAME scheduled job, so giving them different
 * windows would only mean one of them is read on a morning the other is not.
 *
 * @param {{ register: {reviewedOn?: string, reviewedUntil?: string}, path: string, maxWindowDays: number }} input
 * @returns {string[]}
 */
export function eolReviewWindow({ register, path, maxWindowDays }) {
  const on = String(register.reviewedOn ?? '')
  const until = String(register.reviewedUntil ?? '')
  if (!ISO_DATE.test(on) || !ISO_DATE.test(until)) {
    return [
      `${path}: reviewedOn/reviewedUntil must both be ISO dates (YYYY-MM-DD); got ${JSON.stringify(register.reviewedOn)} and ${JSON.stringify(register.reviewedUntil)}.`,
    ]
  }
  if (until < on) {
    return [
      `${path}: reviewedUntil (${until}) is BEFORE reviewedOn (${on}) — the review expired before it happened, so this register has never carried a live one.`,
    ]
  }
  const days = Math.round(
    (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / 86_400_000,
  )
  if (days > maxWindowDays) {
    return [
      `${path}: the review window is ${String(days)} days (${on} -> ${until}), over the ${String(maxWindowDays)}-day maximum. A deprecation census is only as current as the last RESOLUTION, so a window longer than the maintenance cadence is one in which a vendor can abandon a package and nothing here will say so. Move BOTH dates in the commit that re-resolves and re-reads.`,
    ]
  }
  return []
}

/**
 * The CLOCKFUL half, run only by the scheduled `floor-review` job.
 *
 * A deprecation census is a snapshot of what the registry said at the last resolution. Left
 * alone it decays into an assertion that no vendor has walked away since — silently, and
 * without a single line of the tree changing.
 *
 * @param {{ register: {reviewedOn?: string, reviewedUntil?: string}, path: string, today: string }} input
 * @returns {string[]}
 */
export function staleEolReview({ register, path, today }) {
  const until = register.reviewedUntil
  if (!ISO_DATE.test(String(until))) {
    return [
      `${path}: reviewedUntil is ${JSON.stringify(until)} — it must be an ISO date, or freshness cannot be judged.`,
    ]
  }
  // String compare is correct and total for zero-padded ISO dates, and it keeps this
  // function free of the timezone a Date parse would smuggle in.
  if (String(until) < today) {
    return [
      `${path}: the end-of-life register was last reviewed on ${String(register.reviewedOn ?? 'an unrecorded date')} and its review lapsed on ${String(until)} (today is ${today}). Re-run \`pnpm install\` so the lockfile re-resolves the registry's deprecation flags, re-read the rows against what comes back, and move reviewedOn/reviewedUntil in the same commit.`,
    ]
  }
  return []
}
