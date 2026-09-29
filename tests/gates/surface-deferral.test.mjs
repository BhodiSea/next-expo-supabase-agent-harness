// Can-fail proofs for the surface deferral (1.1.0, #56): tools/surfaces.json, its pure
// judgement in tools/lib/surface-deferral.mjs, and the CLI in tools/ci/surface-deferral.mjs
// that the `changes` job (--mode=pr) and the scheduled `floor-review` job (--mode=review)
// run.
//
// A deferral lets a web-first project say that its mobile surface is not built yet, so a
// pull request skips the two device lanes (mobile-e2e and perf-lane). The dangerous
// direction is a STALE deferral: one past its date, or one whose surface has since been
// built. Either keeps hiding both lanes, which is why the lanes come back on their own:
//   - the CONTENT TRIPWIRE: a row is void as soon as the tracked tree under apps/mobile/
//     differs from what the installer recorded in .harness/manifest.json (an edited byte,
//     an added file, a deleted recorded file, or no manifest at all);
//   - the DATE: past deferredUntil a pull request runs the lanes again, and the scheduled
//     review reds naming the row.
//
// The judgement is tested IN-PROCESS (the tools/lib coverage floor applies, and the lib
// takes the file list as a parameter so the Windows leg runs it); the CLI is spawned over
// throwaway git repositories, which skip loudly where git is missing.
// SOURCE: template/base/tools/lib/surface-deferral.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  classifyRows,
  compareTree,
  parseRegister,
  prOutputs,
  reviewProblems,
  SURFACES,
} from '../../template/base/tools/lib/surface-deferral.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TOOLS = join(ROOT, 'template', 'base', 'tools')
const CLI = fileURLToPath(new URL('../../template/base/tools/ci/surface-deferral.mjs', import.meta.url))
const INSTALLER = join(ROOT, 'installer', 'cli.mjs')
const SHIPPED_REGISTER = join(TOOLS, 'surfaces.json')

const HAS_GIT = spawnSync('git', ['--version']).status === 0
const NO_GIT = 'needs git: the CLI lists apps/mobile/ with `git ls-files`, and this leg has none'
const HAS_BASH = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const NO_BASH = 'needs a POSIX bash: the shipped workflows run on ubuntu runners, and this leg has none'

const TODAY = '2026-09-29'
const FUTURE = '2999-12-31'
const PAST = '2026-01-31'
const REASON = 'the web surface ships first; the mobile app is the scaffold until Q2'

const sha = (/** @type {string | Buffer} */ bytes) =>
  createHash('sha256').update(bytes).digest('hex')

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const APP = {
  'apps/mobile/app.config.ts': 'export default { name: "fixture" }\n',
  'apps/mobile/src/index.ts': 'export const ready = true\n',
}

/** A register with one row, in the shipped shape. */
const register = (/** @type {object[]} */ deferrals) => ({ '//': 'fixture', deferrals })
const mobileRow = (until = FUTURE, reason = REASON) => ({
  surface: 'mobile',
  deferredUntil: until,
  reason,
})

/** A manifest recording exactly these files' bytes. */
function manifestFor(/** @type {Record<string, string>} */ files) {
  return {
    harnessVersion: '1.1.0',
    baseVersion: '1.1.0',
    files: Object.fromEntries(
      Object.entries(files).map(([p, body]) => [p, { mode: 'seeded', sha256: sha(body) }]),
    ),
  }
}

/**
 * A throwaway repository: files written, register and manifest as given, everything
 * staged (`git ls-files` lists the index, which is what a CI checkout has).
 * @param {{ files?: Record<string, string>, surfaces?: object | string | null, manifest?: object | string | null }} spec
 */
function repo({ files = APP, surfaces = null, manifest = manifestFor(files) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-surface-'))
  made.push(dir)
  const put = (/** @type {string} */ rel, /** @type {string} */ body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  for (const [rel, body] of Object.entries(files)) put(rel, body)
  if (surfaces !== null) {
    put('tools/surfaces.json', typeof surfaces === 'string' ? surfaces : JSON.stringify(surfaces))
  }
  if (manifest !== null) {
    put(
      '.harness/manifest.json',
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    )
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  return dir
}

function git(/** @type {string} */ cwd, /** @type {string[]} */ ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

/** @param {string} cwd @param {string[]} args */
function run(cwd, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  }
}

/**
 * --mode=pr's stdout contract, asserted on every PR-mode run in this file: EXACTLY the two
 * key=value lines the step appends to $GITHUB_OUTPUT, and nothing else. Anything more on
 * stdout would become a job output, or break the file's format.
 * @param {{ stdout: string, out: string }} res @param {boolean} deferred @param {string} [deferral]
 */
function assertPrLines(res, deferred, deferral = '') {
  assert.equal(
    res.stdout,
    `mobile-deferred=${String(deferred)}\nmobile-deferral=${deferral}\n`,
    `stdout must be exactly the two key=value lines:\n${res.out}`,
  )
}

// ── the register's shape (in-process) ───────────────────────────────────────────────

test('the SHIPPED register is the empty one: a `//` note and no deferral', () => {
  const text = readFileSync(SHIPPED_REGISTER, 'utf8')
  const parsed = parseRegister(text)
  assert.deepEqual(parsed.problems, [])
  assert.deepEqual(parsed.rows, [])
  assert.equal(parsed.absent, false)
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['//', 'deferrals'])
})

test('an ABSENT register is no deferral, not a problem', () => {
  const parsed = parseRegister(null)
  assert.deepEqual(parsed, { rows: [], problems: [], absent: true })
})

test('a well-formed mobile row parses, and `mobile` is the one known surface', () => {
  const parsed = parseRegister(JSON.stringify(register([mobileRow()])))
  assert.deepEqual(parsed.problems, [])
  assert.deepEqual(parsed.rows, [mobileRow()])
  assert.deepEqual(Object.keys(SURFACES), ['mobile'])
  assert.equal(SURFACES.mobile.tree, 'apps/mobile/')
  assert.deepEqual([...SURFACES.mobile.lanes], ['mobile-e2e', 'perf-lane'])
})

test('MALFORMED: every shape Proposal 1 names is a problem naming the row, and yields no row', () => {
  /** @type {Array<[string, unknown, RegExp]>} */
  const CASES = [
    ['an unknown surface', [{ ...mobileRow(), surface: 'desktop' }], /surface "desktop" is not a known surface/],
    // `web` is not deferrable: nothing in the shipped workflows would read it, and the
    // browser lane's own runner fails closed on an absent surface by design.
    ['a web row', [{ ...mobileRow(), surface: 'web' }], /surface "web" is not a known surface/],
    ['a surface that is not a string', [{ ...mobileRow(), surface: 7 }], /surface 7 is not a known surface/],
    ['a repeated surface', [mobileRow(), mobileRow('2998-01-01')], /deferrals\[1\]: surface "mobile" repeats deferrals\[0\]/],
    ['a date that is not YYYY-MM-DD', [mobileRow('2027-1-1')], /deferredUntil "2027-1-1" is not a YYYY-MM-DD date/],
    ['a date that is no calendar day', [mobileRow('2027-02-30')], /deferredUntil "2027-02-30" is not a YYYY-MM-DD date/],
    ['a date that is a number', [{ ...mobileRow(), deferredUntil: 20270101 }], /deferredUntil 20270101 is not a YYYY-MM-DD date/],
    ['a missing date', [{ surface: 'mobile', reason: REASON }], /deferredUntil undefined is not a YYYY-MM-DD date/],
    ['an empty reason', [mobileRow(FUTURE, '')], /reason is empty/],
    ['a whitespace reason', [mobileRow(FUTURE, '   ')], /reason is empty/],
    ['a reason that is not a string', [{ ...mobileRow(), reason: ['x'] }], /reason is empty/],
    ['a reason with a line break', [mobileRow(FUTURE, 'first\nmobile-deferred=true')], /reason contains a line break/],
    ['a reason with a carriage return', [mobileRow(FUTURE, 'first\rsecond')], /reason contains a line break/],
    ['a reason with a Unicode line separator', [mobileRow(FUTURE, 'first\u2028second')], /reason contains a line break/],
    ['a row that is not an object', ['mobile'], /deferrals\[0\] is not an object/],
    ['a null row', [null], /deferrals\[0\] is not an object/],
  ]
  for (const [label, deferrals, needle] of CASES) {
    const parsed = parseRegister(JSON.stringify(register(/** @type {object[]} */ (deferrals))))
    assert.ok(parsed.problems.length > 0, `${label}: no problem reported`)
    assert.match(parsed.problems.join('\n'), needle, label)
  }
})

test('MALFORMED: a register that is not the shipped shape is a problem, never an empty register', () => {
  for (const [text, needle] of [
    ['{ not json', /is not valid JSON/],
    ['[]', /must be an object with a `deferrals` array/],
    ['null', /must be an object with a `deferrals` array/],
    ['{}', /must be an object with a `deferrals` array/],
    ['{"deferrals": {}}', /must be an object with a `deferrals` array/],
  ]) {
    const parsed = parseRegister(/** @type {string} */ (text))
    assert.deepEqual(parsed.rows, [], String(text))
    assert.match(parsed.problems.join('\n'), /** @type {RegExp} */ (needle), String(text))
  }
})

// ── the content tripwire (in-process) ───────────────────────────────────────────────

const TREE = SURFACES.mobile.tree
const filesOf = (/** @type {Record<string, string>} */ files) =>
  Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) }))

test('TRIPWIRE: byte-identical tracked files and records compare clean, and count', () => {
  const res = compareTree({ tree: TREE, files: filesOf(APP), manifest: manifestFor(APP) })
  assert.deepEqual(res, { compared: 2, causes: [] })
})

test('TRIPWIRE: an edited byte, an added file, a deleted recorded file and an absent manifest each void, naming the cause', () => {
  const edited = compareTree({
    tree: TREE,
    files: filesOf({ ...APP, 'apps/mobile/app.config.ts': `${APP['apps/mobile/app.config.ts']}x` }),
    manifest: manifestFor(APP),
  })
  assert.deepEqual(edited.causes, [
    'apps/mobile/app.config.ts differs from the sha the installer recorded',
  ])

  const added = compareTree({
    tree: TREE,
    files: filesOf({ ...APP, 'apps/mobile/src/screen.tsx': 'export {}\n' }),
    manifest: manifestFor(APP),
  })
  assert.deepEqual(added.causes, [
    'apps/mobile/src/screen.tsx has no record in .harness/manifest.json (a file the installer did not plant)',
  ])

  const deleted = compareTree({
    tree: TREE,
    files: filesOf({ 'apps/mobile/app.config.ts': APP['apps/mobile/app.config.ts'] }),
    manifest: manifestFor(APP),
  })
  assert.deepEqual(deleted.causes, [
    'apps/mobile/src/index.ts is recorded in .harness/manifest.json but is not a tracked file',
  ])

  const noManifest = compareTree({ tree: TREE, files: filesOf(APP), manifest: null })
  assert.equal(noManifest.causes.length, 1)
  assert.match(noManifest.causes[0], /\.harness\/manifest\.json is absent/)
})

test('TRIPWIRE: doubt voids — a record with no sha, an unreadable file, a manifest with no files map, a failed listing', () => {
  const noSha = compareTree({
    tree: TREE,
    files: filesOf(APP),
    manifest: {
      files: {
        ...manifestFor(APP).files,
        'apps/mobile/app.config.ts': { mode: 'conflict' },
      },
    },
  })
  assert.deepEqual(noSha.causes, ['apps/mobile/app.config.ts differs from the sha the installer recorded'])

  const unreadable = compareTree({
    tree: TREE,
    files: [...filesOf({ 'apps/mobile/src/index.ts': APP['apps/mobile/src/index.ts'] }), { path: 'apps/mobile/app.config.ts', error: 'EACCES' }],
    manifest: manifestFor(APP),
  })
  assert.deepEqual(unreadable.causes, ['apps/mobile/app.config.ts cannot be read (EACCES)'])

  const noMap = compareTree({ tree: TREE, files: filesOf(APP), manifest: { harnessVersion: '1.1.0' } })
  assert.match(noMap.causes.join('\n'), /records no `files` map/)

  const listing = compareTree({ tree: TREE, files: null, manifest: manifestFor(APP), listError: 'not a git repository' })
  assert.deepEqual(listing.causes, [
    'the tracked files under apps/mobile/ could not be listed (not a git repository)',
  ])

  const unread = compareTree({ tree: TREE, files: null, manifest: null, manifestError: 'no reader' })
  assert.deepEqual(unread.causes, ['.harness/manifest.json could not be read (no reader)'])
})

test('TRIPWIRE: files and records outside the surface tree are not the surface', () => {
  const shared = { 'packages/contracts/src/index.ts': 'export {}\n' }
  const res = compareTree({
    tree: TREE,
    files: filesOf({ ...APP, ...shared, 'apps/mobile-web/x.ts': 'y' }),
    manifest: manifestFor(APP),
  })
  assert.deepEqual(res, { compared: 2, causes: [] })
})

test('RETROFIT: nothing tracked and nothing recorded under apps/mobile/ compares zero files and stays live', () => {
  const res = compareTree({ tree: TREE, files: [], manifest: manifestFor({ 'package.json': '{}' }) })
  assert.deepEqual(res, { compared: 0, causes: [] })
  const [row] = classifyRows({ rows: [mobileRow()], today: TODAY, manifest: manifestFor({}), files: [] })
  assert.equal(row.status, 'live')
  assert.equal(row.compared, 0)
})

// ── the classification, the PR outputs and the review (in-process) ──────────────────

test('CLASSIFY: live over identical bytes, expired past its date, void over an edited tree', () => {
  const base = { manifest: manifestFor(APP), files: filesOf(APP) }
  assert.equal(classifyRows({ rows: [mobileRow()], today: TODAY, ...base })[0].status, 'live')
  // The date is the LAST deferred day: on it the row is live, the day after it is not.
  assert.equal(classifyRows({ rows: [mobileRow(TODAY)], today: TODAY, ...base })[0].status, 'live')
  assert.equal(classifyRows({ rows: [mobileRow(PAST)], today: TODAY, ...base })[0].status, 'expired')
  const edited = classifyRows({
    rows: [mobileRow()],
    today: TODAY,
    manifest: manifestFor(APP),
    files: filesOf({ ...APP, 'apps/mobile/src/index.ts': 'changed\n' }),
  })[0]
  assert.equal(edited.status, 'void')
  assert.deepEqual(edited.causes, ['apps/mobile/src/index.ts differs from the sha the installer recorded'])
  // A row both lapsed and edited is void first: the tree is the stronger claim.
  const both = classifyRows({ rows: [mobileRow(PAST)], today: TODAY, manifest: null, files: [] })[0]
  assert.equal(both.status, 'void')
})

test('PR OUTPUTS: only a live mobile row defers, and only with a well-formed register', () => {
  const live = classifyRows({ rows: [mobileRow()], today: TODAY, manifest: manifestFor(APP), files: filesOf(APP) })
  assert.deepEqual(prOutputs(live, []), { deferred: true, deferral: `${FUTURE}: ${REASON}` })
  assert.deepEqual(prOutputs(live, ['something malformed']), { deferred: false, deferral: '' })
  assert.deepEqual(prOutputs([], []), { deferred: false, deferral: '' })
  const expired = classifyRows({ rows: [mobileRow(PAST)], today: TODAY, manifest: manifestFor(APP), files: filesOf(APP) })
  assert.deepEqual(prOutputs(expired, []), { deferred: false, deferral: '' })
})

test('REVIEW: a live row is clean; an expired or void row is a problem naming the surface and its date', () => {
  const at = { today: TODAY, manifest: manifestFor(APP), files: filesOf(APP) }
  assert.deepEqual(reviewProblems(classifyRows({ rows: [mobileRow()], ...at }), TODAY), [])
  const expired = reviewProblems(classifyRows({ rows: [mobileRow(PAST)], ...at }), TODAY)
  assert.equal(expired.length, 1)
  assert.match(expired[0], /the mobile deferral lapsed after 2026-01-31 \(today is 2026-09-29\)/)
  const voided = reviewProblems(
    classifyRows({ rows: [mobileRow()], today: TODAY, manifest: null, files: filesOf(APP) }),
    TODAY,
  )
  assert.equal(voided.length, 1)
  assert.match(voided[0], /the mobile deferral is VOID — .*manifest\.json is absent/)
})

test('REVIEW: a void row with many causes names the first ones and counts the rest', () => {
  const many = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`apps/mobile/src/s${String(i)}.ts`, `${String(i)}\n`]),
  )
  const [row] = classifyRows({ rows: [mobileRow()], today: TODAY, manifest: manifestFor({}), files: filesOf(many) })
  const [problem] = reviewProblems([row], TODAY)
  assert.match(problem, /and 6 more/)
})

// ── the CLI (spawned over throwaway repositories) ───────────────────────────────────

test('CLI --mode=pr: the SHIPPED empty register over a CORRUPT manifest reads nothing else, prints false, exits 0', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: JSON.parse(readFileSync(SHIPPED_REGISTER, 'utf8')), manifest: '{ corrupt' })
  const res = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(res.code, 0, res.out)
  assertPrLines(res, false)
  assert.match(res.stderr, /no deferral is registered/)
})

test('CLI: an ABSENT register is no deferral in both modes, and the review says so in a NOTE', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: null })
  const pr = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(pr.code, 0, pr.out)
  assertPrLines(pr, false)
  const review = run(dir, '--mode=review', `--today=${TODAY}`)
  assert.equal(review.code, 0, review.out)
  assert.match(review.out, /surface-deferral: NOTE — tools\/surfaces\.json is absent/)
})

test('CLI --mode=pr: a live row over byte-identical files DEFERS, with the reason as the second line', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow()]) })
  const res = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(res.code, 0, res.out)
  assertPrLines(res, true, `${FUTURE}: ${REASON}`)
  assert.match(res.stderr, /mobile deferral LIVE until 2999-12-31 — 2 file\(s\) under apps\/mobile\/ match the sha the installer recorded/)
  assert.match(res.stderr, /mobile-e2e and perf-lane are SKIPPED on this pull request/)
})

test('ANTI-VACUITY (the gate proposal): one appended byte voids the row, and stderr names the file', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow()]) })
  appendFileSync(join(dir, 'apps/mobile/app.config.ts'), 'x')
  const res = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(res.code, 0, res.out)
  assertPrLines(res, false)
  assert.ok(
    res.stderr.includes(
      'surface-deferral: mobile deferral VOID — apps/mobile/app.config.ts differs from the sha the installer recorded',
    ),
    res.stderr,
  )
})

test('CLI --mode=pr: an added file, a deleted recorded file and an absent manifest each void the row, naming the cause', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const added = repo({ surfaces: register([mobileRow()]) })
  writeFileSync(join(added, 'apps/mobile/src/screen.tsx'), 'export {}\n')
  git(added, 'add', '-A')
  const a = run(added, '--mode=pr', `--today=${TODAY}`)
  assert.equal(a.code, 0, a.out)
  assertPrLines(a, false)
  assert.match(a.stderr, /VOID — apps\/mobile\/src\/screen\.tsx has no record in \.harness\/manifest\.json/)

  const deleted = repo({ surfaces: register([mobileRow()]) })
  git(deleted, 'rm', '-q', '--cached', 'apps/mobile/src/index.ts')
  unlinkSync(join(deleted, 'apps/mobile/src/index.ts'))
  const d = run(deleted, '--mode=pr', `--today=${TODAY}`)
  assert.equal(d.code, 0, d.out)
  assertPrLines(d, false)
  assert.match(d.stderr, /VOID — apps\/mobile\/src\/index\.ts is recorded in \.harness\/manifest\.json but is not a tracked file/)

  const noManifest = repo({ surfaces: register([mobileRow()]), manifest: null })
  const n = run(noManifest, '--mode=pr', `--today=${TODAY}`)
  assert.equal(n.code, 0, n.out)
  assertPrLines(n, false)
  assert.match(n.stderr, /VOID — .*\.harness\/manifest\.json is absent/)
})

test('CLI: a built app voids with one cause per file, and the log names the first twenty and counts the rest', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const screens = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`apps/mobile/src/screen-${String(i).padStart(2, '0')}.tsx`, `export const n = ${String(i)}\n`]),
  )
  const dir = repo({ files: { ...APP, ...screens }, surfaces: register([mobileRow()]), manifest: manifestFor(APP) })
  const res = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(res.code, 0, res.out)
  assertPrLines(res, false)
  assert.equal(res.stderr.split('\n').filter((l) => / has no record in /.test(l)).length, 20, res.stderr)
  assert.match(res.stderr, /mobile deferral VOID — and 5 more cause\(s\)/)
})

test('CLI: nothing tracked and nothing recorded under apps/mobile/ (a retrofit install) is LIVE, and says zero files were compared', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({
    files: { 'package.json': '{}\n' },
    surfaces: register([mobileRow()]),
  })
  const res = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(res.code, 0, res.out)
  assertPrLines(res, true, `${FUTURE}: ${REASON}`)
  assert.match(res.stderr, /LIVE until 2999-12-31 — zero files were compared/)
})

test('CLI: a past date is not deferred on a pull request, and --mode=review exits 1 naming the row', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow(PAST)]) })
  const pr = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(pr.code, 0, pr.out)
  assertPrLines(pr, false)
  assert.match(pr.stderr, /mobile deferral EXPIRED/)
  const review = run(dir, '--mode=review', `--today=${TODAY}`)
  assert.equal(review.code, 1, review.out)
  assert.match(review.stderr, /surface-deferral: FAIL/)
  assert.match(review.stderr, /tools\/surfaces\.json: the mobile deferral lapsed after 2026-01-31/)
  assert.match(review.stderr, /FIX\[surface-deferral\]/)
})

test('ANTI-VACUITY (the gate proposal): --mode=review with --today after deferredUntil exits 1; the same row on its date exits 0', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow('2027-03-31')]) })
  const late = run(dir, '--mode=review', '--today=2999-01-01')
  assert.equal(late.code, 1, late.out)
  assert.match(late.stderr, /the mobile deferral lapsed after 2027-03-31/)
  const onTime = run(dir, '--mode=review', '--today=2027-03-31')
  assert.equal(onTime.code, 0, onTime.out)
  assert.match(onTime.stdout, /surface-deferral: OK/)
})

test('CLI --mode=review: a void row exits 1 naming the cause', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow()]) })
  appendFileSync(join(dir, 'apps/mobile/src/index.ts'), '// the first real screen\n')
  const res = run(dir, '--mode=review', `--today=${TODAY}`)
  assert.equal(res.code, 1, res.out)
  assert.match(res.stderr, /the mobile deferral is VOID — apps\/mobile\/src\/index\.ts differs/)
})

test('CLI: each malformed register exits 1 in BOTH modes, and --mode=pr still prints the two false lines', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  for (const surfaces of [
    '{ not json',
    register([{ ...mobileRow(), surface: 'web' }]),
    register([mobileRow(), mobileRow()]),
    register([mobileRow('2027/03/31')]),
    register([mobileRow(FUTURE, '')]),
    register([mobileRow(FUTURE, 'one\ntwo')]),
  ]) {
    const dir = repo({ surfaces })
    const pr = run(dir, '--mode=pr', `--today=${TODAY}`)
    assert.equal(pr.code, 1, `${JSON.stringify(surfaces)}\n${pr.out}`)
    assertPrLines(pr, false)
    assert.match(pr.stderr, /surface-deferral: FAIL/)
    const review = run(dir, '--mode=review', `--today=${TODAY}`)
    assert.equal(review.code, 1, `${JSON.stringify(surfaces)}\n${review.out}`)
  }
})

test('CLI: a CORRUPT manifest with a row present exits 1 in both modes (the manifest is write-guarded: corrupt is tampering)', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow()]), manifest: '{ corrupt' })
  const pr = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(pr.code, 1, pr.out)
  assertPrLines(pr, false)
  assert.match(pr.stderr, /manifest\.json is not valid JSON/)
  const review = run(dir, '--mode=review', `--today=${TODAY}`)
  assert.equal(review.code, 1, review.out)
})

test('CLI: a missing or unknown --mode and a malformed --today are usage errors, never a deferral', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([mobileRow()]) })
  for (const args of [[], ['--mode=push'], ['--mode=pr', '--today=tomorrow']]) {
    const res = run(dir, ...args)
    assert.equal(res.code, 1, `${args.join(' ')}\n${res.out}`)
    assert.doesNotMatch(res.stdout, /mobile-deferred=true/)
  }
})

test('CLI: a listing that fails (no git repository) voids a row instead of deferring blind', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = mkdtempSync(join(tmpdir(), 'nsah-surface-nogit-'))
  made.push(dir)
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, 'tools/surfaces.json'), JSON.stringify(register([mobileRow()])))
  writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifestFor(APP)))
  const res = spawnSync(process.execPath, [CLI, '--mode=pr', `--today=${TODAY}`], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) },
  })
  const out = { stdout: res.stdout ?? '', out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  assert.equal(res.status, 0, out.out)
  assertPrLines(out, false)
  assert.match(res.stderr ?? '', /VOID — the tracked files under apps\/mobile\/ could not be listed \(git ls-files failed/)
})

test('A ZERO-EDIT SCAFFOLD: every tracked apps/mobile/ file matches its record, so a future-dated row is LIVE', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = mkdtempSync(join(tmpdir(), 'nsah-surface-init-'))
  made.push(dir)
  const init = spawnSync(process.execPath, [INSTALLER, 'init', '--dir', dir, '--tier', 'core', '--yes'], {
    encoding: 'utf8',
  })
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`)
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  const empty = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(empty.code, 0, empty.out)
  assertPrLines(empty, false)

  writeFileSync(join(dir, 'tools/surfaces.json'), JSON.stringify(register([mobileRow()]), null, 2))
  const live = run(dir, '--mode=pr', `--today=${TODAY}`)
  assert.equal(live.code, 0, live.out)
  assertPrLines(live, true, `${FUTURE}: ${REASON}`)
  const compared = /LIVE until 2999-12-31 — (\d+) file\(s\) under apps\/mobile\/ match/.exec(live.stderr)
  assert.ok(compared && Number(compared[1]) > 0, `the scaffold's mobile app must be compared, not skipped:\n${live.stderr}`)
})

// ── the `changes` job's step, run the way GitHub runs it ────────────────────────────

/** The run: script of the `changes` job's surface-deferral step, from the shipped workflow. */
function changesStep() {
  const wf = readFileSync(join(ROOT, 'template/base/github/workflows/quality-gate.yml'), 'utf8')
  const at = wf.indexOf('\n  changes:')
  const end = wf.indexOf('\n  db-scale:', at)
  const job = wf.slice(at, end)
  const step = /- name: (Surface deferral[^\n]*)\n(?: {8}[a-z-]+:.*\n)*? {8}run: (.+)\n/.exec(job)
  assert.ok(step, 'the changes job must run the surface-deferral step')
  return step[2]
}

/** Copy the CLI and the libs it imports into a fixture, where the step's relative path finds them. */
function installCli(/** @type {string} */ dir) {
  for (const rel of ['ci/surface-deferral.mjs', 'lib/surface-deferral.mjs', 'lib/gate.mjs', 'lib/fs-walk.mjs']) {
    mkdirSync(dirname(join(dir, 'tools', rel)), { recursive: true })
    copyFileSync(join(TOOLS, rel), join(dir, 'tools', rel))
  }
}

test('THE `changes` STEP: its real run: line writes the deferral to $GITHUB_OUTPUT, and one edited byte turns it off', (t) => {
  if (!HAS_GIT) return t.skip(NO_GIT)
  if (!HAS_BASH) return t.skip(NO_BASH)
  const script = changesStep()
  assert.equal(script, 'node tools/ci/surface-deferral.mjs --mode=pr >> "$GITHUB_OUTPUT"')
  const dir = repo({ surfaces: register([mobileRow()]) })
  installCli(dir)
  const step = (/** @type {string} */ out) =>
    spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    })

  const liveOut = join(dir, 'live.out')
  const live = step(liveOut)
  assert.equal(live.status, 0, live.stderr)
  assert.equal(readFileSync(liveOut, 'utf8'), `mobile-deferred=true\nmobile-deferral=${FUTURE}: ${REASON}\n`)

  appendFileSync(join(dir, 'apps/mobile/app.config.ts'), 'x')
  const voidOut = join(dir, 'void.out')
  const voided = step(voidOut)
  assert.equal(voided.status, 0, voided.stderr)
  assert.equal(readFileSync(voidOut, 'utf8'), 'mobile-deferred=false\nmobile-deferral=\n')

  // A malformed register fails the step, so `changes` goes red and gate-summary with it,
  // and what reached the output still says "not deferred".
  unlinkSync(join(dir, 'tools/surfaces.json'))
  writeFileSync(join(dir, 'tools/surfaces.json'), '{ not json')
  const badOut = join(dir, 'bad.out')
  const bad = step(badOut)
  assert.equal(bad.status, 1, bad.stderr)
  assert.equal(readFileSync(badOut, 'utf8'), 'mobile-deferred=false\nmobile-deferral=\n')
})

test('A PARKED FORK of lib/gate.mjs without readManifest: the CLI still loads, and a row is void rather than live', (t) => {
  // `update` plants this new CLI but parks the incoming copy of a forked tools/lib/gate.mjs,
  // so the CLI can run over a lib from before 1.1.0. A named import of readManifest would
  // fail `changes` at link time on every pull request of such an install; through the
  // namespace, the empty register still prints `false`, and a row cannot go live unread.
  if (!HAS_GIT) return t.skip(NO_GIT)
  const dir = repo({ surfaces: register([]) })
  installCli(dir)
  const gatePath = join(dir, 'tools/lib/gate.mjs')
  const forked = readFileSync(gatePath, 'utf8').replace('export function readManifest(', 'function readManifest(')
  assert.ok(!forked.includes('export function readManifest('), 'precondition: the export is removed')
  writeFileSync(gatePath, forked)
  const local = (/** @type {string[]} */ ...args) => {
    const res = spawnSync(process.execPath, ['tools/ci/surface-deferral.mjs', ...args], { cwd: dir, encoding: 'utf8' })
    return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }
  const empty = local('--mode=pr', `--today=${TODAY}`)
  assert.equal(empty.code, 0, empty.out)
  assertPrLines(empty, false)

  writeFileSync(join(dir, 'tools/surfaces.json'), JSON.stringify(register([mobileRow()])))
  const row = local('--mode=pr', `--today=${TODAY}`)
  assert.equal(row.code, 0, row.out)
  assertPrLines(row, false)
  assert.match(row.stderr, /VOID — \.harness\/manifest\.json could not be read \(tools\/lib\/gate\.mjs has no readManifest export/)
})
