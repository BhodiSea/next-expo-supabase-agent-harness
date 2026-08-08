// THE FROZEN STOP FLOOR (0.3.0) — union semantics, proven end to end.
//
// harness.config.mjs is manifest mode `config` and check-gate-integrity skips every
// non-`owned` entry, so until this release NOTHING hashed STOP_HOOK_STEPS: deleting
// `test-quality` or `diff-coverage` from the array mid-turn ended the turn green, with
// gate-integrity reporting OK because a `config` file is human-tunable by design.
//
// The fix is a union, not a replacement: the hook runs the local config PLUS any floored
// step the config no longer names. A project may APPEND a step (that is the whole reason
// the config is tunable); it may not subtract one.
//
// Fixture commands are `node <file>.mjs` marker scripts rather than shell builtins so the
// Windows leg of the unit lane runs the identical assertions.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadStopChain, unionSteps } from '../../template/base/tools/lib/stop-chain.mjs'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))

/**
 * A scaffold-shaped fixture: the real Stop hook, a hand-written harness.config.mjs whose
 * STOP_HOOK_STEPS are cheap marker scripts, and a stop.floor.json under our control.
 * @param {{ config: string[], floor: string[] | null, corruptFloor?: string }} spec
 *        step names; each becomes a `node mark-<name>.mjs` step that writes ran-<name>.
 */
function fixture({ config, floor, corruptFloor }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-stopfloor-'))
  cpSync(join(TEMPLATE, '.claude/hooks'), join(dir, '.claude/hooks'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  // The hook resolves the union through the shared lib (0.7.0) — part of the rendered
  // install layout, exactly like harness.config.mjs below.
  copyFileSync(join(TEMPLATE, 'tools/lib/stop-chain.mjs'), join(dir, 'tools/lib/stop-chain.mjs'))

  const names = [...new Set([...config, ...(floor ?? [])])]
  for (const n of names) {
    writeFileSync(
      join(dir, `mark-${n}.mjs`),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync('ran-${n}', '1')\n`,
    )
  }
  const tuple = (n) => `['${n}', 'node mark-${n}.mjs']`
  writeFileSync(
    join(dir, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [${config.map(tuple).join(', ')}]\n`,
  )
  if (corruptFloor !== undefined) {
    writeFileSync(join(dir, 'tools/stop.floor.json'), corruptFloor)
  } else if (floor !== null) {
    writeFileSync(
      join(dir, 'tools/stop.floor.json'),
      `${JSON.stringify({ comment: 'fixture', steps: floor.map((n) => [n, `node mark-${n}.mjs`]) }, null, 2)}\n`,
    )
  }
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

const ran = (dir, name) => existsSync(join(dir, `ran-${name}`))

test('a step DELETED from the config still runs, from the floor', () => {
  // The 0.2.1 exploit, verbatim: drop the turn-fatal check from STOP_HOOK_STEPS and end
  // the turn green. The floor makes the deletion buy nothing.
  const dir = fixture({ config: ['validate'], floor: ['validate', 'test-quality'] })
  const r = runStopHook(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(ran(dir, 'validate'), 'the config step must run')
  assert.ok(ran(dir, 'test-quality'), `the floored step must run despite its deletion:\n${r.out}`)
  // …and the top-up is EVIDENCE, printed on the green path too.
  assert.match(r.out, /floor step\(s\) were MISSING/)
  assert.match(r.out, /test-quality/)
})

test('a project may APPEND a step — extension is preserved, subtraction is not', () => {
  const dir = fixture({ config: ['validate', 'house-rule'], floor: ['validate'] })
  const r = runStopHook(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(ran(dir, 'house-rule'), 'a project-added step must still run')
  assert.ok(ran(dir, 'validate'), r.out)
  // Nothing was missing, so there is no top-up note to print.
  assert.ok(!r.out.includes('floor step(s) were MISSING'), r.out)
})

test('a floored step that FAILS blocks the turn even though the config never named it', () => {
  const dir = fixture({ config: ['validate'], floor: ['validate', 'boom'] })
  // Make the floored step red.
  writeFileSync(join(dir, 'mark-boom.mjs'), 'process.exit(3)\n')
  const r = runStopHook(dir)
  assert.equal(r.code, 2, `the turn must be blocked: ${r.out}`)
  assert.match(r.out, /### boom FAILED/)
})

test('a MISSING or CORRUPT floor is a loud NOTE, never a bricked turn', () => {
  // The deliberate trade: a corrupt floor blocking every turn on the machine is a worse
  // failure than a turn whose floor could not be read. The file is inside gate-integrity's
  // hashed surface and the write-guard table, so the tamper is evidenced on the very next
  // validate rather than depending on this hook to notice.
  const missing = fixture({ config: ['validate'], floor: null })
  const m = runStopHook(missing)
  assert.equal(m.code, 0, m.out)
  assert.ok(ran(missing, 'validate'), m.out)
  assert.match(m.out, /could not read tools\/stop\.floor\.json/)
  assert.match(m.out, /write-guard-protected/)

  const corrupt = fixture({ config: ['validate'], floor: [], corruptFloor: '{ not json' })
  const c = runStopHook(corrupt)
  assert.equal(c.code, 0, c.out)
  assert.ok(ran(corrupt, 'validate'), c.out)
  assert.match(c.out, /could not read tools\/stop\.floor\.json/)

  const shapeless = fixture({ config: ['validate'], floor: [], corruptFloor: '{"steps": "all"}' })
  const s = runStopHook(shapeless)
  assert.equal(s.code, 0, s.out)
  assert.match(s.out, /no well-formed `steps` array/)
})

// ── the union LIB (0.7.0): ONE implementation, imported by the hook AND `validate
// --stop-chain`. These pin the semantics the spawn tests above prove end-to-end, at the
// seam both consumers share — so the two callers can never disagree about what the union IS.

test('unionSteps: floor-first order — a floored step a weakened config dropped runs where the floor puts it', () => {
  const config = [
    ['house-rule', 'node mark-house-rule.mjs'],
    ['validate', 'node mark-validate.mjs'],
  ]
  const floor = [
    ['validate', 'node mark-validate.mjs'],
    ['test-quality', 'node mark-test-quality.mjs'],
  ]
  const { steps, injected } = unionSteps(config, floor)
  assert.deepEqual(
    steps.map(([n]) => n),
    ['validate', 'test-quality', 'house-rule'],
    'floor order first, appended project steps last',
  )
  assert.deepEqual(injected.map(([n]) => n), ['test-quality'])
})

test('unionSteps: a config that subtracts nothing is returned AS IS — config-append preserved, no reorder', () => {
  const config = [
    ['validate', 'node mark-validate.mjs'],
    ['house-rule', 'node mark-house-rule.mjs'],
  ]
  const floor = [['validate', 'node mark-validate.mjs']]
  const { steps, injected } = unionSteps(config, floor)
  assert.equal(steps, config, 'identity, not a copy — the hook ran the config array untouched here')
  assert.deepEqual(injected, [])
})

test('unionSteps: subtraction is impossible — every floor step survives even an EMPTY config', () => {
  const floor = [
    ['validate', 'node mark-validate.mjs'],
    ['test-quality', 'node mark-test-quality.mjs'],
    ['diff-coverage', 'node mark-diff-coverage.mjs'],
  ]
  const { steps, injected } = unionSteps([], floor)
  for (const [n] of floor) {
    assert.ok(steps.some(([s]) => s === n), `floor step ${n} must survive the maximal subtraction`)
  }
  assert.equal(injected.length, floor.length)
})

test('loadStopChain mirrors the hook posture: missing/corrupt/shapeless floor is a NOTE, never a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-stopchain-lib-'))
  const config = [['validate', 'node mark-validate.mjs']]
  const floorUrl = pathToFileURL(join(dir, 'stop.floor.json'))

  const missing = loadStopChain(config, floorUrl)
  assert.equal(missing.steps, config)
  assert.deepEqual(missing.injected, [])
  assert.match(String(missing.floorNote), /could not read tools\/stop\.floor\.json/)

  writeFileSync(join(dir, 'stop.floor.json'), '{ not json')
  assert.match(String(loadStopChain(config, floorUrl).floorNote), /could not read tools\/stop\.floor\.json/)

  writeFileSync(join(dir, 'stop.floor.json'), '{"steps": "all"}')
  assert.match(String(loadStopChain(config, floorUrl).floorNote), /no well-formed `steps` array/)

  writeFileSync(
    join(dir, 'stop.floor.json'),
    JSON.stringify({ steps: [['validate', 'node mark-validate.mjs'], ['boom', 'node mark-boom.mjs']] }),
  )
  const good = loadStopChain(config, floorUrl)
  assert.equal(good.floorNote, null)
  assert.deepEqual(good.steps.map(([n]) => n), ['validate', 'boom'])
  assert.deepEqual(good.injected.map(([n]) => n), ['boom'])
})

test('a MISSING union lib is a loud NOTE and the config chain still runs — never a bricked turn', () => {
  // The one failure mode the extraction ADDS. The lib lives under tools/lib — inside
  // gate-integrity's hashed surface and the write-guard table like the floor itself — so
  // the hook degrades exactly as it does on an unreadable floor: config chain alone, said
  // out loud, evidenced on the very next validate rather than bricking every turn here.
  const dir = fixture({ config: ['validate'], floor: ['validate', 'test-quality'] })
  rmSync(join(dir, 'tools/lib/stop-chain.mjs'))
  const r = runStopHook(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(ran(dir, 'validate'), r.out)
  assert.ok(!ran(dir, 'test-quality'), 'without the lib the union cannot be computed — the config chain ran alone')
  assert.match(r.out, /could not load tools\/lib\/stop-chain\.mjs/)
})

test('the SHIPPED floor equals the shipped STOP_HOOK_STEPS (generate-floor lockstep)', async () => {
  const { readFileSync } = await import('node:fs')
  const { STOP_HOOK_STEPS } = await import(
    new URL('../../template/base/tools/harness.config.mjs', import.meta.url).href
  )
  const floor = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../template/base/tools/stop.floor.json', import.meta.url)), 'utf8'),
  ).steps
  assert.deepEqual(
    floor,
    STOP_HOOK_STEPS.map(([n, c]) => [n, c]),
    'tools/stop.floor.json is out of sync — run `node scripts/generate-floor.mjs --write`',
  )
})
