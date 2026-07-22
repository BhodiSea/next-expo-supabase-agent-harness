// The one install-write primitive (init/update/enable all route here so the
// executable-bit rule can never fork per command).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeInstallFile(dest, content) {
  mkdirSync(dirname(dest), { recursive: true })
  // Hooks/scripts with shebangs are invoked directly by Claude Code — they
  // need the executable bit, which writeFileSync would otherwise drop.
  // Binary assets arrive as Buffers and are never executable.
  const executable = typeof content === 'string' && content.startsWith('#!')
  const mode = executable ? 0o755 : 0o644
  writeFileSync(dest, content, { mode })
  // writeFileSync applies mode only at CREATION — an update overwriting an
  // existing file whose shebang-ness changed would otherwise keep the stale
  // bit, so re-assert it explicitly on every write.
  chmodSync(dest, mode)
}
