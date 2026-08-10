// The advisory turn lock's ONE blocking consumer (0.9.0): `installer update` refuses to
// start while a FRESH lock (<10 min) from a LIVE pid claims the tree. The Stop hook's
// outcome recorder writes .harness/turn.lock on every turn; an update sweeping the
// enforcement surface out from under a mid-turn session is exactly the interleaving the
// turn-ledger session scoping cannot repair — the session's next Stop judges files the
// sweep rewrote — so the sweep is the side that waits. A STALE lock (a crashed or
// long-idle session) and a DEAD pid are ignored with a note: a crashed session must not
// hold the tree hostage.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { update } from '../../installer/commands/update.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

const SETS = [
  '--set', 'PROJECT_NAME=Lock Fixture',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-turnlock-'))
  const res = spawnSync('node', [CLI, 'init', '--dir', dir, '--yes', ...SETS], { encoding: 'utf8' })
  assert.equal(res.status, 0, `init must succeed: ${res.stdout}${res.stderr}`)
  return dir
}

/** @param {string} dir @param {{ ageMs?: number, pid?: number, session?: string }} spec */
function plantLock(dir, { ageMs = 0, pid = process.pid, session = 'other-session' } = {}) {
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness', 'turn.lock'),
    `${JSON.stringify({ session_id: session, pid, at: new Date(Date.now() - ageMs).toISOString() })}\n`,
  )
}

/** Run the REAL update() capturing its report as JSON. */
async function runUpdate(dir, opts = {}) {
  const out = []
  const origLog = console.log
  console.log = (...args) => out.push(args.join(' '))
  let code
  try {
    code = await update({ dir, dryRun: false, report: 'json', ...opts })
  } finally {
    console.log = origLog
  }
  return { code, report: JSON.parse(out.join('\n')) }
}

test('update REFUSES to start while a fresh lock from a live pid claims the tree', async () => {
  const dir = initFixture()
  plantLock(dir) // fresh, this very process — alive by construction
  await assert.rejects(
    () => runUpdate(dir),
    (err) => {
      const message = String(/** @type {Error} */ (err).message)
      assert.match(message, /turn\.lock/)
      assert.match(message, /live/i)
      assert.match(message, /other-session/)
      return true
    },
  )
})

test('a STALE lock is ignored with a note; a DEAD pid likewise — a crashed session holds nothing', async () => {
  const stale = initFixture()
  plantLock(stale, { ageMs: 11 * 60 * 1000 })
  const r1 = await runUpdate(stale)
  assert.equal(r1.code, 0, JSON.stringify(r1.report))
  assert.ok(
    r1.report.notes.some((n) => /turn\.lock/.test(n) && /stale|dead/i.test(n)),
    `a skipped lock must be named, never silent: ${JSON.stringify(r1.report.notes)}`,
  )

  const dead = initFixture()
  plantLock(dead, { pid: 2 ** 30 })
  const r2 = await runUpdate(dead)
  assert.equal(r2.code, 0, JSON.stringify(r2.report))
  assert.ok(r2.report.notes.some((n) => /turn\.lock/.test(n)))
})

test('no lock at all is the ordinary state — no refusal, no note', async () => {
  const dir = initFixture()
  const r = await runUpdate(dir)
  assert.equal(r.code, 0, JSON.stringify(r.report))
  assert.ok(!r.report.notes.some((n) => /turn\.lock/.test(n)), JSON.stringify(r.report.notes))
})
