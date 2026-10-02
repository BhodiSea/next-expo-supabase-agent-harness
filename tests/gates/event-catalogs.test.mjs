// In-process proofs for tools/lib/event-catalogs.mjs (1.1.0, #82): how
// tools/gen-event-catalog.mjs finds the event catalogs it walks. A vertical opts in by
// exporting its catalog from its `./client` entry as EVENT_CATALOG, so adding a vertical
// no longer means editing the owned, hash-pinned generator. The LEGACY entry keeps a 1.0.x
// install's catalog exactly as 1.0.x built it: while the root package.json lists
// @app/notes and that vertical has not opted in, the generator reads `noteEvents` from
// @app/notes/client, as the 1.0.x import did.
//
// In-process on purpose: only tests/gates/*.test.mjs count toward the
// template/base/tools/lib/** coverage floor in selftest.yml, and the generator itself runs
// under tsx in a scaffold (tests/gates/gen-event-catalog.test.mjs runs it over fixtures).
// Every fixture is a mkdtemp directory removed after the file. No bash and no git: the
// installer-unit job runs this file on windows-latest too, and the one case that needs a
// symlink skips there, loudly.
// SOURCE: template/base/tools/lib/event-catalogs.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CATALOG_EXPORT,
  LEGACY,
  catalogOf,
  discoverVerticals,
  legacyApplies,
  readRootPackage,
} from '../../template/base/tools/lib/event-catalogs.mjs'

const SCAFFOLD_SLICE = fileURLToPath(
  new URL(
    '../../template/base/.claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs',
    import.meta.url,
  ),
)

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/**
 * A root holding the given files (strings are written verbatim, anything else as JSON).
 * @param {Record<string, unknown>} files
 */
function root(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-event-catalogs-'))
  made.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

const DECLARED = "export { noteEvents as EVENT_CATALOG } from './events.js'\n"

// ── the constants ────────────────────────────────────────────────────────────

test('CATALOG_EXPORT is the one name a vertical exports its catalog under', () => {
  assert.equal(CATALOG_EXPORT, 'EVENT_CATALOG')
})

test('LEGACY names exactly the import 1.0.x hard-coded', () => {
  assert.deepEqual(LEGACY, {
    pkg: '@app/notes',
    specifier: '@app/notes/client',
    exportName: 'noteEvents',
  })
})

// ── discoverVerticals ────────────────────────────────────────────────────────

test('discoverVerticals: no packages/verticals directory is no verticals', () => {
  assert.deepEqual(discoverVerticals(root()), [])
  // packages/ without verticals/ under it
  assert.deepEqual(discoverVerticals(root({ 'packages/api/package.json': { name: '@app/api' } })), [])
})

test('discoverVerticals: packages/verticals as a plain file is no verticals', () => {
  assert.deepEqual(discoverVerticals(root({ 'packages/verticals': 'not a directory\n' })), [])
})

test('discoverVerticals: the directories come back in plain .sort() order', () => {
  const dir = root({
    'packages/verticals/zeta/package.json': { name: '@app/zeta' },
    'packages/verticals/Beta/package.json': { name: '@app/beta' },
    'packages/verticals/alpha/package.json': { name: '@app/alpha' },
    'packages/verticals/_under/package.json': { name: '@app/under' },
  })
  // Code-unit order: upper case before '_' before lower case.
  assert.deepEqual(
    discoverVerticals(dir).map((v) => v.pkg),
    ['@app/beta', '@app/under', '@app/alpha', '@app/zeta'],
  )
})

test('discoverVerticals: a string ./client entry resolves to a root-relative POSIX path', () => {
  const dir = root({
    'packages/verticals/notes/package.json': {
      name: '@app/notes',
      exports: { '.': './src/index.ts', './client': './src/client.ts' },
    },
    'packages/verticals/notes/src/client.ts': DECLARED,
  })
  assert.deepEqual(discoverVerticals(dir), [
    { pkg: '@app/notes', file: 'packages/verticals/notes/src/client.ts', declares: true },
  ])
})

test('discoverVerticals: an object entry reads its import field, then its default field', () => {
  const dir = root({
    'packages/verticals/a/package.json': {
      name: '@app/a',
      exports: { './client': { types: './types.d.ts', import: './src/a.ts', default: './src/ignored.ts' } },
    },
    'packages/verticals/a/src/a.ts': 'export const EVENT_CATALOG = {}\n',
    'packages/verticals/b/package.json': {
      name: '@app/b',
      exports: { './client': { default: './lib/client.mjs' } },
    },
    'packages/verticals/b/lib/client.mjs': 'export const EVENT_CATALOG = {}\n',
  })
  assert.deepEqual(discoverVerticals(dir), [
    { pkg: '@app/a', file: 'packages/verticals/a/src/a.ts', declares: true },
    { pkg: '@app/b', file: 'packages/verticals/b/lib/client.mjs', declares: true },
  ])
})

test('discoverVerticals: an object entry with neither import nor default is no entry', () => {
  const dir = root({
    'packages/verticals/c/package.json': {
      name: '@app/c',
      exports: { './client': { types: './src/client.d.ts', require: './src/client.cjs' } },
    },
    'packages/verticals/d/package.json': { name: '@app/d', exports: { './client': null } },
    'packages/verticals/e/package.json': { name: '@app/e', exports: './src/index.ts' },
    'packages/verticals/f/package.json': { name: '@app/f', exports: { '.': './src/index.ts' } },
    'packages/verticals/g/package.json': { name: '@app/g' },
    'packages/verticals/h/package.json': { name: '@app/h', exports: { './client': { import: 7 } } },
  })
  assert.deepEqual(discoverVerticals(dir), [
    { pkg: '@app/c', file: null, declares: false },
    { pkg: '@app/d', file: null, declares: false },
    { pkg: '@app/e', file: null, declares: false },
    { pkg: '@app/f', file: null, declares: false },
    { pkg: '@app/g', file: null, declares: false },
    { pkg: '@app/h', file: null, declares: false },
  ])
})

test('discoverVerticals: pkg is the directory name when the manifest has no string name', () => {
  const dir = root({
    'packages/verticals/nameless/package.json': { exports: { './client': './client.ts' } },
    'packages/verticals/nameless/client.ts': 'export const other = 1\n',
    'packages/verticals/numbered/package.json': { name: 7 },
    'packages/verticals/nulled/package.json': 'null',
  })
  assert.deepEqual(discoverVerticals(dir), [
    { pkg: 'nameless', file: 'packages/verticals/nameless/client.ts', declares: false },
    { pkg: 'nulled', file: null, declares: false },
    { pkg: 'numbered', file: null, declares: false },
  ])
})

test('discoverVerticals: a declared entry is one whose code, not its comments, names EVENT_CATALOG', () => {
  const dir = root({
    'packages/verticals/declared/package.json': { name: '@app/declared', exports: { './client': './c.ts' } },
    'packages/verticals/declared/c.ts': "// the catalog\nexport const EVENT_CATALOG = defineEventCatalog({})\n",
    'packages/verticals/line/package.json': { name: '@app/line', exports: { './client': './c.ts' } },
    'packages/verticals/line/c.ts': '// EVENT_CATALOG\nexport const other = 1\n',
    'packages/verticals/block/package.json': { name: '@app/block', exports: { './client': './c.ts' } },
    'packages/verticals/block/c.ts': '/* export { x as EVENT_CATALOG } */\nexport const other = 1\n',
    'packages/verticals/prefix/package.json': { name: '@app/prefix', exports: { './client': './c.ts' } },
    'packages/verticals/prefix/c.ts': 'export const MY_EVENT_CATALOG_V2 = {}\nexport const EVENT_CATALOGS = {}\n',
  })
  assert.deepEqual(
    discoverVerticals(dir).map((v) => [v.pkg, v.declares]),
    [
      ['@app/block', false],
      ['@app/declared', true],
      ['@app/line', false],
      ['@app/prefix', false],
    ],
  )
})

test('discoverVerticals: the slice scaffolder\'s client.ts stub names EVENT_CATALOG only in a comment, so it does not opt in', () => {
  const dir = root({
    'packages/verticals/billing-plans/package.json': {
      name: '@app/billing-plans',
      exports: { '.': './src/index.ts', './client': './src/client.ts' },
    },
  })
  const run = spawnSync(process.execPath, [SCAFFOLD_SLICE, 'billing-plans'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  const stub = readFileSync(join(dir, 'packages/verticals/billing-plans/src/client.ts'), 'utf8')
  assert.ok(
    stub.includes("// export { billingPlansEvents as EVENT_CATALOG } from './events.js'\n"),
    `the stub shows the opt-in line, commented out:\n${stub}`,
  )
  assert.ok(stub.includes('`pnpm gen`'), `the stub says to run pnpm gen after exporting it:\n${stub}`)
  assert.deepEqual(discoverVerticals(dir), [
    { pkg: '@app/billing-plans', file: 'packages/verticals/billing-plans/src/client.ts', declares: false },
  ])
  // The checklist names the export, beside the router's `pnpm gen` line.
  assert.ok(
    run.stdout.includes(
      "next: export the catalog from src/client.ts as EVENT_CATALOG (export { billingPlansEvents as EVENT_CATALOG } from './events.js'), or its events are never catalogued\n",
    ),
    run.stdout,
  )
  const lines = run.stdout.split('\n')
  assert.ok(
    lines.findIndex((l) => l.startsWith('next: export the catalog')) <
      lines.findIndex((l) => l.startsWith('next: wire the router')),
    `the catalog line comes before the router line, whose pnpm gen regenerates the catalog:\n${run.stdout}`,
  )
})

test('discoverVerticals: a missing entry file is an entry that does not declare', () => {
  const dir = root({
    'packages/verticals/ghost/package.json': { name: '@app/ghost', exports: { './client': './src/client.ts' } },
    // An entry whose parent is a FILE reads as ENOTDIR, which is absent too.
    'packages/verticals/flat/package.json': { name: '@app/flat', exports: { './client': './src/client.ts' } },
    'packages/verticals/flat/src': 'a file where a directory should be\n',
  })
  assert.deepEqual(discoverVerticals(dir), [
    { pkg: '@app/flat', file: 'packages/verticals/flat/src/client.ts', declares: false },
    { pkg: '@app/ghost', file: 'packages/verticals/ghost/src/client.ts', declares: false },
  ])
})

test('discoverVerticals: a directory without package.json and a plain file are skipped', () => {
  const dir = root({
    'packages/verticals/README.md': '# verticals\n',
    'packages/verticals/half-made/src/client.ts': DECLARED,
    'packages/verticals/tmpl/package.json.tmpl': { name: '@app/tmpl' },
    'packages/verticals/real/package.json': { name: '@app/real' },
  })
  assert.deepEqual(discoverVerticals(dir), [{ pkg: '@app/real', file: null, declares: false }])
})

test('discoverVerticals: a package.json that does not parse throws an error naming it', () => {
  const dir = root({
    'packages/verticals/good/package.json': { name: '@app/good' },
    'packages/verticals/broken/package.json': '{ "name": "@app/broken", }\n',
  })
  assert.throws(
    () => discoverVerticals(dir),
    (e) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /^packages\/verticals\/broken\/package\.json is not valid JSON \(/)
      return true
    },
  )
})

test('discoverVerticals: a read error other than absence is not swallowed', () => {
  // package.json that is a DIRECTORY reads as EISDIR: not absent, so it throws.
  const manifestDir = root({ 'packages/verticals/odd/package.json/keep': '' })
  assert.throws(() => discoverVerticals(manifestDir), { code: 'EISDIR' })
  // An entry that names a directory throws the same way.
  const entryDir = root({
    'packages/verticals/odd/package.json': { name: '@app/odd', exports: { './client': './src' } },
    'packages/verticals/odd/src/keep': '',
  })
  assert.throws(() => discoverVerticals(entryDir), { code: 'EISDIR' })
})

test('discoverVerticals: packages/verticals that cannot be listed for another reason throws', (t) => {
  if (process.platform === 'win32') {
    t.skip('SKIPPED on win32: a symlink loop needs symlink privileges there')
    return
  }
  const dir = root({ 'packages/keep': '' })
  // A symlink to itself: listing it is ELOOP, which is not absence.
  symlinkSync('verticals', join(dir, 'packages', 'verticals'))
  assert.throws(() => discoverVerticals(dir), { code: 'ELOOP' })
})

test('discoverVerticals: the default root is the current directory', () => {
  const dir = root({
    'packages/verticals/here/package.json': { name: '@app/here', exports: { './client': './c.ts' } },
    'packages/verticals/here/c.ts': DECLARED,
  })
  const prev = process.cwd()
  process.chdir(dir)
  try {
    assert.deepEqual(discoverVerticals(), [
      { pkg: '@app/here', file: 'packages/verticals/here/c.ts', declares: true },
    ])
  } finally {
    process.chdir(prev)
  }
})

// ── catalogOf ────────────────────────────────────────────────────────────────

const VALID = {
  'notes.created': { name: 'notes.created', version: 1, description: 'A note was inserted.' },
  'notes.deleted': { name: 'notes.deleted', version: 2, description: '' },
}

test('catalogOf: a valid catalog comes back as the same value', () => {
  assert.equal(catalogOf(VALID, 'packages/verticals/notes/src/client.ts'), VALID)
  const empty = {}
  assert.equal(catalogOf(empty, 'x'), empty)
})

test('catalogOf: null, a number, a string, undefined and an array throw naming where', () => {
  // An array is an object, but a catalog is keyed by wire name: even an empty one is
  // refused, so a vertical that exports a list learns so at once.
  for (const value of [null, 42, 'notes.created', undefined, [], [VALID['notes.created']]]) {
    assert.throws(
      () => catalogOf(value, 'packages/verticals/probe/src/client.ts'),
      (e) => {
        assert.ok(e instanceof Error)
        assert.ok(
          e.message.startsWith(
            'packages/verticals/probe/src/client.ts: EVENT_CATALOG is not an event catalog',
          ),
          e.message,
        )
        return true
      },
      `value ${String(value)}`,
    )
  }
})

test('catalogOf: an entry whose name is not its key throws naming where and the key', () => {
  const bad = { 'notes.created': { name: 'notes.updated', version: 1, description: 'x' } }
  assert.throws(() => catalogOf(bad, 'where.ts'), {
    message:
      'where.ts: EVENT_CATALOG["notes.created"] is not an event definition { name: "notes.created", version: <number>, description: <string> }',
  })
})

test('catalogOf: a missing or mistyped field, or a non-object entry, throws naming where', () => {
  const cases = [
    { 'a.b': { name: 'a.b', description: 'no version' } },
    { 'a.b': { name: 'a.b', version: '1', description: 'string version' } },
    { 'a.b': { name: 'a.b', version: 1 } },
    { 'a.b': { version: 1, description: 'no name' } },
    { 'a.b': null },
    { 'a.b': 'a.b' },
  ]
  for (const value of cases) {
    assert.throws(() => catalogOf(value, 'where.ts'), /^Error: where\.ts: EVENT_CATALOG\["a\.b"\] is not an event definition/, JSON.stringify(value))
  }
})

// ── readRootPackage ──────────────────────────────────────────────────────────

test('readRootPackage: the root package.json text, verbatim', () => {
  const text = '{\n  "name": "scaffold",\n  "devDependencies": { "@app/notes": "workspace:*" }\n}\n'
  assert.equal(readRootPackage(root({ 'package.json': text })), text)
})

test('readRootPackage: null when the root has no package.json', () => {
  assert.equal(readRootPackage(root()), null)
})

test('readRootPackage: the default root is the current directory', () => {
  const dir = root({ 'package.json': '{}\n' })
  const prev = process.cwd()
  process.chdir(dir)
  try {
    assert.equal(readRootPackage(), '{}\n')
  } finally {
    process.chdir(prev)
  }
})

// ── legacyApplies ────────────────────────────────────────────────────────────

const pkgText = (/** @type {Record<string, unknown>} */ manifest) => JSON.stringify(manifest)
const notes = (/** @type {boolean} */ declares) => ({
  pkg: '@app/notes',
  file: 'packages/verticals/notes/src/client.ts',
  declares,
})

test('legacyApplies: listed in devDependencies and not opted in', () => {
  const text = pkgText({ devDependencies: { '@app/notes': 'workspace:*' } })
  assert.equal(legacyApplies(text, [notes(false)]), true)
  // A 1.0.x install that removed the vertical but kept the root dependency: 1.0.x imported
  // it there too, so the entry still applies and the import fails as it did.
  assert.equal(legacyApplies(text, []), true)
})

test('legacyApplies: listed in dependencies and not opted in', () => {
  const text = pkgText({ dependencies: { '@app/notes': 'workspace:*' } })
  assert.equal(legacyApplies(text, [notes(false)]), true)
})

test('legacyApplies: not listed in either field', () => {
  assert.equal(legacyApplies(pkgText({}), [notes(false)]), false)
  assert.equal(
    legacyApplies(
      pkgText({ dependencies: { '@app/api': 'workspace:*' }, devDependencies: { '@app/events': 'workspace:*' } }),
      [notes(false)],
    ),
    false,
  )
  // A field that is not an object lists nothing.
  assert.equal(legacyApplies(pkgText({ devDependencies: ['@app/notes'] }), [notes(false)]), false)
  assert.equal(legacyApplies(pkgText({ dependencies: null }), [notes(false)]), false)
  assert.equal(legacyApplies('null', [notes(false)]), false)
})

test('legacyApplies: listed but opted in stands down', () => {
  const text = pkgText({ devDependencies: { '@app/notes': 'workspace:*' } })
  assert.equal(legacyApplies(text, [notes(true)]), false)
  // Only the vertical NAMED @app/notes counts: another vertical opting in changes nothing.
  assert.equal(
    legacyApplies(text, [notes(false), { pkg: '@app/probe', file: 'packages/verticals/probe/c.ts', declares: true }]),
    true,
  )
})

test('legacyApplies: no root package.json text never applies', () => {
  assert.equal(legacyApplies(null, [notes(false)]), false)
})

test('legacyApplies: text that does not parse throws an error naming package.json', () => {
  assert.throws(() => legacyApplies('{ "devDependencies": ', [notes(false)]), (e) => {
    assert.ok(e instanceof Error)
    assert.match(e.message, /^package\.json is not valid JSON \(/)
    return true
  })
})
