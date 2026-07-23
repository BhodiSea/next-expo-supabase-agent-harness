// The dev perf-harness screen — the surface the CI device lane deep-links into and
// asserts by leaf testID. The PASS leg drives the REAL router + REAL probes exactly the
// way the lane's deep link arrives (budget params on the URL, the actions-registry
// workload committing for real). The FAIL leg pins the screen's RENDER contract with
// the hook mocked to a failing report: the probes' own can-fail proof lives in
// perf-probes.test.ts (a monotonic-clock fail leg — a global performance.now mock
// under the full router tree wedges React's scheduler, measured, so the two halves
// are proven where each is provable). The on-emulator fail proof is the selftest
// busy-loop canary.
import { renderRouter, screen } from 'expo-router/testing-library'
import { usePerfProbes } from '../src/lib/perf-probes'
import { mockSupabaseClient } from '../src/testing/mock-supabase'

// The root layout mounts the Supabase provider, and the real one constructs a
// keychain-backed client over native modules jest only stubs. The harness route
// makes no API call at all, so the auth seam is substituted and the procedure
// seam is deliberately NOT installed — an unstubbed procedure throws, which is
// the assertion that this screen stays network-free.
jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))

// Delegates to the real hook unless a test overrides it for the render-contract leg.
jest.mock('../src/lib/perf-probes', () => {
  const actual =
    jest.requireActual<typeof import('../src/lib/perf-probes')>('../src/lib/perf-probes')
  return { ...actual, usePerfProbes: jest.fn(actual.usePerfProbes) }
})

const mockedProbes = jest.mocked(usePerfProbes)

afterEach(() => {
  mockedProbes.mockReset()
  const actual =
    jest.requireActual<typeof import('../src/lib/perf-probes')>('../src/lib/perf-probes')
  mockedProbes.mockImplementation(actual.usePerfProbes)
})

describe('perf-harness screen (dev chrome)', () => {
  it('measures against generous budgets and surfaces the perf-pass leaf marker', async () => {
    renderRouter('./app', {
      initialUrl:
        '/perf-harness?tabSwitchMs=100000&actionsOpenMs=100000&frameDropMax=100000&runs=2',
    })
    await screen.findByTestId('perf-harness-screen')
    // The probes need real commits; the marker lands once the frame window closes.
    expect(await screen.findByTestId('perf-pass', {}, { timeout: 15_000 })).toBeTruthy()
    expect(screen.queryByTestId('perf-fail')).toBeNull()
    // The real hook ran end-to-end (delegating mock — the render contract below
    // is only meaningful if this leg exercised the genuine measurement path).
    expect(mockedProbes).toHaveBeenCalled()
  })

  it('surfaces perf-fail + the per-metric catalog line when the report breaches', async () => {
    mockedProbes.mockReturnValue({
      phase: 'done',
      step: 0,
      report: {
        pass: false,
        failures: [{ metric: 'tabSwitchMs', measured: 812, cap: 400 }],
        measured: { tabSwitchMs: 812, actionsOpenMs: 12, droppedFrames: 0 },
      },
    })
    renderRouter('./app', { initialUrl: '/perf-harness' })
    await screen.findByTestId('perf-harness-screen')
    expect(await screen.findByTestId('perf-fail')).toBeTruthy()
    // The breach renders through the catalog with the machine metric id intact.
    expect(screen.getByText(/tabSwitchMs/)).toBeTruthy()
    expect(screen.getByText(/812/)).toBeTruthy()
    expect(screen.queryByTestId('perf-pass')).toBeNull()
  })
})
