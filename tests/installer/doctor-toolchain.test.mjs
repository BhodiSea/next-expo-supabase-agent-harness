// `doctor` reports the toolchain it resolved, and `doctor --clean` deletes a fixed list of
// ignored residue (1.0.4, #43).
//
// Through 1.0.3 doctor checked only Node's major version, so nothing said which `supabase`,
// `pnpm` or `psql` a local run would reach, or which pin each is held to. And nothing deleted
// `.harness/stop-output/<step>.log` (the Stop hook's spill files) or `apps/mobile/dist/` (the
// build gate's export). The report is `info` only and never moves the exit code; `--clean`
// deletes an entry only when it is inside the target, not reached through a symlink, ignored
// by git at run time and holds no tracked file.
//
// The probe is injected through doctor's second parameter, so a failing, a timing-out and a
// throwing probe are all driven here without the machine's own tools deciding the result.
// probeCommand itself is proven against this process's own node binary, which every leg has.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { doctor } from '../../installer/commands/doctor.mjs'
import { catalogEntry } from '../../installer/lib/migrations.mjs'
import {
  CLEAN_LIST,
  cleanEntry,
  cleanResidue,
  probeCommand,
  toolchainReport,
} from '../../installer/lib/toolchain.mjs'
import { captured, freshInstall as install } from './helpers/provenance-fixture.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const TEMPLATE_GITIGNORE = fileURLToPath(new URL('../../template/base/gitignore', import.meta.url))

// Every directory this file makes is removed when it ends: a fresh install is ~14 MB, and
// the suite runs on shared machines.
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
/** @param {string} prefix */
const freshInstall = async (prefix) => {
  const dir = await install(prefix)
  made.push(dir)
  return dir
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.email=x@y.z', '-c', 'user.name=x', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** @param {string} dir @param {string} rel @param {string} [body] */
function plant(dir, rel, body = 'residue\n') {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

/** A git repository whose .gitignore is the template's, with both residue entries planted. */
function residueRepo() {
  const dir = tempDir('nesah-clean-')
  git(dir, ['init', '-q'])
  copyFileSync(TEMPLATE_GITIGNORE, join(dir, '.gitignore'))
  plant(dir, '.harness/stop-output/validate.log')
  plant(dir, 'apps/mobile/dist/bundle.js')
  return dir
}

// ── the clean list ─────────────────────────────────────────────────────────────────────────

test('the clean list is the two entries #43 names, and each is ignored by template/base/gitignore', () => {
  assert.deepEqual([...CLEAN_LIST], ['.harness/stop-output/', 'apps/mobile/dist/'])
  const dir = tempDir('nesah-clean-ignore-')
  git(dir, ['init', '-q'])
  copyFileSync(TEMPLATE_GITIGNORE, join(dir, '.gitignore'))
  for (const entry of CLEAN_LIST) {
    const r = spawnSync('git', ['check-ignore', '-q', '--', entry], { cwd: dir })
    assert.equal(r.status, 0, `${entry} is not ignored by template/base/gitignore`)
  }
})

test('never listed: the manifest, pending/, rollback/, turn.lock, the *.jsonl ledgers and the .ok stamps', () => {
  const never = ['.harness/manifest.json', '.harness/pending/', '.harness/rollback/', '.harness/turn.lock']
  for (const entry of CLEAN_LIST) {
    assert.ok(!never.some((n) => entry.startsWith(n) || n.startsWith(entry)), entry)
    assert.ok(!entry.endsWith('.jsonl') && !entry.endsWith('.ok'), entry)
  }
  // And behaviourally: a full clean of a tree holding all of them leaves every one in place.
  const dir = residueRepo()
  const kept = [
    '.harness/manifest.json',
    '.harness/pending/tools/check-x.mjs',
    '.harness/rollback/blob.json',
    '.harness/turn.lock',
    '.harness/turn-outcomes.jsonl',
    '.harness/reviewer-verdicts.jsonl',
    '.harness/validate.ok',
    '.harness/stamps/contracts.ok',
  ].map((rel) => plant(dir, rel))
  const lines = cleanResidue(dir, { clean: true, dryRun: false })
  assert.ok(!existsSync(join(dir, '.harness/stop-output')), lines.join('\n'))
  for (const abs of kept) assert.ok(existsSync(abs), `${abs} was removed`)
})

// ── --clean ────────────────────────────────────────────────────────────────────────────────

test('without --clean nothing is removed and nothing is printed', () => {
  const dir = residueRepo()
  assert.deepEqual(cleanResidue(dir, {}), [])
  assert.ok(existsSync(join(dir, '.harness/stop-output/validate.log')))
  assert.ok(existsSync(join(dir, 'apps/mobile/dist/bundle.js')))
})

test('--clean removes both entries and names each one', () => {
  const dir = residueRepo()
  const lines = cleanResidue(dir, { clean: true })
  assert.deepEqual(lines, ['clean: removed .harness/stop-output/', 'clean: removed apps/mobile/dist/'])
  assert.ok(!existsSync(join(dir, '.harness/stop-output')))
  assert.ok(!existsSync(join(dir, 'apps/mobile/dist')))
  assert.ok(existsSync(join(dir, 'apps/mobile')), 'only the listed directory goes')
})

test('--clean --dry-run lists both entries and removes nothing', () => {
  const dir = residueRepo()
  const lines = cleanResidue(dir, { clean: true, dryRun: true })
  assert.deepEqual(lines, [
    'clean --dry-run: would remove .harness/stop-output/',
    'clean --dry-run: would remove apps/mobile/dist/',
  ])
  assert.ok(existsSync(join(dir, '.harness/stop-output/validate.log')))
  assert.ok(existsSync(join(dir, 'apps/mobile/dist/bundle.js')))
})

test('an absent entry is reported as nothing to remove', () => {
  const dir = residueRepo()
  cleanResidue(dir, { clean: true })
  assert.deepEqual(cleanResidue(dir, { clean: true }), [
    'clean: nothing at .harness/stop-output/',
    'clean: nothing at apps/mobile/dist/',
  ])
})

test('skip: the target is not a git repository, so nothing proves an entry is ignored', () => {
  const dir = tempDir('nesah-clean-nogit-')
  // A git repository above tmpdir would answer for this directory, so git is told to stop
  // looking at the fixture's parent: the case is proven on every machine, never passed over.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir)
  try {
    const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    assert.notEqual(probe.status, 0, 'fixture precondition: the directory is in no git repository')
    plant(dir, '.harness/stop-output/validate.log')
    const lines = cleanResidue(dir, { clean: true })
    assert.equal(lines.length, CLEAN_LIST.length)
    for (const line of lines) assert.match(line, /^clean: skipped .* not a git repository/)
    assert.ok(existsSync(join(dir, '.harness/stop-output/validate.log')))
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = ceiling
  }
})

test('skip: an entry outside the target directory', () => {
  const dir = residueRepo()
  const line = cleanEntry(dir, '../escape/', false)
  assert.match(line, /^clean: skipped \.\.\/escape\/ — .*not inside/)
  assert.match(cleanEntry(dir, '/etc/', false), /^clean: skipped \/etc\/ — .*not inside/)
  assert.match(cleanEntry(dir, './', false), /^clean: skipped \.\/ — .*not inside/)
})

test('skip: an entry reached through a symlink (the entry itself, or a parent)', () => {
  const outside = tempDir('nesah-clean-outside-')
  const victim = plant(outside, 'dist/keep.js')
  plant(outside, 'stop/keep.log')

  const dir = tempDir('nesah-clean-link-')
  git(dir, ['init', '-q'])
  copyFileSync(TEMPLATE_GITIGNORE, join(dir, '.gitignore'))
  mkdirSync(join(dir, 'apps'), { recursive: true })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  // 'junction' lets Windows create a directory link without privileges; POSIX ignores it.
  symlinkSync(outside, join(dir, 'apps', 'mobile'), 'junction')
  symlinkSync(join(outside, 'stop'), join(dir, '.harness', 'stop-output'), 'junction')

  const lines = cleanResidue(dir, { clean: true })
  assert.match(lines[0], /^clean: skipped \.harness\/stop-output\/ — .*symlink/)
  assert.match(lines[1], /^clean: skipped apps\/mobile\/dist\/ — .*symlink/)
  assert.ok(existsSync(victim))
  assert.ok(existsSync(join(outside, 'stop', 'keep.log')))
})

test('skip: an entry git does not ignore at run time', () => {
  const dir = residueRepo()
  // A project that un-ignores its mobile export (a committed web build, say).
  writeFileSync(join(dir, '.gitignore'), `${readFileSync(join(dir, '.gitignore'), 'utf8')}\n!dist/\n`)
  const lines = cleanResidue(dir, { clean: true })
  assert.equal(lines[0], 'clean: removed .harness/stop-output/')
  assert.match(lines[1], /^clean: skipped apps\/mobile\/dist\/ — .*not ignored/)
  assert.ok(existsSync(join(dir, 'apps/mobile/dist/bundle.js')))
})

test('skip: an ignored entry that holds a tracked file (force-added)', () => {
  const dir = residueRepo()
  git(dir, ['add', '-f', 'apps/mobile/dist/bundle.js'])
  git(dir, ['commit', '-qm', 'force-add a build file'])
  const lines = cleanResidue(dir, { clean: true, dryRun: true })
  assert.match(lines[1], /^clean: skipped apps\/mobile\/dist\/ — .*tracked/)
  cleanResidue(dir, { clean: true })
  assert.ok(existsSync(join(dir, 'apps/mobile/dist/bundle.js')))
})

// ── the toolchain report ───────────────────────────────────────────────────────────────────

test('probeCommand: a working binary reports where it is and the first line of its version', () => {
  const r = probeCommand(process.execPath, ['--version'], { cwd: tmpdir() })
  assert.equal(r.found, process.execPath)
  assert.equal(r.version, process.version)
  assert.equal(r.reason, undefined)
})

test('probeCommand: a failing binary is not probed, with its exit status, and never throws', () => {
  const r = probeCommand(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], { cwd: tmpdir() })
  assert.equal(r.found, process.execPath)
  assert.equal(r.version, undefined)
  assert.match(r.reason, /exit 3/)
  assert.match(r.reason, /boom/)
})

test('probeCommand: a binary that hangs is stopped by the timeout and reported as timed out', () => {
  const started = Date.now()
  const r = probeCommand(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: tmpdir(), timeout: 300 })
  assert.ok(Date.now() - started < 15_000, 'the timeout did not stop the probe')
  assert.equal(r.version, undefined)
  assert.match(r.reason, /timed out/)
})

test('probeCommand: a name on no PATH entry, and an absolute path that does not exist', () => {
  const none = probeCommand('nesah-no-such-tool-43', ['--version'], { cwd: tmpdir() })
  assert.equal(none.found, null)
  assert.match(none.reason, /not found on PATH/)
  const gone = probeCommand(join(tmpdir(), 'nesah-gone-43', 'supabase'), ['--version'], { cwd: tmpdir() })
  assert.equal(gone.found, null)
  assert.match(gone.reason, /does not exist/)
})

test('probeCommand: a bare name resolves through the PATH it is given (PATHEXT on win32)', () => {
  const dir = tempDir('nesah-probe-path-')
  const file = join(dir, process.platform === 'win32' ? 'nesah-fake-tool.EXE' : 'nesah-fake-tool')
  writeFileSync(file, 'not a program\n')
  chmodSync(file, 0o755)
  const r = probeCommand('nesah-fake-tool', ['--version'], { cwd: dir, env: { PATH: dir, PATHEXT: '.EXE' } })
  assert.equal(r.found, file)
  // It is found, and it cannot run: that is "not probed", with a reason, and no throw.
  assert.equal(r.version, undefined)
  assert.ok(r.reason, JSON.stringify(r))
})

test('probeCommand with platform win32 injected: a bare name resolves only with a PATHEXT extension', () => {
  // Runs on every leg: the lookup is pure over the injected env and platform.
  const dir = tempDir('nesah-probe-win-')
  writeFileSync(join(dir, 'nesah-shimmed'), '#!/bin/sh\n') // the POSIX script npm puts beside a .cmd shim
  writeFileSync(join(dir, 'nesah-shimmed.CMD'), '@echo off\r\n')
  const r = probeCommand('nesah-shimmed', ['--version'], {
    cwd: dir,
    env: { Path: dir, PATHEXT: '.EXE;.CMD' },
    platform: 'win32',
  })
  assert.equal(r.found, join(dir, 'nesah-shimmed.CMD'))
  assert.ok(r.reason, 'a .cmd shim cannot be started without a shell: not probed')
  const none = probeCommand('nesah-absent', ['--version'], { cwd: dir, env: { Path: dir }, platform: 'win32' })
  assert.equal(none.found, null)
})

/** A fake probe: node works, pnpm fails, psql times out, the PATH supabase throws. */
function fakeProbe(calls) {
  /** @type {import('../../installer/lib/toolchain.mjs').Probe} */
  return (bin, args, { cwd }) => {
    calls.push({ bin, args, cwd })
    if (bin === 'node') return { found: '/fake/bin/node', version: 'v22.99.0' }
    if (bin === 'pnpm') return { found: '/fake/bin/pnpm', reason: 'exit 1: pnpm exploded' }
    if (bin === 'psql') return { found: '/fake/bin/psql', reason: 'timed out after 10s' }
    if (bin === 'supabase') throw new Error('the probe itself crashed')
    return { found: bin, version: '2.118.0' } // the workspace copy, by absolute path
  }
}

/** A probe that finds every tool and reads a version from each. */
const allGood = (bin) => ({ found: `/fake/bin/${basename(bin)}`, version: '1.2.3' })

test('toolchainReport names each tool, the binary, its version or why it was not probed, and its pin', async () => {
  const dir = await freshInstall('nesah-toolchain-')
  const calls = []
  const lines = toolchainReport(dir, fakeProbe(calls))
  const text = lines.join('\n')
  const catalog = catalogEntry(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), 'supabase')
  assert.ok(catalog, 'fixture precondition: the install catalogues the supabase CLI')
  const nodePin = readFileSync(join(dir, '.node-version'), 'utf8').trim()
  const pm = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager.split('+')[0]

  assert.equal(lines.length, 5, text)
  assert.match(lines[0], /^toolchain: node — \/fake\/bin\/node, v22\.99\.0; pin: /)
  assert.ok(lines[0].endsWith(`pin: .node-version ${nodePin}`), lines[0])
  assert.match(lines[1], /^toolchain: pnpm — not probed \(exit 1: pnpm exploded\)/)
  assert.ok(lines[1].endsWith(`pin: package.json packageManager ${pm}`), lines[1])
  assert.match(lines[2], /^toolchain: supabase \(workspace\) — node_modules\/\.bin\/supabase, 2\.118\.0; pin: /)
  assert.ok(lines[2].endsWith(`pin: pnpm-workspace.yaml catalog ${catalog}`), lines[2])
  assert.match(lines[3], /^toolchain: supabase \(PATH\) — not probed \(probe failed: the probe itself crashed\)/)
  assert.match(lines[4], /^toolchain: psql — not probed \(timed out after 10s\); pin: supabase\/config\.toml \[db\] major_version \d+$/)
  assert.ok(!/missing/i.test(text), 'a tool that could not be probed is "not probed", never "missing"')
  // Every probe asks for a version from the install's own directory.
  assert.ok(calls.every((c) => c.cwd === dir && c.args.join(' ') === '--version'), JSON.stringify(calls))
})

test('toolchainReport: absent pin sources are named as absent, not guessed', () => {
  const dir = tempDir('nesah-toolchain-bare-')
  const lines = toolchainReport(dir, allGood)
  assert.match(lines[0], /pin: none \(\.node-version is absent\)$/)
  assert.match(lines[1], /pin: none \(package\.json names no packageManager\)$/)
  assert.match(lines[2], /pin: none \(pnpm-workspace\.yaml catalogues no supabase\)$/)
  assert.match(lines[4], /pin: none \(supabase\/config\.toml sets no \[db\] major_version\)$/)
  // The real probe on a workspace copy that is not installed: named relative to the install.
  const real = toolchainReport(dir)
  assert.match(real[2], /^toolchain: supabase \(workspace\) — not probed \(node_modules\/\.bin\/supabase does not exist\)/)
})

test('toolchainReport: a relative target still probes the workspace copy by its absolute path', () => {
  const dir = tempDir('nesah-toolchain-rel-')
  /** @type {string[]} */
  const bins = []
  toolchainReport(relative(process.cwd(), dir) || '.', (bin) => {
    bins.push(bin)
    return { found: null, reason: 'fake' }
  })
  assert.equal(bins[2], join(dir, 'node_modules', '.bin', 'supabase'))
})

test('doctor prints the toolchain report as info, and a failing, timing-out or throwing probe never moves its exit code', async () => {
  const dir = await freshInstall('nesah-doctor-toolchain-')
  const good = await captured(() => doctor({ dir }, { probe: allGood }))
  const bad = await captured(() => doctor({ dir }, { probe: fakeProbe([]) }))
  assert.match(bad.out, /info +toolchain: node — \/fake\/bin\/node, v22\.99\.0/)
  assert.match(bad.out, /info +toolchain: pnpm — not probed/)
  assert.match(bad.out, /info +toolchain: psql — not probed \(timed out/)
  assert.match(good.out, /info +toolchain: psql — \/fake\/bin\/psql, 1\.2\.3/)
  assert.equal(bad.result, good.result, 'the toolchain report is info only')
})

test('doctor --clean and --clean --dry-run: removal is printed and the exit code does not move', async () => {
  const dir = await freshInstall('nesah-doctor-clean-')
  git(dir, ['init', '-q'])
  const opts = { probe: allGood }
  const baseline = await captured(() => doctor({ dir }, opts))
  plant(dir, '.harness/stop-output/validate.log')
  plant(dir, 'apps/mobile/dist/bundle.js')

  const dry = await captured(() => doctor({ dir, clean: true, dryRun: true }, opts))
  assert.match(dry.out, /info +clean --dry-run: would remove \.harness\/stop-output\//)
  assert.match(dry.out, /info +clean --dry-run: would remove apps\/mobile\/dist\//)
  assert.ok(existsSync(join(dir, '.harness/stop-output/validate.log')))
  assert.ok(existsSync(join(dir, 'apps/mobile/dist/bundle.js')))
  assert.equal(dry.result, baseline.result)

  const real = await captured(() => doctor({ dir, clean: true }, opts))
  assert.match(real.out, /info +clean: removed \.harness\/stop-output\//)
  assert.match(real.out, /info +clean: removed apps\/mobile\/dist\//)
  assert.ok(!existsSync(join(dir, '.harness/stop-output')))
  assert.ok(!existsSync(join(dir, 'apps/mobile/dist')))
  assert.ok(existsSync(join(dir, '.harness/manifest.json')))
  assert.equal(real.result, baseline.result)
})

test('the CLI wires --clean to doctor: `doctor --clean --dry-run` lists and removes nothing', async () => {
  const dir = await freshInstall('nesah-cli-clean-')
  git(dir, ['init', '-q'])
  plant(dir, 'apps/mobile/dist/bundle.js')
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--dir', dir, '--clean', '--dry-run'], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  const out = `${r.stdout}${r.stderr}`
  assert.match(out, /clean --dry-run: would remove apps\/mobile\/dist\//, out)
  assert.match(out, /toolchain: node — /, out)
  assert.ok(existsSync(join(dir, 'apps/mobile/dist/bundle.js')))
})
