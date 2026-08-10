// Regression armor for the one install-write primitive (installer/lib/write-file.mjs):
// the executable-bit rule (shebang STRINGS get 0o755, everything else 0o644,
// Buffers are never executable), parent-directory creation, and — since 0.9.0 —
// REPLACEMENT ATOMICITY: the destination either holds its old bytes or the new
// ones, never a truncation, because a torn file under .claude/hooks/ fails OPEN
// (a load-time SyntaxError exits 1, which Claude Code treats as non-blocking).
// init/update/enable all route through this function, so these pins hold for
// every command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renameWithRetry, writeInstallFile } from '../../installer/lib/write-file.mjs'

// POSIX file modes do not exist on Windows — content assertions run there,
// mode assertions are guarded. Pin the umask so exact-mode assertions are
// deterministic regardless of the runner's inherited umask (node --test runs
// each file in its own process, so this cannot leak into other test files).
const POSIX = process.platform !== 'win32'
if (POSIX) process.umask(0o022)

const mode = (p) => statSync(p).mode & 0o777

test('shebang string gets the executable bit (0o755)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))
  const dest = join(dir, 'hook.mjs')
  const content = '#!/usr/bin/env node\nconsole.log("hook")\n'
  writeInstallFile(dest, content)
  assert.equal(readFileSync(dest, 'utf8'), content)
  if (POSIX) assert.equal(mode(dest), 0o755, 'shebang string must be executable')
})

test('plain string gets 0o644 — including a "#!" that is not at byte 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))

  const plain = join(dir, 'AGENTS.md')
  writeInstallFile(plain, '# Project memory\n')
  assert.equal(readFileSync(plain, 'utf8'), '# Project memory\n')
  if (POSIX) assert.equal(mode(plain), 0o644, 'plain string must not be executable')

  // '#!' mid-content is not a shebang — only startsWith counts.
  const mid = join(dir, 'doc.md')
  writeInstallFile(mid, 'usage:\n#!/usr/bin/env node\n')
  if (POSIX) assert.equal(mode(mid), 0o644, 'mid-content #! must not flip the executable bit')

  // Empty string is a plain string.
  const empty = join(dir, 'empty.txt')
  writeInstallFile(empty, '')
  assert.equal(readFileSync(empty, 'utf8'), '')
  if (POSIX) assert.equal(mode(empty), 0o644)
})

test('Buffer content is never executable, even when it starts with #! bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))

  // Binary asset whose leading bytes spell '#!' — the Buffer branch must win.
  const shebangBytes = Buffer.concat([
    Buffer.from('#!/bin/sh\n'),
    Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50]),
  ])
  const tricky = join(dir, 'asset.bin')
  writeInstallFile(tricky, shebangBytes)
  assert.deepEqual(readFileSync(tricky), shebangBytes, 'buffer bytes must round-trip exactly')
  if (POSIX) assert.equal(mode(tricky), 0o644, 'Buffer content must never be executable')

  // Ordinary binary asset (PNG magic) — also 0o644, bytes intact.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const img = join(dir, 'logo.png')
  writeInstallFile(img, png)
  assert.deepEqual(readFileSync(img), png)
  if (POSIX) assert.equal(mode(img), 0o644)
})

test('parent directories are created recursively', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))
  const dest = join(dir, 'apps', 'server', 'src', 'routes', 'health.ts')
  assert.ok(!existsSync(join(dir, 'apps')), 'fixture precondition: no parent dirs yet')
  writeInstallFile(dest, 'export const ok = true\n')
  assert.equal(readFileSync(dest, 'utf8'), 'export const ok = true\n')
  // Writing next to it reuses the now-existing tree without throwing.
  writeInstallFile(join(dir, 'apps', 'server', 'src', 'routes', 'auth.ts'), 'export {}\n')
  assert.ok(existsSync(join(dir, 'apps', 'server', 'src', 'routes', 'auth.ts')))
})

// ── replacement atomicity (0.9.0) ────────────────────────────────────────────
// The probe record: a hooks/lib file truncated mid-write is a load-time
// SyntaxError → node exit 1 → Claude Code treats the hook as a NON-blocking
// error and the guarded action proceeds. The primitive therefore may never
// truncate in place: it stages to a dot-tmp in the same directory and renames.

const NONROOT = POSIX && typeof process.getuid === 'function' && process.getuid() !== 0

test('a failed staging write leaves the old bytes and mode untouched', { skip: !NONROOT }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))
  const dest = join(dir, 'hookio.mjs')
  const old = '#!/usr/bin/env node\nexport const ok = true\n'
  writeInstallFile(dest, old)

  // A read-only parent refuses the tmp-file creation — the failure lands in
  // the staging step, BEFORE the destination is ever opened.
  chmodSync(dir, 0o555)
  try {
    assert.throws(() => writeInstallFile(dest, 'export const torn = true\n'))
  } finally {
    chmodSync(dir, 0o755)
  }
  assert.equal(readFileSync(dest, 'utf8'), old, 'old bytes must survive a failed replacement')
  assert.equal(mode(dest), 0o755, 'old mode must survive a failed replacement')
  assert.deepEqual(
    readdirSync(dir).filter((f) => f !== basename(dest)),
    [],
    'no tmp residue after a failed replacement',
  )
})

test('a failed rename leaves no tmp residue and throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))
  // The destination is a DIRECTORY: staging succeeds, the rename itself fails.
  const dest = join(dir, 'taken')
  mkdirSync(dest)
  assert.throws(() => writeInstallFile(dest, 'never lands\n'))
  assert.ok(statSync(dest).isDirectory(), 'the colliding directory survives')
  assert.deepEqual(
    readdirSync(dir).filter((f) => f !== 'taken'),
    [],
    'no tmp residue after a failed rename',
  )
})

test('success leaves no tmp residue beside the destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))
  writeInstallFile(join(dir, 'a.json'), '{"a":1}\n')
  writeInstallFile(join(dir, 'a.json'), '{"a":2}\n')
  writeInstallFile(join(dir, 'b.bin'), Buffer.from([0x00, 0x01]))
  assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'b.bin'])
  assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), '{"a":2}\n')
})

// ── the win32 sharing-violation retry policy (0.9.0, decided on paper in W0) ──
// Windows renameSync over a file another process holds open throws
// EPERM/EBUSY/EACCES transiently (antivirus, editors). Policy: retry with
// bounded backoff ON WIN32 ONLY, then throw — the destination still holds the
// OLD bytes when rename never succeeds, which IS the atomicity property. On
// POSIX those errno values are real permission problems and retrying would
// only mask them.

test('renameWithRetry retries transient win32 errors then succeeds', () => {
  const calls = []
  const slept = []
  let failures = 2
  renameWithRetry('/tmp/from', '/tmp/to', {
    platform: 'win32',
    sleep: (ms) => slept.push(ms),
    rename: (from, to) => {
      calls.push([from, to])
      if (failures > 0) {
        failures -= 1
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
    },
  })
  assert.equal(calls.length, 3, 'two failures then the success')
  assert.equal(slept.length, 2, 'one sleep per retry, none after success')
})

test('renameWithRetry exhaustion rethrows the last error', () => {
  let attempts = 0
  assert.throws(
    () =>
      renameWithRetry('/tmp/from', '/tmp/to', {
        platform: 'win32',
        sleep: () => {},
        rename: () => {
          attempts += 1
          throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
        },
      }),
    /EBUSY/,
  )
  assert.ok(attempts >= 3, 'exhaustion means the retry budget was actually spent')
})

test('renameWithRetry never retries on POSIX or on non-transient codes', () => {
  for (const [platform, code] of [
    ['linux', 'EPERM'],
    ['darwin', 'EBUSY'],
    ['win32', 'ENOENT'],
  ]) {
    let attempts = 0
    assert.throws(() =>
      renameWithRetry('/tmp/from', '/tmp/to', {
        platform,
        sleep: () => {},
        rename: () => {
          attempts += 1
          throw Object.assign(new Error(`${code}: nope`), { code })
        },
      }),
    )
    assert.equal(attempts, 1, `${platform}/${code} must not retry`)
  }
})

// ── the closure: one primitive means ONE writeFileSync (0.9.0) ────────────────
// Six bare writeFileSync sites bypassed the primitive at 0.8.0 (manifest.mjs,
// migrations.mjs ×4, agents-lock.mjs) — every one a truncating write to a file
// the enforcement layer depends on. This pins the whole installer/ tree so a
// seventh can never land silently.

test('writeFileSync appears nowhere in installer/ outside the primitive', () => {
  const root = fileURLToPath(new URL('../../installer', import.meta.url))
  const offenders = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const path = join(entry.parentPath, entry.name)
    if (basename(path) === 'write-file.mjs') continue
    if (/\bwriteFileSync\b/.test(readFileSync(path, 'utf8'))) offenders.push(path)
  }
  assert.deepEqual(offenders, [], 'route installer writes through writeInstallFile')
})

test('overwrite re-asserts the mode — shebang-ness flips the executable bit in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-wf-'))

  // writeFileSync's mode option only applies at creation, so the primitive
  // chmods explicitly: a file whose shebang-ness changes across harness
  // versions gets the correct bit even on an overwrite-in-place refresh.
  const wasPlain = join(dir, 'was-plain.mjs')
  writeInstallFile(wasPlain, 'export {}\n')
  writeInstallFile(wasPlain, '#!/usr/bin/env node\nexport {}\n')
  assert.equal(readFileSync(wasPlain, 'utf8'), '#!/usr/bin/env node\nexport {}\n')
  if (POSIX) assert.equal(mode(wasPlain), 0o755, 'overwrite adds the executable bit for a new shebang')

  const wasHook = join(dir, 'was-hook.mjs')
  writeInstallFile(wasHook, '#!/usr/bin/env node\nexport {}\n')
  writeInstallFile(wasHook, 'export {}\n')
  assert.equal(readFileSync(wasHook, 'utf8'), 'export {}\n')
  if (POSIX) assert.equal(mode(wasHook), 0o644, 'overwrite drops the executable bit with the shebang')

  // A pre-existing file created OUTSIDE the primitive is normalized too — the
  // executable-bit rule is a function of content, never of history.
  const preexisting = join(dir, 'pre.sh')
  writeFileSync(preexisting, 'old\n', { mode: 0o600 })
  writeInstallFile(preexisting, '#!/bin/sh\necho new\n')
  assert.equal(readFileSync(preexisting, 'utf8'), '#!/bin/sh\necho new\n')
  if (POSIX) assert.equal(mode(preexisting), 0o755, 'mode is normalized on overwrite')
})
