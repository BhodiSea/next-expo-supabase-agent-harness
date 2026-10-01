// tools/gen-event-catalog.mjs over fixture trees (1.1.0, #82; 2.0.0, #85). The generator
// walks the platform catalog plus each vertical whose `./client` declares EVENT_CATALOG.
// Through 1.1.x it also read the one catalog 1.0.x imported by name; that compatibility
// entry left with the example at 2.0.0, as the 1.1.0 record said it would. These cases run
// the SHIPPED generator with plain node over:
//   - a default 2.0.0 scaffold: no vertical, the default's committed two-row catalog;
//   - a --with-demo scaffold: notes has opted in, the demo's committed five-row catalog;
//   - a 1.0.x install that never opted in: its vertical is named as not catalogued;
//   - an install that adopted the export and kept the root dependency;
//   - B, a vertical that names EVENT_CATALOG and exports no catalog, fails closed;
//   - C, a vertical that names it only in a comment is listed as not catalogued;
//   - D, a tree without the example regenerates without it instead of throwing.
//
// The fixture stands in for an install: @app/events is a stub package under node_modules
// whose catalog is the committed file's two platform rows, the notes vertical's catalog is
// the demo's three notes rows, and its sources are .mjs so no tsx is needed. The generator and
// the libraries it imports are copied from the template into the fixture's tools/, because
// a bare specifier resolves from the importing file's directory, not from the cwd. The root
// dependency is a directory junction, which Windows creates without privileges; there is
// no bash and no git, so the installer-unit job runs this file on windows-latest too.
// SOURCE: template/base/tools/gen-event-catalog.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BASE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const DEMO = fileURLToPath(new URL('../../template/demo/', import.meta.url))
const OUTPUT = 'tools/generated/event-catalog.json'
/** The default scaffold's committed catalog: the platform rows alone. */
const COMMITTED = readFileSync(join(BASE, OUTPUT), 'utf8')
/** The --with-demo scaffold's committed catalog: the platform rows and the example's. */
const DEMO_COMMITTED = readFileSync(join(DEMO, OUTPUT), 'utf8')
/** @type {Array<{ name: string, version: number, description: string }>} */
const ROWS = JSON.parse(DEMO_COMMITTED)
const byPrefix = (/** @type {string} */ prefix) =>
  Object.fromEntries(ROWS.filter((r) => r.name.startsWith(prefix)).map((r) => [r.name, r]))
const PLATFORM = byPrefix('platform.')
const NOTES = byPrefix('notes.')
// The generator plus every tools/lib module it imports. A file the template does not ship
// yet is left out, so a generator that needs it fails on the import, loudly.
const TOOL_FILES = [
  'tools/gen-event-catalog.mjs',
  'tools/lib/inventory.mjs',
  'tools/lib/event-catalogs.mjs',
  'tools/lib/source-text.mjs',
]

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** @param {string} dir @param {Record<string, unknown>} files */
function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(
      join(dir, rel),
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    )
  }
}

/**
 * An install-shaped tree.
 * @param {{ notes?: 'declared' | 'legacy' | null, rootLists?: boolean, extra?: Record<string, unknown>, committed?: string }} shape
 *   notes: how the example's ./client exports its catalog (null: the example is absent);
 *   rootLists: whether the root package.json lists @app/notes (and so links it);
 *   committed: the catalog the tree has committed (the demo's, unless a test says).
 */
function install({ notes = 'declared', rootLists = false, extra = {}, committed = DEMO_COMMITTED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-gen-events-'))
  made.push(dir)
  for (const rel of TOOL_FILES) {
    if (!existsSync(join(BASE, rel))) continue
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    copyFileSync(join(BASE, rel), join(dir, rel))
  }
  write(dir, {
    [OUTPUT]: committed,
    'package.json': {
      name: 'scaffold',
      private: true,
      type: 'module',
      devDependencies: {
        '@app/events': 'workspace:*',
        ...(rootLists ? { '@app/notes': 'workspace:*' } : {}),
      },
    },
    'node_modules/@app/events/package.json': {
      name: '@app/events',
      type: 'module',
      exports: { '.': './index.mjs' },
    },
    'node_modules/@app/events/index.mjs':
      `export const platformEvents = ${JSON.stringify(PLATFORM)}\n` +
      'export function listEvents(catalog) {\n' +
      '  return Object.values(catalog).sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))\n' +
      '}\n',
    ...extra,
  })
  if (notes !== null) {
    write(dir, {
      'packages/verticals/notes/package.json': {
        name: '@app/notes',
        type: 'module',
        exports: { '.': './src/index.mjs', './client': './src/client.mjs' },
      },
      'packages/verticals/notes/src/events.mjs': `export const noteEvents = ${JSON.stringify(NOTES)}\n`,
      'packages/verticals/notes/src/client.mjs':
        notes === 'declared'
          ? "export { noteEvents as EVENT_CATALOG } from './events.mjs'\n"
          : "export { noteEvents } from './events.mjs'\n",
    })
  }
  if (rootLists) {
    // pnpm links a root dependency into the root node_modules; a junction is that link.
    mkdirSync(join(dir, 'node_modules', '@app'), { recursive: true })
    symlinkSync(
      join(dir, 'packages', 'verticals', 'notes'),
      join(dir, 'node_modules', '@app', 'notes'),
      'junction',
    )
  }
  return dir
}

/** @param {string} dir @param {string[]} args */
function generate(dir, args = []) {
  const run = spawnSync(process.execPath, ['tools/gen-event-catalog.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

const IN_SYNC = `${OUTPUT}: in sync (5 events)\n`

test('the fixture splits the demo catalog into two platform rows and three notes rows; the default holds the platform two', () => {
  assert.equal(ROWS.length, 5)
  assert.deepEqual(Object.keys(PLATFORM), ['platform.error_surfaced', 'platform.session_changed'])
  assert.deepEqual(Object.keys(NOTES), ['notes.created', 'notes.deleted', 'notes.updated'])
  assert.equal(COMMITTED, `${JSON.stringify(Object.values(PLATFORM), null, 2)}\n`)
})

test('2.0.0: a default scaffold (no vertical) regenerates the default committed catalog', () => {
  const dir = install({ notes: null, committed: COMMITTED })
  assert.deepEqual(generate(dir, ['--check']), { status: 0, stdout: `${OUTPUT}: in sync (2 events)\n`, stderr: '' })
})

test('a --with-demo scaffold (notes opted in, the root does not list it) regenerates the demo committed catalog', () => {
  const dir = install({ notes: 'declared', rootLists: false })
  assert.deepEqual(generate(dir, ['--check']), { status: 0, stdout: IN_SYNC, stderr: '' })
})

test('2.0.0: a 1.0.x install that never opted in is told its vertical is not catalogued — the compatibility entry is gone', () => {
  const dir = install({ notes: 'legacy', rootLists: true })
  const run = generate(dir, ['--check'])
  assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
  assert.ok(run.stdout.includes(`${OUTPUT}: @app/notes is not catalogued (its ./client declares no EVENT_CATALOG)`), run.stdout)
  assert.ok(run.stderr.startsWith(`${OUTPUT} is stale`), run.stderr)
})

test('proof A: an install that adopted the export and kept the root dependency regenerates it once', () => {
  const dir = install({ notes: 'declared', rootLists: true })
  // No duplicate-name error: the compatibility entry stands down once notes opts in.
  assert.deepEqual(generate(dir, ['--check']), { status: 0, stdout: IN_SYNC, stderr: '' })
})

test('proof B: a vertical that names EVENT_CATALOG and exports no catalog fails closed, naming its file', () => {
  const dir = install({
    extra: {
      'packages/verticals/probe/package.json': {
        name: '@app/probe',
        exports: { './client': './src/client.mjs' },
      },
      'packages/verticals/probe/src/client.mjs': 'export const EVENT_CATALOG = 42\n',
    },
  })
  const run = generate(dir, ['--check'])
  assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
  assert.ok(
    run.stderr.includes(
      'packages/verticals/probe/src/client.mjs: EVENT_CATALOG is not an event catalog',
    ),
    run.stderr,
  )
})

test('proof C: a vertical that names EVENT_CATALOG only in a comment is listed as not catalogued', () => {
  const dir = install({
    extra: {
      'packages/verticals/probe/package.json': {
        name: '@app/probe',
        exports: { './client': './src/client.mjs' },
      },
      'packages/verticals/probe/src/client.mjs': '// EVENT_CATALOG\nexport const other = 1\n',
    },
  })
  assert.deepEqual(generate(dir, ['--check']), {
    status: 0,
    stdout: `${OUTPUT}: @app/probe is not catalogued (its ./client declares no EVENT_CATALOG)\n${IN_SYNC}`,
    stderr: '',
  })
})

test('proof D: without the example the generator regenerates without it instead of throwing', () => {
  const dir = install({ notes: null, rootLists: false })
  const check = generate(dir, ['--check'])
  assert.equal(check.status, 1, 'the committed copy still lists the three notes rows, so --check reds')
  assert.ok(check.stderr.startsWith(`${OUTPUT} is stale`), check.stderr)
  assert.deepEqual(generate(dir), { status: 0, stdout: `wrote ${OUTPUT}\n`, stderr: '' })
  // Exactly the three notes.* rows are gone; what is left is the default's committed file.
  const kept = ROWS.filter((r) => !r.name.startsWith('notes.'))
  assert.equal(readFileSync(join(dir, OUTPUT), 'utf8'), `${JSON.stringify(kept, null, 2)}\n`)
  assert.equal(readFileSync(join(dir, OUTPUT), 'utf8'), COMMITTED)
  assert.deepEqual(generate(dir, ['--check']), {
    status: 0,
    stdout: `${OUTPUT}: in sync (2 events)\n`,
    stderr: '',
  })
})

test('a new vertical that opts in is catalogued with no edit to the generator', () => {
  const probe = { 'probe.pinged': { name: 'probe.pinged', version: 1, description: 'A probe.' } }
  const dir = install({
    extra: {
      'packages/verticals/probe/package.json': {
        name: '@app/probe',
        exports: { './client': { import: './src/client.mjs' } },
      },
      'packages/verticals/probe/src/client.mjs': `export const EVENT_CATALOG = ${JSON.stringify(probe)}\n`,
    },
  })
  const stale = generate(dir, ['--check'])
  assert.equal(stale.status, 1, 'the committed copy lacks the new row, so --check reds')
  assert.deepEqual(generate(dir), { status: 0, stdout: `wrote ${OUTPUT}\n`, stderr: '' })
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, OUTPUT), 'utf8')).map((/** @type {{ name: string }} */ r) => r.name),
    ['notes.created', 'notes.deleted', 'notes.updated', 'platform.error_surfaced', 'platform.session_changed', 'probe.pinged'],
  )
})

// ── the shipped sources ──────────────────────────────────────────────────────

const NAMED = /@app\/notes|noteEvents/

/** Every .mjs under template/base/tools/, as POSIX paths relative to it. */
function toolScripts(dir = join(BASE, 'tools'), rel = '') {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...toolScripts(join(dir, entry.name), path))
    else if (entry.name.endsWith('.mjs')) out.push(path)
  }
  return out.sort()
}

test('the generator names neither the example package nor its catalog export', () => {
  const src = readFileSync(join(BASE, 'tools/gen-event-catalog.mjs'), 'utf8')
  assert.doesNotMatch(src, NAMED)
})

test('2.0.0 (#85): no script under template/base/tools/ names the example or its export', () => {
  const offenders = toolScripts().filter((rel) => NAMED.test(readFileSync(join(BASE, 'tools', rel), 'utf8')))
  assert.deepEqual(offenders, [], 'these tools name @app/notes or noteEvents')
})

test('the demo\'s example opts in, and the seeded root package.json does not list it', () => {
  const client = readFileSync(join(DEMO, 'packages/verticals/notes/src/client.ts'), 'utf8')
  assert.ok(client.includes("export { noteEvents as EVENT_CATALOG } from './events.js'\n"), client)
  assert.doesNotMatch(client, /export \{ noteEvents \}/)
  const rootPkg = JSON.parse(readFileSync(join(BASE, 'package.json.tmpl'), 'utf8'))
  assert.equal(rootPkg.devDependencies['@app/notes'], undefined)
  assert.equal(rootPkg.dependencies?.['@app/notes'], undefined)
  // The generator still needs @app/events from the root, as before.
  assert.equal(rootPkg.devDependencies['@app/events'], 'workspace:*')
})

test('the slice skill\'s dal-dto reference says how a vertical is catalogued', () => {
  const ref = readFileSync(
    join(BASE, '.claude/skills/authoring-vertical-slice/references/dal-dto.md'),
    'utf8',
  )
  assert.ok(
    ref.includes(
      "(`export { <slice>Events as EVENT_CATALOG } from './events.js'`): that name in this file is\n" +
        '  how `tools/gen-event-catalog.mjs` finds the vertical, and a vertical without it is not\n' +
        '  catalogued.',
    ),
    'references/dal-dto.md names the export and what it is for',
  )
})
