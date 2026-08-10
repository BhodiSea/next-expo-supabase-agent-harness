// The one install-write primitive (init/update/enable all route here so the
// executable-bit rule can never fork per command — and, since 0.9.0, so no
// install write can truncate in place). tests/installer/write-file.test.mjs
// pins the closure: writeFileSync appears in THIS file and nowhere else under
// installer/.
//
// Why staging matters here and not merely somewhere: an interrupted direct
// write leaves a torn file, and a torn file under .claude/hooks/ fails OPEN —
// the fail-closed handlers live inside hooks/lib/hookio.mjs and install only
// after the module parses, so a load-time SyntaxError exits 1, which Claude
// Code treats as a NON-blocking hook error and the guarded action proceeds
// (probed empirically for the torn/zeroed/missing cases before 0.9.0 shipped
// this). Staging to a dot-tmp in the SAME directory keeps the rename on one
// filesystem, so the destination either holds its old bytes or the new ones.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Windows renameSync over a file another process holds open (antivirus,
// editors) throws EPERM/EBUSY/EACCES transiently. Retry with bounded backoff
// ON WIN32 ONLY — on POSIX those errno values are real permission problems and
// retrying would mask them — then rethrow: when the rename never lands the
// destination still holds the OLD bytes, which is the atomicity property.
const WIN_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const WIN_RETRY_DELAYS_MS = [10, 50, 100, 250, 500]

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * @param {string} from @param {string} to
 * @param {{ rename?: (from: string, to: string) => void, platform?: string,
 *           sleep?: (ms: number) => void }} [opts]
 */
export function renameWithRetry(
  from,
  to,
  { rename = renameSync, platform = process.platform, sleep = sleepSync } = {},
) {
  const delays = platform === 'win32' ? WIN_RETRY_DELAYS_MS : []
  for (const delayMs of delays) {
    try {
      rename(from, to)
      return
    } catch (err) {
      if (!WIN_TRANSIENT.has(err?.code)) throw err
      sleep(delayMs)
    }
  }
  rename(from, to)
}

let stagingCounter = 0

export function writeInstallFile(dest, content) {
  mkdirSync(dirname(dest), { recursive: true })
  // Hooks/scripts with shebangs are invoked directly by Claude Code — they
  // need the executable bit, which writeFileSync would otherwise drop.
  // Binary assets arrive as Buffers and are never executable.
  const executable = typeof content === 'string' && content.startsWith('#!')
  const mode = executable ? 0o755 : 0o644
  // Same directory → same filesystem → the rename is a single atomic
  // replacement; the dot prefix keeps the staging file out of globs. pid +
  // counter keeps concurrent installers off each other's staging files.
  stagingCounter += 1
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.${stagingCounter}.tmp`)
  try {
    writeFileSync(tmp, content, { mode })
    // writeFileSync's mode is masked by the umask — re-assert it explicitly so
    // the bit survives any umask, exactly as the pre-0.9.0 primitive did on
    // the destination.
    chmodSync(tmp, mode)
    renameWithRetry(tmp, dest)
  } finally {
    rmSync(tmp, { force: true })
  }
}
