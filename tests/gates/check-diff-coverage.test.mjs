// Can-fail + can-pass proofs for the diff-coverage gate
// (template/base/tools/check-diff-coverage.mjs). Two layers, mirroring the SRC suite:
// the PURE core (evaluateDiffCoverage: changed files × TWO istanbul maps × per-runner
// floors → findings/checked/missing) is unit-tested in-process — including the mobile/
// vitest runner split, the both-runner MERGE (per-metric max + true per-line union),
// coverage-map path normalization for POSIX and Windows absolute keys, and the
// missing-map fail-closed signal — while the CLI wrapper (git plumbing, fail-closed
// config parses, the two map artifacts) is spawned against a real throwaway git repo.
// New vs SRC (single-map, vitest-only): everything involving the jest half — the
// jest-classified floors, collectCoverageFrom surface parse/expansion, the missing
// apps/mobile map red, the missing jest.config.js red, and the merge legs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  evaluateDiffCoverage,
  expandBraces,
  parseCollectCoverageFrom,
  parseCoverageExcludes,
  parsePerFileFloors,
} from '../../template/base/tools/check-diff-coverage.mjs'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const GATE = join(TOOLS, 'check-diff-coverage.mjs')
const SHIPPED_VITEST_CONFIG = fileURLToPath(
  new URL('../../template/base/vitest.config.ts', import.meta.url),
)
const SHIPPED_JEST_CONFIG = fileURLToPath(
  new URL('../../template/stack/apps/mobile/jest.config.js', import.meta.url),
)

const FLOORS = { statements: 50, branches: 40, functions: 45, lines: 50 }
// Distinct jest floors so a finding proves WHICH runner's floor was applied.
const JEST_FLOORS = { statements: 80, branches: 40, functions: 45, lines: 50 }
const BOTH = { vitest: FLOORS, jest: FLOORS }
const JEST_SURFACE = ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', '!**/*.test.{ts,tsx}']

// A minimal istanbul-format file entry: statement i sits on line i+1 and is hit iff
// hits[i]; one function and one branch pair, hit iff any statement is.
function maskCov(path, hits) {
  const statementMap = {}
  const s = {}
  hits.forEach((hit, i) => {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } }
    s[i] = hit ? 1 : 0
  })
  const any = hits.some(Boolean) ? 1 : 0
  return {
    path,
    statementMap,
    s,
    fnMap: { 0: { name: 'f', line: 1 } },
    f: { 0: any },
    branchMap: { 0: { line: 1 } },
    b: { 0: [any, any] },
  }
}
const fileCov = (path, { covered, total }) =>
  maskCov(path, Array.from({ length: total }, (_, i) => i < covered))

// ---- pure core: classification, floors, merge, missing maps ----------------------

test('an uncovered new src file (absent from BOTH maps) is a finding naming its runner', () => {
  const { findings, checked, missing } = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts'],
    maps: { vitest: {}, jest: null },
    floors: BOTH,
  })
  assert.deepEqual(checked, ['apps/server/src/dal/widgets.ts'])
  assert.deepEqual(findings, [
    { file: 'apps/server/src/dal/widgets.ts', kind: 'uncovered', runner: 'vitest' },
  ])
  assert.deepEqual([...missing], [])
})

test('a changed file below a per-file floor is a finding naming metric, actual, floor', () => {
  const { findings } = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts'],
    maps: {
      vitest: {
        'apps/server/src/dal/widgets.ts': fileCov('apps/server/src/dal/widgets.ts', {
          covered: 1,
          total: 4, // 25% statements + lines — below 50/50; functions+branches hit
        }),
      },
      jest: null,
    },
    floors: BOTH,
  })
  assert.deepEqual(findings, [
    {
      file: 'apps/server/src/dal/widgets.ts',
      kind: 'below-floor',
      runner: 'vitest',
      metric: 'statements',
      actual: 25,
      floor: 50,
    },
    {
      file: 'apps/server/src/dal/widgets.ts',
      kind: 'below-floor',
      runner: 'vitest',
      metric: 'lines',
      actual: 25,
      floor: 50,
    },
  ])
})

test('a changed file exactly AT every floor is green (floors compare pct < threshold)', () => {
  const { findings, checked } = evaluateDiffCoverage({
    changedFiles: ['packages/schema/src/parse.ts'],
    maps: {
      vitest: {
        'packages/schema/src/parse.ts': fileCov('packages/schema/src/parse.ts', {
          covered: 2,
          total: 4, // exactly 50% statements + lines; functions/branches 100
        }),
      },
      jest: null,
    },
    floors: BOTH,
  })
  assert.equal(checked.length, 1)
  assert.deepEqual(findings, [])
})

test('a changed apps/mobile file is held to the JEST floors (collectCoverageFrom surface)', () => {
  const file = 'apps/mobile/src/components/Button.tsx'
  const { findings } = evaluateDiffCoverage({
    changedFiles: [file],
    maps: { vitest: {}, jest: { [file]: fileCov(file, { covered: 3, total: 5 }) } }, // 60%
    floors: { vitest: FLOORS, jest: JEST_FLOORS },
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.deepEqual(findings, [
    { file, kind: 'below-floor', runner: 'jest', metric: 'statements', actual: 60, floor: 80 },
  ])
})

test("collectCoverageFrom '!'-negations carve the jest surface — tokens.gen.ts is never checked", () => {
  const { findings, checked } = evaluateDiffCoverage({
    changedFiles: ['apps/mobile/src/theme/tokens.gen.ts', 'apps/mobile/jest.config.js'],
    maps: { vitest: {}, jest: {} },
    floors: BOTH,
    jestCoverageFrom: [...JEST_SURFACE, '!src/theme/tokens.gen.ts'],
  })
  assert.deepEqual(checked, [])
  assert.deepEqual(findings, [])
})

test('jestCoverageFrom null (config absent) falls back to the seeded src|app tree shape', () => {
  const { checked, findings } = evaluateDiffCoverage({
    changedFiles: ['apps/mobile/src/lib/kv.ts', 'apps/mobile/metro.config.js'],
    maps: { vitest: {}, jest: {} },
    floors: BOTH,
    jestCoverageFrom: null,
  })
  assert.deepEqual(checked, ['apps/mobile/src/lib/kv.ts'])
  assert.equal(findings[0].kind, 'uncovered')
  assert.equal(findings[0].runner, 'jest')
})

test('MERGE: a file both runners measure takes the per-metric MAX — being measured twice only helps', () => {
  const file = 'apps/mobile/src/lib/kv.ts'
  const { findings } = evaluateDiffCoverage({
    changedFiles: [file],
    maps: {
      vitest: { [file]: fileCov(file, { covered: 1, total: 4 }) }, // 25% alone: below floor
      jest: { [file]: fileCov(file, { covered: 4, total: 4 }) }, // 100%
    },
    floors: { vitest: FLOORS, jest: JEST_FLOORS },
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.deepEqual(findings, [])
})

test('MERGE: lines are a true per-line UNION across the two maps (statements stay per-map max)', () => {
  const file = 'apps/mobile/src/lib/sse.ts'
  const floors = { vitest: FLOORS, jest: { ...FLOORS, lines: 75 } }
  // vitest executed lines 1-2, jest lines 3-4: each map alone is 50% lines (below the
  // 75 floor), the union is 100% — the merge must see the union, not either half.
  const union = evaluateDiffCoverage({
    changedFiles: [file],
    maps: {
      vitest: { [file]: maskCov(file, [true, true, false, false]) },
      jest: { [file]: maskCov(file, [false, false, true, true]) },
    },
    floors,
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.deepEqual(union.findings, [])
  // Same halves, but jest re-measures the SAME two lines: the union is 50% and reds.
  const overlap = evaluateDiffCoverage({
    changedFiles: [file],
    maps: {
      vitest: { [file]: maskCov(file, [true, true, false, false]) },
      jest: { [file]: maskCov(file, [true, true, false, false]) },
    },
    floors,
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.deepEqual(
    overlap.findings.map((f) => f.metric),
    ['lines'],
  )
})

test('a required map that is MISSING surfaces in `missing`, never as a silent pass', () => {
  const { findings, checked, missing } = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts', 'apps/mobile/src/lib/kv.ts'],
    maps: { vitest: null, jest: null },
    floors: BOTH,
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.equal(checked.length, 2)
  assert.deepEqual(findings, [])
  assert.deepEqual([...missing].sort(), ['jest', 'vitest'])
})

test('empty diff → zero checked files, zero findings, zero missing maps', () => {
  const r = evaluateDiffCoverage({ changedFiles: [], maps: { vitest: {}, jest: {} }, floors: BOTH })
  assert.deepEqual(r.findings, [])
  assert.deepEqual(r.checked, [])
  assert.deepEqual([...r.missing], [])
})

test('non-source changed files are ignored: outside src trees, tests, .d.ts, non-code, excludes', () => {
  const { findings, checked } = evaluateDiffCoverage({
    changedFiles: [
      'README.md',
      'tools/check-migrations.mjs',
      'apps/mobile/maestro/smoke.yaml',
      'apps/mobile/src/App.test.tsx', // colocated test
      'apps/web/tests/unit/page.test.ts', // not under src/ or app/
      'packages/contracts/src/types.d.ts', // .d.ts
      'apps/mobile/assets/icon.png', // not a code file
      'packages/platform/supabase/src/browser.ts', // COVERAGE_EXCLUDE exact path
      'packages/platform/supabase/src/service-role.ts', // COVERAGE_EXCLUDE exact path
    ],
    maps: { vitest: {}, jest: {} },
    floors: BOTH,
    vitestExcludes: parseCoverageExcludes(readShippedVitest()),
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.deepEqual(checked, [])
  assert.deepEqual(findings, [])
})

test('coverage-map keys are normalized: absolute POSIX and Windows-separator paths both match', () => {
  const posix = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts'],
    maps: {
      vitest: { '/home/dev/proj/apps/server/src/dal/widgets.ts': fileCov('x', { covered: 4, total: 4 }) },
      jest: null,
    },
    floors: BOTH,
    root: '/home/dev/proj',
  })
  assert.deepEqual(posix.findings, [])
  assert.equal(posix.checked.length, 1)

  const win = evaluateDiffCoverage({
    changedFiles: ['apps\\server\\src\\dal\\widgets.ts'],
    maps: {
      vitest: { 'D:\\a\\proj\\apps\\server\\src\\dal\\widgets.ts': fileCov('x', { covered: 4, total: 4 }) },
      jest: null,
    },
    floors: BOTH,
    root: 'd:\\a\\proj', // drive-letter case may differ between the map and cwd
  })
  assert.deepEqual(win.findings, [])
  assert.equal(win.checked.length, 1)
})

test('ODDITY (pinned): a TOP-LEVEL mobile source file escapes the jest surface entirely', () => {
  // globToRe translates `src/**/*.ts` to `^…src/.*/[^/]*\.ts$`, which requires at least
  // one directory between src/ and the file — but jest's real glob matches zero depth,
  // and apps/mobile/src/routes.ts IS a shipped top-level module (measured by vitest's
  // explicit include list, no less). The classifier returns null for it, so a changed
  // routes.ts is never held to any floor. Conservative direction (under-checking, not a
  // false red), but a real divergence from the runner's own surface — pinned here so a
  // fix shows up as this test flipping.
  const { checked } = evaluateDiffCoverage({
    changedFiles: ['apps/mobile/src/routes.ts', 'apps/mobile/app/_layout.tsx'],
    maps: { vitest: {}, jest: {} },
    floors: BOTH,
    jestCoverageFrom: JEST_SURFACE,
  })
  assert.deepEqual(checked, [])
})

// ---- fail-closed parses against the SHIPPED configs ------------------------------

function readShippedVitest() {
  return readFileSync(SHIPPED_VITEST_CONFIG, 'utf8')
}
function readShippedJest() {
  return readFileSync(SHIPPED_JEST_CONFIG, 'utf8')
}

test('the SHIPPED vitest.config.ts parses: floors 50/40/45/50 and the exclusion list', () => {
  assert.deepEqual(parsePerFileFloors(readShippedVitest()), FLOORS)
  const excludes = parseCoverageExcludes(readShippedVitest())
  assert.ok(excludes.includes('**/*.d.ts'))
  // The live-database surface: the client factories open real connections, so a
  // unit test can only assert they were constructed — the RLS isolation suite in
  // the same Stop chain proves them against a real database instead.
  assert.ok(excludes.includes('packages/platform/supabase/src/browser.ts'))
  assert.ok(excludes.includes('packages/platform/supabase/src/service-role.ts'))
  assert.ok(excludes.includes('packages/platform/supabase/src/database.types.ts'))
  // Generated artifacts are transcriptions of a source of truth, not decisions;
  // the regen-diff gate proves them and coverage would only dilute the bar.
  assert.ok(excludes.includes('packages/design-tokens/src/generated/**'))
})

test('the SHIPPED apps/mobile/jest.config.js parses: LOCKSTEP floors + collectCoverageFrom', () => {
  assert.deepEqual(parsePerFileFloors(readShippedJest()), FLOORS) // one floor, two runners
  const surface = parseCollectCoverageFrom(readShippedJest())
  assert.ok(surface.includes('src/**/*.{ts,tsx}'), surface.join(', '))
  assert.ok(surface.includes('app/**/*.{ts,tsx}'), surface.join(', '))
  assert.ok(surface.includes('!**/*.test.{ts,tsx}'), surface.join(', '))
  // No `!src/theme/tokens.gen.ts` assertion: the generated token module moved to
  // @app/design-tokens (design/W1-STACK-SPEC.md §5), so it is outside this app's
  // coverage surface entirely — the exclusion is correctly GONE, not stale. Asserting a
  // path-exclusion that no longer has a file to exclude would pin dead config.
})

test('a config without the expected block (or with a metric missing) parses to null — fail closed', () => {
  assert.equal(parsePerFileFloors('export default {}'), null)
  assert.equal(
    parsePerFileFloors('const PER_FILE_FLOORS = { statements: 50, branches: 40, functions: 45 }'),
    null, // lines missing
  )
  assert.equal(parseCoverageExcludes('export default {}'), null)
  assert.equal(parseCollectCoverageFrom('module.exports = {}'), null)
})

test("expandBraces: jest's {ts,tsx} braces expand; brace-free globs pass through", () => {
  assert.deepEqual(expandBraces('src/**/*.{ts,tsx}'), ['src/**/*.ts', 'src/**/*.tsx'])
  assert.deepEqual(expandBraces('app/**/*.ts'), ['app/**/*.ts'])
})

// ---- CLI wrapper against a real throwaway git repo --------------------------------

/**
 * @param {{ vitestConfig?: string, jestConfig?: string|null, vitestMap?: object|null,
 *           jestMap?: object|null }} [opts]
 */
function gitFixture({ vitestConfig, jestConfig = null, vitestMap = null, jestMap = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-diffcov-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(GATE, join(dir, 'tools/check-diff-coverage.mjs'))
  writeFileSync(
    join(dir, 'vitest.config.ts'),
    vitestConfig ?? readShippedVitest(), // the GREEN case proves the shipped config parses
  )
  if (jestConfig !== null) {
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/jest.config.js'), jestConfig)
  }
  if (vitestMap !== null) {
    mkdirSync(join(dir, 'coverage'), { recursive: true })
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify(vitestMap))
  }
  if (jestMap !== null) {
    mkdirSync(join(dir, 'apps/mobile/coverage'), { recursive: true })
    writeFileSync(join(dir, 'apps/mobile/coverage/coverage-final.json'), JSON.stringify(jestMap))
  }
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')
  return dir
}

function addUntracked(dir, rel, body = 'export const x = () => 1\n') {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
}

function runGate(dir, { ci = false } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync('node', ['tools/check-diff-coverage.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: clean tree → "no changed source files" one-liner, exit 0', () => {
  const dir = gitFixture({ vitestMap: {} })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('no changed source files'), r.out)
})

test('RED: an untracked, never-imported src file fails naming it + both reproduce commands', () => {
  const dir = gitFixture({ vitestMap: {} })
  addUntracked(dir, 'apps/server/src/dal/widgets.ts')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/dal/widgets.ts'), r.out)
  assert.ok(r.out.includes('absent from every coverage map (vitest + jest-expo)'), r.out)
  assert.ok(r.out.includes('pnpm exec vitest run --coverage --silent'), r.out)
  assert.ok(r.out.includes('pnpm --filter mobile exec jest --coverage --silent'), r.out)
  assert.ok(r.out.includes('FIX[diff-coverage]'), r.out)
})

test('GREEN: the same untracked file passes once the vitest map carries it above the floors', () => {
  const covered = fileCov('apps/server/src/dal/widgets.ts', { covered: 4, total: 4 })
  const dir = gitFixture({ vitestMap: { 'apps/server/src/dal/widgets.ts': covered } })
  addUntracked(dir, 'apps/server/src/dal/widgets.ts')
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('1 changed source file(s) clear the per-file floors'), r.out)
})

test('GREEN merge through the CLI: a jest-classified pure module covered by the VITEST map passes', () => {
  const file = 'apps/mobile/src/lib/kv.ts'
  const dir = gitFixture({
    jestConfig: readShippedJest(),
    vitestMap: { [file]: fileCov(file, { covered: 4, total: 4 }) },
    jestMap: {},
  })
  addUntracked(dir, file)
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('1 changed source file(s) clear the per-file floors'), r.out)
})

test('FAIL CLOSED: missing vitest map reds when a changed file needs it, naming the unit step', () => {
  const dir = gitFixture({ vitestMap: null })
  addUntracked(dir, 'apps/server/src/dal/widgets.ts')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('coverage/coverage-final.json not found but changed files in its tree need it'), r.out)
  assert.ok(r.out.includes('pnpm exec vitest run --coverage --silent'), r.out)
  assert.ok(r.out.includes('chain was reordered or coverage/ was deleted'), r.out)
})

test('FAIL CLOSED: missing apps/mobile map reds for a changed mobile file, naming the jest step', () => {
  const dir = gitFixture({ jestConfig: readShippedJest(), vitestMap: {}, jestMap: null })
  addUntracked(dir, 'apps/mobile/src/components/Button.tsx')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/mobile/coverage/coverage-final.json not found'), r.out)
  assert.ok(r.out.includes('pnpm --filter mobile exec jest --coverage --silent'), r.out)
})

test('FAIL CLOSED: apps/mobile source changed but jest.config.js is gone — the floors have no home', () => {
  const dir = gitFixture({ vitestMap: {}, jestMap: {} })
  addUntracked(dir, 'apps/mobile/src/components/Button.tsx')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes('apps/mobile/jest.config.js not found but apps/mobile source changed'),
    r.out,
  )
})

test('FAIL CLOSED: a vitest.config.ts without PER_FILE_FLOORS reds rather than inventing numbers', () => {
  const dir = gitFixture({ vitestConfig: 'export default {}\n', vitestMap: {} })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no parseable PER_FILE_FLOORS'), r.out)
})

test('FAIL CLOSED: a jest.config.js without floors (or without collectCoverageFrom) reds', () => {
  const noFloors = gitFixture({ jestConfig: 'module.exports = {}\n', vitestMap: {} })
  const r1 = runGate(noFloors)
  assert.equal(r1.code, 1, r1.out)
  assert.ok(r1.out.includes('apps/mobile/jest.config.js carries no parseable PER_FILE_FLOORS'), r1.out)

  const noSurface = gitFixture({
    jestConfig:
      'const PER_FILE_FLOORS = { statements: 50, branches: 40, functions: 45, lines: 50 }\n' +
      'module.exports = { coverageThreshold: { global: PER_FILE_FLOORS } }\n',
    vitestMap: {},
  })
  const r2 = runGate(noSurface)
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes('no parseable collectCoverageFrom'), r2.out)
})

test('outside a git repo: loud SKIP locally, FAIL in CI (never a silent pass)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-diffcov-nogit-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(GATE, join(dir, 'tools/check-diff-coverage.mjs'))
  writeFileSync(join(dir, 'vitest.config.ts'), readShippedVitest())
  mkdirSync(join(dir, 'coverage'), { recursive: true })
  writeFileSync(join(dir, 'coverage/coverage-final.json'), '{}')
  const local = runGate(dir)
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('cannot enumerate changed files'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
