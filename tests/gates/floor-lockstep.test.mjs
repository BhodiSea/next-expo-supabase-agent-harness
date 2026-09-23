// The CI floor is a FROZEN snapshot (template/base/tools/validate.floor.json),
// not a hand-copied array. These tests pin the properties that make it
// trustworthy: (1) the snapshot equals the canonical VALIDATE_STEPS data-to-data
// (so `--min-floor` runs the real chain) and scripts/generate-floor.mjs --check
// agrees; (2) `--min-floor` FAILS CLOSED when the snapshot is missing or corrupt
// (never silently degrades to the local config); (3) config-only extra steps
// still append after the floor; (4) generate-floor --write, run on a mirror,
// seeds a missing or corrupt snapshot from the doctrine and keeps a hand-tuned
// comment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Static, deliberately (0.8.0): the computed file:// dynamic import this replaced
// was opaque to `knip --strict` and needed a Windows workaround (check-query-shapes
// precedent).
import { VALIDATE_STEPS } from '../../template/base/tools/harness.config.mjs'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const VALIDATE = join(TEMPLATE, 'tools/validate.mjs')
const FLOOR_JSON = join(TEMPLATE, 'tools/validate.floor.json')
const GENERATE_FLOOR = fileURLToPath(new URL('../../scripts/generate-floor.mjs', import.meta.url))

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  return { ...env, ...extra }
}

// Build a self-contained scaffold-tools dir: validate.mjs statically imports
// ./harness.config.mjs, so that file must exist for the runner to load at all.
// The floor snapshot is planted (or withheld) per-case.
/** @param {{ floor?: any, config?: any }} parts */
function fixture({ floor, config }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-floor-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    config ?? "export const VALIDATE_STEPS = [['format', 'x']]\nexport const STOP_HOOK_STEPS = []\n",
  )
  if (floor !== undefined) writeFileSync(join(dir, 'tools/validate.floor.json'), floor)
  return dir
}

function runValidate(dir, args) {
  const res = spawnSync('node', ['tools/validate.mjs', ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv() })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('the frozen snapshot equals VALIDATE_STEPS (data-to-data, not a regex parse)', async () => {
  const snapshot = JSON.parse(readFileSync(FLOOR_JSON, 'utf8'))
  assert.equal(typeof snapshot.comment, 'string', 'snapshot must carry a doctrine comment')
  assert.deepEqual(
    snapshot.steps,
    VALIDATE_STEPS,
    'validate.floor.json steps must be a verbatim snapshot of VALIDATE_STEPS (names + commands, in order)',
  )
})

test('scripts/generate-floor.mjs --check agrees the shipped snapshot is in lockstep', () => {
  // The generator/checker hardcodes the repo-root paths, so this is the live
  // lockstep the machinery-lint lane runs.
  const r = spawnSync('node', [GENERATE_FLOOR, '--check'], { encoding: 'utf8', env: cleanEnv() })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 0, out)
  assert.match(out, /generate-floor --check: OK \(VALIDATE_STEPS: \d+, STOP_HOOK_STEPS: \d+ in lockstep\)/, out)
})

// --write runs against a MIRROR, never the real template: generate-floor resolves ROOT from its
// own location, so a copy under a scratch dir writes only there. A tiny synthetic config keeps
// the expected steps literal and the mirror independent of today's real chain.
const MIRROR_CONFIG =
  "export const VALIDATE_STEPS = [['format', 'x'], ['types', 'y']]\nexport const STOP_HOOK_STEPS = [['lint', 'z']]\n"

/** @param {{ validateFloor?: string }} planted */
function mirror({ validateFloor } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-floor-'))
  const tools = join(dir, 'template/base/tools')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(tools, { recursive: true })
  copyFileSync(GENERATE_FLOOR, join(dir, 'scripts/generate-floor.mjs'))
  writeFileSync(join(tools, 'harness.config.mjs'), MIRROR_CONFIG)
  if (validateFloor !== undefined) writeFileSync(join(tools, 'validate.floor.json'), validateFloor)
  return dir
}

function runGenerate(dir, flag) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/generate-floor.mjs'), flag], {
    encoding: 'utf8',
    env: cleanEnv(),
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const readFloor = (dir, name) =>
  JSON.parse(readFileSync(join(dir, 'template/base/tools', name), 'utf8'))

test('--write with no snapshots seeds both from the doctrine, and --check then agrees', () => {
  const dir = mirror()
  const w = runGenerate(dir, '--write')
  assert.equal(w.code, 0, w.out)
  const validate = readFloor(dir, 'validate.floor.json')
  const stop = readFloor(dir, 'stop.floor.json')
  assert.match(validate.comment, /^frozen snapshot of the canonical VALIDATE_STEPS/)
  assert.match(stop.comment, /^frozen snapshot of the canonical STOP_HOOK_STEPS/)
  assert.deepEqual(validate.steps, [['format', 'x'], ['types', 'y']])
  assert.deepEqual(stop.steps, [['lint', 'z']])
  const c = runGenerate(dir, '--check')
  assert.equal(c.code, 0, c.out)
  assert.match(c.out, /generate-floor --check: OK/, c.out)
})

test('--write keeps a hand-tuned comment and replaces the steps', () => {
  const dir = mirror({ validateFloor: JSON.stringify({ comment: 'hand-tuned', steps: [] }) })
  const w = runGenerate(dir, '--write')
  assert.equal(w.code, 0, w.out)
  const validate = readFloor(dir, 'validate.floor.json')
  assert.equal(validate.comment, 'hand-tuned')
  assert.deepEqual(validate.steps, [['format', 'x'], ['types', 'y']])
})

test('--write over a corrupt snapshot seeds the doctrine comment', () => {
  const dir = mirror({ validateFloor: 'this is { not json' })
  const w = runGenerate(dir, '--write')
  assert.equal(w.code, 0, w.out)
  const validate = readFloor(dir, 'validate.floor.json')
  assert.match(validate.comment, /^frozen snapshot of the canonical VALIDATE_STEPS/)
  assert.deepEqual(validate.steps, [['format', 'x'], ['types', 'y']])
})

test('--min-floor FAILS CLOSED when the snapshot is missing', () => {
  const dir = fixture({ floor: undefined }) // no validate.floor.json planted
  const r = runValidate(dir, ['--min-floor', '--list'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /validate\.floor\.json/, r.out)
  assert.match(r.out, /FAILING CLOSED/, r.out)
})

test('--min-floor FAILS CLOSED when the snapshot is corrupt JSON', () => {
  const dir = fixture({ floor: 'this is { not json' })
  const r = runValidate(dir, ['--min-floor', '--list'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not valid JSON|FAILING CLOSED/, r.out)
})

test('--min-floor FAILS CLOSED when steps are malformed (no fallback to config)', () => {
  const dir = fixture({ floor: JSON.stringify({ comment: 'x', steps: [] }) })
  const r = runValidate(dir, ['--min-floor', '--list'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /well-formed|FAILING CLOSED/, r.out)
})

test('config-only extra steps append AFTER the floor (floor first, then extras)', () => {
  const floor = JSON.stringify({
    comment: 'test floor',
    steps: [
      ['format', 'node -e "0"'],
      ['types', 'node -e "0"'],
    ],
  })
  const config =
    "export const VALIDATE_STEPS = [['format', 'node -e \"0\"'], ['types', 'node -e \"0\"'], ['project-extra', 'node -e \"0\"']]\nexport const STOP_HOOK_STEPS = []\n"
  const dir = fixture({ floor, config })
  const r = runValidate(dir, ['--min-floor', '--list'])
  assert.equal(r.code, 0, r.out)
  const names = r.out
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/)[0])
  assert.deepEqual(names, ['format', 'types', 'project-extra'], r.out)
})

test('without --min-floor the runner uses the config directly (snapshot irrelevant)', () => {
  const dir = fixture({ floor: undefined, config: "export const VALIDATE_STEPS = [['only', 'x']]\nexport const STOP_HOOK_STEPS = []\n" })
  const r = runValidate(dir, ['--list'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^only\s/, r.out)
})
