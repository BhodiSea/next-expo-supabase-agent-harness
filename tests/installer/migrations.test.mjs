// Unit tests for the cross-version upgrade machinery (installer/lib/migrations.mjs)
// plus an end-to-end `update` run over a synthetic migration record. The real
// template/migrations.json is exercised by the update-skew CI lane against the
// previous release tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyFileMigrations,
  cmpVersions,
  injectConfigStep,
  matchSeedOnInitOnly,
  readTemplateMigrations,
  requiredConfigSteps,
  seedOnInitOnlyPatterns,
  updateConfigCommand,
  versionsBetween,
} from '../../installer/lib/migrations.mjs'
import { walkTemplate } from '../../installer/lib/copy.mjs'
import { sha256 } from '../../installer/lib/manifest.mjs'
import { update } from '../../installer/commands/update.mjs'
import { init } from '../../installer/commands/init.mjs'

// Capture the printed report (update logs only through printReport) so a test
// can assert on notes/skipped/written without a scaffold-side JSON round-trip.
async function captureUpdate(opts, ctx) {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.map(String).join(' '))
  try {
    const code = await update(opts, ctx)
    return { code, out: lines.join('\n') }
  } finally {
    console.log = orig
  }
}
const parseReport = (out) => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))

const CONFIG_TEMPLATE = fileURLToPath(
  new URL('../../template/base/tools/harness.config.mjs', import.meta.url),
)

test('cmpVersions orders numerically, not lexically', () => {
  assert.equal(cmpVersions('0.1.2', '0.1.10'), -1)
  assert.equal(cmpVersions('0.10.0', '0.9.9'), 1)
  assert.equal(cmpVersions('1.0.0', '1.0.0'), 0)
})

test('versionsBetween picks (from, to] ascending and ignores the doc key', () => {
  const m = { '//': 'doc', '0.1.2': {}, '0.1.3': {}, '0.2.0': {}, '0.1.10': {} }
  assert.deepEqual(versionsBetween(m, '0.1.1', '0.1.10'), ['0.1.2', '0.1.3', '0.1.10'])
  assert.deepEqual(versionsBetween(m, '0.1.3', '0.2.0'), ['0.1.10', '0.2.0'])
  assert.deepEqual(versionsBetween(m, '0.2.0', '0.2.0'), [])
})

test('updateConfigCommand: from-guarded rewrite hits canonical lines only, in BOTH step lists', () => {
  const cfg = `export const VALIDATE_STEPS = [
  ['lint', 'pnpm exec eslint . --max-warnings 0'],
  ['custom-lint', 'pnpm exec eslint . --max-warnings 0'],
]
export const STOP_HOOK_STEPS = [
  ['validate', 'node tools/validate.mjs'],
]`
  const afterLint = updateConfigCommand(cfg, {
    name: 'lint',
    from: 'pnpm exec eslint . --max-warnings 0',
    to: 'pnpm exec eslint . --max-warnings 0 --cache',
  })
  assert.ok(afterLint.includes("['lint', 'pnpm exec eslint . --max-warnings 0 --cache']"), afterLint)
  // a different step with the same command text is untouched (name-anchored)
  assert.ok(afterLint.includes("['custom-lint', 'pnpm exec eslint . --max-warnings 0']"), afterLint)

  const afterStop = updateConfigCommand(afterLint, {
    name: 'validate',
    from: 'node tools/validate.mjs',
    to: 'node tools/validate.mjs --report-all',
  })
  assert.ok(afterStop.includes("['validate', 'node tools/validate.mjs --report-all']"), afterStop)

  // customized consumer command: the from-guard misses, content unchanged
  const customized = "export const VALIDATE_STEPS = [\n  ['lint', 'my-own-linter --strict'],\n]"
  assert.equal(
    updateConfigCommand(customized, {
      name: 'lint',
      from: 'pnpm exec eslint . --max-warnings 0',
      to: 'pnpm exec eslint . --max-warnings 0 --cache',
    }),
    customized,
  )
  // idempotent: re-applying after the rewrite changes nothing
  assert.equal(
    updateConfigCommand(afterStop, {
      name: 'validate',
      from: 'node tools/validate.mjs',
      to: 'node tools/validate.mjs --report-all',
    }),
    afterStop,
  )
})

test('applyFileMigrations: sha-guarded removal, rename cleanup, module promotion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-mig-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/stale.mjs'), 'old\n')
  writeFileSync(join(dir, 'tools/modified.mjs'), 'locally changed\n')
  writeFileSync(join(dir, 'tools/renamed-old.mjs'), 'moving\n')

  const files = {
    'tools/stale.mjs': { mode: 'owned', sha256: sha256('old\n') },
    'tools/modified.mjs': { mode: 'owned', sha256: sha256('pristine\n') }, // drifted
    'tools/renamed-old.mjs': { mode: 'owned', sha256: sha256('moving\n'), module: 'gate-perf-budget' },
    'tools/other.mjs': { mode: 'owned', sha256: 'x', module: 'gate-perf-budget' },
  }
  const modules = new Set(['gate-perf-budget', 'ci-macos'])
  const report = { notes: [] }

  applyFileMigrations({
    targetDir: dir,
    files,
    modules,
    report,
    entries: [
      {
        removed: ['tools/stale.mjs', 'tools/modified.mjs', 'tools/never-existed.mjs'],
        renamed: { 'tools/renamed-old.mjs': 'tools/renamed-new.mjs' },
        promotedModules: ['gate-perf-budget'],
      },
    ],
    dryRun: false,
  })

  assert.ok(!existsSync(join(dir, 'tools/stale.mjs')), 'unmodified removed file must be deleted')
  assert.ok(!files['tools/stale.mjs'], 'manifest entry pruned')
  assert.ok(existsSync(join(dir, 'tools/modified.mjs')), 'locally-modified file must survive')
  assert.ok(report.notes.some((n) => n.includes('locally modified')), report.notes.join('; '))
  assert.ok(!existsSync(join(dir, 'tools/renamed-old.mjs')), 'renamed old path deleted')
  assert.ok(!modules.has('gate-perf-budget'), 'promoted module removed from module list')
  assert.ok(modules.has('ci-macos'), 'unrelated module untouched')
  assert.equal(files['tools/other.mjs'].module, undefined, 'stale module attribution stripped')
})

test('injectConfigStep: uncomment, insert-after, append, idempotent, fail-null', () => {
  // A v0.1.1-shaped consumer config: styleguide still commented, no e2e.
  const OLD_SHAPE = `export const VALIDATE_STEPS = [
  ['format', 'pnpm exec biome ci .'],
  ['build', 'node tools/build-check.mjs'],
  ['rust-check', 'node tools/run-rust-gates.mjs check'],
  // Opt-in gates — uncomment after installing the matching module:
  // ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
]
`

  // Uncomment path.
  const uncommented = injectConfigStep(OLD_SHAPE, {
    name: 'styleguide',
    cmd: 'node tools/check-styleguide-manifest.mjs',
  })
  assert.ok(uncommented.includes("  ['styleguide', 'node tools/check-styleguide-manifest.mjs'],"))
  assert.ok(!/\/\/\s*\['styleguide'/.test(uncommented), 'commented line must be activated')

  // Insert-after path.
  const withE2e = injectConfigStep(uncommented, {
    name: 'e2e',
    cmd: 'node tools/check-e2e.mjs',
    after: 'build',
  })
  const lines = withE2e.split('\n')
  const buildIdx = lines.findIndex((l) => l.includes("['build',"))
  assert.ok(lines[buildIdx + 1].includes("['e2e', 'node tools/check-e2e.mjs'],"), lines[buildIdx + 1])

  // Idempotent: injecting an already-present step is a no-op.
  assert.equal(injectConfigStep(withE2e, { name: 'e2e', cmd: 'node tools/check-e2e.mjs' }), withE2e)

  // Missing `after` anchor falls back to appending before the array close.
  const appended = injectConfigStep(OLD_SHAPE, { name: 'docs-sync', cmd: 'node tools/check-docs-sync.mjs', after: 'no-such-step' })
  assert.ok(appended.includes("['docs-sync', 'node tools/check-docs-sync.mjs'],"))

  // Mangled config → null (fail loud upstream, never guess).
  assert.equal(injectConfigStep('const nothing = 1\n', { name: 'x', cmd: 'y' }), null)
})

test('every shipped migration configStep is already ACTIVE in the shipped config (injection is a no-op)', () => {
  const shipped = readFileSync(CONFIG_TEMPLATE, 'utf8')
  const migrations = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../template/migrations.json', import.meta.url)), 'utf8'),
  )
  for (const [version, record] of Object.entries(migrations)) {
    if (version === '//') continue
    for (const step of record.configSteps ?? []) {
      assert.equal(
        injectConfigStep(shipped, step),
        shipped,
        `${version}: configStep '${step.name}' is not active in the shipped harness.config.mjs — a fresh init and an updated install would diverge`,
      )
    }
  }
})

test('requiredConfigSteps returns steps introduced at or before the version', () => {
  const m = {
    '//': 'doc',
    '0.1.3': { configSteps: [{ name: 'e2e', cmd: 'node tools/check-e2e.mjs' }] },
    '0.2.0': { configSteps: [{ name: 'later', cmd: 'x' }] },
  }
  const names = requiredConfigSteps(m, '0.1.3').map((s) => s.name)
  assert.deepEqual(names, ['e2e'])
  assert.equal(requiredConfigSteps(m, '0.1.3')[0].since, '0.1.3')
  assert.deepEqual(requiredConfigSteps(m, '0.2.0').map((s) => s.name), ['e2e', 'later'])
})

test('update applies a synthetic migration end-to-end (remove + configStep + promotion)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-updmig-'))
  const code = await init({
    dir,
    tier: 'core',
    yes: true,
    set: ['PROJECT_NAME=Mig App', 'GITHUB_OWNER=o', 'SECURITY_OWNERS=@o'],
  })
  assert.equal(code, 0)

  // Backdate the install and plant a stale harness-owned file the migration removes.
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.harnessVersion = '0.0.1'
  writeFileSync(join(dir, 'tools/legacy-gate.mjs'), 'legacy\n')
  manifest.files['tools/legacy-gate.mjs'] = { mode: 'owned', sha256: sha256('legacy\n') }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const migrations = {
    '0.1.0': {
      removed: ['tools/legacy-gate.mjs'],
      configSteps: [{ name: 'synthetic-gate', cmd: 'node tools/synthetic.mjs', after: 'build' }],
    },
  }
  const updCode = await update({ dir, dryRun: false }, { migrations })
  assert.notEqual(updCode, 1)

  assert.ok(!existsSync(join(dir, 'tools/legacy-gate.mjs')), 'migration must delete the stale gate')
  const cfg = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.ok(cfg.includes("['synthetic-gate', 'node tools/synthetic.mjs'],"), 'configStep must be injected')

  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(!after.files['tools/legacy-gate.mjs'], 'manifest entry pruned')
  assert.equal(
    after.files['tools/harness.config.mjs'].sha256,
    sha256(cfg),
    'config re-hashed after sanctioned injection so doctor sees no drift',
  )

  // Injection is idempotent across repeat updates.
  await update({ dir, dryRun: false }, { migrations })
  const cfg2 = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.equal(cfg2.split("['synthetic-gate',").length, 2, 'step must appear exactly once')
})

// ── v0.1.4 Stage 5: seedOnInitOnly — new seeded exemplars a newer template
// ships as init-time-only starting content that `update` must NOT auto-plant. ──

test('seedOnInitOnlyPatterns collects across ALL versions (timeless), deduped and POSIX-normalized', () => {
  const m = {
    '//': 'doc',
    '0.1.4': { seedOnInitOnly: ['apps/desktop/src/features/matrix/', 'apps/desktop/src/router.ts'] },
    // A LATER version repeats router.ts and adds a backslash-authored path — both
    // must fold: dedup by normalized form, and the doc key is ignored.
    '0.1.5': { seedOnInitOnly: ['apps/desktop/src/router.ts', 'apps\\desktop\\src\\theme\\'] },
  }
  assert.deepEqual(seedOnInitOnlyPatterns(m), [
    'apps/desktop/src/features/matrix/',
    'apps/desktop/src/router.ts',
    'apps/desktop/src/theme/',
  ])
  assert.deepEqual(seedOnInitOnlyPatterns({ '//': 'doc', '0.1.4': {} }), [], 'absent key yields no patterns')
})

test('matchSeedOnInitOnly: prefix subtree vs exact file, Windows backslash input normalized', () => {
  const patterns = ['apps/desktop/src/features/matrix/', 'apps/desktop/src/router.ts']
  // '/'-suffixed pattern = subtree prefix.
  assert.equal(
    matchSeedOnInitOnly('apps/desktop/src/features/matrix/MatrixPanel.tsx', patterns),
    'apps/desktop/src/features/matrix/',
  )
  // no slash = exact file; a sibling with the same stem must NOT match.
  assert.equal(matchSeedOnInitOnly('apps/desktop/src/router.ts', patterns), 'apps/desktop/src/router.ts')
  assert.equal(matchSeedOnInitOnly('apps/desktop/src/router.test.ts', patterns), null)
  // a prefix must land on a real path boundary, not a partial segment.
  assert.equal(matchSeedOnInitOnly('apps/desktop/src/features/matrixEXTRA.ts', patterns), null)
  // Windows-supplied backslash paths normalize before matching (POSIX manifest keys).
  assert.equal(
    matchSeedOnInitOnly('apps\\desktop\\src\\features\\matrix\\MatrixGrid.tsx', patterns),
    'apps/desktop/src/features/matrix/',
  )
  assert.equal(matchSeedOnInitOnly('apps\\desktop\\src\\router.ts', patterns), 'apps/desktop/src/router.ts')
  assert.equal(matchSeedOnInitOnly('unrelated/file.ts', patterns), null)
})

test('the shipped seedOnInitOnly records target real template files only (no typo drift)', () => {
  const shipped = readTemplateMigrations()
  const patterns = seedOnInitOnlyPatterns(shipped)
  if (patterns.length === 0) {
    // A fresh lineage ships no upgrade records yet. Assert the emptiness is
    // REAL (no version entry carries seedOnInitOnly) so a parse regression
    // can't masquerade as "nothing shipped" — the closure below arms itself
    // with the first shipped record.
    for (const [version, record] of Object.entries(shipped)) {
      if (version === '//') continue
      assert.ok(!record.seedOnInitOnly, `${version} carries seedOnInitOnly but the pattern collector saw none`)
    }
    return
  }
  // Seeded exemplars live in BOTH trees (stack app files and base tools/*.json).
  const installPaths = [...walkTemplate('base'), ...walkTemplate('stack')].map((e) => e.installPath)
  for (const pattern of patterns) {
    const hit = installPaths.some((ip) => (pattern.endsWith('/') ? ip.startsWith(pattern) : ip === pattern))
    assert.ok(hit, `seedOnInitOnly pattern '${pattern}' resolves to no template file — stale/typo'd record`)
  }
})

test('update withholds absent seedOnInitOnly exemplars (noted once per cluster), refreshes owned, still plants non-matched; dry-run parity + idempotent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-seedonly-'))
  assert.equal(
    await init({
      dir,
      tier: 'core',
      yes: true,
      set: ['PROJECT_NAME=Seed App', 'GITHUB_OWNER=o', 'SECURITY_OWNERS=@o'],
    }),
    0,
  )

  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dropInstalled = (ip) => {
    rmSync(join(dir, ip), { force: true })
    delete manifest.files[ip]
  }

  // Derive the fixture from what the template actually ships, so this test
  // self-arms as the stack fills in: a prefix CLUSTER (a src/ dir under apps/
  // with >= 2 installed files), an exact FILE exemplar, a non-matched seeded
  // file, and an owned hook file. Hardcoding paths here would rot; deriving
  // keeps the scenario pinned to REAL install paths.
  const installed = Object.keys(manifest.files)
  const clusterCounts = new Map()
  for (const ip of installed) {
    const m = ip.match(/^(apps\/[^/]+\/src\/[^/]+\/)/)
    if (m) clusterCounts.set(m[1], (clusterCounts.get(m[1]) ?? 0) + 1)
  }
  const clusterPrefix = [...clusterCounts.entries()].find(([, n]) => n >= 2)?.[0]
  const clusterMembers = clusterPrefix ? installed.filter((ip) => ip.startsWith(clusterPrefix)) : []
  const exactExemplar = installed.find(
    (ip) => ip.startsWith('apps/') && ip.endsWith('.ts') && !ip.startsWith(clusterPrefix ?? ' '),
  )
  const nonMatched = installed.find(
    (ip) =>
      ip.startsWith('apps/') &&
      ip !== exactExemplar &&
      !ip.startsWith(clusterPrefix ?? ' ') &&
      ip.endsWith('.ts'),
  )
  const ownedRel = installed.find((ip) => ip.startsWith('.claude/hooks/') && ip.endsWith('.mjs'))
  if (!clusterPrefix || !exactExemplar || !nonMatched || !ownedRel) {
    // The template skeleton does not yet ship apps/ exemplars or hook files —
    // the fixture arms itself when the stack tree lands. A loud skip, never a
    // silent pass.
    t.skip('template ships no apps/ exemplar cluster yet — fixture self-arms when the stack lands')
    return
  }

  for (const ip of clusterMembers) dropInstalled(ip)
  dropInstalled(exactExemplar)

  // A NEW seeded file NOT in the record → must still plant when absent.
  dropInstalled(nonMatched)

  // An owned file installed by an older harness (content differs, recorded as
  // untouched) → must still be refreshed.
  const oldOwned = '#!/usr/bin/env node\n// older harness build\n'
  writeFileSync(join(dir, ownedRel), oldOwned)
  manifest.files[ownedRel].sha256 = sha256(oldOwned)

  manifest.harnessVersion = '0.0.1'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const migrations = {
    '0.0.2': { seedOnInitOnly: [clusterPrefix, exactExemplar] },
  }
  const matrixMembers = clusterMembers

  const manifestBefore = readFileSync(manifestPath, 'utf8')

  // (c) Dry-run first: emits the plan, writes nothing.
  const dry = await captureUpdate({ dir, dryRun: true, report: 'json' }, { migrations })
  const dryReport = parseReport(dry.out)
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore, 'dry-run must not touch the manifest')
  assert.ok(!existsSync(join(dir, exactExemplar)), 'dry-run must not plant an exemplar')
  assert.ok(!existsSync(join(dir, nonMatched)), 'dry-run must not plant the non-matched file either')

  // Real run: identical report object, now applied.
  const real = await captureUpdate({ dir, report: 'json' }, { migrations })
  const realReport = parseReport(real.out)
  assert.deepEqual(dryReport, realReport, 'dry-run must report exactly the plan the real run executes')

  // (a) matched exemplars withheld: skipped, not written, not on disk, not recorded.
  const afterManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const ip of [...matrixMembers, exactExemplar]) {
    assert.ok(!existsSync(join(dir, ip)), `exemplar must not be planted: ${ip}`)
    assert.ok(realReport.skipped.includes(ip), `exemplar must be counted skipped: ${ip}`)
    assert.ok(!realReport.written.includes(ip), `exemplar must not be written: ${ip}`)
    assert.ok(!afterManifest.files[ip], `exemplar must not be recorded in the manifest: ${ip}`)
  }

  // note fires ONCE per matched cluster (one prefix note, one exact note).
  const clusterNotes = realReport.notes.filter((n) => n.includes('not auto-planted'))
  assert.equal(clusterNotes.length, 2, `expected exactly two cluster notes, got: ${clusterNotes.join(' | ')}`)
  assert.ok(
    clusterNotes.some((n) => n.includes(`${clusterPrefix} — pull with`)),
    clusterNotes.join(' | '),
  )
  assert.ok(clusterNotes.some((n) => n.includes(`--refresh-seeded ${exactExemplar}`)), clusterNotes.join(' | '))

  // non-matched new seeded file IS planted; owned file IS refreshed.
  assert.ok(existsSync(join(dir, nonMatched)), 'non-matched new seeded file must still be planted')
  assert.ok(realReport.written.includes(nonMatched), 'non-matched file must be reported written')
  assert.ok(afterManifest.files[nonMatched], 'planted non-matched file must be recorded')
  assert.notEqual(readFileSync(join(dir, ownedRel), 'utf8'), oldOwned, 'owned file must be refreshed')
  assert.ok(realReport.written.includes(ownedRel), 'owned refresh must be reported')

  // (e) Idempotence: a second update still withholds, still notes, never plants.
  const second = await captureUpdate({ dir, report: 'json' }, { migrations })
  const secondReport = parseReport(second.out)
  for (const ip of [...matrixMembers, exactExemplar]) {
    assert.ok(!existsSync(join(dir, ip)), `second update must still not plant: ${ip}`)
    assert.ok(secondReport.skipped.includes(ip), `second update must still skip: ${ip}`)
  }
  assert.equal(
    secondReport.notes.filter((n) => n.includes('not auto-planted')).length,
    2,
    'second update emits the same two cluster notes',
  )
})
