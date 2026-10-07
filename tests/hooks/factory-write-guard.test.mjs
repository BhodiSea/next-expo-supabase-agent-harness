// The FACTORY's write guard (.claude/hooks/pretool-write-guard.mjs), which had no test until
// 2.0.3 (#224). It denies an Edit, Write, MultiEdit or NotebookEdit of this repository's own
// enforcement surface (template/base/tools/, the shipped hooks, scripts/, installer/, the
// migrations record, CI workflows, the canary registry, .claude/) unless
// HARNESS_ALLOW_SELF_EDIT=1. Through 2.0.2 it stripped the project dir from `file_path` and
// matched what was left without normalising it, so `docs/../scripts/hygiene.mjs` and
// `./scripts/hygiene.mjs` walked past every `^`-anchored pattern, and it never read
// NotebookEdit's `notebook_path`, so every notebook edit passed on an empty path. It now
// resolves whichever path the tool sends against the project dir and judges the
// project-relative result: every spelling of a protected path is denied, and a path that
// resolves outside the project passes, as it always did.
//
// The hook runs in place: it resolves the shipped hookio relative to its own file and reads
// nothing else, so only the project dir is a temp directory (cwd and CLAUDE_PROJECT_DIR, the
// way the factory's settings run it). Absolute spellings are built by string concatenation,
// never `join`, because `join` would normalise away the very `..` and `.` under test. Only
// `node` is spawned, so this runs on the Windows leg of installer-unit too.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../../.claude/hooks/pretool-write-guard.mjs', import.meta.url))

/** hook-contract.test.mjs's LEAKY list: ambient switches a hook must not inherit. */
const LEAKY = ['HARNESS_ALLOW_SELF_EDIT', 'HARNESS_REQUIRE_TOOLCHAINS', 'GITHUB_BASE_REF', 'CI']
function cleanEnv() {
  const e = { ...process.env }
  for (const k of LEAKY) delete e[k]
  return e
}

const ROOT = mkdtempSync(join(tmpdir(), 'epah-factory-write-guard-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

/**
 * @param {string} toolName @param {object} toolInput @param {Record<string, string>} [env]
 * @returns {string | null} the deny reason, or null when the hook passed
 */
function verdict(toolName, toolInput, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: ROOT, ...env },
  })
  assert.equal(res.status, 0, `${toolName} ${JSON.stringify(toolInput)}: exit ${res.status}: ${res.stderr}`)
  if (res.stdout === '') return null
  const out = JSON.parse(res.stdout).hookSpecificOutput
  assert.equal(out.permissionDecision, 'deny', res.stdout)
  return out.permissionDecisionReason
}

const write = (file) => ({ file_path: file, content: '// probe\n' })
const notebook = (file) => ({ notebook_path: file, new_source: 'print(1)\n' })

/**
 * Denied, naming the path it resolves to, and allowed under HARNESS_ALLOW_SELF_EDIT=1.
 * @param {string} toolName @param {object} toolInput @param {string} resolved
 */
function assertProtected(toolName, toolInput, resolved) {
  const label = `${toolName} ${JSON.stringify(toolInput)}`
  const why = verdict(toolName, toolInput)
  assert.ok(why !== null, `${label}: expected a deny`)
  assert.ok(why.startsWith(`Blocked: ${resolved} is the harness's own enforcement surface`), `${label}: ${why}`)
  assert.ok(why.includes('HARNESS_ALLOW_SELF_EDIT=1'), `${label}: the deny names the escape: ${why}`)
  assert.equal(verdict(toolName, toolInput, { HARNESS_ALLOW_SELF_EDIT: '1' }), null, `${label}: allowed with the flag`)
}

/** @param {string} toolName @param {object} toolInput */
function assertAllowed(toolName, toolInput) {
  const why = verdict(toolName, toolInput)
  assert.equal(why, null, `${toolName} ${JSON.stringify(toolInput)}: expected no deny, got ${why}`)
}

test('the plain spellings: an absolute and a repo-relative protected path are denied', () => {
  assertProtected('Write', write(`${ROOT}/scripts/hygiene.mjs`), 'scripts/hygiene.mjs')
  assertProtected('Edit', write('scripts/hygiene.mjs'), 'scripts/hygiene.mjs')
  assertProtected('Write', write(`${ROOT}/.claude/settings.json`), '.claude/settings.json')
})

test('a protected path spelled through `..` is denied, absolute or relative', () => {
  assertProtected('Write', write(`${ROOT}/docs/../scripts/hygiene.mjs`), 'scripts/hygiene.mjs')
  assertProtected('Write', write('docs/../scripts/hygiene.mjs'), 'scripts/hygiene.mjs')
  assertProtected('Edit', write('docs/../template/migrations.json'), 'template/migrations.json')
  assertProtected('Edit', write(`${ROOT}/installer/lib/../../.github/workflows/selftest.yml`), '.github/workflows/selftest.yml')
})

test('a protected path spelled through `./` is denied, absolute or relative', () => {
  assertProtected('Write', write('./scripts/hygiene.mjs'), 'scripts/hygiene.mjs')
  assertProtected('Write', write(`${ROOT}/./scripts/hygiene.mjs`), 'scripts/hygiene.mjs')
  assertProtected('Edit', write('./tests/canary/injections.json'), 'tests/canary/injections.json')
  assertProtected('Edit', write('./.claude/hooks/pretool-write-guard.mjs'), '.claude/hooks/pretool-write-guard.mjs')
})

test('a backslash spelling is judged the way its forward-slash twin is', () => {
  assertProtected('Write', write('.\\scripts\\hygiene.mjs'), 'scripts/hygiene.mjs')
  assertProtected('Write', write('docs\\..\\template\\base\\tools\\validate.mjs'), 'template/base/tools/validate.mjs')
})

test('NotebookEdit is judged on its notebook_path', () => {
  assertProtected('NotebookEdit', notebook(`${ROOT}/scripts/probe.ipynb`), 'scripts/probe.ipynb')
  assertProtected('NotebookEdit', notebook('docs/../installer/probe.ipynb'), 'installer/probe.ipynb')
  assertAllowed('NotebookEdit', notebook(`${ROOT}/docs/probe.ipynb`))
})

test('a tool that sends `path` is judged on it, as the shipped guard reads it', () => {
  assertProtected('Write', { path: `${ROOT}/scripts/hygiene.mjs`, content: '// probe\n' }, 'scripts/hygiene.mjs')
})

test('an unprotected path passes, however it is spelled', () => {
  assertAllowed('Write', write(`${ROOT}/docs/guide.md`))
  assertAllowed('Write', write('./docs/guide.md'))
  assertAllowed('Edit', write('scripts/../docs/guide.md'))
  assertAllowed('Edit', write(`${ROOT}/.claude/../docs/guide.md`))
  assertAllowed('Write', write('template/base/app/page.tsx'))
})

test('a path that resolves outside the project passes, as it always did', () => {
  assertAllowed('Write', write(`${ROOT}/../scripts/hygiene.mjs`))
  assertAllowed('Write', write(`${dirname(ROOT)}/scripts/hygiene.mjs`))
  assertAllowed('Write', write(`${ROOT}-sibling/scripts/hygiene.mjs`))
})

test('a tool input with no path passes', () => {
  assertAllowed('Write', { content: '// probe\n' })
  assertAllowed('NotebookEdit', { new_source: 'print(1)\n' })
})
