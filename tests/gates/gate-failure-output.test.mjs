// Regression armor for commandFailureOutput in template/base/tools/lib/gate.mjs:
// the one idiom for reporting a captured subprocess failure. The defect family it
// ends had two halves, both proven here against a REAL execSync error object, not
// a mock: (1) `e.stderr?.toString() ?? e.message` never falls back when stderr is
// the EMPTY STRING ('' is not nullish), so a tool that wrote nothing to stderr
// produced an empty failure detail; (2) stdout was dropped entirely, and expo/
// pnpm/playwright write their diagnostics to stdout. A gate that swallows the
// output that failed it reads as noise instead of evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandFailureOutput, runCmd } from '../../template/base/tools/lib/gate.mjs'

// A real failing child under runCmd's capture contract (utf8, piped): writes the
// diagnostic to STDOUT ONLY, nothing to stderr, exits non-zero — the exact shape
// `expo export` produces. Script goes through a temp file, not `-e`, so the
// invocation is quoting-safe on both POSIX and Windows runners.
function realFailure({ stdout = '', stderr = '', code = 3 }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-failout-'))
  const script = join(dir, 'child.mjs')
  writeFileSync(
    script,
    `${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ''}` +
      `${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}` +
      `process.exit(${code});`,
  )
  try {
    runCmd(`node "${script}"`)
  } catch (e) {
    return e
  }
  throw new Error('child unexpectedly succeeded')
}

test('stdout-only failure: the diagnostic survives (the empty-string-stderr trap)', () => {
  const e = realFailure({ stdout: 'STDOUT_DIAG: module not found\n' })
  // The trap, pinned: the captured stderr really is '' (not null/undefined), so
  // the retired idiom's ?? never fired and the detail it built was empty.
  assert.equal(e.stderr, '')
  assert.equal((e.stderr?.toString() ?? e.message).slice(0, 300).trim(), '')
  // The helper reports the stream that actually carried the evidence.
  assert.match(commandFailureOutput(e), /STDOUT_DIAG: module not found/)
})

test('stderr-only failure keeps reporting stderr', () => {
  const e = realFailure({ stderr: 'STDERR_DIAG: exploded\n' })
  assert.match(commandFailureOutput(e), /STDERR_DIAG: exploded/)
})

test('both streams: stdout first, then stderr, newline-joined', () => {
  const e = realFailure({ stdout: 'first: context\n', stderr: 'second: error\n' })
  assert.equal(commandFailureOutput(e), 'first: context\nsecond: error')
})

test('null streams (stdio: inherit shape) fall back to e.message', () => {
  // check-web-e2e streams through 'inherit', so the error object carries null
  // streams — the helper must not turn that into an empty detail either.
  const out = commandFailureOutput({ stdout: null, stderr: null, message: 'Command failed: playwright test' })
  assert.equal(out, 'Command failed: playwright test')
})

test('whitespace-only output falls back to e.message', () => {
  const out = commandFailureOutput({ stdout: '  \n', stderr: '\t', message: 'exit 1' })
  assert.equal(out, 'exit 1')
})

test('Buffer streams coerce losslessly (execFileSync without encoding)', () => {
  const out = commandFailureOutput({
    stdout: Buffer.from('buf-out\n'),
    stderr: Buffer.from('buf-err\n'),
    message: 'unused',
  })
  assert.equal(out, 'buf-out\nbuf-err')
})

test('no message at all still yields a string, never undefined', () => {
  assert.equal(typeof commandFailureOutput({}), 'string')
})
