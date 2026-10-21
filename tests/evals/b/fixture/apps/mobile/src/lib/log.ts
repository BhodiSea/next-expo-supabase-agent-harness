// The ONE logging seam. Dev builds print to the Metro console; release builds
// drop everything — a console call in release Hermes is dead weight on the JS
// thread, and a shipped log line is an information leak with no reader.
//
// Features import `log`, never console, so when the crash-reporting module
// (opt-in, later workstream) PATCHES the sink via setLogSink, the swap reaches
// every call site without touching feature code.
export interface LogSink {
  readonly debug: (...args: readonly unknown[]) => void
  readonly info: (...args: readonly unknown[]) => void
  readonly warn: (...args: readonly unknown[]) => void
  readonly error: (...args: readonly unknown[]) => void
}

const devSink: LogSink = {
  debug: (...args) => {
    console.debug(...args)
  },
  info: (...args) => {
    console.info(...args)
  },
  warn: (...args) => {
    console.warn(...args)
  },
  error: (...args) => {
    console.error(...args)
  },
}

const noopSink: LogSink = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

let sink: LogSink = __DEV__ ? devSink : noopSink

/** Install a replacement sink (crash reporting). Dev default: the console. @public — the crash-reporting module hook. */
export function setLogSink(next: LogSink): void {
  sink = next
}

// Delegates per call (not a frozen reference) so a patched sink takes over
// retroactively for every module that already imported `log`.
export const log: LogSink = {
  debug: (...args) => {
    sink.debug(...args)
  },
  info: (...args) => {
    sink.info(...args)
  },
  warn: (...args) => {
    sink.warn(...args)
  },
  error: (...args) => {
    sink.error(...args)
  },
}
