// End-to-end installer lifecycle against the real template tree:
// init (bootstrap + retrofit + dry-run), update refresh/drift semantics,
// doctor exit codes, module enable/disable, CI-floor lockstep, npm pack.
// Ported from the tauri-postgres-agent-harness suite and adapted to this
// repo's layout truth (installer/lib/layout.mjs): apps/mobile Expo app,
// APP_IDENTIFIER store identity (identity.lock.json), empty RETIRED_MODULES,
// and the opt-in module trees (11 from W7 + ci-web-deploy in W8; the pre-W7 skip
// guards armed when the module files landed; shippedModules() keeps them honest
// about the tree, so the count is derived, never hard-coded here).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// Run the CLI, always returning { code, out } — exit codes are part of the
// contract here (0 clean, 1 broken, 2 conflicts/drift), so never throw.
/** @param {string[]} args @param {{ cwd?: string }} [opts] */
function run(args, { cwd } = {}) {
  const res = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

// Residue scanning goes through the ONE shared scanner (scripts/check-residue.mjs)
// — the selftest lanes run the same script, so the residue definition cannot fork.
const RESIDUE = fileURLToPath(new URL('../../scripts/check-residue.mjs', import.meta.url))
function placeholderResidue(dir) {
  const res = spawnSync('node', [RESIDUE, dir], { encoding: 'utf8' })
  if (res.status === 0) return []
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(1)
}

// Module trees that actually ship files. template/modules/ was empty until W7
// landed the opt-in modules — the module tests below skipped until then and
// self-arm the day a module directory gains content (count-agnostic by design).
function shippedModules() {
  const modulesRoot = join(TEMPLATE, 'modules')
  if (!existsSync(modulesRoot)) return []
  return readdirSync(modulesRoot).filter(
    (e) => statSync(join(modulesRoot, e)).isDirectory() && readdirSync(join(modulesRoot, e)).length > 0,
  )
}

test('bootstrap init renders the monorepo layout with manifest modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-boot-'))
  const r = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(r.code, 0, r.out)

  for (const expected of [
    'package.json',
    'pnpm-workspace.yaml',
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/settings.json',
    '.claude/hooks/stop-validate-gate.mjs',
    'tools/harness.config.mjs',
    'tools/validate.mjs',
    'tools/validate.floor.json',
    'tools/identity.lock.json',
    'apps/mobile/app.config.ts',
    'apps/mobile/eas.json',
    'apps/web/app/page.tsx',
    'supabase/migrations/20260101000100_notes.sql',
    'supabase/config.toml',
    'tests/rls/run-rls.mjs',
    '.harness/manifest.json',
  ]) {
    assert.ok(existsSync(join(dir, expected)), `missing ${expected}`)
  }

  // Dotless storage names must land at their dot-path installs — and the
  // dotless twins must NOT exist in the scaffold.
  for (const [stored, installed] of [
    ['gitignore', '.gitignore'],
    ['gitattributes', '.gitattributes'],
    ['editorconfig', '.editorconfig'],
    ['nvmrc', '.nvmrc'],
    ['node-version', '.node-version'],
    ['gitleaks.toml', '.gitleaks.toml'],
    ['dependency-cruiser.cjs', '.dependency-cruiser.cjs'],
    ['mcp.json', '.mcp.json'],
    ['env.example', '.env.example'],
  ]) {
    assert.ok(existsSync(join(dir, installed)), `rename not applied: ${stored} → ${installed}`)
    assert.ok(!existsSync(join(dir, stored)), `dotless twin leaked into scaffold: ${stored}`)
  }
  // github/ → .github (the template ships consumer CI workflows there).
  assert.ok(existsSync(join(dir, '.github')), 'github/ not renamed to .github')
  assert.ok(!existsSync(join(dir, 'github')), 'dotless github/ leaked into scaffold')

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'fixture-app')
  assert.equal(pkg.scripts.validate, 'node tools/validate.mjs')

  // CLAUDE.md must be a pure @AGENTS.md include (doctor enforces this later).
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md')

  // Expo store identity: rendered into app.config.ts, and in lockstep with the
  // identity lock (the expo-policy gate asserts the resolved config equals it).
  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(dir, 'tools/identity.lock.json'), 'utf8'))
  const appConfig = readFileSync(join(dir, 'apps/mobile/app.config.ts'), 'utf8')
  assert.equal(lock.appIdentifier, manifest.answers.APP_IDENTIFIER, 'identity lock must pin the answered APP_IDENTIFIER')
  assert.equal(lock.appIdentifier, 'com.example.fixtureapp', 'default APP_IDENTIFIER must derive from the slug')
  assert.equal(lock.scheme, manifest.answers.APP_SCHEME)
  assert.ok(appConfig.includes(`bundleIdentifier: '${lock.appIdentifier}'`), 'ios.bundleIdentifier must render the identity')
  assert.ok(appConfig.includes(`package: '${lock.appIdentifier}'`), 'android.package must render the identity')
  // The identifier is store identity on BOTH stores — it must satisfy the
  // iOS/Android intersection rule (letter-first segments, no hyphens/underscores).
  assert.match(lock.appIdentifier, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, 'identifier violates the two-store intersection rule')

  // Zero placeholder residue anywhere in the rendered scaffold.
  assert.deepEqual(placeholderResidue(dir), [], 'unrendered {{TOKENS}} in scaffold')

  // Manifest modes: config vs seeded vs owned drive update/doctor semantics.
  assert.equal(manifest.mode, 'bootstrap')
  assert.equal(manifest.files['tools/harness.config.mjs'].mode, 'config')
  assert.equal(manifest.files['tools/validate.mjs'].mode, 'owned')
  assert.equal(manifest.files['.claude/hooks/stop-validate-gate.mjs'].mode, 'owned')
  assert.equal(manifest.files['apps/mobile/app.config.ts'].mode, 'seeded')
  assert.equal(manifest.files['apps/web/app/page.tsx'].mode, 'seeded')
  assert.equal(manifest.files['supabase/migrations/20260101000100_notes.sql'].mode, 'seeded')
  assert.equal(manifest.files['pnpm-workspace.yaml'].mode, 'seeded')
  assert.equal(manifest.files['AGENTS.md'].mode, 'seeded')

  // Manifest keys are POSIX on every OS — path.win32.join separators broke
  // every prefix-based mode rule and made manifests non-portable (upstream
  // v0.1.1 bug class). This assertion is load-bearing on the windows-latest leg.
  const backslashed = Object.keys(manifest.files).filter((k) => k.includes('\\'))
  assert.deepEqual(backslashed, [], 'manifest keys must use POSIX separators on every OS')

  // Fresh installs start already graduated: baseVersion (the seeded-content
  // vintage the version-ramped gates compare against) equals harnessVersion.
  assert.equal(manifest.baseVersion, manifest.harnessVersion, 'init must stamp baseVersion == harnessVersion')
})

test('dry-run writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-dry-'))
  const r = run(['init', '--dir', dir, '--yes', '--dry-run', ...SETS])
  assert.equal(r.code, 0, r.out)
  assert.ok(!existsSync(join(dir, 'package.json')))
  assert.ok(!existsSync(join(dir, '.harness')))
})

test('retrofit: non-clobber configs, merged workspace yaml, no stack app code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-retro-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'existing', dependencies: { next: '16.0.0' }, scripts: { validate: 'my-own-gate' } }),
  )
  const theirWorkspace = "# their workspace\npackages:\n  - 'apps/*'\n"
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), theirWorkspace)
  writeFileSync(join(dir, 'eslint.config.mjs'), 'export default []\n')
  mkdirSync(join(dir, 'apps/web/src'), { recursive: true })
  writeFileSync(join(dir, 'apps/web/package.json'), '{"name":"web"}\n')
  writeFileSync(join(dir, 'apps/web/src/index.ts'), 'export const theirs = true\n')

  // Conflicts (validate script, eslint config) are reported with exit 2 by design.
  const r = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(r.code, 2, r.out)

  // package.json: merged, never clobbered.
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.validate, 'my-own-gate', 'existing validate script must be kept')
  assert.equal(pkg.scripts['harness:validate'], 'node tools/validate.mjs')

  // Root configs: theirs byte-identical, ours at a .harness sibling.
  assert.equal(readFileSync(join(dir, 'eslint.config.mjs'), 'utf8'), 'export default []\n')
  assert.ok(existsSync(join(dir, 'eslint.config.harness.mjs')), 'harness eslint sibling missing')

  // pnpm-workspace.yaml is MERGED (glob union + catalog add-missing), not suffixed.
  const ws = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  assert.ok(ws.startsWith('# their workspace'), 'their workspace header must survive the merge')
  assert.match(ws, /- '?apps\/\*'?/, 'their glob must survive')
  assert.match(ws, /- '?packages\/\*'?/, 'harness glob must be unioned in')
  assert.match(ws, /catalog:/, 'harness catalog must be added')
  assert.match(ws, /'@supabase\/supabase-js'/, 'harness catalog pins must be present')
  assert.ok(!existsSync(join(dir, 'pnpm-workspace.harness.yaml')), 'workspace yaml must merge, not suffix')

  // Their app code untouched; our stack app code NOT installed on retrofit.
  assert.equal(readFileSync(join(dir, 'apps/web/src/index.ts'), 'utf8'), 'export const theirs = true\n')
  assert.equal(readFileSync(join(dir, 'apps/web/package.json'), 'utf8'), '{"name":"web"}\n')
  assert.ok(!existsSync(join(dir, 'apps/mobile')), 'stack mobile app installed on retrofit')
  assert.ok(!existsSync(join(dir, 'supabase/migrations')), 'stack migrations installed on retrofit')
  // Additive workspace-package seeds ARE installed when absent.
  assert.ok(existsSync(join(dir, 'packages/contracts/package.json')), 'additive contracts package seed missing')
  assert.ok(
    existsSync(join(dir, 'packages/platform/errors/package.json')),
    'additive nested-package seed missing (RETROFIT_ADDITIVE must reach packages/*/*)',
  )

  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(manifest.mode, 'retrofit')

  // The Stop gate invokes the runner directly, so the colliding "validate"
  // script cannot hollow it out.
  const cfg = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.ok(cfg.includes('node tools/validate.mjs'), 'stop gate must invoke the runner directly')
})

test('retrofit non-clobber is universal: project memory, ignore rules, settings, compose, workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-retro2-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'existing', dependencies: { next: '16.0.0' } }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(dir, 'apps/web'), { recursive: true })
  writeFileSync(join(dir, 'apps/web/package.json'), '{"name":"web"}\n')

  const theirAgents = '# My project memory\nDo not touch.\n'
  writeFileSync(join(dir, 'AGENTS.md'), theirAgents)
  // A shipped root config that is deliberately NOT in CONFLICTABLE — so the
  // universal parking path is exercised, not the `<base>.harness.<ext>` sibling
  // path. (docker-compose.yml used to play this role; this lineage's local stack
  // is the Supabase CLI, so nothing ships a compose file to collide with.)
  const theirStryker = 'export default { mutate: ["src/theirs.ts"] }\n'
  writeFileSync(join(dir, 'stryker.config.mjs'), theirStryker)
  writeFileSync(join(dir, '.gitignore'), '# mine\nnode_modules/\n')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(
    join(dir, '.claude/settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(make test)'], defaultMode: 'default' } }, null, 2),
  )
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  const theirWorkflow = 'name: theirs\non: push\njobs: {}\n'
  writeFileSync(join(dir, '.github/workflows/quality-gate.yml'), theirWorkflow)

  const r = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(r.code, 2, r.out)

  // Byte-preserved: their project memory, mutation config, and workflow.
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), theirAgents)
  assert.equal(readFileSync(join(dir, 'stryker.config.mjs'), 'utf8'), theirStryker)
  assert.equal(readFileSync(join(dir, '.github/workflows/quality-gate.yml'), 'utf8'), theirWorkflow)
  // Ours parked OUTSIDE active paths (a sibling in workflows/ would execute).
  for (const parked of [
    '.harness/conflicts/AGENTS.md',
    '.harness/conflicts/stryker.config.mjs',
    '.harness/conflicts/.github/workflows/quality-gate.yml',
  ]) {
    assert.ok(existsSync(join(dir, parked)), `missing parked copy: ${parked}`)
  }

  // .gitignore merged: theirs kept, harness patterns appended.
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  assert.ok(gi.startsWith('# mine\nnode_modules/\n'), gi)
  assert.ok(gi.includes('.dev-auth/'), 'harness ignore patterns must be appended')

  // .claude/settings.json merged: their permission posture kept, hooks wired.
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
  assert.equal(settings.permissions.defaultMode, 'default')
  assert.ok(settings.permissions.allow.includes('Bash(make test)'))
  assert.ok(JSON.stringify(settings.hooks).includes('stop-validate-gate'), 'Stop hook must be wired')
})

test('re-running init on an installed project is refused; --force re-renders with carried answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-reinit-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Tune an owned file, then attempt re-init: must refuse before touching anything.
  const tuned = join(dir, 'tools/harness.config.mjs')
  const tunedContent = `${readFileSync(tuned, 'utf8')}// tuned\n`
  writeFileSync(tuned, tunedContent)
  const again = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(again.code, 1, again.out)
  assert.ok(again.out.includes('already has a harness'), again.out)
  assert.equal(readFileSync(tuned, 'utf8'), tunedContent, 'refused init must not touch files')

  // --force re-renders; prior answers carry over without repeating --set.
  const forced = run(['init', '--dir', dir, '--yes', '--force'])
  assert.equal(forced.code, 0, forced.out)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'fixture-app', 'answers must carry over from the prior manifest')

  // Corrupt manifest: never advise re-init.
  writeFileSync(join(dir, '.harness/manifest.json'), '{ corrupted')
  const broken = run(['doctor', '--dir', dir])
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('restore it from git'), broken.out)
  const initOnCorrupt = run(['init', '--dir', dir, '--yes'])
  assert.equal(initOnCorrupt.code, 1)
  assert.ok(initOnCorrupt.out.includes('restore it from git'), initOnCorrupt.out)
})

test('init rejects invalid placeholder values, unknown --set keys, unknown tiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-val-'))

  // Store identity must satisfy the iOS/Android intersection — hyphens are
  // Android-illegal, so this must fail loud before anything is written.
  const badId = run(['init', '--dir', dir, '--yes', ...SETS,
    '--set', 'APP_IDENTIFIER=com.example.my-app'])
  assert.equal(badId.code, 1, badId.out)
  assert.ok(badId.out.includes('hyphens'), badId.out)
  assert.ok(!existsSync(join(dir, 'package.json')), 'nothing may be written on invalid answers')

  const badOrigin = run(['init', '--dir', dir, '--yes', ...SETS, '--set', 'WEB_ORIGIN=app.example.com/v1'])
  assert.equal(badOrigin.code, 1, badOrigin.out)
  assert.ok(badOrigin.out.includes('bare origin'), badOrigin.out)

  const unknownSet = run(['init', '--dir', dir, '--yes', ...SETS, '--set', 'TYPO_VAR=x'])
  assert.equal(unknownSet.code, 1, unknownSet.out)
  assert.ok(unknownSet.out.includes('unknown placeholder'), unknownSet.out)

  const badTier = run(['init', '--dir', dir, '--yes', '--tier', 'strictest', ...SETS])
  assert.equal(badTier.code, 1, badTier.out)
  assert.ok(badTier.out.includes('unknown tier'), badTier.out)
})

test('enable rejects unknown modules with the known-module list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-unkmod-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  const res = run(['enable', 'no-such-module', '--dir', dir])
  assert.equal(res.code, 1, res.out)
  assert.ok(res.out.includes('unknown module'), res.out)
  assert.ok(res.out.includes('ci-mobile-release'), 'the error must name the known modules')
})

// The pre-W7 ODDITY is CLOSED: `init` now mirrors `enable`'s zero-file guard.
// (Previously `init --tier standard` on an empty module tree silently recorded
// the tier's modules with zero installed files — a false-green manifest entry
// by the installer's own fail-loud doctrine.) Healthy half: with the W7 module
// trees shipped, a standard-tier init records its modules AND attributes real
// installed files to each. Red half: against a doctored installer copy whose
// ci-provenance tree is emptied, the same init fails loud BEFORE writing
// anything — proving the guard, not just the happy path.
test('init fails loud when a tier module resolves to zero files; healthy tiers attribute real files', () => {
  // Healthy: the real template tree.
  const dir = mkdtempSync(join(tmpdir(), 'epah-tiermod-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'standard', ...SETS]).code, 0)
  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.deepEqual(
    [...manifest.modules].sort(),
    ['ci-mobile-release', 'ci-provenance', 'ci-web-deploy'],
    'standard tier must record exactly its modules',
  )
  for (const m of manifest.modules) {
    const owned = Object.entries(manifest.files).filter(([, meta]) => meta.module === m)
    assert.ok(owned.length > 0, `tier module ${m} attributed no installed files`)
    for (const [ip] of owned) assert.ok(existsSync(join(dir, ip)), `module file missing on disk: ${ip}`)
  }

  // Red: a doctored copy of installer+template with an emptied module tree.
  // (The guard is unreachable through the real tree now that every module
  // ships files — the copy is how the red path stays exercised.)
  const copyRoot = mkdtempSync(join(tmpdir(), 'epah-zeromod-'))
  for (const p of ['installer', 'template', 'package.json']) {
    cpSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), join(copyRoot, p), { recursive: true })
  }
  rmSync(join(copyRoot, 'template/modules/ci-provenance'), { recursive: true })
  mkdirSync(join(copyRoot, 'template/modules/ci-provenance'))
  const target = mkdtempSync(join(tmpdir(), 'epah-zeromod-t-'))
  const res = spawnSync(
    'node',
    [join(copyRoot, 'installer/cli.mjs'), 'init', '--dir', target, '--yes', '--tier', 'standard', ...SETS],
    { encoding: 'utf8' },
  )
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  assert.equal(res.status, 1, out)
  assert.ok(out.includes("module 'ci-provenance' resolved to zero files"), out)
  assert.ok(!existsSync(join(target, '.harness/manifest.json')), 'a failed init must not write a manifest')
  assert.ok(!existsSync(join(target, 'package.json')), 'a failed init must not write files')
  rmSync(copyRoot, { recursive: true, force: true })
})

test('enable/disable flips a module: dry-run writes nothing, drift is parked, disable round-trips', (t) => {
  const available = shippedModules()
  if (available.length === 0) {
    t.skip('no template/modules/* trees ship files yet (self-arms at W7)')
    return
  }
  const moduleName = available.includes('gate-a11y-deep') ? 'gate-a11y-deep' : available[0]

  const dir = mkdtempSync(join(tmpdir(), 'epah-mod-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)

  // dry-run: reports but writes nothing, manifest unchanged.
  const before = readFileSync(join(dir, '.harness/manifest.json'), 'utf8')
  const dry = run(['enable', moduleName, '--dir', dir, '--dry-run'])
  assert.equal(dry.code, 0, dry.out)
  assert.equal(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'), before, 'dry-run must not touch the manifest')

  // real enable: module + its files recorded, files on disk.
  const on = run(['enable', moduleName, '--dir', dir])
  assert.equal(on.code, 0, on.out)
  const enabled = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.ok(enabled.modules.includes(moduleName), 'module not recorded in manifest')
  const moduleFiles = Object.entries(enabled.files).filter(([, meta]) => meta.module === moduleName)
  assert.ok(moduleFiles.length > 0, `module ${moduleName} installed no files`)
  for (const [ip] of moduleFiles) {
    assert.ok(existsSync(join(dir, ip)), `enabled module file missing: ${ip}`)
  }

  // Locally modify one module file, re-enable: local content kept, incoming parked.
  const [modRel] = moduleFiles.find(([ip]) => ip.endsWith('.mjs')) ?? moduleFiles[0]
  const modAbs = join(dir, modRel)
  const localContent = `${readFileSync(modAbs, 'utf8')}\n// local tuning\n`
  writeFileSync(modAbs, localContent)
  const re = run(['enable', moduleName, '--dir', dir])
  assert.equal(re.code, 0, re.out)
  assert.equal(readFileSync(modAbs, 'utf8'), localContent, 're-enable must not clobber local changes')
  assert.ok(existsSync(join(dir, '.harness/pending', modRel)), 'incoming module version must be parked')

  // disable: locally-modified file is kept but de-recorded; the rest removed.
  const off = run(['disable', moduleName, '--dir', dir])
  assert.equal(off.code, 0, off.out)
  const disabled = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.ok(!disabled.modules.includes(moduleName), 'module still recorded after disable')
  for (const [ip] of moduleFiles) {
    assert.ok(!(ip in disabled.files), `disabled module file still in manifest: ${ip}`)
    if (ip !== modRel) assert.ok(!existsSync(join(dir, ip)), `disabled module file still present: ${ip}`)
  }
})

// W7 representative round-trips, one per module SHAPE: workflow-heavy
// (ci-mobile-release — dotless github/ storage must land at .github/workflows/),
// doc-plus-test (observability — a file under the seeded apps/ prefix plus
// docs), and slice-shaped (push-notifications — .ts.txt slice files installed
// verbatim under docs/, never as live TypeScript).
test('enable/disable round-trips representative W7 module shapes with correct install paths', () => {
  const cases = [
    {
      name: 'ci-mobile-release',
      expect: [
        '.github/workflows/release-please.yml',
        '.github/workflows/release-mobile.yml',
        '.github/workflows/preview-mobile.yml',
        'release-please-config.json',
        'docs/modules/ci-mobile-release/README.md',
      ],
    },
    {
      name: 'observability',
      expect: [
        'apps/server/src/observability/span-routes.test.ts',
        'docs/modules/observability/README.md',
        'docs/modules/observability/otel-server.patch.md',
      ],
    },
    {
      name: 'push-notifications',
      expect: [
        'docs/modules/push-notifications/README.md',
        'docs/modules/push-notifications/APPLY.md',
        'docs/modules/push-notifications/slice/apps/server/src/routes/push-tokens.ts.txt',
        'docs/modules/push-notifications/slice/packages/schema/drizzle/0003_push_device_tokens.sql',
      ],
    },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'epah-mods3-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)

  for (const c of cases) {
    const on = run(['enable', c.name, '--dir', dir])
    assert.equal(on.code, 0, on.out)
    const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
    assert.ok(manifest.modules.includes(c.name), `${c.name} not recorded`)
    for (const ip of c.expect) {
      assert.ok(existsSync(join(dir, ip)), `${c.name}: expected installed file missing: ${ip}`)
      assert.equal(manifest.files[ip]?.module, c.name, `${c.name}: ${ip} not attributed in manifest`)
    }
  }
  // Slice code must stay inert: no live .ts twin of the .txt slice files.
  assert.ok(
    !existsSync(join(dir, 'docs/modules/push-notifications/slice/apps/server/src/routes/push-tokens.ts')),
    'slice .ts.txt must not install as live .ts',
  )
  // The whole enabled scaffold still renders with zero placeholder residue.
  assert.deepEqual(placeholderResidue(dir), [], 'unrendered {{TOKENS}} after module enables')

  // Disable all three: files gone, attributions gone, the scaffold's own files intact.
  for (const c of cases) {
    const off = run(['disable', c.name, '--dir', dir])
    assert.equal(off.code, 0, off.out)
  }
  const final = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  for (const c of cases) {
    assert.ok(!final.modules.includes(c.name), `${c.name} still recorded after disable`)
    for (const ip of c.expect) {
      assert.ok(!(ip in final.files), `${c.name}: ${ip} still in manifest after disable`)
      assert.ok(!existsSync(join(dir, ip)), `${c.name}: ${ip} still on disk after disable`)
    }
    // No directory husks either: every W7 verifier flagged the empty
    // docs/modules/<name>/ (and src/…) skeletons disable used to leave behind.
    assert.ok(
      !existsSync(join(dir, 'docs/modules', c.name)),
      `${c.name}: empty docs/modules/${c.name}/ husk left after disable`,
    )
  }
  assert.ok(
    !existsSync(join(dir, 'apps/server/src/observability')),
    'observability: empty apps/server/src/observability/ husk left after disable',
  )
  assert.ok(existsSync(join(dir, 'apps/web/app/page.tsx')), 'disable must not touch base scaffold files')
})

test('retrofit rejects hono-only, Tauri, foreign lockfiles, and non-workspace layouts with clear messages', () => {
  const honoDir = mkdtempSync(join(tmpdir(), 'nesah-hono-'))
  writeFileSync(join(honoDir, 'package.json'), JSON.stringify({ dependencies: { hono: '^4.0.0' } }))
  const honoRes = run(['init', '--dir', honoDir, '--yes', ...SETS])
  assert.equal(honoRes.code, 1, honoRes.out)
  assert.ok(honoRes.out.includes('expo-postgres-agent-harness'), honoRes.out)

  const tauriDir = mkdtempSync(join(tmpdir(), 'nesah-tauri-'))
  writeFileSync(join(tauriDir, 'package.json'), JSON.stringify({ dependencies: { '@tauri-apps/api': '^2.0.0' } }))
  const tauriRes = run(['init', '--dir', tauriDir, '--yes', ...SETS])
  assert.equal(tauriRes.code, 1, tauriRes.out)
  assert.ok(tauriRes.out.includes('Tauri'), tauriRes.out)

  const npmDir = mkdtempSync(join(tmpdir(), 'nesah-npmlock-'))
  writeFileSync(join(npmDir, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }))
  writeFileSync(join(npmDir, 'package-lock.json'), '{}\n')
  const npmRes = run(['init', '--dir', npmDir, '--yes', ...SETS])
  assert.equal(npmRes.code, 1, npmRes.out)
  assert.ok(npmRes.out.includes('pnpm'), npmRes.out)

  const bareDir = mkdtempSync(join(tmpdir(), 'nesah-bare-'))
  writeFileSync(join(bareDir, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }))
  const bareRes = run(['init', '--dir', bareDir, '--yes', ...SETS])
  assert.equal(bareRes.code, 1, bareRes.out)
  assert.ok(bareRes.out.includes('pnpm-workspace.yaml'), bareRes.out)
})

test('update refreshes unmodified owned files, preserves drift, never touches seeded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-upd-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // 1. REFRESH: simulate a file installed by an older harness version —
  // content differs from the incoming template but MATCHES its manifest hash
  // (i.e. not locally modified). Update must overwrite it in place.
  const ownedRel = '.claude/hooks/posttool-fast-check.mjs'
  const owned = join(dir, ownedRel)
  const oldContent = '#!/usr/bin/env node\n// old harness version\n'
  writeFileSync(owned, oldContent)
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files[ownedRel].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const refresh = run(['update', '--dir', dir])
  assert.equal(refresh.code, 0, refresh.out)
  const refreshed = readFileSync(owned, 'utf8')
  assert.notEqual(refreshed, oldContent, 'unmodified owned file must be refreshed')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.files[ownedRel].sha256, sha256(refreshed), 'manifest hash must track the refresh')

  // 2. DRIFT: a locally-modified owned file is preserved; the incoming version
  // parks under .harness/pending/ and update exits 2.
  writeFileSync(owned, `${refreshed}\n// local tweak\n`)
  const drift = run(['update', '--dir', dir])
  assert.equal(drift.code, 2, drift.out)
  assert.ok(readFileSync(owned, 'utf8').includes('// local tweak'), 'drifted file must be preserved')
  assert.ok(
    existsSync(join(dir, '.harness/pending', ownedRel)),
    'incoming version must be parked under .harness/pending/',
  )

  // 3. SEEDED: never overwritten by update, no matter what.
  const seeded = join(dir, 'AGENTS.md')
  writeFileSync(seeded, '# mine now\n')
  run(['update', '--dir', dir]) // exit 2 from the still-drifted hook — irrelevant here
  assert.equal(readFileSync(seeded, 'utf8'), '# mine now\n', 'seeded file must never be touched')
})

test('backslash manifest keys: doctor trips, update heals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-bslash-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Simulate a manifest written by a backslash-keying Windows install (the
  // upstream pre-0.1.3 bug class this lineage inherits heal machinery for):
  // rewrite one seeded and one owned key with Windows separators.
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const key of ['apps/web/app/page.tsx', 'tools/validate.mjs']) {
    manifest.files[key.split('/').join('\\')] = manifest.files[key]
    delete manifest.files[key]
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // doctor: hard error (exit 1) naming the migration path.
  const doc = run(['doctor', '--dir', dir])
  assert.equal(doc.code, 1, doc.out)
  assert.ok(doc.out.includes('Windows-separator'), doc.out)

  // update: rewrites the keys to POSIX; a follow-up doctor is quiet about
  // separators and the owned file keeps drift protection under its POSIX key.
  const upd = run(['update', '--dir', dir])
  assert.notEqual(upd.code, 1, upd.out)
  const healed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(
    Object.keys(healed.files).filter((k) => k.includes('\\')),
    [],
    'update must rewrite backslash keys to POSIX',
  )
  assert.ok(healed.files['apps/web/app/page.tsx'], 'healed seeded key must survive under POSIX form')
  const docAfter = run(['doctor', '--dir', dir])
  assert.ok(!docAfter.out.includes('Windows-separator'), docAfter.out)
})

test('doctor exit codes: clean=0, drift=2, broken=1; CLAUDE.md purity enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-doc-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // clean → 0
  const clean = run(['doctor', '--dir', dir])
  assert.equal(clean.code, 0, clean.out)
  assert.ok(clean.out.includes('CLEAN'), clean.out)

  // locally modified owned hook → drift warning → 2
  const hook = join(dir, '.claude/hooks/pretool-bash-guard.mjs')
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n// tweak\n`)
  const drift = run(['doctor', '--dir', dir])
  assert.equal(drift.code, 2, drift.out)
  assert.match(drift.out, /locally modified hook/i, drift.out)
  run(['update', '--dir', dir, '--force']) // restore the hook so later checks stay isolated
  assert.equal(run(['doctor', '--dir', dir]).code, 0, 'restore before next mutation failed')

  // CLAUDE.md must stay a pure @AGENTS.md include → impurity is drift (2)
  const claudeMd = join(dir, 'CLAUDE.md')
  writeFileSync(claudeMd, '@AGENTS.md\n\n# extra memory that belongs in AGENTS.md\n')
  const impure = run(['doctor', '--dir', dir])
  assert.equal(impure.code, 2, impure.out)
  assert.match(impure.out, /pure `@AGENTS\.md` include/, impure.out)
  writeFileSync(claudeMd, '@AGENTS.md\n')
  assert.equal(run(['doctor', '--dir', dir]).code, 0, 'restore before next mutation failed')

  // missing owned gate runner → broken → 1
  rmSync(join(dir, 'tools/validate.mjs'))
  const broken = run(['doctor', '--dir', dir])
  assert.equal(broken.code, 1, broken.out)
  assert.match(broken.out, /ERROR/, broken.out)
})

test('refresh-seeded: overwrite when untouched, park on drift, error on unknown path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-refresh-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  const ip = 'apps/mobile/src/routes.ts'
  const abs = join(dir, ip)
  const templateContent = readFileSync(abs, 'utf8')

  // Simulate "installed by an older template, untouched since": plant old
  // content AND record its sha as the installed state.
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const oldContent = '// old template version\n'
  writeFileSync(abs, oldContent)
  manifest.files[ip].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const refreshed = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(refreshed.code, 0, refreshed.out)
  assert.equal(readFileSync(abs, 'utf8'), templateContent, 'untouched seeded file must refresh to the template version')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.files[ip].mode, 'seeded', 'mode must stay seeded after refresh')

  // Local drift: kept, template version parked.
  const localWork = `${templateContent}\n// my project's real work\n`
  writeFileSync(abs, localWork)
  const parked = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(readFileSync(abs, 'utf8'), localWork, 'local changes must never be clobbered')
  assert.ok(existsSync(join(dir, '.harness/pending', ip)), 'template version must be parked')
  assert.ok(parked.out.includes('parked'), parked.out)

  // Unknown path: loud error with candidates.
  const unknown = run(['update', '--dir', dir, '--refresh-seeded', 'mobile/routes.ts'])
  assert.equal(unknown.code, 1, unknown.out)
  assert.ok(unknown.out.includes('did you mean'), unknown.out)
  assert.ok(unknown.out.includes(ip), unknown.out)
})

test('seedOnInitOnly: plain update withholds a new exemplar; refresh-seeded pulls it on demand and records each sha', (t) => {
  // Self-arming port: this repo's migrations.json carries no version records at
  // 0.1.0 (fresh lineage), so there is nothing to withhold yet. The scenario
  // arms itself the moment a release ships a seedOnInitOnly record.
  const migrations = JSON.parse(readFileSync(join(TEMPLATE, 'migrations.json'), 'utf8'))
  const patterns = [
    ...new Set(
      Object.entries(migrations)
        .filter(([v]) => /^\d+\.\d+\.\d+/.test(v))
        .flatMap(([, entry]) => entry.seedOnInitOnly ?? []),
    ),
  ]
  if (patterns.length === 0) {
    t.skip('no seedOnInitOnly records in template/migrations.json yet (self-arms when a release ships one)')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'epah-seedpull-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // Pick the first pattern that matched at least one installed file; make the
  // cluster absent, as a consumer predating the record would have it, and
  // backdate the install so every migration record is in scope.
  const matches = (pattern, ipath) => (pattern.endsWith('/') ? ipath.startsWith(pattern) : ipath === pattern)
  const pattern = patterns.find((p) => Object.keys(manifest.files).some((ipath) => matches(p, ipath)))
  assert.ok(pattern, `no installed file matches any seedOnInitOnly pattern (${patterns.join(', ')})`)
  const members = Object.keys(manifest.files).filter((ipath) => matches(pattern, ipath))
  for (const ip of members) {
    rmSync(join(dir, ip))
    delete manifest.files[ip]
  }
  manifest.harnessVersion = '0.0.0'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // Plain update: must NOT re-plant, must note the deliberate channel.
  const upd = run(['update', '--dir', dir])
  assert.notEqual(upd.code, 1, upd.out)
  for (const ip of members) assert.ok(!existsSync(join(dir, ip)), `plain update must not plant ${ip}`)
  assert.ok(upd.out.includes('not auto-planted'), upd.out)
  assert.ok(upd.out.includes(pattern), upd.out)
  const afterPlain = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const ip of members) assert.ok(!afterPlain.files[ip], `withheld exemplar must not be recorded: ${ip}`)

  // The advertised opt-in: refresh-seeded the pattern → every member lands
  // and is recorded (sha + seeded mode).
  const pull = run(['update', '--dir', dir, '--refresh-seeded', pattern])
  assert.equal(pull.code, 0, pull.out)
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const ip of members) {
    assert.ok(existsSync(join(dir, ip)), `refresh-seeded must plant ${ip}`)
    assert.ok(after.files[ip], `refresh-seeded must record ${ip}`)
    assert.equal(after.files[ip].sha256, sha256(readFileSync(join(dir, ip))), `sha recorded for ${ip}`)
    assert.equal(after.files[ip].mode, 'seeded', `${ip} stays seeded`)
  }
})

test('update: baseVersion carries the seeded-content vintage — pre-baseVersion manifests inherit harnessVersion, stamped values persist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-basev-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  const manifestPath = join(dir, '.harness/manifest.json')
  const installerVersion = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ).version

  // Simulate a manifest from before baseVersion existed: no baseVersion field,
  // harnessVersion one release behind the running installer.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.baseVersion
  manifest.harnessVersion = '0.0.9'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // update: harnessVersion advances to the running installer; baseVersion is
  // stamped to the PRE-update harnessVersion — the release whose seeded
  // content the tree still carries (update withholds new exemplars).
  const upd = run(['update', '--dir', dir])
  assert.notEqual(upd.code, 1, upd.out)
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.harnessVersion, installerVersion)
  assert.equal(after.baseVersion, '0.0.9', 'a pre-baseVersion consumer inherits its old harnessVersion as baseVersion')

  // A second update must NOT drag baseVersion forward — graduation is a human
  // act (`graduate`), never an installer side effect.
  const again = run(['update', '--dir', dir])
  assert.notEqual(again.code, 1, again.out)
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).baseVersion, '0.0.9')

  // refresh-seeded writes the manifest through the same spread — the stamped
  // baseVersion must survive that path too.
  const refresh = run(['update', '--dir', dir, '--refresh-seeded', 'apps/mobile/src/routes.ts'])
  assert.notEqual(refresh.code, 1, refresh.out)
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).baseVersion, '0.0.9')
})

test('doctor: seeded divergence from the current template is an info advisory, never an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-seedadv-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  writeFileSync(join(dir, 'apps/mobile/src/routes.ts'), '// project rewrote its routes\n')
  const r = run(['doctor', '--dir', dir])
  assert.notEqual(r.code, 1, r.out)
  assert.ok(r.out.includes('refresh-seeded'), r.out)
  assert.ok(r.out.includes('apps/mobile/src/routes.ts'), r.out)
})

test('the template ships validate.floor.json in lockstep with VALIDATE_STEPS', async () => {
  // The CI floor is the frozen snapshot tools/validate.floor.json; the
  // installer's concern is that the template actually ships it and it matches.
  const floorPath = join(TEMPLATE, 'base/tools/validate.floor.json')
  assert.ok(existsSync(floorPath), 'template must ship tools/validate.floor.json (the CI floor)')
  const snapshot = JSON.parse(readFileSync(floorPath, 'utf8'))
  // file:// URL, not the raw path — Windows absolute paths (D:\…) are not
  // importable by the ESM loader.
  const { VALIDATE_STEPS } = await import(
    pathToFileURL(join(TEMPLATE, 'base/tools/harness.config.mjs')).href
  )
  assert.deepEqual(
    snapshot.steps,
    VALIDATE_STEPS,
    'tools/validate.floor.json and tools/harness.config.mjs VALIDATE_STEPS must be identical (regenerate with `node scripts/generate-floor.mjs --write`)',
  )
})

test('npm pack ships every template path (dotless storage survives packing)', () => {
  // shell: true — on Windows npm is a .cmd shim that a shell-less spawn cannot
  // execute (ENOENT bare / EINVAL as npm.cmd under Node's CVE-2024-27980
  // hardening). Args are static, so shell interpolation is a non-issue.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    shell: true,
  })
  const files = JSON.parse(out)[0].files.map((f) => f.path)
  for (const critical of [
    'template/base/.claude/settings.json',
    'template/base/.claude/hooks/stop-validate-gate.mjs',
    'template/base/gitignore',
    'template/base/package.json.tmpl',
    'template/base/tools/harness.config.mjs',
    'template/base/tools/validate.floor.json',
    'template/base/github/workflows/quality-gate.yml',
    'template/stack/apps/mobile/app.config.ts',
    'template/stack/apps/mobile/assets/icon.png',
    'template/stack/apps/web/app/page.tsx',
    'template/stack/supabase/migrations/20260101000100_notes.sql',
    // A NESTED package manifest: packages/*/* is a second glob level, and a
    // packing rule that only reached one level deep would drop the entire
    // platform/verticals half of the workspace while still looking green.
    'template/stack/packages/platform/errors/package.json.tmpl',
    'installer/cli.mjs',
  ]) {
    assert.ok(files.includes(critical), `npm pack dropped ${critical}`)
  }
})

// ── Regression armor ported from the upstream update/refresh refactor: pins
// CURRENT behavior of the --force sweep, refresh-seeded unknown-path
// reporting, park-on-drift idempotence, and dry-run plan parity. ──

test('update --force overwrites a drifted OWNED file, notes it, and re-records the sha', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-force-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // A locally-modified owned hook: without --force this parks (exit 2); with
  // --force the incoming template version wins in place.
  const ownedRel = '.claude/hooks/posttool-fast-check.mjs'
  const owned = join(dir, ownedRel)
  const templateContent = readFileSync(owned, 'utf8')
  writeFileSync(owned, `${templateContent}\n// local tweak that force must overwrite\n`)

  const forced = run(['update', '--dir', dir, '--force'])
  assert.equal(forced.code, 0, forced.out) // deliberate overwrite → clean exit
  const restored = readFileSync(owned, 'utf8')
  assert.equal(restored, templateContent, '--force must restore the template version in place')
  assert.ok(!restored.includes('// local tweak'), 'local drift must be gone after --force')
  assert.ok(forced.out.includes(`--force overwrote locally-modified ${ownedRel}`), forced.out)

  // Manifest hash must track the overwrite, so a follow-up doctor is clean.
  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(
    manifest.files[ownedRel].sha256,
    sha256(restored),
    'manifest sha must be re-recorded to the written content',
  )
  assert.equal(run(['doctor', '--dir', dir]).code, 0, 'forced overwrite must leave a clean install')
})

test('refresh-seeded unknown path: non-zero via return (not a throw), near-candidate suggestions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-refunk-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Near miss: wrong directory, right basename → the note names the real path.
  const near = run(['update', '--dir', dir, '--refresh-seeded', 'mobile/routes.ts'])
  assert.equal(near.code, 1, near.out)
  assert.ok(near.out.includes('did you mean'), near.out)
  assert.ok(near.out.includes('apps/mobile/src/routes.ts'), near.out)
  // A non-zero RETURN, not a thrown error — the CLI prefixes "error:" only when
  // update throws (e.g. missing manifest); a bad path must not read that way.
  assert.ok(!near.out.includes('error:'), 'unknown path must exit via code, not throw')

  // No basename match anywhere → the miss is reported WITHOUT a "did you mean".
  const orphan = run(['update', '--dir', dir, '--refresh-seeded', 'no-such-file.zzz'])
  assert.equal(orphan.code, 1, orphan.out)
  assert.ok(orphan.out.includes('no template file installs to no-such-file.zzz'), orphan.out)
  assert.ok(!orphan.out.includes('did you mean'), 'a candidate-less miss must not fabricate a suggestion')

  // Batch with one good + one bad path: the good one is still applied in full,
  // but a single miss fails the whole invocation (exit 1).
  const seededRel = 'apps/web/app/page.tsx'
  const seededAbs = join(dir, seededRel)
  const seededTemplate = readFileSync(seededAbs, 'utf8')
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const oldContent = '// installed by an older template\n'
  writeFileSync(seededAbs, oldContent)
  manifest.files[seededRel].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const batch = run(['update', '--dir', dir,
    '--refresh-seeded', seededRel,
    '--refresh-seeded', 'no-such-file.zzz'])
  assert.equal(batch.code, 1, batch.out) // any miss fails the batch
  assert.equal(
    readFileSync(seededAbs, 'utf8'),
    seededTemplate,
    'the valid path in a partly-bad batch is still refreshed',
  )
})

test('refresh-seeded park-on-drift is idempotent: re-running never clobbers and never flip-flops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-refidem-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  const ip = 'apps/mobile/src/routes.ts'
  const abs = join(dir, ip)
  const templateContent = readFileSync(abs, 'utf8')
  const localWork = `${templateContent}\n// my project's real work\n`
  writeFileSync(abs, localWork)

  const manifestPath = join(dir, '.harness/manifest.json')
  const recordedSha = JSON.parse(readFileSync(manifestPath, 'utf8')).files[ip].sha256
  const pendingPath = join(dir, '.harness/pending', ip)

  const snapshot = () => ({
    file: readFileSync(abs, 'utf8'),
    pending: readFileSync(pendingPath),
    sha: JSON.parse(readFileSync(manifestPath, 'utf8')).files[ip].sha256,
  })

  const first = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(first.code, 2, first.out) // drift → exit 2
  assert.ok(first.out.includes('parked'), first.out)
  const afterFirst = snapshot()
  assert.equal(afterFirst.file, localWork, 'local work must survive the park')
  assert.equal(afterFirst.pending.toString('utf8'), templateContent, 'the template version is what gets parked')
  assert.equal(afterFirst.sha, recordedSha, 'park must NOT re-record the manifest sha')

  // Re-run with nothing changed: same exit, same bytes everywhere — no flip-flop.
  const second = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(second.code, 2, second.out)
  const afterSecond = snapshot()
  assert.equal(afterSecond.file, afterFirst.file, 're-run must not touch local work')
  assert.deepEqual(afterSecond.pending, afterFirst.pending, 're-run must re-park identical bytes')
  assert.equal(afterSecond.sha, afterFirst.sha, 're-run must not drift the recorded sha')
})

test('update --dry-run touches nothing yet reports byte-for-byte the plan the real run applies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-dryplan-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Stage a REFRESH: an owned file installed by an older harness (content
  // differs from the template) but recorded as untouched (sha matches disk).
  const ownedRel = '.claude/hooks/posttool-fast-check.mjs'
  const owned = join(dir, ownedRel)
  const oldContent = '#!/usr/bin/env node\n// older harness build\n'
  writeFileSync(owned, oldContent)
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files[ownedRel].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const fileBefore = readFileSync(owned, 'utf8')
  const manifestBefore = readFileSync(manifestPath, 'utf8')

  // Slice the JSON payload out of combined stdout/stderr — robust to any
  // interpreter noise around it.
  const parseReport = (out) => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))

  // Dry-run: emits the plan, writes nothing.
  const dry = run(['update', '--dir', dir, '--dry-run', '--report', 'json'])
  assert.equal(dry.code, 0, dry.out)
  const dryReport = parseReport(dry.out)
  assert.ok(dryReport.written.includes(ownedRel), 'dry-run plan must list the refresh')
  assert.equal(readFileSync(owned, 'utf8'), fileBefore, 'dry-run must not touch the file')
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore, 'dry-run must not touch the manifest')
  assert.ok(!existsSync(join(dir, '.harness/pending')), 'dry-run must not create pending/')

  // Real run: identical report object, now actually applied on disk.
  const real = run(['update', '--dir', dir, '--report', 'json'])
  assert.equal(real.code, 0, real.out)
  const realReport = parseReport(real.out)
  assert.deepEqual(dryReport, realReport, 'dry-run must report exactly the plan the real run executes')
  assert.notEqual(readFileSync(owned, 'utf8'), oldContent, 'the real run must refresh the file')
  const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(
    manifestAfter.files[ownedRel].sha256,
    sha256(readFileSync(owned, 'utf8')),
    'real run must re-record the sha',
  )
})
