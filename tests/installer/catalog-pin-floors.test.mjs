// catalogPinFloors (1.1.0, #83) — the channel that tells an EXISTING install its seeded
// catalog pins a package below a security floor a release recorded, without `update`
// writing a seeded manifest.
//
// 1.0.3 raised the template's vitest and @vitest/coverage-v8 pins to 4.1.11 for
// GHSA-82fw-gwwq-j7x9, and nothing carried the raise to a tree that already existed:
// pnpm-workspace.yaml is SEEDED, and the one record kind that reaches the catalog
// (dependencyObligations) asks whether a key is PRESENT, never at what version. The
// behaviour under test mirrors that channel on purpose: the floor is EMITTED, never applied,
// the parked file self-clears once the tree meets every floor, and both seeded manifests are
// byte-identical afterwards. What differs is the severity: an unmet floor is a doctor
// WARNING (exit 2), never an ERROR, because an old pin stops no installed gate from running.
//
// A namespace import, so that each case below fails on its own while the exports are
// missing, rather than the whole file failing to load.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as lib from '../../installer/lib/migrations.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PARKED = '.harness/pending/pin-floors.json'
const WHY =
  '4.1.10 is affected by GHSA-82fw-gwwq-j7x9 (moderate): path traversal through the @vitest/mocker redirect mock allows an arbitrary file read.'

const MIGRATIONS = {
  '//': 'doc key, must be ignored',
  '1.0.4': { seedOnInitOnly: ['tools/example.json'] },
  '1.1.0': {
    catalogPinFloors: [
      { name: 'vitest', minVersion: '4.1.11', advisory: 'GHSA-82fw-gwwq-j7x9', why: WHY },
      {
        name: '@vitest/coverage-v8',
        minVersion: '4.1.11',
        advisory: 'GHSA-82fw-gwwq-j7x9',
        why: 'The coverage package peer-pins the identical vitest, so it moves to 4.1.11 with it.',
      },
    ],
  },
  '1.2.0': {
    catalogPinFloors: [
      { name: 'zod', minVersion: '9.0.0', advisory: 'GHSA-future', why: 'a floor from a FUTURE release, not yet demanded of a 1.1.0 install.' },
    ],
  },
}

/** A catalog with the two floored keys at the given values (`null` leaves the key out). */
function catalog(vitest, coverage = vitest, extra = '') {
  return [
    'packages:',
    '  - apps/*',
    'catalog:',
    '  zod: ^4.4.3',
    ...(vitest === null ? [] : [`  vitest: ${vitest}`]),
    ...(coverage === null ? [] : [`  '@vitest/coverage-v8': ${coverage}`]),
    extra,
  ].join('\n')
}

/** @param {string} yaml @param {string} [version] */
const unmetNames = (yaml, version = '1.1.0') =>
  lib.unmetCatalogPinFloors(MIGRATIONS, version, { workspaceYaml: yaml }).map((f) => f.name)

// A fresh, private directory per call: mkdtemp never reuses a path, so a leftover from an
// earlier run can never stand in for a fixture. Each one is removed once the file is done.
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-pinfloor-'))
  made.push(dir)
  return dir
}

// ── the pure probe ──────────────────────────────────────────────────────────────────────

test('below the floor is unmet, and each unmet floor carries since, found and the record fields', () => {
  const unmet = lib.unmetCatalogPinFloors(MIGRATIONS, '1.1.0', { workspaceYaml: catalog('4.1.10') })
  assert.deepEqual(unmet.map((f) => f.name), ['vitest', '@vitest/coverage-v8'])
  assert.deepEqual(unmet[0], {
    name: 'vitest',
    minVersion: '4.1.11',
    advisory: 'GHSA-82fw-gwwq-j7x9',
    why: WHY,
    since: '1.1.0',
    found: '4.1.10',
  })
})

test('at the floor and above it are met', () => {
  assert.deepEqual(unmetNames(catalog('4.1.11')), [])
  assert.deepEqual(unmetNames(catalog('4.1.12')), [])
  assert.deepEqual(unmetNames(catalog('4.2.0')), [])
  assert.deepEqual(unmetNames(catalog('5.0.0')), [])
  // Numeric, not lexical: 4.1.9 sorts after 4.1.11 as a string and is still below it.
  assert.deepEqual(unmetNames(catalog('4.1.9')), ['vitest', '@vitest/coverage-v8'])
})

test('a range is judged by its lower bound: one leading ^, ~, >= or = is stripped', () => {
  // ^4.1.10 may well resolve to 4.1.11 or later, but the catalog does not prove it, and the
  // error must only ever be in the safe direction: met reported unmet, never the reverse.
  assert.deepEqual(unmetNames(catalog('^4.1.10')), ['vitest', '@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(catalog('~4.1.10')), ['vitest', '@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(catalog('>=4.1.10')), ['vitest', '@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(catalog('^4.1.11')), [])
  assert.deepEqual(unmetNames(catalog('~4.1.12')), [])
  assert.deepEqual(unmetNames(catalog('>=4.1.11')), [])
  assert.deepEqual(unmetNames(catalog('=4.1.11')), [])
})

test("the quoted key '@vitest/coverage-v8' is found, with or without a quoted value", () => {
  assert.deepEqual(unmetNames(catalog('4.1.11', '4.1.10')), ['@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(catalog('4.1.11', "'4.1.11'")), [])
  assert.deepEqual(unmetNames(catalog('"4.1.11"', '"4.1.10"')), ['@vitest/coverage-v8'])
})

test('a double-quoted key is found too: a present key read as absent would never be judged', () => {
  // A YAML formatter rewrites the template's '@vitest/coverage-v8': as "@vitest/coverage-v8":.
  // Absent is "not judged", so reading that line as no entry would hide a pin below its floor.
  const doubled = catalog('4.1.11', '4.1.10').replace("'@vitest/coverage-v8'", '"@vitest/coverage-v8"')
  assert.match(doubled, /^ {2}"@vitest\/coverage-v8": 4\.1\.10$/m, 'fixture precondition')
  assert.deepEqual(unmetNames(doubled), ['@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(catalog('4.1.10').replace('  vitest:', '  "vitest":')), ['vitest', '@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(doubled.replace('4.1.10', '4.1.11')), [])
})

test('a comment decoy is neither an entry nor a value', () => {
  // A commented-out line naming a met version is not the catalog entry.
  const commented = catalog('4.1.10', '4.1.10', '  # vitest: 4.1.11\n# vitest: 4.1.11')
  assert.deepEqual(unmetNames(commented), ['vitest', '@vitest/coverage-v8'])
  // A trailing comment is dropped before the value is read, both ways round.
  assert.deepEqual(unmetNames(catalog('4.1.10 # raise to 4.1.11')), ['vitest', '@vitest/coverage-v8'])
  assert.deepEqual(unmetNames(catalog('4.1.11 # 4.1.10 is affected')), [])
  // A key that appears ONLY in a comment is absent, so it is not judged.
  assert.deepEqual(unmetNames(catalog(null, null, '# vitest: 4.1.10')), [])
})

test('a key absent from the catalog is not judged', () => {
  assert.deepEqual(unmetNames(catalog(null, null)), [])
  assert.deepEqual(unmetNames(catalog('4.1.10', null)), ['vitest'])
  assert.deepEqual(unmetNames(''), [])
})

test('a value that is not a plain version is unmet, because it cannot be proven met', () => {
  for (const value of [
    'latest',
    'npm:vitest@4.1.11',
    'https://example.invalid/vitest-4.1.11.tgz',
    'workspace:*',
    '4.1.11-beta.1',
    '>= 4.1.11',
    '^^4.1.11',
    '4.1',
    "''",
  ]) {
    assert.deepEqual(unmetNames(catalog(value, '4.1.11')), ['vitest'], `\`vitest: ${value}\` must be unmet`)
  }
})

test('a floor from a FUTURE record is not demanded yet', () => {
  const yaml = catalog('4.1.11', '4.1.11', '  zod: ^4.4.3')
  assert.deepEqual(unmetNames(yaml, '1.1.0'), [])
  assert.deepEqual(unmetNames(yaml, '1.2.0'), ['zod'])
  // And a record below the floor's own release demands nothing of an older installer.
  assert.deepEqual(unmetNames(catalog('4.1.10'), '1.0.4'), [])
})

// ── update's half: park, report, self-clear, never write a seeded manifest ─────────────

test('applying parks a machine-readable file, names every floor, and NEVER writes a seeded manifest', () => {
  const dir = scratch()
  const yaml = catalog('4.1.10')
  const pkg = JSON.stringify({ devDependencies: { vitest: 'catalog:' } })
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml)
  writeFileSync(join(dir, 'package.json'), pkg)
  const report = { notes: [] }

  const unmet = lib.applyCatalogPinFloors({ targetDir: dir, report, migrations: MIGRATIONS, version: '1.1.0', dryRun: false })

  assert.equal(unmet.length, 2)
  assert.equal(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), yaml)
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), pkg)

  assert.equal(lib.PIN_FLOORS_PATH, PARKED)
  const parked = JSON.parse(readFileSync(join(dir, PARKED), 'utf8'))
  assert.deepEqual(Object.keys(parked), ['//', 'harnessVersion', 'floors'])
  assert.equal(parked.harnessVersion, '1.1.0')
  assert.deepEqual(Object.keys(parked.floors[0]), ['since', 'name', 'found', 'minVersion', 'advisory', 'why'])
  assert.deepEqual(parked.floors.map((f) => [f.name, f.found, f.minVersion]), [
    ['vitest', '4.1.10', '4.1.11'],
    ['@vitest/coverage-v8', '4.1.10', '4.1.11'],
  ])
  assert.match(parked['//'], /does NOT edit pnpm-workspace\.yaml/)

  assert.equal(report.notes.length, 2)
  assert.ok(
    report.notes[0].startsWith(
      'CATALOG PIN FLOOR (1.1.0): raise `vitest` from 4.1.10 to at least 4.1.11 in the pnpm-workspace.yaml catalog, then `pnpm install` and commit pnpm-lock.yaml. WHY: ',
    ),
    report.notes[0],
  )
  assert.match(report.notes[0], /GHSA-82fw-gwwq-j7x9/)
  assert.match(report.notes[0], /\(parked at \.harness\/pending\/pin-floors\.json\)$/)
  assert.match(report.notes[1], /raise `@vitest\/coverage-v8` from 4\.1\.10 to at least 4\.1\.11/)
})

test('a value that is not a plain version is named as unprovable, not as a version below the floor', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), catalog('latest', '4.1.11'))
  const report = { notes: [] }
  lib.applyCatalogPinFloors({ targetDir: dir, report, migrations: MIGRATIONS, version: '1.1.0', dryRun: false })
  assert.equal(report.notes.length, 1)
  assert.match(report.notes[0], /CATALOG PIN FLOOR \(1\.1\.0\): `vitest: latest` cannot be proven at or above 4\.1\.11/)
})

test('a dry run writes nothing at all', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), catalog('4.1.10'))
  const report = { notes: [] }
  const unmet = lib.applyCatalogPinFloors({ targetDir: dir, report, migrations: MIGRATIONS, version: '1.1.0', dryRun: true })
  assert.equal(unmet.length, 2)
  assert.equal(report.notes.length, 2, 'a dry run still reports what it would park')
  assert.deepEqual(readdirSync(dir), ['pnpm-workspace.yaml'], 'not even an empty .harness/ directory')
})

test('the parked file SELF-CLEARS once every floor is met, and a dry run does not clear it', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), catalog('4.1.10'))
  const args = { targetDir: dir, migrations: MIGRATIONS, version: '1.1.0' }
  lib.applyCatalogPinFloors({ ...args, report: { notes: [] }, dryRun: false })
  assert.equal(existsSync(join(dir, PARKED)), true)

  writeFileSync(join(dir, 'pnpm-workspace.yaml'), catalog('4.1.11'))
  lib.applyCatalogPinFloors({ ...args, report: { notes: [] }, dryRun: true })
  assert.equal(existsSync(join(dir, PARKED)), true, 'a dry run deletes nothing either')

  const report = { notes: [] }
  assert.deepEqual(lib.applyCatalogPinFloors({ ...args, report, dryRun: false }), [])
  assert.equal(existsSync(join(dir, PARKED)), false)
  assert.deepEqual(report.notes, [])
})

test('a tree with no pnpm-workspace.yaml judges nothing and parks nothing', () => {
  const dir = scratch()
  const report = { notes: [] }
  assert.deepEqual(lib.applyCatalogPinFloors({ targetDir: dir, report, migrations: MIGRATIONS, version: '1.1.0', dryRun: false }), [])
  assert.deepEqual(readdirSync(dir), [])
})

// ── the shipped record ──────────────────────────────────────────────────────────────────

test('the SHIPPED 1.1.0 record floors vitest and @vitest/coverage-v8 at 4.1.11, and the template meets it', () => {
  const migrations = JSON.parse(readFileSync(join(ROOT, 'template/migrations.json'), 'utf8'))
  const floors = migrations['1.1.0']?.catalogPinFloors ?? []
  assert.deepEqual(
    floors.map((f) => [f.name, f.minVersion, f.advisory]),
    [
      ['vitest', '4.1.11', 'GHSA-82fw-gwwq-j7x9'],
      ['@vitest/coverage-v8', '4.1.11', 'GHSA-82fw-gwwq-j7x9'],
    ],
  )
  for (const f of floors) assert.ok(f.why.length >= 40, `${f.name}: why is ${f.why.length} chars`)
  // A fresh scaffold must never warn: the template's own catalog meets every floor it records.
  const workspaceYaml = readFileSync(join(ROOT, 'template/base/pnpm-workspace.yaml'), 'utf8')
  assert.deepEqual(lib.unmetCatalogPinFloors(migrations, '99.0.0', { workspaceYaml }), [])
  // …and the pins every release through 1.0.2 shipped are below it.
  assert.deepEqual(
    lib.unmetCatalogPinFloors(migrations, '99.0.0', {
      workspaceYaml: workspaceYaml.replaceAll(/^( {2}'?(?:vitest|@vitest\/coverage-v8)'?: )4\.1\.11/gm, '$14.1.10'),
    }).map((f) => f.name),
    ['vitest', '@vitest/coverage-v8'],
  )
})

test('the anchored catalog-entry pattern has exactly one home', () => {
  // unmetDependencyObligations, unmetCatalogPinFloors and doctor's toolchain report read a
  // catalog entry through catalogEntry(); a second copy of the anchor is how two of them
  // come to disagree about what counts as an entry.
  const src = readFileSync(join(ROOT, 'installer/lib/migrations.mjs'), 'utf8')
  const anchor = String.raw`^\\s{2,}(['"]?)${'$'}{key}\\1\\s*:`
  assert.equal(src.split(anchor).length - 1, 1, `expected the anchor ${anchor} exactly once in migrations.mjs`)
  for (const rel of ['installer/commands/doctor.mjs', 'installer/commands/update.mjs', 'installer/lib/toolchain.mjs', 'scripts/check-dependency-channel.mjs']) {
    assert.ok(!readFileSync(join(ROOT, rel), 'utf8').includes(anchor), `${rel} carries a copy of the anchor`)
  }
})

// ── the wired channel: doctor warns at exit 2, update parks, raising clears both ────────
//
// One end-to-end pass over a REAL scaffold, because three surfaces must agree: the shipped
// record, `update`'s unconditional call and `doctor`'s WARNING-level recomputation. The CLI
// demands floors only from records at or below its own package.json version, so this case
// can pass only once the tree says 1.1.0. Same CLI harness as source-fix-obligations.test.mjs.
const CLI = join(ROOT, 'installer/cli.mjs')
/** @param {string[]} args */
function run(args) {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('on a real scaffold: a pin below the floor → doctor warns (exit 2), update parks; raised → both clear', () => {
  const dir = scratch()
  const init = run(['init', '--dir', dir, '--yes',
    '--set', 'PROJECT_NAME=Fixture App',
    '--set', 'GITHUB_OWNER=fixture-owner',
    '--set', 'SECURITY_OWNERS=@fixture-owner/security'])
  assert.equal(init.code, 0, init.out)

  // 1. A fresh scaffold ships at the floor: doctor is clean and nothing is parked.
  const clean = run(['doctor', '--dir', dir])
  assert.equal(clean.code, 0, clean.out)
  assert.equal(existsSync(join(dir, PARKED)), false)

  // 2. Lower both pins to what every release through 1.0.2 shipped. The catalog is seeded,
  //    so neither doctor's drift loop nor update will touch it; doctor recomputes from the
  //    TREE, with nothing parked yet, and the finding is a WARNING, never an error.
  const yamlPath = join(dir, 'pnpm-workspace.yaml')
  const shipped = readFileSync(yamlPath, 'utf8')
  const lowered = shipped.replaceAll(/^( {2}'?(?:vitest|@vitest\/coverage-v8)'?: )4\.1\.11/gm, '$14.1.10')
  assert.notEqual(lowered, shipped, 'fixture precondition: the scaffold pins both packages at 4.1.11')
  writeFileSync(yamlPath, lowered)
  const warned = run(['doctor', '--dir', dir])
  assert.equal(warned.code, 2, warned.out)
  assert.ok(!warned.out.includes('ERROR'), warned.out)
  assert.match(warned.out, /warn {2}catalog pin below a security floor \(since 1\.1\.0\): `vitest` is 4\.1\.10 in the pnpm-workspace\.yaml catalog, below 4\.1\.11 \(GHSA-82fw-gwwq-j7x9\)/)
  assert.match(warned.out, /`@vitest\/coverage-v8` is 4\.1\.10/)

  // 3. update names each floor, parks the machine-readable instruction, exits 0, and leaves
  //    both seeded manifests byte-identical.
  const pkgBefore = readFileSync(join(dir, 'package.json'), 'utf8')
  const updated = run(['update', '--dir', dir])
  assert.equal(updated.code, 0, updated.out)
  assert.match(updated.out, /CATALOG PIN FLOOR \(1\.1\.0\): raise `vitest` from 4\.1\.10 to at least 4\.1\.11/)
  assert.match(updated.out, /CATALOG PIN FLOOR \(1\.1\.0\): raise `@vitest\/coverage-v8` from 4\.1\.10 to at least 4\.1\.11/)
  assert.equal(existsSync(join(dir, PARKED)), true)
  assert.equal(readFileSync(yamlPath, 'utf8'), lowered)
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), pkgBefore)

  // While parked, doctor keeps warning — but never as a parked UPGRADE awaiting a merge:
  // pin-floors.json is an obligation, like dependencies.json and source-fixes.json.
  const parked = run(['doctor', '--dir', dir])
  assert.equal(parked.code, 2, parked.out)
  assert.ok(!parked.out.includes('parked upgrade awaiting merge: .harness/pending/pin-floors.json'), parked.out)

  // 4. Raise the pins by hand: doctor self-clears the parked file without another update.
  writeFileSync(yamlPath, shipped)
  const healed = run(['doctor', '--dir', dir])
  assert.equal(healed.code, 0, healed.out)
  assert.match(healed.out, /info {2}every catalog pin meets its security floor — removing the stale \.harness\/pending\/pin-floors\.json/)
  assert.equal(existsSync(join(dir, PARKED)), false)
})
