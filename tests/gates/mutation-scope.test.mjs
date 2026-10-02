// THE PR MUTATION LANE'S SCOPER AND THE EDGE FUNCTIONS (1.1.0, #78).
//
// tools/mutation-scope.mjs prints the critical files a change touches, comma-separated, for
// `stryker run --mutate`. 1.1.0 puts supabase/functions/*/ on the mutated floor, and StrykerJS's
// vitest runner cannot mutate a file no test relates to: when every file handed to --mutate is
// one no suite imports, it stops with "No tests were executed" and writes no report, so the
// ratchet never gets to speak. An Edge Function directory is on the unit surface once it holds
// a vitest suite (vitest.config.ts measures exactly those directories), so the scoper judges a
// changed file in a directory with no suite itself:
//   - on an install whose baseVersion predates 1.1.0 it is withheld from the run with a NOTE on
//     stderr (stdout IS the --mutate list) until 1.2.0, then RAMP EXPIRED;
//   - on a 1.1.0 install, or none, it is a FAIL naming the file and the one green path.
// A file in a directory that holds a suite is mutated on every vintage, and its survivors meet
// the ratchet's own ramp (tests/gates/check-mutation-ratchet.test.mjs).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { edgeSuiteDirs } from '../../template/base/tools/lib/mutation-critical.mjs'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const DETAIL = 'the Edge Function surface'

/** Every fixture this file makes, removed when it ends. @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const VITEST_SUITE = "import { expect, it } from 'vitest'\nimport { handle } from './handler.ts'\nit('x', () => { expect(handle()).toBe(1) })\n"
const DENO_SUITE = "import { assertEquals } from 'jsr:@std/assert'\nDeno.test('x', () => assertEquals(1, 1))\n"

/**
 * A committed install with the shipped scoper and its libraries, the floor's concrete roots
 * present (the zero-match alarm needs them), then `changes` written on top, uncommitted.
 * @param {Record<string, string>} committed @param {Record<string, string>} changes
 * @param {string[] | null} manifest [baseVersion, harnessVersion], or null for no install record
 */
function install(committed, changes, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-mscope-'))
  made.push(dir)
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
  }
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools', 'lib'), { recursive: true })
  cpSync(join(TOOLS, 'mutation-scope.mjs'), join(dir, 'tools', 'mutation-scope.mjs'))
  write({
    'tools/mutation-scope-extra.json': '{ "roots": [] }\n',
    'packages/api/src/trpc.ts': 'export const t = 1\n',
    'packages/platform/supabase/src/errors.ts': 'export const e = 1\n',
    'packages/platform/errors/src/index.ts': 'export const i = 1\n',
    ...committed,
  })
  if (manifest) {
    write({ '.harness/manifest.json': JSON.stringify({ baseVersion: manifest[0], harnessVersion: manifest[1] }) })
  }
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')
  write(changes)
  return dir
}

function runScope(dir) {
  const env = { ...process.env }
  delete env.CI
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const r = spawnSync(process.execPath, ['tools/mutation-scope.mjs'], { cwd: dir, env, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const HANDLER = 'export function handle() { return 1 }\n'
const HELPER = 'export function pick(keys) { return keys.length === 1 ? keys[0] : undefined }\n'

test('edgeSuiteDirs: the top-level function directories that hold a vitest suite, never a `deno test` one', () => {
  const dir = install(
    {
      'supabase/functions/fn/handler.ts': HANDLER,
      'supabase/functions/fn/handler.test.ts': VITEST_SUITE,
      'supabase/functions/nested/lib/deep.test.ts': VITEST_SUITE,
      'supabase/functions/legacy/index.test.ts': DENO_SUITE,
      'supabase/functions/_shared/cors.ts': 'export const cors = {}\n',
      'supabase/functions/node_modules/pkg/x.test.ts': VITEST_SUITE,
    },
    {},
    null,
  )
  assert.deepEqual([...edgeSuiteDirs(dir)], ['supabase/functions/fn', 'supabase/functions/nested'])
  assert.deepEqual([...edgeSuiteDirs(join(dir, 'no-such-root'))], [])
})

test('a changed handler in a directory with a suite is scoped on every vintage', () => {
  for (const manifest of [['1.0.3', '1.1.0'], ['1.1.0', '1.1.0'], null]) {
    const dir = install(
      { 'supabase/functions/fn/handler.ts': HANDLER, 'supabase/functions/fn/handler.test.ts': VITEST_SUITE },
      { 'supabase/functions/fn/handler.ts': `${HANDLER}// changed\n` },
      manifest,
    )
    const r = runScope(dir)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, 'supabase/functions/fn/handler.ts')
    assert.doesNotMatch(r.stderr, /NOTE/, r.stderr)
  }
})

test('the Deno.serve shell is never scoped', () => {
  const dir = install(
    { 'supabase/functions/fn/index.ts': 'Deno.serve(() => new Response())\n' },
    { 'supabase/functions/fn/index.ts': 'Deno.serve(() => new Response("changed"))\n' },
    null,
  )
  const r = runScope(dir)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('RAMP: on a 1.0.3 install an untested helper is withheld with a NOTE on stderr, and stdout stays the --mutate list', () => {
  const dir = install(
    { 'packages/api/src/trpc.ts': 'export const t = 1\n' },
    {
      'supabase/functions/delete-account/helper.ts': HELPER,
      'packages/api/src/trpc.ts': 'export const t = 2\n',
    },
    ['1.0.3', '1.1.0'],
  )
  const r = runScope(dir)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'packages/api/src/trpc.ts', 'a NOTE on stdout would reach stryker --mutate')
  assert.match(r.stderr, /^mutation-scope: NOTE — 1 changed file\(s\) on the Edge Function surface/m, r.stderr)
  assert.match(r.stderr, /expires in 1\.2\.0/, r.stderr)
  assert.match(r.stderr, /^mutation-scope: NOTE — \(ramp\) supabase\/functions\/delete-account\/helper\.ts: withheld from this run/m, r.stderr)
})

test('RAMP: an upgraded install whose only critical change is an untested helper scopes nothing and exits 0', () => {
  const dir = install({}, { 'supabase/functions/delete-account/helper.ts': HELPER }, ['1.0.3', '1.1.0'])
  const r = runScope(dir)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('RAMP EXPIRED: at harness 1.2.0 the untested helper fails the scoper, and the banner names this ramp', () => {
  const dir = install({}, { 'supabase/functions/delete-account/helper.ts': HELPER }, ['1.0.3', '1.2.0'])
  const r = runScope(dir)
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stderr, /^mutation-scope: RAMP EXPIRED — 1 changed file\(s\) on the Edge Function surface/m, r.stderr)
  assert.ok(r.stderr.includes(DETAIL), r.stderr)
  assert.match(r.stderr, /deadline of 1\.2\.0/, r.stderr)
  assert.match(r.stderr, /supabase\/functions\/delete-account\/helper\.ts/, r.stderr)
})

test('a 1.1.0 install (and a fresh one) fails at once, naming the file and the suite it needs', () => {
  for (const manifest of [['1.1.0', '1.1.0'], null]) {
    const dir = install({}, { 'supabase/functions/_shared/cors.ts': HELPER }, manifest)
    const r = runScope(dir)
    assert.equal(r.code, 1, r.stderr)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^mutation-scope: FAIL — supabase\/functions\/_shared\/cors\.ts: no vitest suite in supabase\/functions\/_shared\//m, r.stderr)
    assert.doesNotMatch(r.stderr, /NOTE/, r.stderr)
  }
})
