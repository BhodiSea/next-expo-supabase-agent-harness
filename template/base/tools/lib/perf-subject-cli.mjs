#!/usr/bin/env node
// tools/lib/perf-subject-cli.mjs — the measurement harness the perf-budget gate
// spawns as a plain `node` child (process.execPath — no shell, no package-manager
// bin shims). The desktop-era original rendered its subject to an HTML string with
// a server renderer and searched the markup; this host has no server renderer, so
// the subject is a react-native COMPONENT and one measurement is one full
// react-test-renderer mount of its element tree. Same doctrine, different renderer:
// a RELATIVE render canary — it times React building the subject's tree, not
// Fabric, not a device — cheap enough for the validate chain, honest about what it
// is (the absolute UX numbers live in the CI device lane).
//
// HOW THE SUBJECT ACTUALLY RENDERS UNDER PLAIN NODE (the module-mock layer):
//   1. The nearest package.json above the subject file is the app package; a
//      createRequire anchored there resolves react, react-test-renderer and
//      babel-preset-expo at the APP's versions — ONE React instance, or every
//      hook call would be invalid.
//   2. @babel/core is reached THROUGH babel-preset-expo's own resolution context:
//      under an isolated (pnpm) node_modules the app does not depend on
//      @babel/core directly, but the preset that needs it always resolves it.
//   3. The subject's TS/TSX import closure compiles per-require via a
//      require.extensions hook + module._compile, using babel-preset-expo — the
//      SAME preset metro and jest-expo read from the app's babel.config.js, so
//      the gate never invents a second transform pipeline.
//      `enableBabelRuntime: false` inlines the emitted helpers: @babel/runtime
//      is the preset's dependency, not the app's, so requiring it from compiled
//      app files would MODULE_NOT_FOUND under isolated installs. (This is the
//      node CJS compile pipeline — require.extensions + module._compile — which
//      is exactly why the subject loads via require, not dynamic import: the
//      ESM loader has no per-extension hook to hang the transform on.)
//   4. react-native itself is NEVER loaded: its resolved entry is pre-planted in
//      the require cache with a minimal host-component mock (View/Text/... as
//      host tags, so props — and the role marker — survive into the rendered
//      tree). This is the plain-node equivalent of what jest-expo's preset
//      provides for a component test, cut down to what a perf subject may
//      legitimately import: a subject is an ISLAND by contract (worked pattern:
//      apps/mobile/src/features/matrix/perfSubject.tsx). An unmocked
//      react-native export throws a NAMED error instead of undefined-soup, so a
//      subject that grows a native dependency fails loudly, never vacuously.
//   5. React 19's test renderer renders CONCURRENTLY: create() alone only
//      SCHEDULES work (an unflushed mount measured 0.6 ms and rendered nothing —
//      measured while building this harness). Every mount is therefore wrapped
//      in act() under IS_REACT_ACT_ENVIRONMENT, so the timed window contains the
//      complete synchronous flush of the declared workload.
//      SOURCE: component tests render through the test renderer's act() so work
//      flushes before assertions https://reactnative.dev/docs/testing-overview
//
// Argv: <absolute subject module> <cells> <runs>. Env: PERF_SUBJECT_EXPECT — the
// anti-vacuity marker, `prop="value"` form (default role="cell", the ARIA-style
// RN role the matrix subject stamps on every cell). It travels via ENVIRONMENT,
// not argv, so a quoted marker can never be mangled by argv joining, and the
// contract stays identical to the desktop-era gate's. On success it prints
// EXACTLY one JSON line `{"samples":[ms,…],"updateSamples":[ms,…]}` (runs
// entries each: mount cost, then the cost of re-rendering the SAME mounted tree
// with a changed `tick` prop — the update path a mount-only benchmark never
// sees). Any problem — bad argv, missing PerfSubject export, or a vacuous
// render (marker absent or not scaling with the declared cells) — exits 1 with
// a reason on stderr. The gate treats a non-zero exit or an unparseable line as a hard FAIL,
// never a silent fallback to a synthetic measurement.
// SOURCE: docs/harness/gates-catalog.md (perf-budget gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import { dirname, join } from 'node:path'

const DEFAULT_EXPECT = 'role="cell"'

/** Nearest package.json at or above `dir` — the app package the subject belongs to. */
function findAppDir(dir) {
  let at = dir
  while (!existsSync(join(at, 'package.json'))) {
    const up = dirname(at)
    if (up === at) {
      console.error(`no package.json found above the subject — cannot anchor module resolution`)
      process.exit(1)
    }
    at = up
  }
  return at
}

/**
 * The minimal react-native surface a PURE perf subject may import. Host-component
 * names render as host tags (react-test-renderer keeps their props verbatim, so
 * marker counting sees exactly what the subject declared); the handful of
 * utilities are inert stand-ins. Anything else throws by name: the subject
 * contract is an island — no lists, no navigation, no native modules.
 */
function reactNativeMock() {
  const dimensions = { width: 390, height: 844, scale: 2, fontScale: 1 }
  const exports_ = {
    __esModule: true,
    View: 'View',
    Text: 'Text',
    Image: 'Image',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    ActivityIndicator: 'ActivityIndicator',
    StyleSheet: {
      create: (styles) => styles,
      flatten: (style) =>
        Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity)) : (style ?? {}),
      hairlineWidth: 1,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
      absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    },
    Platform: { OS: 'ios', Version: 17, select: (spec) => spec.ios ?? spec.native ?? spec.default },
    I18nManager: { isRTL: false, allowRTL: () => undefined, forceRTL: () => undefined },
    PixelRatio: { get: () => 2, getFontScale: () => 1, roundToNearestPixel: (n) => n },
    Dimensions: {
      get: () => dimensions,
      addEventListener: () => ({ remove: () => undefined }),
    },
    useWindowDimensions: () => dimensions,
  }
  return new Proxy(exports_, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop]
      // Interop probes from compiled import sites must see plain absence.
      if (prop === 'default' || prop === 'then') return undefined
      throw new Error(
        `react-native.${prop} is not in the perf-subject mock layer — a perf subject is an ` +
          `island (plain View/Text markup, no lists, no native modules); see the worked ` +
          `pattern apps/mobile/src/features/matrix/perfSubject.tsx`,
      )
    },
  })
}

/** Compile-on-require for the subject's TS/TSX closure, through the app's own preset. */
function installCompileHook(appRequire, presetPath, babel) {
  const compile = (mod, filename) => {
    const source = readFileSync(filename, 'utf8')
    const out = babel.transformSync(source, {
      filename,
      babelrc: false,
      configFile: false,
      sourceType: 'unambiguous',
      presets: [[presetPath, { enableBabelRuntime: false }]],
      caller: { name: 'perf-subject-cli', supportsStaticESM: false, platform: 'ios', isDev: false },
    })
    mod._compile(out.code, filename)
  }
  for (const ext of ['.ts', '.tsx', '.jsx']) appRequire.extensions[ext] = compile
}

/** Count rendered elements whose props carry the marker, walking the JSON tree. */
function countMarkers(node, prop, value) {
  if (node == null || typeof node === 'string') return 0
  if (Array.isArray(node)) {
    let n = 0
    for (const child of node) n += countMarkers(child, prop, value)
    return n
  }
  const self = node.props?.[prop] === value ? 1 : 0
  return self + countMarkers(node.children, prop, value)
}

function parseArgs() {
  const [subjectPath, cellsArg, runsArg] = process.argv.slice(2)
  if (subjectPath === undefined || cellsArg === undefined || runsArg === undefined) {
    console.error('usage: perf-subject-cli <absolute-subject-module> <cells> <runs>')
    process.exit(1)
  }
  const cells = Number(cellsArg)
  const runs = Number(runsArg)
  if (!Number.isFinite(cells) || cells <= 0 || !Number.isInteger(runs) || runs <= 0) {
    console.error(`cells and runs must be positive numbers (got ${cellsArg}, ${runsArg})`)
    process.exit(1)
  }
  const envExpect = process.env.PERF_SUBJECT_EXPECT
  const expect = envExpect !== undefined && envExpect !== '' ? envExpect : DEFAULT_EXPECT
  // The marker is a PROP EQUALITY on the rendered tree (there is no markup string
  // to substring-search on this host), so it must name a prop and a value.
  const marker = /^([A-Za-z_][\w-]*)="([^"]*)"$/.exec(expect)
  if (marker === null) {
    console.error(
      `PERF_SUBJECT_EXPECT must look like prop="value" (e.g. ${DEFAULT_EXPECT}) — got ${expect}`,
    )
    process.exit(1)
  }
  return { subjectPath, cells, runs, expect, prop: marker[1], value: marker[2] }
}

function main() {
  const { subjectPath, cells, runs, expect, prop, value } = parseArgs()

  const appDir = findAppDir(dirname(subjectPath))
  const appRequire = createRequire(join(appDir, 'package.json'))
  const presetPath = appRequire.resolve('babel-preset-expo')
  const babel = createRequire(presetPath)('@babel/core')
  const React = appRequire('react')
  const TestRenderer = appRequire('react-test-renderer')

  // Plant the mock under react-native's RESOLVED entry before anything imports it.
  const rnEntry = appRequire.resolve('react-native')
  const planted = new Module(rnEntry)
  planted.filename = rnEntry
  planted.loaded = true
  planted.exports = reactNativeMock()
  appRequire.cache[rnEntry] = planted

  installCompileHook(appRequire, presetPath, babel)

  // CJS require, not dynamic import: the compile hook lives in require.extensions,
  // which the ESM loader would bypass.
  const mod = appRequire(subjectPath)
  const PerfSubject = mod.PerfSubject
  if (typeof PerfSubject !== 'function') {
    console.error(`subject ${subjectPath} has no PerfSubject({ cells }) component export`)
    process.exit(1)
  }

  // act() is mandatory under the concurrent test renderer (see header point 5).
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { act } = TestRenderer
  const mount = () => {
    // Annotated, not bare: a bare closure-assigned `let` reads as `undefined`
    // outside the callback (closure assignments are invisible to the checker's
    // evolving-type inference), which would poison every caller downstream.
    /** @type {ReturnType<typeof TestRenderer.create> | undefined} */
    let renderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(PerfSubject, { cells }))
    })
    // act() runs its callback synchronously, so this is unreachable in practice —
    // but a renderer that never mounted must fail LOUDLY here, not as a null
    // deref at measurement time. (Copied to a const first: the closure-assigned
    // `let` is exempt from control-flow narrowing, so the guard proves the
    // non-undefined type to the checker only via the local.)
    const mounted = renderer
    if (mounted === undefined) {
      throw new Error(
        'perf-subject: renderer never mounted — act() did not run its callback; check the react-test-renderer install and the module-mock layer',
      )
    }
    return mounted
  }
  const unmount = (renderer) => {
    act(() => {
      renderer.unmount()
    })
  }

  // Does the marker appear ONCE PER CELL (the default — role="cell" does), so its
  // count can be checked against the declared `cells`? A subject whose marker is a
  // container (one per render) sets PERF_SUBJECT_MARKER_SCALES=0 and falls back to
  // the weaker presence-only check.
  const markerScales = process.env.PERF_SUBJECT_MARKER_SCALES !== '0'
  // Tolerance: the subject may round cells to whole rows (cells/columns), so demand
  // 90% rather than an exact match. A degenerate render misses by orders of magnitude.
  const minMarkers = Math.floor(cells * 0.9)

  // Anti-vacuity, both halves. Exits 1 with a reason if the render measured nothing real.
  //   presence — an empty/degenerate render is a vacuously fast "pass"; the marker's
  //     absence means we measured nothing, so the number would be a lie.
  //   scale — PRESENCE was never enough (the desktop-era gate learned this): a subject
  //     that renders ONE row still contains the marker and "passes" the budget in ~1 ms,
  //     so a real regression could be hidden simply by shrinking what gets measured.
  //     The work must actually scale with the declared cells.
  const assertNotVacuous = (rendered) => {
    if (rendered === 0) {
      console.error(
        expect === DEFAULT_EXPECT
          ? 'subject render produced no role="cell" elements — measurement is vacuous'
          : `subject render contains no element with ${expect} — measurement is vacuous`,
      )
      process.exit(1)
    }
    if (!markerScales) return
    if (rendered < minMarkers) {
      console.error(
        `subject rendered ${String(rendered)} × ${expect} but declares cells: ${String(cells)} (expected >= ${String(minMarkers)}) — ` +
          'the measurement does not scale with the declared work, so the number is a lie. ' +
          'Render the full declared workload, fix `cells` in tools/perf-budget.json, or (if the marker is a container rather than one-per-cell) set markerScales: false on the subject.',
      )
      process.exit(1)
    }
  }

  // Warmup: JIT + module init noise stays out of the measured runs.
  for (let i = 0; i < 2; i += 1) unmount(mount())
  const samples = []
  const updateSamples = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    const renderer = mount()
    samples.push(performance.now() - start)
    assertNotVacuous(countMarkers(renderer.toJSON(), prop, value))
    // UPDATE phase (0.1.2): re-render the SAME mounted tree with a changed
    // `tick` prop. Props differ on every update, so a memo bailout at the root
    // is impossible by construction — the timed window is a full reconciliation
    // pass over the mounted tree, the cost a mount-only benchmark never sees
    // (mount builds fibers; update diffs them). Subjects may ignore `tick`
    // entirely — receiving an unknown prop is free.
    const updateStart = performance.now()
    act(() => {
      renderer.update(React.createElement(PerfSubject, { cells, tick: i + 1 }))
    })
    updateSamples.push(performance.now() - updateStart)
    // The updated tree must still carry the scaled markers — an update that
    // blanked the workload would measure nothing.
    assertNotVacuous(countMarkers(renderer.toJSON(), prop, value))
    unmount(renderer)
  }

  process.stdout.write(`${JSON.stringify({ samples, updateSamples })}\n`)
}

try {
  main()
} catch (error) {
  console.error(`perf-subject-cli failed: ${error?.stack ?? error?.message ?? error}`)
  process.exit(1)
}
