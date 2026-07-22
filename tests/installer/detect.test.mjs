// Unit tests for target-directory detection (installer/lib/detect.mjs):
// bootstrap vs retrofit classification, foreign-stack / foreign-lockfile /
// non-workspace rejections with actionable guidance, and git-remote owner
// inference in detectContext.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { detect, detectContext } from '../../installer/lib/detect.mjs'

const dir = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const writePkg = (d, pkg) => writeFileSync(join(d, 'package.json'), JSON.stringify(pkg))

const git = (d, args) =>
  execFileSync('git', ['-C', d, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

// ---------------------------------------------------------------------------
// detect(): bootstrap classification
// ---------------------------------------------------------------------------

test('empty dir → bootstrap, empty: true', () => {
  const d = dir('epah-det-empty-')
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: true })
})

test('non-existent dir → bootstrap, empty: true', () => {
  const d = join(dir('epah-det-miss-'), 'does-not-exist')
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: true })
})

test('dir with only .git and .DS_Store still counts as empty', () => {
  const d = dir('epah-det-gitonly-')
  mkdirSync(join(d, '.git'))
  writeFileSync(join(d, '.DS_Store'), '')
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: true })
})

test('non-empty dir WITHOUT package.json → bootstrap, empty: false (current behavior: no throw)', () => {
  const d = dir('epah-det-nonempty-')
  writeFileSync(join(d, 'README.md'), '# stuff\n')
  mkdirSync(join(d, 'src'))
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: false })
})

// ---------------------------------------------------------------------------
// detect(): rejections
// ---------------------------------------------------------------------------

test('a hono-without-next project is redirected to the expo-postgres harness', () => {
  const d = dir('nesah-det-hono-')
  writePkg(d, { name: 'x', dependencies: { hono: '^4.0.0' } })
  assert.throws(
    () => detect(d),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /`hono` but not `next`/)
      assert.match(err.message, /expo-postgres-agent-harness/)
      return true
    },
  )
})

test('`hono` in devDependencies is redirected too (deps and devDeps are merged)', () => {
  const d = dir('nesah-det-honodev-')
  writePkg(d, { name: 'x', devDependencies: { hono: '^4.0.0' } })
  assert.throws(() => detect(d), /expo-postgres-agent-harness/)
})

test('hono ALONGSIDE next is NOT redirected — this lineage owns two-surface workspaces', () => {
  const d = dir('nesah-det-hononext-')
  writePkg(d, { name: 'x', dependencies: { hono: '^4.0.0', next: '16.0.0' } })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasWeb, true)
})

test('a Tauri project (dep or src-tauri dir) is redirected to the tauri harness', () => {
  const byDep = dir('epah-det-tauridep-')
  writePkg(byDep, { name: 'x', dependencies: { '@tauri-apps/api': '^2.0.0' } })
  assert.throws(
    () => detect(byDep),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /Tauri desktop project/)
      assert.match(err.message, /tauri-postgres-agent-harness/)
      return true
    },
  )

  const byDir = dir('epah-det-tauridir-')
  writePkg(byDir, { name: 'x' })
  mkdirSync(join(byDir, 'apps/desktop/src-tauri'), { recursive: true })
  assert.throws(() => detect(byDir), /tauri-postgres-agent-harness/)
})

test('each foreign lockfile throws, naming the lockfile and the pnpm migration path', () => {
  for (const lock of ['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    const d = dir('epah-det-lock-')
    writePkg(d, { name: 'x' })
    writeFileSync(join(d, lock), '')
    assert.throws(
      () => detect(d),
      (/** @type {Error} */ err) => {
        assert.ok(err.message.includes(lock), `message must name ${lock}: ${err.message}`)
        assert.match(err.message, /requires pnpm/)
        assert.match(err.message, /pnpm import/)
        return true
      },
    )
  }
})

test('pnpm-lock.yaml is NOT a foreign lockfile — falls through to the workspace check', () => {
  const d = dir('epah-det-pnpmlock-')
  writePkg(d, { name: 'x' })
  writeFileSync(join(d, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  assert.throws(() => detect(d), /no pnpm-workspace\.yaml/)
})

test('the `next` rejection wins over the lockfile rejection (check order pinned)', () => {
  const d = dir('nesah-det-order-')
  writePkg(d, { name: 'x', dependencies: { hono: '^4.0.0' } })
  writeFileSync(join(d, 'package-lock.json'), '{}')
  assert.throws(() => detect(d), /`hono` but not `next`/)
})

test('package.json without pnpm-workspace.yaml throws with the monorepo-shape guidance', () => {
  const d = dir('nesah-det-nows-')
  writePkg(d, { name: 'x', dependencies: { next: '16.0.0' } })
  assert.throws(
    () => detect(d),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /no pnpm-workspace\.yaml/)
      assert.ok(err.message.includes('apps/*, packages/*'), err.message)
      return true
    },
  )
})

test('pnpm workspace without web or mobile markers throws with layout guidance', () => {
  const d = dir('nesah-det-nomark-')
  writePkg(d, { name: 'x' })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  assert.throws(
    () => detect(d),
    (/** @type {Error} */ err) => {
      assert.ok(err.message.includes('apps/web Next.js app'), err.message)
      assert.ok(err.message.includes('apps/mobile'), err.message)
      assert.match(err.message, /configurable-layout/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// detect(): valid retrofit trees
// ---------------------------------------------------------------------------

test('retrofit: app.config.ts marker alone → hasExpo true, hasWeb false, pkg round-trips', () => {
  const d = dir('nesah-det-expo-')
  const pkg = { name: 'their-app', private: true }
  writePkg(d, pkg)
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(d, 'apps/mobile'), { recursive: true })
  writeFileSync(join(d, 'apps/mobile/app.config.ts'), 'export default {}\n')
  assert.deepEqual(detect(d), { mode: 'retrofit', pkg, hasExpo: true, hasWeb: false })
})

test('retrofit: an expo root dependency alone marks hasExpo (no app.config yet)', () => {
  const d = dir('nesah-det-expodep-')
  writePkg(d, { name: 'x', dependencies: { expo: '~57.0.0' } })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasExpo, true)
  assert.equal(r.hasWeb, false)
})

test('retrofit: next root dependency alone → hasWeb true, hasExpo false', () => {
  const d = dir('nesah-det-nextdep-')
  writePkg(d, { name: 'x', dependencies: { next: '16.0.0' } })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasExpo, false)
  assert.equal(r.hasWeb, true)
})

test('retrofit: apps/web/next.config.ts alone marks hasWeb even without a next dep', () => {
  const d = dir('nesah-det-webcfg-')
  writePkg(d, { name: 'x' })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(d, 'apps/web'), { recursive: true })
  writeFileSync(join(d, 'apps/web/next.config.ts'), 'export default {}\n')
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasExpo, false)
  assert.equal(r.hasWeb, true)
})

test('retrofit: both markers present → hasExpo and hasWeb both true', () => {
  const d = dir('nesah-det-both-')
  writePkg(d, { name: 'x', devDependencies: { next: '16.0.0' } })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n")
  mkdirSync(join(d, 'apps/mobile'), { recursive: true })
  writeFileSync(join(d, 'apps/mobile/app.json'), '{}')
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasExpo, true)
  assert.equal(r.hasWeb, true)
})

// ---------------------------------------------------------------------------
// detect(): unreadable / corrupt package.json
// ---------------------------------------------------------------------------

test('corrupt package.json throws the unreadable error', () => {
  const d = dir('epah-det-corrupt-')
  writeFileSync(join(d, 'package.json'), '{ this is not json')
  assert.throws(() => detect(d), /unreadable package\.json/)
})

test('package.json that cannot be read as a file (a directory) throws the unreadable error', () => {
  const d = dir('epah-det-eisdir-')
  mkdirSync(join(d, 'package.json'))
  assert.throws(() => detect(d), /unreadable package\.json/)
})

// ---------------------------------------------------------------------------
// detectContext(): git-remote owner inference
// ---------------------------------------------------------------------------

test('detectContext: ssh remote → gitOwner parsed from git@host:owner/repo.git', () => {
  const d = dir('epah-ctx-ssh-')
  git(d, ['init', '-q'])
  git(d, ['remote', 'add', 'origin', 'git@github.com:acme-owner/some-repo.git'])
  const ctx = detectContext(d)
  assert.equal(ctx.gitOwner, 'acme-owner')
  assert.equal(ctx.dirName, basename(d))
  assert.deepEqual(ctx.answers, {})
})

test('detectContext: https remote → gitOwner parsed, with or without the .git suffix', () => {
  const withGit = dir('epah-ctx-https-')
  git(withGit, ['init', '-q'])
  git(withGit, ['remote', 'add', 'origin', 'https://github.com/acme-owner/some-repo.git'])
  assert.equal(detectContext(withGit).gitOwner, 'acme-owner')

  const bare = dir('epah-ctx-httpsbare-')
  git(bare, ['init', '-q'])
  git(bare, ['remote', 'add', 'origin', 'https://github.com/acme-owner/some-repo'])
  assert.equal(detectContext(bare).gitOwner, 'acme-owner')
})

test('detectContext: git repo without an origin remote → gitOwner null', () => {
  const d = dir('epah-ctx-noremote-')
  git(d, ['init', '-q'])
  const ctx = detectContext(d)
  assert.equal(ctx.gitOwner, null)
  assert.equal(ctx.dirName, basename(d))
  assert.deepEqual(ctx.answers, {})
})

test('detectContext: not a git repo at all → gitOwner null, defaults intact', () => {
  const d = dir('epah-ctx-nogit-')
  const ctx = detectContext(d)
  assert.equal(ctx.gitOwner, null)
  assert.equal(ctx.dirName, basename(d))
  assert.deepEqual(ctx.answers, {})
})
