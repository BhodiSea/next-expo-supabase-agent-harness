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
  const { live, conditional, workflows } = liveControls({
    steps: ['format'],
    workflowDir: dir,
  })
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
  const { conditional, workflows } = liveControls({
    steps: [],
    workflowDir: dir,
  })
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

test('the SHIPPED workflows: nine of them, and the path-filtered lanes are marked', () => {
  // The claim docs/harness/enforcement-tiers.md now makes in writing. If a lane stops being
  // path-filtered this reds, and the table's `(path-filtered)` qualifiers become overstated
  // in the other direction — which is a finding either way.
  const { conditional, workflows } = liveControls({
    steps: [],
    workflowDir: SHIPPED_WORKFLOWS,
  })
  assert.equal(workflows, 9)
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
  // `check-i18n.mjs` was this test's example until 0.6.0 made it two-surface, which is
  // exactly the event this file exists to notice: it left the set, so the example moved to a
  // gate that is still single-surface BY NATURE rather than by omission.
  const gates = singleSurfaceGates({
    toolsDir: SHIPPED_TOOLS,
    configText: `export const VALIDATE_STEPS = [\n  ['styleguide', 'node tools/check-styleguide-manifest.mjs'],\n]\n`,
  })
  const byFile = new Map(gates.map((g) => [g.file, g]))
  assert.equal(
    byFile.get('check-styleguide-manifest.mjs')?.key,
    'styleguide',
    'the config maps file -> step',
  )
  assert.equal(byFile.get('check-styleguide-manifest.mjs')?.surface, 'mobile')
  assert.ok(gates.length >= 8, `the harness ships more single-surface gates: ${gates.length}`)
})

test('ANTI-VACUITY: the DISCHARGED gates are not single-surface, and that is what discharges them', () => {
  // Two releases' commitments, asserted as the mechanical facts the tiers Target check
  // actually reads. If either gate's second-surface support is ever removed, the matching
  // row's Target stops discharging and reds instead — which is the whole design.
  //   build-check.mjs  — 0.5.0 gave it a `--web` mode over the .next client chunks.
  //   check-i18n.mjs   — 0.6.0 made it surface-parameterised (SURFACES), so it scans
  //                      apps/web/{lib,app} alongside apps/mobile/{src,app}.
  const gates = singleSurfaceGates({ toolsDir: SHIPPED_TOOLS })
  for (const [file, why] of [
    ['build-check.mjs', 'scans both apps/mobile and apps/web'],
    ['check-i18n.mjs', 'is surface-parameterised over mobile AND web'],
  ]) {
    assert.equal(
      gates.some((g) => g.file === file),
      false,
      `${file} ${why}`,
    )
  }
  assert.ok(
    gates.some((g) => g.file === 'check-perf-budget.mjs'),
    'and the derivation still finds the gates that ARE single-surface',
  )
})

test('THE STEP FOLD: two single-surface scripts under one step are not a single-surface gate', () => {
  // 0.6.0. Both consumers of this derivation ask about a tier ROW, and a row names a chain
  // STEP — but the derivation answered about a SCRIPT, and those coincide only while every
  // step runs one script. `boundaries` has run two since 0.1.x, and `route-manifest` became
  // the case that made it matter: check-route-manifest.mjs is mobile-only, check-web-routes.mjs
  // is web-only, and the step covers the product. Unfolded, the row's arrived Target could
  // never discharge no matter what shipped.
  const gates = singleSurfaceGates({
    toolsDir: SHIPPED_TOOLS,
    configText:
      "export const VALIDATE_STEPS = [\n  ['route-manifest', 'node tools/check-route-manifest.mjs && node tools/check-web-routes.mjs'],\n]\n",
  })
  assert.equal(
    gates.some((g) => g.key === 'route-manifest'),
    false,
    'the STEP reaches both surfaces, so neither of its scripts is reported',
  )
  for (const file of ['check-route-manifest.mjs', 'check-web-routes.mjs']) {
    assert.equal(
      gates.some((g) => g.file === file),
      false,
      `${file} folds into its step`,
    )
  }
})

test('THE STEP FOLD does not hide a one-surface step that happens to run two scripts', () => {
  // The fold is over SURFACES, not over script count. Two mobile-only scripts under one step
  // are still a mobile-only control and still owe a row — otherwise "add a second script"
  // would be a way to leave the table.
  const gates = singleSurfaceGates({
    toolsDir: SHIPPED_TOOLS,
    configText:
      "export const VALIDATE_STEPS = [\n  ['mobile-only', 'node tools/check-route-manifest.mjs && node tools/check-expo-policy.mjs'],\n]\n",
  })
  const folded = gates.filter((g) => g.key === 'mobile-only')
  assert.equal(folded.length, 2, 'both scripts stay reported under the shared step key')
  assert.deepEqual([...new Set(folded.map((g) => g.surface))], ['mobile'])
})

test('a script with NO step keys on its own basename and never folds with another', () => {
  // The two lane RUNNERS tier rows name directly (check-web-e2e.mjs, check-e2e-device.mjs)
  // are each other's compensating control, not two halves of one step. They carry no config
  // entry, so they key on their own basenames and group alone — which is what keeps the fold
  // from silently discharging the pair.
  const gates = singleSurfaceGates({ toolsDir: SHIPPED_TOOLS })
  const byFile = new Map(gates.map((g) => [g.file, g]))
  assert.equal(byFile.get('check-web-e2e.mjs')?.key, 'web-e2e')
  assert.equal(byFile.get('check-e2e-device.mjs')?.key, 'e2e-device')
  assert.equal(byFile.get('check-web-e2e.mjs')?.surface, 'web')
  assert.equal(byFile.get('check-e2e-device.mjs')?.surface, 'mobile')
})
