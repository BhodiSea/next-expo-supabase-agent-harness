// THE RED-PROOF for check-eol-target (0.11.0) — the factory-side half of the defect that
// shipped twice: `template/base/tools/eol.json` is SEEDED, its production-scope
// `removalTarget` is a date the HARNESS writes, and when that date equals the version being
// cut every fresh scaffold reds on `version-sync` while `update` cannot correct any install
// that already holds the value. 0.10.0 met it (found by the upgrade lane, after 23 green
// factory Stop steps); 0.11.0 was dated by that very fix and met it again.
//
// The [repo-root] positional is the seam: each fixture is a REAL git repo, because the
// seeded-reach closure diffs the register against the previous release TAG. Fixtures are
// built so the HIGHEST tag equals the fixture's own package.json version — the release-commit
// shape the strictly-below rule exists for, and the shape that made three earlier copies of
// this idiom diff a release against its own tree.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-eol-target.mjs', import.meta.url))

// The lane-env doctrine: the local suite runs CI-shaped, so scrub the vars a leaked
// environment could steer a spawned gate with. This gate DOES read CI (skip-loudly vs
// fail-closed), so the case about that asymmetry sets it explicitly.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of ['CI', 'HARNESS_REQUIRE_TOOLCHAINS', 'HARNESS_ALLOW_SELF_EDIT', 'GITHUB_BASE_REF']) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

// Hermetic git: the fixture's history must not depend on the machine's config. The LITERAL
// '/dev/null', not os.devNull — Git for Windows translates the literal string to its NUL
// device while os.devNull is `\\.\nul`, a path git cannot open. Mirrors
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

const register = (rows) => JSON.stringify({ reviewedOn: '2026-01-01', deprecated: rows })
const uuidRow = (target, scope = 'production') => ({
  package: 'uuid',
  scope,
  reason: 'fixture acceptance',
  ...(target === null ? {} : { removalTarget: target }),
})

const PROBED = { '0.2.0': { seededSourceFixes: [{ probes: [{ path: 'tools/eol.json' }] }] } }
const UNPROBED = { '0.2.0': { seededSourceFixes: [{ probes: [{ path: 'apps/web/e2e/home.spec.ts' }] }] } }

/**
 * A fixture repo at version 0.2.0. Tagged history: v0.1.0 carries `before`, v0.2.0 carries
 * `after` — so the highest tag equals the fixture's own version and the baseline must
 * resolve to v0.1.0, never to itself.
 * @returns {string} the fixture root
 */
function makeRepo({ before, after, migrations = PROBED, tagged = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-eoltarget-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  write('package.json', JSON.stringify({ name: 'fixture', version: '0.2.0' }))
  write('template/migrations.json', JSON.stringify(migrations))
  write('template/base/tools/eol.json', before)
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'release v0.1.0'])
  if (!tagged) {
    write('template/base/tools/eol.json', after)
    return dir
  }
  git(dir, ['tag', 'v0.1.0'])
  write('template/base/tools/eol.json', after)
  git(dir, ['add', '-A'])
  // --allow-empty: the cases where `before` and `after` are identical (dev-scope, empty
  // register) are testing the CURRENT tree, not a delta, and a fixture that cannot build
  // its second tag would fail before reaching the assertion.
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'release v0.2.0'])
  git(dir, ['tag', 'v0.2.0'])
  return dir
}

function run(dir, envExtra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env: cleanEnv(envExtra) })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('RED: a production-scope removalTarget EQUAL to the version being cut — the 0.10.0/0.11.0 class', () => {
  const dir = makeRepo({ before: register([uuidRow('0.1.0')]), after: register([uuidRow('0.2.0')]) })
  const { code, out } = run(dir)
  assert.equal(code, 1, `an arrived target must red:\n${out}`)
  assert.match(out, /the uuid acceptance carries removalTarget 0\.2\.0 and package\.json is 0\.2\.0 — it has ARRIVED/)
  // The seeded reach is the half a reader must not miss: re-dating buys fresh scaffolds only.
  assert.match(out, /This file is SEEDED/)
})

test('RED: a removalTarget BELOW the version — an arrival that was slept through, not merely met', () => {
  const dir = makeRepo({ before: register([uuidRow('0.1.0')]), after: register([uuidRow('0.1.5')]) })
  const { code, out } = run(dir)
  assert.equal(code, 1, `a target already passed must red:\n${out}`)
  assert.match(out, /removalTarget 0\.1\.5 and package\.json is 0\.2\.0 — it has ARRIVED/)
})

test('GREEN + the strictly-below pin: the baseline is the PREVIOUS tag, never the tag being cut', () => {
  const dir = makeRepo({ before: register([uuidRow('0.2.0')]), after: register([uuidRow('0.9.0')]) })
  const { code, out } = run(dir)
  assert.equal(code, 0, out)
  // "vs v0.1.0" with "1 moved target(s)" proves the diff ran against the predecessor: against
  // the fixture's own v0.2.0 tree the register is identical and the count would be 0, so this
  // assertion is what fails if the `.at(-1)` shape ever comes back.
  assert.match(out, /EOL TARGET: CLEAN \(1 production-scope removalTarget\(s\) at v0\.2\.0, none arrived; seeded-reach vs v0\.1\.0: 1 moved target\(s\)\)/)
  assert.ok(!out.includes('vs v0.2.0'), `the baseline must never be the tag being cut:\n${out}`)
})

test('RED: a moved target with no seededSourceFixes probe on tools/eol.json reaches no existing install', () => {
  const dir = makeRepo({
    before: register([uuidRow('0.2.0')]),
    after: register([uuidRow('0.9.0')]),
    migrations: UNPROBED,
  })
  const { code, out } = run(dir)
  assert.equal(code, 1, `a moved target with no channel must red:\n${out}`)
  assert.match(out, /removalTarget moved for uuid -> 0\.9\.0 since v0\.1\.0, but template\/migrations\.json "0\.2\.0" carries no seededSourceFixes probe on tools\/eol\.json/)
})

test('GREEN: a DEV-scope row is not judged — the scope filter is real, not decorative', () => {
  // Same arrived date, dev scope. `arrivedAcceptances` judges production scope only, because
  // only a production-closure acceptance carries removalTarget at all; a gate that reds here
  // would be inventing an obligation the consumer-side check does not have.
  const dir = makeRepo({
    before: register([uuidRow('0.2.0', 'development')]),
    after: register([uuidRow('0.2.0', 'development')]),
  })
  const { code, out } = run(dir)
  assert.equal(code, 0, `a dev-scope arrival must not red:\n${out}`)
  assert.match(out, /0 production-scope removalTarget\(s\)/)
})

test('RED: an emptied or renamed `deprecated` array — anti-vacuity, because every check here filters it', () => {
  const empty = JSON.stringify({ reviewedOn: '2026-01-01', deprecated: [] })
  const dir = makeRepo({ before: empty, after: empty })
  const { code, out } = run(dir)
  assert.equal(code, 1, `an empty register must red rather than report clean:\n${out}`)
  assert.match(out, /carries no `deprecated` rows at all/)
  assert.match(out, /pass vacuously/)
})

test('RED in CI / SKIP loudly outside it: no reachable tag is a verdict about clone depth, not about the tree', () => {
  const dir = makeRepo({ before: register([uuidRow('0.9.0')]), after: register([uuidRow('0.9.0')]), tagged: false })
  const ci = run(dir, { CI: 'true' })
  assert.equal(ci.code, 1, `in CI a missing tag must fail closed:\n${ci.out}`)
  assert.match(ci.out, /no v\*\.\*\.\* tag strictly below 0\.2\.0 is reachable/)
  assert.match(ci.out, /A skip is not allowed in CI/)
  const local = run(dir)
  assert.equal(local.code, 0, `outside CI the same condition skips loudly:\n${local.out}`)
  assert.match(local.out, /seeded-reach closure SKIPPED/)
  assert.match(local.out, /FAILS CLOSED in CI/)
})
