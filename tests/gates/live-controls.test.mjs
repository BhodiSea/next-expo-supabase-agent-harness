// tools/lib/live-controls.mjs (0.5.0) — the one definition of "what actually runs here",
// shared by the factory control (scripts/check-tier-coverage.mjs) and the chain control
// (check-docs-sync.mjs's tiers section).
//
// THE BUG THIS FILE EXISTS FOR, found while writing it. Every conditional lane in the
// shipped merge gate is written `if: >-` with the expression on the FOLLOWING lines,
// because the conditions are three clauses long. A one-line `^ {4}if:\s*(.+)$` captures
// `>-` and nothing else — which reads as "this job has no condition", so the whole
// path-filter rule found ZERO conditional jobs and passed over the eleven rows it was
// written to catch. A rule that silently matches nothing is indistinguishable from a rule
// that found nothing wrong, which is the failure mode this release is about.
// SOURCE: template/base/tools/lib/live-controls.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { liveControls, singleSurfaceGates } from '../../template/base/tools/lib/live-controls.mjs'

const SHIPPED_WORKFLOWS = fileURLToPath(
  new URL('../../template/base/github/workflows', import.meta.url),
)
const SHIPPED_TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))

function workflowDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-live-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

test('a FOLDED `if: >-` block is read in full — the one-line regex found nothing', () => {
  const dir = workflowDir({
    'a.yml': `name: a
jobs:
  always:
    name: unconditional
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  filtered:
    name: path-filtered
    needs: [changes]
    if: >-
      !cancelled() &&
      (github.event_name == 'schedule' ||
       (github.event_name == 'pull_request' && needs.changes.outputs.web == 'true'))
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
  })
  const { live, conditional, workflows } = liveControls({ steps: ['format'], workflowDir: dir })
  assert.equal(workflows, 1)
  assert.deepEqual([...live].sort(), ['always', 'filtered', 'format'])
  assert.deepEqual([...conditional], ['filtered'])
  assert.equal(conditional.has('always'), false, 'an unconditional job must not be marked')
})

test('a one-line `if:` is read too — both spellings, one rule', () => {
  const dir = workflowDir({
    'a.yml': `name: a
jobs:
  nightly:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
  })
  const { conditional } = liveControls({ steps: [], workflowDir: dir })
  assert.deepEqual([...conditional], ['nightly'])
})

test('a gate SCRIPT a lane invokes is a nameable control, and inherits the lane s conditionality', () => {
  // Two tier rows name a script rather than a step or a job. Before 0.5.0 the cell parser
  // matched kebab names only, so those cells resolved to nothing and were exempt.
  const dir = workflowDir({
    'a.yml': `name: a
jobs:
  filtered:
    if: needs.changes.outputs.web == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: node tools/check-web-e2e.mjs
  always:
    runs-on: ubuntu-latest
    steps:
      - run: node tools/check-secrets.mjs
`,
  })
  const { live, conditional } = liveControls({ steps: [], workflowDir: dir })
  assert.ok(live.has('check-web-e2e.mjs'), 'a script a lane runs is a control')
  assert.ok(conditional.has('check-web-e2e.mjs'), 'it did not run when its only lane skipped')
  assert.ok(live.has('check-secrets.mjs'))
  assert.equal(conditional.has('check-secrets.mjs'), false, 'an unconditional lane runs it')
})

test('a script invoked by BOTH a filtered and an unfiltered lane is not conditional', () => {
  const dir = workflowDir({
    'a.yml': `name: a
jobs:
  filtered:
    if: needs.changes.outputs.web == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: node tools/check-e2e.mjs
`,
    'b.yml': `name: b
jobs:
  always:
    runs-on: ubuntu-latest
    steps:
      - run: node tools/check-e2e.mjs
`,
  })
  const { conditional, workflows } = liveControls({ steps: [], workflowDir: dir })
  assert.equal(workflows, 2, 'ALL workflows are read — the 0.3.0 correction, applied here')
  assert.equal(conditional.has('check-e2e.mjs'), false)
})

test('a missing workflow directory yields no jobs rather than throwing', () => {
  // A scaffold with CI removed is a legitimate state. The CALLER decides what an empty job
  // set means; inventing one here would hide the removal.
  const { live, conditional, workflows } = liveControls({
    steps: ['format'],
    workflowDir: join(tmpdir(), 'epah-live-does-not-exist'),
  })
  assert.deepEqual([...live], ['format'])
  assert.equal(conditional.size, 0)
  assert.equal(workflows, 0)
})

test('the SHIPPED workflows: eight of them, and the path-filtered lanes are marked', () => {
  // The claim docs/harness/enforcement-tiers.md now makes in writing. If a lane stops being
  // path-filtered this reds, and the table's `(path-filtered)` qualifiers become overstated
  // in the other direction — which is a finding either way.
  const { conditional, workflows } = liveControls({
    steps: [],
    workflowDir: SHIPPED_WORKFLOWS,
  })
  assert.equal(workflows, 8)
  for (const lane of ['web-e2e', 'perf-lane', 'mobile-e2e']) {
    assert.ok(conditional.has(lane), `${lane} is path-filtered and must be marked conditional`)
  }
  for (const lane of ['static', 'unit', 'gate-summary']) {
    assert.equal(conditional.has(lane), false, `${lane} runs on every commit`)
  }
})

test('singleSurfaceGates keys by the STEP name, not the filename', () => {
  // `styleguide` runs check-styleguide-manifest.mjs and `build` runs build-check.mjs. A
  // filename-only key would demand tier rows under names nobody would think to write, and
  // — worse for the Target check — would never match the rows that do exist.
  const gates = singleSurfaceGates({
    toolsDir: SHIPPED_TOOLS,
    configText: `export const VALIDATE_STEPS = [\n  ['i18n', 'node tools/check-i18n.mjs'],\n]\n`,
  })
  const byFile = new Map(gates.map((g) => [g.file, g]))
  assert.equal(byFile.get('check-i18n.mjs')?.key, 'i18n', 'the config maps file -> step')
  assert.equal(byFile.get('check-i18n.mjs')?.surface, 'mobile')
  assert.ok(gates.length >= 8, `the harness ships more single-surface gates: ${gates.length}`)
})

test('ANTI-VACUITY: build-check.mjs is NOT single-surface any more, and that is the discharge', () => {
  // 0.5.0 gave it a `--web` mode over the .next client chunks. This is the mechanical fact
  // the tiers Target check reads to decide the `build` row's commitment was met — so if the
  // web mode is ever removed, the row's Target stops discharging and reds instead.
  const gates = singleSurfaceGates({ toolsDir: SHIPPED_TOOLS })
  assert.equal(
    gates.some((g) => g.file === 'build-check.mjs'),
    false,
    'build-check.mjs scans both apps/mobile and apps/web',
  )
  assert.ok(
    gates.some((g) => g.file === 'check-i18n.mjs'),
    'and the derivation still finds the gates that ARE single-surface',
  )
})
