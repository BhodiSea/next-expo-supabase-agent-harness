// The FACTORY's PostToolUse adapter (.claude/hooks/posttool-factory-check.mjs), which had no
// test until 1.1.0 (#69). It runs the SHIPPED posttool-source-check over this repository's own
// edits, translating only the path it is told about (template/base/<p> becomes <p>), and its
// whole contract is that the verdict is the shipped hook's: stdout, stderr and exit code passed
// through unaltered. Until 1.1.0 it forwarded stderr and the exit code only. That was enough
// while the shipped hook spoke only by exiting 2; once an advisory-class site answers with a
// PostToolUse `additionalContext` object on stdout at exit 0, an adapter that drops stdout
// turns the message into silence.
//
// The layout is copied, not pointed at: the adapter resolves the shipped hook and its hookio
// relative to its own file (../../template/base/…), so the temp directory mirrors the repo —
// .claude/hooks/<adapter>, template/base/.claude and template/base/tools/lib — and each fixture
// file is written where the spawned hook reads it, under template/base/, because the adapter
// runs the hook with template/base/ as its cwd. Only `node` is spawned, so this runs on the
// Windows leg of installer-unit too.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const ADAPTER = '.claude/hooks/posttool-factory-check.mjs'
const SHIPPED = 'template/base/.claude/hooks/posttool-source-check.mjs'

const LEAKY = ['HARNESS_ALLOW_SELF_EDIT', 'HARNESS_REQUIRE_TOOLCHAINS', 'GITHUB_BASE_REF', 'CI']
function cleanEnv() {
  const e = { ...process.env }
  for (const k of LEAKY) delete e[k]
  return e
}

const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A temp copy of the adapter and the shipped tree it resolves, in the repo's layout. */
function mirror() {
  const root = mkdtempSync(join(tmpdir(), 'epah-factory-check-'))
  made.push(root)
  mkdirSync(join(root, '.claude/hooks'), { recursive: true })
  cpSync(join(REPO, ADAPTER), join(root, ADAPTER))
  cpSync(join(REPO, 'template/base/.claude'), join(root, 'template/base/.claude'), { recursive: true })
  cpSync(join(REPO, 'template/base/tools/lib'), join(root, 'template/base/tools/lib'), { recursive: true })
  return root
}

/** @param {string} root @param {string} rel @param {string} text */
function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/** The adapter, as the factory's settings run it: cwd and CLAUDE_PROJECT_DIR at the repo root. */
function runAdapter(root, input) {
  const res = spawnSync(process.execPath, [join(root, ADAPTER)], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: root },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** The shipped hook run directly, the way the adapter says it runs it. */
function runShipped(root, input) {
  const base = join(root, 'template/base')
  const res = spawnSync(process.execPath, [join(root, SHIPPED)], {
    cwd: base,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: base },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

let root
before(() => {
  root = mirror()
})

/** One edit, through the adapter and directly: the adapter must add and drop nothing. */
function bothWays(consumerPath, text) {
  put(root, `template/base/${consumerPath}`, text)
  const viaAdapter = runAdapter(root, {
    tool_name: 'Edit',
    tool_input: { file_path: join(root, 'template/base', consumerPath) },
  })
  const direct = runShipped(root, { tool_name: 'Edit', tool_input: { file_path: consumerPath } })
  assert.deepEqual(viaAdapter, direct, 'the adapter must pass the shipped verdict through unaltered')
  return viaAdapter
}

test('a MANDATORY uncited site: the adapter forwards exit 2 and the stderr, and adds no stdout', () => {
  const r = bothWays('apps/server/src/auth.ts', 'const claims = await jwtVerify(token, jwks)\n')
  assert.equal(r.code, 2, r.stderr)
  assert.ok(r.stderr.includes('apps/server/src/auth.ts:1'), r.stderr)
  assert.equal(r.stdout, '')
})

test('an ADVISORY-only site: the adapter forwards exit 0 and the additionalContext object on stdout', () => {
  const r = bothWays('apps/web/lib/limits.ts', 'export const opts = { timeoutMs: 5000 }\n')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.ok(out.hookSpecificOutput.additionalContext.includes('apps/web/lib/limits.ts:1'), r.stdout)
  assert.ok(out.hookSpecificOutput.additionalContext.includes('[tuning-constants]'), r.stdout)
})

test('a clean file: exit 0 and no output on either channel', () => {
  const r = bothWays('apps/web/lib/clean.ts', 'export const nothing = 1\n')
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' })
})

test('the adapter forwards stdout, stderr and an arbitrary exit code byte for byte, with the path translated', () => {
  // A stub in place of the shipped hook isolates the forwarding from any rule: it echoes the
  // path it was handed on stdout, writes a marker to stderr and exits 3.
  const stub = mirror()
  put(
    stub,
    SHIPPED,
    [
      "let raw = ''",
      "process.stdin.on('data', (d) => { raw += d })",
      "process.stdin.on('end', () => {",
      '  const p = JSON.parse(raw).tool_input.file_path',
      "  process.stdout.write(`OUT ${p}\\n{\"k\":1}`)",
      "  process.stderr.write('ERR line\\n')",
      '  process.exit(3)',
      '})',
      '',
    ].join('\n'),
  )
  const r = runAdapter(stub, {
    tool_name: 'Write',
    tool_input: { file_path: join(stub, 'template/base/apps/server/src/x.ts') },
  })
  assert.deepEqual(r, { code: 3, stdout: 'OUT apps/server/src/x.ts\n{"k":1}', stderr: 'ERR line\n' })

  // Outside the template trees the adapter does not run the hook at all.
  const outside = runAdapter(stub, { tool_name: 'Write', tool_input: { file_path: join(stub, 'scripts/x.mjs') } })
  assert.deepEqual(outside, { code: 0, stdout: '', stderr: '' })
})
