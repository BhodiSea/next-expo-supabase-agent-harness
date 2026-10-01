// The worked example as an opt-in overlay (2.0.0, #85): `init` plans no demo path,
// `init --with-demo` plans every one of them, and `eject` takes the demo back out of an
// install that chose it. These tests run the real CLI against the real template tree, so
// the demo's paths and the sidecar row index are read from template/, never restated here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTemplate } from '../../installer/lib/copy.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const INDEX = fileURLToPath(new URL('../../template/demo-index.json', import.meta.url))

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** @param {string[]} args */
function run(args) {
  const res = spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

const made = []
/** @param {string} tag */
function tmp(tag) {
  const dir = mkdtempSync(join(tmpdir(), `epah-demo-${tag}-`))
  made.push(dir)
  return dir
}
test.after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

// Every install path the demo tree ships, and the subset no default plan ships.
const demoPaths = walkTemplate('demo').map((e) => e.installPath)
const defaultPaths = new Set([...walkTemplate('base'), ...walkTemplate('stack')].map((e) => e.installPath))
const demoOnly = demoPaths.filter((p) => !defaultPaths.has(p))
const shared = demoPaths.filter((p) => defaultPaths.has(p))

/** @param {string} dir */
function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
}

/** @param {string} dir @param {Record<string, unknown>} m */
function writeManifestRaw(dir, m) {
  writeFileSync(join(dir, '.harness/manifest.json'), `${JSON.stringify(m, null, 2)}\n`)
}

/** Every file under `dir` outside .harness/, POSIX-keyed, with its bytes. */
function tree(dir) {
  const out = new Map()
  const walk = (abs, rel) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const r = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (r === '.harness') continue
      if (ent.isDirectory()) walk(join(abs, ent.name), r)
      else out.set(r, readFileSync(join(abs, ent.name)))
    }
  }
  walk(dir, '')
  return out
}

test('the demo tree exists, ships demo-only paths, and the sidecar index names rows', () => {
  assert.ok(demoOnly.length > 0, 'template/demo ships no demo-only path')
  assert.ok(shared.length > 0, 'template/demo overlays no shared file')
  const index = JSON.parse(readFileSync(INDEX, 'utf8'))
  assert.ok(Array.isArray(index.rows) && index.rows.length > 0, 'template/demo-index.json lists no rows')
})

test('default init plans no demo path and records demo: false', () => {
  const dir = tmp('plan')
  const r = run(['init', '--dir', dir, '--tier', 'core', '--yes', '--dry-run', '--report', 'json', ...SETS])
  assert.equal(r.code, 0, r.out)
  const written = new Set(JSON.parse(r.out).written)
  const leaked = demoOnly.filter((p) => written.has(p))
  assert.deepEqual(leaked, [], 'a default init planned demo-only paths')

  const real = tmp('default')
  assert.equal(run(['init', '--dir', real, '--tier', 'core', '--yes', ...SETS]).code, 0)
  const m = manifestOf(real)
  assert.equal(m.demo, false, 'a 2.0.0 default init records demo: false')
  for (const p of demoOnly) assert.ok(!existsSync(join(real, p)), `default init wrote ${p}`)
})

test('init --with-demo plans every demo path, with the demo bytes, and records demo: true', () => {
  const dir = tmp('plan-demo')
  const r = run(['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', '--dry-run', '--report', 'json', ...SETS])
  assert.equal(r.code, 0, r.out)
  const written = new Set(JSON.parse(r.out).written)
  const missing = demoPaths.filter((p) => !written.has(p))
  assert.deepEqual(missing, [], 'init --with-demo left demo paths out of its plan')

  const real = tmp('demo')
  const res = run(['init', '--dir', real, '--tier', 'core', '--yes', '--with-demo', ...SETS])
  assert.equal(res.code, 0, res.out)
  const m = manifestOf(real)
  assert.equal(m.demo, true)
  // Same-path replacement: each shared file carries the demo's bytes, not the default's.
  const def = tmp('demo-def')
  assert.equal(run(['init', '--dir', def, '--tier', 'core', '--yes', ...SETS]).code, 0)
  const differing = shared.filter((p) => !readFileSync(join(real, p)).equals(readFileSync(join(def, p))))
  assert.ok(differing.length > 0, 'no shared file differs between the demo and the default install')
  for (const p of demoPaths) assert.ok(p in m.files, `demo path not recorded in the manifest: ${p}`)
  // The demo's workspace package is in the root solution file, under @app/api's layer.
  const solution = readFileSync(join(real, 'tsconfig.json'), 'utf8')
  const notesAt = solution.indexOf('"packages/verticals/notes"')
  assert.ok(notesAt > 0, 'the demo vertical is missing from the root solution file')
  assert.ok(notesAt < solution.indexOf('"packages/api"'), 'the demo vertical must sit below @app/api in layer order')
  assert.ok(!readFileSync(join(def, 'tsconfig.json'), 'utf8').includes('verticals/notes'))
})

test('eject after init --with-demo leaves the same files as a default init, byte for byte, outside .harness/', () => {
  const def = tmp('cmp-default')
  const demo = tmp('cmp-demo')
  assert.equal(run(['init', '--dir', def, '--tier', 'core', '--yes', ...SETS]).code, 0)
  assert.equal(run(['init', '--dir', demo, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)

  const r = run(['eject', '--dir', demo])
  assert.equal(r.code, 0, r.out)

  const a = tree(def)
  const b = tree(demo)
  const onlyDefault = [...a.keys()].filter((k) => !b.has(k))
  const onlyEjected = [...b.keys()].filter((k) => !a.has(k))
  const different = [...a.keys()].filter((k) => b.has(k) && !a.get(k).equals(b.get(k)))
  assert.deepEqual({ onlyDefault, onlyEjected, different }, { onlyDefault: [], onlyEjected: [], different: [] })

  const m = manifestOf(demo)
  assert.equal(m.demo, false, 'eject must record demo: false')
  for (const p of demoOnly) assert.ok(!(p in m.files), `ejected path still recorded: ${p}`)
  // Every recorded file matches the bytes on disk: the manifest describes the ejected tree.
  for (const [ip, meta] of Object.entries(m.files)) {
    if (meta.mode === 'conflicted') continue
    assert.equal(sha256(readFileSync(join(demo, ip))), meta.sha256, `stale record after eject: ${ip}`)
  }
  // The migrations eject deleted are recorded with the bytes it deleted (the `migrations`
  // gate reads this record; see check-migrations.mjs).
  const demoMigrations = demoOnly.filter((p) => p.startsWith('supabase/migrations/'))
  assert.ok(demoMigrations.length > 0)
  assert.deepEqual(Object.keys(m.ejectedMigrations ?? {}).sort(), demoMigrations.sort())
  // And a second eject has nothing to remove: the install no longer has the demo.
  const again = run(['eject', '--dir', demo])
  assert.equal(again.code, 1, again.out)
})

test("eject clears the build output of a package it removed whole, and keeps a directory holding anything else", () => {
  // A worked-in install has built the demo's packages: `tsc -b` writes dist/ and pnpm links
  // node_modules/ inside each one. Left behind, packages/verticals/notes/ would still read as
  // a vertical directory to every gate that walks packages/verticals/*.
  const demo = tmp('build-output')
  assert.equal(run(['init', '--dir', demo, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const notes = join(demo, 'packages/verticals/notes')
  mkdirSync(join(notes, 'dist'), { recursive: true })
  writeFileSync(join(notes, 'dist/index.js'), 'export {}\n')
  mkdirSync(join(notes, 'node_modules/@app'), { recursive: true })
  writeFileSync(join(notes, 'node_modules/.modules.yaml'), 'x\n')
  writeFileSync(join(notes, 'tsconfig.tsbuildinfo'), '{}\n')
  // A package directory holding a file eject did not write is the project's to judge.
  const api = join(demo, 'apps/web/lib/app-data')
  writeFileSync(join(api, 'orders.ts'), 'export const orders = 1\n')
  const r = run(['eject', '--dir', demo])
  assert.equal(r.code, 0, r.out)
  assert.ok(!existsSync(notes), 'the removed package directory, build output and all, is gone')
  assert.ok(!existsSync(join(demo, 'packages/verticals')), 'and so is the empty verticals directory')
  assert.ok(existsSync(join(api, 'orders.ts')), "the project's own file stays")

  // A removed package directory that holds a file eject did not write is kept, and said so.
  const kept = tmp('build-output-kept')
  assert.equal(run(['init', '--dir', kept, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const keptNotes = join(kept, 'packages/verticals/notes')
  mkdirSync(join(keptNotes, 'dist'), { recursive: true })
  writeFileSync(join(keptNotes, 'NOTES.local.md'), 'mine\n')
  const k = run(['eject', '--dir', kept])
  assert.equal(k.code, 0, k.out)
  assert.ok(existsSync(join(keptNotes, 'NOTES.local.md')))
  assert.match(k.out, /packages\/verticals\/notes\/ is kept: it holds files eject did not write \(NOTES\.local\.md, dist\)/)
})

test('eject --dry-run writes nothing and lists what a real run removes', () => {
  const dir = tmp('dry')
  assert.equal(run(['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const before = tree(dir)
  const manifestBefore = readFileSync(join(dir, '.harness/manifest.json'), 'utf8')
  const r = run(['eject', '--dir', dir, '--dry-run'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`would remove ${demoOnly[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const after = tree(dir)
  assert.equal(after.size, before.size)
  for (const [k, v] of before) assert.ok(after.get(k)?.equals(v), `dry run changed ${k}`)
  assert.equal(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'), manifestBefore)
})

test('eject keeps a drifted file and a re-recorded fork, and parks the default copy of a drifted shared file', () => {
  const dir = tmp('keep')
  assert.equal(run(['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const textOnly = demoOnly.filter((p) => /\.(ts|tsx|sql)$/.test(p))
  const [drifted, forked] = textOnly
  const sharedCode = shared.find((p) => /\.(ts|tsx)$/.test(p))
  assert.ok(drifted && forked && sharedCode)

  // Drift: edited, record unchanged.
  writeFileSync(join(dir, drifted), `${readFileSync(join(dir, drifted), 'utf8')}\n// local edit\n`)
  // Fork: edited AND the record re-pointed at the edited bytes.
  const forkBytes = `${readFileSync(join(dir, forked), 'utf8')}\n// a fork the project re-recorded\n`
  writeFileSync(join(dir, forked), forkBytes)
  // A shared file the project changed: eject cannot restore the default bytes over it.
  const sharedBytes = `${readFileSync(join(dir, sharedCode), 'utf8')}\n// project change\n`
  writeFileSync(join(dir, sharedCode), sharedBytes)
  const m = manifestOf(dir)
  m.files[forked] = { ...m.files[forked], sha256: sha256(forkBytes) }
  writeManifestRaw(dir, m)

  const r = run(['eject', '--dir', dir])
  assert.equal(r.code, 2, `kept files must surface as exit 2\n${r.out}`)
  assert.ok(existsSync(join(dir, drifted)), 'eject deleted a drifted file')
  assert.ok(existsSync(join(dir, forked)), 'eject deleted a re-recorded fork')
  assert.equal(readFileSync(join(dir, forked), 'utf8'), forkBytes)
  assert.equal(readFileSync(join(dir, sharedCode), 'utf8'), sharedBytes, 'eject overwrote a changed shared file')
  assert.ok(existsSync(join(dir, '.harness/pending', sharedCode)), 'the default copy of a kept shared file must be parked')
  assert.match(r.out, new RegExp(drifted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const after = manifestOf(dir)
  assert.equal(after.demo, false)
  assert.ok(!(drifted in after.files), 'a kept demo file is the project\'s now: its record is dropped, as disable does')
  // Untouched demo-only files are gone.
  const untouched = demoOnly.filter((p) => p !== drifted && p !== forked)
  for (const p of untouched) assert.ok(!existsSync(join(dir, p)), `eject left ${p}`)
})

test('eject deletes only the indexed rows a project left as shipped, in a register the project changed', () => {
  const dir = tmp('rows')
  assert.equal(run(['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const index = JSON.parse(readFileSync(INDEX, 'utf8'))
  const byFile = new Map()
  for (const row of index.rows) if (row.jsonPointer !== undefined) byFile.set(row.file, [...(byFile.get(row.file) ?? []), row])
  // A register whose demo rows sit in an array, so a project row can be appended beside them.
  const [file, rows] = [...byFile].find(([, rs]) => rs.some((r) => /\/\d+$/.test(r.jsonPointer))) ?? []
  assert.ok(file, 'the index names no array rows in a JSON register')
  const arrayPath = rows.find((r) => /\/\d+$/.test(r.jsonPointer)).jsonPointer.replace(/\/\d+$/, '')
  const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const at = (o, ptr) => ptr.split('/').slice(1).reduce((x, k) => x[k.replaceAll('~1', '/').replaceAll('~0', '~')], o)
  const arr = at(doc, arrayPath)
  const projectRow = { ...arr[0], projectRow: 'kept by eject' }
  arr.unshift(projectRow) // BEFORE the demo rows: every shipped pointer now misses by one
  writeFileSync(join(dir, file), `${JSON.stringify(doc, null, 2)}\n`)

  const r = run(['eject', '--dir', dir])
  assert.equal(r.code, 0, r.out)
  const after = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const left = at(after, arrayPath)
  assert.ok(left.some((x) => x.projectRow === 'kept by eject'), 'eject deleted a project row')
  const demoReg = JSON.parse(readFileSync(fileURLToPath(new URL(`../../template/demo/${file}`, import.meta.url)), 'utf8'))
  for (const row of rows) {
    const shipped = JSON.stringify(at(demoReg, row.jsonPointer))
    assert.ok(!left.some((x) => JSON.stringify(x) === shipped), `${file}${row.jsonPointer}: a shipped demo row survived eject`)
  }
  assert.match(r.out, /row/)
})

test('eject on an install without the demo exits non-zero and changes nothing', () => {
  const dir = tmp('nodemo')
  assert.equal(run(['init', '--dir', dir, '--tier', 'core', '--yes', ...SETS]).code, 0)
  const before = readFileSync(join(dir, '.harness/manifest.json'), 'utf8')
  const r = run(['eject', '--dir', dir])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no demo/)
  assert.equal(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'), before)

  // A manifest from before 2.0.0 records no demo either: its example is woven into the spine
  // migrations, so eject refuses rather than guess (docs/runbooks/harness-upgrade.md).
  const m = JSON.parse(before)
  delete m.demo
  writeManifestRaw(dir, m)
  const old = run(['eject', '--dir', dir])
  assert.equal(old.code, 1, old.out)
  assert.match(old.out, /before 2\.0\.0/)

  const empty = tmp('nomanifest')
  const none = run(['eject', '--dir', empty])
  assert.equal(none.code, 1, none.out)
  assert.match(none.out, /run `init` first/)
})

test('init --with-demo refuses a retrofit, and init --force carries the demo choice', () => {
  // The lifecycle suite's retrofit target: a workspace with its own apps/web.
  const retro = tmp('retro')
  writeFileSync(join(retro, 'package.json'), JSON.stringify({ name: 'existing', dependencies: { next: '16.0.0' } }))
  writeFileSync(join(retro, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(retro, 'apps/web/src'), { recursive: true })
  writeFileSync(join(retro, 'apps/web/package.json'), '{"name":"web"}\n')
  const r = run(['init', '--dir', retro, '--yes', '--with-demo', ...SETS])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--with-demo/)
  assert.ok(!existsSync(join(retro, '.harness/manifest.json')), 'a refused retrofit must write nothing')

  const dir = tmp('force')
  assert.equal(run(['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const again = run(['init', '--dir', dir, '--tier', 'core', '--yes', '--force'])
  assert.equal(again.code, 0, again.out)
  assert.equal(manifestOf(dir).demo, true, 'init --force must carry the demo choice')
  for (const p of demoOnly) assert.ok(existsSync(join(dir, p)), `--force re-render dropped ${p}`)
})

test('update keeps a demo install whole and never plants the demo into a default install', () => {
  const demo = tmp('upd-demo')
  assert.equal(run(['init', '--dir', demo, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const u = run(['update', '--dir', demo])
  assert.equal(u.code, 0, u.out)
  assert.ok(readFileSync(join(demo, 'tsconfig.json'), 'utf8').includes('"packages/verticals/notes"'), 'update dropped the demo reference')
  for (const p of demoOnly) assert.ok(existsSync(join(demo, p)), `update removed ${p}`)
  assert.equal(manifestOf(demo).demo, true)

  const def = tmp('upd-default')
  assert.equal(run(['init', '--dir', def, '--tier', 'core', '--yes', ...SETS]).code, 0)
  // A project that deleted nothing and asked for nothing gets no demo file from update.
  const d = run(['update', '--dir', def])
  assert.equal(d.code, 0, d.out)
  for (const p of demoOnly) assert.ok(!existsSync(join(def, p)), `update planted ${p} into a default install`)

  // An install that predates the demo record and still carries the example keeps the
  // example's project reference across update (its package is on disk).
  const old = tmp('upd-old')
  assert.equal(run(['init', '--dir', old, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const m = manifestOf(old)
  delete m.demo
  writeManifestRaw(old, m)
  const o = run(['update', '--dir', old])
  assert.equal(o.code, 0, o.out)
  assert.ok(readFileSync(join(old, 'tsconfig.json'), 'utf8').includes('"packages/verticals/notes"'))
  assert.equal(manifestOf(old).demo, undefined, 'update must not invent a demo record for an older install')

  // --refresh-seeded still resolves a demo path for an install that carries the example.
  const one = demoOnly.find((p) => p.startsWith('packages/verticals/notes/src/'))
  writeFileSync(join(old, one), 'drifted\n')
  const rs = run(['update', '--dir', old, '--refresh-seeded', one])
  assert.equal(rs.code, 2, rs.out)
  assert.ok(existsSync(join(old, '.harness/pending', one)), 'refresh-seeded must park the demo version of a drifted demo file')
})

test('docs/cli.md and --help name eject and --with-demo', () => {
  const help = run(['--help'])
  assert.match(help.out, /eject/)
  assert.match(help.out, /--with-demo/)
  const doc = readFileSync(fileURLToPath(new URL('../../docs/cli.md', import.meta.url)), 'utf8')
  assert.match(doc, /\beject\b/)
  assert.match(doc, /--with-demo/)
})
