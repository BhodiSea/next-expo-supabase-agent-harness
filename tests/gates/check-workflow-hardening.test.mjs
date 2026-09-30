// A PROJECT'S OWN WORKFLOWS ARE HELD TO THE HOUSE RULES (1.1.0, #73).
//
// Since 1.0.2 every workflow the harness ships selects `shell: bash` at workflow level and
// gives every job a ceiling, and tests/gates/workflow-hardening.test.mjs holds that over the
// template and the factory. Nothing held it over a workflow a project writes. The one
// structural workflow check an install ran, actions-lint.yml's `harden-runner-coverage`
// loop, compares line COUNTS per file, so it passes every shape in
// tests/gates/helpers/workflow-hardening-cases.mjs (the factory test runs the loop over each
// of them as its control).
//
// This file is the can-fail proof of the `workflow-hardening` lane
// (tests/canary/injections.json#lanes) and of its ramp's expiry
// (scripts/ci/stop-side-expiries.json):
//   - the pure rules in template/base/tools/lib/workflow-hardening.mjs, one case per rule and
//     per shape the loop misses; they read text only, so the Windows leg runs every case;
//   - the CI-only gate template/base/tools/check-workflow-hardening.mjs, spawned on fixture
//     installs: exit 1 naming `<file>#<job>`, and the ramp opened at 1.1.0 until 1.2.0 —
//     a NOTE on a 1.0.3 install at harness 1.1.0, and RAMP EXPIRED naming "the workflow
//     hardening rules" at harness 1.2.0;
//   - the rendered core, standard and strict workflow sets and the factory's own workflows
//     produce no finding under the gate's bound;
//   - the job in actions-lint.yml that runs it, and the comments that name it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderEntry, walkTemplate } from '../../installer/lib/copy.mjs'
import { TIERS } from '../../installer/lib/layout.mjs'
import {
  jobsOf,
  PLATFORM_LIMITS,
  workflowFindings,
} from '../../template/base/tools/lib/workflow-hardening.mjs'
import { CHECKOUT, CLEAN, CLEAN_JOB, HARDEN, HEAD, ISSUE_FIXTURE, LOOP_MISSES } from './helpers/workflow-hardening-cases.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const GATE = join(REPO, 'template', 'base', 'tools', 'check-workflow-hardening.mjs')
const DETAIL = 'the workflow hardening rules'

/** @param {Record<string, string>} files @param {{ baseVersion: string, harnessVersion: string }} [manifest] */
function install(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-wfh-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  if (manifest) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'manifest.json'), JSON.stringify(manifest, null, 2))
  }
  return dir
}

/** @param {string} cwd */
function runGate(cwd) {
  const res = spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** @param {string} file @param {string} text */
const gateFindings = (file, text) => workflowFindings({ file, text }, PLATFORM_LIMITS)

// ── the failing-first case: the issue's fixture ─────────────────────────────────────────

test('RED (the issue fixture): the gate exits 1 and names .github/workflows/x.yml#b', () => {
  const res = runGate(install({ '.github/workflows/x.yml': ISSUE_FIXTURE }))
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /^workflow-hardening: FAIL/m, res.out)
  assert.match(res.out, /^ {2}- \.github\/workflows\/x\.yml#b: the first step is a run: step, not step-security\/harden-runner/m, res.out)
  // Job `a` carries harden-runner first (twice): the position rule has nothing to say about it.
  assert.doesNotMatch(res.out, /x\.yml#a: the first step/, res.out)
  assert.match(res.out, /^FIX\[workflow-hardening\]: reproduce with `node tools\/check-workflow-hardening\.mjs`/m, res.out)
})

// ── point 2 of the issue: every shape the counting loop passes ───────────────────────────

for (const c of LOOP_MISSES) {
  test(`RED: ${c.id} — the library and the gate name ${c.job}`, () => {
    const findings = Object.entries(c.files).flatMap(([file, text]) => gateFindings(file, text))
    assert.equal(findings.length, 1, findings.join('\n'))
    assert.match(findings[0], c.finding)
    assert.ok(findings[0].startsWith(`${c.job}: `), findings[0])

    const res = runGate(install(c.files))
    assert.equal(res.code, 1, res.out)
    assert.ok(res.out.includes(`  - ${findings[0]}`), res.out)
  })
}

// ── the rules, one at a time ────────────────────────────────────────────────────────────

test('GREEN: the clean shape — bash default above jobs:, a ceiling, harden-runner first', () => {
  assert.deepEqual(gateFindings('.github/workflows/ok.yml', CLEAN), [])
  // `- name:` then `uses:` on the next line, `- uses:` on the dash line, quoted or not.
  const inline = CLEAN.replace(/- name: Harden runner \(egress audit\)\n {8}uses:/, '- uses:')
  assert.notEqual(inline, CLEAN)
  assert.deepEqual(gateFindings('.github/workflows/ok.yml', inline), [])
  const quoted = CLEAN.replace(`uses: ${HARDEN} # v2.20.0`, `uses: '${HARDEN}' # v2.20.0`)
  assert.notEqual(quoted, CLEAN)
  assert.deepEqual(gateFindings('.github/workflows/ok.yml', quoted), [])
})

test('the shell rule: no bash default, a job-level one only, one below jobs:, a Scorecard workflow', () => {
  const noDefault = CLEAN.replace('defaults:\n  run:\n    shell: bash\n', '')
  assert.match(gateFindings('a.yml', noDefault)[0], /^a\.yml: no workflow-level `defaults\.run\.shell: bash`/)
  const pwsh = CLEAN.replace('shell: bash', 'shell: pwsh')
  assert.match(gateFindings('b.yml', pwsh)[0], /^b\.yml: no workflow-level `defaults\.run\.shell: bash`/)
  const below = `${noDefault}defaults:\n  run:\n    shell: bash\n`
  assert.match(gateFindings('c.yml', below)[0], /^c\.yml: `defaults:` sits BELOW `jobs:`/)
  // No run: step at all: nothing for a shell default to govern.
  const usesOnly = `on: push\njobs:\n${CLEAN_JOB.replace('      - run: echo hi | tee out.txt\n', '')}`
  assert.deepEqual(gateFindings('d.yml', usesOnly), [])
  const publishing = `${CLEAN}          publish_results: true\n`
  assert.match(gateFindings('e.yml', publishing)[0], /^e\.yml: publishes Scorecard results and carries a top-level defaults\/env block/)
  assert.deepEqual(gateFindings('f.yml', publishing.replace('defaults:\n  run:\n    shell: bash\n', '')), [])
  // A comment is not a default.
  const commented = CLEAN.replace('defaults:\n  run:\n    shell: bash\n', '# defaults:\n#   run:\n#     shell: bash\n')
  assert.match(gateFindings('g.yml', commented)[0], /no workflow-level/)
})

test('the clock rule: no ceiling, a step-level one, the platform bound, an expression, a reusable call', () => {
  const untimed = CLEAN.replace('    timeout-minutes: 10\n', '')
  assert.match(gateFindings('a.yml', untimed)[0], /^a\.yml#build: no job-level timeout-minutes — a hang costs GitHub's 360-minute default/)
  const stepLevel = untimed.replace('      - run: echo hi | tee out.txt\n', '      - run: echo hi | tee out.txt\n        timeout-minutes: 5\n')
  assert.match(gateFindings('b.yml', stepLevel)[0], /^b\.yml#build: no job-level timeout-minutes/)
  // The gate's bound is the platform's: 360 minutes on a GitHub-hosted runner…
  assert.deepEqual(gateFindings('c.yml', CLEAN.replace('timeout-minutes: 10', 'timeout-minutes: 360')), [])
  assert.match(gateFindings('d.yml', CLEAN.replace('timeout-minutes: 10', 'timeout-minutes: 361'))[0], /^d\.yml#build: timeout-minutes 361 is outside 1\.\.360/)
  assert.match(gateFindings('e.yml', CLEAN.replace('timeout-minutes: 10', 'timeout-minutes: 0'))[0], /timeout-minutes 0 is outside 1\.\.360/)
  // …and five days on a self-hosted one.
  const selfHosted = CLEAN.replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, linux]')
  assert.deepEqual(gateFindings('f.yml', selfHosted.replace('timeout-minutes: 10', 'timeout-minutes: 7200')), [])
  assert.match(gateFindings('g.yml', selfHosted.replace('timeout-minutes: 10', 'timeout-minutes: 7201'))[0], /^g\.yml#build: timeout-minutes 7201 is outside 1\.\.7200/)
  // A value the check cannot read is a finding, never a pass.
  const expr = CLEAN.replace('timeout-minutes: 10', 'timeout-minutes: ${{ inputs.minutes }}')
  assert.match(gateFindings('h.yml', expr)[0], /^h\.yml#build: timeout-minutes `\$\{\{ inputs\.minutes \}\}` is not a whole number of minutes/)
  assert.deepEqual(gateFindings('i.yml', CLEAN.replace('timeout-minutes: 10', 'timeout-minutes: 10 # the lane takes 2')), [])
  // A reusable-workflow call takes no ceiling and has no steps of its own.
  const reusable = `${HEAD}  scan:\n    uses: org/repo/.github/workflows/w.yml@${'0'.repeat(40)}\n`
  assert.deepEqual(gateFindings('j.yml', reusable), [])
  assert.match(gateFindings('k.yml', reusable.replace('\n  scan:\n', '\n  scan:\n    timeout-minutes: 10\n'))[0], /^k\.yml#scan: a reusable-workflow job cannot take timeout-minutes/)
  // The factory keeps its own, tighter bar.
  assert.match(workflowFindings({ file: 'l.yml', text: CLEAN.replace('timeout-minutes: 10', 'timeout-minutes: 241') }, { maxMinutes: 240 })[0], /241 is outside 1\.\.240/)
})

test('the position rule: exempt only a reusable call and a self-hosted job; unreadable steps are a finding', () => {
  const bare = CLEAN_JOB.replace(/ {6}- name: Harden runner[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, '')
  assert.notEqual(bare, CLEAN_JOB)
  assert.match(gateFindings('a.yml', `${HEAD}${bare}`)[0], /^a\.yml#build: the first step uses actions\/checkout@0{40}, not step-security\/harden-runner/)
  for (const runsOn of ['self-hosted', '[self-hosted, linux]', "['self-hosted', 'x64']", '\n      - self-hosted\n      - linux']) {
    const text = `${HEAD}${bare.replace(' ubuntu-latest', ` ${runsOn}`.replace(' \n', '\n'))}`
    assert.deepEqual(gateFindings('b.yml', text), [], `runs-on: ${runsOn}`)
  }
  const noSteps = `${HEAD}  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n`
  assert.match(gateFindings('c.yml', noSteps)[0], /^c\.yml#build: no steps: list this check can read/)
  const flowSteps = `${HEAD}  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps: []\n`
  assert.match(gateFindings('d.yml', flowSteps)[0], /^d\.yml#build: no steps: list this check can read/)
  // An indentless sequence (the dash at the key's own column) is valid YAML and is read.
  const indentless = CLEAN.replace(/\n {6}- /g, '\n    - ').replace(/\n {8}(uses|with):/g, '\n      $1:').replace('\n          egress-policy', '\n        egress-policy')
  assert.deepEqual(gateFindings('e.yml', indentless), [])
})

test('the windows rule: audit on a windows label or a windows matrix value, quoted or not', () => {
  const win = CLEAN.replace('runs-on: ubuntu-latest', 'runs-on: windows-2022')
  assert.deepEqual(gateFindings('a.yml', win), [])
  assert.deepEqual(gateFindings('b.yml', win.replace('egress-policy: audit', "egress-policy: 'audit'")), [])
  const noWith = win.replace('        with:\n          egress-policy: audit\n', '')
  assert.match(gateFindings('c.yml', noWith)[0], /^c\.yml#build: runs on Windows \(runs-on: windows-2022\)/)
  // A matrix `include:` entry names the runner.
  const include = CLEAN.replace('runs-on: ubuntu-latest', 'runs-on: ${{ matrix.runner }}').replace(
    '    steps:',
    '    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-latest\n          - runner: windows-latest\n    steps:',
  )
  assert.deepEqual(gateFindings('d.yml', include), [])
  assert.match(gateFindings('e.yml', include.replace('egress-policy: audit', 'egress-policy: block'))[0], /^e\.yml#build: runs on Windows \(matrix\.runner: windows-latest\)/)
  // A block list under the key, and a matrix with no windows value.
  const blockList = CLEAN.replace('runs-on: ubuntu-latest', 'runs-on: ${{ matrix.os }}').replace(
    '    steps:',
    '    strategy:\n      matrix:\n        os:\n          - ubuntu-latest\n          - windows-latest\n    steps:',
  )
  assert.match(gateFindings('f.yml', blockList.replace('          egress-policy: audit\n', '          disable-sudo: true\n'))[0], /^f\.yml#build: runs on Windows \(matrix\.os: windows-latest\)/)
  const linuxOnly = blockList.replace('windows-latest', 'ubuntu-24.04').replace('egress-policy: audit', 'egress-policy: block')
  assert.deepEqual(gateFindings('g.yml', linuxOnly), [])
})

test('input the check cannot read is a finding: no jobs:, a jobs: with no job, a key that is not a job id', () => {
  assert.match(gateFindings('a.yml', 'on: push\n')[0], /^a\.yml: no top-level `jobs:` block this check can read/)
  assert.match(gateFindings('b.yml', `${HEAD}`)[0], /^b\.yml: the `jobs:` block yields no job/)
  assert.match(gateFindings('c.yml', 'on: push\njobs: {}\n')[0], /^c\.yml: no top-level `jobs:` block this check can read/)
  const quotedKey = CLEAN.replace('  build:', '  "build it":')
  assert.match(gateFindings('d.yml', quotedKey)[0], /^d\.yml: line 6 under `jobs:` is not a job id this check can read \("build it":\)/)
  assert.equal(jobsOf('on: push\n'), null)
})

test('CRLF is normalised before any rule runs, and job ids take the platform alphabet', () => {
  assert.deepEqual(gateFindings('a.yml', CLEAN.replace(/\n/g, '\r\n')), [])
  const lateCrlf = LOOP_MISSES[1].files['.github/workflows/late.yml'].replace(/\n/g, '\r\n')
  assert.match(gateFindings('b.yml', lateCrlf)[0], /^b\.yml#build: the first step uses actions\/checkout@/)
  const ids = `${HEAD}${CLEAN_JOB.replace('  build:', '  Build_1:')}${CLEAN_JOB.replace('  build:', '  _private-2:')}`
  assert.deepEqual(jobsOf(ids)?.jobs.map((j) => j.id), ['Build_1', '_private-2'])
  assert.deepEqual(gateFindings('c.yml', ids), [])
  const unhardened = ids.replace(`      - name: Harden runner (egress audit)\n        uses: ${HARDEN} # v2.20.0\n        with:\n          egress-policy: audit\n      - uses: ${CHECKOUT}`, '      - run: echo first')
  assert.match(gateFindings('d.yml', unhardened)[0], /^d\.yml#Build_1: the first step is a run: step/)
})

// ── the gate ───────────────────────────────────────────────────────────────────────────

test('GREEN: a clean install exits 0 and says what it judged, .yaml included', () => {
  const res = runGate(install({ '.github/workflows/ok.yml': CLEAN, '.github/workflows/two.yaml': CLEAN }))
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /^workflow-hardening: OK — 2 workflow\(s\), 2 job\(s\): a workflow-level bash default, a ceiling on every job, harden-runner first/m, res.out)
})

test('RED: no workflow directory, an empty one, or a workflow it cannot read — never a pass', () => {
  const none = runGate(install({ 'README.md': 'x\n' }))
  assert.equal(none.code, 1, none.out)
  assert.match(none.out, /- \.github\/workflows: no workflow directory/, none.out)

  const emptyDir = install({ 'README.md': 'x\n' })
  mkdirSync(join(emptyDir, '.github', 'workflows'), { recursive: true })
  const empty = runGate(emptyDir)
  assert.equal(empty.code, 1, empty.out)
  assert.match(empty.out, /- \.github\/workflows: no \*\.yml or \*\.yaml workflow/, empty.out)

  const unreadable = install({ '.github/workflows/ok.yml': CLEAN })
  mkdirSync(join(unreadable, '.github', 'workflows', 'dir.yml'))
  const res = runGate(unreadable)
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /- \.github\/workflows\/dir\.yml: cannot be read/, res.out)
})

// ── the ramp: opened at 1.1.0, until 1.2.0 ───────────────────────────────────────────────

test('RAMP: a 1.1.0 install is held to the rules at once — exit 1', () => {
  const res = runGate(install({ '.github/workflows/x.yml': ISSUE_FIXTURE }, { baseVersion: '1.1.0', harnessVersion: '1.1.0' }))
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, /^workflow-hardening: FAIL/m, res.out)
  assert.doesNotMatch(res.out, /NOTE/, res.out)
})

test('RAMP: a 1.0.3 install at harness 1.1.0 gets dated NOTEs that expire in 1.2.0 — exit 0', () => {
  const res = runGate(install({ '.github/workflows/x.yml': ISSUE_FIXTURE }, { baseVersion: '1.0.3', harnessVersion: '1.1.0' }))
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, new RegExp(`^workflow-hardening: NOTE — ${DETAIL}[^\\n]*expires in 1\\.2\\.0`, 'm'), res.out)
  assert.match(res.out, /^workflow-hardening: NOTE — \(ramp\) \.github\/workflows\/x\.yml#b: the first step is a run: step/m, res.out)
  assert.doesNotMatch(res.out, /FAIL/, res.out)
})

test('RAMP EXPIRED: a 1.0.3 install at harness 1.2.0 is red, and the banner names the workflow hardening rules', () => {
  const res = runGate(install({ '.github/workflows/x.yml': ISSUE_FIXTURE }, { baseVersion: '1.0.3', harnessVersion: '1.2.0' }))
  assert.equal(res.code, 1, res.out)
  assert.match(res.out, new RegExp(`^workflow-hardening: RAMP EXPIRED — ${DETAIL}`, 'm'), res.out)
  assert.match(res.out, /^ {2}- \.github\/workflows\/x\.yml#b: the first step is a run: step/m, res.out)
})

// ── what ships: zero findings under the gate's bound ─────────────────────────────────────

/** @param {string[]} modules */
function renderedWorkflows(modules) {
  return ['base', ...modules.map((m) => `modules/${m}`)]
    .flatMap((tree) => walkTemplate(tree))
    .filter((e) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.installPath))
    .map((e) => ({ file: e.installPath, text: String(renderEntry(e, { DEFAULT_BRANCH: 'main' })) }))
}

for (const tier of /** @type {Array<keyof typeof TIERS>} */ (['core', 'standard', 'strict'])) {
  test(`GREEN: the rendered ${tier} workflow set passes the gate`, () => {
    const set = renderedWorkflows(TIERS[tier])
    assert.ok(set.length >= 9, `${tier}: ${String(set.length)} workflow(s)`)
    assert.deepEqual(set.flatMap((w) => workflowFindings(w, PLATFORM_LIMITS)), [])
    const res = runGate(install(Object.fromEntries(set.map((w) => [w.file, w.text]))))
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, new RegExp(`OK — ${String(set.length)} workflow\\(s\\)`), res.out)
  })
}

test("GREEN: the factory's own workflows pass the gate's rules", () => {
  const dir = join(REPO, '.github', 'workflows')
  const factory = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(dir, f), 'utf8') }))
  assert.ok(factory.length >= 6)
  assert.deepEqual(factory.flatMap((w) => workflowFindings(w, PLATFORM_LIMITS)), [])
})

// ── the lane that runs it ────────────────────────────────────────────────────────────────

const ACTIONS_LINT = readFileSync(join(REPO, 'template', 'base', 'github', 'workflows', 'actions-lint.yml'), 'utf8')

test('actions-lint.yml runs the gate in a job of its own, shaped like floor-review, and re-runs when it changes', () => {
  const job = jobsOf(ACTIONS_LINT)?.jobs.find((j) => j.id === 'workflow-hardening')
  assert.ok(job, "actions-lint.yml has no 'workflow-hardening' job")
  const body = job.lines.join('\n')
  assert.match(body, /^ {4}timeout-minutes: 10$/m)
  assert.match(body, /^ {4}runs-on: ubuntu-latest$/m)
  const uses = [...body.matchAll(/^ {6}- (?:name: [^\n]*\n {8})?uses: (\S+)/gm)].map((m) => m[1])
  assert.deepEqual(
    uses.map((u) => u.split('@')[0]),
    ['step-security/harden-runner', 'actions/checkout', 'actions/setup-node'],
  )
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned by full SHA`)
  assert.match(body, /node-version-file: \.node-version/)
  assert.match(body, /^ {8}run: node tools\/check-workflow-hardening\.mjs$/m)
  // Both paths lists name both new files, and the manifest the ramp reads.
  const lists = [...ACTIONS_LINT.matchAll(/^ {4}paths:\n((?: {6}- .*\n)+)/gm)].map((m) => m[1])
  assert.equal(lists.length, 2)
  for (const list of lists) {
    for (const p of ['tools/check-workflow-hardening.mjs', 'tools/lib/workflow-hardening.mjs', '.harness/manifest.json']) {
      assert.ok(list.includes(`- '${p}'`), `a paths list omits ${p}:\n${list}`)
    }
  }
})

test('harden-runner-coverage keeps its id, name and loop; its comment and zizmor.yml say who checks position', () => {
  const job = jobsOf(ACTIONS_LINT)?.jobs.find((j) => j.id === 'harden-runner-coverage')
  assert.ok(job)
  const body = job.lines.join('\n')
  assert.match(body, /^ {4}name: harden-runner coverage \(incl\. audit-on-windows\)$/m)
  assert.match(body, /^ {6}- name: Every job carries harden-runner$/m)
  assert.match(body, /for wf in \.github\/workflows\/\*\.yml; do/)
  assert.match(body, /hardened=\$\(grep -c 'step-security\/harden-runner@' "\$wf" \|\| true\)/)
  assert.match(body, /COUNTS/)
  assert.match(body, /`workflow-hardening` job/)
  const zizmor = readFileSync(join(REPO, 'template', 'base', 'github', 'zizmor.yml'), 'utf8')
  assert.match(zizmor, /checked by the workflow-hardening job in actions-lint\.yml/)
})
