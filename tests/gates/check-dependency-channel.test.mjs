// THE FACTORY GATE'S OWN RED-PROOF (0.7.0) — check-dependency-channel had zero test
// references: the factory-gate class the 0.6.0 changelog names for `hygiene` (no
// canary-registry entry — that registry closes over the shipped chain and the Stop chain,
// and these scripts ship to nobody), so the gate could spend releases with no watched
// failure. This one had already failed unwatched once: its private previousTag() kept the
// `.at(-1)` shape through the v0.6.0 hotfix class, resolving the tag being cut as its own
// predecessor on every release commit.
//
// The [repo-root] positional is the seam: each fixture is a REAL git repo (tags are the
// gate's input, so the fixture must have real ones) whose catalog, owned config and
// migrations ledger this suite skews one surface at a time. The fixtures carry >= 20
// catalog keys and >= 3 owned-config references on purpose — the gate's own anti-vacuity
// tripwires red below those floors, and a fixture that trips them would be testing the
// tripwire instead of the closure.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-dependency-channel.mjs', import.meta.url))

// The lane-env doctrine: the local suite runs CI-shaped, so scrub the vars a leaked
// environment could steer a spawned gate with. This gate DOES read CI (skip-loudly vs
// fail-closed), so cases that are about that asymmetry set it explicitly.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of ['CI', 'HARNESS_REQUIRE_TOOLCHAINS', 'HARNESS_ALLOW_SELF_EDIT', 'GITHUB_BASE_REF']) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

// Hermetic git: the fixture's history must not depend on the machine's config (hooks,
// signing, default branch prompts), or the proof reds on somebody else's dotfiles.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid.example',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid.example',
}
function git(dir, args) {
  execFileSync('git', args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' })
}

// 22 keys: comfortably above the gate's `now.size < 20` vacuity floor.
const BASE_PACKAGES = [
  'react', 'react-dom', 'next', 'expo', 'eslint', 'eslint-plugin-jsx-a11y',
  'eslint-plugin-import', 'typescript', 'typescript-eslint', 'vitest', 'globals', 'zod',
  'jiti', 'prettier', 'knip', 'lefthook', 'tsx', 'vite', 'rollup', 'husky', 'nanoid', 'pino',
]
const catalogYaml = (extra = []) =>
  ['packages:', '  - apps/*', 'catalog:', ...[...BASE_PACKAGES, ...extra].map((n) => `  ${n}: ^1.0.0`), ''].join('\n')

// Three references (one dynamic — the 0.4.0 jsx-a11y shape the gate's scanner exists for),
// above the `referenced.size < 3` vacuity floor. jsx-a11y must stay referenced AND
// obligated: the gate's KNOWN_HISTORICAL_GAPS names it unconditionally.
const ownedConfig = (extraLines = '') => `import globalsPkg from 'globals'
import tseslint from 'typescript-eslint'
const a11y = await import('eslint-plugin-jsx-a11y')
${extraLines}export default [globalsPkg, tseslint, a11y]
`

const MIGRATIONS = {
  '0.1.0': {},
  '0.2.0': {
    dependencyObligations: [
      {
        name: 'eslint-plugin-jsx-a11y',
        catalog: '^1.0.0',
        why: 'eslint.config.mjs resolves it dynamically and pnpm-workspace.yaml is seeded, so upgraded installs must add the catalog pin by hand.',
      },
    ],
  },
}

/**
 * A fixture repo at version 0.2.0. Tagged history: v0.1.0 = the base tree, v0.2.0 = the
 * tree after `catalogGain`/`referenceGain` land — so the HIGHEST tag always equals the
 * fixture's own package.json version, which is exactly the release-commit shape the
 * strictly-below rule exists for. `tagged: false` builds one untagged commit instead.
 * @returns {string} the fixture root
 */
function makeRepo({ catalogGain = [], referenceGain = '', tagged = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-depchan-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  write('package.json', JSON.stringify({ name: 'fixture', version: '0.2.0' }))
  write('template/migrations.json', JSON.stringify(MIGRATIONS))
  write('template/base/pnpm-workspace.yaml', catalogYaml())
  write('template/base/eslint.config.mjs', ownedConfig())
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'release v0.1.0'])
  if (!tagged) return dir
  git(dir, ['tag', 'v0.1.0'])
  write('template/base/pnpm-workspace.yaml', catalogYaml(catalogGain))
  write('template/base/eslint.config.mjs', ownedConfig(referenceGain))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'release v0.2.0'])
  git(dir, ['tag', 'v0.2.0'])
  return dir
}

function run(dir, envExtra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env: cleanEnv(envExtra) })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('RED: a catalog key gained since the previous tag, referenced by owned config, with no obligation — the 0.4.0 class', () => {
  const dir = makeRepo({ catalogGain: ['left-pad'], referenceGain: "import leftPad from 'left-pad'\n" })
  const { code, out } = run(dir)
  assert.equal(code, 1, `a channel-less gained dependency must red:\n${out}`)
  // "since v0.1.0" is load-bearing: the fixture's highest tag (v0.2.0) IS its own version,
  // so a baseline of anything but v0.1.0 means the strictly-below rule regressed — under
  // `.at(-1)` the delta is computed against the release's own tree, is empty, and this
  // exact finding becomes unreachable on every release commit.
  assert.match(out, /gained `left-pad` since v0\.1\.0 and a harness-owned config references it, but no dependencyObligations record carries it/)
})

test('GREEN + the strictly-below pin: a repo whose highest tag equals its own version resolves the PREVIOUS tag, never itself', () => {
  // The gained key is deliberately unreferenced: an addition no owned config imports needs
  // no channel, so the tree is clean — and the "1 catalog addition(s)" in the summary
  // proves the delta was computed against v0.1.0 rather than against the fixture's own
  // v0.2.0 tree (where it would be 0).
  const dir = makeRepo({ catalogGain: ['nanoid-dictionary'] })
  const { code, out } = run(dir)
  assert.equal(code, 0, out)
  assert.match(out, /DEPENDENCY CHANNEL: CLEAN \(vs v0\.1\.0: 1 catalog addition\(s\), 3 reference\(s\) across 1 owned config\(s\), 1 obligation\(s\)\)/)
  assert.ok(!out.includes('vs v0.2.0'), `the baseline must never be the tag being cut:\n${out}`)
})

test('RED in CI / SKIP loudly outside it: no reachable tag is a verdict about clone depth, not about the tree', () => {
  const dir = makeRepo({ tagged: false })
  const ci = run(dir, { CI: 'true' })
  assert.equal(ci.code, 1, `in CI a missing tag must fail closed:\n${ci.out}`)
  assert.match(ci.out, /no v\*\.\*\.\* tag reachable/)
  assert.match(ci.out, /skips are not allowed in CI/)
  const local = run(dir)
  assert.equal(local.code, 0, `outside CI the same condition skips loudly:\n${local.out}`)
  assert.match(local.out, /DEPENDENCY CHANNEL: SKIPPED/)
  assert.match(local.out, /FAILS CLOSED in CI/)
})
