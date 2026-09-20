// A SHIPPED WORKFLOW CANNOT SWALLOW A FAILED STEP OR HANG (1.0.2).
//
// Two properties of every workflow this harness ships or runs, and both are about a lane
// that reports something other than what happened.
//
// THE SHELL. GitHub runs a step that names no shell as `bash -e {0}` — no `pipefail` — and
// a step under `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`. So an un-shelled
// `producer | tee file` takes `tee`'s exit status, and the producer's failure is gone. That
// is exactly what `gate-summary` was: the one check an enterprise is told to mark required,
// whose verdict script exits 1 on a failed lane, piped into `tee` with no shell named. The
// required check could not go red. A workflow-level `defaults.run.shell: bash` closes the
// class rather than the instance.
//
// THE CLOCK. A job with no `timeout-minutes` inherits GitHub's 360. A hung step is six
// hours of runner before anything reports, and a cancelled job is one `summarize-gate`
// already reads as a failure — so a ceiling fails closed.
//
// YAML-shaped, never YAML-parsed, like every other workflow check here (no parser
// dependency; the same two-space job-heading regex the canary closure uses). Which is also
// why PLACEMENT is asserted: four line-parsers slice from `\njobs:` and read a two-space key
// after it as a job id, so a `defaults:` block below `jobs:` would hand them a job named `run`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderEntry, walkTemplate } from '../../installer/lib/copy.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TEMPLATE_BASE = join(REPO, 'template', 'base')

// The SHIPPED set is base AND every module — the structural checks before this one scanned
// base only, which left the module workflows outside every closure. Rendered, because that
// is what a consumer's runner executes.
function shippedWorkflows() {
  const trees = [
    'base',
    ...readdirSync(join(REPO, 'template', 'modules'))
      .sort()
      .map((m) => `modules/${m}`),
  ]
  return trees
    .flatMap((tree) => walkTemplate(tree))
    .filter((e) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.installPath))
    .map((e) => ({ file: e.installPath, text: String(renderEntry(e, { DEFAULT_BRANCH: 'main' })) }))
}

function factoryWorkflows() {
  const dir = join(REPO, '.github', 'workflows')
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(dir, f), 'utf8') }))
}

/** @param {string} text @returns {Array<{ id: string, body: string }>} */
function jobsOf(text) {
  const at = text.indexOf('\njobs:')
  if (at === -1) return []
  const region = text.slice(at)
  const heads = [...region.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
  return heads.map((m, i) => ({ id: m[1], body: region.slice(m.index, heads[i + 1]?.index ?? region.length) }))
}

const DEFAULTS_RE = /^defaults:\n {2}run:\n {4}shell: bash\n/m
const MAX_TIMEOUT = 240

/** The shell rule. @param {{ file: string, text: string }} workflow @returns {string[]} */
function shellProblems({ file, text }) {
  // OpenSSF Scorecard refuses to PUBLISH results from a workflow that carries top-level
  // `defaults` or `env` — the one workflow where the shell default must NOT be added.
  if (/publish_results:\s*true/.test(text)) {
    return /^(defaults|env):/m.test(text)
      ? [`${file}: publishes Scorecard results and carries a top-level defaults/env block — Scorecard's verifier rejects that workflow`]
      : []
  }
  if (!/^\s+(- )?run:/m.test(text)) return [] // no run: step — nothing for a shell default to govern
  const at = text.search(DEFAULTS_RE)
  if (at === -1) return [`${file}: no workflow-level \`defaults.run.shell: bash\` — an un-shelled step runs without pipefail`]
  return at > text.indexOf('\njobs:')
    ? [`${file}: \`defaults:\` sits BELOW \`jobs:\` — the line-parsers would read its \`run:\` key as a job id`]
    : []
}

/** The clock rule, for one job. @param {string} file @param {{ id: string, body: string }} job @returns {string[]} */
function clockProblems(file, job) {
  const reusable = /^ {4}uses:\s*\S/m.test(job.body)
  const timeout = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(job.body)
  if (reusable) return timeout ? [`${file}#${job.id}: a reusable-workflow job cannot take timeout-minutes`] : []
  if (timeout === null) return [`${file}#${job.id}: no job-level timeout-minutes — a hang costs GitHub's 360-minute default`]
  const minutes = Number(timeout[1])
  return minutes < 1 || minutes > MAX_TIMEOUT
    ? [`${file}#${job.id}: timeout-minutes ${timeout[1]} is outside 1..${String(MAX_TIMEOUT)}`]
    : []
}

/**
 * Everything wrong with one workflow, as sentences. Pure, so the synthetic negatives below
 * can show each rule going red.
 *
 * @param {{ file: string, text: string }} workflow @returns {string[]}
 */
function hardeningProblems(workflow) {
  return [...shellProblems(workflow), ...jobsOf(workflow.text).flatMap((job) => clockProblems(workflow.file, job))]
}

test('the walk is not vacuous: base AND module workflows, no shared install path, plus the factory set', () => {
  const shipped = shippedWorkflows()
  assert.ok(shipped.length >= 19, `only ${String(shipped.length)} shipped workflow(s) found`)
  assert.equal(new Set(shipped.map((w) => w.file)).size, shipped.length, 'two trees install the same workflow path')
  // `${{ … }}` is GitHub's expression syntax; residue is an UPPER_SNAKE harness token.
  assert.ok(shipped.every((w) => !/\{\{[A-Z0-9_]+\}\}/.test(w.text)), 'a workflow rendered with residue')
  assert.ok(factoryWorkflows().length >= 6)
  assert.ok(shipped.reduce((n, w) => n + jobsOf(w.text).length, 0) >= 48)
})

test('every SHIPPED workflow selects bash at workflow level and bounds every job it can', () => {
  assert.deepEqual(shippedWorkflows().flatMap(hardeningProblems), [])
})

test('every FACTORY workflow does too — and the Scorecard workflow carries no top-level defaults or env', () => {
  assert.deepEqual(factoryWorkflows().flatMap(hardeningProblems), [])
  const scorecard = factoryWorkflows().find((w) => w.file.endsWith('scorecard.yml'))
  assert.ok(scorecard && /publish_results:\s*true/.test(scorecard.text), 'fixture precondition: scorecard.yml publishes')
})

test('each rule can go red: the synthetic negatives', () => {
  const job = (extra) => `\njobs:\n  lint:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: echo hi\n`
  const good = `name: x\ndefaults:\n  run:\n    shell: bash\n${job('    timeout-minutes: 10\n')}`
  assert.deepEqual(hardeningProblems({ file: 'good.yml', text: good }), [])

  const noDefault = `name: x\n${job('    timeout-minutes: 10\n')}`
  assert.match(hardeningProblems({ file: 'a.yml', text: noDefault })[0], /no workflow-level `defaults\.run\.shell: bash`/)

  const jobLevelOnly = `name: x\n${job('    defaults:\n      run:\n        shell: bash\n    timeout-minutes: 10\n')}`
  assert.match(hardeningProblems({ file: 'b.yml', text: jobLevelOnly })[0], /no workflow-level/)

  const below = `name: x\n${job('    timeout-minutes: 10\n')}defaults:\n  run:\n    shell: bash\n`
  assert.match(hardeningProblems({ file: 'c.yml', text: below })[0], /sits BELOW `jobs:`/)

  const untimed = `name: x\ndefaults:\n  run:\n    shell: bash\n${job('')}`
  assert.match(hardeningProblems({ file: 'd.yml', text: untimed })[0], /d\.yml#lint: no job-level timeout-minutes/)

  const stepLevel = `name: x\ndefaults:\n  run:\n    shell: bash\n\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        timeout-minutes: 5\n`
  assert.match(hardeningProblems({ file: 'e.yml', text: stepLevel })[0], /no job-level timeout-minutes/)

  const sixHours = `name: x\ndefaults:\n  run:\n    shell: bash\n${job('    timeout-minutes: 360\n')}`
  assert.match(hardeningProblems({ file: 'f.yml', text: sixHours })[0], /360 is outside/)

  const reusableTimed = 'name: x\n\njobs:\n  scan:\n    uses: org/repo/.github/workflows/w.yml@0123456789012345678901234567890123456789\n    timeout-minutes: 10\n'
  assert.match(hardeningProblems({ file: 'g.yml', text: reusableTimed })[0], /reusable-workflow job cannot take/)

  const publishing = `name: x\ndefaults:\n  run:\n    shell: bash\n${job('    timeout-minutes: 10\n')}          publish_results: true\n`
  assert.match(hardeningProblems({ file: 'h.yml', text: publishing })[0], /Scorecard's verifier rejects/)
})

// ── behavioural canaries ────────────────────────────────────────────────────────────────
// The structural rules say the shell is selected. These say it MATTERS: the step's real
// script, run the way GitHub would run it, fails when the thing it wraps fails.

const HAS_BASH = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const SKIP = 'needs a POSIX bash: the shipped set runs on ubuntu runners, and this leg has none'

/**
 * One step of a rendered workflow: its script, and the argv GitHub would run it with —
 * the step's own `shell:`, else the workflow default, else GitHub's un-shelled `bash -e`.
 *
 * @param {string} text @param {string} stepName
 */
function stepOf(text, stepName) {
  const at = text.indexOf(`- name: ${stepName}`)
  assert.notEqual(at, -1, `step not found: ${stepName}`)
  const next = text.indexOf('\n      - ', at + 1)
  const block = text.slice(at, next === -1 ? text.length : next)
  const inline = /^ {8}run: (?![|>])(.+)$/m.exec(block)
  const folded = /^ {8}run: \|\n((?: {10}.*\n?|\n)+)/m.exec(block)
  const script = inline ? inline[1] : (folded?.[1] ?? '').replace(/^ {10}/gm, '')
  assert.ok(script.trim() !== '', `no run: script under ${stepName}`)
  const shelled = /^ {8}shell: bash$/m.test(block) || DEFAULTS_RE.test(text)
  return { script, argv: shelled ? ['--noprofile', '--norc', '-eo', 'pipefail'] : ['-e'] }
}

/** @param {string} script @param {string[]} argv @param {{ cwd: string, env?: Record<string, string> }} opts */
function runAsGitHub(script, argv, { cwd, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-step-'))
  const file = join(dir, 'step.sh')
  writeFileSync(file, script)
  const res = spawnSync('bash', [...argv, file], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, dir }
}

const qualityGate = () => shippedWorkflows().find((w) => w.file.endsWith('quality-gate.yml'))?.text ?? ''

test('CANARY: gate-summary goes RED when its summarizer does — and passed under the un-shelled default', (t) => {
  if (!HAS_BASH) return t.skip(SKIP)
  const { script, argv } = stepOf(qualityGate(), 'Summarize every lane (a skip is recorded, never a pass)')
  const summary = join(mkdtempSync(join(tmpdir(), 'nsah-summary-')), 'summary.md')
  const env = { NEEDS_JSON: JSON.stringify({ static: { result: 'failure', outputs: {} } }), GITHUB_STEP_SUMMARY: summary }

  const selected = runAsGitHub(script, argv, { cwd: TEMPLATE_BASE, env })
  assert.equal(selected.code, 1, `the required check must fail when a lane failed:\n${selected.out}`)
  assert.match(readFileSync(summary, 'utf8'), /static/, 'the FAIL list reaches the step summary it is teed into')

  // THE DEFECT, kept as the control: the identical script under GitHub's un-shelled default
  // exits 0, because the pipeline's status is `tee`'s. If this ever stops being true the
  // canary above proves nothing about the shell.
  const unshelled = runAsGitHub(script, ['-e'], { cwd: TEMPLATE_BASE, env })
  assert.equal(unshelled.code, 0, unshelled.out)
})

test('CANARY: the mutation scoper\'s fail-closed exit reaches the step — a command substitution inside `echo` discarded it', (t) => {
  if (!HAS_BASH) return t.skip(SKIP)
  const { script, argv } = stepOf(qualityGate(), 'Which critical files does this change touch?')
  const cwd = mkdtempSync(join(tmpdir(), 'nsah-scope-'))
  mkdirSync(join(cwd, 'tools'), { recursive: true })
  writeFileSync(join(cwd, 'tools', 'mutation-scope.mjs'), "console.error('mutation-scope: FAIL — a root matched zero files')\nprocess.exit(1)\n")
  const res = runAsGitHub(script, argv, { cwd, env: { GITHUB_OUTPUT: join(cwd, 'out.txt') } })
  assert.notEqual(res.code, 0, `a scoper that failed closed must fail the step, not report "nothing to mutate":\n${res.out}`)
})

test('CANARY: the targetSdk floor step still SAYS why it failed when no targetSdkVersion is found', (t) => {
  if (!HAS_BASH) return t.skip(SKIP)
  const { script, argv } = stepOf(qualityGate(), 'targetSdk floor (the generated project vs tools/store-policy.json)')
  const cwd = mkdtempSync(join(tmpdir(), 'nsah-sdk-'))
  mkdirSync(join(cwd, 'tools'), { recursive: true })
  mkdirSync(join(cwd, 'apps', 'mobile', 'android'), { recursive: true })
  writeFileSync(join(cwd, 'tools', 'store-policy.json'), JSON.stringify({ androidTargetSdk: { floor: 35 } }))
  const res = runAsGitHub(script, argv, { cwd })
  assert.equal(res.code, 1, res.out)
  // Under pipefail a no-match `grep` kills an assignment before the diagnostic prints; the
  // step stays red either way, but a red that does not say why is a worse red.
  assert.match(res.out, /::error::generated android project targets SDK 'none'/, res.out)
})
