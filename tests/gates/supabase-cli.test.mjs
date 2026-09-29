// Unit proofs for template/base/tools/lib/supabase-cli.mjs (1.0.4, #43): which Supabase CLI a
// local run of the database lane spawns. Through 1.0.3 the rls runner and `types-drift` both
// spawned a bare `supabase`, so outside a package script they took whichever CLI came first
// on the machine's PATH, while `pnpm test:rls`, `pnpm db:types` and every CI job took the
// catalog-pinned copy in node_modules/.bin. The helper puts that copy first when it exists.
//
// `platform` is injected, so both branches run on both legs of the matrix: the POSIX branch
// on windows-latest too, and the win32 branch on ubuntu. Nothing here spawns a process.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { supabaseCli } from '../../template/base/tools/lib/supabase-cli.mjs'

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A project root; with `workspace`, node_modules/.bin holds a `supabase` entry. */
function root({ workspace }) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-supabase-cli-'))
  made.push(dir)
  if (workspace) {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.bin', 'supabase'), '#!/bin/sh\n')
  }
  return dir
}

const pathKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')

test('POSIX, workspace copy present: PATH starts with <root>/node_modules/.bin and the source is workspace', () => {
  const dir = root({ workspace: true })
  const env = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/x' }
  const cli = supabaseCli(dir, env, 'linux')
  assert.equal(cli.source, 'workspace')
  assert.equal(cli.env.PATH, `${join(dir, 'node_modules', '.bin')}:/usr/local/bin:/usr/bin`)
  assert.equal(cli.env.HOME, '/home/x', 'every other key is passed through')
  assert.equal(cli.bin, join(dir, 'node_modules', '.bin', 'supabase'))
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin', 'the caller env is not mutated')
})

test('POSIX, no workspace copy: env comes back unchanged and the source is PATH', () => {
  const dir = root({ workspace: false })
  const env = { PATH: '/usr/bin' }
  const cli = supabaseCli(dir, env, 'darwin')
  assert.equal(cli.source, 'PATH')
  assert.equal(cli.env, env)
  assert.equal(cli.bin, 'supabase')
})

test('POSIX, workspace copy present and no PATH at all: PATH is the workspace bin dir alone', () => {
  const dir = root({ workspace: true })
  const cli = supabaseCli(dir, { HOME: '/h' }, 'linux')
  assert.equal(cli.source, 'workspace')
  assert.equal(cli.env.PATH, join(dir, 'node_modules', '.bin'))
  assert.deepEqual(pathKeys(cli.env), ['PATH'])
})

test('POSIX, an env whose path key is spelled `Path`: that key is prefixed and no second PATH key appears', () => {
  const dir = root({ workspace: true })
  const cli = supabaseCli(dir, { Path: '/usr/bin' }, 'linux')
  assert.equal(cli.source, 'workspace')
  assert.deepEqual(pathKeys(cli.env), ['Path'])
  assert.equal(cli.env.Path, `${join(dir, 'node_modules', '.bin')}:/usr/bin`)
})

test('win32: the env comes back unchanged and the source is PATH, even with a workspace copy (.cmd shims need a shell)', () => {
  const dir = root({ workspace: true })
  const env = { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' }
  const cli = supabaseCli(dir, env, 'win32')
  assert.equal(cli.source, 'PATH')
  assert.equal(cli.env, env)
  // Windows spells the key `Path`; a second `PATH` key beside it would be a different
  // variable to Node and an ambiguous one to the child (tests/gates/check-types-drift.test.mjs).
  assert.deepEqual(pathKeys(cli.env), ['Path'])
  assert.equal(cli.bin, 'supabase')
})

test('defaults: with no env or platform given it reads process.env and process.platform', () => {
  const dir = root({ workspace: false })
  const cli = supabaseCli(dir)
  assert.equal(cli.source, 'PATH')
  assert.equal(cli.env, process.env)
})
