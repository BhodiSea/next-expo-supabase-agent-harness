// The write guard's append-only migration rule, against a REAL git repository (1.0.4, #45).
//
// Through 1.0.3 the rule denied an Edit or Write to any `supabase/migrations/*.sql` that
// existed on disk. It made no git call, so the draft `supabase migration new` or
// `supabase db diff -f` had just written, and the shipped authoring instructions then tell
// the agent to write, was treated as deployed history. Now a migration on disk may be
// edited only when three proofs hold for every spelling of it (its name, and where its
// bytes land):
//   - untracked:   git status reports exactly one entry for it, `?? <path>`, and the file
//                  has one hard link (a second name for a committed file's bytes is `??` too);
//   - manifest:    .harness/manifest.json parses, and its `files` records no such path;
//   - environment: CLAUDE_PROJECT_DIR is set and no GIT_DIR, GIT_WORK_TREE,
//                  GIT_INDEX_FILE or GIT_COMMON_DIR can point git at another repository.
// Every deny below fails EXACTLY ONE proof, and the message names it and the path. None of
// them is opened by HARNESS_ALLOW_SELF_EDIT=1. Content rules still judge what the draft
// receives (policy-using-true below).
//
// The hook runs from its real template path, with the fixture as cwd and
// CLAUDE_PROJECT_DIR, the way subagent-verdict-pathstate.test.mjs runs its hook.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(
  new URL('../../template/base/.claude/hooks/pretool-write-guard.mjs', import.meta.url),
)

const COMMITTED = 'supabase/migrations/20260101000000_committed.sql'
const DRAFT = 'supabase/migrations/29990101000000_draft.sql'
const PLANTED = 'supabase/migrations/20250101000000_planted.sql'

/**
 * What git must never inherit from whoever ran the tests: each one can make git answer for
 * another repository or index, and the guard now denies when any of them is set, so an
 * inherited value would turn every allowed case below into a deny.
 */
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']
/** hook-contract.test.mjs's LEAKY list: ambient switches a hook must not inherit. */
const LEAKY = ['HARNESS_ALLOW_SELF_EDIT', 'HARNESS_REQUIRE_TOOLCHAINS', 'GITHUB_BASE_REF', 'CI']

function cleanEnv() {
  const e = { ...process.env }
  for (const k of [...LEAKY, ...GIT_REDIRECTS]) delete e[k]
  return e
}

const HAS_GIT = spawnSync('git', ['--version'], { env: cleanEnv() }).status === 0
const NO_GIT = HAS_GIT ? false : 'git is not on PATH on this machine: every case here needs a real repository'

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
/** @param {string} prefix */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: cleanEnv() },
  )
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** @param {string} dir @param {string} rel @param {string} body */
function put(dir, rel, body) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), body)
}

/**
 * An install under git: the committed baseline holds a manifest that parses (recording
 * PLANTED, a migration `init` wrote) and one committed migration; DRAFT is on disk and
 * untracked. The final `git add -A` of the pathstate fixture is left out on purpose.
 * @param {{ repo?: boolean, manifest?: string | null }} [opts]
 */
function install({ repo = true, manifest } = {}) {
  const dir = tempDir('nesah-mig-draft-')
  if (repo) git(dir, ['init', '-q'])
  const body =
    manifest === undefined
      ? `${JSON.stringify({ harnessVersion: '1.0.4', baseVersion: '1.0.4', files: { [PLANTED]: { sha256: 'a'.repeat(64), owner: 'harness' } } }, null, 2)}\n`
      : manifest
  if (body !== null) put(dir, '.harness/manifest.json', body)
  put(dir, COMMITTED, 'CREATE TABLE public.notes (id uuid PRIMARY KEY);\n')
  if (repo) {
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'baseline'])
  }
  put(dir, DRAFT, '-- draft written by supabase migration new\n')
  return dir
}

/**
 * The hook, cwd'd into `dir`. GIT_CEILING_DIRECTORIES stops git's discovery at the fixture's
 * parent, so a repository above tmpdir can never answer for a fixture that has none.
 * @param {string} dir @param {object} toolInput @param {Record<string, string>} [env]
 */
function runHook(dir, toolInput, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'content' in toolInput ? 'Write' : 'Edit', tool_input: toolInput }),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, GIT_CEILING_DIRECTORIES: dirname(dir), ...env },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** @param {{ stdout: string }} r */
const reason = (r) => {
  if (!r.stdout.includes('"deny"')) return null
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
}

const write = (file, content = '-- probe\n') => ({ file_path: file, content })
const edit = (file) => ({ file_path: file, old_string: '-- draft', new_string: '-- re-cased draft' })

/**
 * The deny for one case: denied with and without HARNESS_ALLOW_SELF_EDIT=1, and both times
 * naming the append-only rule, the path and the one proof that failed.
 * @param {string} dir @param {string} file @param {'untracked' | 'manifest' | 'environment'} proof
 * @param {{ env?: Record<string, string>, names?: string, detail?: RegExp }} [opts]
 */
function assertDenied(dir, file, proof, { env = {}, names = file, detail } = {}) {
  for (const selfEdit of [{}, { HARNESS_ALLOW_SELF_EDIT: '1' }]) {
    for (const input of [write(file), edit(file)]) {
      const r = runHook(dir, input, { ...env, ...selfEdit })
      const why = reason(r)
      const label = `${JSON.stringify(selfEdit)} ${'content' in input ? 'Write' : 'Edit'}`
      assert.equal(r.code, 0, `${label}: ${r.stderr}`)
      assert.ok(why !== null, `${label}: expected a deny, got ${JSON.stringify(r.stdout)}`)
      assert.match(why, /^migrations are append-only: /, `${label}: ${why}`)
      assert.ok(why.includes(names), `${label}: the deny must name ${names}: ${why}`)
      assert.ok(why.includes(`the ${proof} proof failed`), `${label}: the deny must name the ${proof} proof: ${why}`)
      for (const other of ['untracked', 'manifest', 'environment'].filter((p) => p !== proof)) {
        assert.ok(!why.includes(`the ${other} proof failed`), `${label}: only the ${proof} proof fails: ${why}`)
      }
      if (detail) assert.match(why, detail, `${label}: ${why}`)
      assert.ok(why.includes('supabase migration new'), `${label}: the advice stays: ${why}`)
    }
  }
}

// ── the carve-out ───────────────────────────────────────────────────────────────────────────

test('an untracked migration the manifest does not record can be edited and written', { skip: NO_GIT }, () => {
  const dir = install()
  assert.equal(git(dir, ['status', '--porcelain', '--', DRAFT]), `?? ${DRAFT}\n`, 'fixture precondition')
  for (const input of [write(DRAFT, 'CREATE TABLE public.items (id uuid PRIMARY KEY);\n'), edit(DRAFT)]) {
    const r = runHook(dir, input)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(reason(r), null, `${JSON.stringify(input)} was denied: ${r.stdout}`)
  }
  // By absolute path too, the way Claude Code delivers file_path.
  const abs = runHook(dir, write(join(dir, DRAFT)))
  assert.equal(reason(abs), null, abs.stdout)
})

test('a Write of USING (true) to the draft is still denied by policy-using-true', { skip: NO_GIT }, () => {
  const dir = install()
  const r = runHook(
    dir,
    write(DRAFT, 'CREATE POLICY p ON public.items FOR SELECT USING (true);\n'),
  )
  const why = reason(r)
  assert.ok(why !== null, r.stdout)
  assert.match(why, /^USING \(true\) \/ WITH CHECK \(true\) is a policy that permits every row/, why)
})

// ── every other case still denies, each on exactly one proof ────────────────────────────────

test('a committed migration, clean or with a working-tree change: the untracked proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  assertDenied(dir, COMMITTED, 'untracked', { detail: /reports nothing/ })
  appendFileSync(join(dir, COMMITTED), '-- a local tweak\n')
  assertDenied(dir, COMMITTED, 'untracked', { detail: / M / })
})

test('a staged migration that was never committed: the untracked proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  git(dir, ['add', '--', DRAFT])
  assertDenied(dir, DRAFT, 'untracked', { detail: /A {2}/ })
})

test('a committed migration removed from the index with git rm --cached: the untracked proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  git(dir, ['rm', '-q', '--cached', '--', COMMITTED])
  const status = git(dir, ['status', '--porcelain', '--', COMMITTED])
  assert.match(status, /\?\? /, `fixture precondition: git shows the ?? beside the staged deletion: ${status}`)
  assertDenied(dir, COMMITTED, 'untracked', { detail: /D {2}/ })
})

test('an untracked migration listed in .git/info/exclude: the untracked proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  // A git built without templates creates no .git/info; the exclude file is read either way.
  mkdirSync(join(dir, '.git/info'), { recursive: true })
  appendFileSync(join(dir, '.git/info/exclude'), `\n${DRAFT}\n`)
  assert.equal(git(dir, ['status', '--porcelain', '--', DRAFT]), '', 'fixture precondition: ignored')
  assertDenied(dir, DRAFT, 'untracked', { detail: /reports nothing/ })
})

test('an untracked migration the manifest records: the manifest proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  put(dir, PLANTED, '-- planted by init\n')
  assert.equal(git(dir, ['status', '--porcelain', '--', PLANTED]), `?? ${PLANTED}\n`, 'fixture precondition')
  assertDenied(dir, PLANTED, 'manifest', { detail: /records it/ })
})

test('an untracked migration when the manifest is missing, or does not parse: the manifest proof fails', { skip: NO_GIT }, () => {
  assertDenied(install({ manifest: null }), DRAFT, 'manifest', { detail: /missing/ })
  assertDenied(install({ manifest: '{ "files": { ' }), DRAFT, 'manifest', { detail: /does not parse/ })
  assertDenied(install({ manifest: '{"fixture":true}\n' }), DRAFT, 'manifest', { detail: /no files object/ })
})

test('an untracked migration in a directory that is not a git repository: the untracked proof fails', { skip: NO_GIT }, () => {
  const dir = install({ repo: false })
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    env: { ...cleanEnv(), GIT_CEILING_DIRECTORIES: dirname(dir) },
  })
  assert.notEqual(probe.status, 0, 'fixture precondition: no repository answers for the fixture')
  assertDenied(dir, DRAFT, 'untracked', { detail: /git status failed/ })
})

test('an untracked migration when git is not on PATH: the untracked proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  const empty = tempDir('nesah-mig-nopath-')
  // One PATH key whatever its case: Windows spells it Path, and two keys that differ only in
  // case leave which one the child sees to the platform.
  const env = cleanEnv()
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: write(DRAFT) }),
    env: { ...env, PATH: empty, CLAUDE_PROJECT_DIR: dir },
  })
  const why = reason({ stdout: r.stdout ?? '' })
  assert.ok(why !== null, `expected a deny: ${r.stdout} ${r.stderr}`)
  assert.ok(why.includes('the untracked proof failed'), why)
  assert.match(why, /git status failed/, why)
  assert.ok(why.includes(DRAFT), why)
})

test('an untracked migration while GIT_DIR is set, to another repository or to nowhere: the environment proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  const other = install()
  assertDenied(dir, DRAFT, 'environment', { env: { GIT_DIR: join(other, '.git') }, detail: /GIT_DIR/ })
  assertDenied(dir, DRAFT, 'environment', { env: { GIT_DIR: join(dir, 'no-such-git-dir') }, detail: /GIT_DIR/ })
  for (const name of ['GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    assertDenied(dir, DRAFT, 'environment', { env: { [name]: join(other, '.git') }, detail: new RegExp(name) })
  }
})

test('an untracked migration when CLAUDE_PROJECT_DIR is unset: the environment proof fails', { skip: NO_GIT }, () => {
  const dir = install()
  const env = cleanEnv()
  delete env.CLAUDE_PROJECT_DIR
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: write(DRAFT) }),
    env,
  })
  const why = reason({ stdout: r.stdout ?? '' })
  assert.ok(why !== null, `expected a deny: ${r.stdout} ${r.stderr}`)
  assert.ok(why.includes('the environment proof failed'), why)
  assert.match(why, /CLAUDE_PROJECT_DIR/, why)
})

test('an untracked symlink under supabase/migrations/ pointing at a committed migration: the untracked proof fails for the target', { skip: NO_GIT }, (t) => {
  const dir = install()
  const link = 'supabase/migrations/29990102000000_link.sql'
  try {
    symlinkSync('20260101000000_committed.sql', join(dir, link))
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      t.skip('this Windows runner has no symlink privilege (no Developer Mode): the link cannot be made here')
      return
    }
    throw err
  }
  assert.equal(git(dir, ['status', '--porcelain', '--', link]), `?? ${link}\n`, 'fixture precondition: the link is untracked')
  assertDenied(dir, link, 'untracked', { names: COMMITTED, detail: /reports nothing/ })
})

test('an untracked hard link under supabase/migrations/ to a committed migration: the untracked proof fails on the link count', { skip: NO_GIT }, (t) => {
  // git status judges a name, not an inode: a second name for a committed migration's bytes
  // reports `??`, the manifest does not record it, and a write through it would rewrite the
  // committed file in place. The symlink case above is caught by its target's spelling; a
  // hard link has no other spelling, so the file's link count is what proves it.
  const dir = install()
  const link = 'supabase/migrations/29990103000000_hardlink.sql'
  try {
    linkSync(join(dir, COMMITTED), join(dir, link))
  } catch (err) {
    t.skip(`this filesystem cannot make a hard link here (${err.code}): the case cannot be built`)
    return
  }
  assert.equal(git(dir, ['status', '--porcelain', '--', link]), `?? ${link}\n`, 'fixture precondition: the link is untracked')
  assertDenied(dir, link, 'untracked', { detail: /2 hard links/ })
})
