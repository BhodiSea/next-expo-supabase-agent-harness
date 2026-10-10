// Shared fixtures for the Single Home library's in-process tests (2.1.0, #186):
// tests/gates/{shapes,homes,importers,workspace-tiers,complexity,sweep}.test.mjs.
//
// THE PARSER. The extractor reads TypeScript through the project's own `typescript`, which
// selftest.yml's installer-unit never installs: there the tests that need it SKIP loudly by
// name. lint.yml's machinery-shapes step installs the root and sets
// HARNESS_TEST_REQUIRE_TYPESCRIPT=1, which turns a parser that cannot load into a failure.
//
// THE TREE. The library reads the working directory as a project root (the gates run from
// one), so a fixture is a temp directory the test chdirs into for the length of one call.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { loadParser } from '../../../template/base/tools/lib/i18n-tree.mjs'

export const ts = await loadParser()
const REQUIRE_TS = process.env.HARNESS_TEST_REQUIRE_TYPESCRIPT === '1'

/**
 * A test that needs the parser: it skips by name where `typescript` is absent, and fails
 * there under HARNESS_TEST_REQUIRE_TYPESCRIPT=1.
 * @param {string} name @param {() => void | Promise<void>} fn
 */
export function treeTest(name, fn) {
  if (ts !== null) return test(name, fn)
  if (REQUIRE_TS) {
    return test(name, () =>
      assert.fail('typescript cannot be imported, and HARNESS_TEST_REQUIRE_TYPESCRIPT=1 says this lane runs the extractor'),
    )
  }
  return test(name, {
    skip: 'typescript is not installed here (selftest.yml installer-unit runs with no install); lint.yml machinery-shapes runs this test with the parser',
  }, fn)
}

/** Write a tree of files under `dir`. @param {string} dir @param {Record<string, string>} files */
function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

/**
 * Run `fn` with a fixture tree as the working directory, then remove the tree; for an async
 * `fn`, once its promise settles.
 * @template T
 * @param {Record<string, string>} files @param {(dir: string) => T} fn @returns {T}
 */
export function inTree(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-sh-'))
  const cwd = process.cwd()
  const done = () => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
  let result
  try {
    writeTree(dir, files)
    process.chdir(dir)
    result = fn(dir)
  } catch (error) {
    done()
    throw error
  }
  if (result instanceof Promise) return /** @type {T} */ (result.finally(done))
  done()
  return result
}

/**
 * A workspace package.json: its name, its runtime dependencies, and an `exports` map
 * (default: `.` to src/index.ts).
 * @param {string} name @param {string[]} [deps] @param {Record<string, string | Record<string, string>>} [exportsMap]
 */
export function pkg(name, deps = [], exportsMap = { '.': './src/index.ts' }) {
  const dependencies = Object.fromEntries(deps.map((d) => [d, 'workspace:*']))
  return `${JSON.stringify({ name, private: true, type: 'module', exports: exportsMap, dependencies }, null, 2)}\n`
}

/** A 40-odd-token body worth a class: `name` with its literals. @param {string} name */
export const BODY = (name, label = 'notes.created') => `export function ${name}(origin: { actorId: string, orgId: string }, id: string, at: string) {
  const payload = { actorId: origin.actorId, id, at, orgId: origin.orgId }
  return { name: '${label}', payload }
}
`

/**
 * The plan's named functions (SINGLE-HOME §2.1, G.5, the dogfood rows), as they stood at
 * #143's head: name → [token count under TOKEN_CONVENTION, source].
 * @type {Record<string, [number, string]>}
 */
export const GOLDEN = {
  publicCredentials: [
    33,
    `export function publicCredentials(): SupabaseCredentials {
  // the WEB parser specifically
  const env = parseWebPublicEnv()
  return requireCredentials(
    {
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE,
      url: env.NEXT_PUBLIC_SUPABASE_URL,
    },
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
  )
}`,
  ],
  subscribe: [
    33,
    `function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}`,
  ],
  asRowArray: [
    24,
    `export function asRowArray(data: unknown): readonly unknown[] {
  return Array.isArray(data) ? data : []
}`,
  ],
  invalidCursor: [
    28,
    `export function invalidCursor(): AppError {
  return appError.validation({
    code: 'invalid_cursor',
    fields: ['cursor'],
    message: 'the page cursor is not one this server minted',
  })
}`,
  ],
  useTheme: [
    29,
    `export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (value === null) {
    throw new Error('useTheme must be called inside a <ThemeProvider>')
  }
  return value
}`,
  ],
  noteCreated: [
    48,
    `export function noteCreated(origin: EventOrigin, noteId: string, occurredAt: string): NoteEvent {
  return {
    name: 'notes.created',
    payload: { actorId: origin.actorId, noteId, occurredAt, orgId: origin.orgId },
  }
}`,
  ],
}
