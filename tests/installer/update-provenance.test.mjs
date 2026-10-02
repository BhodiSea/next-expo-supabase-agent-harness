// `update` NEVER OVERWRITES A RE-RECORDED FORK (1.0.2) — the policy, end to end, in process.
//
// Until 1.0.2 "the bytes match the manifest record" was read as "the harness wrote them".
// A consumer who forks an owned file re-records its sha — it is the only way to keep their
// own `gate-integrity` green — so every deliberate fork was overwritten by the next
// `update`, deleted by `disable` or by a `removed` migration, and the installer did the
// same to bytes it had recorded itself (a retrofit-merged settings file). Each case below
// injects the released-sha tables (`releasedShas`), because the difference between "aged
// by an older release" and "forked" is exactly whether a release shipped the bytes, and a
// test has to be able to say which one it means.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { doctor } from '../../installer/commands/doctor.mjs'
import { enable } from '../../installer/commands/enable.mjs'
import { init } from '../../installer/commands/init.mjs'
import { planTree } from '../../installer/lib/copy.mjs'
import { fileMode, sha256 } from '../../installer/lib/manifest.mjs'
import { render, tokenSites } from '../../installer/lib/placeholders.mjs'
import {
  VERSION,
  captureUpdate,
  captured,
  freshInstall,
  liveOwned,
  manifestOf,
  parseReport,
  recordBytes,
  tablesWith,
  writeManifestOf,
} from './helpers/provenance-fixture.mjs'

const HOOK = '.claude/hooks/posttool-fast-check.mjs'
const FORK = '#!/usr/bin/env node\n// the consumer forked this file on purpose\n'
const AGED = '#!/usr/bin/env node\n// bytes an earlier commit of this release shipped\n'
const EARLIER = [{ sha256: sha256(AGED) }]

/** @param {string} dir @param {string} ip */
const read = (dir, ip) => readFileSync(join(dir, ip), 'utf8')

test('bytes a release SHIPPED refresh in place — "aged" now has to mean it', async () => {
  const dir = await freshInstall('epah-prov-aged-')
  recordBytes(dir, HOOK, AGED)
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tablesWith({ [HOOK]: EARLIER }) })
  assert.equal(res.code, 0, res.out)
  const report = parseReport(res.out)
  assert.ok(report.written.includes(HOOK), 'a released sha is pristine: refreshed')
  assert.notEqual(read(dir, HOOK), AGED)
  assert.equal(manifestOf(dir).files[HOOK].sha256, sha256(read(dir, HOOK)), 'the refresh is re-recorded')
})

test('a re-recorded FORK is parked when upstream changed the file: bytes intact, exit 2, DRIFT + note', async () => {
  const dir = await freshInstall('epah-prov-fork-')
  const forkSha = recordBytes(dir, HOOK, FORK)
  // Two variants in range: upstream changed this file since the install's version.
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tablesWith({ [HOOK]: EARLIER }) })
  assert.equal(res.code, 2, res.out)
  const report = parseReport(res.out)
  assert.equal(read(dir, HOOK), FORK, 'the fork must survive')
  assert.ok(!report.written.includes(HOOK), 'a fork is never reported as written')
  assert.deepEqual(
    report.drift.filter((d) => d.path === HOOK).map((d) => d.path),
    [HOOK],
  )
  assert.ok(existsSync(join(dir, '.harness', 'pending', HOOK)), 'the incoming version is parked')
  assert.notEqual(read(dir, join('.harness', 'pending', HOOK)), FORK)
  assert.ok(
    report.notes.some((n) => n.includes(HOOK) && n.includes('matches no release')),
    report.notes.join('\n'),
  )
  assert.equal(manifestOf(dir).files[HOOK].sha256, forkSha, 'a park never re-records')
})

test('a fork costs NOTHING when upstream has not touched the file: kept, skipped, one note, exit 0', async () => {
  const dir = await freshInstall('epah-prov-kept-')
  recordBytes(dir, HOOK, FORK)
  const other = 'tools/validate.mjs'
  recordBytes(dir, other, '// a second fork\n')
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tablesWith() })
  assert.equal(res.code, 0, `nothing new to merge must not cost exit 2:\n${res.out}`)
  const report = parseReport(res.out)
  assert.equal(read(dir, HOOK), FORK)
  assert.ok(report.skipped.includes(HOOK) && report.skipped.includes(other))
  assert.deepEqual(report.drift, [])
  assert.ok(!existsSync(join(dir, '.harness', 'pending')), 'nothing is parked')
  const kept = report.notes.filter((n) => n.includes('local fork(s) kept'))
  assert.equal(kept.length, 1, 'ONE aggregate note, not one per file')
  assert.ok(kept[0].includes('2 local fork(s)') && kept[0].includes(HOOK) && kept[0].includes(other), kept[0])
})

test('--force still means "discard my fork"', async () => {
  const dir = await freshInstall('epah-prov-force-')
  recordBytes(dir, HOOK, FORK)
  const res = await captureUpdate({ dir, force: true, report: 'json' }, { releasedShas: tablesWith() })
  assert.equal(res.code, 0, res.out)
  const report = parseReport(res.out)
  assert.ok(report.written.includes(HOOK))
  assert.notEqual(read(dir, HOOK), FORK)
  assert.ok(report.notes.some((n) => n.includes(`--force overwrote locally-modified ${HOOK}`)))
})

test('a pin BACK to an older release parks — and the note says what it is, not "no release shipped this"', async () => {
  const dir = await freshInstall('epah-prov-pin-')
  recordBytes(dir, HOOK, AGED)
  const tables = { '0.0.1': { [HOOK]: EARLIER }, ...tablesWith({ [HOOK]: [{ sha256: sha256('an earlier variant\n') }] }) }
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables })
  assert.equal(res.code, 2, res.out)
  assert.equal(read(dir, HOOK), AGED)
  const note = parseReport(res.out).notes.find((n) => n.includes(HOOK)) ?? ''
  assert.match(note, /matches release 0\.0\.1, older than this install/)
  assert.ok(!note.includes('matches no release'), note)
})

test('NO table for the install\'s version: the pre-1.0.2 behaviour, and exactly one note saying so', async () => {
  const dir = await freshInstall('epah-prov-notable-')
  recordBytes(dir, HOOK, AGED)
  recordBytes(dir, 'tools/validate.mjs', '// aged too\n')
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: {} })
  assert.equal(res.code, 0, res.out)
  const report = parseReport(res.out)
  assert.ok(report.written.includes(HOOK) && report.written.includes('tools/validate.mjs'))
  const notes = report.notes.filter((n) => n.includes('provenance unverifiable'))
  assert.equal(notes.length, 1, report.notes.join('\n'))
  assert.match(notes[0], /2 harness-owned file\(s\)/)
})

test('a PLACEHOLDER-bearing fork parks while its pristine twin — aged by a release — refreshes', async () => {
  const dir = await freshInstall('epah-prov-tokens-')
  const answers = manifestOf(dir).answers
  const live = liveOwned()
  const [agedPath, forkPath] = Object.keys(live).filter((p) => live[p][0].sites && existsSync(join(dir, p)))
  assert.ok(agedPath && forkPath, 'fixture precondition: two installed owned placeholder files')

  // The twin an older commit of this release shipped: same tokens, one more line of source.
  const agedSource = `${derenderedSource(dir, agedPath, answers)}\n# a line an earlier commit shipped\n`
  recordBytes(dir, agedPath, render(agedSource, answers))
  // The fork: the consumer's edit to the RENDERED file, re-recorded.
  const forked = `${read(dir, forkPath)}\n# the consumer's own line\n`
  recordBytes(dir, forkPath, forked)

  const tables = tablesWith({
    [agedPath]: [{ sha256: sha256(agedSource), sites: tokenSites(agedSource) }],
    [forkPath]: [{ sha256: sha256('an earlier variant of the fork path\n') }],
  })
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables })
  const report = parseReport(res.out)
  assert.ok(report.written.includes(agedPath), `the released twin must refresh:\n${res.out}`)
  assert.equal(read(dir, forkPath), forked, 'the fork must survive')
  assert.ok(report.drift.some((d) => d.path === forkPath))
  assert.equal(res.code, 2)
})

/** The template source of an installed placeholder file, rebuilt from the live table's sites. */
/** @param {string} dir @param {string} ip @param {Record<string, string>} answers */
function derenderedSource(dir, ip, answers) {
  let text = read(dir, ip)
  // Tokens are rendered with the fixture's answers; walk the live sites right-to-left so
  // earlier offsets stay valid while the text changes length.
  const rendered = liveOwned()[ip][0].sites ?? []
  let shift = 0
  const positions = rendered.map(([offset, token]) => {
    const at = offset + shift
    shift += String(answers[token] ?? `{{${token}}}`).length - `{{${token}}}`.length
    return /** @type {[number, string]} */ ([at, token])
  })
  for (const [at, token] of positions.reverse()) {
    const value = String(answers[token] ?? `{{${token}}}`)
    text = `${text.slice(0, at)}{{${token}}}${text.slice(at + value.length)}`
  }
  return text
}

test('tsconfig.json is DERIVED at plan time: a second hop refreshes it instead of calling it a fork', async () => {
  const dir = await freshInstall('epah-prov-tsconfig-')
  // What init/update leave behind when they inject or prune project references: bytes no
  // release shipped, recorded by the installer itself.
  recordBytes(dir, 'tsconfig.json', `${read(dir, 'tsconfig.json')}\n// references derived at plan time\n`)
  const tables = tablesWith({ 'tsconfig.json': [{ sha256: sha256('an earlier variant\n') }] })
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables })
  assert.equal(res.code, 0, res.out)
  assert.ok(parseReport(res.out).written.includes('tsconfig.json'))
})

test('dry-run reports EXACTLY the plan the real run applies when a fork parks — and lists paths in human mode', async () => {
  const dir = await freshInstall('epah-prov-dry-')
  recordBytes(dir, HOOK, FORK)
  recordBytes(dir, 'tools/validate.mjs', AGED)
  const releasedShas = tablesWith({ [HOOK]: EARLIER, 'tools/validate.mjs': EARLIER })

  const human = await captureUpdate({ dir, dryRun: true }, { releasedShas })
  assert.match(human.out, / {4}would write tools\/validate\.mjs/)
  assert.match(human.out, new RegExp(`DRIFT ${HOOK.replaceAll('.', '\\.')}`))

  const dry = await captureUpdate({ dir, dryRun: true, report: 'json' }, { releasedShas })
  assert.ok(!existsSync(join(dir, '.harness', 'pending')), 'dry-run must not park anything')
  assert.equal(read(dir, 'tools/validate.mjs'), AGED, 'dry-run must not write anything')
  const real = await captureUpdate({ dir, report: 'json' }, { releasedShas })
  assert.deepEqual(parseReport(dry.out), parseReport(real.out))
  assert.equal(dry.code, real.code)
})

test('a `removed` migration deletes what a release shipped and LEAVES a fork in place, record kept', async () => {
  const dir = await freshInstall('epah-prov-removed-')
  mkdirSync(join(dir, 'tools'), { recursive: true })
  const shipped = '// what 1.0.1 shipped at this path\n'
  recordBytes(dir, 'tools/retired-pristine.mjs', shipped)
  recordBytes(dir, 'tools/retired-forked.mjs', '// the consumer kept and changed this one\n')
  const manifest = manifestOf(dir)
  manifest.harnessVersion = '0.0.9'
  writeManifestOf(dir, manifest)

  const retired = { 'tools/retired-pristine.mjs': [{ sha256: sha256(shipped) }], 'tools/retired-forked.mjs': [{ sha256: sha256(shipped) }] }
  const tables = { '0.0.9': { ...liveOwned(), ...retired }, ...tablesWith() }
  const migrations = { [VERSION]: { removed: ['tools/retired-pristine.mjs', 'tools/retired-forked.mjs'] } }
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables, migrations })
  const report = parseReport(res.out)
  assert.ok(!existsSync(join(dir, 'tools/retired-pristine.mjs')), 'bytes a release shipped are removed')
  assert.ok(existsSync(join(dir, 'tools/retired-forked.mjs')), 'a fork is never deleted')
  assert.ok(
    report.notes.some((n) => n.includes('tools/retired-forked.mjs') && n.includes('a local fork, left in place')),
    report.notes.join('\n'),
  )
  assert.ok(manifestOf(dir).files['tools/retired-forked.mjs'], 'its record is kept, so doctor keeps naming it')
})

test('`--refresh-seeded <owned fork>` parks: a path asked for by name always gets the template copy', async () => {
  const dir = await freshInstall('epah-prov-refresh-')
  recordBytes(dir, HOOK, FORK)
  const res = await captureUpdate({ dir, refreshSeeded: [HOOK], report: 'json' }, { releasedShas: tablesWith() })
  assert.equal(res.code, 2, res.out)
  assert.equal(read(dir, HOOK), FORK)
  assert.ok(existsSync(join(dir, '.harness', 'pending', HOOK)))
})

test('`--refresh-seeded` on a SEEDED path is untouched by provenance — no verdict, no "unverifiable" noise', async () => {
  const dir = await freshInstall('epah-prov-seeded-')
  const seeded = 'tools/eol.json'
  const aged = '{ "an older seeded register": true }\n'
  recordBytes(dir, seeded, aged)
  const manifest = manifestOf(dir)
  manifest.files[seeded].mode = 'seeded'
  writeManifestOf(dir, manifest)
  const res = await captureUpdate({ dir, refreshSeeded: [seeded], report: 'json' }, { releasedShas: tablesWith() })
  assert.equal(res.code, 0, res.out)
  const report = parseReport(res.out)
  assert.ok(report.written.includes(seeded))
  assert.ok(!report.notes.some((n) => n.includes('provenance')), report.notes.join('\n'))
})

test('`enable` parks a forked owned module file and `disable` keeps it', async () => {
  const dir = await freshInstall('epah-prov-module-')
  const releasedShas = tablesWith()
  const module = 'observability'
  assert.equal((await captured(() => enable({ dir }, module, true, { releasedShas }))).result, 0)
  const owned = Object.entries(manifestOf(dir).files)
    .filter(([, meta]) => meta.module === module && meta.mode === 'owned')
    .map(([ip]) => ip)
    .sort()
  assert.ok(owned.length > 0, `fixture precondition: the ${module} module installs at least one owned file`)
  const [forkedPath] = owned
  recordBytes(dir, forkedPath, '# the consumer forked this module file\n')

  const again = await captured(() => enable({ dir }, module, true, { releasedShas }))
  assert.equal(read(dir, forkedPath), '# the consumer forked this module file\n', 're-enable must not clobber the fork')
  assert.ok(existsSync(join(dir, '.harness', 'pending', forkedPath)), again.out)

  await captured(() => enable({ dir }, module, false, { releasedShas }))
  assert.ok(existsSync(join(dir, forkedPath)), 'disable deleted a re-recorded fork')
  for (const ip of owned.slice(1)) assert.ok(!existsSync(join(dir, ip)), `${ip} is pristine and must go`)
})

test('retrofit-MERGED settings are the installer\'s own non-release sha: the next update keeps them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-prov-retrofit-'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'their-app', version: '1.0.0', private: true })}\n`)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(dir, 'apps/web'), { recursive: true })
  writeFileSync(join(dir, 'apps/web/package.json'), '{"name":"web"}\n')
  writeFileSync(join(dir, 'apps/web/next.config.ts'), 'export default {}\n')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude/settings.json'), `${JSON.stringify({ env: { THEIR_SETTING: '1' } }, null, 2)}\n`)
  const set = ['PROJECT_NAME=Their App', 'GITHUB_OWNER=o', 'SECURITY_OWNERS=@o/sec']
  const initCode = (await captured(() => init({ dir, yes: true, tier: 'core', set }))).result
  assert.ok([0, 2].includes(initCode))
  const merged = read(dir, '.claude/settings.json')
  assert.ok(merged.includes('THEIR_SETTING'), 'fixture precondition: init merged their settings')
  assert.equal(manifestOf(dir).files['.claude/settings.json'].mode, 'owned')

  await captureUpdate({ dir, report: 'json' }, { releasedShas: tablesWith() })
  assert.equal(read(dir, '.claude/settings.json'), merged, 'update overwrote the settings it had merged at init')
})

test('`doctor` NAMES a re-recorded fork as info — and its exit code does not move for it', async () => {
  const dir = await freshInstall('epah-prov-doctor-')
  const releasedShas = tablesWith()
  const before = await captured(() => doctor({ dir }, { releasedShas }))
  assert.ok(!before.out.includes('local fork:'), before.out)
  recordBytes(dir, HOOK, FORK)
  const after = await captured(() => doctor({ dir }, { releasedShas }))
  assert.match(after.out, new RegExp(`info +local fork: ${HOOK.replaceAll('.', '\\.')}`))
  assert.equal(after.result, before.result, 'a fork is a decision, not damage')
})

test('an agent-surface fork keeps its tools/agents.lock.json entry: update neither overwrites nor launders it', async () => {
  const dir = await freshInstall('epah-prov-lock-')
  const lockPath = join(dir, 'tools', 'agents.lock.json')
  assert.ok(existsSync(lockPath), 'fixture precondition: init wrote the agents lock')
  const live = liveOwned()
  const agent = Object.keys(live)
    .filter((p) => p.startsWith('.claude/agents/') && !live[p][0].sites)
    .sort()[0]
  const lockedBefore = JSON.parse(readFileSync(lockPath, 'utf8')).files[agent]
  recordBytes(dir, agent, `${read(dir, agent)}\nA house rule the consumer added.\n`)
  const tables = tablesWith({ [agent]: [{ sha256: sha256('an earlier variant of this agent\n') }] })
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables })
  assert.equal(res.code, 2, res.out)
  assert.ok(read(dir, agent).includes('A house rule the consumer added.'))
  assert.equal(
    JSON.parse(readFileSync(lockPath, 'utf8')).files[agent],
    lockedBefore,
    'the lock entry still describes the pristine file — the mismatch IS the edit it exists to show',
  )
})

// The case the 1.0.1 runbook got wrong: it said the re-pin of an UNTOUCHED agent file left
// `prompts` red until a human regenerated the lock. `update` rewrites a file a release
// shipped and re-records that file's lock entry, hash and model pin together, so nothing
// is owed. Only an edited copy (the case above) needs a human regeneration.
test('an UNTOUCHED agent file moves its tools/agents.lock.json entry with it: hash and model pin, nothing owed', async () => {
  const dir = await freshInstall('epah-prov-lock-clean-')
  const lockPath = join(dir, 'tools', 'agents.lock.json')
  const owned = liveOwned()
  const agent = Object.keys(owned)
    .filter((p) => p.startsWith('.claude/agents/') && !owned[p][0].sites)
    .sort()[0]
  const name = agent.slice('.claude/agents/'.length, -'.md'.length)
  const live = read(dir, agent)
  const aged = live.replace(/^model:.*$/m, 'model: haiku')
  assert.notEqual(aged, live, 'fixture precondition: the agent pins a model')
  recordBytes(dir, agent, aged)
  // recordBytes leaves the lock alone: put it in the state a 1.0.0 lock was in.
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.files[agent] = sha256(aged)
  lock.models[name] = 'haiku'
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  const tables = tablesWith({ [agent]: [{ sha256: sha256(aged) }] })
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables })
  assert.equal(res.code, 0, res.out)
  assert.ok(parseReport(res.out).written.includes(agent), 'bytes a release shipped are rewritten')
  const after = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(after.files[agent], sha256(read(dir, agent)), 'the hash moves with the file update wrote')
  assert.equal(after.models[name], /^model:\s*(.+)$/m.exec(live)?.[1]?.trim(), 'the model pin moves with it')
  const check = spawnSync(process.execPath, ['tools/gen-agents-lock.mjs', '--check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`)
})

// ── AN OWNED PATH WITH NO MANIFEST RECORD (1.0.4, N21) ──────────────────────────────────
//
// `init` records every owned file it writes and `update` every file it creates or refreshes,
// so a pristine install holds no unrecorded owned file. One appears when a release starts
// shipping a path where the project already had its own file, when `enable` keeps a file at
// a module path (it parks its own copy and records nothing), when `disable` keeps a modified
// module file and drops its record and the module is enabled again, or when someone deletes a
// record by hand. Through 1.0.3 the sweep read "no record" as "unmodified" and overwrote the
// project's bytes with exit 0, and a `removed` migration deleted them. Both now ask the
// question 1.0.2 asks of a recorded file: did any release ship these bytes for this path?

const UNRECORDED = 'tools/validate.mjs'
const THEIRS = '// a project file at a harness-owned path\n'

/**
 * Put `bytes` at `ip` and DROP its manifest record — the state each route above leaves.
 *
 * @param {string} dir @param {string} ip @param {string} bytes
 */
function unrecordedBytes(dir, ip, bytes) {
  mkdirSync(dirname(join(dir, ip)), { recursive: true })
  writeFileSync(join(dir, ip), bytes)
  const manifest = manifestOf(dir)
  delete manifest.files[ip]
  writeManifestOf(dir, manifest)
}

/** @param {{ notes: string[] }} report @param {string} ip */
const notesNaming = (report, ip) => report.notes.filter((n) => n.includes(ip))

test('an unrecorded owned file whose bytes NO release shipped is kept: parked, exit 2, one note', async () => {
  const dir = await freshInstall('epah-prov-unrec-')
  unrecordedBytes(dir, UNRECORDED, THEIRS)
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tablesWith() })
  assert.equal(res.code, 2, res.out)
  const report = parseReport(res.out)
  assert.equal(read(dir, UNRECORDED), THEIRS, "the project's bytes must survive")
  assert.ok(!report.written.includes(UNRECORDED), 'a kept file is never reported as written')
  const pending = join('.harness', 'pending', UNRECORDED)
  assert.deepEqual(
    report.drift.filter((d) => d.path === UNRECORDED),
    [{ path: UNRECORDED, pending }],
  )
  assert.ok(existsSync(join(dir, pending)), 'the incoming version is parked')
  assert.notEqual(read(dir, pending), THEIRS)
  assert.deepEqual(notesNaming(report, UNRECORDED), [
    `${UNRECORDED} has no manifest record and its bytes match no release of this harness — kept; the incoming version is parked at ${pending} (merge it and record its sha, delete yours and re-run update, or re-run with --force)`,
  ])
  assert.equal(manifestOf(dir).files[UNRECORDED], undefined, 'a park never writes a record')
})

test('the same file under --force is overwritten and recorded, and the note says so — sweep and --refresh-seeded alike', async () => {
  for (const extra of [{}, { refreshSeeded: [UNRECORDED] }]) {
    const dir = await freshInstall('epah-prov-unrec-force-')
    unrecordedBytes(dir, UNRECORDED, THEIRS)
    const res = await captureUpdate({ dir, force: true, report: 'json', ...extra }, { releasedShas: tablesWith() })
    assert.equal(res.code, 0, res.out)
    const report = parseReport(res.out)
    assert.ok(report.written.includes(UNRECORDED), res.out)
    assert.notEqual(read(dir, UNRECORDED), THEIRS)
    assert.equal(manifestOf(dir).files[UNRECORDED].sha256, sha256(read(dir, UNRECORDED)))
    assert.deepEqual(notesNaming(report, UNRECORDED), [`--force overwrote locally-modified ${UNRECORDED}`])
  }
})

test('an install at an OLDER version whose table lacks the path: new in the incoming version, and the project file parks — no unchanged-upstream skip', async () => {
  const dir = await freshInstall('epah-prov-unrec-new-')
  unrecordedBytes(dir, UNRECORDED, THEIRS)
  const manifest = manifestOf(dir)
  manifest.harnessVersion = '0.0.9'
  writeManifestOf(dir, manifest)
  const older = liveOwned()
  delete older[UNRECORDED]
  // In range sits exactly one variant and it IS the incoming source — for a recorded fork
  // that is the "upstream has not changed it" skip. With no record, nothing shows the
  // project even knows the harness ships this path.
  const tables = { '0.0.9': older, ...tablesWith() }
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables, migrations: {} })
  assert.equal(res.code, 2, res.out)
  const report = parseReport(res.out)
  assert.equal(read(dir, UNRECORDED), THEIRS)
  assert.ok(!report.skipped.includes(UNRECORDED), 'an unrecorded path never takes the unchanged-upstream skip')
  assert.ok(report.drift.some((d) => d.path === UNRECORDED), res.out)
  assert.ok(!report.notes.some((n) => n.includes('local fork(s) kept')), report.notes.join('\n'))
})

test('with NO released-sha tables at all, an unrecorded owned file parks — as `enable` and --refresh-seeded already do', async () => {
  const dir = await freshInstall('epah-prov-unrec-notables-')
  unrecordedBytes(dir, UNRECORDED, THEIRS)
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: {} })
  assert.equal(res.code, 2, res.out)
  const report = parseReport(res.out)
  assert.equal(read(dir, UNRECORDED), THEIRS)
  assert.ok(report.drift.some((d) => d.path === UNRECORDED), res.out)
  assert.equal(notesNaming(report, UNRECORDED).length, 1, report.notes.join('\n'))
})

test('`enable` keeps an unrecorded owned module file, and the next `update` keeps it too (exit 2)', async () => {
  const dir = await freshInstall('epah-prov-unrec-enable-')
  const releasedShas = tablesWith()
  const module = 'observability'
  const [ip] = planTree(`modules/${module}`, manifestOf(dir).answers)
    .map((e) => e.installPath)
    .filter((p) => fileMode(p) === 'owned')
    .sort()
  assert.ok(ip, `fixture precondition: the ${module} module installs at least one owned file`)
  const theirs = '# the project already had its own file at this module path\n'
  unrecordedBytes(dir, ip, theirs)

  const enabled = await captured(() => enable({ dir }, module, true, { releasedShas }))
  assert.equal(enabled.result, 0, enabled.out)
  assert.equal(read(dir, ip), theirs, 'fixture precondition: enable keeps the file')
  assert.equal(manifestOf(dir).files[ip], undefined, 'fixture precondition: enable records nothing for it')
  assert.ok(manifestOf(dir).modules.includes(module), 'fixture precondition: the module is enabled')

  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas })
  assert.equal(res.code, 2, res.out)
  assert.equal(read(dir, ip), theirs, 'the next update overwrote the file enable kept')
  assert.ok(
    parseReport(res.out).drift.some((d) => d.path === ip),
    res.out,
  )
})

test('an unrecorded owned file whose bytes a release SHIPPED refreshes and is recorded, exit 0 — as before', async () => {
  // A table at the running version, and one OLDER than any install: with no record nobody
  // pinned the file, so either shows the harness wrote these bytes.
  for (const releasedShas of [tablesWith({ [UNRECORDED]: EARLIER }), { '0.0.1': { [UNRECORDED]: EARLIER }, ...tablesWith() }]) {
    const dir = await freshInstall('epah-prov-unrec-released-')
    unrecordedBytes(dir, UNRECORDED, AGED)
    const res = await captureUpdate({ dir, report: 'json' }, { releasedShas })
    assert.equal(res.code, 0, res.out)
    const report = parseReport(res.out)
    assert.ok(report.written.includes(UNRECORDED), res.out)
    assert.notEqual(read(dir, UNRECORDED), AGED)
    assert.equal(manifestOf(dir).files[UNRECORDED].sha256, sha256(read(dir, UNRECORDED)), 'the refresh is recorded')
    assert.deepEqual(notesNaming(report, UNRECORDED), [])
  }
})

test('dry-run reports EXACTLY the plan the real run applies when an unrecorded file parks', async () => {
  const dir = await freshInstall('epah-prov-unrec-dry-')
  unrecordedBytes(dir, UNRECORDED, THEIRS)
  const releasedShas = tablesWith()
  const dry = await captureUpdate({ dir, dryRun: true, report: 'json' }, { releasedShas })
  assert.ok(!existsSync(join(dir, '.harness', 'pending')), 'dry-run must not park anything')
  assert.equal(read(dir, UNRECORDED), THEIRS, 'dry-run must not write anything')
  const real = await captureUpdate({ dir, report: 'json' }, { releasedShas })
  assert.deepEqual(parseReport(dry.out), parseReport(real.out))
  assert.equal(dry.code, real.code)
})

test('`--refresh-seeded <owned path>` with no record parks with exactly ONE note, and --force overwrites', async () => {
  // Bytes no release shipped, and bytes one did: --refresh-seeded parks both without a
  // record, and each park carries one note whichever rule decided it.
  for (const bytes of [THEIRS, AGED]) {
    const dir = await freshInstall('epah-prov-unrec-refresh-')
    unrecordedBytes(dir, UNRECORDED, bytes)
    const releasedShas = tablesWith({ [UNRECORDED]: EARLIER })
    const res = await captureUpdate({ dir, refreshSeeded: [UNRECORDED], report: 'json' }, { releasedShas })
    assert.equal(res.code, 2, res.out)
    assert.equal(read(dir, UNRECORDED), bytes)
    assert.ok(existsSync(join(dir, '.harness', 'pending', UNRECORDED)))
    assert.equal(notesNaming(parseReport(res.out), UNRECORDED).length, 1, res.out)

    const forced = await captureUpdate(
      { dir, refreshSeeded: [UNRECORDED], force: true, report: 'json' },
      { releasedShas },
    )
    assert.equal(forced.code, 0, forced.out)
    assert.ok(parseReport(forced.out).written.includes(UNRECORDED), forced.out)
    assert.notEqual(read(dir, UNRECORDED), bytes)
  }
})

test('a `removed` migration keeps an unrecorded file no release shipped — owned or seeded — and deletes one a release shipped', async () => {
  const dir = await freshInstall('epah-prov-unrec-removed-')
  const shipped = '// what 0.0.9 shipped at this path\n'
  const ownedTheirs = 'tools/retired-theirs.mjs'
  const ownedShipped = 'tools/retired-shipped.mjs'
  const seededTheirs = 'apps/mobile/__tests__/retired-seeded.test.tsx'
  assert.equal(fileMode(seededTheirs), 'seeded', 'fixture precondition: a seeded path')
  unrecordedBytes(dir, ownedTheirs, THEIRS)
  unrecordedBytes(dir, ownedShipped, shipped)
  unrecordedBytes(dir, seededTheirs, '// the project wrote this test\n')
  const manifest = manifestOf(dir)
  manifest.harnessVersion = '0.0.9'
  writeManifestOf(dir, manifest)

  // The tables list OWNED paths only, so no release can vouch for the seeded one.
  const retired = { [ownedTheirs]: [{ sha256: sha256(shipped) }], [ownedShipped]: [{ sha256: sha256(shipped) }] }
  const tables = { '0.0.9': { ...liveOwned(), ...retired }, ...tablesWith() }
  const migrations = { [VERSION]: { removed: [ownedTheirs, ownedShipped, seededTheirs] } }
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: tables, migrations })
  const report = parseReport(res.out)
  assert.ok(!existsSync(join(dir, ownedShipped)), 'bytes a release shipped are removed, record or not')
  assert.ok(report.notes.includes(`removed by template migration: ${ownedShipped}`), report.notes.join('\n'))
  for (const ip of [ownedTheirs, seededTheirs]) {
    assert.ok(existsSync(join(dir, ip)), `${ip}: a file no release shipped is never deleted without a record`)
    assert.ok(
      report.notes.includes(
        `removed by template migration: ${ip} has no manifest record and no release shipped its bytes — left in place; remove it manually`,
      ),
      report.notes.join('\n'),
    )
  }
})
