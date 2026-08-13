// The backup evidence lane (0.9.9) — the one control in this harness whose subject is NOT in
// the tree. Backups live in the platform's control plane, so the state can only be learned by
// asking over the network, and a check that resolves its answer from a live third-party
// endpoint may never ride `pnpm validate`.
//
// THIS FILE IS THE REASON THE LANE IS NOT DECORATION. The live query rides a scheduled,
// credential-gated job that skips on every machine without a token — including the harness's
// own CI, which has no Supabase project — so nothing in the ordinary run of things ever
// demonstrates it can go red. The judgement is therefore a pure function over RECORDED API
// responses, exercised here on every `pnpm test`, and the last test spawns the SHIPPED SCRIPT
// against a fixture so the lane itself is proven rather than just its library.
//
// THE TWO TESTS THAT MATTER MOST ARE THE ONES ASSERTING GREEN. Both encode a documented
// vendor behaviour that a naive control would red a CORRECT project over:
//   - PITR replaces daily backups entirely, so "has PITR AND has daily backups" is false of
//     every correctly configured project.
//   - An idle database produces no recent WAL backups, and its latest recovery point still
//     reflects the current state, so a recency bound would red a quiet, healthy project.
// SOURCE: https://supabase.com/docs/guides/platform/backups
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  judgeBackupPosture,
  postureShapeProblems,
} from '../../template/base/tools/lib/backup-posture.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHIPPED = join(ROOT, 'template/base/tools/backup-posture.json')
const SCRIPT = join(ROOT, 'template/base/tools/check-backup-posture.mjs')

const NOW = 1_760_000_000 // a fixed clock; the judgement never reads one of its own
const HOURS = (n) => NOW - n * 3600
const iso = (unix) => new Date(unix * 1000).toISOString()

const POSTURE = {
  owner: 'platform-team',
  maxDailyBackupAgeHours: 30,
  why: 'A day of writes is recoverable from the event log, so a missed daily backup is a next-morning problem rather than a page.',
}

/** A response in the exact shape the published 200 schema declares. */
const response = (over = {}) => ({
  region: 'ap-southeast-2',
  walg_enabled: true,
  pitr_enabled: false,
  backups: [{ id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: iso(HOURS(6)) }],
  physical_backup_data: {
    earliest_physical_backup_date_unix: HOURS(24 * 7),
    latest_physical_backup_date_unix: HOURS(6),
  },
  ...over,
})

const judge = (over, posture = POSTURE) =>
  judgeBackupPosture({ response: response(over), posture, nowUnix: NOW })

// ---- the assertions that must stay GREEN on a correct project -------------------------
test('PITR enabled with NO daily backups is correct, not broken — the OR, never the AND', () => {
  // "If you enable PITR, we will no longer take Daily Backups." An AND here would red every
  // correctly configured PITR project, which is the failure this test exists to prevent.
  const { problems, notes } = judge({ pitr_enabled: true, backups: [] })
  assert.deepEqual(problems, [])
  assert.match(notes.join(' '), /PITR is enabled/)
})

test('an IDLE PITR project with a very old latest recovery point stays green', () => {
  // "when the database has no activity, we do not make WAL file backups", and the latest
  // restore point "could be significantly behind the current time" while still reflecting
  // the current state. A recency bound would red a quiet, healthy project.
  const { problems, notes } = judge({
    pitr_enabled: true,
    backups: [],
    physical_backup_data: {
      earliest_physical_backup_date_unix: HOURS(24 * 30),
      latest_physical_backup_date_unix: HOURS(24 * 21),
    },
  })
  assert.deepEqual(problems, [])
  assert.match(notes.join(' '), /Recency is deliberately NOT asserted/)
})

test('PITR off with a recent completed daily backup is green', () => {
  const { problems, notes } = judge({})
  assert.deepEqual(problems, [])
  assert.match(notes.join(' '), /PITR is OFF/)
})

test('FAILED and PENDING rows alongside a good one do not red — only the newest COMPLETED counts', () => {
  const { problems } = judge({
    backups: [
      { id: 3, is_physical_backup: true, status: 'FAILED', inserted_at: iso(HOURS(1)) },
      { id: 2, is_physical_backup: true, status: 'PENDING', inserted_at: iso(HOURS(2)) },
      { id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: iso(HOURS(6)) },
    ],
  })
  assert.deepEqual(problems, [])
})

// ---- the assertions that must go RED ---------------------------------------------------
test('no PITR and no completed backup reds — there is no recovery mechanism at all', () => {
  const { problems } = judge({ pitr_enabled: false, backups: [] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /NEITHER Point-in-Time Recovery .* NOR any COMPLETED backup/)
})

test('a FAILED-only backup list is not a recovery mechanism', () => {
  const { problems } = judge({
    backups: [{ id: 1, is_physical_backup: true, status: 'FAILED', inserted_at: iso(HOURS(2)) }],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no recovery mechanism at all/)
})

test('a daily backup past the operator’s own tolerance reds, naming both numbers', () => {
  const { problems } = judge({
    backups: [
      { id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: iso(HOURS(50)) },
    ],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /50\.0 hours old, past the 30-hour tolerance/)
})

test('the tolerance is judged at its edge, not approximately', () => {
  const at = (h) =>
    judge({
      backups: [
        { id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: iso(HOURS(h)) },
      ],
    }).problems
  assert.deepEqual(at(30), [], 'exactly at the tolerance is inside it')
  assert.equal(at(31).length, 1)
})

// ---- anti-vacuity: the shape must be the shape the schema promises ---------------------
test('a missing required field reds rather than judging nothing', () => {
  for (const field of ['region', 'walg_enabled', 'pitr_enabled', 'backups', 'physical_backup_data']) {
    const r = response()
    delete r[field]
    const { problems } = judgeBackupPosture({ response: r, posture: POSTURE, nowUnix: NOW })
    assert.equal(problems.length, 1, `expected a red for missing ${field}`)
    assert.match(problems[0], /pass vacuously/)
  }
})

test('an empty response reds — "I could not see anything" is not "correctly configured"', () => {
  const { problems } = judgeBackupPosture({ response: {}, posture: POSTURE, nowUnix: NOW })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /missing required field/)
})

test('a status outside the published enum reds rather than counting as a good backup', () => {
  const { problems } = judge({
    backups: [{ id: 1, is_physical_backup: true, status: 'SORT_OF_OK', inserted_at: iso(NOW) }],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /outside the published enum/)
})

test('a non-array backups field reds — the shape has changed under the lane', () => {
  const { problems } = judge({ backups: 'none' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /non-array `backups`/)
})

// ---- the two guards that stop a CORRECT project redding --------------------------------
test('a project mid-RESTORE asserts nothing — the lane must not fire while a restore runs', () => {
  // The sharpest case in the whole lane: failing a project *because it is being restored*
  // would mean firing at the exact moment the operator is using what this exists to protect.
  const { problems, notes } = judgeBackupPosture({
    response: response({ pitr_enabled: false, backups: [] }),
    project: { status: 'RESTORING', created_at: new Date((NOW - 86_400 * 90) * 1000).toISOString() },
    posture: POSTURE,
    nowUnix: NOW,
  })
  assert.deepEqual(problems, [])
  assert.match(notes.join(' '), /status RESTORING/)
})

test('every unsettled status asserts nothing, and settled ones still judge', () => {
  const at = (status) =>
    judgeBackupPosture({
      response: response({ pitr_enabled: false, backups: [] }),
      project: { status, created_at: new Date((NOW - 86_400 * 90) * 1000).toISOString() },
      posture: POSTURE,
      nowUnix: NOW,
    }).problems
  for (const s of ['RESTORING', 'PAUSING', 'RESIZING', 'COMING_UP', 'INACTIVE', 'UPGRADING']) {
    assert.deepEqual(at(s), [], `${s} must assert nothing`)
  }
  for (const s of ['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY']) {
    assert.equal(at(s).length, 1, `${s} is settled and must still be judged`)
  }
})

test('a project younger than the operator’s own tolerance asserts nothing', () => {
  // It reuses THEIR number and invents none: the harness has no opinion about how new is too
  // new. A project created two hours ago has not missed a daily backup.
  const { problems, notes } = judgeBackupPosture({
    response: response({ pitr_enabled: false, backups: [] }),
    project: {
      status: 'ACTIVE_HEALTHY',
      created_at: new Date((NOW - 2 * 3600) * 1000).toISOString(),
    },
    posture: POSTURE,
    nowUnix: NOW,
  })
  assert.deepEqual(problems, [])
  assert.match(notes.join(' '), /younger than its own backup window/)
})

test('a project OLDER than the tolerance is judged normally — the guard is not an escape', () => {
  const { problems } = judgeBackupPosture({
    response: response({ pitr_enabled: false, backups: [] }),
    project: {
      status: 'ACTIVE_HEALTHY',
      created_at: new Date((NOW - 100 * 3600) * 1000).toISOString(),
    },
    posture: POSTURE,
    nowUnix: NOW,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no recovery mechanism at all/)
})

test('with NO project envelope the guards are inert and the judgement still runs', () => {
  const { problems } = judgeBackupPosture({
    response: response({ pitr_enabled: false, backups: [] }),
    project: null,
    posture: POSTURE,
    nowUnix: NOW,
  })
  assert.equal(problems.length, 1)
})

// ---- an unreadable timestamp is a SHAPE problem, not a missing backup -------------------
test('an unparseable inserted_at reds as a SHAPE problem, not as "no recovery mechanism"', () => {
  // Dropping the row instead would empty the newest-completed search and red the project for
  // having no backups at all: the right verdict for entirely the wrong reason.
  const { problems } = judge({
    backups: [{ id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: 'yesterday' }],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cannot read as an unambiguous instant/)
  // Narrowed to the EXISTENCE failure's own opening words: the shape message deliberately
  // quotes the phrase "no recovery mechanism at all" while explaining the mistake it avoids,
  // so searching for that phrase alone would match the very message being distinguished.
  assert.doesNotMatch(problems[0], /this project has NEITHER/)
})

test('an offset-less timestamp reds too — JS would read it as LOCAL time', () => {
  // The published schema types inserted_at as a bare string with no format and no pattern, so
  // nothing guarantees a zone; without one the age is wrong by up to fourteen hours depending
  // on where the runner is.
  const { problems } = judge({
    backups: [
      { id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: '2026-08-12T04:00:00' },
    ],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unambiguous instant/)
})

test('a +HH:MM offset is accepted — only ambiguity is refused, not non-Z zones', () => {
  const { problems } = judge({
    backups: [
      {
        id: 1,
        is_physical_backup: true,
        status: 'COMPLETED',
        inserted_at: new Date(HOURS(6) * 1000).toISOString().replace('Z', '+00:00'),
      },
    ],
  })
  assert.deepEqual(problems, [])
})

test('an unreadable timestamp on a NON-completed row is ignored — only good rows are read', () => {
  const { problems } = judge({
    backups: [
      { id: 2, is_physical_backup: true, status: 'FAILED', inserted_at: 'whenever' },
      { id: 1, is_physical_backup: true, status: 'COMPLETED', inserted_at: iso(HOURS(6)) },
    ],
  })
  assert.deepEqual(problems, [])
})

// ---- the posture file's own shape ------------------------------------------------------
test('a null tolerance reds — the harness supplies no default on purpose', () => {
  const problems = postureShapeProblems({ ...POSTURE, maxDailyBackupAgeHours: null }, 'p.json')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must be a positive number/)
  assert.match(problems[0], /business criticality/)
})

test('a zero or negative tolerance reds', () => {
  assert.equal(postureShapeProblems({ ...POSTURE, maxDailyBackupAgeHours: 0 }, 'p').length, 1)
  assert.equal(postureShapeProblems({ ...POSTURE, maxDailyBackupAgeHours: -4 }, 'p').length, 1)
})

test('an unexplained tolerance reds — a number with no reasoning is not a determination', () => {
  const problems = postureShapeProblems({ ...POSTURE, why: 'because' }, 'p.json')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /business criticality produced that number/)
})

test('an unowned posture reds — a backup requirement nobody holds is answered by nobody', () => {
  const problems = postureShapeProblems({ ...POSTURE, owner: '  ' }, 'p.json')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must name who holds this posture/)
})

// ---- the SHIPPED posture ---------------------------------------------------------------
test('the shipped posture ships the tolerance UNSET, and says so', () => {
  const shipped = JSON.parse(readFileSync(SHIPPED, 'utf8'))
  assert.equal(shipped.maxDailyBackupAgeHours, null, 'a shipped number would be a harness default')
  // It must still red when actually used, so the operator cannot ignore it into production.
  assert.equal(postureShapeProblems(shipped, SHIPPED).length, 1)
  assert.ok(shipped.owner.length > 0)
  assert.equal(shipped.restorationTesting.lastTestedOn, null)
  assert.match(shipped.restorationTesting.whyThisIsNotAutomated, /destructive|no Management API path/)
})

// ---- the LANE's own red-proof: the shipped script, driven to a failure ------------------
test('the shipped script reds on a recorded response with no recovery mechanism', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-posture-'))
  const posturePath = join(dir, 'backup-posture.json')
  const fixturePath = join(dir, 'response.json')
  writeFileSync(posturePath, JSON.stringify(POSTURE))
  writeFileSync(fixturePath, JSON.stringify(response({ pitr_enabled: false, backups: [] })))

  const red = spawnSync(
    process.execPath,
    [SCRIPT, `--posture=${posturePath}`, `--fixture=${fixturePath}`, `--now=${String(NOW)}`],
    { encoding: 'utf8', env: { ...process.env, SUPABASE_ACCESS_TOKEN: '', CI: '' } },
  )
  assert.equal(red.status, 1, `expected a red, got ${String(red.status)}: ${red.stdout}${red.stderr}`)
  assert.match(red.stderr, /backup-posture: FAIL \(1\)/)
  assert.match(red.stderr, /no recovery mechanism at all/)
  // The failure hint must name the ceiling rather than implying a restore was tested.
  assert.match(red.stderr, /It cannot test a restore/)
})

test('the shipped script GREENS on a recorded PITR response — and never calls the network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-posture-'))
  const posturePath = join(dir, 'backup-posture.json')
  const fixturePath = join(dir, 'response.json')
  writeFileSync(posturePath, JSON.stringify(POSTURE))
  writeFileSync(fixturePath, JSON.stringify(response({ pitr_enabled: true, backups: [] })))

  const green = spawnSync(
    process.execPath,
    [SCRIPT, `--posture=${posturePath}`, `--fixture=${fixturePath}`, `--now=${String(NOW)}`],
    { encoding: 'utf8', env: { ...process.env, SUPABASE_ACCESS_TOKEN: '', CI: '' } },
  )
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`)
  assert.match(green.stdout, /Point-in-Time Recovery/)
})

test('an unconfigured tree SKIPS loudly, and the skip states what is not being proven', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-posture-'))
  const posturePath = join(dir, 'backup-posture.json')
  writeFileSync(posturePath, JSON.stringify(POSTURE))

  const skipped = spawnSync(process.execPath, [SCRIPT, `--posture=${posturePath}`], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: '', SUPABASE_PROJECT_REF: '' },
  })
  assert.equal(skipped.status, 0, `${skipped.stdout}${skipped.stderr}`)
  assert.match(skipped.stdout, /SKIPPED/)
  // A silent skip would read as evidence. It must say that it is not.
  assert.match(skipped.stdout, /NO backup evidence is being produced/)
})

test('HARNESS_REQUIRE_BACKUP_EVIDENCE=1 turns the skip into a failure — the operator’s opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-posture-'))
  const posturePath = join(dir, 'backup-posture.json')
  writeFileSync(posturePath, JSON.stringify(POSTURE))

  const red = spawnSync(process.execPath, [SCRIPT, `--posture=${posturePath}`], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      SUPABASE_ACCESS_TOKEN: '',
      SUPABASE_PROJECT_REF: '',
      HARNESS_REQUIRE_BACKUP_EVIDENCE: '1',
    },
  })
  assert.equal(red.status, 1, `${red.stdout}${red.stderr}`)
  assert.match(red.stderr, /makes this binding/)
})
