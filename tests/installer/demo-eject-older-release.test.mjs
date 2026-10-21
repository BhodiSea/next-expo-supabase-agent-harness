// `eject` on an install made by an EARLIER release (2.0.4). Most of the worked example is
// seeded, so `update` leaves an untouched demo file at the bytes the install's own release
// wrote. Eject used to compare a seeded file only with its own release's demo bytes, so every
// demo file a later release changed read as a "re-recorded fork" and was kept. The released
// tables' `demo` map (template/shas/<version>.json) is what lets it tell the two apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eject } from '../../installer/commands/eject.mjs'
import { renderEntry, walkTemplate } from '../../installer/lib/copy.mjs'
import { fileMode } from '../../installer/lib/manifest.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI = join(ROOT, 'installer/cli.mjs')
const SETS = ['--set', 'PROJECT_NAME=Fixture App', '--set', 'GITHUB_OWNER=fixture-owner', '--set', 'SECURITY_OWNERS=@fixture-owner/security']

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** @param {string} cli @param {string[]} args */
function run(cli, args) {
  const res = spawnSync('node', [cli, ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const made = []
/** @param {string} tag */
function tmp(tag) {
  const dir = mkdtempSync(join(tmpdir(), `epah-demo-older-${tag}-`))
  made.push(dir)
  return dir
}
test.after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const defaults = new Map([...walkTemplate('base'), ...walkTemplate('stack')].map((e) => [e.installPath, e]))
const seededDemo = walkTemplate('demo').filter((e) => fileMode(e.installPath) !== 'owned' && /\.(ts|tsx)$/.test(e.installPath))
const demoOnly = seededDemo.filter((e) => !defaults.has(e.installPath)).map((e) => e.installPath)
const shared = seededDemo.filter((e) => defaults.has(e.installPath)).map((e) => e.installPath)

/** @param {string} dir */
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))

/**
 * Put `bytes` on disk at `ip` and record them, as the install's own (earlier) release did.
 *
 * @param {string} dir @param {string} ip @param {string} bytes
 */
function asEarlierRelease(dir, ip, bytes) {
  writeFileSync(join(dir, ip), bytes)
  const m = manifestOf(dir)
  m.files[ip] = { ...m.files[ip], sha256: sha256(bytes) }
  writeFileSync(join(dir, '.harness/manifest.json'), `${JSON.stringify(m, null, 2)}\n`)
}

/** @param {() => Promise<number>} fn */
async function quietly(fn) {
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.error = error
  }
}

test("eject removes an untouched demo file an earlier release shipped, and restores the default over a shared one", async () => {
  const dir = tmp('injected')
  assert.equal(run(CLI, ['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', ...SETS]).code, 0)
  const [older, forked, newer] = demoOnly
  const sharedOlder = shared[0]
  assert.ok(older && forked && newer && sharedOlder, 'the demo tree ships too few seeded code files for this test')

  const earlier = (ip) => `${readFileSync(join(dir, ip), 'utf8')}\n// as an earlier release shipped it\n`
  const olderBytes = earlier(older)
  const sharedBytes = earlier(sharedOlder)
  const forkBytes = `${readFileSync(join(dir, forked), 'utf8')}\n// a fork the project re-recorded\n`
  const newerBytes = earlier(newer)
  asEarlierRelease(dir, older, olderBytes)
  asEarlierRelease(dir, sharedOlder, sharedBytes)
  asEarlierRelease(dir, forked, forkBytes)
  asEarlierRelease(dir, newer, newerBytes)

  const releasedDemo = {
    '2.0.2': { [older]: [{ sha256: sha256(olderBytes) }], [sharedOlder]: [{ sha256: sha256(sharedBytes) }] },
    // A table newer than the running installer cannot have shipped with it: it vouches for nothing.
    '99.0.0': { [newer]: [{ sha256: sha256(newerBytes) }] },
  }
  const code = await quietly(() => eject({ dir, report: 'json' }, { releasedDemo }))
  assert.equal(code, 2, 'the fork and the file only a future table names are kept, so eject exits 2')

  assert.ok(!existsSync(join(dir, older)), `eject kept ${older}, which an earlier release shipped untouched`)
  const restored = renderEntry(defaults.get(sharedOlder), { DESIGN_TOKENS: 'default', ...manifestOf(dir).answers })
  assert.equal(readFileSync(join(dir, sharedOlder), 'utf8'), String(restored), `eject did not restore the default over ${sharedOlder}`)
  assert.ok(!existsSync(join(dir, '.harness/pending', sharedOlder)), 'an untouched shared file is restored, not parked')
  assert.equal(readFileSync(join(dir, forked), 'utf8'), forkBytes, 'a re-recorded fork no release shipped is still kept')
  assert.equal(readFileSync(join(dir, newer), 'utf8'), newerBytes, 'a table newer than the installer must vouch for nothing')
})

/** The newest release tag older than this tree's version that ships a demo, or null. */
function earlierDemoTag() {
  try {
    const tags = execFileSync('git', ['tag', '--list', 'v2.*.*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    return tags.includes('v2.0.2') ? 'v2.0.2' : null
  } catch {
    return null
  }
}

test('an untouched v2.0.2 --with-demo install, updated with this tree, ejects with no demo file kept', (t) => {
  const tag = earlierDemoTag()
  if (tag === null) {
    t.skip('SKIP: no v2.0.2 tag in this clone (a shallow checkout); the injected-table test above still runs')
    return
  }
  const old = tmp('tag-cli')
  const tar = execFileSync('git', ['archive', '--format=tar', tag, 'installer', 'template', 'package.json'], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 })
  assert.equal(spawnSync('tar', ['-x', '-C', old], { input: tar }).status, 0)

  const dir = tmp('tag-install')
  const init = run(join(old, 'installer/cli.mjs'), ['init', '--dir', dir, '--tier', 'core', '--yes', '--with-demo', ...SETS])
  assert.equal(init.code, 0, init.out)
  const update = run(CLI, ['update', '--dir', dir])
  assert.equal(update.code, 0, update.out)

  const r = run(CLI, ['eject', '--dir', dir])
  const demoPaths = new Set(walkTemplate('demo').map((e) => e.installPath))
  const kept = r.out
    .split('\n')
    .map((line) => /^\s*(?:CONFLICT|DRIFT) (\S+?):/.exec(line)?.[1])
    .filter((ip) => ip !== undefined && demoPaths.has(ip))
  assert.deepEqual(kept, [], `eject kept untouched ${tag} demo files:\n${r.out}`)
  assert.equal(r.code, 0, r.out)
  for (const ip of demoPaths) {
    if (!defaults.has(ip)) assert.ok(!existsSync(join(dir, ip)), `eject left ${ip}`)
  }
})
