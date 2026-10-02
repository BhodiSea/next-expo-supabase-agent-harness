// Fixture workflows for the workflow-hardening rules (1.1.0, #73), shared by the two files
// that judge them from opposite sides:
//   - tests/gates/workflow-hardening.test.mjs runs the shipped `harden-runner-coverage` loop
//     over each fixture and asserts it PASSES, because the loop counts lines and cannot see
//     any of these shapes (the control);
//   - tests/gates/check-workflow-hardening.test.mjs asserts the library and the CI-only gate
//     report each one, naming the file and the job.
// Each fixture is otherwise clean (a workflow-level bash default and a ceiling on every job),
// so the one finding it produces is the one the case is about.

const PIN = '0000000000000000000000000000000000000000'
export const HARDEN = `step-security/harden-runner@${PIN}`
export const CHECKOUT = `actions/checkout@${PIN}`

/** The workflow-level block every clean fixture carries, above `jobs:`. */
export const HEAD = 'on: push\ndefaults:\n  run:\n    shell: bash\njobs:\n'

/** The fixture in issue #73, byte for byte: job `a` has two harden-runner steps, job `b` none. */
export const ISSUE_FIXTURE = [
  'on: push',
  'jobs:',
  '  a:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: ${HARDEN}`,
  `      - uses: ${HARDEN}`,
  '  b:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo unhardened | tee out.txt',
  '',
].join('\n')

/** A job hardened the way every shipped job is. */
export const CLEAN_JOB = [
  '  build:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 10',
  '    steps:',
  '      - name: Harden runner (egress audit)',
  `        uses: ${HARDEN} # v2.20.0`,
  '        with:',
  '          egress-policy: audit',
  `      - uses: ${CHECKOUT}`,
  '      - run: echo hi | tee out.txt',
  '',
].join('\n')

export const CLEAN = `${HEAD}${CLEAN_JOB}`

/**
 * Every shape the counting loop passes and the position rule reds: point 2 of issue #73.
 * `files` is what sits under the fixture's root; `finding` must match one finding line, and
 * `job` is the `<file>#<job>` it names.
 * @type {Array<{ id: string, files: Record<string, string>, job: string, finding: RegExp }>}
 */
export const LOOP_MISSES = [
  {
    id: 'two harden-runner steps in one job cover a neighbour that has none',
    files: {
      '.github/workflows/x.yml': [
        HEAD.trimEnd(),
        '  a:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 10',
        '    steps:',
        `      - uses: ${HARDEN}`,
        `      - uses: ${HARDEN}`,
        '  b:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 10',
        '    steps:',
        '      - run: echo unhardened | tee out.txt',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/x.yml#b',
    finding: /^\.github\/workflows\/x\.yml#b: the first step is a run: step, not step-security\/harden-runner/,
  },
  {
    id: 'harden-runner placed after checkout',
    files: {
      '.github/workflows/late.yml': [
        HEAD.trimEnd(),
        '  build:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 10',
        '    steps:',
        `      - uses: ${CHECKOUT}`,
        `      - uses: ${HARDEN}`,
        '      - run: echo hi',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/late.yml#build',
    finding: /^\.github\/workflows\/late\.yml#build: the first step uses actions\/checkout@0{40}, not step-security\/harden-runner/,
  },
  {
    id: 'a comment naming step-security/harden-runner@ counted as a step',
    files: {
      '.github/workflows/commented.yml': [
        HEAD.trimEnd(),
        '  build:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 10',
        '    steps:',
        `      # - uses: ${HARDEN}`,
        '      - run: echo hi',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/commented.yml#build',
    finding: /^\.github\/workflows\/commented\.yml#build: the first step is a run: step/,
  },
  {
    id: 'a .yaml workflow, which the loop never reads',
    files: {
      '.github/workflows/ok.yml': CLEAN,
      '.github/workflows/other.yaml': [
        HEAD.trimEnd(),
        '  build:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 10',
        '    steps:',
        '      - run: echo unhardened',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/other.yaml#build',
    finding: /^\.github\/workflows\/other\.yaml#build: the first step is a run: step/,
  },
  {
    id: 'a workflow indented by four spaces, where the loop counts zero jobs',
    files: {
      '.github/workflows/deep.yml': [
        'on: push',
        'defaults:',
        '    run:',
        '        shell: bash',
        'jobs:',
        '    build:',
        '        runs-on: ubuntu-latest',
        '        timeout-minutes: 10',
        '        steps:',
        '            - run: echo unhardened',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/deep.yml#build',
    finding: /^\.github\/workflows\/deep\.yml#build: the first step is a run: step/,
  },
  {
    id: 'a windows job whose harden-runner blocks instead of auditing',
    files: {
      '.github/workflows/win.yml': [
        HEAD.trimEnd(),
        '  build:',
        '    runs-on: windows-latest',
        '    timeout-minutes: 10',
        '    steps:',
        `      - uses: ${HARDEN}`,
        '        with:',
        '          egress-policy: block',
        '      - run: echo hi',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/win.yml#build',
    finding: /^\.github\/workflows\/win\.yml#build: runs on Windows \(runs-on: windows-latest\) and its harden-runner step does not set egress-policy: audit/,
  },
  {
    id: 'a matrix job with a windows value and no egress-policy',
    files: {
      '.github/workflows/matrix.yml': [
        HEAD.trimEnd(),
        '  test:',
        '    runs-on: ${{ matrix.os }}',
        '    timeout-minutes: 10',
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest, windows-latest]',
        '    steps:',
        `      - uses: ${HARDEN}`,
        '      - run: echo hi',
        '',
      ].join('\n'),
    },
    job: '.github/workflows/matrix.yml#test',
    finding: /^\.github\/workflows\/matrix\.yml#test: runs on Windows \(matrix\.os: windows-latest\) and its harden-runner step does not set egress-policy: audit/,
  },
]
