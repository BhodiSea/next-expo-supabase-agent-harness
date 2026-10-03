// A CLI older than the install it is pointed at (2.0.2). `update` applies "the harness version
// you are running", so before this an older CLI moved an install BACKWARDS without a word: a
// 2.0.0 CLI run over a 2.0.1 scaffold printed `harness update 2.0.1 → 2.0.0` and rewrote 11
// owned files. A global install (`npm i -g`) stays at the version it was installed at, and a
// bare `npx next-expo-supabase-agent-harness` resolves to that global copy, so the stale CLI is
// the ordinary case, not a contrived one. `update`, `enable`, `disable` and `eject` write
// template bytes into an existing install, and each now refuses before its first write,
// naming both versions and the `@latest` command that fixes it.
//
// `graduate` had the mirror defect: it advanced baseVersion to the CLI's version rather than
// the install's, so `npx …@latest graduate` on an install that had not been updated would
// mark ramps the install does not yet carry as already swept. It now advances to the
// install's own harnessVersion, whichever CLI runs it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { graduate } from '../../installer/commands/graduate.mjs'
import { MODULES } from '../../installer/lib/layout.mjs'
import { installerVersion } from '../../installer/lib/manifest.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const SETS = [
  '--set', 'PROJECT_NAME=Mismatch Fixture',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]
const NEWER = '99.0.0'

/** @param {string[]} args */
const cli = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' })

/** A real core-tier scaffold whose manifest claims a release newer than this CLI. */
function newerInstall() {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-mismatch-'))
  const res = cli(['init', '--dir', dir, '--tier', 'core', '--yes', ...SETS])
  assert.equal(res.status, 0, `init must succeed: ${res.stdout}${res.stderr}`)
  const path = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, `${JSON.stringify({ ...manifest, harnessVersion: NEWER }, null, 2)}\n`)
  return { dir, manifestBytes: readFileSync(path, 'utf8') }
}

/**
 * @param {{ status: number | null, stdout: string, stderr: string }} res
 * @param {string} command the command named in the remedy
 */
function assertRefused(res, command) {
  const out = `${res.stdout}${res.stderr}`
  assert.equal(res.status, 1, out)
  assert.match(out, new RegExp(`v${NEWER.replaceAll('.', '\\.')}`), 'names the install version')
  assert.match(out, new RegExp(`v${installerVersion().replaceAll('.', '\\.')}`), 'names the CLI version')
  assert.match(out, new RegExp(`npx next-expo-supabase-agent-harness@latest ${command}`), 'names the @latest remedy')
  assert.match(out, /npm i -g next-expo-supabase-agent-harness@latest/, 'names the global-install remedy')
}

test('update, enable, disable and eject refuse a CLI older than the install, and write nothing', () => {
  const { dir, manifestBytes } = newerInstall()
  const notInstalled = MODULES.find((m) => !JSON.parse(manifestBytes).modules?.includes(m))
  assert.ok(notInstalled, 'a core install leaves at least one module to enable')
  /** @type {Array<[string[], string]>} */
  const cases = [
    [['update', '--dir', dir], 'update'],
    [['update', '--dir', dir, '--dry-run'], 'update'],
    [['update', '--dir', dir, '--refresh-seeded', 'README.md'], 'update'],
    [['enable', notInstalled, '--dir', dir], 'enable'],
    [['disable', notInstalled, '--dir', dir], 'disable'],
    [['eject', '--dir', dir], 'eject'],
  ]
  for (const [args, command] of cases) {
    assertRefused(cli(args), command)
    assert.equal(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'), manifestBytes, `${args.join(' ')}: manifest untouched`)
    assert.ok(!existsSync(join(dir, '.harness/rollback')), `${args.join(' ')}: no rollback snapshot was taken`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('update at the SAME version still runs — the guard refuses only an older CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-mismatch-same-'))
  assert.equal(cli(['init', '--dir', dir, '--tier', 'core', '--yes', ...SETS]).status, 0)
  const res = cli(['update', '--dir', dir, '--dry-run'])
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`)
  assert.match(res.stdout, new RegExp(`harness update ${installerVersion().replaceAll('.', '\\.')} → `))
  rmSync(dir, { recursive: true, force: true })
})

/** A manifest plus a validate that exits 0 with no ramp NOTE: graduate's clean path. */
function graduateFixture(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-graduate-target-'))
  mkdirSync(join(dir, '.harness'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify({ modules: [], files: {}, ...manifest }, null, 2))
  writeFileSync(join(dir, 'tools/validate.mjs'), 'console.log("validate: all green")\n')
  return dir
}

/** @param {string} dir */
const baseVersionOf = (dir) => JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8')).baseVersion

test('graduate advances baseVersion to the INSTALL version when a newer CLI runs it', async () => {
  const dir = graduateFixture({ harnessVersion: '0.0.5', baseVersion: '0.0.1' })
  assert.equal(await graduate({ dir }), 0)
  assert.equal(baseVersionOf(dir), '0.0.5', `never past the install's own harnessVersion (the CLI is ${installerVersion()})`)
  rmSync(dir, { recursive: true, force: true })
})

test('graduate advances baseVersion to the install version when an OLDER CLI runs it', async () => {
  const dir = graduateFixture({ harnessVersion: NEWER, baseVersion: '0.0.1' })
  assert.equal(await graduate({ dir }), 0)
  assert.equal(baseVersionOf(dir), NEWER)
  rmSync(dir, { recursive: true, force: true })
})

test('graduate: baseVersion already at the install version is a no-op, whatever the CLI version', async () => {
  const dir = graduateFixture({ harnessVersion: '0.0.5', baseVersion: '0.0.5' })
  assert.equal(await graduate({ dir }), 0)
  assert.equal(baseVersionOf(dir), '0.0.5')
  rmSync(dir, { recursive: true, force: true })
})
