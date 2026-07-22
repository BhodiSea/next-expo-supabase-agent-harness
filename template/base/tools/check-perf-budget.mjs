#!/usr/bin/env node
// Gate: perf-budget — a floor gate from this harness's first release.
//
// Median-of-N render budget over REAL feature subjects: N runs after warmup measure
// the wall time of a full react-test-renderer mount and assert the MEDIAN against
// tools/perf-budget.json (write-guard-protected — raising the budget is a reviewed
// human decision). Median over mean: runners spike; a single GC pause must not
// flake the gate, but a real regression shifts the median. Belt and braces, the
// gate RE-MEASURES ONCE before failing — a red requires two independent
// over-budget medians, so scheduler noise cannot fail a turn while a genuine 10x
// regression still cannot pass.
//
// ONE budget shape: subjects: [{ subject, cells, medianBudgetMs, expect? }] under
// a shared top-level `runs` (one measurement protocol per budget: medians stay
// comparable across subjects, and the re-measure-once discipline is calibrated to
// N). The desktop-era original carried two legacy shapes and a synthetic
// server-rendered fixture for the consumers that predated its subjects[] form;
// this harness ships subjects[] as its FLOOR — there are no older installs to
// ramp, so a legacy key and a missing subjects[] are both contract FAILs and no
// synthetic fallback exists at all. The subjects[] shape also arms the
// DENSE-FEATURE CLOSURE scan: every apps/mobile/src/features/* dir that imports
// the keyset-paged data hook (useKeysetQuery) must ship a perfSubject declared in
// subjects[], every declared file must exist, and every features/*/perfSubject.tsx
// must be declared — a dense screen nobody measures is the green-but-bad path this
// gate exists to close. `exempt: [{ dir, reason }]` is the reviewed escape (the
// rls-exempt pattern; malformed entries FAIL, never fail open).
//
// One measurement = one CLI spawn: process.execPath runs
// tools/lib/perf-subject-cli.mjs, which mounts the subject's real component graph
// under react-test-renderer with the app's own babel preset (no second transform
// pipeline; see the CLI header for the module-mock layer). A missing subject
// file, spawn failure, malformed CLI output, or a vacuous render (the per-subject
// `expect` marker — default role="cell" — absent from the mounted tree, or not
// scaling with the declared cells) is a hard FAIL with a named reason — NEVER a
// silent fallback to a synthetic path.
//
// This is deliberately a RELATIVE canary, not a UX metric: it catches "someone
// made cell rendering 5× slower" in the validate chain, cheaply, with no emulator.
// Budgets ship ~10× above a fresh-scaffold median so real features fit; the
// ABSOLUTE UX numbers (startup, on-device flows) live in the CI-only device lane
// (tools/check-mobile-perf.mjs closure + the Maestro perf job), never inside this
// chain.
// SOURCE: docs/harness/gates-catalog.md (perf-budget gate) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, MAX_BUFFER, ok, skipOrFail } from './lib/gate.mjs'
import { blankComments, lineOf, skipBalanced } from './lib/source-text.mjs'

const GATE = 'perf-budget'
const BUDGET_PATH = 'tools/perf-budget.json'
// Both roots carry components with effects: src/ (features, components, lib) and
// app/ (the router's route files are React components too — a leaked listener in
// a route effect is the MOST likely place, since routes mount and unmount on
// every navigation).
const SCAN_ROOTS = ['apps/mobile/src', 'apps/mobile/app']
const FEATURES_DIR = 'apps/mobile/src/features'
const WORKED_SUBJECT = 'apps/mobile/src/features/matrix/perfSubject.tsx'
const DEFAULT_EXPECT = 'role="cell"'

if (!existsSync('apps/mobile/package.json'))
  skipOrFail(GATE, 'apps/mobile not found (no mobile surface yet)')
if (!existsSync(BUDGET_PATH)) {
  fail(GATE, `${BUDGET_PATH} missing — the render budget must exist as reviewable data; restore it`)
}
let budget
try {
  budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
} catch (e) {
  fail(GATE, `${BUDGET_PATH} is not valid JSON (${e.message}) — the budget must be reviewable data`)
}

// ---- leak discipline ------------------------------------------------------------
// Runs before any measurement: a leak is a performance defect no render benchmark
// can see. An effect that subscribes and never unsubscribes is the canonical React
// leak: every mount adds a listener, every unmount leaves it, and the cost is
// invisible in a render benchmark (which mounts once) and invisible in the e2e
// suite (which never navigates back). It shows up only in a long session, as the
// thing users call "it gets slow after a while" — and on this host the app LIVES
// in long sessions: mobile apps background and foreground for days between cold
// starts, so an unremoved AppState or Keyboard listener compounds far longer than
// any browser tab would have let it.
//
// This is the AGENT-TIME half — a structural scan, deterministic, no emulator. The
// CI half (the jest-expo emitter-count spec) counts live listeners across a
// mount/unmount loop and catches leaks whose shape this scan cannot see.
//
// The rule: an effect that REGISTERS something must TEAR IT DOWN in the cleanup it
// returns. Pairs are matched by name, and the teardown must appear inside the
// returned cleanup — not merely somewhere in the effect, or `return () => {}`
// would satisfy it.
//
// The pair set is this host's registration surface (the desktop-era original's
// DOM Observer pair — Mutation/Resize/Intersection/Performance — has no
// react-native equivalent and is dropped):
//   • .addEventListener  → .removeEventListener OR .remove() — RN's AppState,
//     Dimensions and Linking all RETURN an EventSubscription whose .remove() is
//     the documented teardown.
//     SOURCE: AppState.addEventListener returns a subscription; call .remove()
//     in the effect cleanup https://reactnative.dev/docs/appstate
//   • .addListener       → .remove() — Keyboard.addListener (and the navigation
//     emitters) return a subscription with .remove().
//     SOURCE: Keyboard.addListener → subscription.remove()
//     https://reactnative.dev/docs/keyboard
//   • setInterval        → clearInterval
//   • requestAnimationFrame → cancelAnimationFrame
//   • .subscribe(        → .unsubscribe() / .remove() / .close()
//   • runAfterInteractions → .cancel() — InteractionManager handles are
//     cancellable promises; an uncancelled handle runs after unmount and pins
//     everything its closure captured.
//     SOURCE: InteractionManager.runAfterInteractions returns a cancellable
//     handle https://reactnative.dev/docs/interactionmanager
const LEAK_PAIRS = [
  {
    register: /\.addEventListener\s*\(/,
    teardown: /\.removeEventListener\s*\(|\.remove\s*\(/,
    what: 'addEventListener',
    fix: "removeEventListener (or .remove() on the returned subscription — RN's AppState/Dimensions/Linking form)",
  },
  {
    register: /\.addListener\s*\(/,
    teardown: /\.remove\s*\(|\.removeAllListeners\s*\(/,
    what: '.addListener(',
    fix: '.remove() on the returned subscription',
  },
  {
    register: /\bsetInterval\s*\(/,
    teardown: /\bclearInterval\s*\(/,
    what: 'setInterval',
    fix: 'clearInterval',
  },
  {
    register: /\brequestAnimationFrame\s*\(/,
    teardown: /\bcancelAnimationFrame\s*\(/,
    what: 'requestAnimationFrame',
    fix: 'cancelAnimationFrame',
  },
  {
    register: /\.subscribe\s*\(/,
    teardown: /\.unsubscribe\s*\(|\.remove\s*\(|\.close\s*\(/,
    what: '.subscribe(',
    fix: ".unsubscribe() (or the subscription's own .remove()/.close())",
  },
  {
    register: /\brunAfterInteractions\s*\(/,
    teardown: /\.cancel\s*\(/,
    what: 'InteractionManager.runAfterInteractions',
    fix: '.cancel() on the returned handle',
  },
]

// The cleanup is whatever the effect RETURNS. Find the first top-level `return` inside the
// effect body and take everything from there to the body's end: a returned arrow, a
// returned function expression, or a returned identifier (a teardown handed back directly,
// e.g. `return unsubscribe`) all fall inside that slice.
function cleanupSliceOf(body) {
  const at = body.search(/\breturn\b/)
  return at === -1 ? null : body.slice(at)
}

/**
 * The effect bodies in a source file, comments already blanked. useFocusEffect is
 * in the set alongside useEffect/useLayoutEffect: on this host it is the idiomatic
 * place to register screen-scoped listeners (it fires on focus, cleans up on
 * blur), so exempting it would exempt exactly the effects most likely to register
 * something.
 */
function effectBodies(text) {
  const bodies = []
  for (const m of text.matchAll(/\buse(?:Effect|LayoutEffect|FocusEffect)\s*\(/g)) {
    const open = text.indexOf('(', m.index)
    const callEnd = skipBalanced(text, open)
    const brace = text.indexOf('{', open)
    if (brace === -1 || brace > callEnd) continue // concise-body effect: nothing to register
    bodies.push({ body: text.slice(brace, skipBalanced(text, brace)), index: m.index })
  }
  return bodies
}

/** The pairs this effect body REGISTERS but never tears down in the cleanup it RETURNS. */
function unpairedIn(body) {
  const cleanup = cleanupSliceOf(body)
  return LEAK_PAIRS.filter(
    (pair) => pair.register.test(body) && !(cleanup !== null && pair.teardown.test(cleanup)),
  )
}

function leaksInFile(path) {
  // Comments blanked FIRST: a `removeEventListener` named only in a comment must never
  // satisfy this check (the styleguide gate's lineage shipped exactly that fail-open once).
  const text = blankComments(readFileSync(path, 'utf8'))
  const errs = []
  for (const { body, index } of effectBodies(text)) {
    for (const pair of unpairedIn(body)) {
      errs.push(
        `${path}:${lineOf(text, index)}: this effect registers ${pair.what} but its cleanup never calls ${pair.fix} — every mount adds one and every unmount leaves it behind, so the listener set grows without bound for as long as the app runs (and a mobile app runs for days between cold starts). A render benchmark mounts once and the fast e2e lane never navigates back, so NOTHING else in the chain can see this. FIX: return a cleanup function from the effect that calls ${pair.fix}; or, if this registration genuinely outlives the component by design, add a reviewed {"file": "${path}", "reason": …} entry to ${BUDGET_PATH} effectCleanupAllow[]`,
      )
    }
  }
  return errs
}

function scanEffectLeaks(allowFiles) {
  const errs = []
  for (const root of SCAN_ROOTS) {
    const files = walkFiles(root, {
      excludeDirs: new Set(['node_modules']),
      filter: (rel) => /\.tsx?$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel),
    })
    for (const rel of files) {
      const path = `${root}/${rel}`
      if (!allowFiles.has(path)) errs.push(...leaksInFile(path))
    }
  }
  return errs
}

// Reviewed escape (the rls-exempt pattern): a malformed or stale entry FAILS, never opens.
const leakAllow = new Set()
if (budget.effectCleanupAllow !== undefined) {
  if (!Array.isArray(budget.effectCleanupAllow)) {
    fail(
      GATE,
      `${BUDGET_PATH} "effectCleanupAllow" must be an ARRAY of { "file": path, "reason": non-empty string } entries — got ${JSON.stringify(budget.effectCleanupAllow)}`,
    )
  }
  for (const entry of budget.effectCleanupAllow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.file === 'string' &&
      entry.file.trim() !== '' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${BUDGET_PATH}: every effectCleanupAllow entry must be { "file": repo-relative path, "reason": non-empty string } — got ${JSON.stringify(entry)}`,
      )
    }
    if (!existsSync(entry.file)) {
      fail(
        GATE,
        `${BUDGET_PATH} effectCleanupAllow names "${entry.file}", which does not exist — stale exemption; remove it (a stale escape is a loaded gun aimed at the next file to take that path)`,
      )
    }
    leakAllow.add(entry.file)
  }
}

// Turn-fatal from the first release: unlike the desktop-era original (which
// version-ramped this scan over consumers that predated it), every install of
// THIS harness was born with the leak bar — there is nothing to ramp.
failures(
  GATE,
  scanEffectLeaks(leakAllow),
  '  Leak discipline: an effect that registers a listener/timer/frame/subscription must tear it down in the cleanup it returns (see docs/harness/gates-catalog.md "perf-budget").',
)

// ---- real-subject measurement ---------------------------------------------------
const cliAbs = fileURLToPath(new URL('./lib/perf-subject-cli.mjs', import.meta.url))

// One measurement = one CLI spawn: process.execPath (the running node) executes the
// CLI directly — no shell, no package-manager shims (the desktop-era gate needed
// shell:true only to reach a .cmd bin shim on Windows; a node child has no shim, so
// argv passes through unquoted on every platform). Any non-zero exit or unusable
// stdout is a FAIL — the gate never quietly substitutes a synthetic measurement.
// `expect` (the per-subject anti-vacuity marker) travels via the
// PERF_SUBJECT_EXPECT environment variable, not argv — markers carry quotes
// (role="cell") and the env channel is immune to any future quoting regression.
function measureViaSubject(subjectRel, cells, runs, expect, markerScales) {
  const subjectAbs = resolve(process.cwd(), subjectRel)
  // markerScales: the CLI asserts the marker count SCALES with `cells`, not merely
  // that it is present — a one-row subject would otherwise "pass" the budget in
  // ~1 ms. A subject whose marker is a per-render container rather than per-cell
  // opts out with `markerScales: false`, and takes the weaker presence-only
  // guarantee.
  const env = { ...process.env }
  if (expect !== undefined) env.PERF_SUBJECT_EXPECT = expect
  if (markerScales === false) env.PERF_SUBJECT_MARKER_SCALES = '0'
  const res = spawnSync(process.execPath, [cliAbs, subjectAbs, String(cells), String(runs)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env,
  })
  if (res.error) {
    fail(
      GATE,
      `could not spawn the perf subject CLI (${res.error.message}) — the gate never falls back to a synthetic measurement`,
    )
  }
  if (res.status !== 0) {
    const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-4).join(' | ')
    fail(
      GATE,
      `the real perf subject failed to measure (exit ${res.status}) via \`node tools/lib/perf-subject-cli.mjs ${subjectRel}\`: ${detail} — fix the subject or run pnpm install; the gate never falls back to a synthetic measurement`,
    )
  }
  let parsed
  for (const line of (res.stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      parsed = JSON.parse(t)
    } catch {
      /* not the samples line — keep scanning */
    }
  }
  const isSampleRun = (arr) =>
    Array.isArray(arr) &&
    arr.length === runs &&
    arr.every((s) => typeof s === 'number' && Number.isFinite(s))
  const okShape =
    parsed !== undefined && isSampleRun(parsed.samples) && isSampleRun(parsed.updateSamples)
  if (!okShape) {
    fail(
      GATE,
      `the perf subject CLI did not emit a valid {"samples":[…],"updateSamples":[…]} line of ${runs} numbers each (stdout: ${JSON.stringify((res.stdout ?? '').slice(0, 200))}) — measurement is unusable`,
    )
  }
  const medianOf = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]
  return {
    median: medianOf(parsed.samples),
    samples: parsed.samples,
    updateMedian: medianOf(parsed.updateSamples),
    updateSamples: parsed.updateSamples,
  }
}

// Median-of-runs with the re-measure-once discipline, parameterized by subject
// entry; fails the gate on two independent over-budget medians (mount and —
// when the entry declares medianUpdateBudgetMs — update each get the
// discipline), otherwise returns the human-readable detail line. The update
// median is always MEASURED and printed; it is asserted only when budgeted, so
// an entry without the key keeps prior red/green behavior exactly.
/** @param {{ subject: string, cells: number, runs: number, medianBudgetMs: number, medianUpdateBudgetMs?: number, expect?: string, markerScales?: boolean }} entry */
function measureWithRetry({
  subject,
  cells,
  runs,
  medianBudgetMs,
  medianUpdateBudgetMs,
  expect,
  markerScales,
}) {
  let measured = measureViaSubject(subject, cells, runs, expect, markerScales)
  const overBudget = () =>
    measured.median > medianBudgetMs ||
    (medianUpdateBudgetMs !== undefined && measured.updateMedian > medianUpdateBudgetMs)
  let retried = false
  if (overBudget()) {
    // One full re-measure before failing: two independent over-budget medians
    // cannot both be scheduler noise.
    retried = true
    measured = measureViaSubject(subject, cells, runs, expect, markerScales)
  }
  const updateBudgetNote =
    medianUpdateBudgetMs === undefined ? '' : ` (budget ${medianUpdateBudgetMs}ms)`
  const detail = `subject ${subject}, ${cells} cells, ${runs} runs${retried ? ' (re-measured once)' : ''}: median ${measured.median.toFixed(1)}ms (budget ${medianBudgetMs}ms; samples ${measured.samples.map((s) => s.toFixed(0)).join('/')}ms), update median ${measured.updateMedian.toFixed(1)}ms${updateBudgetNote}`
  if (overBudget()) {
    const which =
      measured.median > medianBudgetMs ? 'render (mount) cost' : 'update (re-render) cost'
    fail(
      GATE,
      `${detail} — ${which} regressed past the budget twice in a row. Find the regression (or, after a DELIBERATE change to the subject, re-baseline ${BUDGET_PATH} in a reviewed commit).`,
    )
  }
  return detail
}

// ---- shape contract -------------------------------------------------------------
// ONE shape, checked by key PRESENCE so a malformed value gets the right contract
// error. A singular "subject" key is the desktop-era legacy spelling — it never
// existed on this harness, so name the current form instead of guessing intent.
if (budget.subject !== undefined) {
  fail(
    GATE,
    `${BUDGET_PATH} declares a singular "subject" key — this harness has no legacy single-subject shape. Declare subjects: [{ "subject": path, "cells": n, "medianBudgetMs": n }] and delete "subject".`,
  )
}
if (budget.subjects === undefined) {
  fail(
    GATE,
    `${BUDGET_PATH} must declare subjects: [{ "subject": path, "cells": n, "medianBudgetMs": n }] — a budget with no measured subject is a vacuous pass (worked pattern: ${WORKED_SUBJECT})`,
  )
}

const { runs } = budget
if (typeof runs !== 'number' || runs <= 0) {
  fail(
    GATE,
    `${BUDGET_PATH} must carry a positive number for runs (shared by every subjects[] entry — one measurement protocol per budget)`,
  )
}
const ENTRY_SHAPE =
  '{ "subject": non-empty string, "cells": positive number, "medianBudgetMs": positive number, "medianUpdateBudgetMs"?: positive number, "expect"?: non-empty string }'
if (!Array.isArray(budget.subjects) || budget.subjects.length === 0) {
  fail(
    GATE,
    `${BUDGET_PATH} "subjects" must be a NON-EMPTY array of ${ENTRY_SHAPE} — an empty measurement list is a vacuous pass (worked pattern: ${WORKED_SUBJECT})`,
  )
}
for (const entry of budget.subjects) {
  const okShape =
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.subject === 'string' &&
    entry.subject.trim() !== '' &&
    typeof entry.cells === 'number' &&
    entry.cells > 0 &&
    typeof entry.medianBudgetMs === 'number' &&
    entry.medianBudgetMs > 0 &&
    (entry.medianUpdateBudgetMs === undefined ||
      (typeof entry.medianUpdateBudgetMs === 'number' && entry.medianUpdateBudgetMs > 0)) &&
    (entry.expect === undefined ||
      (typeof entry.expect === 'string' && entry.expect.trim() !== '')) &&
    (entry.markerScales === undefined || typeof entry.markerScales === 'boolean')
  if (!okShape) {
    fail(
      GATE,
      `${BUDGET_PATH}: every subjects[] entry must be ${ENTRY_SHAPE} — got ${JSON.stringify(entry)}`,
    )
  }
}
const declared = new Set()
for (const entry of budget.subjects) {
  if (declared.has(entry.subject)) {
    fail(
      GATE,
      `${BUDGET_PATH} subjects[] declares "${entry.subject}" twice — one budget per subject; remove the duplicate`,
    )
  }
  declared.add(entry.subject)
}

// Exemptions — the ONE escape hatch for the closure rule below, so its parse
// fails LOUD, never open (the rls-exempt pattern). `dir` is the bare feature
// directory NAME under apps/mobile/src/features/, not a path.
const exemptDirs = new Set()
if (budget.exempt !== undefined) {
  if (!Array.isArray(budget.exempt)) {
    fail(
      GATE,
      `${BUDGET_PATH} "exempt" must be an ARRAY of { "dir": feature dir name, "reason": non-empty string } entries — got ${JSON.stringify(budget.exempt)}`,
    )
  }
  for (const entry of budget.exempt) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.dir === 'string' &&
      entry.dir.trim() !== '' &&
      !entry.dir.includes('/') &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${BUDGET_PATH}: every exemption must be { "dir": feature dir NAME under ${FEATURES_DIR}/ (no slashes), "reason": non-empty string } — got ${JSON.stringify(entry)}`,
      )
    }
    exemptDirs.add(entry.dir)
  }
}

// ---- dense-feature closure ------------------------------------------------------
// Detection is TEXTUAL, pinned to `from '<...>'` module specifiers whose basename
// is the keyset-paged data hook — tolerant of relative-path variants
// (./useKeysetQuery, ../matrix/useKeysetQuery, an alias ending in /useKeysetQuery)
// and optional extensions, and it covers both import and re-export statements.
// Limits, honestly: no AST — a commented-out import or a string literal containing
// such a specifier still counts as dense (over-detection reds with `exempt` as the
// reviewed escape; it can never fail-open green), and a feature reaching the hook
// only through a barrel re-export in ANOTHER dir is not detected — the inverse
// closure (every features/*/perfSubject must be declared) still covers such
// features once they ship a subject.
const DENSE_IMPORT = /\bfrom\s*(['"])(?:[^'"]*\/)?useKeysetQuery(?:\.[cm]?[tj]sx?)?\1/

// Density is a SHAPE, not an import name. A dense screen that never touches the
// keyset hook — a hand-tuned virtualized list, a masonry list, an imperative
// canvas — is exactly as capable of regressing as one that does. These STRUCTURAL
// signals catch the shape instead of the spelling:
//   • getItemLayout — the prop a virtualized list declares so it can place any
//     index without measuring. Nothing else has a reason to declare it: it IS the
//     fixed-row dense-list tell on this host.
//     SOURCE: getItemLayout on FlatList (VirtualizedList family)
//     https://reactnative.dev/docs/flatlist#getitemlayout
//   • FlashList — the recycling list; reached for precisely when a plain list is
//     too slow, i.e. when the screen is dense by admission.
//   • react-native-skia — an imperative paint surface, dense by construction.
// Extensible as reviewable data: `densitySignals: ["regex-source", …]` in
// perf-budget.json. Over-detection reds with `exempt[]` as the reviewed escape; it
// can never fail open. Turn-fatal from the first release (no older installs to
// ramp — see the leak-scan note above).
const DEFAULT_DENSITY_SIGNALS = [
  String.raw`\bgetItemLayout\b`,
  String.raw`\bFlashList\b`,
  String.raw`react-native-skia`,
]
const configured = budget.densitySignals
if (configured !== undefined && !Array.isArray(configured)) {
  fail(
    GATE,
    `${BUDGET_PATH} densitySignals must be an ARRAY of regex-source strings — got ${JSON.stringify(configured)}`,
  )
}
const signalSources = (configured ?? DEFAULT_DENSITY_SIGNALS).map((s) => {
  if (typeof s !== 'string' || s === '') {
    fail(GATE, `${BUDGET_PATH} densitySignals entries must be non-empty regex-source strings`)
  }
  return s
})
const DENSITY_SIGNALS = signalSources.map((s) => new RegExp(s))
// A consumer without a features/ tree has nothing to scan: the closure below
// no-ops and only the declared-file existence check applies.
const featureDirs = existsSync(FEATURES_DIR)
  ? readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : []
const errs = []
for (const entry of budget.subjects) {
  if (!existsSync(resolve(process.cwd(), entry.subject))) {
    errs.push(
      `subjects[] declares "${entry.subject}" but the file does not exist — restore it or remove the entry; harness exemplars can be pulled with \`npx next-expo-supabase-agent-harness update --refresh-seeded <path>\``,
    )
  }
}
for (const dirName of featureDirs) {
  if (exemptDirs.has(dirName)) continue // reviewed escape — skips both closure directions
  const dirRel = `${FEATURES_DIR}/${dirName}`
  const files = walkFiles(dirRel, {
    excludeDirs: new Set(['node_modules']),
    filter: (rel) => /\.tsx?$/.test(rel),
  })
  const sources = files.map((rel) => readFileSync(`${dirRel}/${rel}`, 'utf8'))
  const denseByHook = sources.some((src) => DENSE_IMPORT.test(src))
  const matchedSignals = DENSITY_SIGNALS.filter((re) => sources.some((src) => re.test(src)))
  const denseByShape = matchedSignals.length > 0
  // The subject is a component, so .tsx is the worked spelling; .ts is accepted
  // for a subject that builds its elements without JSX.
  const subjectRel = [`${dirRel}/perfSubject.tsx`, `${dirRel}/perfSubject.ts`].find((p) =>
    existsSync(p),
  )
  const hasSubjectFile = subjectRel !== undefined
  if (denseByHook && !hasSubjectFile) {
    errs.push(
      `${dirRel}/ imports useKeysetQuery (data-dense by doctrine) but ships NO perfSubject.tsx — a dense screen nobody measures is a silent regression farm. FIX: create ${dirRel}/perfSubject.tsx exporting a PerfSubject({ cells }) component that materializes every cell with a countable role (worked pattern: ${WORKED_SUBJECT}), declare it in ${BUDGET_PATH} subjects[] with its cells + medianBudgetMs, or exempt "${dirName}" with a reviewed reason in ${BUDGET_PATH} exempt[]`,
    )
  } else if (denseByShape && !hasSubjectFile) {
    errs.push(
      `${dirRel}/ is data-dense by SHAPE (${matchedSignals.map((re) => re.source).join(', ')}) but ships NO perfSubject.tsx — density is a shape, not an import name: a screen that declares getItemLayout, recycles through FlashList, or paints a canvas is exactly as capable of regressing as one that imports the keyset hook. FIX: create ${dirRel}/perfSubject.tsx (worked pattern: ${WORKED_SUBJECT}) and declare it in ${BUDGET_PATH} subjects[], or exempt "${dirName}" with a reviewed reason in ${BUDGET_PATH} exempt[]`,
    )
  }
  if (hasSubjectFile && !declared.has(subjectRel)) {
    errs.push(
      `${subjectRel} exists but is not declared in ${BUDGET_PATH} subjects[] — an unmeasured subject is decoration; add { "subject": "${subjectRel}", "cells": …, "medianBudgetMs": … } (or exempt "${dirName}" with a reviewed reason)`,
    )
  }
}
for (const dirName of [...exemptDirs].sort()) {
  if (!featureDirs.includes(dirName)) {
    errs.push(
      `${BUDGET_PATH} exempts feature dir "${dirName}" but ${FEATURES_DIR}/${dirName}/ does not exist — stale exemption; remove it`,
    )
  }
}

failures(
  GATE,
  errs,
  `  Dense-feature closure: every ${FEATURES_DIR}/* dir that is data-dense — by importing useKeysetQuery, or by SHAPE (getItemLayout / FlashList / react-native-skia) — ships a measured perfSubject.tsx (see docs/harness/gates-catalog.md "perf-budget").`,
)

// Closure holds — measure every declared subject sequentially (never in
// parallel: these are wall-clock medians and CPU contention would flake them).
const details = budget.subjects.map((entry) =>
  measureWithRetry({
    subject: entry.subject,
    cells: entry.cells,
    runs,
    medianBudgetMs: entry.medianBudgetMs,
    medianUpdateBudgetMs: entry.medianUpdateBudgetMs,
    expect: entry.expect ?? DEFAULT_EXPECT,
    markerScales: entry.markerScales,
  }),
)
ok(GATE, details.join('; '))
