// Proof for scripts/check-ci-preconditions.mjs — the shipped CI's entry-path closure.
//
// WHY THIS EXISTS. The first EXECUTION of the shipped quality-gate static job
// (scripts/ci/consumer-ci-static.sh, 0.9.0) proved what a reading never had to state:
// the entry path is `pnpm install --frozen-lockfile`, which hard-fails on a scaffold
// whose first commit omitted pnpm-lock.yaml — and 12 of the 14 jobs die even earlier,
// at setup-node's `cache: pnpm` step. The lane proves the demand is real ONCE; this
// gate is the static closure that keeps the three parties from drifting apart again:
// every shipped `pnpm install` spells its lockfile posture explicitly, every
// `cache: pnpm` job is backed by init's committed-lockfile guidance (the cross-file
// half), and every action a consumer executes is SHA-pinned with a reviewable comment.
// The judgement is a pure function over workflow TEXT so it can be proven red here
// without a scaffold, exactly like its neighbours (rule-integrity, escape-registry).
// SOURCE: scripts/lib/ci-preconditions.mjs · scripts/ci/consumer-ci-static.sh
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ciPreconditionProblems } from '../../scripts/lib/ci-preconditions.mjs'

const INIT_NOTE_OK =
  "report.notes.push(\n  'next: pnpm install, then git init (if new) and COMMIT — the first commit must include pnpm-lock.yaml — then validate',\n)"
const INIT_NOTE_REGRESSED =
  "report.notes.push(\n  'next: pnpm install, then git init and commit, then validate',\n)"

const wf = (file, text) => ({ file, text })
const PINNED = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0'

const CLEAN_WF = wf(
  'quality-gate.yml',
  [
    'jobs:',
    '  static:',
    '    steps:',
    `      - uses: ${PINNED}`,
    '      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0',
    '        with:',
    '          cache: pnpm',
    '      - name: Install dependencies',
    '        run: pnpm install --frozen-lockfile',
  ].join('\n'),
)

test('the clean shape: frozen installs, cache: pnpm backed by the init note, pinned actions', () => {
  const problems = ciPreconditionProblems({ workflows: [CLEAN_WF], initSource: INIT_NOTE_OK })
  assert.deepEqual(problems, [])
})

test('anti-vacuity: an empty workflow universe is a broken scan, never a clean one', () => {
  const problems = ciPreconditionProblems({ workflows: [], initSource: INIT_NOTE_OK })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no shipped workflows/i)
})

test('a workflow set with zero pnpm install invocations and zero uses: is a parse failure, not a pass', () => {
  const problems = ciPreconditionProblems({
    workflows: [wf('empty.yml', 'jobs:\n  a:\n    steps:\n      - run: echo hi\n')],
    initSource: INIT_NOTE_OK,
  })
  assert.ok(problems.some((p) => /no `pnpm install` invocation/i.test(p)))
  assert.ok(problems.some((p) => /no `uses:` reference/i.test(p)))
})

test('a BARE `pnpm install` reds — its lockfile posture flips on the CI env var', () => {
  const problems = ciPreconditionProblems({
    workflows: [
      CLEAN_WF,
      wf('extra.yml', `jobs:\n  j:\n    steps:\n      - uses: ${PINNED}\n      - run: pnpm install\n`),
    ],
    initSource: INIT_NOTE_OK,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /extra\.yml:5/)
  assert.match(problems[0], /neither --frozen-lockfile nor --no-frozen-lockfile/)
})

test('an explicit --no-frozen-lockfile is a DECLARED divergence, not a finding', () => {
  const problems = ciPreconditionProblems({
    workflows: [
      CLEAN_WF,
      wf(
        'extra.yml',
        `jobs:\n  j:\n    steps:\n      - uses: ${PINNED}\n      - run: pnpm install --no-frozen-lockfile\n`,
      ),
    ],
    initSource: INIT_NOTE_OK,
  })
  assert.deepEqual(problems, [])
})

test('prose in comments is not an invocation — the ADOPTION-note shape must not trip the scan', () => {
  const problems = ciPreconditionProblems({
    workflows: [
      CLEAN_WF,
      wf(
        'extra.yml',
        `jobs:\n  j:\n    steps:\n      # it runs BEFORE \`pnpm install\` so a pre-0.2.0 install is cheap\n      - uses: ${PINNED}\n      - run: pnpm install --frozen-lockfile\n`,
      ),
    ],
    initSource: INIT_NOTE_OK,
  })
  assert.deepEqual(problems, [])
})

test('cache: pnpm with an init note that stopped naming pnpm-lock.yaml reds — the cross-file closure', () => {
  const problems = ciPreconditionProblems({
    workflows: [CLEAN_WF],
    initSource: INIT_NOTE_REGRESSED,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /pnpm-lock\.yaml/)
  assert.match(problems[0], /next-steps/i)
})

test('no `next:` note at all fails closed — a closure that cannot find its anchor must say so', () => {
  const problems = ciPreconditionProblems({
    workflows: [CLEAN_WF],
    initSource: 'export async function init() {}\n',
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no 'next:' note/i)
})

test('a tag-pinned action reds — a movable ref is not a pin', () => {
  const problems = ciPreconditionProblems({
    workflows: [
      CLEAN_WF,
      wf(
        'extra.yml',
        'jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm install --frozen-lockfile\n',
      ),
    ],
    initSource: INIT_NOTE_OK,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /extra\.yml:4/)
  assert.match(problems[0], /SHA-pinned/)
})

test('a SHA pin with no version comment reds — an unlabelled pin is unreviewable', () => {
  const problems = ciPreconditionProblems({
    workflows: [
      CLEAN_WF,
      wf(
        'extra.yml',
        'jobs:\n  j:\n    steps:\n      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n      - run: pnpm install --frozen-lockfile\n',
      ),
    ],
    initSource: INIT_NOTE_OK,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /comment/)
})

test('a `uses:`-shaped string inside a run block is shell, not an action reference', () => {
  // actions-lint.yml greps for reusable-workflow calls: `reusable=$(grep -cE '^    uses: …' "$wf")`.
  // The scan must judge YAML keys, not every line that contains the word.
  const problems = ciPreconditionProblems({
    workflows: [
      CLEAN_WF,
      wf(
        'extra.yml',
        `jobs:\n  j:\n    steps:\n      - uses: ${PINNED}\n      - run: |\n          reusable=$(grep -cE '^    uses: .+/\\.github/workflows/' "$wf" || true)\n          pnpm install --frozen-lockfile\n`,
      ),
    ],
    initSource: INIT_NOTE_OK,
  })
  assert.deepEqual(problems, [])
})

test('the SHIPPED tree is clean through the real runner — the gate is wired, not aspirational', () => {
  const script = fileURLToPath(new URL('../../scripts/check-ci-preconditions.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /CI PRECONDITIONS: CLEAN/)
})
