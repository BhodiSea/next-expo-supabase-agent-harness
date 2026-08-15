// THE RED-PROOF for check-sbom-drift (0.11.0). The gate's first real run finds ZERO added
// components, and a gate whose first run finds nothing is only worth having if it CAN find
// something — that is what this file establishes, and why the clean line is not decoration.
//
// The [repo-root] positional is the seam: each fixture is a REAL git repo, because the diff
// reads the previous release TAG's lockfile. Fixtures are built so the HIGHEST tag equals the
// fixture's own package.json version — the release-commit shape the strictly-below rule
// exists for, and the shape that made three earlier copies of this idiom diff a release
// against its own tree.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-sbom-drift.mjs', import.meta.url))

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of ['CI', 'HARNESS_REQUIRE_TOOLCHAINS', 'HARNESS_ALLOW_SELF_EDIT', 'GITHUB_BASE_REF']) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

// Hermetic git — the LITERAL '/dev/null' for the Windows reason recorded in
// check-dependency-channel.test.mjs.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid.example',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid.example',
}
function git(dir, args) {
  execFileSync('git', args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' })
}

// 140 packages: comfortably above the gate's own 100-component vacuity floor, which a smaller
// fixture would trip instead of exercising the diff.
const BASE = Array.from({ length: 140 }, (_, i) => `dep-${String(i)}@1.0.0`)
const lock = (keys) => `lockfileVersion: '9.0'\n\npackages:\n${keys.map((k) => `  ${k}:\n    resolution: {integrity: sha512-x}\n`).join('')}\nsnapshots:\n`

const ROW = (purl, release = '0.2.0') => ({
  purl,
  reason: 'a fixture addition reviewed for the purposes of this proof, stated at length enough to clear the bar',
  release,
  reviewedOn: '2026-08-15',
})

/**
 * A fixture repo at version 0.2.0. v0.1.0 carries `before`, v0.2.0 carries `after`, so the
 * highest tag equals the fixture's own version and the baseline must resolve to v0.1.0.
 */
function makeRepo({ before = BASE, after = BASE, additions = [], tagged = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-sbomdrift-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  write('package.json', JSON.stringify({ name: 'fixture', version: '0.2.0' }))
  write('scripts/sbom-additions.json', JSON.stringify({ additions }))
  write('pnpm-lock.yaml', lock(before))
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'release v0.1.0'])
  if (!tagged) {
    write('pnpm-lock.yaml', lock(after))
    return dir
  }
  git(dir, ['tag', 'v0.1.0'])
  write('pnpm-lock.yaml', lock(after))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'release v0.2.0'])
  git(dir, ['tag', 'v0.2.0'])
  return dir
}

function run(dir, envExtra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env: cleanEnv(envExtra) })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('RED: a component present now and absent at the previous tag, with no reviewed row', () => {
  const dir = makeRepo({ after: [...BASE, 'left-pad@1.3.0'] })
  const { code, out } = run(dir)
  assert.equal(code, 1, `an unreviewed addition must red:\n${out}`)
  assert.match(out, /pkg:npm\/left-pad@1\.3\.0 is in this tree's resolved components and was NOT in v0\.1\.0/)
  assert.match(out, /A dependency nobody chose is how a supply chain moves/)
})

test('GREEN + the strictly-below pin: the same addition with a reviewed row is clean, keyed off the PREVIOUS tag', () => {
  const dir = makeRepo({ after: [...BASE, 'left-pad@1.3.0'], additions: [ROW('pkg:npm/left-pad@1.3.0')] })
  const { code, out } = run(dir)
  assert.equal(code, 0, out)
  // "vs v0.1.0" with "1 added" proves the diff ran against the predecessor: against the
  // fixture's own v0.2.0 tree the lockfile is identical and the count would be 0.
  assert.match(out, /SBOM DRIFT: CLEAN \(vs v0\.1\.0: 141 component\(s\), 1 added, 0 removed, 1 reviewed row\(s\)\)/)
  assert.ok(!out.includes('vs v0.2.0'), `the baseline must never be the tag being cut:\n${out}`)
})

test('RED: a scoped package is compared on its percent-encoded purl, not its raw name', () => {
  // The spelling detail purlForLockKey exists for: comparing un-encoded silently mismatches
  // every scoped package, which is most of them, and a check that mismatches everything gets
  // deleted rather than fixed. A raw-name row must NOT satisfy the scoped addition.
  const dir = makeRepo({
    after: [...BASE, '@scope/thing@2.0.0'],
    additions: [ROW('pkg:npm/@scope/thing@2.0.0')],
  })
  const { code, out } = run(dir)
  assert.equal(code, 1, `an un-encoded row must not satisfy a scoped addition:\n${out}`)
  assert.match(out, /pkg:npm\/%40scope\/thing@2\.0\.0/)
})

test('RED: a row claiming THIS release that is not an addition has outlived its subject', () => {
  const dir = makeRepo({ additions: [ROW('pkg:npm/never-arrived@9.9.9', '0.2.0')] })
  const { code, out } = run(dir)
  assert.equal(code, 1, out)
  assert.match(out, /is reviewed for release 0\.2\.0 but is not an addition in this diff/)
  assert.match(out, /Retire it/)
})

test('GREEN: a row for an EARLIER release is left alone — its component is in both trees now', () => {
  // The end state of every allowlist row, and it must not read as staleness: a component
  // reviewed at 0.1.0 is present at both ends of a 0.1.0 -> 0.2.0 diff and is no longer an
  // addition. Scoping the stale check to the CURRENT release is what stops this file rotting.
  const dir = makeRepo({ additions: [ROW('pkg:npm/dep-0@1.0.0', '0.1.0')] })
  const { code, out } = run(dir)
  assert.equal(code, 0, out)
})

test('RED: an allowlist row without a substantive reason, a purl, or a release', () => {
  const dir = makeRepo({
    after: [...BASE, 'left-pad@1.3.0'],
    additions: [{ purl: 'left-pad', reason: 'too short', release: 'soon' }],
  })
  const { code, out } = run(dir)
  assert.equal(code, 1, out)
  assert.match(out, /must be a pkg:npm\/… string/)
  assert.match(out, /needs a substantive 'reason'/)
  assert.match(out, /needs the 'release' it was reviewed for/)
})

test('RED (anti-vacuity): a lockfile that parses to almost nothing reds instead of reporting no drift', () => {
  const dir = makeRepo({ before: ['solo@1.0.0'], after: ['solo@1.0.0'] })
  const { code, out } = run(dir)
  assert.equal(code, 1, `a broken parse must red rather than report a clean diff:\n${out}`)
  assert.match(out, /the machinery closure is larger than that at every release/)
})

test('RED in CI / SKIP loudly outside it: no reachable tag is a verdict about clone depth', () => {
  const dir = makeRepo({ tagged: false })
  const ci = run(dir, { CI: 'true' })
  assert.equal(ci.code, 1, ci.out)
  assert.match(ci.out, /no v\*\.\*\.\* tag strictly below 0\.2\.0 is reachable/)
  assert.match(ci.out, /A skip is not allowed in CI/)
  const local = run(dir)
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /SKIPPED/)
  assert.match(local.out, /FAILS CLOSED in CI/)
})
