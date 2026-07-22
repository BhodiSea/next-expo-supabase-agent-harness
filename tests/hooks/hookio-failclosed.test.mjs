// Fail-closed I/O contract for the shared hook runtime (.claude/hooks/lib/hookio.mjs)
// plus the posttool-{source,fast}-check contracts NOT already covered by
// hook-contract.test.mjs. The core suite spawns tiny fixture hooks (written to a
// mkdtemp dir) that import the SHIPPED hookio.mjs via a file:// URL and then crash
// in each shape a real hook can crash — a synchronous throw during module eval, an
// unhandled promise rejection, malformed stdin — asserting the guard exits 2 (blocks
// the action) rather than 1 (which Claude Code treats as a non-blocking hook error).
// A fixture that completes cleanly exits 0. hook-contract.test.mjs already covers the
// guards' malformed-stdin path and source-check's jwtVerify/FORCE-RLS cited/uncited
// basics; the source-check cases here are additive (distinct decision groups, the
// SOURCE-window boundary, the broken-rules-module fail-closed path, comment/skip edges).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
// Fixtures import the shipped module directly (not a copy) via a file:// URL so this
// is Windows-safe — a raw D:\… path is not importable by the ESM loader.
const HOOKIO_URL = pathToFileURL(join(TEMPLATE, '.claude/hooks/lib/hookio.mjs')).href
const IMPORT_ALL = `import ${JSON.stringify(HOOKIO_URL)}\n`
const importNamed = (names) => `import { ${names} } from ${JSON.stringify(HOOKIO_URL)}\n`

let proj
let fixDir
let seq = 0

before(() => {
  // Rendered install layout, like hook-contract.test.mjs: the posttool hooks import
  // ../../tools/lib/provenance-rules.mjs relative to .claude/hooks/.
  proj = mkdtempSync(join(tmpdir(), 'epah-hookio-'))
  cpSync(join(TEMPLATE, '.claude'), join(proj, '.claude'), { recursive: true })
  mkdirSync(join(proj, 'tools'), { recursive: true })
  cpSync(join(TEMPLATE, 'tools/lib'), join(proj, 'tools/lib'), { recursive: true })
  mkdirSync(join(proj, 'apps/server/src'), { recursive: true })
  mkdirSync(join(proj, 'packages/schema/drizzle'), { recursive: true })
  fixDir = mkdtempSync(join(tmpdir(), 'epah-hookio-fx-'))
})

// Spawn a one-off fixture module that imports the shipped hookio and does `body`.
function runFixture(body, { input = '' } = {}) {
  const file = join(fixDir, `fixture-${seq++}.mjs`)
  writeFileSync(file, body)
  const res = spawnSync('node', [file], { input, encoding: 'utf8' })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// Run a real shipped hook from the rendered layout, hook-contract.test.mjs style.
function runHook(name, input, { env = {}, cwd = proj } = {}) {
  const res = spawnSync('node', [join(proj, '.claude/hooks', name)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// ── hookio: fail-closed handlers ─────────────────────────────────────────────
test('hookio fails CLOSED (exit 2) on a synchronous throw after import', () => {
  const r = runFixture(`${IMPORT_ALL}throw new Error('boom-sync')\n`)
  assert.equal(r.code, 2, `sync throw must block, got ${r.code}: ${r.stderr}`)
  assert.match(r.stderr, /HOOK CRASHED|failing closed/i)
})

test('hookio fails CLOSED (exit 2) on an asynchronous rejection', () => {
  // Both async shapes a hook can produce route through the unhandledRejection handler.
  const rejected = runFixture(`${IMPORT_ALL}Promise.reject(new Error('boom-reject'))\n`)
  assert.equal(rejected.code, 2, `Promise.reject must block: ${rejected.stderr}`)
  assert.match(rejected.stderr, /HOOK CRASHED|failing closed/i)

  const asyncThrow = runFixture(
    `${IMPORT_ALL}async function work() { throw new Error('boom-async-fn') }\nwork()\n`,
  )
  assert.equal(asyncThrow.code, 2, `unawaited async throw must block: ${asyncThrow.stderr}`)
  assert.match(asyncThrow.stderr, /HOOK CRASHED|failing closed/i)
})

test('a fixture that completes cleanly exits 0 (handlers installed, none fire)', () => {
  const r = runFixture(
    `${importNamed('readHookInput, pass')}await readHookInput()\npass()\n`,
    { input: '{"tool_name":"Edit"}' },
  )
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
})

// ── hookio: readHookInput / block / denyTool / pass surface ───────────────────
test('readHookInput: empty stdin → {} exit 0, valid JSON → exit 0, malformed → fail closed', () => {
  const body = `${importNamed('readHookInput')}const parsed = await readHookInput()\nprocess.stdout.write(JSON.stringify(parsed))\n`

  const empty = runFixture(body, { input: '' })
  assert.equal(empty.code, 0, empty.stderr)
  assert.equal(empty.stdout, '{}', 'empty stdin is a legitimate no-input event → {}')

  const valid = runFixture(body, { input: '{"tool_input":{"file_path":"a.ts"}}' })
  assert.equal(valid.code, 0, valid.stderr)
  assert.match(valid.stdout, /"file_path":"a\.ts"/)

  const malformed = runFixture(body, { input: 'this is { not json' })
  assert.equal(malformed.code, 2, 'malformed (non-empty, unparseable) stdin must fail closed')
  assert.match(malformed.stderr, /HOOK CRASHED|failing closed/i)
})

test('block(reason) writes the reason to stderr and exits 2', () => {
  const r = runFixture(`${importNamed('block')}block('blocked because reasons')\n`)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /blocked because reasons/)
})

test('denyTool(event, reason) emits a structured deny on stdout and exits 0', () => {
  const r = runFixture(`${importNamed('denyTool')}denyTool('PreToolUse', 'no touching')\n`)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /"permissionDecision":"deny"/)
  assert.match(r.stdout, /"hookEventName":"PreToolUse"/)
  assert.match(r.stdout, /no touching/)
})

test('pass() exits 0 with no output', () => {
  const r = runFixture(`${importNamed('pass')}pass()\n`)
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

// ── posttool-fast-check: non-blocking contract ───────────────────────────────
test('fast-check is non-blocking (exit 0) on a non-matching extension', () => {
  const r = runHook('posttool-fast-check.mjs', { tool_input: { file_path: 'notes.md' } })
  assert.equal(r.code, 0, r.stderr)
})

test('fast-check never blocks: exits 0 on a .ts edit even when biome cannot run', () => {
  // The mkdtemp project has no node_modules, so `pnpm exec biome` cannot resolve
  // biome (and pnpm may be absent entirely on the runner). The hook may surface the
  // failure to stderr but MUST exit 0 — the authoritative checks live on the Stop gate.
  const f = join(proj, 'apps/server/src/fast.ts')
  writeFileSync(f, 'export const x = 1\n')
  const r = runHook('posttool-fast-check.mjs', { tool_input: { file_path: f } })
  assert.equal(r.code, 0, `fast-check must not block: ${r.stderr}`)
})

// ── posttool-source-check: fail-closed load + heuristic edges ─────────────────
test('source-check fails CLOSED (exit 2) when the provenance-rules module is broken', () => {
  // The dynamic import of ../../tools/lib/provenance-rules.mjs happens AFTER hookio
  // installs its handlers; a broken (or missing) rules module must BLOCK, not exit 1.
  const bad = mkdtempSync(join(tmpdir(), 'epah-hookio-badrules-'))
  cpSync(join(TEMPLATE, '.claude'), join(bad, '.claude'), { recursive: true })
  mkdirSync(join(bad, 'tools/lib'), { recursive: true })
  writeFileSync(join(bad, 'tools/lib/provenance-rules.mjs'), 'this is not valid javascript {{{\n')
  const res = spawnSync('node', [join(bad, '.claude/hooks/posttool-source-check.mjs')], {
    input: JSON.stringify({ tool_input: { file_path: 'x.ts' } }),
    encoding: 'utf8',
    cwd: bad,
    env: { ...process.env, CLAUDE_PROJECT_DIR: bad },
  })
  assert.equal(res.status, 2, `broken rules module must block: ${res.stderr}`)
  assert.match(res.stderr, /provenance-rules import/)
  assert.match(res.stderr, /failing closed/i)
})

test('source-check flags an uncited decision site and passes a cited one (hnsw + set_config)', () => {
  // Distinct decision groups from hook-contract's jwtVerify/FORCE-RLS coverage:
  // vector-index (USING hnsw) in SQL and guc-identity (set_config) in TS.
  const uncitedSql = join(proj, 'packages/schema/drizzle/9101_idx.sql')
  writeFileSync(uncitedSql, 'CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedSql } }).code, 2)

  const citedSql = join(proj, 'packages/schema/drizzle/9102_idx.sql')
  writeFileSync(
    citedSql,
    '-- SOURCE: https://github.com/pgvector/pgvector [corpus: pgvector/hnsw]\nCREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);\n',
  )
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: citedSql } }).code, 0)

  const uncitedTs = join(proj, 'apps/server/src/ctx-a.ts')
  writeFileSync(uncitedTs, "const r = set_config('app.user_id', id, true)\n")
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedTs } }).code, 2)

  const citedTs = join(proj, 'apps/server/src/ctx-b.ts')
  writeFileSync(
    citedTs,
    "// SOURCE: https://www.postgresql.org/docs/current/functions-admin.html\nconst r = set_config('app.user_id', id, true)\n",
  )
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: citedTs } }).code, 0)
})

test('source-check honors the 3-line SOURCE window (cited 3 lines above passes, 4 fails)', () => {
  const within = join(proj, 'apps/server/src/win-ok.ts')
  writeFileSync(within, '// SOURCE: https://example.com/retries\nconst a = 1\nconst b = 2\nconst maxRetries = 5\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: within } }).code, 0)

  const outside = join(proj, 'apps/server/src/win-far.ts')
  writeFileSync(
    outside,
    '// SOURCE: https://example.com/retries\nconst a = 1\nconst b = 2\nconst c = 3\nconst maxRetries = 5\n',
  )
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: outside } }).code, 2)
})

test('source-check does not flag a decision keyword that only appears in a comment', () => {
  const f = join(proj, 'apps/server/src/comment-only.ts')
  writeFileSync(f, '// we will call jwtVerify and set_config here later\nexport const x = 1\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: f } }).code, 0)
})

test('source-check exits 0 when the edited file no longer exists on disk', () => {
  const missing = join(proj, 'apps/server/src/vanished.ts')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: missing } }).code, 0)
})

test('source-check skips a non-scannable extension (.js) even with a decision site', () => {
  const f = join(proj, 'apps/server/src/legacy.js')
  writeFileSync(f, 'const claims = jwtVerify(token, jwks)\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: f } }).code, 0)
})
