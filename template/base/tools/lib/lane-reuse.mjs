// tools/lib/lane-reuse.mjs — the judge behind post-merge lane reuse (1.1.0).
//
// THE COST. quality-gate.yml runs on `pull_request` and on the `push` its merge produces, and
// the concurrency group is keyed on `github.ref`, which differs between the two, so neither
// run cancels the other. `static`, `unit`, `mutation`, `runtime-rls`, `e2e-fast` and
// `integration-lane` carry no job-level `if:`, so an up-to-date squash merge re-ran all of
// them on the tree the pull request run had just proved. And the push run judged that tree
// LESS strictly: without GITHUB_BASE_REF the diff-scoped steps compare against HEAD, so diff
// coverage, the mutation scoper and the append-only migration check all see an empty diff.
//
// THE RULE. On a push, a lane asks whether the merged pull request's own run already passed
// THIS lane on THIS tree. The tree is the key: `git rev-parse HEAD^{tree}` of the checked-out
// commit on the push, and of the checked-out merge commit on the pull request, where the
// lane's last step printed one marker (the job name, that tree, the pull request's head). A
// merge that changed anything — a branch behind its base, a conflict resolution — has a
// different tree and misses. The tree does not pin everything (history, the runner image,
// the network, the clock), which is why the nightly run never reuses.
//
// PURE. No fs, no network, no clock. The transport (tools/ci/lane-reuse.mjs) feeds inputs in
// and fetches whatever `need` asks for next, so every miss the judge can return is decided
// here and proven in the harness's tests/gates/lane-reuse.test.mjs. `undefined` means "not
// fetched yet" and yields a `need`; anything unusable — null from a failed fetch included —
// is a MISS that says why. A miss is never an error: the lane simply runs every step.
// SOURCE: docs/harness/README.md (post-merge lane reuse) [corpus: harness/doctrine]

/** The one workflow whose pull request runs can stand in for its push runs. */
export const WORKFLOW_FILE = 'quality-gate.yml'

/**
 * The marker's tag. The record step's `run:` text never contains it — the script builds the
 * marker — so GitHub's echo of the step's command in the log can never count as a second one.
 */
export const MARKER_TAG = '[lane-reuse] RECORD v1'

/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase as git prints it. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// The run URL becomes a step output and a job output, so it must be one line of https.
const RUN_URL = /^https:\/\/[^\s"'<>`]+$/

/**
 * @typedef {{ job: string, tree: string, head: string }} Marker
 * @typedef {{ number: number, head: string, ref: string, repoId: number }} PullRef
 * @typedef {{ id: number, attempt: number, url: string, head: string }} RunRef
 * @typedef {{
 *   hit: boolean, reason: string, from?: string,
 *   need?: 'tree' | 'pulls' | 'runs' | 'jobs' | 'log',
 *   pull?: PullRef, run?: RunRef, jobId?: number,
 * }} Verdict
 */

/** @param {string} reason @returns {Verdict} */
const miss = (reason) => ({ hit: false, reason })

/**
 * @param {Verdict['need']} what @param {Partial<Verdict>} [context]
 * @returns {Verdict}
 */
const need = (what, context = {}) => ({
  hit: false,
  reason: `needs ${String(what)}`,
  need: what,
  ...context,
})

/**
 * The one marker line the record step prints.
 * @param {Marker} marker
 * @returns {string}
 */
export function formatMarker({ job, tree, head }) {
  return `${MARKER_TAG} ${JSON.stringify({ job, tree, head })}`
}

/** @param {unknown} v @returns {v is Marker} */
function isMarker(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const m = /** @type {Record<string, unknown>} */ (v)
  return (
    Object.keys(m).length === 3 &&
    typeof m.job === 'string' &&
    m.job !== '' &&
    typeof m.tree === 'string' &&
    OBJECT_ID.test(m.tree) &&
    typeof m.head === 'string' &&
    OBJECT_ID.test(m.head)
  )
}

/** @param {string} line @returns {Marker | null} */
function parseMarkerLine(line) {
  const payload = line.slice(line.indexOf(MARKER_TAG) + MARKER_TAG.length).trim()
  try {
    const value = JSON.parse(payload)
    return isMarker(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Every line of a job log that carries the tag. GitHub prefixes each log line with a
 * timestamp, so the tag is looked for anywhere on the line.
 * @param {string} log
 * @returns {{ count: number, marker: Marker | null }} `marker` only when there is exactly one
 *   tagged line and it parses
 */
export function readMarkers(log) {
  const lines = String(log)
    .split('\n')
    .filter((l) => l.includes(MARKER_TAG))
  return { count: lines.length, marker: lines.length === 1 ? parseMarkerLine(lines[0]) : null }
}

/**
 * What the request itself must satisfy before anything is fetched.
 * @param {{ event?: unknown, sha?: unknown, job?: unknown }} input
 * @returns {Verdict | null}
 */
function judgeRequest({ event, sha, job }) {
  if (event !== 'push') {
    return miss(
      `event ${JSON.stringify(event ?? '')} never reuses: only a push to the default branch does, and pull_request, schedule and workflow_dispatch always run in full`,
    )
  }
  if (typeof sha !== 'string' || !OBJECT_ID.test(sha)) return miss('GITHUB_SHA is not a commit id')
  if (typeof job !== 'string' || job === '') return miss('no --job name to look up')
  return null
}

/** @param {unknown} repo @returns {number | null} a repository's id, or null */
const repoId = (repo) => {
  const id = /** @type {Record<string, unknown> | null | undefined} */ (repo)?.id
  return Number.isInteger(id) ? /** @type {number} */ (id) : null
}

/**
 * Where the pull request's head lives. A run is tied to its pull request by this (head
 * commit, head branch, head repository), because GitHub empties a run's `pull_requests` once
 * the pull request is merged. A FORK never reuses: its run executed workflow text from a
 * repository this one does not control until the merge, so its merge runs every lane, as it
 * did before reuse existed.
 * @param {Record<string, any>} pr @param {number} n
 * @returns {Verdict | { ok: { ref: string, repoId: number } }}
 */
function headOf(pr, n) {
  const ref = pr.head?.ref
  if (typeof ref !== 'string' || ref === '') return miss(`#${String(n)} names no head branch`)
  const head = repoId(pr.head?.repo)
  if (head === null) return miss(`#${String(n)} names no head repository (a deleted fork?)`)
  const base = repoId(pr.base?.repo)
  if (base === null) return miss(`#${String(n)} names no base repository`)
  if (head !== base) {
    return miss(
      `#${String(n)} comes from a fork, and a fork's pull request never reuses: its merge runs every lane`,
    )
  }
  return { ok: { ref, repoId: head } }
}

/** @param {unknown} p @param {string} sha @returns {Verdict | { ok: PullRef }} */
function mergedPull(p, sha) {
  const pr = /** @type {Record<string, any>} */ (p ?? {})
  const n = pr.number
  if (!Number.isInteger(n) || n < 1) return miss('the associated pull request has no number')
  if (typeof pr.merged_at !== 'string' || pr.merged_at === '')
    return miss(`#${String(n)} was not merged`)
  if (pr.merge_commit_sha !== sha) {
    return miss(`#${String(n)} merged as ${String(pr.merge_commit_sha)}, not as this commit ${sha}`)
  }
  const head = pr.head?.sha
  if (typeof head !== 'string' || !OBJECT_ID.test(head))
    return miss(`#${String(n)} names no head commit`)
  const where = headOf(pr, n)
  if (!('ok' in where)) return where
  return { ok: { number: n, head, ...where.ok } }
}

/**
 * Exactly one pull request, merged, whose merge commit IS this push's commit.
 * @param {unknown} pulls the parsed `GET /repos/{r}/commits/{sha}/pulls`
 * @param {string} sha
 * @returns {Verdict | { ok: PullRef }}
 */
function pickPull(pulls, sha) {
  if (pulls === undefined) return need('pulls')
  if (!Array.isArray(pulls))
    return miss(`the pull request lookup for ${sha} failed (API or parse error)`)
  if (pulls.length === 0)
    return miss(`no pull request is associated with ${sha}: a direct push, never a merge`)
  if (pulls.length > 1) {
    return miss(
      `${String(pulls.length)} pull requests are associated with ${sha}, and reuse needs exactly one`,
    )
  }
  return mergedPull(pulls[0], sha)
}

/**
 * A run OF THIS pull request at its final head: a `pull_request` run whose head commit, head
 * branch and head repository are the pull request's. Another pull request's run executes that
 * pull request's own workflow text, which could print any marker, so it never stands in.
 * `pull_requests` is NOT read: GitHub fills it with the pull requests that are OPEN with a
 * matching head, so on the push after a merge it is empty (or names some other open pull
 * request from the same branch), and it never says which pull request triggered the run.
 * @param {any} r @param {PullRef} pull
 */
function isRunOf(r, pull) {
  return (
    r?.event === 'pull_request' &&
    r.head_sha === pull.head &&
    r.head_branch === pull.ref &&
    repoId(r.head_repository) === pull.repoId
  )
}

/** Newest first: creation time, then the (monotonic) run id. @param {any} a @param {any} b */
function newestFirst(a, b) {
  return (
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
    Number(b.id) - Number(a.id)
  )
}

/**
 * The NEWEST run of the pull request at its final head decides: an older green never
 * outranks a newer run, whatever that one concluded. Its latest attempt is the one read.
 * @param {unknown} runs the parsed `workflow_runs` of this workflow, event pull_request
 * @param {PullRef} pull
 * @returns {Verdict | { ok: RunRef }}
 */
function pickRun(runs, pull) {
  if (runs === undefined) return need('runs', { pull })
  if (!Array.isArray(runs)) {
    return miss(
      `listing ${WORKFLOW_FILE} runs for #${String(pull.number)} failed (API or parse error)`,
    )
  }
  const own = runs.filter((r) => isRunOf(r, pull)).sort(newestFirst)
  if (own.length === 0) {
    return miss(
      `no ${WORKFLOW_FILE} pull_request run of #${String(pull.number)} at its final head ${pull.head} on its head branch ${JSON.stringify(pull.ref)}`,
    )
  }
  const r = own[0]
  const valid =
    Number.isInteger(r.id) &&
    Number.isInteger(r.run_attempt) &&
    r.run_attempt >= 1 &&
    RUN_URL.test(String(r.html_url))
  if (!valid)
    return miss(`the newest run of #${String(pull.number)} is malformed (id, attempt or URL)`)
  return { ok: { id: r.id, attempt: r.run_attempt, url: r.html_url, head: pull.head } }
}

/**
 * The job whose `name:` is exactly `name`, matched here on the parsed response and never on
 * a command line, and its conclusion must be exactly `success`: failure, neutral, cancelled,
 * skipped, timed_out, action_required and null never count.
 * @param {unknown} jobs the parsed `jobs` of the run's latest attempt
 * @param {string} name @param {RunRef} run
 * @returns {Verdict | { ok: number }}
 */
function pickJob(jobs, name, run) {
  if (jobs === undefined) return need('jobs', { run })
  if (!Array.isArray(jobs))
    return miss(`listing the jobs of ${run.url} failed (API or parse error)`)
  const named = jobs.filter((j) => j?.name === name)
  if (named.length === 0)
    return miss(
      `${run.url} (attempt ${String(run.attempt)}) has no job named ${JSON.stringify(name)}`,
    )
  if (named.length > 1) {
    return miss(
      `${run.url} (attempt ${String(run.attempt)}) has ${String(named.length)} jobs named ${JSON.stringify(name)}`,
    )
  }
  const j = named[0]
  if (j.conclusion !== 'success') {
    return miss(
      `${JSON.stringify(name)} concluded ${JSON.stringify(j.conclusion ?? null)} in ${run.url}, and only success counts`,
    )
  }
  if (!Number.isInteger(j.id))
    return miss(`${JSON.stringify(name)} in ${run.url} carries no job id`)
  return { ok: j.id }
}

/**
 * The job's log must hold exactly one well-formed marker, for this job, this tree and the
 * run's own head.
 * @param {unknown} log @param {{ job: string, tree: string, run: RunRef, jobId: number }} ctx
 * @returns {Verdict}
 */
function judgeLog(log, { job, tree, run, jobId }) {
  if (log === undefined) return need('log', { run, jobId })
  if (typeof log !== 'string')
    return miss(`the log of ${JSON.stringify(job)} in ${run.url} could not be read`)
  const { count, marker } = readMarkers(log)
  if (count === 0) return miss(`no reuse record in the log of ${JSON.stringify(job)} in ${run.url}`)
  if (count > 1)
    return miss(
      `${String(count)} reuse records in the log of ${JSON.stringify(job)} in ${run.url}, and exactly one counts`,
    )
  if (marker === null) return miss(`the reuse record in ${run.url} is malformed`)
  if (marker.job !== job)
    return miss(
      `the record in ${run.url} was recorded for ${JSON.stringify(marker.job)}, not for ${JSON.stringify(job)}`,
    )
  if (marker.tree !== tree) {
    return miss(
      `the tree ${marker.tree} that ${run.url} proved differs from this checkout's ${tree}: the merge changed something`,
    )
  }
  if (marker.head !== run.head)
    return miss(`the recorded head ${marker.head} differs from the run's head ${run.head}`)
  return {
    hit: true,
    from: run.url,
    reason: `${JSON.stringify(job)} passed on this exact tree (${tree}) in ${run.url}, the run of pull request head ${run.head}`,
  }
}

/**
 * The whole judgement. Returns a hit, a miss, or a `need` naming the next input to fetch
 * together with what the transport needs to fetch it (`pull`, `run`, `jobId`).
 *
 * @param {{
 *   event?: unknown, sha?: unknown, job?: unknown, tree?: unknown,
 *   pulls?: unknown, runs?: unknown, jobs?: unknown, log?: unknown,
 * }} input
 * @returns {Verdict}
 */
export function judgeReuse(input) {
  const refused = judgeRequest(input)
  if (refused) return refused
  const sha = /** @type {string} */ (input.sha)
  const job = /** @type {string} */ (input.job)
  if (input.tree === undefined) return need('tree')
  if (typeof input.tree !== 'string' || !OBJECT_ID.test(input.tree))
    return miss("this checkout's tree could not be read")
  const pull = pickPull(input.pulls, sha)
  if (!('ok' in pull)) return pull
  const run = pickRun(input.runs, pull.ok)
  if (!('ok' in run)) return run
  const picked = pickJob(input.jobs, job, run.ok)
  if (!('ok' in picked)) return picked
  const verdict = judgeLog(input.log, { job, tree: input.tree, run: run.ok, jobId: picked.ok })
  return verdict.hit
    ? { ...verdict, reason: `${verdict.reason} (pull request #${String(pull.ok.number)})` }
    : verdict
}
