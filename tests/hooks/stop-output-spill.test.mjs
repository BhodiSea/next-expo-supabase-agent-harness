// Bounded Stop output with spill-to-file (0.10.0).
//
// THE DEFECT, AND WHY THIS RELEASE IS WHEN IT MATTERS. Each failing step was reported as
// `out.slice(-4000)` — the TAIL. For a gate whose summary comes last that is the right
// 4000 characters; for one that ENUMERATES (a type-error list, a lint run) the head is the
// finding and the tail is the count, so an agent read "42 problems" and never saw the
// first. Nothing recovered it: the child's output lived only inside the catch.
//
// It becomes acute at 0.10.0 because an upgrading install can meet SIX expired ramps at
// once. `validate.mjs` is fail-fast so a human meets them one per run, but the Stop chain
// runs its steps to completion — the agent sees all six in one block, six tails deep, with
// the block budget draining.
//
// Every test below is a way the head can be lost while the turn still ends red.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))

/** A distinctive first line, a lot of filler, and a distinctive last line. */
const noisy = (n) =>
  [`HEAD-MARKER-${n}: the first finding, which the tail-only slice used to drop`]
    .concat(Array.from({ length: 400 }, (_, i) => `${n} filler line ${String(i)} ${'x'.repeat(40)}`))
    .concat([`TAIL-MARKER-${n}: 42 problems`])
    .join('\n')

/**
 * A tree whose STOP_HOOK_STEPS all FAIL, each printing `noisy(name)` and exiting 1.
 * @param {string[]} names
 */
function fixture(names) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-stopspill-'))
  cpSync(join(TEMPLATE, '.claude/hooks'), join(dir, '.claude/hooks'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TEMPLATE, 'tools/lib/stop-chain.mjs'), join(dir, 'tools/lib/stop-chain.mjs'))
  for (const n of names) {
    writeFileSync(
      join(dir, `fail-${n}.mjs`),
      `process.stdout.write(${JSON.stringify(noisy(n))})\nprocess.exit(1)\n`,
    )
  }
  const tuple = (n) => `['${n}', 'node fail-${n}.mjs']`
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [${names.map(tuple).join(', ')}]\n`,
  )
  writeFileSync(
    join(dir, 'tools/stop.floor.json'),
    `${JSON.stringify({ comment: 'fixture', steps: names.map((n) => [n, `node fail-${n}.mjs`]) }, null, 2)}\n`,
  )
  return dir
}

/** @param {string} dir */
function runStopHook(dir) {
  const res = spawnSync('node', [join(dir, '.claude/hooks/stop-validate-gate.mjs')], {
    cwd: dir,
    input: JSON.stringify({ stop_hook_active: false }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const SIX = ['validate', 'rls-isolation', 'unit', 'mobile-unit', 'diff-coverage', 'duplication']

test('THE FLOOD: six failing steps — every gate is named and every HEAD survives', () => {
  // The 0.10.0 shape. Before the spill, six tails meant six `42 problems` lines and not one
  // of the six findings.
  const dir = fixture(SIX)
  const r = runStopHook(dir)
  assert.equal(r.code, 2, r.out)
  for (const n of SIX) {
    assert.ok(r.out.includes(`### ${n} FAILED`), `${n} must be named`)
    assert.ok(r.out.includes(`HEAD-MARKER-${n}`), `${n}'s FIRST finding must survive`)
    assert.ok(r.out.includes(`TAIL-MARKER-${n}`), `${n}'s summary must survive too`)
  }
})

test('the full output is on disk, and it is the WHOLE output — not the excerpt', () => {
  const dir = fixture(['unit'])
  const r = runStopHook(dir)
  const path = join(dir, '.harness/stop-output/unit.log')
  assert.ok(existsSync(path), `the spill file must exist:\n${r.out}`)
  const spilled = readFileSync(path, 'utf8')
  assert.equal(spilled, noisy('unit'), 'the spill is byte-identical to the child output')
  // The message must POINT at it, or the file is one nobody opens.
  assert.ok(r.out.includes('.harness/stop-output/unit.log'), r.out)
  assert.ok(/… \d+ characters omitted/.test(r.out), r.out)
})

test('one file PER GATE — six simultaneous failures are six readable logs, not one interleaved', () => {
  const dir = fixture(SIX)
  runStopHook(dir)
  for (const n of SIX) {
    const p = join(dir, `.harness/stop-output/${n}.log`)
    assert.ok(existsSync(p), `${n} needs its own file`)
    assert.ok(readFileSync(p, 'utf8').startsWith(`HEAD-MARKER-${n}`), `${p} holds ${n}'s output`)
  }
})

test('SHORT output is passed through untouched — no spill, no elision notice', () => {
  // The common case must not gain a file or a paragraph. A gate whose whole output fits is
  // reported exactly as before.
  const dir = mkdtempSync(join(tmpdir(), 'epah-stopspill-short-'))
  cpSync(join(TEMPLATE, '.claude/hooks'), join(dir, '.claude/hooks'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TEMPLATE, 'tools/lib/stop-chain.mjs'), join(dir, 'tools/lib/stop-chain.mjs'))
  writeFileSync(join(dir, 'fail-unit.mjs'), "process.stdout.write('just this')\nprocess.exit(1)\n")
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    "export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['unit', 'node fail-unit.mjs']]\n",
  )
  writeFileSync(
    join(dir, 'tools/stop.floor.json'),
    `${JSON.stringify({ comment: 'fixture', steps: [['unit', 'node fail-unit.mjs']] }, null, 2)}\n`,
  )
  const r = runStopHook(dir)
  assert.equal(r.code, 2, r.out)
  assert.ok(r.out.includes('just this'), r.out)
  assert.ok(!r.out.includes('characters omitted'), r.out)
  assert.equal(existsSync(join(dir, '.harness/stop-output')), false, 'no file for short output')
})

test('FAILS SOFT: an unwritable spill still blocks the turn and still shows both ends', () => {
  // Bookkeeping never decides a turn. A hook that threw while REPORTING a failure would
  // convert a red gate into a crashed hook — strictly worse than the truncation it
  // replaced. `.harness` is planted as a FILE so mkdirSync cannot create the directory.
  const dir = fixture(['unit'])
  writeFileSync(join(dir, '.harness'), 'not a directory')
  const r = runStopHook(dir)
  assert.equal(r.code, 2, r.out)
  assert.ok(r.out.includes('HEAD-MARKER-unit'), r.out)
  assert.ok(r.out.includes('TAIL-MARKER-unit'), r.out)
  assert.ok(r.out.includes('could not be written'), r.out)
})
