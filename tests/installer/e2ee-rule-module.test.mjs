// The full encryption rule ships with the `e2ee` module (2.0.0, #86, design record B02).
//
// Until 2.0.0 `.claude/rules/e2ee.md` was stored in template/base, so every install carried
// it, while the module it describes is opt-in (`strict` is the only tier that installs it).
// 2.0.0 moves its STORAGE to template/modules/e2ee without changing its bytes or its install
// path, and the "2.0.0" migrations record removes the base copy from existing installs. On an
// `e2ee` install `update` then plants the module copy again, attributed to the module, so
// `disable e2ee` can remove it. These cases hold each half:
//
//   1. the template: base does not ship the rule, the module does, and the record names it;
//   2. the factory closure: no base, stack or preset file cites a rule only a module ships,
//      except the four listed below, each for its reason;
//   3. the upgrade, with an injected `removed` record over a backdated install, core and
//      `e2ee`, pristine and forked (the fork survives with its note, on both);
//   4. `update --dry-run` reports the re-planted rule exactly as the real run does.
//
// In-process and read-only over the template, POSIX install paths throughout, so the Windows
// leg of installer-unit runs every case.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { enable } from '../../installer/commands/enable.mjs'
import { renderEntry, walkTemplate } from '../../installer/lib/copy.mjs'
import { sha256 } from '../../installer/lib/manifest.mjs'
import { readTemplateMigrations } from '../../installer/lib/migrations.mjs'
import {
  captured,
  captureUpdate,
  freshInstall,
  liveOwned,
  manifestOf,
  parseReport,
  recordBytes,
  tablesWith,
  VERSION,
  writeManifestOf,
} from './helpers/provenance-fixture.mjs'

const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))
const RULE = '.claude/rules/e2ee.md'
// The release an upgrading install is pretended to be at: the last one whose base shipped
// the rule. Its released-sha table is injected, so provenance can tell a release's bytes
// from a fork (without a table for the install's version every recorded sha is unverifiable,
// and `removed` deletes a fork too).
const BACKDATED = '1.1.0'

/** The rule as the e2ee module ships it, rendered with no answers (it carries no tokens). */
function moduleRuleBytes() {
  const entry = walkTemplate('modules/e2ee').find((e) => e.installPath === RULE)
  assert.ok(entry, `the e2ee module does not ship ${RULE}`)
  return String(renderEntry(entry, {}))
}

/** Tables for the backdated version and the live one; both list the rule's released bytes. */
function releasedShas() {
  const released = { [RULE]: [{ sha256: sha256(moduleRuleBytes()) }] }
  return { [BACKDATED]: { ...liveOwned(), ...released }, ...tablesWith() }
}

// Injected, so the case proves the mechanism whatever else the shipped record carries.
const MIGRATIONS = { [VERSION]: { removed: [RULE] } }

/** Pretend the install is a 1.x one: its harness version, and its record without a module. */
function backdate(dir) {
  const manifest = manifestOf(dir)
  manifest.harnessVersion = BACKDATED
  if (manifest.files[RULE]) {
    const { module: _dropped, ...rest } = manifest.files[RULE]
    manifest.files[RULE] = rest
  }
  writeManifestOf(dir, manifest)
}

// ── 1. the template ─────────────────────────────────────────────────────────────────

test('the full rule ships with the e2ee module, not with base, and the 2.0.0 record removes the base copy', () => {
  const base = walkTemplate('base').map((e) => e.installPath)
  assert.ok(!base.includes(RULE), `template/base still ships ${RULE}`)
  const module = walkTemplate('modules/e2ee').find((e) => e.installPath === RULE)
  assert.ok(module, `template/modules/e2ee does not ship ${RULE}`)
  // Same install path, so it loads exactly as it did; only which installs carry it changed.
  assert.equal(module.storagePath, `modules/e2ee/${RULE}`)
  // The stub stays in base: it is the always-loaded half.
  assert.ok(base.includes('.claude/rules/encryption.md'), 'the stub must stay in base')
  const record = readTemplateMigrations()['2.0.0']
  assert.ok(record?.removed?.includes(RULE), `the "2.0.0" record must name ${RULE} in removed`)
  assert.ok(typeof record.removedWhy === 'string' && record.removedWhy.length > 200, 'removedWhy must say why')
})

// ── 2. the factory closure ──────────────────────────────────────────────────────────

/** Every `.claude/rules/` install path some module ships and base does not. */
function moduleOnlyRules() {
  const base = new Set(walkTemplate('base').map((e) => e.installPath))
  const out = new Set()
  for (const name of readdirSync(join(TEMPLATE, 'modules')).sort()) {
    for (const e of walkTemplate(`modules/${name}`)) {
      if (e.installPath.startsWith('.claude/rules/') && !base.has(e.installPath)) out.add(e.installPath)
    }
  }
  return [...out].sort()
}

// One file per entry, by storage path, each with its reason. Nothing else in base, stack or a
// preset may name a rule that only a module ships: a base file that cites it points every
// install without that module at a file it does not have, and nothing in an install notices.
const EXEMPT = new Map([
  ['base/.claude/rules/encryption.md', 'the stub: it says that `enable e2ee` installs the full rule'],
  [
    'base/.claude/skills/authoring-e2ee-feature/SKILL.md',
    'its first step reads the full rule, and the skill already requires the e2ee module',
  ],
  ['base/docs/harness/README.md', 'the doctrine names both rule files and says the full one comes with e2ee'],
  ['base/docs/runbooks/harness-upgrade.md', 'the upgrade runbook records where the rule went and when'],
])

test('no base, stack or preset file cites a rule only a module ships, outside the reviewed exemptions', () => {
  const paths = moduleOnlyRules()
  // Non-empty on purpose: before 2.0.0 no module shipped anything under .claude/, and this
  // closure would pass vacuously over an empty set.
  assert.ok(paths.length > 0, 'no module ships a .claude/rules/ file that base does not')
  assert.ok(paths.includes(RULE))
  const trees = ['base', 'stack', ...readdirSync(join(TEMPLATE, 'presets')).sort().map((p) => `presets/${p}`)]
  const offenders = []
  for (const tree of trees) {
    for (const entry of walkTemplate(tree)) {
      if (EXEMPT.has(entry.storagePath)) continue
      const text = readFileSync(entry.sourcePath, 'utf8')
      for (const p of paths) if (text.includes(p)) offenders.push(`${entry.storagePath} names ${p}`)
    }
  }
  assert.deepEqual(offenders, [], 'cite the always-loaded stub, .claude/rules/encryption.md, instead')
  // An exemption for a file the template no longer ships would excuse nothing.
  const shipped = new Set(trees.flatMap((t) => walkTemplate(t).map((e) => e.storagePath)))
  for (const [file, why] of EXEMPT) assert.ok(shipped.has(file), `stale exemption (${why}): ${file}`)
})

// ── 3. the upgrade ──────────────────────────────────────────────────────────────────

test('core install: the unmodified base copy is deleted and its record pruned', async () => {
  const dir = await freshInstall('epah-b02-core-')
  assert.ok(!existsSync(join(dir, RULE)), 'a fresh 2.0.0 core install carries no full rule')
  recordBytes(dir, RULE, moduleRuleBytes())
  backdate(dir)
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: releasedShas(), migrations: MIGRATIONS })
  const report = parseReport(res.out)
  assert.ok(!existsSync(join(dir, RULE)), `${RULE} survived on a core install`)
  assert.equal(manifestOf(dir).files[RULE], undefined, 'its record must be pruned')
  assert.ok(report.notes.includes(`removed by template migration: ${RULE}`), report.notes.join('\n'))
  assert.ok(existsSync(join(dir, '.claude/rules/encryption.md')), 'the stub stays')
})

test('core install through the SHIPPED 2.0.0 record: the same deletion', async () => {
  const dir = await freshInstall('epah-b02-shipped-')
  recordBytes(dir, RULE, moduleRuleBytes())
  backdate(dir)
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: releasedShas() })
  assert.ok(!existsSync(join(dir, RULE)), res.out)
  assert.equal(manifestOf(dir).files[RULE], undefined)
})

test('e2ee install: the rule is re-planted as the module\'s, and `disable e2ee` removes it', async () => {
  const dir = await freshInstall('epah-b02-mod-', { modules: ['e2ee'] })
  assert.equal(manifestOf(dir).files[RULE]?.module, 'e2ee', 'a fresh --modules e2ee install attributes the rule')
  backdate(dir)
  assert.equal(manifestOf(dir).files[RULE].module, undefined, 'fixture: a 1.x record carries no module')
  const shas = releasedShas()
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: shas, migrations: MIGRATIONS })
  assert.ok(existsSync(join(dir, RULE)), `${RULE} must survive on an e2ee install`)
  assert.equal(manifestOf(dir).files[RULE]?.module, 'e2ee', 'the re-planted record must name the module')
  assert.ok(parseReport(res.out).written.includes(RULE), res.out)

  const off = await captured(() => enable({ dir }, 'e2ee', false, { releasedShas: shas }))
  assert.equal(off.result, 0, off.out)
  assert.ok(!existsSync(join(dir, RULE)), '`disable e2ee` must remove the rule it now owns')
  assert.equal(manifestOf(dir).files[RULE], undefined)
  for (const rule of ['encryption.md', 'security-invariants.md', 'boundaries.md']) {
    assert.ok(existsSync(join(dir, '.claude/rules', rule)), `disable must leave the base rule ${rule}`)
  }
})

const FORK = `${'# a project that kept and edited the full rule\n'.repeat(3)}`

test('re-recorded fork, core install: the file survives with the "remove it manually" note', async () => {
  const dir = await freshInstall('epah-b02-fork-core-')
  recordBytes(dir, RULE, FORK)
  backdate(dir)
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: releasedShas(), migrations: MIGRATIONS })
  const report = parseReport(res.out)
  assert.equal(readFileSync(join(dir, RULE), 'utf8'), FORK, 'a fork is never deleted')
  assert.ok(
    report.notes.some((n) => n.includes(RULE) && n.includes('a local fork, left in place; remove it manually')),
    report.notes.join('\n'),
  )
})

test('re-recorded fork, e2ee install: the file survives with its note, and `disable e2ee` leaves it', async () => {
  const dir = await freshInstall('epah-b02-fork-mod-', { modules: ['e2ee'] })
  recordBytes(dir, RULE, FORK)
  backdate(dir)
  const shas = releasedShas()
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: shas, migrations: MIGRATIONS })
  const report = parseReport(res.out)
  assert.equal(readFileSync(join(dir, RULE), 'utf8'), FORK, 'a fork is never deleted')
  // The note says "remove it manually", which is wrong advice on this install: the module
  // ships the rule. The runbook's 2.0.0 section corrects it for an e2ee install.
  assert.ok(
    report.notes.some((n) => n.includes(RULE) && n.includes('remove it manually')),
    report.notes.join('\n'),
  )
  // The fork keeps its old record, with no module attribution...
  assert.equal(manifestOf(dir).files[RULE]?.module, undefined)
  // ...and the rule's bytes are the ones 1.1.0 shipped, so nothing new is parked for it.
  assert.ok(!existsSync(join(dir, '.harness/pending', RULE)))
  assert.ok(
    report.notes.some((n) => n.includes('nothing parked') && n.includes(RULE)),
    report.notes.join('\n'),
  )
  await captured(() => enable({ dir }, 'e2ee', false, { releasedShas: shas }))
  assert.equal(readFileSync(join(dir, RULE), 'utf8'), FORK, '`disable e2ee` leaves a fork it does not own')
})

test('re-recorded fork, e2ee install whose version shipped OTHER rule bytes: the module copy is parked for the merge', async () => {
  const dir = await freshInstall('epah-b02-fork-park-', { modules: ['e2ee'] })
  recordBytes(dir, RULE, FORK)
  backdate(dir)
  // What an install sees when the rule changed after its version: its release shipped an
  // earlier text, so the incoming module copy is new, and `update` parks it beside the fork.
  const earlier = { [RULE]: [{ sha256: sha256('# the full rule as an earlier release wrote it\n') }] }
  const shas = { [BACKDATED]: { ...liveOwned(), ...earlier }, ...tablesWith() }
  const res = await captureUpdate({ dir, report: 'json' }, { releasedShas: shas, migrations: MIGRATIONS })
  assert.equal(readFileSync(join(dir, RULE), 'utf8'), FORK, 'a fork is never deleted')
  assert.ok(existsSync(join(dir, '.harness/pending', RULE)), 'the module copy must be parked for the merge')
  assert.ok(parseReport(res.out).drift.some((d) => d.path === RULE), res.out)
})

// ── 4. dry run ──────────────────────────────────────────────────────────────────────

test('update --dry-run on an e2ee install reports the re-planted rule exactly as the real run does', async () => {
  const dir = await freshInstall('epah-b02-dry-', { modules: ['e2ee'] })
  backdate(dir)
  const shas = releasedShas()
  const dry = await captureUpdate({ dir, dryRun: true, report: 'json' }, { releasedShas: shas, migrations: MIGRATIONS })
  assert.ok(existsSync(join(dir, RULE)), 'a dry run deletes nothing')
  assert.equal(manifestOf(dir).files[RULE].module, undefined, 'a dry run records nothing')
  const real = await captureUpdate({ dir, report: 'json' }, { releasedShas: shas, migrations: MIGRATIONS })
  const [d, r] = [parseReport(dry.out), parseReport(real.out)]
  assert.ok(r.written.includes(RULE), 'the real run re-plants the rule')
  assert.ok(d.written.includes(RULE), `the dry run must list ${RULE} under written, as the real run does`)
  assert.ok(!d.skipped.includes(RULE))
  assert.deepEqual(d, r)
  assert.equal(dry.code, real.code)
})
