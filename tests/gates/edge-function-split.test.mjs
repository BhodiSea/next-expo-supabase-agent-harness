// THE EDGE FUNCTION SPLIT AND ITS REACH (1.1.0, #78).
//
// supabase/functions/delete-account/index.ts held every decision the function makes, and it
// imports a jsr: specifier and starts a server as it loads, so no Node-side check could reach
// it. 1.1.0 splits it: handler.ts holds the decisions and takes its clients and environment as
// parameters; index.ts is a Deno.serve shell. This file pins the shape that makes the split
// worth having, and the config that turns it into reach:
//   - handler.ts names no Deno global and imports nothing at runtime (its one import is
//     type-only), so vitest can run it in plain Node;
//   - index.ts is the shell: it imports the handler and calls Deno.serve, and nothing else;
//   - vitest.config.ts DERIVES the Edge Function suites and the measured directories from the
//     tree, executed here over fixture trees: a `deno test` file is never collected, and a
//     directory with no vitest suite is never measured (so an install's existing untested
//     helper cannot weigh on the aggregate floor);
//   - the ADR's traceability rows name tests that exist;
//   - the 1.1.0 record withholds the new files from `update` and tells an existing install,
//     through a seededSourceFixes probe the v1.0.3 index.ts matches, how to pull them.
//
// The cases that read TypeScript source (the shape of handler.ts and index.ts, and the
// evaluated vitest.config.ts) run through tsTest, which loads the root's own `typescript`: where
// it is not installed (selftest.yml's installer-unit runs the suite with no install) they SKIP
// loudly by name, and under HARNESS_TEST_REQUIRE_TYPESCRIPT=1 (lint.yml's machinery-lint, which
// installs the root) a compiler that cannot load FAILS. The #76 convention (i18n-tree.test.mjs).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeMatchesBroken } from '../../installer/lib/migrations.mjs'
import { edgeSuiteDirs } from '../../template/base/tools/lib/mutation-critical.mjs'

/** The root's `typescript`, or null where nothing is installed. */
const ts = await import('typescript').then(
  (m) => m.default ?? m,
  () => null,
)
const REQUIRE_TS = process.env.HARNESS_TEST_REQUIRE_TYPESCRIPT === '1'

/** A case that needs the compiler: skipped loudly without it, failed if this lane requires it. */
function tsTest(name, fn) {
  if (ts !== null) return test(name, fn)
  if (REQUIRE_TS) {
    return test(name, () =>
      assert.fail('typescript cannot be imported, and HARNESS_TEST_REQUIRE_TYPESCRIPT=1 says this lane reads the TypeScript source'),
    )
  }
  return test(
    name,
    {
      skip: 'typescript is not installed here (selftest.yml installer-unit runs with no install); lint.yml machinery-lint runs this case with the compiler',
    },
    fn,
  )
}

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const FN = join(REPO, 'template', 'stack', 'supabase', 'functions', 'delete-account')
const read = (...p) => readFileSync(join(...p), 'utf8')
const MIGRATIONS = JSON.parse(read(REPO, 'template', 'migrations.json'))

/** Every fixture this file makes, removed when it ends. @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** Source with comments and string/template literals blanked, so prose cannot satisfy a scan. */
function codeOnly(src) {
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
  }).outputText
  return out.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
}

tsTest('handler.ts names no Deno global and imports nothing at runtime (vitest runs it in Node)', () => {
  const src = read(FN, 'handler.ts')
  const code = codeOnly(src)
  assert.doesNotMatch(code, /\bDeno\b/, 'handler.ts reaches a Deno global, so Node cannot run it')
  // Transpiling erases a type-only import; what survives is what Node would have to resolve.
  const runtime = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  assert.doesNotMatch(runtime, /^\s*import\s/m, 'handler.ts has a runtime import')
  assert.doesNotMatch(src, /['"](?:jsr|npm):/, 'handler.ts names a jsr:/npm: specifier')
  assert.match(src, /^import type \{ SupabaseClient \} from '@supabase\/supabase-js'$/m)
})

tsTest('index.ts is the shell: the handler, the runtime binding, and nothing else', () => {
  const code = codeOnly(read(FN, 'index.ts'))
  const imports = [...read(FN, 'index.ts').matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['@supabase/supabase-js', './handler.ts'])
  assert.match(code, /Deno\.serve\(createDeleteAccountHandler\(/)
  // No decision is taken here: no branch, no loop, no query.
  assert.doesNotMatch(code, /\bif\s*\(|\bfor\s*\(|\?\?|\.from\(|deleteUser/, code)
})

test('deno.json pins supabase-js to one release, and the lock beside it records that release', () => {
  const config = JSON.parse(read(FN, 'deno.json'))
  const target = config.imports['@supabase/supabase-js']
  assert.match(target, /^jsr:@supabase\/supabase-js@\d+\.\d+\.\d+$/)
  const lock = JSON.parse(read(FN, 'deno.lock'))
  assert.ok(Object.hasOwn(lock.specifiers, target), `deno.lock does not resolve ${target}`)
})

// ── vitest.config.ts, executed ──────────────────────────────────────────────────────────

/**
 * Evaluate the SHIPPED vitest.config.ts with its root at `dir`: transpiled by TypeScript,
 * `vitest/config` replaced by an identity defineConfig, written into `dir` so the config's own
 * `new URL('.', import.meta.url)` resolves there.
 */
async function loadConfig(dir) {
  const stub = join(dir, 'vitest-config-stub.mjs')
  writeFileSync(stub, 'export const defineConfig = (config) => config\n')
  const js = ts
    .transpileModule(read(REPO, 'template', 'base', 'vitest.config.ts'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(/from ['"]vitest\/config['"]/, `from '${pathToFileURL(stub).href}'`)
  const file = join(dir, 'vitest.config.mjs')
  writeFileSync(file, js)
  const config = (await import(pathToFileURL(file).href)).default
  const unitNode = config.test.projects.find((p) => p?.test?.name === 'unit-node')
  return { include: unitNode.test.include, coverage: config.test.coverage.include }
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-vitest-edge-'))
  made.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

const VITEST_SUITE = "import { expect, it } from 'vitest'\nit('x', () => { expect(1).toBe(1) })\n"
const DENO_SUITE = "import { assertEquals } from 'jsr:@std/assert'\nDeno.test('x', () => assertEquals(1, 1))\n"

tsTest('vitest.config.ts collects every vitest suite under supabase/functions, and never a `deno test` file', async () => {
  const dir = tree({
    'supabase/functions/fn/handler.ts': 'export const x = 1\n',
    'supabase/functions/fn/handler.test.ts': VITEST_SUITE,
    'supabase/functions/fn/index.ts': 'Deno.serve(() => new Response())\n',
    'supabase/functions/legacy/index.ts': 'Deno.serve(() => new Response())\n',
    'supabase/functions/legacy/index.test.ts': DENO_SUITE,
    'supabase/functions/nested/lib/deep.test.ts': VITEST_SUITE.replace("'vitest'", '"vitest"'),
    'supabase/functions/node_modules/pkg/x.test.ts': VITEST_SUITE,
    'supabase/functions/_shared/cors.ts': 'export const cors = {}\n',
  })
  const { include, coverage } = await loadConfig(dir)
  const edge = include.filter((p) => p.startsWith('supabase/'))
  assert.deepEqual(edge, [
    'supabase/functions/fn/handler.test.ts',
    'supabase/functions/nested/lib/deep.test.ts',
  ])
  // Measured: the directories holding a vitest suite. NOT legacy/ (its only test is a Deno
  // test) and NOT _shared/ (no suite at all) — an install's untested helper stays out of the
  // aggregate, and diff-coverage names it when it changes.
  assert.deepEqual(
    coverage.filter((p) => p.startsWith('supabase/')),
    ['supabase/functions/fn/**/*.ts', 'supabase/functions/nested/**/*.ts'],
  )
  // The mutation lane's scoper reads the same tree the same way (tools/lib/mutation-critical.mjs
  // edgeSuiteDirs): a directory it lets Stryker mutate is exactly one vitest measures.
  assert.deepEqual(
    [...edgeSuiteDirs(dir)].map((d) => `${d}/**/*.ts`),
    coverage.filter((p) => p.startsWith('supabase/')),
  )
})

tsTest('vitest.config.ts with no supabase/functions at all: no Edge Function entry, and the config still loads', async () => {
  const { include, coverage } = await loadConfig(tree({ 'README.md': 'x\n' }))
  assert.equal(include.filter((p) => p.startsWith('supabase/')).length, 0)
  assert.equal(coverage.filter((p) => p.startsWith('supabase/')).length, 0)
  assert.ok(include.includes('packages/*/src/**/*.test.ts'), 'the rest of unit-node is untouched')
})

tsTest('the SHIPPED tree: the delete-account suite runs and its directory is measured', async () => {
  const dir = tree({
    'supabase/functions/delete-account/handler.test.ts': read(FN, 'handler.test.ts'),
    'supabase/functions/delete-account/handler.ts': read(FN, 'handler.ts'),
  })
  const { include, coverage } = await loadConfig(dir)
  assert.ok(include.includes('supabase/functions/delete-account/handler.test.ts'), include.join(', '))
  assert.ok(coverage.includes('supabase/functions/delete-account/**/*.ts'), coverage.join(', '))
})

// ── the ADR names tests that exist ──────────────────────────────────────────────────────

test("the account-deletion ADR's traceability rows name handler.test.ts cases that exist", () => {
  const adr = read(REPO, 'template', 'base', 'docs', 'adr', '20260720-account-deletion.md')
  const suite = read(FN, 'handler.test.ts')
  const row = adr.split('\n').find((l) => l.startsWith("| Only the caller's account dies |"))
  assert.ok(row, 'the ADR lost its "Only the caller\'s account dies" row')
  const ids = [...adr.matchAll(/`(?:handler\.test\.ts )?> ([^`]+)`/g)].map((m) => m[1])
  assert.ok(ids.length >= 4, `expected the handler test ids in the ADR, got ${String(ids.length)}`)
  assert.match(row, /handler\.test\.ts > /, 'the row names no test id')
  for (const id of ids) assert.ok(suite.includes(`'${id}'`), `the ADR names a test that does not exist: ${id}`)
})

// ── the 1.1.0 record: withheld from `update`, and a fix instruction for existing installs ─

test('the 1.1.0 record withholds the new function files and parks a fix the v1.0.3 index.ts matches', () => {
  const record = MIGRATIONS['1.1.0']
  for (const f of ['handler.ts', 'handler.test.ts', 'deno.json', 'deno.lock']) {
    assert.ok(
      record.seedOnInitOnly.includes(`supabase/functions/delete-account/${f}`),
      `${f} is not seedOnInitOnly: update would plant it into every existing install`,
    )
  }
  const fix = record.seededSourceFixes.find((f) => f.gate === 'lint')
  assert.ok(fix, 'no seededSourceFixes entry pairs the lint exemption')
  const v103 = read(REPO, 'tests', 'fixtures', 'released', '1.0.3', 'delete-account-index.ts.txt')
  for (const probe of fix.probes) {
    assert.equal(probe.path, 'supabase/functions/delete-account/index.ts')
    assert.equal(probeMatchesBroken(v103, probe.brokenWhen), true, 'the v1.0.3 index.ts must read as unfixed')
    assert.equal(probeMatchesBroken(read(FN, 'index.ts'), probe.brokenWhen), false, 'the 1.1.0 shell must read as fixed')
  }
  assert.deepEqual(
    [...fix.paths].sort(),
    ['deno.json', 'deno.lock', 'handler.test.ts', 'handler.ts', 'index.ts'].map((f) => `supabase/functions/delete-account/${f}`),
  )
})

test("eslint.config.mjs: the dated exemption covers exactly the seeded shell, and only the complexity block", () => {
  const config = read(REPO, 'template', 'base', 'eslint.config.mjs')
  assert.equal(config.match(/'supabase\/functions\/delete-account\/index\.ts'/g)?.length, 1)
  const block = config.slice(config.indexOf("ignores: ['supabase/functions/delete-account/index.ts']"))
  assert.match(block.slice(0, 400), /'sonarjs\/cognitive-complexity': \['error', 15\]/)
  assert.match(config, /^ {6}'supabase\/\*',\n {6}'!supabase\/functions\/',$/m, 'the global ignore must let supabase/functions back in')
  assert.match(config, /edge-functions-complexity-seeded-exemption/)
})
