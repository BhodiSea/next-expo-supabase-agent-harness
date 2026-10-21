// The README recording (#165) is rendered by vhs from docs/media/harness-demo.tape, and no
// CI lane runs vhs. So this test runs the tape's typed commands in plain bash, in the order
// the tape types them, against this checkout, and holds each one to the tape's own
// `# expect:` and `# exit:` lines. A guard message or gate line that changes reds here, so
// the tape is updated and the GIF regenerated, instead of the README showing output the
// release no longer prints. It also holds the GIF to the size the issue allows and the
// README to embedding it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TAPE = join(ROOT, 'docs/media/harness-demo.tape')
const GIF_PATH = 'docs/media/harness-demo.gif'
const MAX_GIF_BYTES = 2 * 1024 * 1024
const HAS_BASH = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0

/**
 * Every `Type` line that an `Enter` follows, with the `# expect:` and `# exit:` lines
 * written above it. vhs takes a string in double quotes, single quotes or backticks.
 * @param {string} text
 */
function parseTape(text) {
  const lines = text.split('\n')
  const steps = []
  /** @type {string[]} */
  let expects = []
  let exit = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const expect = /^# expect: (.+)$/.exec(line)
    const exitLine = /^# exit: (\d+)$/.exec(line)
    const typed = /^Type (["'`])(.*)\1$/.exec(line)
    if (expect) expects.push(expect[1])
    else if (exitLine) exit = Number(exitLine[1])
    else if (typed) {
      assert.equal(lines[i + 1]?.trim(), 'Enter', `tape line ${String(i + 1)}: a typed command must be followed by Enter`)
      steps.push({ command: typed[2], expects, exit, line: i + 1 })
      expects = []
      exit = 0
    }
  }
  assert.deepEqual(expects, [], 'an `# expect:` line is left with no typed command after it')
  return steps
}

test('the tape writes the GIF the README embeds, and the GIF stays under 2 MB', () => {
  const tape = readFileSync(TAPE, 'utf8')
  assert.match(tape, new RegExp(`^Output ${GIF_PATH.replaceAll('.', '\\.')}$`, 'm'))
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes(`](${GIF_PATH})`), `README.md does not embed ${GIF_PATH}`)
  assert.ok(existsSync(join(ROOT, GIF_PATH)), `${GIF_PATH} is missing: run \`vhs docs/media/harness-demo.tape\``)
  const size = statSync(join(ROOT, GIF_PATH)).size
  assert.ok(size <= MAX_GIF_BYTES, `${GIF_PATH} is ${String(size)} bytes, over the 2 MB the README allows`)
})

test('parseTape pairs each typed command with the lines above it', () => {
  const steps = parseTape(['# expect: a', '# exit: 1', 'Type "x"', 'Enter', 'Sleep 1s', 'Type `y "z"`', 'Enter'].join('\n'))
  assert.deepEqual(steps, [
    { command: 'x', expects: ['a'], exit: 1, line: 3 },
    { command: 'y "z"', expects: [], exit: 0, line: 6 },
  ])
  assert.throws(() => parseTape('Type "x"\nSleep 1s'), /followed by Enter/)
  assert.throws(() => parseTape('Type "x"\nEnter\n# expect: orphan'), /no typed command/)
})

test('every command the tape types prints what the tape says it prints', { skip: !HAS_BASH && 'needs bash' }, () => {
  const steps = parseTape(readFileSync(TAPE, 'utf8'))
  assert.ok(steps.some((s) => s.exit !== 0), 'the recording must show at least one gate going red')
  assert.ok(steps.some((s) => s.expects.length > 0), 'the tape checks no output at all')
  const tmp = mkdtempSync(join(tmpdir(), 'epah-recording-'))
  try {
    // `clear` is screen plumbing for the recording; the commands run in one shell, as typed.
    const script = ['exec 2>&1', 'clear() { :; }']
    steps.forEach((s, i) => {
      script.push(`printf '\\n@@begin ${String(i)}\\n'`, s.command, `printf '\\n@@end ${String(i)} %s\\n' "$?"`)
    })
    const env = { ...process.env, TMPDIR: tmp }
    delete env.CLAUDE_PROJECT_DIR
    const res = spawnSync('bash', ['--noprofile', '--norc'], { cwd: ROOT, input: script.join('\n'), encoding: 'utf8', env, timeout: 120_000 })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    steps.forEach((s, i) => {
      const block = new RegExp(`@@begin ${String(i)}\\n([\\s\\S]*?)\\n@@end ${String(i)} (\\d+)`).exec(res.stdout ?? '')
      assert.ok(block, `tape line ${String(s.line)} never finished: ${s.command}\n${out.slice(-2000)}`)
      assert.equal(Number(block[2]), s.exit, `tape line ${String(s.line)} exited ${block[2]}, the tape says ${String(s.exit)}: ${s.command}\n${block[1]}`)
      for (const e of s.expects) {
        assert.ok(block[1].includes(e), `tape line ${String(s.line)} did not print "${e}": ${s.command}\n${block[1]}`)
      }
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
