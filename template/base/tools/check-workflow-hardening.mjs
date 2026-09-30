#!/usr/bin/env node
// CI-only gate: workflow-hardening — this project's own workflows meet the house rules the
// harness's shipped ones meet (1.1.0). NOT a chain step: it runs in actions-lint.yml's
// `workflow-hardening` job, on a pull request or push that touches a workflow, this script,
// its library or .harness/manifest.json. `node tools/check-workflow-hardening.mjs` runs it
// anywhere; it needs Node and nothing installed.
//
// Every `.github/workflows/*.yml` and `*.yaml` is judged by the pure rules in
// tools/lib/workflow-hardening.mjs, under the platform's bound (PLATFORM_LIMITS):
//   1. a workflow-level `defaults.run.shell: bash`, above `jobs:` (not in the one workflow
//      that publishes OpenSSF Scorecard results, whose verifier rejects it);
//   2. a literal `timeout-minutes` on every job that can take one, from 1 to 360 on a
//      GitHub-hosted runner and to 7200 on a self-hosted one; none on a reusable-workflow call;
//   3. step-security/harden-runner as the FIRST step of every job that is neither a
//      reusable-workflow call nor self-hosted, with `egress-policy: audit` when its runner,
//      or a matrix value it reads, names windows.
// It replaces nothing: `harden-runner-coverage` beside it still counts harden-runner lines
// per file, with its verdict unchanged; this gate checks position.
//
// Input it cannot read is a finding, never a pass: no workflow directory, no workflow in it,
// a file it cannot read, a workflow with no `jobs:` block or no job in it, a line under
// `jobs:` that is not a job id, a job with no readable `steps:` list, a ceiling that is not a
// whole number.
//
// RAMPED. The rules are new for a project's own workflows, so an install whose baseVersion
// predates 1.1.0 gets its findings as NOTEs, with the deadline, until 1.2.0; a fresh 1.1.0
// scaffold is held to them at once. Every workflow the harness ships passes them in every
// tier (tests/gates/check-workflow-hardening.test.mjs), so a NOTE is about a workflow the
// project wrote or edited.
// SOURCE: docs/harness/gates-catalog.md (CI-only lanes, workflow-hardening)
import { readdirSync, readFileSync } from 'node:fs'
import { failures, ok, rampNote } from './lib/gate.mjs'
import { jobsOf, PLATFORM_LIMITS, workflowFindings } from './lib/workflow-hardening.mjs'

const GATE = 'workflow-hardening'
const DIR = '.github/workflows'

/** @type {string[]} */
const errs = []
/** @type {string[]} */
let files = []
try {
  files = readdirSync(DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
} catch {
  errs.push(
    `${DIR}: no workflow directory — the check has nothing to judge, and it never passes what it cannot see`,
  )
}
if (errs.length === 0 && files.length === 0) {
  errs.push(
    `${DIR}: no *.yml or *.yaml workflow — the check has nothing to judge, and it never passes what it cannot see`,
  )
}

let jobCount = 0
for (const name of files) {
  const file = `${DIR}/${name}`
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    errs.push(`${file}: cannot be read — a workflow the check cannot read is never a pass`)
    continue
  }
  jobCount += jobsOf(text)?.jobs.length ?? 0
  errs.push(...workflowFindings({ file, text }, PLATFORM_LIMITS))
}

if (errs.length > 0) {
  const ramped = rampNote(
    GATE,
    '1.1.0',
    'the workflow hardening rules over the project workflows (a workflow-level bash default, a ceiling on every job, harden-runner as the first step)',
    { until: '1.2.0' },
  )
  if (ramped) {
    for (const e of errs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
    ok(
      GATE,
      `NOTE-only on this pre-1.1.0 install — ${String(errs.length)} finding(s) above, with the deadline`,
    )
  }
}

failures(
  GATE,
  errs,
  'Each finding names <file> or <file>#<job>. The fixes: a top-level `defaults:` block whose `run:` sets `shell: bash`, above `jobs:`; a whole-number `timeout-minutes` on the job; step-security/harden-runner, pinned by SHA, as its first step, with `egress-policy: audit` on Windows. Every workflow the harness ships has all three to copy.',
)
ok(
  GATE,
  `${String(files.length)} workflow(s), ${String(jobCount)} job(s): a workflow-level bash default, a ceiling on every job, harden-runner first`,
)
