// seededSourceFixes runtime channel (0.7.0) — the channel that carries a CORRECTED seeded
// source file to an EXISTING install as an instruction, without `update` writing a file the
// consumer owns.
//
// The behaviour under test mirrors dependencyObligations deliberately: an obligation is
// EMITTED, never applied — the seeded sources are untouched, the parked file self-clears
// once the tree stops matching the recorded BROKEN shape, and the parked file is
// machine-readable. What is new is the PROBES: "did the consumer apply a source fix" is not
// decidable in general, so each set records the harness-authored broken shape and is judged
// UNAPPLIED only while a probe file EXISTS and still matches it. Absent is NOT broken —
// the consumer moved the surface, and the gate stays the authority.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SOURCE_FIX_OBLIGATIONS_PATH,
  applySeededSourceFixObligations,
  unappliedSeededSourceFixes,
} from '../../installer/lib/migrations.mjs'

const CLIENT = 'apps/web/lib/supabase/client.ts'
const BARREL = 'packages/platform/supabase/src/client.ts'

const MIGRATIONS = {
  '//': 'doc key, must be ignored',
  '0.6.0': {
    seededSourceFixes: [
      {
        gate: 'auth-posture',
        why: 'the browser client persisted its session to localStorage while every server render read the cookie jar — a sign-in LOOP on the shipped scaffold.',
        paths: [CLIENT, BARREL],
        probes: [
          { path: CLIENT, brokenWhen: { lacks: 'cookieSessionStorage' } },
          { path: BARREL, brokenWhen: { lacks: 'cookieSessionStorage' } },
        ],
      },
    ],
  },
  '0.7.0': {
    seededSourceFixes: [
      {
        gate: 'future-gate',
        why: 'a fix from a FUTURE release, which must not be demanded of a 0.6.0 install.',
        paths: ['apps/web/lib/future.ts'],
        probes: [{ path: 'apps/web/lib/future.ts', brokenWhen: { contains: 'FUTURE_BROKEN' } }],
      },
    ],
  },
}

const BROKEN_CLIENT = '// pre-0.6.0 shape: no storage supplied, the session lands in localStorage\nexport function getBrowserClient() {}\n'
const FIXED_CLIENT = "import { cookieSessionStorage } from '@app/supabase/client'\nexport function getBrowserClient() {}\n"
const BROKEN_BARREL = "export { createBrowserSupabaseClient } from './browser.js'\n"
const FIXED_BARREL = "export { cookieSessionStorage } from './cookies.js'\n"

// readFile fixture: absent keys are null (the file does not exist), present keys are text.
/** @param {Record<string, string>} map */
const treeOf = (map) => (rel) => (Object.hasOwn(map, rel) ? map[rel] : null)

let seq = 0
function scratch() {
  const dir = join(tmpdir(), `harness-srcfix-${String(process.pid)}-${String(seq++)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** @param {string} dir @param {Record<string, string>} files */
function plant(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

test('a fix from a FUTURE release is not demanded yet', () => {
  const unapplied = unappliedSeededSourceFixes(MIGRATIONS, '0.6.0', treeOf({
    [CLIENT]: FIXED_CLIENT,
    [BARREL]: FIXED_BARREL,
    'apps/web/lib/future.ts': 'FUTURE_BROKEN',
  }))
  assert.deepEqual(unapplied, [])
})

test('a tree still matching the recorded broken shape owes the fix, tagged with its release', () => {
  const unapplied = unappliedSeededSourceFixes(MIGRATIONS, '0.6.0', treeOf({
    [CLIENT]: BROKEN_CLIENT,
    [BARREL]: BROKEN_BARREL,
  }))
  assert.equal(unapplied.length, 1)
  assert.equal(unapplied[0].gate, 'auth-posture')
  assert.equal(unapplied[0].since, '0.6.0')
})

test('ANY matching probe is enough — the unit is the subsystem, not the line', () => {
  // Half-applied is still broken: the app half took the fix, the package half did not.
  const unapplied = unappliedSeededSourceFixes(MIGRATIONS, '0.6.0', treeOf({
    [CLIENT]: FIXED_CLIENT,
    [BARREL]: BROKEN_BARREL,
  }))
  assert.equal(unapplied.length, 1)
})

test('a tree that took the fix owes nothing', () => {
  const unapplied = unappliedSeededSourceFixes(MIGRATIONS, '0.6.0', treeOf({
    [CLIENT]: FIXED_CLIENT,
    [BARREL]: FIXED_BARREL,
  }))
  assert.deepEqual(unapplied, [])
})

test('an ABSENT probe file is NOT broken — the consumer moved the surface; the gate stays the authority', () => {
  assert.deepEqual(unappliedSeededSourceFixes(MIGRATIONS, '0.6.0', treeOf({})), [])
})

test('an EMPTY probe file IS broken — it exists and lacks the symbol; "" must never read as absent', () => {
  const unapplied = unappliedSeededSourceFixes(MIGRATIONS, '0.6.0', treeOf({
    [CLIENT]: '',
    [BARREL]: FIXED_BARREL,
  }))
  assert.equal(unapplied.length, 1)
})

test('contains-shaped probes fire on the recorded broken marker', () => {
  const m = {
    '0.6.0': {
      seededSourceFixes: [
        {
          gate: 'auth-posture',
          why: 'a comment claimed httpOnly on a cookie a browser-side sign-in cannot set it on.',
          paths: [CLIENT],
          probes: [{ path: CLIENT, brokenWhen: { contains: 'the credential is an httpOnly cookie' } }],
        },
      ],
    },
  }
  assert.equal(
    unappliedSeededSourceFixes(m, '0.6.0', treeOf({ [CLIENT]: '// the credential is an httpOnly cookie\n' })).length,
    1,
  )
  assert.deepEqual(unappliedSeededSourceFixes(m, '0.6.0', treeOf({ [CLIENT]: FIXED_CLIENT })), [])
})

test('a malformed brokenWhen reads as NOT broken — check-seeded-migrations makes it unauthorable', () => {
  // The runtime must not guess in the broken direction: a parked obligation nobody can
  // clear is worse than a missed one the gate still reports.
  const m = {
    '0.6.0': {
      seededSourceFixes: [
        { gate: 'g', why: 'a long enough reason for the fixture to be shaped like the real thing.', paths: [CLIENT], probes: [{ path: CLIENT, brokenWhen: {} }] },
      ],
    },
  }
  assert.deepEqual(unappliedSeededSourceFixes(m, '0.6.0', treeOf({ [CLIENT]: BROKEN_CLIENT })), [])
})

test('applying parks a machine-readable file and NEVER writes a seeded source', () => {
  const dir = scratch()
  plant(dir, { [CLIENT]: BROKEN_CLIENT, [BARREL]: BROKEN_BARREL })
  const report = { notes: [] }

  const unapplied = applySeededSourceFixObligations({
    targetDir: dir,
    report,
    migrations: MIGRATIONS,
    version: '0.6.0',
    dryRun: false,
  })

  assert.equal(unapplied.length, 1)
  // THE BOUNDARY: both seeded sources are byte-identical afterwards.
  assert.equal(readFileSync(join(dir, CLIENT), 'utf8'), BROKEN_CLIENT)
  assert.equal(readFileSync(join(dir, BARREL), 'utf8'), BROKEN_BARREL)

  const parked = JSON.parse(readFileSync(join(dir, SOURCE_FIX_OBLIGATIONS_PATH), 'utf8'))
  assert.equal(parked.harnessVersion, '0.6.0')
  assert.equal(parked.fixes[0].since, '0.6.0')
  assert.equal(parked.fixes[0].gate, 'auth-posture')
  assert.deepEqual(parked.fixes[0].paths, [CLIENT, BARREL])
  // The parked artifact is (version, gate, why, paths, since) — the probes stay in the
  // template record; the TREE is the authority, never this file.
  assert.equal(parked.fixes[0].probes, undefined)
  assert.match(parked['//'], /instruction to a human/i)

  assert.equal(report.notes.length, 1)
  assert.match(report.notes[0], /SEEDED SOURCE FIX \(0\.6\.0 · gate auth-posture\)/)
  assert.match(report.notes[0], /docs\/runbooks\/harness-upgrade\.md/)
  assert.match(report.notes[0], /\.harness\/pending\/source-fixes\.json/)
})

test('a dry run writes nothing at all', () => {
  const dir = scratch()
  plant(dir, { [CLIENT]: BROKEN_CLIENT })
  applySeededSourceFixObligations({
    targetDir: dir,
    report: { notes: [] },
    migrations: MIGRATIONS,
    version: '0.6.0',
    dryRun: true,
  })
  assert.equal(existsSync(join(dir, SOURCE_FIX_OBLIGATIONS_PATH)), false)
})

test('the parked file SELF-CLEARS once the tree stops matching the broken shape', () => {
  const dir = scratch()
  plant(dir, { [CLIENT]: BROKEN_CLIENT, [BARREL]: BROKEN_BARREL })
  applySeededSourceFixObligations({
    targetDir: dir,
    report: { notes: [] },
    migrations: MIGRATIONS,
    version: '0.6.0',
    dryRun: false,
  })
  assert.equal(existsSync(join(dir, SOURCE_FIX_OBLIGATIONS_PATH)), true)

  plant(dir, { [CLIENT]: FIXED_CLIENT, [BARREL]: FIXED_BARREL })
  const report = { notes: [] }
  const unapplied = applySeededSourceFixObligations({
    targetDir: dir,
    report,
    migrations: MIGRATIONS,
    version: '0.6.0',
    dryRun: false,
  })
  assert.deepEqual(unapplied, [])
  assert.equal(existsSync(join(dir, SOURCE_FIX_OBLIGATIONS_PATH)), false)
  assert.deepEqual(report.notes, [])
})

test('the SHIPPED template/migrations.json 0.6.0 fix set carries probes that do not match the FIXED template', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const migrations = JSON.parse(readFileSync(join(root, 'template/migrations.json'), 'utf8'))
  const fixes = Object.entries(migrations)
    .filter(([v]) => /^\d+\.\d+\.\d+/.test(v))
    .flatMap(([, e]) => e.seededSourceFixes ?? [])
  assert.ok(fixes.length > 0, 'no seededSourceFixes record exists, so this test proves nothing')
  for (const fix of fixes) {
    assert.ok((fix.probes ?? []).length > 0, `shipped fix set (gate ${fix.gate}) carries no probes`)
  }
  // Evaluated over the real template tree: the template ships FIXED, so nothing is
  // unapplied — the probes describe the PRE-fix shape, not the current one.
  const readTemplate = (rel) => {
    for (const t of ['template/stack', 'template/base']) {
      const p = join(root, t, rel)
      if (existsSync(p)) return readFileSync(p, 'utf8')
    }
    return null
  }
  assert.deepEqual(unappliedSeededSourceFixes(migrations, '99.0.0', readTemplate), [])
})

// ── the wired channel: update parks it, doctor warns at exit 2, healing clears both ─────
//
// One end-to-end pass over a REAL scaffold, because the three surfaces must agree: the
// probes in the shipped record, `update`'s unconditional call, and `doctor`'s WARNING-level
// recomputation (exit 2 — the upgrade lane runs doctor before its sweep and permits only
// 0/2, so an error here would kill every pre-0.6.0 baseline leg; the gate itself owns the
// red). Same CLI harness as lifecycle.test.mjs, env scrubbed per the hook doctrine.
const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
/** @param {string[]} args */
function run(args) {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('on a real scaffold: broken shape → doctor warns (exit 2), update parks; healed → both clear', () => {
  const dir = scratch()
  const init = run(['init', '--dir', dir, '--yes',
    '--set', 'PROJECT_NAME=Fixture App',
    '--set', 'GITHUB_OWNER=fixture-owner',
    '--set', 'SECURITY_OWNERS=@fixture-owner/security'])
  assert.equal(init.code, 0, init.out)

  // A fresh scaffold ships FIXED: doctor is clean and nothing is parked.
  const clean = run(['doctor', '--dir', dir])
  assert.equal(clean.code, 0, clean.out)

  // Regress one seeded file to the pre-0.6.0 shape (no cookie-backed storage). Seeded
  // files are the consumer's, so neither doctor's drift loop nor update will touch it —
  // exactly why this channel exists.
  const clientPath = join(dir, CLIENT)
  const shipped = readFileSync(clientPath, 'utf8')
  writeFileSync(clientPath, BROKEN_CLIENT)

  // doctor recomputes from the TREE — no update has run, nothing is parked yet, and the
  // finding is a WARNING (exit 2), never an error: the auth-posture gate owns the red.
  const warned = run(['doctor', '--dir', dir])
  assert.equal(warned.code, 2, warned.out)
  assert.match(warned.out, /unapplied seeded source fix \(since 0\.6\.0, gate auth-posture\)/)
  assert.match(warned.out, /docs\/runbooks\/harness-upgrade\.md/)

  // update names the set and parks the machine-readable instruction.
  const updated = run(['update', '--dir', dir])
  assert.equal(updated.code, 0, updated.out)
  assert.match(updated.out, /SEEDED SOURCE FIX \(0\.6\.0 · gate auth-posture\)/)
  assert.equal(existsSync(join(dir, SOURCE_FIX_OBLIGATIONS_PATH)), true)

  // While parked, doctor keeps warning — but never as a parked UPGRADE awaiting a merge:
  // source-fixes.json is an obligation, not a parked file, same as dependencies.json.
  const parked = run(['doctor', '--dir', dir])
  assert.equal(parked.code, 2, parked.out)
  assert.ok(!parked.out.includes('parked upgrade awaiting merge: .harness/pending/source-fixes.json'), parked.out)

  // Heal the tree by hand (the consumer applies the fix): doctor self-clears the parked
  // artifact without another update and goes clean.
  writeFileSync(clientPath, shipped)
  const healed = run(['doctor', '--dir', dir])
  assert.equal(healed.code, 0, healed.out)
  assert.match(healed.out, /removing the stale \.harness\/pending\/source-fixes\.json/)
  assert.equal(existsSync(join(dir, SOURCE_FIX_OBLIGATIONS_PATH)), false)
})
