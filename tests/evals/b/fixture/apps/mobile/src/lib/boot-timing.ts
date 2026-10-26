// Cold-start stamp, once. Hermes under the New Architecture exposes the native
// startup timeline at `performance.reactNativeStartupTiming`; the shell calls
// stampBootTiming() when the first screen is on-screen, and the elapsed
// wall-clock from runtime init to interactive parks here for the device perf
// lane (the startup-budget rows and their Maestro measurement land in a later
// workstream — this module is the seam they read).
//
// Stamp-once discipline (same as the desktop original): re-renders, re-mounts
// and navigation must never overwrite the first honest number. Fail-silent: a
// missing timeline (old runtime, jest, a stripped host) is a measurement that
// did not happen — the perf lane fails loudly on ABSENCE rather than passing on
// a fabricated zero.
interface StartupTiming {
  readonly initializeRuntimeStart?: number
}

interface PerformanceWithStartup {
  readonly now?: () => number
  readonly reactNativeStartupTiming?: StartupTiming
}

let bootMs: number | null = null

export function stampBootTiming(): void {
  if (bootMs !== null) return
  try {
    const perf = (globalThis as { performance?: PerformanceWithStartup }).performance
    const start = perf?.reactNativeStartupTiming?.initializeRuntimeStart
    if (typeof start !== 'number' || typeof perf?.now !== 'function') return
    // Both numbers sit on the same performance timeline (origin = process
    // start), so the difference is runtime-init -> first-screen-interactive.
    bootMs = Math.max(0, Math.round(perf.now() - start))
  } catch {
    // The host did not answer; absence stays honest.
  }
}

/** The stamped cold-start milliseconds, or null when never measured. @public — the perf lane reads it. */
export function bootTimingMs(): number | null {
  return bootMs
}
