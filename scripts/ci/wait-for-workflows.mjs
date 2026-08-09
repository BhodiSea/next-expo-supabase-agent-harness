#!/usr/bin/env node
// THE PUBLISH-BLOCKING POLLER: release publish blocks on OTHER workflows' verdicts for
// the exact SHA being tagged, and this script is where that verdict lives. Extracted
// from release.yml's inline selftest wait (0.7.0, W8) following the summarize-gate
// precedent — the verdict lives in a script precisely so it can be falsified by
// tests/gates/wait-for-workflows.test.mjs rather than being an untestable YAML
// expression — and generalized to a LIST of required workflows because tag-time parity
// now needs release to block on BOTH selftest.yml AND lint.yml at the tag ref.
//
// VERDICT DOCTRINE, per required workflow, over `gh run list --commit $GITHUB_SHA`:
//   - some completed run concluded success     → that workflow is GREEN;
//   - runs exist, all completed, none success  → HARD FAIL immediately, naming it —
//     a red required workflow must stop the release the moment it is known;
//   - runs exist, some still running/queued    → pending; keep polling within budget;
//   - ZERO runs                                → pending while the budget lasts, then a
//     HARD FAIL naming the absence: a wait that treats absence as pending-forever is
//     the silent-skip shape (a required workflow whose `on:` triggers never fired for
//     this ref would otherwise read as timeout flake instead of as the defect it is);
//   - `gh run list` itself failing             → pending (network/auth flake must not
//     invent a verdict either way), named loudly if it persists to timeout.
// Every required workflow green → exit 0. The poll cadence and total budget are the
// SAME 90 × 60 s the inline wait used; --attempts/--poll-seconds exist for the
// death-tests, not for the release lane.
//
// Transport mirrors the inline step it replaced: the gh CLI with GH_TOKEN in env. It is
// spawned through the shell (the check-e2e pnpm-shim precedent: on Windows the test's
// stand-in gh is a .cmd twin only a shell resolves), so both embedded operands are
// validated against strict shapes before the command string is built.
//   usage: GITHUB_SHA=<sha> GH_TOKEN=<token> node scripts/ci/wait-for-workflows.mjs \
//            <workflow.yml> [<workflow.yml> ...] [--attempts N] [--poll-seconds N]
// SOURCE: .github/workflows/release.yml · tests/gates/wait-for-workflows.test.mjs
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Judge one poll's snapshot across every required workflow. `runsByWorkflow` maps each
 * workflow file to the parsed `gh run list --json status,conclusion` array for the SHA,
 * or null when the listing itself failed (the caller must never let a listing failure
 * masquerade as an empty run list — absence and unreachability are different findings).
 * @param {Record<string, { status?: string, conclusion?: string | null }[] | null>} runsByWorkflow
 * @returns {{ verdict: 'green' | 'failed' | 'pending', green: string[], failed: string[],
 *             running: string[], absent: string[], errored: string[] }}
 */
export function judgeRuns(runsByWorkflow) {
  /** @type {string[]} */ const green = []
  /** @type {string[]} */ const failed = []
  /** @type {string[]} */ const running = []
  /** @type {string[]} */ const absent = []
  /** @type {string[]} */ const errored = []
  for (const [wf, runs] of Object.entries(runsByWorkflow)) {
    if (!Array.isArray(runs)) errored.push(wf)
    else if (runs.length === 0) absent.push(wf)
    else if (runs.some((r) => r.status === 'completed' && r.conclusion === 'success')) green.push(wf)
    else if (runs.every((r) => r.status === 'completed')) failed.push(wf)
    else running.push(wf)
  }
  const verdict =
    failed.length > 0
      ? 'failed'
      : running.length + absent.length + errored.length === 0
        ? 'green'
        : 'pending'
  return { verdict, green, failed, running, absent, errored }
}

/**
 * The LOUD timeout report: one line per still-not-green workflow, each naming what was
 * observed and the re-runnable remedy — a stuck tag with a mute log is how a release
 * dies in place. Zero-runs gets its own wording because it is not flake: it means the
 * required workflow never started for this ref at all.
 * @param {ReturnType<typeof judgeRuns>} judged
 * @param {string} sha
 * @param {number} minutes
 * @returns {string[]}
 */
export function timeoutReport(judged, sha, minutes) {
  /** @type {string[]} */ const lines = []
  for (const wf of judged.absent) {
    lines.push(
      `${wf}: ZERO runs exist for ${sha} after ${String(minutes)} min — a required workflow that never starts is the silent-skip shape, not flake. Check its \`on:\` triggers cover this tag ref, then re-run this release job.`,
    )
  }
  for (const wf of judged.running) {
    lines.push(
      `${wf}: still not finished for ${sha} after ${String(minutes)} min — wait for it (or \`gh run rerun\` a stuck run), then re-run this release job.`,
    )
  }
  for (const wf of judged.errored) {
    lines.push(
      `${wf}: \`gh run list\` kept failing, so no verdict was ever observed — check GH_TOKEN and network, then re-run this release job.`,
    )
  }
  return lines
}

// The two operands embedded in the shell command line (see the header for why shell).
const WORKFLOW_SHAPE = /^[A-Za-z0-9._-]+\.ya?ml$/
const SHA_SHAPE = /^[0-9a-f]{7,64}$/i

/**
 * One `gh run list` for one workflow at one SHA. Returns the parsed run array, or null
 * when gh fails or prints non-JSON — the caller keeps polling rather than guessing.
 * @param {string} workflow
 * @param {string} sha
 * @returns {{ status?: string, conclusion?: string | null }[] | null}
 */
function fetchRuns(workflow, sha) {
  const r = spawnSync(
    `gh run list --workflow ${workflow} --commit ${sha} --json status,conclusion --limit 10`,
    { shell: true, encoding: 'utf8' },
  )
  if (r.status !== 0) return null
  try {
    const parsed = JSON.parse(String(r.stdout))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {string[]} argv
 * @returns {{ workflows: string[], attempts: number, pollSeconds: number }}
 */
function parseArgs(argv) {
  /** @type {string[]} */ const workflows = []
  let attempts = 90 // × 60 s = the same 90-minute budget the inline wait had
  let pollSeconds = 60
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--attempts') attempts = Number(argv[(i += 1)])
    else if (argv[i] === '--poll-seconds') pollSeconds = Number(argv[(i += 1)])
    else workflows.push(argv[i])
  }
  return { workflows, attempts, pollSeconds }
}

/** @param {string} msg @returns {never} */
function usageError(msg) {
  console.error(`wait-for-workflows: ${msg}`)
  console.error(
    'usage: GITHUB_SHA=<sha> node scripts/ci/wait-for-workflows.mjs <workflow.yml> [<workflow.yml> ...] [--attempts N] [--poll-seconds N]',
  )
  process.exit(2)
}

/**
 * @param {{ workflows: string[], attempts: number, pollSeconds: number }} args
 * @param {string} sha
 */
function validateArgs({ workflows, attempts, pollSeconds }, sha) {
  if (workflows.length === 0) usageError('no required workflows named — a wait over nothing is a silent skip')
  for (const wf of workflows) {
    if (!WORKFLOW_SHAPE.test(wf)) usageError(`workflow ${JSON.stringify(wf)} is not a bare <name>.yml filename`)
  }
  if (!SHA_SHAPE.test(sha)) usageError('GITHUB_SHA is not set to a commit SHA')
  if (!Number.isInteger(attempts) || attempts < 1) usageError('--attempts must be a positive integer')
  if (!Number.isFinite(pollSeconds) || pollSeconds < 0) usageError('--poll-seconds must be a non-negative number')
}

/** @param {ReturnType<typeof judgeRuns>} judged @param {string} sha */
function reportFailed(judged, sha) {
  for (const wf of judged.failed) {
    console.error(
      `::error::${wf} FAILED for ${sha} — every completed run is non-success, and a red required workflow must stop the release. Fix or re-run it (\`gh run rerun\`), then re-run this job.`,
    )
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { workflows, attempts, pollSeconds } = args
  const sha = process.env.GITHUB_SHA ?? ''
  validateArgs(args, sha)

  console.log(`waiting for green ${workflows.join(' + ')} runs on ${sha} (budget ${String(attempts)} × ${String(pollSeconds)}s)`)
  let judged = judgeRuns(Object.fromEntries(workflows.map((wf) => [wf, null])))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    judged = judgeRuns(Object.fromEntries(workflows.map((wf) => [wf, fetchRuns(wf, sha)])))
    if (judged.verdict === 'failed') {
      reportFailed(judged, sha)
      process.exit(1)
    }
    if (judged.verdict === 'green') {
      console.log(`all required workflows green for ${sha}: ${judged.green.join(', ')}`)
      process.exit(0)
    }
    console.log(
      `poll ${String(attempt)}/${String(attempts)}: green=[${judged.green.join(', ')}] running=[${judged.running.join(', ')}] absent=[${judged.absent.join(', ')}] errored=[${judged.errored.join(', ')}]`,
    )
    if (attempt < attempts) await new Promise((res) => setTimeout(res, pollSeconds * 1000))
  }
  console.error(`::error::timed out waiting for required workflow runs on ${sha}`)
  for (const line of timeoutReport(judged, sha, Math.round((attempts * pollSeconds) / 60))) {
    console.error(`::error::${line}`)
  }
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
