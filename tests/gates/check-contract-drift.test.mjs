// Regression armor for the contracts lane around the parseJsonc extraction:
//   A. template/base/tools/lib/jsonc.mjs — parseJsonc, unit-tested IN-PROCESS: line
//      and block comments, trailing commas, comment markers preserved inside strings,
//      nested structures, escapes, and the invalid-after-strip throw paths. These pin
//      the EXACT current behavior (including one known latent bug — see A9).
//   B. template/base/tools/check-contract-drift.mjs — the sub-checks that run WITHOUT a
//      pnpm install: the tsconfig project-references sync (pure static, fixture-driven)
//      and the openapi regen-diff SKIP/FAIL asymmetry. Fixtures never carry
//      apps/server/scripts/emit-openapi.ts unless a case wants the openapi branch, so
//      the tsconfig check runs in isolation with a clean red/green.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Windows-safe dynamic import: a raw absolute path (D:\…) is not loadable by the
// ESM loader — go through a file:// URL.
const JSONC = pathToFileURL(
  fileURLToPath(new URL('../../template/base/tools/lib/jsonc.mjs', import.meta.url)),
).href
const { parseJsonc } = await import(JSONC)
const INV = pathToFileURL(
  fileURLToPath(new URL('../../template/base/tools/lib/inventory.mjs', import.meta.url)),
).href
const { renderActions, renderEvents } = await import(INV)

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-contract-drift.mjs', import.meta.url),
)

// ---------------------------------------------------------------------------
// A. parseJsonc — in-process unit tests
// ---------------------------------------------------------------------------

test('parseJsonc: line comments (// to end of line) are stripped anywhere', () => {
  assert.deepEqual(parseJsonc('// header line\n{ "a": 1 }'), { a: 1 })
  assert.deepEqual(parseJsonc('{\n  "a": 1, // one\n  "b": 2 // two\n}'), { a: 1, b: 2 })
  // trailing // with no newline before EOF still terminates cleanly
  assert.deepEqual(parseJsonc('{ "a": 1 }\n// dangling tail comment'), { a: 1 })
})

test('parseJsonc: block comments (/* */) are stripped, including multi-line spans', () => {
  assert.deepEqual(parseJsonc('{ /* c */ "a": 1 }'), { a: 1 })
  assert.deepEqual(parseJsonc('{\n/* multi\nline\ncomment */\n"a": 1 }'), { a: 1 })
  assert.deepEqual(parseJsonc('{ "a": /* inline */ 1 }'), { a: 1 })
  assert.deepEqual(parseJsonc('{ /**/ }'), {})
})

test('parseJsonc: trailing commas before } and ] are dropped (object, array, nested)', () => {
  assert.deepEqual(parseJsonc('{ "a": 1, }'), { a: 1 })
  assert.deepEqual(parseJsonc('[1, 2, 3, ]'), [1, 2, 3])
  assert.deepEqual(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }'), { a: [1, 2], b: { c: 3 } })
})

test('parseJsonc: comment markers inside double-quoted strings are preserved', () => {
  // The tokenizer is string-aware: //, /* and */ inside a value are content, not comments.
  assert.deepEqual(parseJsonc('{ "u": "http://x.com//p" }'), { u: 'http://x.com//p' })
  assert.deepEqual(parseJsonc('{ "u": "a/*b*/c" }'), { u: 'a/*b*/c' })
  assert.deepEqual(parseJsonc('{ "u": "end*/here" }'), { u: 'end*/here' })
  assert.deepEqual(parseJsonc('{ "u": "1//2" }'), { u: '1//2' })
})

test('parseJsonc: escaped quotes and backslashes inside strings survive', () => {
  assert.deepEqual(parseJsonc('{ "a": "x\\"y" }'), { a: 'x"y' })
  assert.deepEqual(parseJsonc('{ "a": "x\\\\" }'), { a: 'x\\' })
  // an escaped quote must not end the string early, so the following comment still strips
  assert.deepEqual(parseJsonc('{ "a": "x\\"y" /* c */, "b": 2 }'), { a: 'x"y', b: 2 })
})

test('parseJsonc: a realistic JSONC tsconfig (comments + trailing commas + nested refs) parses', () => {
  const tsconfig = `{
  // TypeScript solution-style project references
  "compilerOptions": { "composite": true },
  "references": [
    { "path": "../../packages/schema" },
    { "path": "../../packages/importer" }, /* the trailing comma above is legal JSONC */
  ],
}`
  assert.deepEqual(parseJsonc(tsconfig), {
    compilerOptions: { composite: true },
    references: [{ path: '../../packages/schema' }, { path: '../../packages/importer' }],
  })
})

test('parseJsonc: empty / whitespace-padded inputs parse to their bare value', () => {
  assert.deepEqual(parseJsonc('{}'), {})
  assert.deepEqual(parseJsonc('[]'), [])
  assert.deepEqual(parseJsonc('   \n  { "a": 1 }  \n'), { a: 1 })
})

test('parseJsonc: invalid-after-strip inputs throw (single quotes, comment-only, empty)', () => {
  // Single quotes are recognized as string delimiters (so a // inside them is
  // protected from stripping) but JSON.parse still rejects them — pin the throw.
  assert.throws(() => parseJsonc("{ 'a': 1 }"), SyntaxError)
  // A file that is only a comment strips to whitespace, which is not valid JSON.
  assert.throws(() => parseJsonc('// only a comment\n'), SyntaxError)
  assert.throws(() => parseJsonc(''), SyntaxError)
})

test('parseJsonc: KNOWN BUG — trailing-comma cleanup is not string-aware', () => {
  // The final `.replace(/,(\s*[}\]])/g, '$1')` runs over the whole comment-stripped
  // text with no string-awareness, so a string VALUE whose content ends in ',]' or
  // ',}' loses that comma. Benign for tsconfig (paths never contain those sequences),
  // pinned here as the CURRENT behavior (ported unchanged from the source harness);
  // reported to the orchestrator.
  //   desired-when-fixed: parseJsonc('{ "a": "text,]" }') === { a: 'text,]' }
  assert.deepEqual(parseJsonc('{ "a": "text,]" }'), { a: 'text]' })
  assert.deepEqual(parseJsonc('{ "a": "v,}" }'), { a: 'v}' })
  assert.deepEqual(parseJsonc('{ "a": "v, }" }'), { a: 'v }' })
})

// ---------------------------------------------------------------------------
// B. check-contract-drift — tsconfig references sync + inventory regen-diff skip asymmetry
// ---------------------------------------------------------------------------

// A GREEN workspace: schema has no workspace deps; contracts depends on schema and carries
// the matching project reference; the solution references both PACKAGE dirs. apps/* are
// deliberately NOT solution references (the two non-composite leaf apps are extra
// `tsc -b . apps/web apps/mobile` roots), so the solution-reference check skips them.
const GREEN_PACKAGES = {
  'packages/schema': { pkg: { name: '@app/schema' }, tsconfig: { references: [] } },
  'packages/contracts': {
    pkg: { name: '@app/contracts', dependencies: { '@app/schema': 'workspace:*' } },
    tsconfig: { references: [{ path: '../schema' }] },
  },
}
const GREEN_SOLUTION = ['packages/schema', 'packages/contracts']

// Build a scaffold-shaped tree; a package's `tsconfig: null` omits its tsconfig.json, a
// string tsconfig/solution is written verbatim (to exercise JSONC), `solution: null` omits
// the root tsconfig.json, and `inventory: true` plants a stub tools/gen-action-inventory.mjs
// so the regen-diff branch engages.
/** @param {{ packages?: any, solution?: any, inventory?: boolean }} [opts] */
function fixture({ packages = GREEN_PACKAGES, solution = GREEN_SOLUTION, inventory = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-contract-'))
  for (const [rel, spec] of Object.entries(packages)) {
    mkdirSync(join(dir, rel), { recursive: true })
    if (spec.pkg != null) {
      writeFileSync(join(dir, rel, 'package.json'), JSON.stringify(spec.pkg, null, 2))
    }
    if (spec.tsconfig != null) {
      const body =
        typeof spec.tsconfig === 'string' ? spec.tsconfig : JSON.stringify(spec.tsconfig, null, 2)
      writeFileSync(join(dir, rel, 'tsconfig.json'), body)
    }
  }
  if (solution != null) {
    const body =
      typeof solution === 'string'
        ? solution
        : JSON.stringify({ references: solution.map((p) => ({ path: p })) }, null, 2)
    writeFileSync(join(dir, 'tsconfig.json'), body)
  }
  if (inventory) {
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(join(dir, 'tools/gen-action-inventory.mjs'), 'export {}\n')
  }
  return dir
}

// POSIX-normalize output for path substring checks — the gate emits join()/relative()
// paths that carry backslashes on the windows-latest lane.
const norm = (s) => s.split('\\').join('/')

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: norm(`${res.stdout ?? ''}${res.stderr ?? ''}`) }
}

test('GREEN: tsconfig references mirror the workspace dependency graph', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('tsconfig references mirror the workspace graph'), r.out)
})

test('GREEN: JSONC tsconfigs (comments + trailing commas) still parse and pass in the gate', () => {
  const packages = {
    'packages/schema': { pkg: { name: '@app/schema' }, tsconfig: '{ "references": [] }' },
    'packages/contracts': {
      pkg: { name: '@app/contracts', dependencies: { '@app/schema': 'workspace:*' } },
      tsconfig:
        '{\n  // contracts references the schema package it imports\n  "references": [\n    { "path": "../schema" }, // trailing comma is legal JSONC\n  ],\n}',
    },
  }
  const solution =
    '{\n  // every workspace PACKAGE is a referenced project\n  "references": [\n    { "path": "packages/schema" },\n    { "path": "packages/contracts" },\n  ],\n}'
  const r = runGate(fixture({ packages, solution }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('tsconfig references mirror the workspace graph'), r.out)
})

test('RED: a workspace dep with no matching project reference fails naming the dep', () => {
  const packages = {
    ...GREEN_PACKAGES,
    'packages/contracts': {
      pkg: { name: '@app/contracts', dependencies: { '@app/schema': 'workspace:*' } },
      tsconfig: { references: [] },
    },
  }
  const r = runGate(fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing project reference to packages/schema'), r.out)
})

test('RED: a workspace package without a tsconfig.json fails loud', () => {
  const packages = {
    ...GREEN_PACKAGES,
    'packages/contracts': {
      pkg: { name: '@app/contracts', dependencies: { '@app/schema': 'workspace:*' } },
      tsconfig: null,
    },
  }
  const r = runGate(fixture({ packages }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing tsconfig.json'), r.out)
})

test('RED: the solution tsconfig missing a PACKAGE reference is named', () => {
  const r = runGate(fixture({ solution: ['packages/schema'] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing reference to packages/contracts'), r.out)
})

test('GREEN: apps/* are NOT required as solution references (non-composite leaf roots)', () => {
  // apps/web depends on @app/schema and carries the per-package reference (which IS checked),
  // but the solution does not reference apps/web — and must not need to.
  const packages = {
    ...GREEN_PACKAGES,
    'apps/web': {
      pkg: { name: 'web', dependencies: { '@app/schema': 'workspace:*' } },
      tsconfig: { references: [{ path: '../../packages/schema' }] },
    },
  }
  const r = runGate(fixture({ packages, solution: GREEN_SOLUTION }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: with no solution tsconfig, the per-package reference checks still pass', () => {
  const r = runGate(fixture({ solution: null }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('tsconfig references mirror the workspace graph'), r.out)
})

test('inventory skip asymmetry: a generator present, no install → local SKIP, CI FAIL', () => {
  const local = runGate(fixture({ inventory: true }), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('node_modules missing'), local.out)

  const ci = runGate(fixture({ inventory: true }), { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('node_modules missing'), ci.out)
})

test('a tsconfig failure beats the inventory skip: red even locally, never SKIPPED', () => {
  const packages = {
    ...GREEN_PACKAGES,
    'packages/contracts': {
      pkg: { name: '@app/contracts', dependencies: { '@app/schema': 'workspace:*' } },
      tsconfig: { references: [] },
    },
  }
  const r = runGate(fixture({ packages, inventory: true }), { ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing project reference to packages/schema'), r.out)
  assert.ok(!r.out.includes('SKIPPED'), r.out)
})

// ---------------------------------------------------------------------------
// C. the pure inventory serializers (tools/lib/inventory.mjs) — in-process, no workspace
// ---------------------------------------------------------------------------

test('renderActions: code-unit sorted rows of {action, type} from a _def.procedures record', () => {
  const procedures = {
    'system.me': { _def: { type: 'query' } },
    'notes.create': { _def: { type: 'mutation' } },
  }
  const expected = `${JSON.stringify(
    [
      { action: 'notes.create', type: 'mutation' },
      { action: 'system.me', type: 'query' },
    ],
    null,
    2,
  )}\n`
  assert.equal(renderActions(procedures), expected)
})

test('renderEvents: code-unit sorted {name,version,description}; a duplicate name throws', () => {
  const out = renderEvents([
    { name: 'platform.b', version: 1, description: 'second' },
    { name: 'notes.a', version: 2, description: 'first' },
  ])
  assert.ok(out.indexOf('notes.a') < out.indexOf('platform.b'), out)
  assert.throws(
    () =>
      renderEvents([
        { name: 'x', version: 1, description: 'd' },
        { name: 'x', version: 1, description: 'e' },
      ]),
    /duplicate event name/,
  )
})
