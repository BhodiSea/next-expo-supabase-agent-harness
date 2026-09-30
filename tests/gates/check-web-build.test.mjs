// Can-fail proofs for the `web-compile` chain step (template/base/tools/check-web-build.mjs,
// 1.1.0, #77): the web app is COMPILED by `next build`, on a stamp miss, in the chain every
// turn ends on. Through 1.0.x no chain step did: `types` only typechecks, `build` is the
// mobile export, and `next build` ran only in two path-filtered CI jobs, so a web app that
// did not compile passed the local chain and the `static` job.
//
// The build itself is driven by a fake `pnpm` on PATH (sh + .cmd twins, the
// check-web-e2e.test.mjs pattern, so the selftest matrix runs this on windows-latest too).
// The fake records every invocation, dumps the environment it was handed, prints a
// controllable message, rewrites apps/web/next-env.d.ts the way a real `next build` does,
// and exits with a controllable code. This is the canary proof wired in
// tests/canary/injections.json#steps.web-compile — it must stay green and non-vacuous.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-web-build.mjs', import.meta.url))
const QUALITY_GATE = fileURLToPath(
  new URL('../../template/base/github/workflows/quality-gate.yml', import.meta.url),
)
const STAMP = join('.harness', 'web-compile.ok')
const NEXT_ENV = join('apps', 'web', 'next-env.d.ts')
const COMMITTED_NEXT_ENV = '/// <reference types="next" />\n// committed on purpose\n'
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/** Every fixture directory this file made, removed when the file ends. */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/**
 * The placeholder env the shipped `web-build` job builds with, read from its "Build the web
 * app" step: the step must supply exactly these values, byte for byte, because a key or a
 * DSN spelled any other way is a `secrets` or `hygiene` finding in the scaffold.
 * @returns {Record<string, string>}
 */
function webBuildJobEnv() {
  const lines = readFileSync(QUALITY_GATE, 'utf8').split('\n')
  const at = lines.findIndex((l) => l.trim() === '- name: Build the web app')
  assert.ok(at >= 0, 'quality-gate.yml has no "Build the web app" step')
  assert.equal(lines[at + 1]?.trim(), 'env:', 'the "Build the web app" step opens with its env block')
  /** @type {Record<string, string>} */
  const env = {}
  for (const line of lines.slice(at + 2)) {
    if (/^\s*#/.test(line)) continue
    const m = /^\s+([A-Z][A-Z0-9_]*):\s*(\S.*)$/.exec(line)
    if (m === null) break
    env[m[1]] = m[2].trim()
  }
  return env
}
const PLACEHOLDERS = webBuildJobEnv()

/**
 * A scaffold-shaped tree: apps/web with a committed next-env.d.ts, a workspace package, the
 * root files the stamp hashes, and node_modules. Every knob can remove one of them.
 * @param {{ web?: boolean, nodeModules?: boolean, manifest?: { baseVersion: string, harnessVersion: string } }} [knobs]
 */
function fixture({ web = true, nodeModules = true, manifest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-webcompile-'))
  made.push(dir)
  if (web) {
    mkdirSync(join(dir, 'apps/web/app'), { recursive: true })
    writeFileSync(join(dir, 'apps/web/package.json'), '{ "name": "web", "private": true }\n')
    writeFileSync(join(dir, 'apps/web/app/page.tsx'), 'export default function P() {\n  return null\n}\n')
    writeFileSync(join(dir, NEXT_ENV), COMMITTED_NEXT_ENV)
  }
  mkdirSync(join(dir, 'packages/kernel/src'), { recursive: true })
  writeFileSync(join(dir, 'packages/kernel/src/index.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'tsconfig.base.json'), '{}\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  if (nodeModules) mkdirSync(join(dir, 'node_modules'), { recursive: true })
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

/**
 * A fake `pnpm` answering `pnpm --filter web exec next build --webpack`. It appends its
 * arguments to <dir>/fake/calls.log, dumps its environment to <dir>/fake/env.txt, rewrites
 * apps/web/next-env.d.ts the way the real build does, prints `message` and exits `exit`.
 * @param {string} dir @param {{ exit?: number, message?: string }} [knobs]
 */
function armPnpm(dir, { exit = 0, message = 'Compiled successfully' } = {}) {
  const fake = join(dir, 'fake')
  mkdirSync(fake, { recursive: true })
  writeFileSync(join(fake, 'message.txt'), `${message}\n`)
  writeFileSync(
    join(fake, 'pnpm'),
    [
      '#!/bin/sh',
      `echo "$*" >> "${join(fake, 'calls.log')}"`,
      `env > "${join(fake, 'env.txt')}"`,
      'if [ -d apps/web ]; then printf \'import "./.next/types/routes.d.ts";\\n\' > apps/web/next-env.d.ts; fi',
      `cat "${join(fake, 'message.txt')}"`,
      `exit ${String(exit)}`,
      '',
    ].join('\n'),
  )
  chmodSync(join(fake, 'pnpm'), 0o755)
  writeFileSync(
    join(fake, 'pnpm.cmd'),
    [
      '@echo off',
      `echo %*>> "${join(fake, 'calls.log')}"`,
      `set > "${join(fake, 'env.txt')}"`,
      'if exist apps\\web echo import "./.next/types/routes.d.ts";> apps\\web\\next-env.d.ts',
      `type "${join(fake, 'message.txt')}"`,
      `exit /b ${String(exit)}`,
      '',
    ].join('\r\n'),
  )
  return fake
}

/** How many times the fake build ran in `dir`. */
const buildCalls = (dir) => {
  const log = join(dir, 'fake', 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0
}

/** The environment the fake build was handed, as a map. */
function buildEnv(dir) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of readFileSync(join(dir, 'fake', 'env.txt'), 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq).toUpperCase()] = line.slice(eq + 1)
  }
  return out
}

/**
 * Run the step in `dir` with the fake pnpm first on PATH. Every placeholder key is removed
 * from the inherited environment, so each case starts from "nothing set" unless `env` sets it.
 * @param {string} dir
 * @param {{ ci?: boolean, requireToolchains?: boolean, env?: Record<string, string>, script?: string }} [opts]
 */
function runGate(dir, { ci = false, requireToolchains = false, env = {}, script = GATE } = {}) {
  /** @type {Record<string, string | undefined>} */
  const childEnv = { ...process.env }
  for (const k of ['CI', 'HARNESS_REQUIRE_TOOLCHAINS', 'GITHUB_BASE_REF', 'HARNESS_PARITY_REPORT_DIR']) {
    delete childEnv[k]
  }
  for (const k of Object.keys(childEnv)) {
    if (Object.hasOwn(PLACEHOLDERS, k.toUpperCase())) delete childEnv[k]
  }
  if (ci) childEnv.CI = 'true'
  if (requireToolchains) childEnv.HARNESS_REQUIRE_TOOLCHAINS = '1'
  childEnv[PATH_KEY] = `${join(dir, 'fake')}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...childEnv, ...env },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('the placeholder table is read from the shipped web-build job, and it is not empty', () => {
  // Guards the helper above: every later env assertion compares against this table.
  assert.deepEqual(Object.keys(PLACEHOLDERS).sort(), [
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_WEB_ORIGIN',
    'NODE_ENV',
    'SUPABASE_DB_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ])
})

test('RED: a build that exits 1 fails the step and carries the tool output', () => {
  const dir = fixture()
  armPnpm(dir, { exit: 1, message: "Module not found: Can't resolve 'server-only' in app/providers.tsx" })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /^web-compile: FAIL/m)
  assert.ok(r.out.includes("Module not found: Can't resolve 'server-only'"), r.out)
  assert.ok(r.out.includes('FIX[web-compile]:'), r.out)
  assert.equal(buildCalls(dir), 1)
  assert.ok(!existsSync(join(dir, STAMP)), 'a failed build must record no stamp')
})

test('the build runs through `exec`, never through a package.json script name', () => {
  // An agent can redefine a script in the SEEDED apps/web/package.json; `exec` runs the
  // binary, as the `build` step does for expo.
  const dir = fixture()
  armPnpm(dir)
  runGate(dir)
  const calls = readFileSync(join(dir, 'fake', 'calls.log'), 'utf8').trim()
  assert.equal(calls, '--filter web exec next build --webpack')
})

test('GREEN: an exit 0 records the stamp, and unchanged inputs then hit it', () => {
  const dir = fixture()
  armPnpm(dir)
  const first = runGate(dir)
  assert.equal(first.code, 0, first.out)
  assert.match(first.out, /^web-compile: OK/m)
  assert.ok(existsSync(join(dir, STAMP)), 'a green build records .harness/web-compile.ok')
  const second = runGate(dir)
  assert.equal(second.code, 0, second.out)
  assert.match(second.out, /^web-compile: STAMPED — inputs unchanged since last green run/m)
  assert.equal(buildCalls(dir), 1, 'a stamp hit must not build again')
})

test('the committed next-env.d.ts is restored after the build, so the stamp can hit at all', () => {
  // `next build` rewrites apps/web/next-env.d.ts, which is committed and sits inside the
  // `apps/web` stamp input: left rewritten, the tree is dirty and the stamp misses forever.
  const dir = fixture()
  armPnpm(dir)
  runGate(dir)
  assert.equal(buildCalls(dir), 1, 'the build ran, and so rewrote the file')
  assert.equal(readFileSync(join(dir, NEXT_ENV), 'utf8'), COMMITTED_NEXT_ENV)
  // …on a failed build too.
  const red = fixture()
  armPnpm(red, { exit: 1, message: 'Failed to compile.' })
  runGate(red)
  assert.equal(buildCalls(red), 1)
  assert.equal(readFileSync(join(red, NEXT_ENV), 'utf8'), COMMITTED_NEXT_ENV)
})

test('an edit under apps/web re-runs the build, and so does an edit under packages', () => {
  const dir = fixture()
  armPnpm(dir)
  runGate(dir)
  writeFileSync(join(dir, 'apps/web/app/page.tsx'), 'export default function P() {\n  return 1\n}\n')
  const web = runGate(dir)
  assert.doesNotMatch(web.out, /STAMPED/, web.out)
  assert.equal(buildCalls(dir), 2, 'an apps/web edit must re-run the build')
  writeFileSync(join(dir, 'packages/kernel/src/index.ts'), 'export const x = 2\n')
  const pkg = runGate(dir)
  assert.doesNotMatch(pkg.out, /STAMPED/, pkg.out)
  assert.equal(buildCalls(dir), 3, 'a packages edit must re-run the build')
  // Build output is never an input: a fresh .next leaves the stamp standing.
  mkdirSync(join(dir, 'apps/web/.next/static'), { recursive: true })
  writeFileSync(join(dir, 'apps/web/.next/static/chunk.js'), 'x\n')
  const churn = runGate(dir)
  assert.match(churn.out, /^web-compile: STAMPED/m, churn.out)
  assert.equal(buildCalls(dir), 3)
})

test('CI=true ignores the stamp and builds for real', () => {
  const dir = fixture()
  armPnpm(dir)
  runGate(dir)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 0, ci.out)
  assert.doesNotMatch(ci.out, /STAMPED/, ci.out)
  assert.equal(buildCalls(dir), 2, 'CI must never trust a stamp')
})

test('a kept stamp register with no web-compile list builds in full, and records no stamp', () => {
  // An install that edited tools/lib/stamp-inputs.mjs keeps its copy: `update` parks the
  // 1.1.0 one and plants this new owned step beside it, so the step meets a register with no
  // entry for itself. It must judge in full, as the essential-eight and conformance-map
  // stamps do, never crash on the missing list or stamp over an empty one.
  const dir = fixture()
  armPnpm(dir)
  const tools = join(dir, 'tools')
  cpSync(fileURLToPath(new URL('../../template/base/tools/lib', import.meta.url)), join(tools, 'lib'), {
    recursive: true,
  })
  cpSync(GATE, join(tools, 'check-web-build.mjs'))
  writeFileSync(
    join(tools, 'lib', 'stamp-inputs.mjs'),
    "export const STAMP_INPUTS = { build: ['apps/mobile'] }\n",
  )
  const script = join(tools, 'check-web-build.mjs')
  const first = runGate(dir, { script })
  assert.equal(first.code, 0, first.out)
  assert.match(first.out, /^web-compile: OK/m, first.out)
  assert.equal(existsSync(join(dir, STAMP)), false, 'no list, no stamp')
  const second = runGate(dir, { script })
  assert.equal(second.code, 0, second.out)
  assert.doesNotMatch(second.out, /STAMPED/, second.out)
  assert.equal(buildCalls(dir), 2, 'with no list to hash, every run builds')
})

test('no apps/web, or no node_modules: a loud SKIP locally, a FAIL under HARNESS_REQUIRE_TOOLCHAINS=1', () => {
  for (const knobs of [{ web: false }, { nodeModules: false }]) {
    const dir = fixture(knobs)
    armPnpm(dir)
    const local = runGate(dir)
    assert.equal(local.code, 0, local.out)
    assert.match(local.out, /^web-compile: SKIPPED — /m)
    const strict = runGate(dir, { requireToolchains: true })
    assert.equal(strict.code, 1, strict.out)
    assert.match(strict.out, /skips are not allowed in CI/)
    assert.equal(buildCalls(dir), 0, `${JSON.stringify(knobs)}: nothing to build`)
  }
})

test('unset env keys receive the web-build job placeholders, and the step names the keys it filled', () => {
  const dir = fixture()
  armPnpm(dir)
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  const seen = buildEnv(dir)
  for (const [key, value] of Object.entries(PLACEHOLDERS)) {
    assert.equal(seen[key], value, `${key} must reach the build as the web-build job spells it`)
  }
  const line = r.out.split('\n').find((l) => l.startsWith('web-compile: placeholder env'))
  assert.ok(line, r.out)
  for (const key of Object.keys(PLACEHOLDERS)) assert.ok(line.includes(key), `${key} missing from: ${line}`)
})

test('a key the caller sets passes through unchanged, and is not reported as filled', () => {
  const dir = fixture()
  armPnpm(dir)
  const r = runGate(dir, { env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:64321' } })
  assert.equal(r.code, 0, r.out)
  const seen = buildEnv(dir)
  assert.equal(seen.NEXT_PUBLIC_SUPABASE_URL, 'http://127.0.0.1:64321')
  assert.equal(seen.SUPABASE_DB_URL, PLACEHOLDERS.SUPABASE_DB_URL)
  const line = r.out.split('\n').find((l) => l.startsWith('web-compile: placeholder env')) ?? ''
  assert.ok(!line.includes('NEXT_PUBLIC_SUPABASE_URL'), line)
})

test('a key an apps/web env file defines is left for Next to load, never overridden', () => {
  // Next loads apps/web/.env* itself, and the process environment outranks every file, so
  // filling a placeholder over a key the project configured there would build (and leave in
  // .next) an app pointed at the placeholder instead of the project's own value.
  const dir = fixture()
  armPnpm(dir)
  writeFileSync(join(dir, 'apps/web/.env.local'), 'NEXT_PUBLIC_WEB_ORIGIN=http://localhost:4000\n')
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(!Object.hasOwn(buildEnv(dir), 'NEXT_PUBLIC_WEB_ORIGIN'), 'the file, not the step, supplies it')
  const line = r.out.split('\n').find((l) => l.startsWith('web-compile: placeholder env')) ?? ''
  assert.ok(!line.includes('NEXT_PUBLIC_WEB_ORIGIN'), line)
  assert.ok(line.includes('SUPABASE_DB_URL'), line)
})

test('THE RAMP: on a 1.0.3 manifest a failed build is a NOTE, exits 0 and records no stamp', () => {
  const dir = fixture({ manifest: { baseVersion: '1.0.3', harnessVersion: '1.1.0' } })
  armPnpm(dir, { exit: 1, message: 'Failed to compile. ./app/providers.tsx' })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^web-compile: NOTE — .*expires in 1\.2\.0/m)
  assert.ok(r.out.includes('Failed to compile. ./app/providers.tsx'), 'the NOTE carries the output')
  assert.ok(!existsSync(join(dir, STAMP)), 'a ramped failure records no stamp')
  // So the NOTE repeats: the next run builds again rather than riding a stamp.
  const again = runGate(dir)
  assert.equal(again.code, 0, again.out)
  assert.match(again.out, /^web-compile: NOTE — /m)
  assert.equal(buildCalls(dir), 2)
})

test('THE RAMP stays silent on a green build, even on a 1.0.3 manifest', () => {
  // rampNote prints its NOTE on every armed call, and graduate refuses while one stands, so
  // the ramp is consulted only once the build has failed.
  const dir = fixture({ manifest: { baseVersion: '1.0.3', harnessVersion: '1.1.0' } })
  armPnpm(dir)
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /NOTE/)
})

test('THE RAMP EXPIRES at harness 1.2.0, and a 1.1.0 manifest is never ramped', () => {
  const expired = fixture({ manifest: { baseVersion: '1.0.3', harnessVersion: '1.2.0' } })
  armPnpm(expired, { exit: 1, message: 'Failed to compile.' })
  const late = runGate(expired)
  assert.equal(late.code, 1, late.out)
  assert.match(late.out, /web-compile: RAMP EXPIRED/)
  const fresh = fixture({ manifest: { baseVersion: '1.1.0', harnessVersion: '1.1.0' } })
  armPnpm(fresh, { exit: 1, message: 'Failed to compile.' })
  const live = runGate(fresh)
  assert.equal(live.code, 1, live.out)
  assert.doesNotMatch(live.out, /NOTE/)
})

test('a build that cannot find the referenced declarations says to run `types` first', () => {
  // Next's type check reads each referenced workspace package's emitted declarations, which
  // `tsc -b` (the `types` step, earlier in the chain) writes. Run alone on a fresh clone the
  // build reds with TS6305, and the step says which command produces them.
  const dir = fixture()
  armPnpm(dir, {
    exit: 1,
    message: "lib/x.ts(1,1): error TS6305: Output file 'packages/api/dist/index.d.ts' has not been built from source file 'packages/api/src/index.ts'.",
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('pnpm exec tsc -b . apps/web apps/mobile'), r.out)
})
