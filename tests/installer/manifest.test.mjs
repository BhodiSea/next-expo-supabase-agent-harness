// Unit tests for the manifest record-keeping (installer/lib/manifest.mjs):
// fileMode classification precedence, corrupt-vs-absent readManifest behavior,
// and writeManifest's stable/sorted output round-tripping through readManifest.
// Regression armor: these pin CURRENT behavior after the v0.1.3 refactor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fileMode,
  installerVersion,
  manifestPath,
  readManifest,
  sha256,
  writeManifest,
} from '../../installer/lib/manifest.mjs'
import { CONFIG_FILES, SEEDED_FILES, SEEDED_PREFIXES } from '../../installer/lib/layout.mjs'

const PKG = fileURLToPath(new URL('../../package.json', import.meta.url))

function sampleManifest() {
  return {
    harnessVersion: '0.1.3',
    installedAt: '2026-07-11T00:00:00.000Z',
    mode: 'greenfield',
    tier: 'standard',
    modules: ['ci-windows-release', 'ci-provenance'],
    answers: { PROJECT_NAME: 'Round Trip', GITHUB_OWNER: 'o' },
    files: {
      'tools/validate.mjs': { mode: 'owned', sha256: sha256('v\n') },
      'package.json': { mode: 'seeded', sha256: sha256('p\n') },
      'tools/harness.config.mjs': { mode: 'config', sha256: sha256('c\n') },
      'apps/desktop/src/main.ts': { mode: 'seeded', sha256: sha256('m\n') },
    },
  }
}

test('sha256 is deterministic hex over text', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256('hello\n'), sha256('hello\n'))
  assert.notEqual(sha256('hello\n'), sha256('hello'))
})

test('fileMode: explicit config files classify as config', () => {
  for (const path of CONFIG_FILES) {
    assert.equal(fileMode(path), 'config', path)
  }
  assert.equal(fileMode('tools/harness.config.mjs'), 'config')
})

test('fileMode: exact seeded-file matches classify as seeded', () => {
  assert.equal(fileMode('package.json'), 'seeded')
  assert.equal(fileMode('CLAUDE.md'), 'seeded')
  assert.equal(fileMode('tools/perf-budget.json'), 'seeded')
  assert.equal(fileMode('tests/rls/db-context.ts'), 'seeded')
})

test('fileMode: seeded-prefix matches classify as seeded', () => {
  assert.equal(fileMode('apps/desktop/src/main.ts'), 'seeded')
  assert.equal(fileMode('packages/schema/src/index.ts'), 'seeded')
  assert.equal(fileMode('drizzle/0001_init.sql'), 'seeded')
  assert.equal(fileMode('tests/unit/example.test.ts'), 'seeded')
})

test('fileMode: everything else defaults to owned', () => {
  assert.equal(fileMode('tools/validate.mjs'), 'owned')
  assert.equal(fileMode('README.md'), 'owned')
  assert.equal(fileMode('.github/workflows/ci.yml'), 'owned')
  // sibling of a seeded exact file, not itself seeded
  assert.equal(fileMode('tests/rls/other.ts'), 'owned')
})

test('fileMode: prefix matching is literal startsWith, not path-segment aware', () => {
  // bare directory name without the trailing slash does not match 'apps/'
  assert.equal(fileMode('apps'), 'owned')
  assert.equal(fileMode('apps.md'), 'owned')
  // 'tests/unit2/' is not under the 'tests/unit/' prefix
  assert.equal(fileMode('tests/unit2/example.test.ts'), 'owned')
})

test('fileMode: expects POSIX install paths — backslash separators fall through to owned', () => {
  // Install paths are built with forward slashes by the template walker, so this
  // pins the POSIX-only contract: a backslash path never matches a seeded prefix.
  assert.equal(fileMode('apps\\desktop\\src\\main.ts'), 'owned')
})

test('fileMode: config wins over seeded-file and seeded-prefix matches', () => {
  const configPath = [...CONFIG_FILES][0]
  SEEDED_FILES.add(configPath)
  SEEDED_PREFIXES.push('tools/')
  try {
    assert.equal(fileMode(configPath), 'config', 'config beats a simultaneous seeded-file match')
    assert.equal(fileMode('tools/anything.mjs'), 'seeded', 'sanity: injected prefix is live')
  } finally {
    SEEDED_FILES.delete(configPath)
    SEEDED_PREFIXES.pop()
  }
  // state restored: back to the natural classification
  assert.equal(fileMode(configPath), 'config')
  assert.equal(fileMode('tools/anything.mjs'), 'owned')
})

test('manifestPath points at .harness/manifest.json under the target dir', () => {
  assert.equal(manifestPath('/x/y'), join('/x/y', '.harness', 'manifest.json'))
})

test('readManifest: genuinely absent manifest returns null (init advice is correct)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  assert.equal(readManifest(dir), null)
  // .harness exists but manifest.json does not — still absent
  mkdirSync(join(dir, '.harness'), { recursive: true })
  assert.equal(readManifest(dir), null)
})

test('readManifest: unreadable path (directory at manifest.json) also reads as absent', () => {
  // Pins that ANY read failure — not just ENOENT — is treated as "no manifest".
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  mkdirSync(join(dir, '.harness', 'manifest.json'), { recursive: true })
  assert.equal(readManifest(dir), null)
})

test('readManifest: corrupt JSON throws the restore-from-git error, never null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  mkdirSync(join(dir, '.harness'), { recursive: true })
  for (const corrupt of ['{ not json', '', '{"files": }']) {
    writeFileSync(join(dir, '.harness', 'manifest.json'), corrupt)
    assert.throws(
      () => readManifest(dir),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /not valid JSON/)
        assert.match(err.message, /do NOT re-run `init`/)
        return true
      },
      `corrupt payload ${JSON.stringify(corrupt)} must throw, not return null`,
    )
  }
})

test('readManifest: valid JSON parses through untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, '.harness', 'manifest.json'), '{"harnessVersion":"9.9.9","extra":true}\n')
  assert.deepEqual(readManifest(dir), { harnessVersion: '9.9.9', extra: true })
})

test('writeManifest: creates .harness, pins key order, sorts modules and files, trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  writeManifest(dir, sampleManifest())

  const raw = readFileSync(join(dir, '.harness', 'manifest.json'), 'utf8')
  assert.ok(raw.endsWith('}\n'), 'output ends with exactly one trailing newline')
  assert.ok(!raw.endsWith('\n\n'))

  const parsed = JSON.parse(raw)
  assert.deepEqual(
    Object.keys(parsed),
    ['harnessVersion', 'installedAt', 'mode', 'tier', 'modules', 'answers', 'files'],
    'top-level key order is fixed',
  )
  assert.deepEqual(parsed.modules, ['ci-provenance', 'ci-windows-release'], 'modules sorted')
  assert.deepEqual(
    Object.keys(parsed.files),
    ['apps/desktop/src/main.ts', 'package.json', 'tools/harness.config.mjs', 'tools/validate.mjs'],
    'file entries sorted by install path',
  )
})

test('writeManifest: output is stable across insertion order (byte-identical)', () => {
  const a = sampleManifest()
  const b = /** @type {any} */ (sampleManifest())
  b.modules = ['ci-provenance', 'ci-windows-release'] // reversed relative to a
  b.files = Object.fromEntries(Object.entries(a.files).reverse())

  const dirA = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  const dirB = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  writeManifest(dirA, a)
  writeManifest(dirB, b)
  assert.equal(
    readFileSync(manifestPath(dirA), 'utf8'),
    readFileSync(manifestPath(dirB), 'utf8'),
    'same records in a different order must serialize identically',
  )
})

test('writeManifest: round-trips through readManifest and accepts a Set of modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  const manifest = sampleManifest()
  writeManifest(dir, manifest)
  assert.deepEqual(readManifest(dir), {
    ...manifest,
    modules: ['ci-provenance', 'ci-windows-release'],
    files: {
      'apps/desktop/src/main.ts': manifest.files['apps/desktop/src/main.ts'],
      'package.json': manifest.files['package.json'],
      'tools/harness.config.mjs': manifest.files['tools/harness.config.mjs'],
      'tools/validate.mjs': manifest.files['tools/validate.mjs'],
    },
  })

  // enable/update pass module collections that may be Sets — the spread supports both
  const dirSet = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  writeManifest(dirSet, { ...manifest, modules: new Set(['b-mod', 'a-mod']) })
  assert.deepEqual(readManifest(dirSet).modules, ['a-mod', 'b-mod'])
})

test('writeManifest: does not mutate the caller manifest and drops unknown top-level keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  const manifest = sampleManifest()
  manifest.modules = ['z-mod', 'a-mod']
  manifest.junkKey = 'should not persist'
  writeManifest(dir, manifest)

  assert.deepEqual(manifest.modules, ['z-mod', 'a-mod'], 'caller module order untouched (sort on a copy)')
  const parsed = readManifest(dir)
  assert.deepEqual(parsed.modules, ['a-mod', 'z-mod'])
  assert.ok(!('junkKey' in parsed), 'only the known schema keys are written')
})

test('writeManifest: baseVersion persists right after harnessVersion when present, is omitted when absent', () => {
  // Absent (pre-0.1.5 manifests round-tripping through enable/update spreads):
  // the key must NOT appear — rampNote's harnessVersion fallback depends on
  // being able to tell "never stamped" apart from a stamped value.
  const dirOld = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  writeManifest(dirOld, sampleManifest())
  assert.ok(!('baseVersion' in readManifest(dirOld)), 'absent baseVersion must not be serialized')

  // Present: pinned position (second key) and value round-trips.
  const dirNew = mkdtempSync(join(tmpdir(), 'tpah-man-'))
  writeManifest(dirNew, { ...sampleManifest(), baseVersion: '0.1.4' })
  const raw = JSON.parse(readFileSync(manifestPath(dirNew), 'utf8'))
  assert.equal(raw.baseVersion, '0.1.4')
  assert.deepEqual(
    Object.keys(raw),
    ['harnessVersion', 'baseVersion', 'installedAt', 'mode', 'tier', 'modules', 'answers', 'files'],
    'baseVersion sits right after harnessVersion in the pinned key order',
  )
})

test('installerVersion reports the package.json version', () => {
  assert.equal(installerVersion(), JSON.parse(readFileSync(PKG, 'utf8')).version)
})
