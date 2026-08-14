// tools/lib/sbom.mjs — is the emitted dependency inventory COMPLETE, or is it a file
// named sbom.cdx.json?
//
// THE FAILURE THIS EXISTS FOR. Emitting an SBOM is a `pnpm sbom` invocation and takes one
// line; nothing about that line can go red. A lane that produces an artefact and never
// judges it is the shape ASD's evidence hierarchy ranks lowest and the shape this harness
// calls decoration: the artefact exists, a reviewer reads the job name, and an inventory
// that silently lost half the tree looks exactly like one that did not. So the artefact is
// CONSUMED here — closed BOTH ways against pnpm-lock.yaml, which is the only inventory in
// the repository that is already deterministic and already reviewed.
//
// BOTH WAYS, and each direction catches a different accident. A lock package with no
// component means the emission under-reports — the inventory a vulnerability scan would be
// aimed at has a hole in it. A component with no lock package means the SBOM was generated
// against a DIFFERENT tree than the one committed here: a stale committed artefact, a
// filtered `--filter` run, or a generator pointed at the wrong workspace. The second is the
// one a human never notices, because a too-large inventory reads as thorough.
//
// WHY THE LOCKFILE IS THE ORACLE AND NOT node_modules. `pnpm sbom --lockfile-only` needs no
// store and no install, so the lane costs nothing and cannot flake on a registry; judging it
// against the same file it was derived from would be circular, but the lockfile is parsed
// here INDEPENDENTLY, by text, and the two counts are compared. A generator that dropped a
// section, a spec-version bump that renamed a field, or a `--prod`/`--filter` flag nobody
// meant to leave on all show up as a count disagreement rather than as silence.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not judge whether a component is VULNERABLE —
// that is osv-scan's job on the same lane, against a database this repo does not own — and
// it does not judge licences (`licenses` is a chain step with its own policy file). This is
// the asset-discovery half only: what is in the tree, completely.
// SOURCE: https://cyclonedx.org/docs/1.7/json/ (CycloneDX 1.7 JSON: bomFormat, components[].purl)
// SOURCE: docs/harness/gates-catalog.md (the artefact-vs-control distinction)

/** How many offending names an error line spells out before it just counts them. */
const NAMED = 8

/**
 * The `packages:` section keys of a pnpm lockfile — every RESOLVED third-party package,
 * exactly once, as `name@version` (`@scope/name@version` when scoped).
 *
 * Text, not YAML, and that is a decision rather than laziness: this runs on a lane with no
 * install, so it may not import a parser, and the shape it needs is one indentation level
 * deep. `packages:` and not `snapshots:` — snapshots keys carry peer-dependency suffixes
 * (`foo@1.0.0(react@19.0.0)`), so one package appears under several keys there and the
 * count would over-report against an SBOM that lists it once. Workspace members are in
 * `importers:` and are deliberately out: they are not third-party assets, and pnpm does not
 * emit them as components either (verified against a 1539-package scaffold, both counts).
 *
 * @param {string} lockText
 * @returns {string[]}
 */
export function lockPackageKeys(lockText) {
  const at = lockText.indexOf('\npackages:\n')
  if (at === -1) return []
  const rest = lockText.slice(at + 1)
  // The section ends at the next column-0 key (`snapshots:`), or at EOF.
  const end = rest.slice(1).search(/\n[a-z][a-zA-Z]*:\n/)
  const body = end === -1 ? rest : rest.slice(0, end + 1)
  return [...body.matchAll(/^ {2}'?([^'\s][^:']*)'?:$/gm)].map((m) => m[1])
}

/**
 * The purl a lock key denotes, in the spelling CycloneDX writes.
 *
 * Three details, all load-bearing. A peer suffix is stripped FIRST — it cannot appear on a
 * `packages:` key in pnpm 9+, but the lockfile is a format this repo does not own, and the
 * suffix contains its own `@`, so stripping it second finds the wrong separator and yields
 * `pkg:npm/react-dom%4019.0.0(react@19.0.0)`. Then the version is taken from the LAST `@`,
 * because a scoped name begins with one. And the scope's `@` is percent-encoded —
 * pkg:npm/%40scope/name — as the purl spec requires; comparing on the un-encoded form
 * silently mismatches every scoped package, which is most of them, and a check that
 * mismatches everything gets deleted rather than fixed.
 * @param {string} key @returns {string}
 */
export function purlForLockKey(key) {
  const bare = key.split('(')[0]
  const cut = bare.lastIndexOf('@')
  const name = bare.slice(0, cut)
  const version = bare.slice(cut + 1)
  return `pkg:npm/${name.replace('@', '%40')}@${version}`
}

/** @param {string[]} names @returns {string} */
function listed(names) {
  const head = names.slice(0, NAMED).join(', ')
  return names.length > NAMED ? `${head} (+${String(names.length - NAMED)} more)` : head
}

/**
 * Everything wrong with an emitted inventory, or an empty list.
 *
 * @param {{ sbom: any, lockText: string, sbomPath?: string, lockPath?: string }} input
 * @returns {string[]}
 */
export function sbomProblems({
  sbom,
  lockText,
  sbomPath = 'the SBOM',
  lockPath = 'pnpm-lock.yaml',
}) {
  const problems = []

  if (sbom?.bomFormat !== 'CycloneDX') {
    problems.push(
      `${sbomPath} does not declare bomFormat 'CycloneDX' (found ${JSON.stringify(sbom?.bomFormat)}) — the closure below reads CycloneDX fields, so judging another format would compare nothing against nothing and report it clean.`,
    )
    return problems
  }
  if (typeof sbom.metadata?.component?.purl !== 'string') {
    problems.push(
      `${sbomPath} has no metadata.component.purl — an inventory that does not name what it is an inventory OF cannot be attributed to a release, which is the only thing that makes it evidence rather than a file.`,
    )
  }

  const components = Array.isArray(sbom.components) ? sbom.components : []
  // ANTI-VACUITY, both inputs. A zero-component SBOM and a lockfile the parser could not
  // read both produce a clean set comparison, and a clean comparison over nothing is the
  // exact result this whole lane exists to refuse.
  if (components.length === 0) {
    problems.push(
      `${sbomPath} lists ZERO components. Every tree this ships to resolves at least its own toolchain, so an empty inventory is a broken emission, never a dependency-free repository — and an empty set matches an empty set, so the completeness closure below would pass on it.`,
    )
  }
  const lockKeys = lockPackageKeys(lockText)
  if (lockKeys.length === 0) {
    problems.push(
      `${lockPath} yielded no \`packages:\` entries. Either the lockfile is not a pnpm lockfile, or its format moved under this parser — either way the completeness closure has no oracle and must not report clean.`,
    )
  }
  if (problems.length > 0) return problems

  const inSbom = new Set(components.map((c) => c?.purl).filter((p) => typeof p === 'string'))
  if (inSbom.size !== components.length) {
    problems.push(
      `${sbomPath} has ${String(components.length - inSbom.size)} component(s) with a missing or duplicate purl — the purl is the identity this closure compares on, so a component without one is invisible to it.`,
    )
  }
  const inLock = new Map(lockKeys.map((k) => [purlForLockKey(k), k]))

  const missing = [...inLock].filter(([p]) => !inSbom.has(p)).map(([, k]) => k)
  if (missing.length > 0) {
    problems.push(
      `${String(missing.length)} package(s) resolved in ${lockPath} are ABSENT from ${sbomPath}: ${listed(missing.sort())}. The inventory under-reports the tree, so anything aimed at it — a vulnerability scan, a licence review, an assessor — is aimed at a subset nobody declared.`,
    )
  }
  const foreign = [...inSbom].filter((p) => !inLock.has(p))
  if (foreign.length > 0) {
    problems.push(
      `${String(foreign.length)} component(s) in ${sbomPath} are resolved by NO entry in ${lockPath}: ${listed(foreign.sort())}. The inventory describes a different tree than the one committed here — a stale artefact, a filtered generation, or a generator pointed at another workspace. A too-large inventory reads as thorough, which is why this direction is checked.`,
    )
  }

  return problems
}
