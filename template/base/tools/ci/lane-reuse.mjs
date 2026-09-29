#!/usr/bin/env node
// Post-merge lane reuse (1.1.0): the transport. The judge is tools/lib/lane-reuse.mjs.
//
// Two modes, one per event, and each lane of quality-gate.yml that reuses calls both:
//
//   RECORD (last step, pull_request only; runs only if every earlier step passed):
//     node tools/ci/lane-reuse.mjs --record --job "<the job's name:>"
//   prints ONE marker line: the job name, `git rev-parse HEAD^{tree}` of the checked-out
//   merge commit, and the pull request's head (PR_HEAD_SHA, from the event, in env:). The
//   marker is built here so the step's `run:` text cannot contain it: GitHub echoes that
//   text into the log, and an echo must never count as a second marker. Any event but
//   pull_request, or a head that is not a commit id, is refused (exit 1): that is a wiring
//   fault, and a silent record would read as "nothing to reuse" forever.
//
//   LOOKUP (first step after checkout, push only; `id: reuse`):
//     node tools/ci/lane-reuse.mjs --job "<the job's name:>"
//   resolves the merged pull request for GITHUB_SHA, lists that pull request's runs of this
//   workflow at its final head, takes the newest run's latest attempt, finds the job by name
//   IN JAVASCRIPT on the parsed response, and reads the marker from that job's log. It
//   writes `hit=true` and `from=<run url>` to $GITHUB_OUTPUT on a hit, `hit=false`
//   otherwise. EVERY failure — the event, an API error, a parse error, a mismatch, a bug in
//   this file — is a miss that prints why and exits 0: the lane then runs every step, which
//   is what it did before this file existed. Only a usage error (no --job) exits 2.
//
// It runs BEFORE setup-node, on the runner image's own Node, so it imports Node built-ins
// and the judge only. Transport: the gh CLI the runner image carries, with GH_TOKEN from
// `github.token` in env: (never `${{ }}` inside `run:`). gh is spawned through a shell, as
// scripts/ci/wait-for-workflows.mjs does, so the Windows test leg's stand-in gh (a .cmd
// twin only a shell resolves) works; so EVERY operand that reaches that command line is
// checked against a strict shape first, and the job name never reaches it at all. git runs
// WITHOUT a shell (an argument array), because `HEAD^{tree}` carries a `^`, which cmd.exe
// reads as an escape character.
// SOURCE: docs/harness/README.md (post-merge lane reuse) [corpus: harness/doctrine]
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { formatMarker, judgeReuse, OBJECT_ID, WORKFLOW_FILE } from '../lib/lane-reuse.mjs'

// The operand shapes allowed on the gh command line.
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const API_PATH = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/
const FIELD = /^[a-z_]+=[A-Za-z0-9_.-]+$/
// A job log is text of any size the runner produced; bound it rather than let it crash.
const MAX_BUFFER = 256 * 1024 * 1024

/** @param {string} msg @returns {never} */
function usage(msg) {
  console.error(`lane-reuse: ${msg}`)
  console.error('usage: node tools/ci/lane-reuse.mjs [--record] --job "<the job\'s name:>"')
  process.exit(2)
}

/** @param {string[]} argv @returns {{ record: boolean, job: string }} */
function parseArgs(argv) {
  let record = false
  let job = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--record') record = true
    else if (argv[i] === '--job') {
      job = argv[i + 1] ?? null
      i += 1
    } else usage(`unknown argument ${JSON.stringify(argv[i])}`)
  }
  if (typeof job !== 'string' || job.trim() === '')
    usage('--job must name the job, exactly as its `name:` reads')
  return { record, job }
}

/** This checkout's tree, or '' when git cannot say. No shell: see the header. */
function readTree() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * One `gh api` call. Every operand is shape-checked before the command string is built;
 * a refused operand, a gh failure or an oversized answer all return null.
 * @param {string} path @param {string[]} [fields] query fields (sent with --method GET)
 * @returns {string | null}
 */
function ghApi(path, fields = []) {
  if (!API_PATH.test(path) || !fields.every((f) => FIELD.test(f))) return null
  const query = fields.map((f) => ` -f ${f}`).join('')
  const r = spawnSync(`gh api --method GET ${path}${query}`, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null
}

/**
 * A JSON answer, or the array under `key` in it; null on any failure.
 * @param {string} path @param {string[]} fields @param {string} [key]
 * @returns {unknown}
 */
function ghJson(path, fields, key) {
  const text = ghApi(path, fields)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return key === undefined ? parsed : (parsed?.[key] ?? null)
  } catch {
    return null
  }
}

/**
 * The fetch for each input the judge can ask for.
 * @param {string} repo @param {string} sha
 * @returns {Record<string, (v: import('../lib/lane-reuse.mjs').Verdict) => unknown>}
 */
function fetchers(repo, sha) {
  return {
    tree: () => readTree(),
    pulls: () => ghJson(`repos/${repo}/commits/${sha}/pulls`, []),
    runs: (v) =>
      ghJson(
        `repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs`,
        ['event=pull_request', `head_sha=${v.pull.head}`, 'per_page=100'],
        'workflow_runs',
      ),
    jobs: (v) =>
      ghJson(
        `repos/${repo}/actions/runs/${String(v.run.id)}/attempts/${String(v.run.attempt)}/jobs`,
        ['per_page=100'],
        'jobs',
      ),
    log: (v) => ghApi(`repos/${repo}/actions/jobs/${String(v.jobId)}/logs`),
  }
}

/**
 * Feed the judge until it stops asking. Bounded: the judge asks for each input once.
 * @param {string} job
 * @returns {import('../lib/lane-reuse.mjs').Verdict}
 */
function lookup(job) {
  const input = { event: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA, job }
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  let verdict = judgeReuse(input)
  if (verdict.need && !REPO_SHAPE.test(repo))
    return { hit: false, reason: 'GITHUB_REPOSITORY is not an owner/name pair' }
  const fetch = fetchers(repo, String(input.sha))
  for (let asked = 0; verdict.need && asked < 6; asked += 1) {
    input[verdict.need] = fetch[verdict.need](verdict)
    verdict = judgeReuse(input)
  }
  return verdict.need
    ? { hit: false, reason: `the judge kept asking for ${verdict.need}` }
    : verdict
}

/** @param {import('../lib/lane-reuse.mjs').Verdict} verdict */
function publish(verdict) {
  const lines = [
    `hit=${verdict.hit ? 'true' : 'false'}`,
    ...(verdict.hit ? [`from=${verdict.from}`] : []),
  ]
  const out = process.env.GITHUB_OUTPUT
  try {
    if (out) appendFileSync(out, `${lines.join('\n')}\n`)
  } catch (e) {
    // No output means `hit` reads empty, and an empty hit runs every step: the safe side.
    console.log(
      `lane-reuse: could not write $GITHUB_OUTPUT (${e instanceof Error ? e.message : String(e)}); every step runs`,
    )
    return
  }
  if (verdict.hit) {
    console.log(
      `lane-reuse: HIT — ${verdict.reason}. This lane's steps do not run again on this push.`,
    )
  } else {
    console.log(`lane-reuse: MISS — ${verdict.reason}. Every step of this lane runs.`)
  }
}

/** @param {string} job */
function record(job) {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  const head = process.env.PR_HEAD_SHA ?? ''
  const refuse = (/** @type {string} */ why) => {
    console.error(
      `lane-reuse: record refused — ${why}. Nothing was recorded, so the push after this merge runs this lane in full.`,
    )
    process.exit(1)
  }
  if (event !== 'pull_request')
    refuse(`the record runs only on pull_request, and this event is ${JSON.stringify(event)}`)
  if (!OBJECT_ID.test(head))
    refuse(
      'PR_HEAD_SHA is not a commit id (set it from github.event.pull_request.head.sha in env:)',
    )
  const tree = readTree()
  if (!OBJECT_ID.test(tree)) refuse("this checkout's tree could not be read")
  console.log(formatMarker({ job, tree, head }))
}

const { record: recording, job } = parseArgs(process.argv.slice(2))
if (recording) {
  record(job)
} else {
  let verdict
  try {
    verdict = lookup(job)
  } catch (e) {
    verdict = {
      hit: false,
      reason: `the lookup failed (${e instanceof Error ? e.message : String(e)})`,
    }
  }
  publish(verdict)
}
