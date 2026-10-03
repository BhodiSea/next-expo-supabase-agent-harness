// scripts/ci/npm-publish.mjs (1.1.0, #161): the npm publish job's two verdicts.
//
// `tag` decides the dist-tag a release publishes under, and refuses the cases with no
// mechanical answer: a package the registry has never seen (trusted publishing cannot
// create one, so the first version is a manual publish), a version already published, and
// a lower version on the current major line. `verify` proves, after `npm publish`, that the
// registry holds the attested tarball's bytes with SLSA provenance, published through the
// GitHub trusted publisher: npm's OIDC exchange falls back silently to any other credential,
// so publish's own exit status cannot show that. These tests pin both verdicts pure, then
// run the CLI end to end against a stand-in registry on 127.0.0.1 (no network), including
// the retry that waits out a version not yet visible and the immediate failure on a record
// that exists and is wrong.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  SLSA_PROVENANCE_V1,
  VERIFY_BUDGET,
  distTagFor,
  integrityOf,
  parseVersion,
  publishProblems,
} from '../../scripts/ci/npm-publish.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/ci/npm-publish.mjs', import.meta.url))
const run = promisify(execFile)

const GOOD_INTEGRITY = integrityOf(Buffer.from('attested tarball bytes'))
/**
 * A registry version document as npm serves one published through a trusted publisher.
 * Typed `any` so each test can strip or rewrite the part it is about.
 * @returns {any}
 */
const goodMeta = (integrity = GOOD_INTEGRITY) => ({
  version: '1.2.3',
  dist: { integrity, attestations: { url: 'x', provenance: { predicateType: SLSA_PROVENANCE_V1 } } },
  _npmUser: { name: 'GitHub Actions', trustedPublisher: { id: 'github', oidcConfigId: 'c' } },
})

// ── parseVersion / distTagFor: the dist-tag decision, pure ───────────────────

test('parseVersion reads x.y.z and x.y.z-pre, and nothing looser', () => {
  assert.deepEqual(parseVersion('1.2.3'), { release: [1, 2, 3], prerelease: null })
  assert.deepEqual(parseVersion('2.0.0-rc.1'), { release: [2, 0, 0], prerelease: 'rc.1' })
  for (const bad of ['v1.2.3', '1.2', '1.2.3.4', '', '^1.2.3']) assert.equal(parseVersion(bad), null, bad)
})

test('a version above latest publishes as latest', () => {
  assert.deepEqual(distTagFor('1.1.0', { latest: '1.0.4' }), { tag: 'latest' })
  assert.deepEqual(distTagFor('2.0.0', { latest: '1.9.9' }), { tag: 'latest' })
})

test('a prerelease publishes as next, never latest', () => {
  assert.deepEqual(distTagFor('2.0.0-rc.1', { latest: '1.1.0' }), { tag: 'next' })
})

test('the release of a prerelease that holds latest takes latest', () => {
  assert.deepEqual(distTagFor('2.0.0', { latest: '2.0.0-rc.1' }), { tag: 'latest' })
})

test('a maintenance release on an older major line publishes as v<major>', () => {
  assert.deepEqual(distTagFor('1.0.5', { latest: '2.0.0' }), { tag: 'v1' })
})

test('a package the registry has never seen is refused, naming the manual first publish', () => {
  const r = distTagFor('1.1.0', null)
  assert.ok('error' in r && /not on the registry/.test(r.error) && /by hand/.test(r.error), JSON.stringify(r))
})

test('re-publishing latest, a lower version on the same major, and a malformed version are refused', () => {
  assert.ok('error' in distTagFor('1.1.0', { latest: '1.1.0' }))
  assert.ok('error' in distTagFor('1.0.9', { latest: '1.1.0' }))
  assert.ok('error' in distTagFor('v1.1.0', { latest: '1.0.4' }))
})

// ── publishProblems: the post-publish verdict, pure ──────────────────────────

test('the attested bytes, with provenance, from the trusted publisher → no problems', () => {
  assert.deepEqual(publishProblems(goodMeta(), GOOD_INTEGRITY), [])
})

test('an absent version is one problem, which the CLI retries', () => {
  assert.deepEqual(publishProblems(null, GOOD_INTEGRITY), ['the registry has no record of this version'])
})

test('different bytes on the registry are named', () => {
  const p = publishProblems(goodMeta(integrityOf(Buffer.from('other bytes'))), GOOD_INTEGRITY)
  assert.equal(p.length, 1)
  assert.match(p[0], /different bytes than the GitHub Release asset/)
})

test('a version with no provenance, or the wrong predicate, is named', () => {
  const none = goodMeta()
  delete none.dist.attestations
  assert.match(publishProblems(none, GOOD_INTEGRITY).join('\n'), /no provenance attestation/)
  const wrong = goodMeta()
  wrong.dist.attestations.provenance.predicateType = 'https://example.test/other'
  assert.match(publishProblems(wrong, GOOD_INTEGRITY).join('\n'), /provenance predicate is/)
})

test('a version published with a token instead of the trusted publisher is named', () => {
  const token = goodMeta()
  token._npmUser = { name: 'someone' }
  assert.match(publishProblems(token, GOOD_INTEGRITY).join('\n'), /not through a GitHub trusted publisher/)
})

// ── the CLI, end to end, against a stand-in registry ─────────────────────────

/**
 * Serve `routes` (path → body, or a function of the request count) on 127.0.0.1, run the
 * CLI with `args` plus --registry and --package, and close the server.
 * @param {Record<string, unknown>} routes
 * @param {string[]} args
 */
async function cli(routes, args) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-publish-'))
  const pkg = join(dir, 'package.json')
  writeFileSync(pkg, JSON.stringify({ name: 'fixture-pkg', version: '1.2.3' }))
  const tarball = join(dir, 'fixture-pkg-1.2.3.tgz')
  writeFileSync(tarball, 'attested tarball bytes')
  /** @type {Record<string, number>} */ const hits = {}
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    hits[path] = (hits[path] ?? 0) + 1
    const route = routes[path]
    const body = typeof route === 'function' ? route(hits[path]) : route
    if (body === undefined || body === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('"Not Found"')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const argv = [SCRIPT, ...args.map((a) => (a === '<tarball>' ? tarball : a))]
  argv.push('--registry', `http://127.0.0.1:${String(port)}`, '--package', pkg)
  try {
    const r = await run(process.execPath, argv)
    return { code: 0, stdout: r.stdout, stderr: r.stderr, hits }
  } catch (e) {
    const err = /** @type {{ code: number, stdout: string, stderr: string }} */ (e)
    return { code: err.code, stdout: err.stdout, stderr: err.stderr, hits }
  } finally {
    server.close()
  }
}

test('CLI tag prints the dist-tag on stdout and nothing else', async () => {
  const r = await cli({ '/-/package/fixture-pkg/dist-tags': { latest: '1.2.2' } }, ['tag', '1.2.3'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'latest\n')
})

test('CLI tag fails, naming the manual first publish, when the package is absent', async () => {
  const r = await cli({}, ['tag', '1.2.3'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /not on the registry/)
})

test('CLI tag refuses a version that is not the one package.json declares', async () => {
  const r = await cli({ '/-/package/fixture-pkg/dist-tags': { latest: '1.2.2' } }, ['tag', '1.2.4'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /declares 1\.2\.3/)
})

test('CLI verify passes when the registry holds the attested tarball through the trusted publisher', async () => {
  const r = await cli({ '/fixture-pkg/1.2.3': goodMeta() }, ['verify', '<tarball>', '1.2.3', '--attempts', '1'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /holds the attested tarball/)
})

test('CLI verify waits out a version that is not visible yet', async () => {
  const r = await cli({ '/fixture-pkg/1.2.3': (n) => (n < 3 ? null : goodMeta()) }, [
    'verify',
    '<tarball>',
    '1.2.3',
    '--attempts',
    '5',
    '--poll-seconds',
    '0',
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.hits['/fixture-pkg/1.2.3'], 3)
})

test('CLI verify fails after the budget when the version never appears', async () => {
  const r = await cli({}, ['verify', '<tarball>', '1.2.3', '--attempts', '3', '--poll-seconds', '0'])
  assert.equal(r.code, 1)
  assert.equal(r.hits['/fixture-pkg/1.2.3'], 3)
  assert.match(r.stderr, /no record of this version/)
})

test('the default verify budget waits several minutes, as npm says a trusted publish can take', () => {
  // v2.0.0 became readable 158 s after `npm publish` returned; a budget below five minutes
  // would red that publish again.
  const waitedSeconds = (VERIFY_BUDGET.attempts - 1) * VERIFY_BUDGET.pollSeconds
  assert.ok(waitedSeconds >= 300, `the default budget waits ${String(waitedSeconds)} s`)
  // ...and stays inside publish-npm's 30-minute job timeout, so the job reports the
  // registry's answer rather than being cancelled.
  assert.ok(waitedSeconds < 25 * 60, `the default budget waits ${String(waitedSeconds)} s`)
})

test('CLI verify fails at once on a record that exists and is wrong', async () => {
  const token = goodMeta()
  token._npmUser = { name: 'someone' }
  const r = await cli({ '/fixture-pkg/1.2.3': token }, ['verify', '<tarball>', '1.2.3', '--attempts', '5', '--poll-seconds', '0'])
  assert.equal(r.code, 1)
  assert.equal(r.hits['/fixture-pkg/1.2.3'], 1)
  assert.match(r.stderr, /not through a GitHub trusted publisher/)
})
