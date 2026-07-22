import { useEffect, useRef, useState } from 'react'

// The measurement engine behind the dev perf-harness screen (app/perf-harness.tsx) —
// the on-device half of the interaction-latency floor. The budgets themselves live in
// tools/interaction-budget.json, which is NOT bundled (tools/ is harness machinery, not
// app surface): the CI device runner reads that file and hands the numbers to the screen
// through its deep link's query params, and DEFAULT_PROBE_BUDGETS mirrors the seeded file
// for a bare open. Keeping the transport at the URL seam means the app never grows an
// import edge into the harness's config tree.
//
// What is measured, and why it is honest:
//   tabSwitchMs   — the median commit latency of swapping one content subtree for another
//                   (the same render→commit path a tab switch pays), workload = the REAL
//                   actions ranking + row primitives the shipped modal renders.
//   actionsOpenMs — the median commit latency of a query change re-ranking the REAL
//                   command registry (rankCommands) and re-rendering the row list — the
//                   exact work opening/typing in the actions modal does.
//   frame drops   — requestAnimationFrame deltas collected over a fixed window while the
//                   workload re-renders every frame; a delta over ~2 frame budgets is a
//                   dropped frame (the list-scroll stall class).
// Wall clock on an emulator is a STEP-FUNCTION detector, never a drift ratchet — same
// doctrine as the startup budgets (tools/startup-budget.json).
// SOURCE: RAIL interaction-latency model — respond within ~100ms, animate at frame budget
// https://web.dev/articles/rail [corpus: harness/doctrine]

export interface ProbeBudgets {
  /** Median subtree-swap commit latency cap (ms). */
  readonly tabSwitchMs: number
  /** Median re-rank + re-render commit latency cap (ms). */
  readonly actionsOpenMs: number
  /** Dropped frames tolerated inside the frame window. */
  readonly frameDropMax: number
  /** Iterations per latency probe (median of N). */
  readonly runs: number
}

/** @public — test-facing seam API (the unit suite pins the fallback identity). Mirrors the seeded defaults. */
// Mirrors the seeded tools/interaction-budget.json (tabSwitchMs 400 / actionsOpenMs 600 /
// listScrollFrameDropMax 12 / runs 7) so a bare open measures against the same floor the
// CI lane enforces. The lane always passes explicit params, so a consumer who ratchets the
// JSON does not also have to ratchet this fallback for CI to see the new caps.
export const DEFAULT_PROBE_BUDGETS: ProbeBudgets = {
  tabSwitchMs: 400,
  actionsOpenMs: 600,
  frameDropMax: 12,
  runs: 7,
}

/** One frame at 60Hz is ~16.7ms; a delta past two budgets means at least one frame died. */
const FRAME_BUDGET_MS = 34
/** How many requestAnimationFrame deltas the frames phase collects. */
const FRAME_WINDOW = 30

type ParamValue = string | readonly string[] | undefined

function positiveNumber(raw: ParamValue, fallback: number): number {
  const text = typeof raw === 'string' || raw === undefined ? raw : raw[0]
  if (typeof text !== 'string' || text === '') return fallback
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Budgets from the deep link's query params (`perf-harness?tabSwitchMs=400&...`), falling
 * back per-field to the seeded defaults. Malformed input can only ever RELAX to the
 * defaults — a runner typo must not mint a 0ms cap that reds every run for a fake reason.
 */
export function parseProbeBudgets(params: Readonly<Record<string, ParamValue>>): ProbeBudgets {
  return {
    tabSwitchMs: positiveNumber(params['tabSwitchMs'], DEFAULT_PROBE_BUDGETS.tabSwitchMs),
    actionsOpenMs: positiveNumber(params['actionsOpenMs'], DEFAULT_PROBE_BUDGETS.actionsOpenMs),
    frameDropMax: positiveNumber(params['frameDropMax'], DEFAULT_PROBE_BUDGETS.frameDropMax),
    runs: Math.round(positiveNumber(params['runs'], DEFAULT_PROBE_BUDGETS.runs)),
  }
}

/** Median of the samples; NaN on an empty set (a verdict over nothing must not pass). @public — test-facing seam API. */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) return Number.NaN
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  // ?? NaN: unreachable by construction (length checked above), and NaN — not a
  // fabricated 0 — is what the fail-closed verdict must see if it ever were.
  const upper = sorted[mid] ?? Number.NaN
  if (sorted.length % 2 === 1) return upper
  return ((sorted[mid - 1] ?? Number.NaN) + upper) / 2
}

/** Frame deltas over the threshold each count the whole frames they overran. @public — test-facing seam API. */
export function countDroppedFrames(
  deltas: readonly number[],
  thresholdMs: number = FRAME_BUDGET_MS,
): number {
  let dropped = 0
  for (const delta of deltas) {
    if (delta > thresholdMs) dropped += Math.floor(delta / (thresholdMs / 2)) - 1
  }
  return dropped
}

/** One budget breach — pure data; the screen renders it through the catalog. @public — test-facing seam API. */
export interface ProbeFailure {
  readonly metric: 'tabSwitchMs' | 'actionsOpenMs' | 'droppedFrames'
  readonly measured: number
  readonly cap: number
}

/** @public — test-facing seam API (the verdict suite builds these directly). */
export interface ProbeMeasurements {
  readonly tabSwitchMs: number
  readonly actionsOpenMs: number
  readonly droppedFrames: number
}

/** @public — test-facing seam API (the screen suite mocks the hook with a literal report). */
export interface ProbeReport {
  readonly pass: boolean
  readonly failures: readonly ProbeFailure[]
  readonly measured: ProbeMeasurements
}

/**
 * The verdict. A NaN measurement FAILS its budget (a probe that never ran must never read
 * as green — the fail-closed twin of check-mobile-perf's missing-artifact rule).
 * @public — test-facing seam API.
 */
export function probeVerdict(budgets: ProbeBudgets, measured: ProbeMeasurements): ProbeReport {
  const failures: ProbeFailure[] = []
  const over = (value: number, cap: number): boolean => !(value <= cap)
  if (over(measured.tabSwitchMs, budgets.tabSwitchMs)) {
    failures.push({
      metric: 'tabSwitchMs',
      measured: measured.tabSwitchMs,
      cap: budgets.tabSwitchMs,
    })
  }
  if (over(measured.actionsOpenMs, budgets.actionsOpenMs)) {
    failures.push({
      metric: 'actionsOpenMs',
      measured: measured.actionsOpenMs,
      cap: budgets.actionsOpenMs,
    })
  }
  if (over(measured.droppedFrames, budgets.frameDropMax)) {
    failures.push({
      metric: 'droppedFrames',
      measured: measured.droppedFrames,
      cap: budgets.frameDropMax,
    })
  }
  return { pass: failures.length === 0, failures, measured }
}

/** @public — test-facing seam API (the hook suite narrows phases with it). */
export type ProbePhase = 'tab' | 'actions' | 'frames' | 'done'

export interface ProbeControls {
  readonly phase: ProbePhase
  /** Iteration counter — the screen derives its workload subtree/query from it. */
  readonly step: number
  /** Non-null exactly when phase === 'done'. */
  readonly report: ProbeReport | null
}

const now = (): number => globalThis.performance.now()

/**
 * The probe sequencer. Each latency phase marks a timestamp, bumps `step` (the screen
 * re-renders its workload from it), and reads the commit latency in the post-commit
 * effect; after `runs` samples it advances. The frames phase runs a requestAnimationFrame
 * loop (torn down in the effect cleanup) collecting FRAME_WINDOW deltas while the
 * workload keeps re-rendering, then computes the verdict.
 *
 * Budgets are FROZEN at mount (ref): the measurement is one-shot, and a caller
 * passing a fresh object literal per render must not tear down the in-flight
 * frames loop through the effect's dependency identity.
 */
export function usePerfProbes(budgets: ProbeBudgets): ProbeControls {
  const [phase, setPhase] = useState<ProbePhase>('tab')
  const [step, setStep] = useState(0)
  const [report, setReport] = useState<ProbeReport | null>(null)
  const budgetsRef = useRef(budgets)
  const markRef = useRef<number | null>(null)
  const samplesRef = useRef<{ tab: number[]; actions: number[] }>({ tab: [], actions: [] })

  // Latency phases. This effect runs AFTER the commit `step` caused, so
  // now() - mark is the render→commit cost of that workload change.
  useEffect(() => {
    if (phase !== 'tab' && phase !== 'actions') return
    const samples = phase === 'tab' ? samplesRef.current.tab : samplesRef.current.actions
    if (markRef.current !== null) samples.push(now() - markRef.current)
    if (samples.length >= budgetsRef.current.runs) {
      markRef.current = null
      setStep(0)
      setPhase(phase === 'tab' ? 'actions' : 'frames')
      return
    }
    markRef.current = now()
    setStep((current) => current + 1)
  }, [phase, step])

  // Frames phase — a SEPARATE effect that deliberately does NOT depend on `step`:
  // its ticks bump `step` to force workload commits, and re-running the effect on
  // each bump would tear down the loop and reset the deltas it is collecting.
  useEffect(() => {
    if (phase !== 'frames') return
    const deltas: number[] = []
    let last = now()
    let handle = 0
    const tick = (): void => {
      const at = now()
      deltas.push(at - last)
      last = at
      if (deltas.length >= FRAME_WINDOW) {
        const samples = samplesRef.current
        setReport(
          probeVerdict(budgetsRef.current, {
            tabSwitchMs: median(samples.tab),
            actionsOpenMs: median(samples.actions),
            droppedFrames: countDroppedFrames(deltas),
          }),
        )
        setPhase('done')
        return
      }
      // Re-render the workload every frame so the deltas price real commits.
      setStep((current) => current + 1)
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(handle)
    }
  }, [phase])

  return { phase, step, report }
}
