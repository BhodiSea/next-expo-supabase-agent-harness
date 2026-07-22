// Can-fail + can-pass proofs for the perf-budget gate
// (template/base/tools/check-perf-budget.mjs). Fixture-driven: build a
// scaffold-shaped tree, run the REAL gate with cwd inside it, assert the exact
// red/green. The gate measures by spawning tools/lib/perf-subject-cli.mjs as a
// plain node child, which anchors module resolution at apps/mobile — so the
// measurement paths plant MINIMAL CommonJS stubs (react / react-test-renderer /
// react-native / babel-preset-expo / @babel/core) in the fixture's
// apps/mobile/node_modules: enough surface for createElement + a synchronous
// act()+create() mount whose JSON tree carries the subject's props. The stub is
// faster than real React, so a generous budget greens and a sub-microsecond one
// reds; the SHAPE (median-of-N, re-measure-once, anti-vacuity, marker scaling)
// is what these pin, not absolute milliseconds. Every shape/closure/leak red is
// proven BEFORE any spawn, install-free.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-perf-budget.mjs', import.meta.url),
)
const CLI = fileURLToPath(
  new URL('../../template/base/tools/lib/perf-subject-cli.mjs', import.meta.url),
)
const MATRIX_SUBJECT = 'apps/mobile/src/features/matrix/perfSubject.tsx'

// ---- the module-stub layer -------------------------------------------------------

const REACT_STUB = `'use strict'
function createElement(type, props) {
  return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
}
module.exports = { createElement: createElement }
`

// A synchronous stand-in for react-test-renderer: act() runs its callback,
// create() resolves function components and hands back a props/children tree
// that the CLI's marker counter walks exactly like the real toJSON() output.
const RENDERER_STUB = `'use strict'
function resolveNode(node) {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(resolveNode)
  if (typeof node.type === 'function') return resolveNode(node.type(node.props || {}))
  return { type: node.type, props: node.props || {}, children: resolveNode(node.children || []) }
}
function create(element) {
  let tree = resolveNode(element)
  return {
    toJSON: function () { return tree },
    update: function (next) { tree = resolveNode(next) },
    unmount: function () {},
  }
}
function act(cb) { cb() }
module.exports = { create: create, act: act }
`

function plantStubModules(dir) {
  const nm = join(dir, 'apps/mobile/node_modules')
  const write = (rel, content) => {
    const abs = join(nm, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const pkg = (name) => `{ "name": "${name}", "version": "0.0.0-stub", "main": "index.js" }`
  write('babel-preset-expo/package.json', pkg('babel-preset-expo'))
  write('babel-preset-expo/index.js', 'module.exports = function preset() { return {} }\n')
  write('@babel/core/package.json', pkg('@babel/core'))
  write('@babel/core/index.js', 'module.exports = { transformSync: (source) => ({ code: source }) }\n')
  write('react/package.json', pkg('react'))
  write('react/index.js', REACT_STUB)
  write('react-test-renderer/package.json', pkg('react-test-renderer'))
  write('react-test-renderer/index.js', RENDERER_STUB)
  write('react-native/package.json', pkg('react-native'))
  write('react-native/index.js', 'module.exports = {}\n')
}

// A REAL subject: one role="cell" marker per declared cell (plain CJS — the
// fixture's identity-babel compiles nothing, so the .tsx must already be CJS).
const SUBJECT_SRC = `'use strict'
function PerfSubject(props) {
  const kids = []
  for (let i = 0; i < props.cells; i += 1) {
    kids.push({ type: 'Text', props: { role: 'cell' }, children: ['x'] })
  }
  return { type: 'View', props: {}, children: kids }
}
exports.PerfSubject = PerfSubject
`

// ---- fixtures -------------------------------------------------------------------

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** @param {{ budget?: any, mobile?: boolean, stubs?: boolean, files?: Record<string, string> }} [opts] */
function fixture({ budget, mobile = true, stubs = false, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-perfgate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (mobile) {
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/package.json'), '{ "name": "mobile" }\n')
    if (stubs) plantStubModules(dir)
  }
  if (budget !== null && budget !== undefined) {
    writeFileSync(join(dir, 'tools/perf-budget.json'), asText(budget))
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

/** @param {Record<string, any>} [overrides] */
function subjectsBudget(overrides = {}) {
  return {
    runs: 3,
    subjects: [{ subject: MATRIX_SUBJECT, cells: 50, medianBudgetMs: 100000 }],
    ...overrides,
  }
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  delete env.PERF_SUBJECT_EXPECT
  delete env.PERF_SUBJECT_MARKER_SCALES
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ---- budget shape contract -------------------------------------------------------

test('RED: a mobile surface with no committed budget file fails; corrupt JSON fails loud', () => {
  const missing = runGate(fixture({ budget: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('tools/perf-budget.json missing'), missing.out)

  const corrupt = runGate(fixture({ budget: '{ not json' }))
  assert.equal(corrupt.code, 1, corrupt.out)
  assert.ok(corrupt.out.includes('is not valid JSON'), corrupt.out)
})

test('RED: the desktop-era singular "subject" key never existed here — legacy shape is a contract FAIL', () => {
  const alone = runGate(
    fixture({ budget: { runs: 3, cells: 100, medianBudgetMs: 5, subject: MATRIX_SUBJECT } }),
  )
  assert.equal(alone.code, 1, alone.out)
  assert.ok(alone.out.includes('declares a singular "subject" key'), alone.out)
  assert.ok(alone.out.includes('delete "subject"'), alone.out)

  // subject AND subjects together take the same fail — never a guess between them.
  const both = runGate(
    fixture({ budget: subjectsBudget({ subject: MATRIX_SUBJECT }) }),
  )
  assert.equal(both.code, 1, both.out)
  assert.ok(both.out.includes('declares a singular "subject" key'), both.out)
})

test('RED: budget arithmetic — missing subjects, bad runs, empty/ill-shaped/duplicate entries', () => {
  const noSubjects = runGate(fixture({ budget: { runs: 3 } }))
  assert.equal(noSubjects.code, 1, noSubjects.out)
  assert.ok(noSubjects.out.includes('must declare subjects:'), noSubjects.out)
  assert.ok(noSubjects.out.includes('vacuous pass'), noSubjects.out)

  const noRuns = runGate(
    fixture({ budget: { subjects: [{ subject: MATRIX_SUBJECT, cells: 1, medianBudgetMs: 1 }] } }),
  )
  assert.equal(noRuns.code, 1, noRuns.out)
  assert.ok(noRuns.out.includes('positive number for runs'), noRuns.out)

  const empty = runGate(fixture({ budget: { runs: 3, subjects: [] } }))
  assert.equal(empty.code, 1, empty.out)
  assert.ok(empty.out.includes('NON-EMPTY array'), empty.out)

  for (const entry of [
    { subject: MATRIX_SUBJECT, cells: 50 }, // no budget
    { subject: MATRIX_SUBJECT, cells: -1, medianBudgetMs: 5 },
    { subject: '', cells: 50, medianBudgetMs: 5 },
    { subject: MATRIX_SUBJECT, cells: 50, medianBudgetMs: 5, expect: '' },
  ]) {
    const r = runGate(fixture({ budget: { runs: 3, subjects: [entry] } }))
    assert.equal(r.code, 1, `${JSON.stringify(entry)} :: ${r.out}`)
    assert.ok(r.out.includes('every subjects[] entry must be'), `${JSON.stringify(entry)} :: ${r.out}`)
  }

  const entry = { subject: MATRIX_SUBJECT, cells: 50, medianBudgetMs: 5 }
  const dup = runGate(fixture({ budget: { runs: 3, subjects: [entry, { ...entry }] } }))
  assert.equal(dup.code, 1, dup.out)
  assert.ok(dup.out.includes(`declares "${MATRIX_SUBJECT}" twice`), dup.out)
})

// ---- dense-feature closure -------------------------------------------------------

test('RED closure (inverse): a subjects[] entry naming a missing file fails before any spawn', () => {
  const r = runGate(fixture({ budget: subjectsBudget() }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes(`subjects[] declares "${MATRIX_SUBJECT}" but the file does not exist`),
    r.out,
  )
  assert.ok(!r.out.includes('falls back'), r.out)
})

test('RED closure: a feature importing useKeysetQuery with no perfSubject reds with the create-FIX', () => {
  const dir = fixture({
    budget: subjectsBudget(),
    files: {
      [MATRIX_SUBJECT]: SUBJECT_SRC,
      'apps/mobile/src/features/reports/HeatPanel.tsx':
        "import { useKeysetQuery } from '../matrix/useKeysetQuery'\nexport const q = useKeysetQuery\n",
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('imports useKeysetQuery (data-dense by doctrine) but ships NO perfSubject.tsx'), r.out)
  assert.ok(r.out.includes('PerfSubject({ cells })'), r.out)
  assert.ok(r.out.includes(`worked pattern: ${MATRIX_SUBJECT}`), r.out)
})

test('RED closure: density is a SHAPE — getItemLayout / FlashList / react-native-skia each red', () => {
  const sources = {
    getItemLayout: 'export const opts = { getItemLayout: (d, i) => layout(i) }\n',
    FlashList: "import { FlashList } from '@shopify/flash-list'\nexport const L = FlashList\n",
    'react-native-skia': "import { Canvas } from '@shopify/react-native-skia'\nexport const C = Canvas\n",
  }
  for (const [signal, content] of Object.entries(sources)) {
    const dir = fixture({
      budget: subjectsBudget(),
      files: {
        [MATRIX_SUBJECT]: SUBJECT_SRC,
        'apps/mobile/src/features/heat/Panel.tsx': content,
      },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${signal}: ${r.out}`)
    assert.ok(r.out.includes('data-dense by SHAPE'), `${signal}: ${r.out}`)
    assert.ok(r.out.includes('apps/mobile/src/features/heat/'), `${signal}: ${r.out}`)
  }
})

test('densitySignals are reviewable data: a custom signal arms the scan, a malformed key fails', () => {
  const custom = runGate(
    fixture({
      budget: subjectsBudget({ densitySignals: ['\\bMyDenseWidget\\b'] }),
      files: {
        [MATRIX_SUBJECT]: SUBJECT_SRC,
        'apps/mobile/src/features/heat/Panel.tsx': 'export const P = () => <MyDenseWidget />\n',
      },
    }),
  )
  assert.equal(custom.code, 1, custom.out)
  assert.ok(custom.out.includes('data-dense by SHAPE (\\bMyDenseWidget\\b)'), custom.out)

  const malformed = runGate(fixture({ budget: subjectsBudget({ densitySignals: 'FlashList' }) }))
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('densitySignals must be an ARRAY'), malformed.out)
})

test('RED closure (inverse): an existing features/*/perfSubject.tsx not declared in subjects[] fails', () => {
  const dir = fixture({
    budget: subjectsBudget(),
    files: {
      [MATRIX_SUBJECT]: SUBJECT_SRC,
      'apps/mobile/src/features/notes/perfSubject.tsx': SUBJECT_SRC,
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes('apps/mobile/src/features/notes/perfSubject.tsx exists but is not declared'),
    r.out,
  )
})

test('RED: exempt[] escapes fail closed — malformed shapes and stale directories', () => {
  const noReason = runGate(fixture({ budget: subjectsBudget({ exempt: [{ dir: 'reports' }] }) }))
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('every exemption must be'), noReason.out)

  const notArray = runGate(fixture({ budget: subjectsBudget({ exempt: 'reports' }) }))
  assert.equal(notArray.code, 1, notArray.out)
  assert.ok(notArray.out.includes('"exempt" must be an ARRAY'), notArray.out)

  const pathNotName = runGate(
    fixture({
      budget: subjectsBudget({ exempt: [{ dir: 'apps/mobile/src/features/reports', reason: 'x' }] }),
    }),
  )
  assert.equal(pathNotName.code, 1, pathNotName.out)
  assert.ok(pathNotName.out.includes('feature dir NAME'), pathNotName.out)

  const stale = runGate(
    fixture({
      budget: subjectsBudget({ exempt: [{ dir: 'ghost', reason: 'gone' }] }),
      files: { [MATRIX_SUBJECT]: SUBJECT_SRC },
    }),
  )
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes('exempts feature dir "ghost"'), stale.out)
  assert.ok(stale.out.includes('stale exemption'), stale.out)
})

// ---- measurement (stubbed react in the fixture's own node_modules) ---------------

test('GREEN: a generous budget measures the real subject through the CLI and passes; exempt silences a dense dir', () => {
  const dir = fixture({
    budget: subjectsBudget({ exempt: [{ dir: 'reports', reason: 'prototype, not routed yet' }] }),
    stubs: true,
    files: {
      [MATRIX_SUBJECT]: SUBJECT_SRC,
      'apps/mobile/src/features/reports/HeatPanel.tsx':
        "import { useKeysetQuery } from '../matrix/useKeysetQuery'\nexport const q = useKeysetQuery\n",
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('perf-budget: OK'), r.out)
  assert.ok(r.out.includes(`subject ${MATRIX_SUBJECT}, 50 cells, 3 runs`), r.out)
  assert.ok(!r.out.includes('re-measured'), r.out)
  // Median-of-N proof: one timing sample per declared run.
  const samples = r.out.match(/samples ([\d/]+)ms/)
  assert.ok(samples, r.out)
  assert.equal(samples[1].split('/').length, 3, r.out)
})

test('RED: an over-budget median re-measures ONCE, then fails naming the subject', () => {
  const dir = fixture({
    budget: {
      runs: 3,
      subjects: [{ subject: MATRIX_SUBJECT, cells: 50, medianBudgetMs: 0.000001 }],
    },
    stubs: true,
    files: { [MATRIX_SUBJECT]: SUBJECT_SRC },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('(re-measured once)'), r.out)
  assert.ok(r.out.includes('regressed past the budget twice in a row'), r.out)
  assert.ok(r.out.includes(`subject ${MATRIX_SUBJECT}`), r.out)
})

// ---- update phase (0.1.2): the re-render cost a mount-only benchmark never sees --

test('update phase: the median is always measured and printed; asserted only when budgeted', () => {
  // No medianUpdateBudgetMs → prior red/green behavior, update median printed.
  const unbudgeted = runGate(
    fixture({ budget: subjectsBudget(), stubs: true, files: { [MATRIX_SUBJECT]: SUBJECT_SRC } }),
  )
  assert.equal(unbudgeted.code, 0, unbudgeted.out)
  assert.ok(/update median \d+\.\dms/.test(unbudgeted.out), unbudgeted.out)
  assert.ok(!/update median [\d.]+ms \(budget/.test(unbudgeted.out), unbudgeted.out)

  // A generous update budget passes and prints beside the median.
  const budgeted = runGate(
    fixture({
      budget: {
        runs: 3,
        subjects: [
          { subject: MATRIX_SUBJECT, cells: 50, medianBudgetMs: 100000, medianUpdateBudgetMs: 100000 },
        ],
      },
      stubs: true,
      files: { [MATRIX_SUBJECT]: SUBJECT_SRC },
    }),
  )
  assert.equal(budgeted.code, 0, budgeted.out)
  assert.ok(budgeted.out.includes('(budget 100000ms)'), budgeted.out)
})

test('RED update phase: an over-budget update median re-measures ONCE, then fails naming the update path', () => {
  const dir = fixture({
    budget: {
      runs: 3,
      subjects: [
        {
          subject: MATRIX_SUBJECT,
          cells: 50,
          medianBudgetMs: 100000,
          medianUpdateBudgetMs: 0.000001,
        },
      ],
    },
    stubs: true,
    files: { [MATRIX_SUBJECT]: SUBJECT_SRC },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('(re-measured once)'), r.out)
  assert.ok(r.out.includes('update (re-render) cost regressed past the budget twice in a row'), r.out)
})

test('RED update phase: a malformed medianUpdateBudgetMs is a contract FAIL before any spawn', () => {
  for (const bad of [-1, 0, 'fast']) {
    const r = runGate(
      fixture({
        budget: {
          runs: 3,
          subjects: [
            { subject: MATRIX_SUBJECT, cells: 50, medianBudgetMs: 1, medianUpdateBudgetMs: bad },
          ],
        },
        files: { [MATRIX_SUBJECT]: SUBJECT_SRC },
      }),
    )
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('every subjects[] entry must be'), r.out)
  }
})

test('RED: a vacuous render (no markers) is a measurement FAIL, never a synthetic fallback', () => {
  const dir = fixture({
    budget: subjectsBudget(),
    stubs: true,
    files: {
      [MATRIX_SUBJECT]:
        "'use strict'\nexports.PerfSubject = function PerfSubject() {\n  return { type: 'View', props: {}, children: [] }\n}\n",
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('the real perf subject failed to measure'), r.out)
  assert.ok(r.out.includes('vacuous'), r.out)
  assert.ok(r.out.includes('never falls back to a synthetic measurement'), r.out)
})

// ---- G15: effect-cleanup leak discipline ----------------------------------------

/** A component whose effect registers `register` and returns `cleanup` (null = returns nothing). */
function effectFile(register, cleanup) {
  return `import { useEffect } from 'react'
export function Widget() {
  useEffect(() => {
    const onChange = () => undefined
    ${register}
    ${cleanup === null ? '' : `return () => { ${cleanup} }`}
  }, [])
  return null
}
`
}

const LEAK_FILE = 'apps/mobile/src/Widget.tsx'

test('leak discipline: an effect that registers a listener and returns NO cleanup reds by file:line', () => {
  const dir = fixture({
    budget: subjectsBudget(),
    files: { [LEAK_FILE]: effectFile("AppState.addEventListener('change', onChange)", null) },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/mobile/src/Widget.tsx:3'), r.out)
  assert.ok(r.out.includes('this effect registers addEventListener'), r.out)
  assert.ok(r.out.includes('Leak discipline'), r.out)
})

test('leak discipline: `return () => {}` and a comment-only teardown both still red', () => {
  const emptyCleanup = fixture({
    budget: subjectsBudget(),
    files: { [LEAK_FILE]: effectFile("AppState.addEventListener('change', onChange)", '') },
  })
  const empty = runGate(emptyCleanup)
  assert.equal(empty.code, 1, empty.out)
  assert.ok(empty.out.includes('this effect registers addEventListener'), empty.out)

  const commented = fixture({
    budget: subjectsBudget(),
    files: {
      [LEAK_FILE]: effectFile(
        "AppState.addEventListener('change', onChange)",
        '// TODO: sub.remove() one day',
      ),
    },
  })
  const c = runGate(commented)
  assert.equal(c.code, 1, c.out)
  assert.ok(c.out.includes('this effect registers addEventListener'), c.out)
})

test('leak discipline: every registration pair has its own paired teardown (red bare, green paired)', () => {
  /** @type {[string, string, string][]} */
  const cases = [
    [
      "const sub = AppState.addEventListener('change', onChange)",
      'removeEventListener (or .remove()',
      'sub.remove()',
    ],
    [
      "const sub = Keyboard.addListener('keyboardDidShow', onChange)",
      '.remove() on the returned subscription',
      'sub.remove()',
    ],
    ['const t = setInterval(onChange, 100)', 'clearInterval', 'clearInterval(t)'],
    ['const h = requestAnimationFrame(onChange)', 'cancelAnimationFrame', 'cancelAnimationFrame(h)'],
    ['const sub = source.subscribe(onChange)', '.unsubscribe()', 'sub.unsubscribe()'],
    [
      'const handle = InteractionManager.runAfterInteractions(onChange)',
      '.cancel() on the returned handle',
      'handle.cancel()',
    ],
  ]
  for (const [register, expected, teardown] of cases) {
    const bare = runGate(
      fixture({ budget: subjectsBudget(), files: { [LEAK_FILE]: effectFile(register, null) } }),
    )
    assert.equal(bare.code, 1, `${register} must red\n${bare.out}`)
    assert.ok(bare.out.includes(expected), `${register} must name ${expected}\n${bare.out}`)

    // Paired: the leak scan passes, so the run reds LATER on the missing subject
    // file — proof the teardown satisfied the pair without a full install.
    const paired = runGate(
      fixture({ budget: subjectsBudget(), files: { [LEAK_FILE]: effectFile(register, teardown) } }),
    )
    assert.equal(paired.code, 1, `${register} + ${teardown}\n${paired.out}`)
    assert.ok(!paired.out.includes('Leak discipline'), `${register} + ${teardown} must pass the scan\n${paired.out}`)
    assert.ok(paired.out.includes('does not exist'), paired.out)
  }
})

test('leak discipline: useFocusEffect is scanned too — screen-scoped listeners are the likely leak', () => {
  const content = `import { useFocusEffect } from 'expo-router'
export function Screen() {
  useFocusEffect(() => {
    const t = setInterval(() => undefined, 1000)
  })
  return null
}
`
  const r = runGate(fixture({ budget: subjectsBudget(), files: { [LEAK_FILE]: content } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('this effect registers setInterval'), r.out)
})

test('leak discipline: test files are not scanned (a test may register without cleanup)', () => {
  const dir = fixture({
    budget: subjectsBudget(),
    stubs: true,
    files: {
      [MATRIX_SUBJECT]: SUBJECT_SRC,
      'apps/mobile/src/Widget.test.tsx': effectFile("AppState.addEventListener('c', onChange)", null),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('leak discipline: effectCleanupAllow mutes a reviewed file; stale and malformed entries FAIL CLOSED', () => {
  const muted = fixture({
    budget: subjectsBudget({
      effectCleanupAllow: [{ file: LEAK_FILE, reason: 'registered for the app lifetime' }],
    }),
    stubs: true,
    files: {
      [MATRIX_SUBJECT]: SUBJECT_SRC,
      [LEAK_FILE]: effectFile("AppState.addEventListener('change', onChange)", null),
    },
  })
  const m = runGate(muted)
  assert.equal(m.code, 0, m.out)

  const stale = runGate(
    fixture({
      budget: subjectsBudget({ effectCleanupAllow: [{ file: LEAK_FILE, reason: 'gone' }] }),
    }),
  )
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes('stale exemption'), stale.out)

  const malformed = runGate(
    fixture({ budget: subjectsBudget({ effectCleanupAllow: [{ file: LEAK_FILE }] }) }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('effectCleanupAllow entry must be'), malformed.out)

  const notArray = runGate(
    fixture({ budget: subjectsBudget({ effectCleanupAllow: {} }) }),
  )
  assert.equal(notArray.code, 1, notArray.out)
  assert.ok(notArray.out.includes('"effectCleanupAllow" must be an ARRAY'), notArray.out)
})

test('leak discipline is turn-fatal from the first release — NO baseVersion ramp downgrades it', () => {
  // The desktop-era original version-ramped this scan; this harness was born with
  // the bar, so even an ancient baseVersion must still red (nothing to ramp).
  const dir = fixture({
    budget: subjectsBudget(),
    files: { [LEAK_FILE]: effectFile("AppState.addEventListener('change', onChange)", null) },
  })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.0.1' }),
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('this effect registers addEventListener'), r.out)
  assert.ok(!r.out.includes('NOTE'), r.out)
})

// ---- the perf-subject CLI's own contract (driven directly) -----------------------

/** @param {string} subjectSource @param {number} cells @param {number} runs @param {{ expect?: string, markerScales?: boolean }} [opts] */
function runCli(subjectSource, cells, runs, { expect, markerScales } = {}) {
  const dir = fixture({ budget: null, stubs: true, files: { 'apps/mobile/subject.tsx': subjectSource } })
  const env = { ...process.env }
  delete env.PERF_SUBJECT_EXPECT
  delete env.PERF_SUBJECT_MARKER_SCALES
  if (expect !== undefined) env.PERF_SUBJECT_EXPECT = expect
  if (markerScales === false) env.PERF_SUBJECT_MARKER_SCALES = '0'
  const res = spawnSync(
    process.execPath,
    [CLI, join(dir, 'apps/mobile/subject.tsx'), String(cells), String(runs)],
    { cwd: dir, encoding: 'utf8', env },
  )
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, stdout: res.stdout ?? '' }
}

test('perf-subject-cli: a valid subject prints ONE {"samples":[…],"updateSamples":[…]} line of N numbers each', () => {
  const r = runCli(SUBJECT_SRC, 100, 5)
  assert.equal(r.code, 0, r.out)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, r.out)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.samples.length, 5, r.out)
  assert.ok(parsed.samples.every((s) => typeof s === 'number' && Number.isFinite(s)), r.out)
  // The update phase re-renders the SAME mounted tree with a changed tick —
  // one update sample per run, and the recount keeps its anti-vacuity teeth.
  assert.equal(parsed.updateSamples.length, 5, r.out)
  assert.ok(
    parsed.updateSamples.every((s) => typeof s === 'number' && Number.isFinite(s)),
    r.out,
  )
})

test('perf-subject-cli G30: markers must SCALE with the declared cells — one row cannot pass', () => {
  const oneCell = `'use strict'
exports.PerfSubject = function PerfSubject() {
  return { type: 'View', props: {}, children: [{ type: 'Text', props: { role: 'cell' }, children: ['only one'] }] }
}
`
  const r = runCli(oneCell, 10000, 3)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not scale with the declared work'), r.out)
  assert.ok(r.out.includes('10000'), r.out)
})

test('perf-subject-cli: PERF_SUBJECT_EXPECT overrides the marker; markerScales=false is the container opt-out', () => {
  const container = `'use strict'
exports.PerfSubject = function PerfSubject() {
  return { type: 'View', props: { 'data-chart': '1' }, children: ['x'] }
}
`
  // Container marker + opt-out → green even though role="cell" is absent.
  const optOut = runCli(container, 10000, 3, { expect: 'data-chart="1"', markerScales: false })
  assert.equal(optOut.code, 0, optOut.out)

  // Same subject under the default marker → vacuous.
  const vacuous = runCli(container, 10000, 3)
  assert.equal(vacuous.code, 1, vacuous.out)
  assert.ok(vacuous.out.includes('no role="cell" elements'), vacuous.out)
})

test('perf-subject-cli: a subject with no PerfSubject export exits 1 naming the contract', () => {
  const r = runCli("'use strict'\nexports.nope = 1\n", 100, 3)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('PerfSubject({ cells })'), r.out)
})

// ---- skip asymmetry --------------------------------------------------------------

test('skip asymmetry: no mobile surface → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = fixture({ budget: null, mobile: false })
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const local = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  assert.equal(local.status, 0, `${local.stdout}${local.stderr}`)
  assert.ok(`${local.stdout}`.includes('SKIPPED'), `${local.stdout}${local.stderr}`)

  const ci = runGate(dir)
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('apps/mobile not found'), ci.out)
})
