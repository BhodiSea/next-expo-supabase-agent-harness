// Regression armor for the one install-write primitive (installer/lib/write-file.mjs):
// the executable-bit rule (shebang STRINGS get 0o755, everything else 0o644,
// Buffers are never executable) and parent-directory creation. init/update/
// enable all route through this function, so these pins hold for every command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeInstallFile } from '../../installer/lib/write-file.mjs'

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
