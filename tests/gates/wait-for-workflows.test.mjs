// scripts/ci/wait-for-workflows.mjs (0.7.0, W8) — the publish-blocking poller.
//
// release.yml used to carry its selftest wait as inline YAML, which made the verdict
// logic untestable; the extraction puts it here instead, generalized to a workflow LIST
// so release can block on BOTH selftest.yml and lint.yml at the tag SHA (tag-time
// parity). These tests pin the four verdict outcomes pure — all-green → green,
// any all-failed → failed naming it, still-running → pending (retry), zero runs →
// pending (never green) — and then the CLI end-to-end through a stand-in `gh` on PATH
// (sh + .cmd twins delegating to one node stub, the check-e2e shim precedent, so the
// selftest matrix can run this file on windows-latest): exit 0 on green, an immediate
// exit 1 naming an all-failed workflow, a retry that polls again past a pending
// snapshot, and the zero-runs HARD FAIL that lands only AFTER the whole timeout budget
// — absence-as-pending-forever is the silent-skip shape this poller exists to refuse.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { judgeRuns, timeoutReport } from '../../scripts/ci/wait-for-workflows.mjs'

const POLLER = fileURLToPath(new URL('../../scripts/ci/wait-for-workflows.mjs', import.meta.url))
const SHA = 'a'.repeat(40)

const GREEN = [{ status: 'completed', conclusion: 'success' }]
const FAILED = [{ status: 'completed', conclusion: 'failure' }]
const RUNNING = [{ status: 'in_progress', conclusion: null }]

// ── judgeRuns: the verdict logic, pure over synthetic gh-run JSON ────────────

test('all required workflows green → verdict green', () => {
  const j = judgeRuns({ 'selftest.yml': GREEN, 'lint.yml': GREEN })
  assert.equal(j.verdict, 'green')
  assert.deepEqual(j.green.sort(), ['lint.yml', 'selftest.yml'])
})

test('a success among earlier failures still counts as green (re-run semantics)', () => {
  const j = judgeRuns({ 'selftest.yml': [...FAILED, ...GREEN], 'lint.yml': GREEN })
  assert.equal(j.verdict, 'green')
})

test('one workflow all-failed → verdict failed, NAMING it and only it', () => {
  const j = judgeRuns({ 'selftest.yml': GREEN, 'lint.yml': FAILED })
  assert.equal(j.verdict, 'failed')
  assert.deepEqual(j.failed, ['lint.yml'])
  assert.deepEqual(j.green, ['selftest.yml'])
})

test('mixed non-success conclusions (failure + cancelled) are still all-failed', () => {
  const j = judgeRuns({ 'lint.yml': [...FAILED, { status: 'completed', conclusion: 'cancelled' }] })
  assert.equal(j.verdict, 'failed')
  assert.deepEqual(j.failed, ['lint.yml'])
})

test('a still-running run → verdict pending (retry), even beside a completed failure', () => {
  const j = judgeRuns({ 'selftest.yml': [...FAILED, ...RUNNING], 'lint.yml': GREEN })
  assert.equal(j.verdict, 'pending')
  assert.deepEqual(j.running, ['selftest.yml'])
  assert.deepEqual(j.failed, [])
})

test('ZERO runs for a required workflow → pending and categorized absent, NEVER green', () => {
  const j = judgeRuns({ 'selftest.yml': GREEN, 'lint.yml': [] })
  assert.equal(j.verdict, 'pending')
  assert.deepEqual(j.absent, ['lint.yml'])
})

test('an unreadable run list (gh failure → null) is errored/pending, not absent and not green', () => {
  const j = judgeRuns({ 'selftest.yml': null })
  assert.equal(j.verdict, 'pending')
  assert.deepEqual(j.errored, ['selftest.yml'])
  assert.deepEqual(j.absent, [])
})

test('timeoutReport names the zero-runs workflow as the silent-skip shape, with a remedy', () => {
  const lines = timeoutReport(judgeRuns({ 'lint.yml': [], 'selftest.yml': RUNNING }), SHA, 90)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /lint\.yml: ZERO runs/)
  assert.match(lines[0], /silent-skip shape/)
  assert.match(lines[0], /re-run this release job/)
  assert.match(lines[1], /selftest\.yml: still not finished/)
})

// ── the CLI end-to-end, through a stand-in gh on PATH ────────────────────────

// Windows names the variable Path; override THAT key or the child gets two PATHs.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/**
 * A fake `gh` earlier on PATH: sh + .cmd twins both delegating to one node stub that
 * counts calls per workflow and answers `run list` from canned JSON — `<wf>.<n>.json`
 * for poll n if present, else the steady-state `<wf>.json`. The count files double as
 * the proof of HOW MANY times the poller asked, which is what distinguishes an
 * immediate hard fail from a full-budget timeout.
 * @param {Record<string, object[]>} steady steady-state runs per workflow file
 * @param {Record<string, object[]>} [scripted] keyed `<wf>.<n>` for poll n (0-based)
 */
function fakeGh(steady, scripted = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-waitwf-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const stub = join(dir, 'gh-stub.mjs')
  writeFileSync(
    stub,
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { dirname, join } from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      'const dir = dirname(fileURLToPath(import.meta.url))',
      'const args = process.argv.slice(2)',
      "const wf = args[args.indexOf('--workflow') + 1]",
      'const countFile = join(dir, `count-${wf}`)',
      "const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0",
      'writeFileSync(countFile, String(n + 1))',
      'const scripted = join(dir, `${wf}.${n}.json`)',
      "process.stdout.write(readFileSync(existsSync(scripted) ? scripted : join(dir, `${wf}.json`), 'utf8'))",
      '',
    ].join('\n'),
  )
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node "${stub}" "$@"\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'gh.cmd'), `@echo off\r\nnode "${stub}" %*\r\nexit /b %errorlevel%\r\n`)
  for (const [wf, runs] of Object.entries(steady)) {
    writeFileSync(join(dir, `${wf}.json`), JSON.stringify(runs))
  }
  for (const [key, runs] of Object.entries(scripted)) {
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(runs))
  }
  return {
    dir,
    bin,
    /** @param {string} wf */
    calls: (wf) => Number(readFileSync(join(dir, `count-${wf}`), 'utf8')),
  }
}

/** @param {string} bin @param {string[]} args */
function runPoller(bin, args) {
  const env = { ...process.env, GITHUB_SHA: SHA }
  env[PATH_KEY] = `${bin}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync(
    process.execPath,
    [POLLER, ...args, '--poll-seconds', '0'],
    { encoding: 'utf8', env },
  )
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('e2e: green runs for every required workflow → exit 0', () => {
  const gh = fakeGh({ 'selftest.yml': GREEN, 'lint.yml': GREEN })
  const r = runPoller(gh.bin, ['selftest.yml', 'lint.yml', '--attempts', '3'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all required workflows green/)
})

test('e2e: an all-failed workflow → exit 1 IMMEDIATELY, naming it (one poll, not the budget)', () => {
  const gh = fakeGh({ 'selftest.yml': GREEN, 'lint.yml': FAILED })
  const r = runPoller(gh.bin, ['selftest.yml', 'lint.yml', '--attempts', '5'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /lint\.yml FAILED/)
  assert.ok(!/selftest\.yml FAILED/.test(r.out), `must name only the red workflow: ${r.out}`)
  assert.equal(gh.calls('lint.yml'), 1, 'a known-red workflow must stop the release on the FIRST poll')
})

test('e2e: a pending first snapshot is retried, and a later green run releases the wait', () => {
  const gh = fakeGh(
    { 'selftest.yml': GREEN, 'lint.yml': GREEN },
    { 'selftest.yml.0': RUNNING },
  )
  const r = runPoller(gh.bin, ['selftest.yml', 'lint.yml', '--attempts', '4'])
  assert.equal(r.code, 0, r.out)
  assert.equal(gh.calls('selftest.yml'), 2, `one pending poll, then the green one: ${r.out}`)
})

test('e2e: ZERO runs for a required workflow → hard fail ONLY after the whole timeout budget', () => {
  const gh = fakeGh({ 'selftest.yml': GREEN, 'lint.yml': [] })
  const r = runPoller(gh.bin, ['selftest.yml', 'lint.yml', '--attempts', '3'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /timed out waiting/)
  assert.match(r.out, /lint\.yml: ZERO runs/)
  assert.match(r.out, /silent-skip shape/)
  assert.equal(gh.calls('lint.yml'), 3, 'absence must be given the full budget to appear before it hard-fails')
})

test('e2e: no workflows named, or a missing GITHUB_SHA, is a usage error (exit 2), never a wait', () => {
  const gh = fakeGh({})
  const none = runPoller(gh.bin, ['--attempts', '1'])
  assert.equal(none.code, 2, none.out)
  assert.match(none.out, /silent skip/)

  const env = { ...process.env }
  delete env.GITHUB_SHA
  env[PATH_KEY] = `${gh.bin}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const noSha = spawnSync(process.execPath, [POLLER, 'lint.yml', '--attempts', '1'], { encoding: 'utf8', env })
  assert.equal(noSha.status, 2, `${noSha.stdout ?? ''}${noSha.stderr ?? ''}`)
})
