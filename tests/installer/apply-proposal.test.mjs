// `apply-proposal` (1.1.0, #65): an agent stages the whole proposed text of a write-guarded
// register as one JSON file under harness-proposals/, and a human applies it in one action.
//
// Through 1.1.0's first cut an agent had no way to hand a human such an edit: the register is
// denied to it by the write guard, `.harness/proposals/` is denied by the settings deny list,
// the write guard's `harness-dir` rule and the bash guard's PROT_DIRS, and it is gitignored.
// The agent could only describe the edit in prose, and the human either typed it or relaunched
// with HARNESS_ALLOW_SELF_EDIT=1, which lifts the guard for every protected path at once.
//
// Everything runs in-process, because the coverage counter cannot see a child process
// (CONTRIBUTING.md). The terminal and the prompt are injected the way `update` injects its
// writer: `tty` says whether stdin and stdout are terminals, and `ask` answers the prompt.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { applyProposal } from '../../installer/commands/apply-proposal.mjs'
import { doctor } from '../../installer/commands/doctor.mjs'
import { PROPOSABLE, PROPOSALS_DIR } from '../../installer/lib/proposals.mjs'
import { captured, freshInstall as install } from './helpers/provenance-fixture.mjs'

// Every directory this file makes is removed when it ends (a fresh install is ~14 MB).
/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
/** @param {string} prefix */
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.email=x@y.z', '-c', 'user.name=x', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** @param {string} dir @param {string} rel @param {string} body */
function plant(dir, rel, body) {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

const TARGET = 'tools/i18n-allow.json'
const COMMITTED = `${JSON.stringify({ comment: 'fixture', strings: [] }, null, 2)}\n`
const PROPOSED = `${JSON.stringify({ comment: 'fixture', strings: ['Acme™'] }, null, 2)}\n`
const REASON = 'The legal footer carries the trademark sign, which the catalog cannot hold.'

/** A git repository with one committed register, the shape of an install for this verb. */
function repo() {
  const dir = tempDir('nesah-proposal-')
  git(dir, ['init', '-q'])
  plant(dir, TARGET, COMMITTED)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

/** @param {string} dir @param {string} target */
const blob = (dir, target) => git(dir, ['rev-parse', `HEAD:${target}`]).trim()

/**
 * Stage a proposal the way the docs tell an agent to write one: the whole object, two-space
 * JSON, one trailing newline.
 * @param {string} dir @param {string} id @param {Record<string, unknown>} [fields]
 */
function stage(dir, id, fields = {}) {
  const proposal = { version: 1, target: TARGET, reason: REASON, base: blob(dir, TARGET), content: PROPOSED, ...fields }
  return plant(dir, `${PROPOSALS_DIR}/${id}.json`, `${JSON.stringify(proposal, null, 2)}\n`)
}

const TERMINAL = { stdin: true, stdout: true }

/**
 * @param {string} dir @param {string | undefined} id
 * @param {{ dryRun?: boolean, yes?: boolean, answer?: string, tty?: { stdin: boolean, stdout: boolean },
 *           onAsk?: () => void }} [o]
 */
async function run(dir, id, o = {}) {
  /** @type {string[]} */
  const asked = []
  const { result, out } = await captured(() =>
    applyProposal({ dir, dryRun: o.dryRun ?? false, yes: o.yes ?? false }, id, {
      tty: o.tty ?? TERMINAL,
      ask: async (question) => {
        asked.push(question)
        o.onAsk?.()
        return o.answer ?? `${TARGET}\n`
      },
    }),
  )
  return { code: result, out, asked }
}

const read = (/** @type {string} */ dir, /** @type {string} */ rel) => readFileSync(join(dir, rel), 'utf8')

test('a valid proposal is applied once the target path is typed: the file is written, the proposal deleted, and the output says to commit it', async () => {
  const dir = repo()
  const file = stage(dir, 'allow-trademark')
  const r = await run(dir, 'allow-trademark')
  assert.equal(r.code, 0, r.out)
  assert.equal(read(dir, TARGET), PROPOSED)
  assert.equal(existsSync(file), false, 'the applied proposal is deleted')
  assert.ok(r.out.includes(REASON), r.out)
  // The diff is the review: the removed and the added line are both in it.
  assert.match(r.out, /^- {2}"strings": \[\]$/m)
  assert.match(r.out, /^\+ {2}"strings": \[$/m)
  assert.match(r.out, /^\+ {4}"Acme™"$/m)
  assert.match(r.out, /^commit tools\/i18n-allow\.json$/m)
  assert.equal(r.asked.length, 1)
  assert.ok(r.asked[0].includes(TARGET), r.asked[0])
})

test('any answer but the target path writes nothing and keeps the proposal', async () => {
  const dir = repo()
  const file = stage(dir, 'allow-trademark')
  for (const answer of ['y', 'yes', '', 'tools/i18n-allow', ` ${TARGET}x`]) {
    const r = await run(dir, 'allow-trademark', { answer })
    assert.equal(r.code, 1, `${JSON.stringify(answer)}: ${r.out}`)
    assert.equal(read(dir, TARGET), COMMITTED)
    assert.ok(existsSync(file))
  }
})

test('--dry-run prints the reason and the diff, asks nothing and writes nothing', async () => {
  const dir = repo()
  const file = stage(dir, 'allow-trademark')
  const before = readFileSync(file, 'utf8')
  const r = await run(dir, 'allow-trademark', { dryRun: true })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.asked, [])
  assert.ok(r.out.includes(REASON), r.out)
  assert.match(r.out, /^\+ {4}"Acme™"$/m)
  assert.match(r.out, /dry run/i)
  assert.equal(read(dir, TARGET), COMMITTED)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('with no id it lists the pending proposals, and says so when there are none', async () => {
  const dir = repo()
  const none = await run(dir, undefined, { tty: { stdin: false, stdout: false } })
  assert.equal(none.code, 0, none.out)
  assert.match(none.out, /no pending proposals/)
  stage(dir, 'allow-trademark')
  const one = await run(dir, undefined, { tty: { stdin: false, stdout: false } })
  assert.equal(one.code, 0, one.out)
  assert.ok(one.out.includes(`${PROPOSALS_DIR}/allow-trademark.json`), one.out)
  assert.ok(one.out.includes(TARGET), one.out)
  assert.ok(one.out.includes(REASON), one.out)
  assert.ok(one.out.includes('apply-proposal allow-trademark'), one.out)
  assert.deepEqual(one.asked, [])
  assert.equal(read(dir, TARGET), COMMITTED)
})

test('a target that is not in HEAD, with a null base, is created', async () => {
  const dir = repo()
  const target = 'tools/secret-scan-allow.json'
  const content = `${JSON.stringify({ entries: [] }, null, 2)}\n`
  stage(dir, 'first-allow', { target, base: null, content })
  const r = await run(dir, 'first-allow', { answer: target })
  assert.equal(r.code, 0, r.out)
  assert.equal(read(dir, target), content)
  assert.match(r.out, /new file/)
})

// ── the refusals: each exits 1 with its own message, asks nothing and writes nothing ──
/**
 * @typedef {{ name: string, message: RegExp, id?: string,
 *             setup: (dir: string) => void, tty?: { stdin: boolean, stdout: boolean },
 *             yes?: boolean, skip?: string | false }} Refusal
 */
/** @type {Refusal[]} */
const REFUSALS = [
  {
    name: 'the target is outside the proposable set (an owned gate config)',
    message: /tools\/harness\.config\.mjs is outside the proposable set/,
    setup: (dir) => stage(dir, 'p', { target: 'tools/harness.config.mjs' }),
  },
  {
    name: 'the target is a baseline only its generator writes',
    message: /tools\/perf-baseline\.json is outside the proposable set/,
    setup: (dir) => stage(dir, 'p', { target: 'tools/perf-baseline.json', base: null }),
  },
  {
    name: 'the id resolves outside --dir',
    message: /resolves outside --dir/,
    id: '../../../escape',
    setup: () => {},
  },
  {
    name: 'the id is a path inside --dir but not a file in harness-proposals/',
    message: /not a proposal id/,
    id: '../tools/i18n-allow',
    setup: () => {},
  },
  {
    name: 'the target resolves outside --dir through a symlinked directory',
    message: /tools\/i18n-allow\.json resolves outside --dir/,
    setup: (dir) => {
      stage(dir, 'p')
      const outside = tempDir('nesah-proposal-outside-')
      plant(outside, 'i18n-allow.json', COMMITTED)
      rmSync(join(dir, 'tools'), { recursive: true })
      symlinkSync(outside, join(dir, 'tools'), 'dir')
    },
    skip: process.platform === 'win32' ? 'creating a directory symlink needs a privilege Windows runners lack' : false,
  },
  {
    name: 'content is not JSON',
    message: /content is not JSON/,
    setup: (dir) => stage(dir, 'p', { content: '{"strings": [' }),
  },
  {
    name: 'base does not equal git rev-parse HEAD:<target>',
    message: /base .* does not match HEAD:tools\/i18n-allow\.json/,
    setup: (dir) => stage(dir, 'p', { base: '0'.repeat(40) }),
  },
  {
    name: 'a null base for a target that is in HEAD',
    message: /base is null, but tools\/i18n-allow\.json is in HEAD/,
    setup: (dir) => stage(dir, 'p', { base: null }),
  },
  {
    name: 'a non-null base for a target that is not in HEAD',
    message: /tools\/secret-scan-allow\.json is not in HEAD, so base must be null/,
    setup: (dir) => stage(dir, 'p', { target: 'tools/secret-scan-allow.json' }),
  },
  {
    name: 'the target has uncommitted changes',
    message: /tools\/i18n-allow\.json has uncommitted changes/,
    setup: (dir) => {
      stage(dir, 'p')
      writeFileSync(join(dir, TARGET), `${COMMITTED} `)
    },
  },
  {
    name: 'stdin is not a TTY',
    message: /stdin is not a terminal/,
    setup: (dir) => stage(dir, 'p'),
    tty: { stdin: false, stdout: true },
  },
  {
    name: 'stdout is not a TTY',
    message: /stdout is not a terminal/,
    setup: (dir) => stage(dir, 'p'),
    tty: { stdin: true, stdout: false },
  },
  // Beyond the issue's list, each for a reason stated in the verb.
  {
    name: 'no proposal by that id',
    message: /no proposal harness-proposals\/p\.json/,
    setup: () => {},
  },
  {
    name: 'the proposal file is not JSON',
    message: /harness-proposals\/p\.json is not JSON/,
    setup: (dir) => plant(dir, `${PROPOSALS_DIR}/p.json`, '{ "version": 1,'),
  },
  {
    name: 'the proposal carries a field the format does not have',
    message: /unknown field "yes"/,
    setup: (dir) => stage(dir, 'p', { yes: true }),
  },
  {
    name: 'the proposal is not version 1',
    message: /version must be 1/,
    setup: (dir) => stage(dir, 'p', { version: 2 }),
  },
  {
    name: 'the reason is empty',
    message: /reason must be a non-empty string/,
    setup: (dir) => stage(dir, 'p', { reason: '  ' }),
  },
  {
    name: 'a character that can make the terminal show other text than the bytes written',
    message: /control or bidirectional-format character/,
    setup: (dir) => stage(dir, 'p', { reason: 'fine\u001b[2Kreally' }),
  },
  {
    name: 'a bidirectional override inside the content',
    message: /control or bidirectional-format character/,
    setup: (dir) =>
      stage(dir, 'p', { content: `${JSON.stringify({ comment: 'fixture', strings: ['a‮b'] }, null, 2)}\n` }),
  },
  {
    name: 'the proposal changes nothing',
    message: /changes nothing/,
    setup: (dir) => stage(dir, 'p', { content: COMMITTED }),
  },
  {
    name: '--yes, which the verb does not have',
    message: /no --yes/,
    setup: (dir) => stage(dir, 'p'),
    yes: true,
  },
]

for (const c of REFUSALS) {
  test(`refused: ${c.name}`, { skip: c.skip ?? false }, async () => {
    const dir = repo()
    c.setup(dir)
    const target = join(dir, TARGET)
    const before = existsSync(target) ? readFileSync(target, 'utf8') : null
    const proposal = join(dir, PROPOSALS_DIR, 'p.json')
    const staged = existsSync(proposal) ? readFileSync(proposal, 'utf8') : null
    const r = await run(dir, c.id ?? 'p', { tty: c.tty, yes: c.yes })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, c.message)
    assert.match(r.out, /apply-proposal: refused/)
    assert.deepEqual(r.asked, [], 'a refusal never reaches the prompt')
    assert.equal(existsSync(target) ? readFileSync(target, 'utf8') : null, before, 'nothing written')
    assert.equal(existsSync(proposal) ? readFileSync(proposal, 'utf8') : null, staged, 'the proposal is kept')
  })
}

test('refused: a directory that is not a git work tree (base and the dirty check need git)', async () => {
  const dir = tempDir('nesah-proposal-nogit-')
  plant(dir, TARGET, COMMITTED)
  plant(
    dir,
    `${PROPOSALS_DIR}/p.json`,
    `${JSON.stringify({ version: 1, target: TARGET, reason: REASON, base: null, content: PROPOSED }, null, 2)}\n`,
  )
  const r = await run(dir, 'p')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not inside a git work tree/)
  assert.equal(read(dir, TARGET), COMMITTED)
})

test('the base and dirty checks run again after the prompt, so an edit made while it waited is not overwritten', async () => {
  const dir = repo()
  const file = stage(dir, 'allow-trademark')
  const concurrent = `${COMMITTED}\n`
  const r = await run(dir, 'allow-trademark', { onAsk: () => writeFileSync(join(dir, TARGET), concurrent) })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /uncommitted changes/)
  assert.equal(read(dir, TARGET), concurrent)
  assert.ok(existsSync(file))
})

test('the bytes written are the bytes the diff showed, even if the proposal file changes at the prompt', async () => {
  const dir = repo()
  stage(dir, 'allow-trademark')
  const swapped = `${JSON.stringify({ comment: 'fixture', strings: ['*'] }, null, 2)}\n`
  const r = await run(dir, 'allow-trademark', { onAsk: () => stage(dir, 'allow-trademark', { content: swapped }) })
  assert.equal(r.code, 0, r.out)
  assert.equal(read(dir, TARGET), PROPOSED)
})

test('the proposable set: reviewed, write-guarded registers only, never an owned file, a pin or a generator-written baseline', () => {
  assert.equal(new Set(PROPOSABLE).size, PROPOSABLE.length, 'no duplicates')
  for (const p of PROPOSABLE) assert.match(p, /^tools\/[a-z0-9./-]+\.json$/, p)
  for (const yes of ['tools/i18n-allow.json', 'tools/rls-exempt.json', 'tools/approved-tools.json', 'tools/mcp/corpus/project.json', 'tools/field-notes.json', 'tools/secret-scan-allow.json']) {
    assert.ok(PROPOSABLE.includes(yes), `${yes} should be proposable`)
  }
  for (const no of [
    'tools/harness.config.mjs',
    'tools/validate.floor.json',
    'tools/identity.lock.json',
    'tools/prompts.lock.json',
    'tools/generated/query-shapes.json',
    'tools/mcp/corpus/index.json',
    'tools/perf-baseline.json',
    'tools/mutation-baseline.json',
    '.claude/settings.json',
  ]) {
    assert.ok(!PROPOSABLE.includes(no), `${no} must not be proposable`)
  }
  // The directory the proposals live in sits outside everything the guards protect.
  assert.equal(PROPOSALS_DIR, 'harness-proposals')
})

test('doctor lists a staged proposal as info and returns the exit code it returns without one', async () => {
  const dir = await install('nesah-doctor-proposal-')
  made.push(dir)
  const probe = () => ({ found: '/fake/bin/tool', version: '1.2.3' })
  const without = await captured(() => doctor({ dir }, { probe }))
  plant(
    dir,
    `${PROPOSALS_DIR}/allow-trademark.json`,
    `${JSON.stringify({ version: 1, target: TARGET, reason: REASON, base: null, content: PROPOSED }, null, 2)}\n`,
  )
  plant(dir, `${PROPOSALS_DIR}/broken.json`, '{')
  const withOne = await captured(() => doctor({ dir }, { probe }))
  assert.equal(withOne.result, without.result, 'a pending proposal is info only')
  assert.match(
    withOne.out,
    /info +pending register proposal: harness-proposals\/allow-trademark\.json proposes tools\/i18n-allow\.json/,
  )
  assert.match(withOne.out, /apply-proposal allow-trademark/)
  assert.match(withOne.out, /info +pending register proposal: harness-proposals\/broken\.json is not JSON/)
  assert.doesNotMatch(without.out, /pending register proposal/)
})
