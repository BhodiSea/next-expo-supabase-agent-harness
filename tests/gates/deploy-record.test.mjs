// Can-fail proofs for the deploy-time artefact channel (deploy-record.yml):
// the manifest judgement, the ASD patch-window arithmetic, and the RB-02 binding —
// all pure functions in template/base/tools/lib/deploy-record.mjs, plus the
// emitter spawned against a scaffold-shaped fixture (emit-after-judge both ways).
// The lanes' registered red-proofs live here; the network halves (OSV, the
// backups endpoint) are deliberately NOT reproduced — those are the same
// vendor-surface boundary the backup-evidence suite records, and the judgements
// they feed are what this file proves red.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  deployManifestProblems,
  judgePatchWindows,
  judgeRestoreBinding,
  windowFor,
} from '../../template/base/tools/lib/deploy-record.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sha64 = 'a'.repeat(64)
const gitSha = 'b'.repeat(40)

const MANIFEST = {
  commit: gitSha,
  deployedAt: '2026-08-16T12:00:00Z',
  surface: 'production',
  packageVersion: '1.0.0',
  lockfileSha: sha64,
  migrations: [{ name: '20260101000000_a.sql', sha256: sha64 }],
  functions: [{ name: 'delete-account', sha256: sha64 }],
  resolutions: [{ name: 'next', version: '16.2.11' }],
}

test('the manifest judgement: the good shape passes; every starved field names its judgement', () => {
  assert.deepEqual(deployManifestProblems(MANIFEST), [])
  assert.ok(
    deployManifestProblems({ ...MANIFEST, commit: 'HEAD' }).some((p) => /restore manifest cannot bind/.test(p)),
  )
  assert.ok(
    deployManifestProblems({ ...MANIFEST, deployedAt: 'yesterday' }).some((p) => /never a wall clock/.test(p)),
  )
  assert.ok(
    deployManifestProblems({ ...MANIFEST, migrations: [] }).some((p) => /anti-vacuity/.test(p)),
    'an empty migration set means the emitter ran outside the deployed checkout',
  )
  assert.ok(
    deployManifestProblems({ ...MANIFEST, resolutions: [] }).some((p) => /DEPLOYED versions/.test(p)),
  )
})

test('the window mapping is ASD-verbatim and conservative: critical+production=48h, production=2w, else 1mo', () => {
  assert.equal(windowFor({ critical: true, production: true }), 'PA-06')
  assert.equal(windowFor({ critical: false, production: true }), 'PA-07')
  assert.equal(windowFor({ critical: true, production: false }), 'PA-10')
})

test('patch windows: inside passes, outside reds naming the row and the verbatim window', () => {
  const vuln = (over = {}) => ({
    id: 'GHSA-test',
    package: 'next',
    version: '16.2.11',
    published: '2026-08-10T00:00:00Z',
    critical: true,
    production: true,
    fixedIn: '16.2.12',
    ...over,
  })
  // 48h window, published 6 days before `now` → outside.
  const red = judgePatchWindows({ manifest: MANIFEST, vulns: [vuln()], now: '2026-08-16T00:00:00Z' })
  assert.equal(red.findings.length, 1)
  assert.match(red.findings[0], /PA-06/)
  assert.match(red.findings[0], /48 hours/)
  assert.match(red.findings[0], /fixed in 16\.2\.12/)

  // The same advisory judged one day after publication is inside the window.
  const green = judgePatchWindows({ manifest: MANIFEST, vulns: [vuln()], now: '2026-08-11T00:00:00Z' })
  assert.deepEqual(green.findings, [])

  // Non-critical takes the two-week window: 6 days is fine, 20 is not.
  const twoWeeks = vuln({ critical: false })
  assert.deepEqual(judgePatchWindows({ manifest: MANIFEST, vulns: [twoWeeks], now: '2026-08-16T00:00:00Z' }).findings, [])
  assert.match(
    judgePatchWindows({ manifest: MANIFEST, vulns: [twoWeeks], now: '2026-08-30T00:00:00Z' }).findings[0],
    /PA-07.*two weeks/s,
  )

  // An undated advisory is a FINDING, never a shrug — dateless would be the evasion.
  assert.match(
    judgePatchWindows({ manifest: MANIFEST, vulns: [vuln({ published: undefined })], now: '2026-08-16T00:00:00Z' }).findings[0],
    /no parseable published date/,
  )
})

test('the RB-02 binding: a complete pair emits the record with the exclusions; each starved half reds', () => {
  const bound = judgeRestoreBinding({
    manifest: MANIFEST,
    backup: { mechanism: 'daily-backup', latestAt: '2026-08-16T02:00:00Z' },
  })
  assert.deepEqual(bound.problems, [])
  assert.equal(bound.record.boundAt, MANIFEST.deployedAt)
  assert.equal(bound.record.applications.commit, gitSha)
  assert.ok(
    bound.record.knownExclusions.some((e) => /Vault\/pgsodium root key/.test(e)),
    'the sharpest exclusion travels IN the artefact, where the restorer reads it',
  )

  const noBackup = judgeRestoreBinding({ manifest: MANIFEST, backup: null })
  assert.equal(noBackup.record, null)
  assert.match(noBackup.problems[0], /no backup fact to bind/)

  const neverCompleted = judgeRestoreBinding({
    manifest: MANIFEST,
    backup: { mechanism: 'daily-backup', latestAt: null },
  })
  assert.match(neverCompleted.problems[0], /a promise, not a record/)

  const badManifest = judgeRestoreBinding({
    manifest: { ...MANIFEST, commit: 'HEAD' },
    backup: { mechanism: 'pitr', latestAt: null },
  })
  assert.ok(badManifest.problems.some((p) => /deploy manifest:/.test(p)))
})

test('the EMITTER judges before it writes: a scaffold-shaped tree emits; a hollow one emits NOTHING', () => {
  const tool = join(ROOT, 'template/base/tools/emit-deploy-record.mjs')
  const lib = join(ROOT, 'template/base/tools/lib')
  const stage = (withMigrations) => {
    const dir = mkdtempSync(join(tmpdir(), 'nesah-deploy-'))
    mkdirSync(join(dir, 'tools'), { recursive: true })
    spawnSync('cp', ['-R', lib, join(dir, 'tools/lib')])
    spawnSync('cp', [tool, join(dir, 'tools/emit-deploy-record.mjs')])
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(
      join(dir, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\npackages:\n\n  next@16.2.11:\n    resolution: {integrity: sha512-x}\n",
    )
    if (withMigrations) {
      mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
      writeFileSync(join(dir, 'supabase/migrations/20260101000000_a.sql'), 'SELECT 1;\n')
      mkdirSync(join(dir, 'supabase/functions/delete-account'), { recursive: true })
      writeFileSync(join(dir, 'supabase/functions/delete-account/index.ts'), 'export {}\n')
    }
    return dir
  }
  const env = {
    ...process.env,
    DEPLOY_COMMIT: gitSha,
    DEPLOYED_AT: '2026-08-16T12:00:00Z',
    DEPLOY_SURFACE: 'production',
  }

  const good = stage(true)
  const ok = spawnSync(process.execPath, ['tools/emit-deploy-record.mjs'], { cwd: good, encoding: 'utf8', env })
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`)
  const emitted = JSON.parse(readFileSync(join(good, 'artifacts/deploy-manifest.json'), 'utf8'))
  assert.equal(emitted.commit, gitSha)
  assert.equal(emitted.migrations.length, 1)
  assert.ok(emitted.resolutions.some((r) => r.name === 'next' && r.version === '16.2.11'))

  const hollow = stage(false)
  const red = spawnSync(process.execPath, ['tools/emit-deploy-record.mjs'], { cwd: hollow, encoding: 'utf8', env })
  assert.equal(red.status, 1, `${red.stdout}${red.stderr}`)
  assert.match(`${red.stdout}${red.stderr}`, /nothing is emitted/)
  assert.throws(() => readFileSync(join(hollow, 'artifacts/deploy-manifest.json')), 'a failed judgement must leave no artefact')
})
