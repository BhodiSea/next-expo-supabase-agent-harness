// Can-fail proofs for the machinery complexity ratchet (G16). The arithmetic lives in
// scripts/lib/complexity.mjs, so it is tested here as a pure function — measured scores in,
// problems out — without a 15-second ESLint run (scripts/check-complexity-ratchet.mjs only
// supplies the measurements by re-linting with --no-inline-config). The script itself runs at
// the end of this file, over a mirror with a fake `pnpm`, to pin where it reads and writes its
// record (#53).
//
// The gate this backs is the one that stops the harness exempting ITSELF from the
// cognitive-complexity <= 15 bar it enforces on every consumer: a disable directive
// suppresses the rule entirely, so `eslint .` stays green while a disabled function grows
// without limit. These tests pin the comparison.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compareComplexity, identify, keyScores, scoreOf } from '../../scripts/lib/complexity.mjs'

const record = { limit: 15, functions: { 'a.mjs::foo': 20, 'b.mjs::bar': 30 } }

test('a function that stayed at or below its record is clean', () => {
  const { problems, improved } = compareComplexity(
    new Map([['a.mjs::foo', 20], ['b.mjs::bar', 30]]),
    record,
  )
  assert.equal(problems.length, 0)
  assert.equal(improved.length, 0)
})

test('GREW: a ratcheted function that increased reds — the promise nothing kept', () => {
  const { problems } = compareComplexity(new Map([['a.mjs::foo', 21], ['b.mjs::bar', 30]]), record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /GREW to 21 from a recorded 20/)
})

test('NEW: an over-limit function with no record reds — the next function is not free', () => {
  const { problems } = compareComplexity(
    new Map([['a.mjs::foo', 20], ['b.mjs::bar', 30], ['c.mjs::baz', 18]]),
    record,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /c\.mjs::baz: NEW over-limit function at 18/)
})

test('STALE: a record whose function is gone reds — bank the win, do not hoard the budget', () => {
  const { problems } = compareComplexity(new Map([['a.mjs::foo', 20]]), record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /b\.mjs::bar: recorded at 30 but no longer over the limit/)
})

test('improvement is reported, not failed — so the headroom can be banked deliberately', () => {
  const { problems, improved } = compareComplexity(
    new Map([['a.mjs::foo', 17], ['b.mjs::bar', 30]]),
    record,
  )
  assert.equal(problems.length, 0)
  assert.deepEqual(improved, [['a.mjs::foo', 17, 20]])
})

test('identify: reads the function name off a declaration, position-independently', () => {
  assert.equal(identify('export async function init(opts) {'), 'init')
  assert.equal(identify('export function mergeClaudeSettings(a, b) {'), 'mergeClaudeSettings')
  assert.equal(identify('  const parseThing = (x) => {'), 'parseThing')
})

test('identify: an anonymous callback falls back to normalized declaration text', () => {
  const id = identify('  entries.forEach((entry, i) => {')
  assert.match(id, /^anon\(/)
  // Stable across line shifts — it is the text, not a line number.
  assert.equal(id, identify('\t\tentries.forEach((entry, i) => {  '))
})

test('scoreOf: extracts the measured score, or null for an unrelated message', () => {
  assert.equal(scoreOf('Refactor this function to reduce its Cognitive Complexity from 133 to the 15 allowed.'), 133)
  assert.equal(scoreOf('some other lint message'), null)
})

test('keyScores: distinct names all measured; no collision', () => {
  const { measured, collisions } = keyScores([
    { base: 'a.mjs::foo', score: 30 },
    { base: 'a.mjs::bar', score: 16 },
  ])
  assert.deepEqual(collisions, [])
  assert.equal(measured.get('a.mjs::foo'), 30)
  assert.equal(measured.get('a.mjs::bar'), 16)
})

test('keyScores: two OVER-LIMIT functions sharing a name are REFUSED, not guessed', () => {
  // The occurrence-index scheme (the first fix) was itself broken by an adversarial review: a
  // same-named sibling CROSSING the complexity limit renumbers the indices, so a real regression
  // can slide into a vacated slot and read as "improved". ESLint only reports over-limit
  // functions, so there is no stable occurrence population — the honest response is to refuse the
  // ambiguity and make the human give them distinct names, never to pick one silently.
  const { measured, collisions } = keyScores([
    { base: 'a.mjs::handle', score: 30 },
    { base: 'a.mjs::handle', score: 16 },
    { base: 'a.mjs::other', score: 20 },
  ])
  assert.deepEqual(collisions, ['a.mjs::handle'])
  // The colliding name is NOT in measured (it is reported as a collision, not scored).
  assert.equal(measured.has('a.mjs::handle'), false)
  assert.equal(measured.get('a.mjs::other'), 20)
})

// ── The script itself, over a mirror (#53) ─────────────────────────────────────────────────
// The script resolves ROOT from its own location and lints ROOT's tree, so the record it judges
// against must be ROOT's too, whichever directory it was started from. A MIRROR holds copies of
// the script and its one repository import, a record, an `a.mjs` whose first line names `foo`,
// and a canned ESLint report; a fake `pnpm` on PATH prints that report and exits 1, as ESLint
// does when it reports anything. So these runs need no root node_modules (installer-unit runs
// them without an install) and never touch the real record. The mirror is built under a
// realpath: the function key is the report's filePath with ROOT stripped, and ROOT is the
// script's RESOLVED location, so a symlinked tmpdir (/var on macOS) would turn every key NEW.
const RATCHET = fileURLToPath(new URL('../../scripts/check-complexity-ratchet.mjs', import.meta.url))
const COMPLEXITY_LIB = fileURLToPath(new URL('../../scripts/lib/complexity.mjs', import.meta.url))
const MIRROR_RECORD = 'scripts/complexity-ratchet.json'
const SHIMLESS =
  process.platform === 'win32' &&
  'the ratchet spawns pnpm without a shell, so no test shim can stand in for it on win32'

// Windows names the variable Path; override THAT key or the child gets two PATHs.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/** @param {number} score */
const recordOf = (score) => `${JSON.stringify({ limit: 15, functions: { 'a.mjs::foo': score } })}\n`

/** @param {string} prefix */
const scratch = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

/** @param {{ recorded: number, measured: number }} scores */
function ratchetMirror({ recorded, measured }) {
  const root = scratch('epah-ratchet-')
  mkdirSync(join(root, 'scripts/lib'), { recursive: true })
  copyFileSync(RATCHET, join(root, 'scripts/check-complexity-ratchet.mjs'))
  copyFileSync(COMPLEXITY_LIB, join(root, 'scripts/lib/complexity.mjs'))
  writeFileSync(join(root, MIRROR_RECORD), recordOf(recorded))
  writeFileSync(join(root, 'a.mjs'), 'export function foo() {\n  return 1\n}\n')
  const message = `Refactor this function to reduce its Cognitive Complexity from ${String(measured)} to the 15 allowed.`
  const report = [
    { filePath: join(root, 'a.mjs'), messages: [{ ruleId: 'sonarjs/cognitive-complexity', line: 1, message }] },
  ]
  writeFileSync(join(root, 'eslint-report.json'), JSON.stringify(report))
  // The shim sits OUTSIDE the mirror, so the mirror holds exactly its five files.
  const bin = join(scratch('epah-ratchet-bin-'), 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\ncat '${join(root, 'eslint-report.json')}'\nexit 1\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  return { root, bin }
}

/** @param {{ root: string, bin: string }} mirror @param {string} cwd @param {string[]} [args] */
function runRatchet({ root, bin }, cwd, args = []) {
  const env = { ...process.env, [PATH_KEY]: `${bin}${delimiter}${process.env[PATH_KEY] ?? ''}` }
  const r = spawnSync(process.execPath, [join(root, 'scripts/check-complexity-ratchet.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('run from the mirror root: record and measured both 20 is CLEAN (the CI and Stop-hook case)', { skip: SHIMLESS }, () => {
  const mirror = ratchetMirror({ recorded: 20, measured: 20 })
  const r = runRatchet(mirror, mirror.root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /COMPLEXITY RATCHET: CLEAN \(1 recorded function\(s\), none grew; worst is a\.mjs::foo at 20\)/, r.out)
})

test('run from a foreign directory with no scripts/: the record still resolves from ROOT, so CLEAN', { skip: SHIMLESS }, () => {
  const mirror = ratchetMirror({ recorded: 20, measured: 20 })
  const r = runRatchet(mirror, scratch('epah-ratchet-cwd-'))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /COMPLEXITY RATCHET: CLEAN \(1 recorded function\(s\), none grew; worst is a\.mjs::foo at 20\)/, r.out)
  assert.doesNotMatch(r.out, /NEW over-limit function/, r.out)
})

test("a foreign directory's own, laxer record cannot turn growth into a false CLEAN", { skip: SHIMLESS }, () => {
  const mirror = ratchetMirror({ recorded: 20, measured: 22 })
  const cwd = scratch('epah-ratchet-cwd-')
  mkdirSync(join(cwd, 'scripts'))
  writeFileSync(join(cwd, MIRROR_RECORD), recordOf(30))
  const r = runRatchet(mirror, cwd)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /a\.mjs::foo: GREW to 22 from a recorded 20/, r.out)
  assert.doesNotMatch(r.out, /CLEAN/, r.out)
})

test('--write from a foreign directory writes ROOT\'s record and nothing under the working directory', { skip: SHIMLESS }, () => {
  const mirror = ratchetMirror({ recorded: 20, measured: 18 })
  const cwd = scratch('epah-ratchet-cwd-')
  mkdirSync(join(cwd, 'scripts'))
  const r = runRatchet(mirror, cwd, ['--write'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /COMPLEXITY RATCHET: wrote scripts\/complexity-ratchet\.json \(1 function\(s\)\)/, r.out)
  // One comparison, so a red shows both halves: ROOT's record moved, and the working
  // directory's empty scripts/ stayed empty.
  assert.deepEqual(
    {
      rootRecord: JSON.parse(readFileSync(join(mirror.root, MIRROR_RECORD), 'utf8')).functions,
      underCwd: readdirSync(join(cwd, 'scripts')),
    },
    { rootRecord: { 'a.mjs::foo': 18 }, underCwd: [] },
  )
})
