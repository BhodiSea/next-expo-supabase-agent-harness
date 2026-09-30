// template/base/tools/lib/lane-reuse.mjs + template/base/tools/ci/lane-reuse.mjs (1.1.0, #57):
// a push to the default branch reuses the merged pull request's green lane result when the
// tree is identical, and runs everything otherwise.
//
// The cost this closes is real and the risk is the whole point of the tests. Six lanes of
// the shipped quality-gate.yml run on `pull_request` AND on the `push` its merge produces,
// and an up-to-date squash merge re-runs them on the tree the pull request run already
// proved. Reuse is only worth having if it can never turn a red, an unfinished run, another
// pull request's run or a different tree into a pass. So the judge is PURE and every one of
// those shapes is a miss here, by name; exactly one shape hits, and it names the run it
// relied on. The transport is then driven end to end through a stand-in `gh` on PATH (sh and
// .cmd twins delegating to one node stub, the wait-for-workflows precedent, so the Windows
// leg runs this file too): the stand-in records its argv, which is how the tests show a job
// name never reaches the shell, and a lookup on any event but push asks GitHub nothing.
// SOURCE: tests/gates/wait-for-workflows.test.mjs (the stand-in gh transport)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatMarker, judgeReuse, MARKER_TAG, readMarkers } from '../../template/base/tools/lib/lane-reuse.mjs'

const TRANSPORT = fileURLToPath(new URL('../../template/base/tools/ci/lane-reuse.mjs', import.meta.url))
const LIB = fileURLToPath(new URL('../../template/base/tools/lib/lane-reuse.mjs', import.meta.url))
const SUMMARIZER = fileURLToPath(new URL('../../template/base/tools/ci/summarize-gate.mjs', import.meta.url))

const SHA = 'a'.repeat(40) // the commit the push checked out (the squash)
const TREE = 'b'.repeat(40) // its tree, and the tree the pull request run proved
const HEAD = 'c'.repeat(40) // the pull request's final head
const JOB = 'integration lane (mobile <-> web-hosted API, real postgres)'
const RUN_URL = 'https://github.com/o/r/actions/runs/101'

const BRANCH = 'feature/reuse' // the pull request's head branch
const REPO_ID = 11 // this repository: the pull request's base AND head (not a fork)

const pull = (over = {}) => ({
  number: 7,
  merged_at: '2026-09-29T08:00:00Z',
  merge_commit_sha: SHA,
  head: { sha: HEAD, ref: BRANCH, repo: { id: REPO_ID, full_name: 'o/r' } },
  base: { ref: 'main', repo: { id: REPO_ID, full_name: 'o/r' } },
  ...over,
})
/**
 * A run the way GitHub serves it AFTER the merge. A workflow run's `pull_requests` lists
 * only pull requests that are still OPEN with a matching head_sha or head_branch, so once
 * the pull request is merged it is empty: the run is tied to it by its head commit, head
 * branch and head repository, never by that list.
 */
const run = (over = {}) => ({
  id: 101,
  run_attempt: 2,
  event: 'pull_request',
  head_sha: HEAD,
  head_branch: BRANCH,
  head_repository: { id: REPO_ID, full_name: 'o/r' },
  html_url: RUN_URL,
  created_at: '2026-09-29T07:00:00Z',
  pull_requests: [],
  ...over,
})
const job = (over = {}) => ({ id: 555, name: JOB, conclusion: 'success', ...over })
/** A job log the way GitHub serves it: every line timestamped, the step's command echoed. */
const logWith = (...markers) =>
  [
    '2026-09-29T07:10:00.0000000Z ##[group]Run node tools/ci/lane-reuse.mjs --record --job "x"',
    '2026-09-29T07:10:00.0000000Z ##[endgroup]',
    ...markers.map((m) => `2026-09-29T07:10:01.0000000Z ${m}`),
    '2026-09-29T07:10:02.0000000Z Cleaning up orphan processes',
    '',
  ].join('\n')
const LOG = logWith(formatMarker({ job: JOB, tree: TREE, head: HEAD }))
const snapshot = (over = {}) => ({
  event: 'push',
  sha: SHA,
  tree: TREE,
  job: JOB,
  pulls: [pull()],
  runs: [run()],
  jobs: [job()],
  log: LOG,
  ...over,
})

/** @param {import('../../template/base/tools/lib/lane-reuse.mjs').Verdict} v @param {RegExp} why */
function assertMiss(v, why) {
  assert.equal(v.hit, false, `expected a miss, got ${JSON.stringify(v)}`)
  assert.equal(v.need, undefined, `a miss is a verdict, not a request for more input: ${JSON.stringify(v)}`)
  assert.match(v.reason, why)
}

// ── the pure judge ────────────────────────────────────────────────────────────────────────

test('HIT: only the exact match reuses, and it names the run it relied on', () => {
  const v = judgeReuse(snapshot())
  assert.equal(v.hit, true, v.reason)
  assert.equal(v.from, RUN_URL)
  assert.match(v.reason, /#7/)
  assert.match(v.reason, new RegExp(TREE))
})

test('every event other than push misses, before asking GitHub anything', () => {
  for (const event of ['pull_request', 'schedule', 'workflow_dispatch', 'merge_group', 'pull_request_target', '', undefined]) {
    // Every later input left unfetched: an event miss must not even request the tree.
    const v = judgeReuse({ event, sha: SHA, job: JOB })
    assertMiss(v, /only a push/)
  }
})

test('a missing or malformed commit, job name or tree misses', () => {
  assertMiss(judgeReuse(snapshot({ sha: 'HEAD' })), /GITHUB_SHA/)
  assertMiss(judgeReuse(snapshot({ job: '' })), /--job/)
  assertMiss(judgeReuse(snapshot({ tree: '' })), /tree could not be read/)
  assertMiss(judgeReuse(snapshot({ tree: null })), /tree could not be read/)
})

test('no associated pull request, two of them, or one that was not merged, misses', () => {
  assertMiss(judgeReuse(snapshot({ pulls: [] })), /no pull request is associated/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull(), pull({ number: 8 })] })), /2 pull requests are associated/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ merged_at: null })] })), /#7 was not merged/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ merge_commit_sha: 'd'.repeat(40) })] })), /not as this commit/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ number: undefined })] })), /no number/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ head: {} })] })), /no head commit/)
  assertMiss(judgeReuse(snapshot({ pulls: null })), /lookup .* failed/)
})

test('only runs of the merged pull request at its final head count', () => {
  // Another pull request's run executes that pull request's own workflow text, which could
  // print any marker, so only a pull_request run at this pull request's final head, from its
  // head branch in its head repository, can stand in.
  assertMiss(judgeReuse(snapshot({ runs: [run({ head_sha: 'e'.repeat(40) })] })), /at its final head/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ head_branch: 'other-branch' })] })), /no quality-gate\.yml pull_request run of #7/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ head_branch: undefined })] })), /no quality-gate\.yml pull_request run of #7/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ head_repository: { id: 99, full_name: 'x/r' } })] })), /no quality-gate\.yml pull_request run of #7/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ head_repository: null })] })), /no quality-gate\.yml pull_request run of #7/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ event: 'push' })] })), /no quality-gate\.yml pull_request run/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ event: 'pull_request_target' })] })), /no quality-gate\.yml pull_request run/)
  assertMiss(judgeReuse(snapshot({ runs: [] })), /no quality-gate\.yml pull_request run/)
  assertMiss(judgeReuse(snapshot({ runs: null })), /listing .* failed/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ html_url: 'javascript:alert(1)' })] })), /malformed/)
  assertMiss(judgeReuse(snapshot({ runs: [run({ run_attempt: 0 })] })), /malformed/)
})

test('a run is tied to its pull request by head commit, branch and repository, not by pull_requests, which a merge empties', () => {
  // GitHub fills a workflow run's `pull_requests` with the pull requests that are OPEN with a
  // matching head, so the push after a merge always reads it empty. A judge that required the
  // merged pull request's number there would miss on every merge and reuse nothing.
  const v = judgeReuse(snapshot({ runs: [run({ pull_requests: [] })] }))
  assert.equal(v.hit, true, v.reason)
  // And a list naming some other OPEN pull request from the same head changes nothing either
  // way: it says which pull requests are open now, not which one triggered the run.
  assert.equal(judgeReuse(snapshot({ runs: [run({ pull_requests: [{ number: 8 }] })] })).hit, true)
})

test('a pull request from a fork never reuses, and neither does one whose head is gone', () => {
  // A fork's run executed workflow text from a repository this one does not control, up to
  // the merge. Conservative: its merge runs every lane, as it did before reuse existed.
  const fork = pull({ head: { sha: HEAD, ref: BRANCH, repo: { id: 99, full_name: 'someone/r' } } })
  assertMiss(judgeReuse(snapshot({ pulls: [fork] })), /#7 comes from a fork/)
  const forkRun = run({ head_repository: { id: 99, full_name: 'someone/r' } })
  assertMiss(judgeReuse(snapshot({ pulls: [fork], runs: [forkRun] })), /fork/)
  // A deleted head repository or branch leaves nothing to tie a run to.
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ head: { sha: HEAD, ref: BRANCH, repo: null } })] })), /#7 names no head repository/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ head: { sha: HEAD, repo: { id: REPO_ID } } })] })), /#7 names no head branch/)
  assertMiss(judgeReuse(snapshot({ pulls: [pull({ base: { ref: 'main', repo: null } })] })), /#7 names no base repository/)
})

test('the NEWEST run of the pull request decides: an older green never outranks a newer run', () => {
  const older = run({ id: 90, created_at: '2026-09-28T07:00:00Z', html_url: 'https://github.com/o/r/actions/runs/90' })
  const newer = run({ id: 101, created_at: '2026-09-29T07:00:00Z' })
  const v = judgeReuse(snapshot({ runs: [older, newer], jobs: undefined }))
  assert.equal(v.need, 'jobs')
  assert.equal(v.run.id, 101, 'the jobs asked for must be the newest run\'s')
  assert.equal(v.run.attempt, 2, 'and from its LATEST attempt')
  // Same creation time: the higher run id is the newer run.
  const tie = judgeReuse(snapshot({ runs: [newer, run({ id: 102 })], jobs: undefined }))
  assert.equal(tie.run.id, 102)
})

test('every conclusion other than exactly success misses', () => {
  for (const conclusion of ['failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure', 'SUCCESS', null, undefined]) {
    assertMiss(judgeReuse(snapshot({ jobs: [job({ conclusion })] })), /only success counts/)
  }
})

test('a missing job, a duplicated job name or an unreadable job list misses', () => {
  assertMiss(judgeReuse(snapshot({ jobs: [job({ name: 'static (validate floor)' })] })), /has no job named/)
  assertMiss(judgeReuse(snapshot({ jobs: [job(), job({ id: 556 })] })), /2 jobs named/)
  assertMiss(judgeReuse(snapshot({ jobs: [job({ id: 'x' })] })), /no job id/)
  assertMiss(judgeReuse(snapshot({ jobs: null })), /listing the jobs .* failed/)
})

test('a tree or head mismatch misses: the key is the tree, and the marker must be this run\'s', () => {
  const otherTree = logWith(formatMarker({ job: JOB, tree: 'f'.repeat(40), head: HEAD }))
  assertMiss(judgeReuse(snapshot({ log: otherTree })), /tree .* differs/)
  const otherHead = logWith(formatMarker({ job: JOB, tree: TREE, head: 'f'.repeat(40) }))
  assertMiss(judgeReuse(snapshot({ log: otherHead })), /head .* differs/)
  const otherJob = logWith(formatMarker({ job: 'unit (vitest + jest-expo + diff coverage)', tree: TREE, head: HEAD }))
  assertMiss(judgeReuse(snapshot({ log: otherJob })), /recorded for .* not for/)
})

test('no marker, a malformed marker or more than one marker in the log misses', () => {
  const good = formatMarker({ job: JOB, tree: TREE, head: HEAD })
  assertMiss(judgeReuse(snapshot({ log: logWith() })), /no reuse record/)
  assertMiss(judgeReuse(snapshot({ log: logWith(good, good) })), /2 reuse records/)
  for (const bad of [
    `${MARKER_TAG} not json`,
    `${MARKER_TAG} []`,
    `${MARKER_TAG} null`,
    `${MARKER_TAG} ${JSON.stringify({ job: JOB, tree: TREE })}`,
    `${MARKER_TAG} ${JSON.stringify({ job: JOB, tree: TREE, head: HEAD, extra: 1 })}`,
    `${MARKER_TAG} ${JSON.stringify({ job: JOB, tree: 'B'.repeat(40), head: HEAD })}`,
    `${MARKER_TAG} ${JSON.stringify({ job: '', tree: TREE, head: HEAD })}`,
  ]) {
    assertMiss(judgeReuse(snapshot({ log: logWith(bad) })), /malformed/)
  }
  assertMiss(judgeReuse(snapshot({ log: null })), /could not be read/)
})

test('the judge asks for each input in order, with what the transport needs to fetch it', () => {
  const base = { event: 'push', sha: SHA, job: JOB }
  assert.equal(judgeReuse(base).need, 'tree')
  assert.equal(judgeReuse({ ...base, tree: TREE }).need, 'pulls')
  const runs = judgeReuse({ ...base, tree: TREE, pulls: [pull()] })
  assert.equal(runs.need, 'runs')
  assert.deepEqual(runs.pull, { number: 7, head: HEAD, ref: BRANCH, repoId: REPO_ID })
  const jobs = judgeReuse({ ...base, tree: TREE, pulls: [pull()], runs: [run()] })
  assert.equal(jobs.need, 'jobs')
  assert.deepEqual(jobs.run, { id: 101, attempt: 2, url: RUN_URL, head: HEAD })
  const log = judgeReuse({ ...base, tree: TREE, pulls: [pull()], runs: [run()], jobs: [job()] })
  assert.equal(log.need, 'log')
  assert.equal(log.jobId, 555)
  for (const v of [runs, jobs, log]) assert.equal(v.hit, false, 'a request for input is never a hit')
})

test('the marker round-trips, and the record step\'s echoed command is not a marker', () => {
  const m = { job: JOB, tree: TREE, head: HEAD }
  assert.deepEqual(readMarkers(logWith(formatMarker(m))), { count: 1, marker: m })
  assert.equal(readMarkers(logWith()).count, 0)
  assert.ok(!'node tools/ci/lane-reuse.mjs --record --job "x"'.includes(MARKER_TAG))
})

test('both files use Node built-ins only: the lookup runs before setup-node, on the runner image\'s Node', () => {
  for (const file of [LIB, TRANSPORT]) {
    const specifiers = [...readFileSync(file, 'utf8').matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const s of specifiers) {
      assert.ok(s.startsWith('node:') || s === '../lib/lane-reuse.mjs', `${file} imports ${s}`)
    }
  }
})

// ── the transport, end to end through a stand-in gh ───────────────────────────────────────

const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

// Every scratch directory this file makes, removed when it ends.
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
/** @param {string} prefix */
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
const HAS_GIT = spawnSync('git', ['--version']).status === 0
const NO_GIT = 'needs git on PATH: the transport reads HEAD^{tree} through git'

/** A throwaway repository with one commit; returns its dir, commit and tree. */
function repo() {
  const dir = scratch('nsah-reuse-')
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('-c', 'user.email=x@y.z', '-c', 'user.name=x', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
  return { dir, sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }
}

/**
 * A fake `gh` earlier on PATH. It answers `gh api <path>` from `<key>.out` (or exits 1 when
 * `<key>.fail` exists), keyed by the path with every non-alphanumeric run folded to `_`,
 * and appends its argv to calls.jsonl, which is the proof of what reached the command line.
 * @param {Record<string, string | null>} answers path -> stdout, or null for a failure
 */
function fakeGh(answers) {
  const dir = scratch('nsah-reuse-gh-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const stub = join(dir, 'gh-stub.mjs')
  writeFileSync(
    stub,
    [
      "import { appendFileSync, existsSync, readFileSync } from 'node:fs'",
      "import { dirname, join } from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      'const dir = dirname(fileURLToPath(import.meta.url))',
      'const args = process.argv.slice(2)',
      "appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')",
      "const path = args.find((a) => a.startsWith('repos/')) ?? ''",
      "const key = path.replace(/[^A-Za-z0-9]+/g, '_')",
      "if (existsSync(join(dir, key + '.fail')) || !existsSync(join(dir, key + '.out'))) process.exit(1)",
      "process.stdout.write(readFileSync(join(dir, key + '.out'), 'utf8'))",
      '',
    ].join('\n'),
  )
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node "${stub}" "$@"\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'gh.cmd'), `@echo off\r\nnode "${stub}" %*\r\nexit /b %errorlevel%\r\n`)
  for (const [path, body] of Object.entries(answers)) {
    const key = path.replace(/[^A-Za-z0-9]+/g, '_')
    writeFileSync(join(dir, `${key}.${body === null ? 'fail' : 'out'}`), body ?? '')
  }
  const callsFile = join(dir, 'calls.jsonl')
  return {
    bin,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [],
  }
}

/** The four answers GitHub gives for a merged, up-to-date pull request whose lane passed. */
function greenAnswers({ sha, jobName, log }) {
  return {
    [`repos/o/r/commits/${sha}/pulls`]: JSON.stringify([pull({ merge_commit_sha: sha })]),
    'repos/o/r/actions/workflows/quality-gate.yml/runs': JSON.stringify({ total_count: 1, workflow_runs: [run()] }),
    'repos/o/r/actions/runs/101/attempts/2/jobs': JSON.stringify({ total_count: 1, jobs: [job({ name: jobName })] }),
    'repos/o/r/actions/jobs/555/logs': log,
  }
}

/** @param {{ bin: string, cwd: string, args: string[], env?: Record<string, string> }} o */
function runTransport({ bin, cwd, args, env = {} }) {
  const out = join(cwd, '.github-output')
  const childEnv = {
    ...process.env,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_OUTPUT: out,
    GH_TOKEN: 'test-token',
    ...env,
  }
  childEnv[PATH_KEY] = `${bin}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync(process.execPath, [TRANSPORT, ...args], { cwd, encoding: 'utf8', env: childEnv })
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    outputs: existsSync(out) ? readFileSync(out, 'utf8') : '',
  }
}

test('e2e: a push whose merged pull request passed this lane on this tree HITS, and publishes where from', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const log = logWith(formatMarker({ job: JOB, tree: r.tree, head: HEAD }))
  const gh = fakeGh(greenAnswers({ sha: r.sha, jobName: JOB, log }))
  const res = runTransport({ bin: gh.bin, cwd: r.dir, args: ['--job', JOB], env: { GITHUB_SHA: r.sha } })
  assert.equal(res.code, 0, res.out)
  // The whole HIT line, compared line for line: it names the run the result came from. (A
  // substring search for the run URL would also pass on a line that merely contained it.)
  const hit = `lane-reuse: HIT — ${JSON.stringify(JOB)} passed on this exact tree (${r.tree}) in ${RUN_URL}, the run of pull request head ${HEAD} (pull request #${String(pull().number)}). This lane's steps do not run again on this push.`
  assert.ok(res.stdout.split(/\r?\n/).includes(hit), res.out)
  assert.match(res.outputs, /^hit=true$/m)
  assert.ok(res.outputs.split('\n').includes(`from=${RUN_URL}`), res.outputs)
  assert.equal(gh.calls().length, 4, 'pulls, runs, jobs, log: one call each')
})

test('e2e: the job name never reaches the command line, so its metacharacters execute nothing', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const hostile = 'e2e $(touch pwned) & echo "x" | y <-> z; `touch pwned2`'
  const log = logWith(formatMarker({ job: hostile, tree: r.tree, head: HEAD }))
  const gh = fakeGh(greenAnswers({ sha: r.sha, jobName: hostile, log }))
  const res = runTransport({ bin: gh.bin, cwd: r.dir, args: ['--job', hostile], env: { GITHUB_SHA: r.sha } })
  assert.equal(res.code, 0, res.out)
  assert.match(res.outputs, /^hit=true$/m, 'matched in JavaScript on the parsed response')
  for (const argv of gh.calls()) {
    assert.ok(!argv.some((a) => a.includes('touch') || a.includes('<->')), `a job name reached gh: ${JSON.stringify(argv)}`)
  }
  assert.ok(!existsSync(join(r.dir, 'pwned')) && !existsSync(join(r.dir, 'pwned2')))
})

test('e2e: any event but push misses at once, asks GitHub nothing, and exits 0', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const gh = fakeGh({})
  for (const event of ['pull_request', 'schedule', 'workflow_dispatch']) {
    const res = runTransport({ bin: gh.bin, cwd: r.dir, args: ['--job', JOB], env: { GITHUB_EVENT_NAME: event, GITHUB_SHA: r.sha } })
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /lane-reuse: MISS — .*only a push/)
    assert.match(res.outputs, /^hit=false$/m)
    assert.doesNotMatch(res.outputs, /^from=/m)
  }
  assert.deepEqual(gh.calls(), [])
})

test('e2e: an API failure, or a merge that changed the tree, is a miss that says why and exits 0', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const failing = fakeGh({ [`repos/o/r/commits/${r.sha}/pulls`]: null })
  const res = runTransport({ bin: failing.bin, cwd: r.dir, args: ['--job', JOB], env: { GITHUB_SHA: r.sha } })
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /MISS — the pull request lookup .* failed/)
  assert.match(res.outputs, /^hit=false$/m)

  const behind = logWith(formatMarker({ job: JOB, tree: 'f'.repeat(40), head: HEAD }))
  const gh = fakeGh(greenAnswers({ sha: r.sha, jobName: JOB, log: behind }))
  const res2 = runTransport({ bin: gh.bin, cwd: r.dir, args: ['--job', JOB], env: { GITHUB_SHA: r.sha } })
  assert.equal(res2.code, 0, res2.out)
  assert.match(res2.out, /MISS — .*tree/)
  assert.match(res2.outputs, /^hit=false$/m)
})

test('e2e: the record prints exactly one marker on a pull request, and a push lookup reads it back as a hit', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const rec = runTransport({
    bin: fakeGh({}).bin,
    cwd: r.dir,
    args: ['--record', '--job', JOB],
    env: { GITHUB_EVENT_NAME: 'pull_request', PR_HEAD_SHA: HEAD, GITHUB_SHA: r.sha },
  })
  assert.equal(rec.code, 0, rec.out)
  const markers = rec.stdout.split('\n').filter((l) => l.includes(MARKER_TAG))
  assert.equal(markers.length, 1, rec.out)
  assert.deepEqual(readMarkers(rec.stdout).marker, { job: JOB, tree: r.tree, head: HEAD })

  // The round trip: that stdout, served back the way GitHub serves a job log.
  const log = rec.stdout.split('\n').map((l) => `2026-09-29T07:10:01.0000000Z ${l}`).join('\n')
  const gh = fakeGh(greenAnswers({ sha: r.sha, jobName: JOB, log }))
  const res = runTransport({ bin: gh.bin, cwd: r.dir, args: ['--job', JOB], env: { GITHUB_SHA: r.sha } })
  assert.match(res.outputs, /^hit=true$/m, res.out)
})

test('e2e: the record refuses any event but pull_request, and a head that is not a commit id', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const bin = fakeGh({}).bin
  for (const env of [
    { GITHUB_EVENT_NAME: 'push', PR_HEAD_SHA: HEAD },
    { GITHUB_EVENT_NAME: 'pull_request', PR_HEAD_SHA: '' },
    { GITHUB_EVENT_NAME: 'pull_request', PR_HEAD_SHA: 'main' },
  ]) {
    const res = runTransport({ bin, cwd: r.dir, args: ['--record', '--job', JOB], env })
    assert.equal(res.code, 1, res.out)
    assert.ok(!res.stdout.includes(MARKER_TAG), `a refused record printed a marker: ${res.out}`)
  }
})

test('e2e: a missing --job is a usage error (exit 2), never a silent miss', () => {
  const r = { dir: scratch('nsah-reuse-usage-') }
  const bin = fakeGh({}).bin
  for (const args of [[], ['--job'], ['--job', ''], ['--jb', JOB]]) {
    const res = runTransport({ bin, cwd: r.dir, args })
    assert.equal(res.code, 2, `${JSON.stringify(args)} -> ${res.out}`)
  }
})

test('e2e: a hit reaches gate-summary through the job output — named with its run, verdict unchanged', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const r = repo()
  const log = logWith(formatMarker({ job: JOB, tree: r.tree, head: HEAD }))
  const gh = fakeGh(greenAnswers({ sha: r.sha, jobName: JOB, log }))
  const res = runTransport({ bin: gh.bin, cwd: r.dir, args: ['--job', JOB], env: { GITHUB_SHA: r.sha } })
  // The job maps `reused-from: ${{ steps.reuse.outputs.from }}`; this is that mapping.
  const from = /^from=(.*)$/m.exec(res.outputs)?.[1] ?? ''
  assert.equal(from, RUN_URL, res.out)
  const summarize = (needs) =>
    spawnSync(process.execPath, [SUMMARIZER], { encoding: 'utf8', env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) } })
  const green = summarize({
    'integration-lane': { result: 'success', outputs: { 'reused-from': from } },
    static: { result: 'success', outputs: { 'reused-from': '' } },
  })
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /REUSED/)
  assert.ok(green.stdout.includes(`integration-lane <- ${RUN_URL}`), green.stdout)
  assert.ok(!/- static <-/.test(green.stdout), 'a lane that ran is not reported as reused')
  const red = summarize({
    'integration-lane': { result: 'success', outputs: { 'reused-from': from } },
    static: { result: 'failure', outputs: {} },
  })
  assert.equal(red.status, 1, red.stdout + red.stderr)
})
