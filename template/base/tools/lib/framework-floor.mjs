// tools/lib/framework-floor.mjs — the SECURITY FLOOR for framework pins, as pure logic.
//
// WHAT PROBLEM THIS SOLVES. Nothing in the 31-step chain reds on a pinned dependency with
// a published advisory, and the harness proved it the hard way: it shipped `next: 16.2.7`
// for two releases after the 2026-07-20 security release put nine advisories — four High —
// on that exact range. The osv-scan lanes did not catch it and could not: the PR lane is
// DIFF-AWARE (only NEWLY introduced vulnerabilities fail it, and the pin was not new), and
// the full-tree lane runs on a schedule against a live database, which is a verdict that
// changes with the calendar and therefore cannot be a chain step.
//
// THE SPLIT, which is the whole design. Everything here is CLOCKLESS and OFFLINE: given
// the same lockfile and the same floor, the verdict is the same today, next year, and on a
// laptop in a tunnel. The one time-dependent question — "is this review still fresh?" —
// deliberately does NOT live in this half. It rides the scheduled `floor-review` CI job,
// because a wall-clock check inside `pnpm validate` reds an unchanged tree on a date, which
// is the non-determinism gates-catalog.md already ruled out for `pnpm audit`.
//
// PURE — no fs, no process, no clock reads of its own (`today` is a parameter). The gate
// and the CI script own every read and every exit.
// SOURCE: docs/harness/gates-catalog.md (the determinism rule that excluded `pnpm audit`)

/**
 * Parse `name` -> the set of versions the lockfile RESOLVES it to.
 *
 * Judging the resolved lockfile rather than the catalog string is the point: a catalog can
 * say `^16.2.11` while a transitive constraint pins the actual install lower, and it is the
 * installed bytes that serve requests. pnpm lockfile v9 keys its `packages:` block by
 * `name@version`; a scoped name carries its own `@`, so the version starts after the LAST
 * one. Peer-decorated keys (`name@1.0.0(react@19.2.0)`) live under `snapshots:` in v9, but
 * the suffix is stripped anyway so a format change cannot silently produce junk versions.
 *
 * @param {string} lockText
 * @returns {Map<string, Set<string>>}
 */
export function parseLockVersions(lockText) {
  const found = new Map()
  const lines = lockText.split('\n')
  let inPackages = false
  for (const line of lines) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      // A top-level key ends the previous block. `snapshots:` is read too: it is where
      // peer-decorated entries live, and reading both means a v9-vs-v10 layout change
      // degrades to "found the same versions twice", never to "found none".
      inPackages = line.startsWith('packages:') || line.startsWith('snapshots:')
      continue
    }
    if (!inPackages) continue
    const m = /^ {2}'?(\S+?)'?:\s*(?:#.*)?$/.exec(line)
    if (m === null) continue
    // Truncate at the FIRST `(`, do not "remove the parenthesised groups". Peer
    // decoration nests — `next@16.2.7(react-dom@19.2.3(react@19.2.3))(react@19.2.3)` —
    // and `/\([^)]*\)/g` cannot match a nested group, so it stripped the inner pair and
    // left a trailing `)` behind: the version parsed as `16.2.7)`, which then failed to
    // equal the identical entry from `packages:` and reported the SAME advisory twice,
    // once with a mangled version. An npm package name can never contain `(`, so
    // everything from the first one is decoration by construction.
    const key = m[1].replace(/\(.*$/, '')
    const at = key.lastIndexOf('@')
    if (at <= 0) continue
    const name = key.slice(0, at)
    const version = key.slice(at + 1)
    if (!/^\d/.test(version)) continue
    const set = found.get(name) ?? new Set()
    set.add(version)
    found.set(name, set)
  }
  return found
}

/**
 * Compare two semver strings. Prerelease sorts BELOW its own release, so `16.2.11-canary.1`
 * does not satisfy a floor of `16.2.11` — a canary carrying the fix is not the release the
 * advisory names, and accepting one would let a floor be met by a build nobody shipped.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core = '', pre = ''] = String(v).split('+')[0].split('-', 2)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

/** The advisory ids a message should name, most severe first, capped so the line stays readable. */
function citeAdvisories(entry) {
  const rows = Array.isArray(entry.advisories) ? entry.advisories : []
  const high = rows.filter((a) => a.severity === 'High').map((a) => a.id)
  const shown = (high.length > 0 ? high : rows.map((a) => a.id)).slice(0, 4)
  if (shown.length === 0) return 'no advisory ids are recorded in the floor'
  const rest = rows.length - shown.length
  return `${shown.join(', ')}${rest > 0 ? ` (+${String(rest)} more)` : ''}`
}

/**
 * Judge ONE package's candidate versions against its own floor rows.
 *
 * Split out from judgeFloor to stay under the cognitive-complexity ceiling the harness
 * holds every consumer to — the gate that enforces it caught this function at 19.
 *
 * @param {string} name
 * @param {{ minPatchByMajor?: Record<string, string>, advisories?: {id: string, severity?: string}[], source?: string, why?: string }} entry
 * @param {Set<string>} candidates
 * @returns {string[]}
 */
function judgePackage(name, entry, candidates) {
  const problems = []
  const lines = entry.minPatchByMajor ?? {}
  for (const version of [...candidates].sort()) {
    const major = version.split('.')[0]
    const min = lines[major]
    if (min === undefined) {
      problems.push(
        `${name}@${version} is on major line ${major}, for which tools/framework-floor.json records NO patched release — an unsupported line receives no security fixes at all. Supported lines: ${Object.keys(lines).sort().join(', ')}. Move to one, or add the line to the floor in a reviewed commit.`,
      )
      continue
    }
    if (compareVersions(version, min) < 0) {
      problems.push(
        `${name}@${version} is BELOW the reviewed security floor ${min} for the ${major}.x line — ${citeAdvisories(entry)}. ${entry.why ?? ''} Bump the catalog pin and commit the lockfile. SOURCE: ${entry.source ?? 'tools/framework-floor.json'}`.replace(
          /\s+/g,
          ' ',
        ),
      )
    }
  }
  return problems
}

/**
 * Judge resolved and pinned versions against the floor.
 *
 * @param {{
 *   floor: { packages?: Record<string, { minPatchByMajor?: Record<string, string>, advisories?: {id: string, severity?: string}[], source?: string, why?: string }> },
 *   resolved: Map<string, Set<string>>,
 *   catalogPins: Map<string, string>,
 *   haveLock: boolean,
 * }} input
 * @returns {{ problems: string[], judged: number }}
 */
export function judgeFloor({ floor, resolved, catalogPins, haveLock }) {
  const problems = []
  const packages = Object.entries(floor.packages ?? {})
  let judged = 0

  if (packages.length === 0) {
    problems.push(
      'tools/framework-floor.json declares no packages — an empty floor is a gate that cannot red, so it is a claim rather than a control. Remove the file or give it a row.',
    )
    return { problems, judged }
  }

  // ANTI-VACUITY, and it is checked GLOBALLY rather than per package on purpose. The
  // failure to guard against is parseLockVersions silently matching nothing after an
  // upstream lockfile-format change: every floor would then judge only the catalog and
  // report OK forever. "This one package is missing from the lock" is NOT that failure —
  // a catalog pin nothing depends on resolves to nothing, legitimately — so asking it per
  // package would red correct trees, and a floor that reds correct trees gets deleted.
  if (haveLock && resolved.size === 0) {
    problems.push(
      'pnpm-lock.yaml is present but parseLockVersions matched ZERO packages in it — the lockfile scanner has stopped working (an upstream format change, most likely), so the RESOLVED half of every framework floor would pass vacuously. Fix the scanner before trusting a green here.',
    )
    return { problems, judged }
  }

  for (const [name, entry] of packages) {
    const lines = entry.minPatchByMajor ?? {}
    if (Object.keys(lines).length === 0) {
      problems.push(
        `tools/framework-floor.json: \`${name}\` has no minPatchByMajor entries — a floored package with no floor judges nothing.`,
      )
      continue
    }

    // The versions to judge: every RESOLVED version from the lockfile, plus the catalog
    // pin when it is EXACT. A ranged pin (`^16.2.11`) is not decidable without resolving
    // it, so it is deliberately not judged here — the lockfile half is what covers it.
    const candidates = new Set(resolved.get(name) ?? [])
    const pin = catalogPins.get(name)
    if (pin !== undefined && /^\d/.test(pin)) candidates.add(pin)

    // Absent from BOTH is legitimate and silent: a scaffold that dropped apps/web has no
    // `next`, and demanding one would be the harness asserting a product shape it does
    // not require. The scanner-broken case is caught globally above.
    if (candidates.size === 0) continue

    judged += candidates.size
    problems.push(...judgePackage(name, entry, candidates))
  }

  return { problems, judged }
}

/**
 * The CLOCKFUL half, run only by the scheduled `floor-review` job.
 *
 * A floor is a snapshot of what a human knew on `reviewedOn`. Left alone it decays into an
 * assertion that nothing has been published since — which is the failure mode this whole
 * release is about. `reviewedUntil` is the date that claim stops being made for free.
 *
 * @param {{ floor: {packages?: Record<string, {reviewedOn?: string, reviewedUntil?: string}>}, today: string }} input
 * @returns {string[]}
 */
export function staleReviews({ floor, today }) {
  const problems = []
  const packages = Object.entries(floor.packages ?? {})
  if (packages.length === 0) {
    return ['tools/framework-floor.json declares no packages — there is nothing to review.']
  }
  for (const [name, entry] of packages) {
    for (const field of ['reviewedOn', 'reviewedUntil']) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry[field] ?? ''))) {
        problems.push(
          `tools/framework-floor.json \`${name}\`: ${field} is ${JSON.stringify(entry[field])} — it must be an ISO date (YYYY-MM-DD), or the freshness check cannot judge it.`,
        )
      }
    }
    // String compare is correct and total for zero-padded ISO dates, and it keeps this
    // function free of Date parsing (and of the timezone the local clock would smuggle in).
    if (typeof entry.reviewedUntil === 'string' && entry.reviewedUntil < today) {
      problems.push(
        `tools/framework-floor.json \`${name}\`: the floor was last reviewed on ${entry.reviewedOn ?? 'an unrecorded date'} and its review lapsed on ${entry.reviewedUntil} (today is ${today}). A floor nobody has re-read is an assertion that no advisory has been published since — re-read the upstream security feed, update minPatchByMajor and the advisory rows, and move reviewedOn/reviewedUntil in the same commit.`,
      )
    }
  }
  return problems
}
