#!/usr/bin/env node
// THE NPM PUBLISH VERDICTS (1.1.0, #161). release.yml's `publish-npm` job publishes the
// tarball the release job attached to the GitHub Release (the bytes its build provenance
// attestation names) to the npm registry through trusted publishing (OIDC). The two
// decisions that job makes live here rather than in YAML, so
// tests/gates/npm-publish.test.mjs can falsify them:
//
//   tag     the dist-tag the version publishes under. A prerelease goes to `next`; a version
//           above the registry's `latest` becomes `latest`; a version below it on an older
//           major line goes to `v<major>`, because npm refuses `latest` for a lower version.
//           Everything else is a HARD FAIL with the reason: a version already published, a
//           lower version on the current major line (which tag it deserves is a human
//           call), and a package the registry has never seen. Trusted publishing cannot
//           create a package, so the first version is the maintainer's manual publish
//           (CONTRIBUTING.md, "Releases").
//   verify  after `npm publish`, that the registry holds what was meant: `dist.integrity` is
//           the sha512 of the attested tarball, the version carries a SLSA provenance
//           attestation, and `_npmUser.trustedPublisher` says it arrived through OIDC. npm's
//           OIDC exchange never throws (it falls back to whatever other credential exists),
//           so an exit 0 from `npm publish` alone proves nothing about how the version was
//           published. A version not yet visible is retried within the budget, because the
//           registry's read path can trail its write path by seconds.
//
// The package name and version come from package.json (`--package` points the tests at a
// fixture), and the version argument must equal it: the tag is the claim, package.json is
// what was packed. Transport is the registry's public JSON API over fetch; no npm CLI.
//   usage: node scripts/ci/npm-publish.mjs tag <version> [--registry URL] [--package PATH]
//          node scripts/ci/npm-publish.mjs verify <tarball> <version> [--registry URL]
//                 [--package PATH] [--attempts N] [--poll-seconds N]
// SOURCE: .github/workflows/release.yml · tests/gates/npm-publish.test.mjs
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1'

const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const NAME_SHAPE = /^[a-z0-9][a-z0-9._-]*$/

/**
 * @param {string} version
 * @returns {{ release: [number, number, number], prerelease: string | null } | null}
 */
export function parseVersion(version) {
  const m = VERSION_SHAPE.exec(version)
  if (m === null) return null
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null }
}

/**
 * Compare the x.y.z parts only.
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number} negative, zero or positive
 */
function compareRelease(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * The dist-tag `version` publishes under, given the registry's current dist-tags, or null
 * when the registry has never seen the package.
 * @param {string} version
 * @param {Record<string, string> | null} distTags
 * @returns {{ tag: string } | { error: string }}
 */
export function distTagFor(version, distTags) {
  const v = parseVersion(version)
  if (v === null) return { error: `"${version}" is not an x.y.z or x.y.z-pre version` }
  if (distTags === null) {
    return {
      error:
        'the package is not on the registry. Trusted publishing cannot create a package: the maintainer publishes the first version by hand, configures the trusted publisher, then re-runs this job (CONTRIBUTING.md, "Releases").',
    }
  }
  if (v.prerelease !== null) return { tag: 'next' }
  const latest = typeof distTags.latest === 'string' ? parseVersion(distTags.latest) : null
  if (latest === null) return { tag: 'latest' }
  const order = compareRelease(v.release, latest.release)
  if (order > 0 || (order === 0 && latest.prerelease !== null)) return { tag: 'latest' }
  if (order === 0) {
    return { error: `${version} is already the registry's latest; a published version cannot be published again` }
  }
  if (v.release[0] < latest.release[0]) return { tag: `v${String(v.release[0])}` }
  return {
    error: `${version} is below the registry's latest (${String(distTags.latest)}) on the same major line, so no dist-tag fits it mechanically. Publish it by hand with an explicit --tag, or release a higher version.`,
  }
}

/**
 * npm's `dist.integrity` form of a tarball's bytes.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/**
 * What is wrong with the registry's record of the version just published, or [] when it
 * is the attested tarball, published through a GitHub trusted publisher, with provenance.
 * `meta` is the registry's version document, or null when the version is not visible.
 * @param {any} meta
 * @param {string} expectedIntegrity
 * @returns {string[]}
 */
export function publishProblems(meta, expectedIntegrity) {
  if (meta === null || typeof meta !== 'object') return ['the registry has no record of this version']
  /** @type {string[]} */ const problems = []
  const integrity = meta.dist?.integrity
  if (integrity !== expectedIntegrity) {
    problems.push(
      `dist.integrity is ${String(integrity)}, but the attested tarball's is ${expectedIntegrity}: the registry holds different bytes than the GitHub Release asset`,
    )
  }
  const provenance = meta.dist?.attestations?.provenance
  if (provenance === undefined || provenance === null) {
    problems.push('the version carries no provenance attestation: it was not published from a trusted publisher with provenance')
  } else if (provenance.predicateType !== SLSA_PROVENANCE_V1) {
    problems.push(`the provenance predicate is ${String(provenance.predicateType)}, not ${SLSA_PROVENANCE_V1}`)
  }
  if (meta._npmUser?.trustedPublisher?.id !== 'github') {
    problems.push(
      `the version was published by ${String(meta._npmUser?.name)}, not through a GitHub trusted publisher: the OIDC exchange failed and npm used another credential`,
    )
  }
  return problems
}

/** @param {string} msg @returns {never} */
function usageError(msg) {
  console.error(`npm-publish: ${msg}`)
  console.error('usage: node scripts/ci/npm-publish.mjs tag <version> [--registry URL] [--package PATH]')
  console.error(
    '       node scripts/ci/npm-publish.mjs verify <tarball> <version> [--registry URL] [--package PATH] [--attempts N] [--poll-seconds N]',
  )
  process.exit(2)
}

/**
 * @param {string[]} argv
 * @returns {{ positionals: string[], registry: string, packagePath: string, attempts: number, pollSeconds: number }}
 */
function parseArgs(argv) {
  /** @type {string[]} */ const positionals = []
  let registry = 'https://registry.npmjs.org'
  let packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
  let attempts = 10
  let pollSeconds = 15
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--registry') registry = argv[(i += 1)] ?? ''
    else if (argv[i] === '--package') packagePath = argv[(i += 1)] ?? ''
    else if (argv[i] === '--attempts') attempts = Number(argv[(i += 1)])
    else if (argv[i] === '--poll-seconds') pollSeconds = Number(argv[(i += 1)])
    else positionals.push(argv[i])
  }
  if (!/^https?:\/\/\S+$/.test(registry)) usageError(`--registry ${JSON.stringify(registry)} is not an http(s) URL`)
  if (!Number.isInteger(attempts) || attempts < 1) usageError('--attempts must be a positive integer')
  if (!Number.isFinite(pollSeconds) || pollSeconds < 0) usageError('--poll-seconds must be a non-negative number')
  return { positionals, registry: registry.replace(/\/+$/, ''), packagePath, attempts, pollSeconds }
}

/**
 * The package's name, after checking that `version` is the version package.json declares.
 * @param {string} packagePath
 * @param {string} version
 * @returns {string}
 */
function packageName(packagePath, version) {
  /** @type {{ name?: unknown, version?: unknown }} */
  let pkg
  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch (e) {
    return usageError(`cannot read ${packagePath}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof pkg.name !== 'string' || !NAME_SHAPE.test(pkg.name)) {
    return usageError(`${packagePath} has no unscoped package name`)
  }
  if (pkg.version !== version) {
    return usageError(`the version argument is ${version}, but ${packagePath} declares ${String(pkg.version)}`)
  }
  return pkg.name
}

/**
 * GET a registry JSON document. 404 is null (absent); any other failure throws.
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} answered ${String(res.status)}`)
  return res.json()
}

/**
 * One read of a version document: the document (null when absent), or why the read failed,
 * so a network failure is retried like absence instead of ending the run.
 * @param {string} url
 * @returns {Promise<{ meta: any } | { failure: string }>}
 */
async function readVersion(url) {
  try {
    return { meta: await getJson(url) }
  } catch (e) {
    return { failure: `reading the registry failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** @param {{ positionals: string[], registry: string, packagePath: string }} args */
async function tagCommand({ positionals, registry, packagePath }) {
  const [version] = positionals
  if (version === undefined || positionals.length !== 1) usageError('tag takes exactly one <version>')
  const name = packageName(packagePath, version)
  /** @type {Record<string, string> | null} */
  let distTags
  try {
    distTags = await getJson(`${registry}/-/package/${name}/dist-tags`)
  } catch (e) {
    console.error(`::error::npm-publish tag: ${name}@${version}: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
  const decided = distTagFor(version, distTags)
  if ('error' in decided) {
    console.error(`::error::npm-publish tag: ${name}@${version}: ${decided.error}`)
    process.exit(1)
  }
  console.log(decided.tag)
}

/** @param {{ positionals: string[], registry: string, packagePath: string, attempts: number, pollSeconds: number }} args */
async function verifyCommand({ positionals, registry, packagePath, attempts, pollSeconds }) {
  const [tarball, version] = positionals
  if (tarball === undefined || version === undefined || positionals.length !== 2) {
    usageError('verify takes <tarball> <version>')
  }
  const name = packageName(packagePath, version)
  const expected = integrityOf(readFileSync(tarball))
  let problems = ['the registry was never asked']
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const read = await readVersion(`${registry}/${name}/${version}`)
    problems = 'failure' in read ? [read.failure] : publishProblems(read.meta, expected)
    if (problems.length === 0) {
      console.log(`${name}@${version}: the registry holds the attested tarball (${expected}), with provenance, published through the GitHub trusted publisher`)
      return
    }
    // Only absence and a failed read are worth waiting out; a record that exists and is
    // wrong will not become right.
    if ('meta' in read && read.meta !== null) break
    console.log(`attempt ${String(attempt)}/${String(attempts)}: ${name}@${version}: ${problems[0]}`)
    if (attempt < attempts) await new Promise((res) => setTimeout(res, pollSeconds * 1000))
  }
  for (const p of problems) console.error(`::error::npm-publish verify: ${name}@${version}: ${p}`)
  process.exit(1)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'tag') await tagCommand(args)
  else if (command === 'verify') await verifyCommand(args)
  else usageError(`unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
