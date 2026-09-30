// tools/lib/workflow-hardening.mjs — the house rules for a GitHub Actions workflow, as pure
// rules over its text (1.1.0).
//
// THE THREE RULES, each a way a lane reports something other than what happened:
//   - THE SHELL. GitHub runs a step that names no shell as `bash -e {0}`, without
//     `pipefail`, so `producer | tee file` reports tee's status and the producer's failure
//     is gone. A workflow-level `defaults.run.shell: bash` (which GitHub runs as
//     `bash --noprofile --norc -eo pipefail {0}`) closes the class, above `jobs:`.
//   - THE CLOCK. A job with no `timeout-minutes` inherits GitHub's 360-minute default, so a
//     hung step is six hours of runner before anything reports. Every job that can take a
//     ceiling carries a literal one inside the caller's bound.
//   - THE SENSOR. step-security/harden-runner watches egress only from the moment it runs,
//     so it is the FIRST step of every job that runs steps on a GitHub-hosted runner, and on
//     a Windows runner it sets `egress-policy: audit` (blocking is Linux-only; an audited
//     Windows job beats an uninstrumented one). A reusable-workflow call has no steps of its
//     own, and a self-hosted runner's egress belongs to its host's firewall.
//
// WHO READS THEM. tests/gates/workflow-hardening.test.mjs holds the workflows the harness
// ships and its own under a 240-minute bar; tools/check-workflow-hardening.mjs, a CI-only
// gate run by actions-lint.yml's `workflow-hardening` job, holds the project's own under the
// platform's bound (PLATFORM_LIMITS). One rule set, two bounds.
//
// YAML-SHAPED, NEVER YAML-PARSED, like every workflow check here: no parser dependency. So
// the reading is stated, and input it cannot read is a FINDING, never a pass. CRLF is
// normalised first. A job is a key directly under a top-level `jobs:`, at the indentation of
// the first key there, named in GitHub's job-id alphabet ([A-Za-z_][A-Za-z0-9_-]*); a job's
// own keys sit at the indentation of its first key. Comment lines are skipped everywhere, so
// a commented-out step is not a step.
// SOURCE: docs/harness/gates-catalog.md (CI-only lanes, workflow-hardening)
// SOURCE: https://docs.github.com/en/actions/reference/limits (a job runs for up to 6 hours on a GitHub-hosted runner and up to 5 days on a self-hosted one)

/**
 * The gate's bound: the longest a job can run on the platform. A ceiling above it is a
 * number the runner never honours, and a job with none inherits 360 minutes.
 * @type {{ maxMinutes: number, selfHostedMaxMinutes: number }}
 */
export const PLATFORM_LIMITS = Object.freeze({ maxMinutes: 360, selfHostedMaxMinutes: 5 * 24 * 60 })

const HARDEN_RUNNER = 'step-security/harden-runner@'
const JOB_ID = /^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1:\s*(#.*)?$/
const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length

/** A blank line or a comment line: never a key, a step or a value. @param {string} line */
const isNoise = (line) => {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

/**
 * A scalar as written after `key:`: trailing comment and one pair of quotes removed.
 * @param {string} raw @returns {string}
 */
function scalar(raw) {
  const v = raw.replace(/\s+#.*$/, '').trim()
  const quoted = /^(["'])(.*)\1$/.exec(v)
  return quoted ? quoted[2] : v
}

/**
 * The index just past the block `lines[at]` opens: the first later line that is not noise
 * and sits at or left of its indentation.
 * @param {string[]} lines @param {number} at
 */
function blockEnd(lines, at) {
  const own = indentOf(lines[at])
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!isNoise(lines[i]) && indentOf(lines[i]) <= own) return i
  }
  return lines.length
}

/** @param {string[]} lines @param {number} from @param {number} to */
function firstContent(lines, from, to) {
  for (let i = from; i < to; i += 1) if (!isNoise(lines[i])) return i
  return -1
}

/**
 * The keys of a mapping whose entries sit at the indentation of its first entry.
 * @param {string[]} lines the mapping's lines, header excluded
 * @returns {Map<string, { at: number, value: string }>}
 */
function keysOf(lines) {
  const keys = new Map()
  const first = firstContent(lines, 0, lines.length)
  if (first === -1) return keys
  const indent = indentOf(lines[first])
  for (const [at, line] of lines.entries()) {
    if (isNoise(line) || indentOf(line) !== indent) continue
    const m = KEY.exec(line.trim())
    if (m && !keys.has(m[1])) keys.set(m[1], { at, value: m[2] })
  }
  return keys
}

/**
 * A key's value with its continuation: the inline text plus every deeper line under it,
 * trailing comments removed (`runs-on: ubuntu-latest # not self-hosted` names no label).
 * @param {string[]} lines @param {{ at: number, value: string }} entry
 */
function valueText(lines, entry) {
  return [
    entry.value,
    ...lines.slice(entry.at + 1, blockEnd(lines, entry.at)).filter((l) => !isNoise(l)),
  ]
    .map((l) => l.replace(/\s+#.*$/, ''))
    .join('\n')
}

/** @param {string} text */
const toLines = (text) => text.replace(/\r\n?/g, '\n').split('\n')

/**
 * @typedef {{ id: string, line: number, lines: string[] }} WorkflowJob
 *   `line` is 1-based; `lines` starts at the job's own heading.
 */

/**
 * The jobs of one workflow, or null when it has no top-level `jobs:` block this reading can
 * see (a flow mapping such as `jobs: {}` included). A line at the job indentation that is
 * not a job id, or a line left of it, is a problem, and the job it would have opened is not
 * judged, so the caller must report `problems`.
 * @param {string} text
 * @returns {{ jobs: WorkflowJob[], problems: string[] } | null}
 */
export function jobsOf(text) {
  const lines = toLines(text)
  const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l))
  if (at === -1) return null
  const end = blockEnd(lines, at)
  const first = firstContent(lines, at + 1, end)
  /** @type {WorkflowJob[]} */
  const jobs = []
  const problems = []
  if (first === -1) return { jobs, problems }
  const jobIndent = indentOf(lines[first])
  /** @type {WorkflowJob | null} */
  let current = null
  for (let i = first; i < end; i += 1) {
    const line = lines[i]
    if (isNoise(line) || indentOf(line) > jobIndent) {
      current?.lines.push(line)
      continue
    }
    const m = indentOf(line) === jobIndent ? JOB_ID.exec(line.trim()) : null
    current = m ? { id: m[2], line: i + 1, lines: [line] } : null
    if (current) jobs.push(current)
    else
      problems.push(
        `line ${String(i + 1)} under \`jobs:\` is not a job id this check can read (${line.trim()})`,
      )
  }
  return { jobs, problems }
}

// ── the shell rule ─────────────────────────────────────────────────────────────────────

/**
 * The shell the top-level `defaults:` block at `at` selects for `run:`, as written; null
 * when it selects none this reading can see.
 * @param {string[]} lines @param {number} at @returns {string | null}
 */
function defaultShell(lines, at) {
  const block = lines.slice(at + 1, blockEnd(lines, at))
  const run = keysOf(block).get('run')
  if (!run || scalar(run.value) !== '') return null
  const shell = keysOf(block.slice(run.at + 1, blockEnd(block, run.at))).get('shell')
  return shell === undefined ? null : scalar(shell.value)
}

/**
 * The shell rule, for one workflow. OpenSSF Scorecard refuses to PUBLISH results from a
 * workflow that carries a top-level `defaults` or `env`, so that one workflow must not
 * carry the default; a workflow with no `run:` step has nothing for a default to govern.
 * @param {string} file @param {string[]} lines @returns {string[]}
 */
function shellFindings(file, lines) {
  const text = lines.join('\n')
  if (/publish_results:\s*true/.test(text)) {
    return /^(defaults|env):/m.test(text)
      ? [
          `${file}: publishes Scorecard results and carries a top-level defaults/env block — Scorecard's verifier rejects that workflow`,
        ]
      : []
  }
  if (!/^\s+(-\s+)?run:/m.test(text)) return []
  const at = lines.findIndex((l) => /^defaults:\s*(#.*)?$/.test(l))
  const shell = at === -1 ? null : defaultShell(lines, at)
  if (shell === null) {
    return [
      `${file}: no workflow-level \`defaults.run.shell: bash\` — an un-shelled step runs without pipefail, so \`producer | tee\` reports tee's status`,
    ]
  }
  if (shell !== 'bash') {
    // A custom command runs exactly as written; only the plain `bash` gets GitHub's
    // `--noprofile --norc -eo pipefail`. One spelling keeps the rule a string comparison.
    return [
      `${file}: the workflow-level \`defaults.run.shell\` is \`${shell}\`, not \`bash\` — only \`shell: bash\` runs as \`bash --noprofile --norc -eo pipefail {0}\`; write it that way`,
    ]
  }
  const jobsAt = lines.findIndex((l) => /^jobs:/.test(l))
  return jobsAt !== -1 && at > jobsAt
    ? [
        `${file}: \`defaults:\` sits BELOW \`jobs:\` — the line-parsers would read its \`run:\` key as a job id`,
      ]
    : []
}

// ── the clock rule ─────────────────────────────────────────────────────────────────────

/**
 * The clock rule, for one job.
 * @param {string} where `<file>#<job>`
 * @param {{ keys: Map<string, { at: number, value: string }>, selfHosted: boolean }} job
 * @param {{ maxMinutes: number, selfHostedMaxMinutes?: number }} limits
 * @returns {string[]}
 */
function clockFindings(where, job, limits) {
  const timeout = job.keys.get('timeout-minutes')
  if (job.keys.has('uses'))
    return timeout ? [`${where}: a reusable-workflow job cannot take timeout-minutes`] : []
  if (!timeout)
    return [`${where}: no job-level timeout-minutes — a hang costs GitHub's 360-minute default`]
  const raw = scalar(timeout.value)
  if (!/^\d+$/.test(raw)) {
    return [
      `${where}: timeout-minutes \`${raw}\` is not a whole number of minutes — the check cannot read it, and it never passes what it cannot read`,
    ]
  }
  const max = job.selfHosted
    ? (limits.selfHostedMaxMinutes ?? limits.maxMinutes)
    : limits.maxMinutes
  const minutes = Number(raw)
  return minutes < 1 || minutes > max
    ? [`${where}: timeout-minutes ${raw} is outside 1..${String(max)}`]
    : []
}

// ── the sensor rule ────────────────────────────────────────────────────────────────────

/**
 * The first step of a `steps:` list: its lines, from its dash to the next step. Null when
 * the list is not a block sequence this reading can see (`steps: []`, a missing key).
 * @param {string[]} lines the job's lines @param {{ at: number, value: string } | undefined} steps
 * @returns {string[] | null}
 */
function firstStep(lines, steps) {
  if (!steps || scalar(steps.value) !== '') return null
  const dash = firstContent(lines, steps.at + 1, lines.length)
  if (dash === -1 || !lines[dash].trimStart().startsWith('- ')) return null
  if (indentOf(lines[dash]) < indentOf(lines[steps.at])) return null
  const out = [lines[dash]]
  for (const line of lines.slice(dash + 1)) {
    if (!isNoise(line) && indentOf(line) <= indentOf(lines[dash])) break
    out.push(line)
  }
  return out
}

/**
 * What a step uses (`- uses:` on its dash line, or `uses:` among its keys), else null.
 * @param {string[]} step
 */
function stepUses(step) {
  const lines = [step[0].replace(/^(\s*)- /, '$1  '), ...step.slice(1)]
  const uses = keysOf(lines).get('uses')
  return uses ? scalar(uses.value) : null
}

/**
 * Whether the runner is Windows, and where that was read: the `runs-on` value, or a value
 * of a matrix key `runs-on` reads (`${{ matrix.<key> }}`), inline, as a block list under the
 * key, or in an `include:` entry.
 * @param {string[]} lines the job's lines @param {Map<string, { at: number, value: string }>} keys
 * @returns {string | null}
 */
function windowsSource(lines, keys) {
  const runsOn = keys.get('runs-on')
  if (!runsOn) return null
  const text = valueText(lines, runsOn)
  if (/windows/i.test(text)) return `runs-on: ${scalar(text.replace(/\n\s*/g, ' '))}`
  const strategy = keys.get('strategy')
  if (!strategy) return null
  const block = lines.slice(strategy.at + 1, blockEnd(lines, strategy.at))
  for (const [, key] of text.matchAll(/matrix\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    const hit = matrixValues(block, key).find((v) => /windows/i.test(v))
    if (hit) return `matrix.${key}: ${hit}`
  }
  return null
}

/**
 * Every value a matrix key takes inside a strategy block.
 * @param {string[]} block @param {string} key @returns {string[]}
 */
function matrixValues(block, key) {
  const out = []
  const re = new RegExp(`^(\\s*(?:-\\s+)?)${key}:(.*)$`)
  for (const [at, line] of block.entries()) {
    const m = isNoise(line) ? null : re.exec(line)
    if (!m) continue
    const inline = scalar(m[2]).replace(/^\[|\]$/g, '')
    out.push(
      ...inline
        .split(',')
        .map((v) => scalar(v))
        .filter((v) => v !== ''),
    )
    for (const next of block.slice(at + 1)) {
      if (isNoise(next)) continue
      if (indentOf(next) <= m[1].length) break
      out.push(scalar(next.trim().replace(/^-\s+/, '')))
    }
  }
  return out
}

/**
 * The sensor rule, for one job that runs steps on a GitHub-hosted runner.
 * @param {string} where @param {string[]} lines @param {Map<string, { at: number, value: string }>} keys
 * @returns {string[]}
 */
function sensorFindings(where, lines, keys) {
  const step = firstStep(lines, keys.get('steps'))
  if (step === null)
    return [`${where}: no steps: list this check can read — a job it cannot read is never a pass`]
  const uses = stepUses(step)
  if (uses === null || !uses.startsWith(HARDEN_RUNNER)) {
    const what = uses === null ? 'is a run: step' : `uses ${uses}`
    return [
      `${where}: the first step ${what}, not step-security/harden-runner — every step before it runs with no egress sensor; make harden-runner the first step (egress-policy: audit on windows-*)`,
    ]
  }
  const windows = windowsSource(lines, keys)
  const audits = step.some(
    (l) =>
      !isNoise(l) &&
      /^\s*egress-policy:/.test(l) &&
      scalar(l.replace(/^\s*egress-policy:/, '')) === 'audit',
  )
  return windows && !audits
    ? [
        `${where}: runs on Windows (${windows}) and its harden-runner step does not set egress-policy: audit — blocking is Linux-only, so the step must audit`,
      ]
    : []
}

// ── one workflow ───────────────────────────────────────────────────────────────────────

/**
 * The rules for one job.
 * @param {string} file @param {WorkflowJob} job @param {{ maxMinutes: number, selfHostedMaxMinutes?: number }} limits
 * @returns {string[]}
 */
function jobFindings(file, job, limits) {
  const where = `${file}#${job.id}`
  const lines = job.lines.slice(1)
  const keys = keysOf(lines)
  const runsOn = keys.get('runs-on')
  const selfHosted = runsOn !== undefined && /\bself-hosted\b/.test(valueText(lines, runsOn))
  const clock = clockFindings(where, { keys, selfHosted }, limits)
  if (keys.has('uses') || selfHosted) return clock
  return [...clock, ...sensorFindings(where, lines, keys)]
}

/**
 * Everything wrong with one workflow, as sentences naming `<file>` or `<file>#<job>`.
 * @param {{ file: string, text: string }} workflow
 * @param {{ maxMinutes: number, selfHostedMaxMinutes?: number }} limits the ceiling bound:
 *   the factory passes its 240-minute bar, the gate PLATFORM_LIMITS
 * @returns {string[]}
 */
export function workflowFindings({ file, text }, limits) {
  const lines = toLines(text)
  const parsed = jobsOf(text)
  if (parsed === null) {
    return [
      ...shellFindings(file, lines),
      `${file}: no top-level \`jobs:\` block this check can read — a workflow it cannot read is never a pass`,
    ]
  }
  const { jobs, problems } = parsed
  const empty =
    jobs.length === 0 && problems.length === 0
      ? [`${file}: the \`jobs:\` block yields no job — a workflow it cannot read is never a pass`]
      : []
  return [
    ...shellFindings(file, lines),
    ...problems.map((p) => `${file}: ${p}`),
    ...empty,
    ...jobs.flatMap((job) => jobFindings(file, job, limits)),
  ]
}
