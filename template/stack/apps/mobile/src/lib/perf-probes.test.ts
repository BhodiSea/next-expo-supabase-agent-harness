// The perf-probe engine (jest, not the pure vitest lane: the sequencer is a React hook
// and the render loop is the thing under test). The pure halves — parsing, median,
// frame arithmetic, the verdict — are pinned first; then the hook is driven through a
// real render to 'done' and to both verdict polarities. The FAIL leg matters most: a
// perf marker nobody has ever seen go red is indistinguishable from no marker at all.
import { renderHook, waitFor } from '@testing-library/react-native'
import {
  countDroppedFrames,
  DEFAULT_PROBE_BUDGETS,
  median,
  parseProbeBudgets,
  probeVerdict,
  usePerfProbes,
} from './perf-probes'

describe('parseProbeBudgets', () => {
  it('reads explicit params and rounds runs', () => {
    expect(
      parseProbeBudgets({
        tabSwitchMs: '250',
        actionsOpenMs: '500',
        frameDropMax: '8',
        runs: '5.4',
      }),
    ).toEqual({ tabSwitchMs: 250, actionsOpenMs: 500, frameDropMax: 8, runs: 5 })
  })

  it('falls back per-field to the seeded defaults on absent, empty, or malformed input', () => {
    expect(parseProbeBudgets({})).toEqual(DEFAULT_PROBE_BUDGETS)
    expect(
      parseProbeBudgets({ tabSwitchMs: '', actionsOpenMs: 'soon', frameDropMax: '-3', runs: '0' }),
    ).toEqual(DEFAULT_PROBE_BUDGETS)
  })

  it('takes the first value of a repeated param', () => {
    expect(parseProbeBudgets({ runs: ['3', '9'] }).runs).toBe(3)
  })
})

describe('median', () => {
  it('answers the middle sample (odd) and the midpoint (even)', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('is NaN over nothing — an unmeasured probe must not read as a number', () => {
    expect(Number.isNaN(median([]))).toBe(true)
  })
})

describe('countDroppedFrames', () => {
  it('counts nothing while every delta stays under the threshold', () => {
    expect(countDroppedFrames([16, 17, 33, 34])).toBe(0)
  })

  it('prices a long delta by the whole frames it overran', () => {
    // 35ms over a 34ms threshold: floor(35 / 17) - 1 = 1 dropped frame.
    expect(countDroppedFrames([35])).toBe(1)
    // A 300ms stall at 60Hz is a pile of dead frames, not one.
    expect(countDroppedFrames([300])).toBeGreaterThanOrEqual(15)
  })
})

describe('probeVerdict', () => {
  const budgets = { tabSwitchMs: 400, actionsOpenMs: 600, frameDropMax: 12, runs: 7 }

  it('passes exactly AT every cap (budgets are ceilings, not open bounds)', () => {
    const report = probeVerdict(budgets, {
      tabSwitchMs: 400,
      actionsOpenMs: 600,
      droppedFrames: 12,
    })
    expect(report.pass).toBe(true)
    expect(report.failures).toHaveLength(0)
  })

  it('names each breached metric with the measured value and its cap', () => {
    const report = probeVerdict(budgets, {
      tabSwitchMs: 401,
      actionsOpenMs: 599,
      droppedFrames: 13,
    })
    expect(report.pass).toBe(false)
    expect(report.failures).toEqual([
      { metric: 'tabSwitchMs', measured: 401, cap: 400 },
      { metric: 'droppedFrames', measured: 13, cap: 12 },
    ])
  })

  it('FAILS CLOSED on a NaN measurement — a probe that never ran is not a pass', () => {
    const report = probeVerdict(budgets, {
      tabSwitchMs: Number.NaN,
      actionsOpenMs: 1,
      droppedFrames: 0,
    })
    expect(report.pass).toBe(false)
    expect(report.failures[0]?.metric).toBe('tabSwitchMs')
  })
})

describe('usePerfProbes', () => {
  it('walks tab → actions → frames to a PASSING report under generous budgets', async () => {
    const { result } = renderHook(() =>
      usePerfProbes({ tabSwitchMs: 10_000, actionsOpenMs: 10_000, frameDropMax: 10_000, runs: 2 }),
    )
    await waitFor(
      () => {
        expect(result.current.phase).toBe('done')
      },
      { timeout: 15_000 },
    )
    expect(result.current.report?.pass).toBe(true)
    expect(result.current.report?.measured.tabSwitchMs).toBeGreaterThanOrEqual(0)
    expect(result.current.report?.measured.actionsOpenMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a FAILING verdict on slow commits — the marker can go red', async () => {
    // Deterministic slowness: under jest the wall clock between two effect
    // flushes can quantize to 0ms, so the fail leg drives a monotonic
    // performance.now advancing 500ms per read — every latency sample measures
    // 500ms+ against a 400ms cap, whatever the host's real speed.
    let tick = 0
    const spy = jest.spyOn(globalThis.performance, 'now').mockImplementation(() => (tick += 500))
    try {
      const { result } = renderHook(() =>
        usePerfProbes({
          tabSwitchMs: 400,
          actionsOpenMs: 10_000_000,
          frameDropMax: 10_000,
          runs: 2,
        }),
      )
      await waitFor(
        () => {
          expect(result.current.phase).toBe('done')
        },
        { timeout: 15_000 },
      )
      expect(result.current.report?.pass).toBe(false)
      expect(result.current.report?.failures.map((f) => f.metric)).toContain('tabSwitchMs')
    } finally {
      spy.mockRestore()
    }
  })
})
