// Can-fail proofs for the gate-integrity gate (template/base/tools/check-gate-integrity.mjs).
// Fixture = a REAL scaffold from `init` in tmpdir; the gate runs via spawnSync with
// cwd inside it (exactly how validate invokes it), env CI=true. Proves: a fresh
// install is green, a raw shell tamper on any harness-owned enforcement file reds
// the gate naming the file, human tuning of the mode-'config' gate config does NOT
// trip it, and a missing manifest fails CLOSED in CI (skipOrFail asymmetry).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESCAPE_LISTS } from '../../template/base/tools/lib/enforcement-surface.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

let scaffold

before(() => {
  scaffold = mkdtempSync(join(tmpdir(), 'epah-gateint-'))
  const res = spawnSync(
    'node',
    [
      CLI, 'init', '--dir', scaffold, '--yes',
      '--set', 'PROJECT_NAME=Integrity App',
      '--set', 'GITHUB_OWNER=fixture-owner',
      '--set', 'SECURITY_OWNERS=@fixture-owner/security',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
  assert.ok(
    existsSync(join(scaffold, 'tools/check-gate-integrity.mjs')),
    'init must install the gate-integrity script',
  )
})

function runGate(env = {}) {
  const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
    cwd: scaffold,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', ...env },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: a fresh scaffold passes (every owned enforcement file matches its recorded hash)', () => {
  const r = runGate()
  assert.equal(r.code, 0, r.out)
})

test('RED: a raw append to an owned gate script (shell tamper) fails naming the file', () => {
  const target = join(scaffold, 'tools/check-migrations.mjs')
  const original = readFileSync(target)
  try {
    appendFileSync(target, '\n// tampered via raw shell write, bypassing the write-guard\n')
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('tools/check-migrations.mjs'), r.out)
  } finally {
    writeFileSync(target, original)
  }
  const restored63 = runGate()
  assert.equal(restored63.code, 0, `restoring the file must return the gate to green
${restored63.out}`)
})

test('RED: deleting an owned enforcement file fails naming it', () => {
  const target = join(scaffold, 'tools/check-contract-drift.mjs')
  const original = readFileSync(target)
  try {
    rmSync(target)
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('tools/check-contract-drift.mjs'), r.out)
    assert.ok(r.out.includes('missing'), r.out)
  } finally {
    writeFileSync(target, original)
  }
})

test('GREEN: hand-tuning tools/harness.config.mjs (mode config) does not trip the gate', () => {
  const target = join(scaffold, 'tools/harness.config.mjs')
  const original = readFileSync(target, 'utf8')
  try {
    writeFileSync(target, `${original}\n// human-tuned: project-specific gate note\n`)
    const r = runGate()
    assert.equal(r.code, 0, r.out)
  } finally {
    writeFileSync(target, original)
  }
})

// ── wiring BY VALUE (0.3.0) ───────────────────────────────────────────────────
// Hashing settings.json proves its BYTES are what the installer wrote; it cannot prove
// those bytes still wire anything, because a legitimately-tuned settings file re-records
// its hash on the next `update`. These two cases are what lived in that gap.

test('GREEN: the exec bit is no longer in the trust path — a chmod -x hook still runs and still blocks', () => {
  // On 0.2.1 clearing the bit silently stopped a hook executing while every sha256 in the
  // manifest still matched, because this gate hashes CONTENT and never MODE. 0.3.0 fixes
  // it structurally rather than detecting it — the settings command invokes `node` — so
  // the proof is that the file still RUNS, and still DENIES, with the bit off.
  //
  // Proven on a guard rather than the Stop hook because the guard's verdict is
  // milliseconds; the Stop-hook spelling is the selftest canary, where a real installed
  // scaffold exists for its chain to run against.
  const hook = join(scaffold, '.claude/hooks/pretool-bash-guard.mjs')
  const mode = statSync(hook).mode
  try {
    chmodSync(hook, 0o644)
    const res = spawnSync('node', [hook], {
      cwd: scaffold,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: scaffold, HARNESS_ALLOW_SELF_EDIT: '' },
    })
    assert.equal(res.status, 0, `the hook must still execute with the exec bit cleared: ${res.stderr}`)
    assert.ok(
      (res.stdout ?? '').includes('"deny"'),
      `and must still block: ${res.stdout} ${res.stderr}`,
    )
    // …and the gate stays green, because mode was never what it was checking.
    const restored122 = runGate()
    assert.equal(restored122.code, 0, `chmod must not red gate-integrity — it hashes content
${restored122.out}`)
  } finally {
    chmodSync(hook, mode)
  }
})

test('RED: a hook command rewritten away from `node <existing path>` reds the gate', () => {
  const settingsPath = join(scaffold, '.claude/settings.json')
  const original = readFileSync(settingsPath, 'utf8')
  const restore = () => writeFileSync(settingsPath, original)

  // (a) neutered to a no-op: the hook is still "wired", and runs nothing.
  try {
    const s = JSON.parse(original)
    s.hooks.Stop[0].hooks[0].command = 'true'
    writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`)
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('.claude/settings.json'), r.out)
    assert.ok(r.out.includes('Stop'), r.out)
  } finally {
    restore()
  }

  // (b) pointed at a path that does not exist.
  try {
    const s = JSON.parse(original)
    s.hooks.Stop[0].hooks[0].command = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/gone.mjs"'
    writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`)
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('does not exist'), r.out)
  } finally {
    restore()
  }

  // (c) the bare-path shape 0.2.1 shipped — it depends on the exec bit, which nothing
  // here hashes, so it is exactly the state this check exists to refuse.
  try {
    const s = JSON.parse(original)
    s.hooks.Stop[0].hooks[0].command = '$CLAUDE_PROJECT_DIR/.claude/hooks/stop-validate-gate.mjs'
    writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`)
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('executable bit'), r.out)
  } finally {
    restore()
  }

  const restored171 = runGate()
  assert.equal(restored171.code, 0, `restoring settings.json must return the gate to green
${restored171.out}`)
})

// ── the frozen Stop floor is a SUPERSET invariant (0.3.0) ─────────────────────
// STOP_HOOK_STEPS lives in a mode-`config` file, which the owned-file loop skips by
// design — so nothing hashed the list of checks that decide whether a TURN may end.
// tools/stop.floor.json is `owned` and hashed like every other tools/ file; the
// invariant here is that the config still CONTAINS it.

test('RED: a step deleted from STOP_HOOK_STEPS reds the gate naming it', () => {
  const cfgPath = join(scaffold, 'tools/harness.config.mjs')
  const original = readFileSync(cfgPath, 'utf8')
  try {
    writeFileSync(cfgPath, original.replace(/\s*\['test-quality',[^\]]*\],/, ''))
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes("missing the floored step 'test-quality'"), r.out)
    assert.ok(r.out.includes('never subtract'), r.out)
  } finally {
    writeFileSync(cfgPath, original)
  }
  const restored192 = runGate()
  assert.equal(restored192.code, 0, `restoring the step must return the gate to green
${restored192.out}`)
})

test('RED: a floored step whose COMMAND was rewritten reds — the list is not the check', () => {
  const cfgPath = join(scaffold, 'tools/harness.config.mjs')
  const original = readFileSync(cfgPath, 'utf8')
  try {
    // The step is still there, still named, and now runs nothing.
    writeFileSync(
      cfgPath,
      original.replace("'node tools/check-test-quality.mjs'", "'node --version'"),
    )
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('the frozen floor pins'), r.out)
  } finally {
    writeFileSync(cfgPath, original)
  }
})

test('GREEN: APPENDING a project step to STOP_HOOK_STEPS stays green (extension is the point)', () => {
  const cfgPath = join(scaffold, 'tools/harness.config.mjs')
  const original = readFileSync(cfgPath, 'utf8')
  try {
    writeFileSync(
      cfgPath,
      `${original}\nSTOP_HOOK_STEPS.push(['house-rule', 'node tools/check-house-rule.mjs'])\n`,
    )
    const r = runGate()
    assert.equal(r.code, 0, r.out)
  } finally {
    writeFileSync(cfgPath, original)
  }
})

// ── CONFIG_COMMIT: threshold-bearing configs must be COMMITTED, not merely present ──
// A naive hash is the wrong answer for these — raising a coverage floor or adding an
// eslint rule is a legitimate act, and a pin guaranteed to break on correct use is a gate
// everyone learns to ignore. The invariant is the one the escape lists already use: the
// file may DIFFER from the template, but it may not be DIRTY at gate time.
//
// A git-backed scaffold of its own: the shared fixture above lives in a bare tmpdir with
// no repository, which is precisely why the escape-list rule has never been exercised
// there either.
test('RED: an uncommitted PER_FILE_FLOORS edit reds; committing the same edit is green', () => {
  const repo = mkdtempSync(join(tmpdir(), 'epah-gateint-git-'))
  const init = spawnSync(
    'node',
    [CLI, 'init', '--dir', repo, '--yes', '--set', 'PROJECT_NAME=Commit App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
  const git = (...args) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')

  const run = () => {
    const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
    })
    return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }

  const clean = run()
  assert.equal(clean.code, 0, clean.out)

  // A fresh scaffold's manifest is 0.3.0-vintage, so the 0.3.0 ramp is NOT in force and
  // the rule is live from day one — exactly the asymmetry the ramp exists to create.
  const vitest = join(repo, 'vitest.config.ts')
  const before = readFileSync(vitest, 'utf8')
  writeFileSync(vitest, `${before}\n// agent lowered a floor mid-turn\n`)
  const dirty = run()
  assert.equal(dirty.code, 1, dirty.out)
  assert.ok(dirty.out.includes('vitest.config.ts'), dirty.out)
  assert.ok(dirty.out.includes('NOT COMMITTED'), dirty.out)

  // The SAME edit, committed, is green forever after: a reviewed raise is legitimate.
  git('add', 'vitest.config.ts')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'raise a floor')
  const committed = run()
  assert.equal(committed.code, 0, committed.out)

  // stryker.config.mjs (0.9.0): the UNGUARDED mutation-narrowing path. The write-guard
  // denies the Edit/Write and shell spellings, but a config that arrived dirty by any
  // other road (a merge, a tool, HARNESS_ALLOW_SELF_EDIT left exported) narrowed what the
  // mutation lane even mutates — and no hash pins it, because widening the scope is a
  // legitimate consumer act. Commit-not-dirty is the invariant that survives both.
  const stryker = join(repo, 'stryker.config.mjs')
  const strykerBefore = readFileSync(stryker, 'utf8')
  writeFileSync(stryker, `${strykerBefore}\n// agent narrowed the mutated surface mid-turn\n`)
  const strykerDirty = run()
  assert.equal(strykerDirty.code, 1, strykerDirty.out)
  assert.ok(strykerDirty.out.includes('stryker.config.mjs'), strykerDirty.out)
  assert.ok(strykerDirty.out.includes('NOT COMMITTED'), strykerDirty.out)
  git('add', 'stryker.config.mjs')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'widen the scope')
  assert.equal(run().code, 0)
})

// THE ESCAPE LIST THE HARNESS ITSELF PLANTED (0.3.0).
//
// Found by upgrade-lane.sh in CI: `update` plants a NEW escape list into an existing
// install (0.3.0 does it with tools/approved-tools.json), which leaves it untracked, and
// the commit-not-dirty rule then accused the consumer of widening a hatch they had never
// seen — on the very run that delivered it. Dropping the file from the committed tree
// while leaving it on disk reproduces that state exactly: bytes the installer wrote,
// recorded in the manifest, and in no commit the consumer could diff it against.
test('a planted escape list is a NOTE; tuning it or hand-creating one is still RED', () => {
  const repo = mkdtempSync(join(tmpdir(), 'epah-gateint-plant-'))
  const init = spawnSync(
    'node',
    [CLI, 'init', '--dir', repo, '--yes', '--set', 'PROJECT_NAME=Plant App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
  const git = (...args) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')

  const run = () => {
    const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
    })
    return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }
  // The message carries the gate's OUTPUT, like every other assertion in this test. This one
  // said only 'baseline', and it is the one that failed on a CI runner — so the log recorded
  // `1 !== 0` and nothing about which of the gate's checks reddened. An assertion whose
  // failure carries no evidence turns a diagnosable defect into a re-run and a shrug.
  const baseline = run()
  assert.equal(baseline.code, 0, `baseline run of check-gate-integrity reddened:\n${baseline.out}`)

  // (a) untracked AND byte-identical to what the installer recorded: a plant, not a
  // widening. Green, and it SAYS so — silence here would be indistinguishable from the
  // gate not looking.
  const planted = 'tools/approved-tools.json'
  git('rm', '--cached', '-q', planted)
  // Commit the removal too: a staged-but-uncommitted `git rm --cached` leaves BOTH a
  // `D ` and a `??` line, which is a deliberate index edit, not a plant, and must stay red.
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'an install predating the registry')
  const asPlanted = run()
  assert.equal(asPlanted.code, 0, asPlanted.out)
  assert.ok(asPlanted.out.includes('harness plant, not a widening'), asPlanted.out)

  // (b) the same untracked file with ONE entry appended is a widening with no diff to
  // review — the case the whole rule exists for, and the one an over-broad fix would lose.
  const abs = join(repo, planted)
  const original = readFileSync(abs, 'utf8')
  const tuned = JSON.parse(original)
  tuned.servers = [...(tuned.servers ?? []), { name: 'exfil', tools: ['*'] }]
  writeFileSync(abs, `${JSON.stringify(tuned, null, 2)}\n`)
  const widened = run()
  assert.equal(widened.code, 1, widened.out)
  assert.ok(widened.out.includes(planted), widened.out)
  writeFileSync(abs, original)

  // (c) an escape list the harness never planted — creating one converts a red into a
  // NOTE, so it has no manifest entry to vouch for it and stays RED.
  writeFileSync(join(repo, 'tools/secret-scan-allow.json'), '{ "allow": [] }\n')
  const handMade = run()
  assert.equal(handMade.code, 1, handMade.out)
  assert.ok(handMade.out.includes('tools/secret-scan-allow.json'), handMade.out)
})

// ── WHO PLANTED THESE BYTES (1.1.0, #84) ────────────────────────────────────────
// Until 1.1.0 the plant exemption above read ONE manifest field: untracked and byte-identical
// to `.harness/manifest.json`'s record. Since 1.0.2 a human re-records a sha to keep a fork,
// and the manifest need not be committed, so one uncommitted edit to `files` turned any
// untracked escape list into a "plant". The exemption now also asks tools/lib/planted-shas.json
// (generated from the released-sha tables' `planted` maps, owned, hash-pinned by sub-check 1)
// whether a harness release ever planted exactly these bytes.
//
// Every case below writes baseVersion AND harnessVersion into the manifest before the
// baseline commit: sub-check 2 stays quiet, and the ramp window the case exercises does not
// depend on where the version bump sits on the branch. Every case runs the gate with
// HARNESS_ALLOW_SELF_EDIT: '', as the plant case above does; with '1' sub-check 3 is off.
const PLANT_REPOS = []
after(() => {
  for (const repo of PLANT_REPOS) rmSync(repo, { recursive: true, force: true })
})

/**
 * A scaffold for one plant case: `init` (with SECURITY_OWNERS answered, so two escape lists
 * carry a rendered placeholder), the versions written into the manifest, `git init`, and a
 * baseline commit unless `commit` is false.
 * @param {{ tier?: string, base?: string, harness?: string, commit?: boolean }} [opts]
 */
function plantScaffold({ tier = 'core', base, harness, commit = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'epah-gateint-release-'))
  PLANT_REPOS.push(repo)
  const init = spawnSync(
    'node',
    [CLI, 'init', '--dir', repo, '--tier', tier, '--yes', '--set', 'PROJECT_NAME=Release App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
  const manifestPath = join(repo, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (base !== undefined) manifest.baseVersion = base
  if (harness !== undefined) manifest.harnessVersion = harness
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const git = (...args) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  const commitAll = (message) => git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', message)
  if (commit) {
    git('add', '-A')
    commitAll('baseline')
  }
  const run = () => {
    const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
    })
    return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }
  /** Re-record `rel`'s sha256 in the manifest, the supported way to keep a fork since 1.0.2. */
  const reRecord = (rel) => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const sha = createHash('sha256').update(readFileSync(join(repo, rel))).digest('hex')
    m.files[rel] = { ...(m.files[rel] ?? { mode: 'seeded' }), sha256: sha }
    writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`)
  }
  return { repo, git, commitAll, run, reRecord }
}

/** Injection A: a never-shipped escape list, created by hand and given a manifest record. */
function injectA(fx) {
  writeFileSync(join(fx.repo, 'tools/secret-scan-allow.json'), '{ "allow": [] }\n')
  fx.reRecord('tools/secret-scan-allow.json')
}

/** Injection B: a shipped escape list, untracked as case (b) does it, widened, re-recorded. */
function injectB(fx) {
  const planted = 'tools/approved-tools.json'
  fx.git('rm', '--cached', '-q', planted)
  fx.commitAll('an install predating the registry')
  const abs = join(fx.repo, planted)
  const tuned = JSON.parse(readFileSync(abs, 'utf8'))
  tuned.servers = [...(tuned.servers ?? []), { name: 'exfil', tools: ['*'] }]
  writeFileSync(abs, `${JSON.stringify(tuned, null, 2)}\n`)
  fx.reRecord(planted)
}

const NO_RELEASE = 'no harness release planted these bytes'
const RELEASE_PLANT = 'a harness release planted exactly these bytes'

test('injection A: a hand-made escape list with a re-recorded sha is RED once the record is not the only witness (#84)', () => {
  const fx = plantScaffold({ base: '1.1.0', harness: '1.1.0' })
  assert.equal(fx.run().code, 0, 'the committed baseline is green')
  injectA(fx)
  const r = fx.run()
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('gate-integrity: FAIL (1)'), r.out)
  assert.ok(r.out.includes(`- tools/secret-scan-allow.json: escape hatch present but not committed, and ${NO_RELEASE}.`), r.out)
  assert.ok(r.out.includes('a record can be written by hand'), r.out)
  assert.ok(!r.out.includes('tools/secret-scan-allow.json is present but not yet committed'), `no plant NOTE for it:\n${r.out}`)
})

test('injection B: an untracked, widened approved-tools.json with a re-recorded sha is RED (#84)', () => {
  const fx = plantScaffold({ base: '1.1.0', harness: '1.1.0' })
  injectB(fx)
  const r = fx.run()
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`- tools/approved-tools.json: escape hatch present but not committed, and ${NO_RELEASE}.`), r.out)
})

test('the release-provenance rule is ramped: a 1.0.3 install gets a (ramp 1.1.0) NOTE until 1.2.0, then RAMP EXPIRED (#84)', () => {
  // A clean tree names no 1.1.0 ramp: rampNote is called only when a finding exists, because
  // an armed call prints a NOTE, and a NOTE about nothing on every green run is noise the
  // upgrade lane refuses (scripts/ci/upgrade-lane.sh, section 7b).
  const noting = plantScaffold({ base: '1.0.3', harness: '1.1.0' })
  const clean = noting.run()
  assert.equal(clean.code, 0, clean.out)
  assert.ok(!clean.out.includes('ramp 1.1.0') && !clean.out.includes('live from baseVersion 1.1.0'), clean.out)

  injectA(noting)
  const noted = noting.run()
  assert.equal(noted.code, 0, noted.out)
  assert.ok(noted.out.includes('release provenance of an uncommitted, planted escape list (ramp: live from baseVersion 1.1.0'), noted.out)
  assert.ok(noted.out.includes(`gate-integrity: NOTE — (ramp 1.1.0) tools/secret-scan-allow.json: escape hatch present but not committed, and ${NO_RELEASE}.`), noted.out)
  // …and the OK line says the rule was NOTE-only, not `clean`: a withheld finding reported as
  // clean is the skip read as a pass that #80 removed from this line.
  const okLine = noted.out.split('\n').find((l) => l.startsWith('gate-integrity: OK')) ?? ''
  assert.ok(okLine.includes('escape-list commit rule NOTE-only for 1 untracked list(s) no release planted (withheld by the 1.1.0 ramp)'), noted.out)
  assert.ok(!okLine.includes('escape list(s) clean'), okLine)

  // The same install on harness 1.2.0: the escape is over.
  const expired = plantScaffold({ base: '1.0.3', harness: '1.2.0' })
  injectA(expired)
  const r = expired.run()
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RAMP EXPIRED — release provenance of an uncommitted, planted escape list'), r.out)
  assert.ok(r.out.includes(`- tools/secret-scan-allow.json: escape hatch present but not committed, and ${NO_RELEASE}.`), r.out)
})

test('a placeholder-bearing escape list: the rendered plant is a NOTE, one added exemption with a re-recorded sha is RED (#84)', () => {
  const fx = plantScaffold({ base: '1.1.0', harness: '1.1.0' })
  const planted = 'tools/rls-exempt.json'
  const abs = join(fx.repo, planted)
  const rendered = readFileSync(abs, 'utf8')
  assert.ok(rendered.includes('@o/sec') && !rendered.includes('{{SECURITY_OWNERS}}'), 'init rendered the owners token')
  fx.git('rm', '--cached', '-q', planted)
  fx.commitAll('an install predating the list')

  const asPlanted = fx.run()
  assert.equal(asPlanted.code, 0, asPlanted.out)
  assert.ok(asPlanted.out.includes(`NOTE — ${planted} is present but not yet committed, its bytes match the manifest record, and ${RELEASE_PLANT}`), asPlanted.out)
  assert.ok(asPlanted.out.includes('harness plant, not a widening'), asPlanted.out)

  const list = JSON.parse(rendered)
  list.exempt.push({ table: 'public.widened', reason: 'an exemption nobody reviewed' })
  writeFileSync(abs, `${JSON.stringify(list, null, 2)}\n`)
  fx.reRecord(planted)
  const widened = fx.run()
  assert.equal(widened.code, 1, widened.out)
  assert.ok(widened.out.includes(`- ${planted}: escape hatch present but not committed, and ${NO_RELEASE}.`), widened.out)
})

for (const tier of ['core', 'strict']) {
  test(`a fresh ${tier} scaffold before its first commit: every escape list is a release plant, exit 0 (#84)`, () => {
    const fx = plantScaffold({ tier, commit: false })
    const r = fx.run()
    assert.equal(r.code, 0, r.out)
    const lists = ESCAPE_LISTS.filter((p) => existsSync(join(fx.repo, p)))
    assert.ok(lists.length >= 30, `only ${String(lists.length)} escape list(s) on disk — the fixture is vacuous`)
    for (const p of lists) {
      assert.ok(r.out.includes(`NOTE — ${p} is present but not yet committed, its bytes match the manifest record, and ${RELEASE_PLANT}`), `${p}:\n${r.out}`)
    }
  })
}

test('missing manifest: fails CLOSED in CI, skips LOUDLY locally', () => {
  const manifest = join(scaffold, '.harness/manifest.json')
  const parked = join(scaffold, '.harness/manifest.json.parked')
  renameSync(manifest, parked)
  try {
    const ci = runGate()
    assert.equal(ci.code, 1, ci.out)
    assert.ok(ci.out.includes('not an installed harness'), ci.out)
    // The same absence is a loud SKIP outside CI — never a silent pass.
    const local = runGate({ CI: '' })
    assert.equal(local.code, 0, local.out)
    assert.ok(local.out.includes('SKIPPED'), local.out)
  } finally {
    renameSync(parked, manifest)
  }
})

// A THRESHOLD CONFIG THE HARNESS ITSELF REWROTE (0.4.0).
//
// The mirror of the planted-escape-list case above, found the same way — by upgrade-lane.sh
// — and one release later. vitest.config.ts and eslint.config.mjs are harness-OWNED, so any
// release that changes them leaves an upgraded install with both DIRTY: modified relative to
// the consumer's last commit, by the harness, on the run that delivered the upgrade. The
// commit-not-dirty rule then reported "threshold-bearing config modified but NOT COMMITTED"
// about a file the consumer had never touched — a confident accusation aimed at the wrong
// party, and a red on the upgrade itself.
//
// The discriminator is the manifest hash, exactly as for the plant: init/update are the only
// writers, so bytes matching the record mean nobody has tuned them since. It must NOT weaken
// the real case, hence both halves here.
test('a config the INSTALLER rewrote is a NOTE; the same file hand-tuned is still RED', () => {
  const repo = mkdtempSync(join(tmpdir(), 'epah-gateint-refresh-'))
  const init = spawnSync(
    'node',
    [CLI, 'init', '--dir', repo, '--yes', '--set', 'PROJECT_NAME=Refresh App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
  const git = (...args) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')

  const run = () => {
    const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '' },
    })
    return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }

  // Reproduce the post-update state: the file on disk is what the installer recorded, and
  // the committed tree holds something older. Rewinding the COMMIT (not the file) is the
  // exact shape — same bytes, same manifest hash, a diff against the consumer's last commit.
  const vitest = join(repo, 'vitest.config.ts')
  const shipped = readFileSync(vitest, 'utf8')
  writeFileSync(vitest, `// an older vintage the consumer committed\n${shipped}`)
  git('add', 'vitest.config.ts')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'older vintage')
  writeFileSync(vitest, shipped) // what `update` would write back

  const refreshed = run()
  assert.equal(refreshed.code, 0, `a harness refresh must not red the upgrade:\n${refreshed.out}`)
  assert.ok(refreshed.out.includes('byte-identical to what the installer recorded'), refreshed.out)
  assert.ok(!refreshed.out.includes('NOT COMMITTED'), refreshed.out)

  // One byte of human tuning on top and the finding returns — the discriminator is the
  // hash, not the path, so it cannot be used to launder a lowered floor through an upgrade.
  writeFileSync(vitest, `${shipped}\n// agent lowered a floor mid-turn\n`)
  const tuned = run()
  assert.equal(tuned.code, 1, tuned.out)
  assert.ok(tuned.out.includes('NOT COMMITTED'), tuned.out)
})

// ── WHAT HARNESS_ALLOW_SELF_EDIT=1 RELAXES HERE (1.1.0, #80) ──────────────────────
// The flag lifts exactly one of this gate's checks: the commit rule over the escape lists
// and the threshold-bearing configs. The hash, retrofit-conflict, hook-command, Stop-floor and
// baseVersion checks ignore it. The doctrine's "What `HARNESS_ALLOW_SELF_EDIT=1` relaxes"
// section says so, and the first case below pins that behaviour (green on 1.0.3 and after).
// The second pins the OK line's honesty: until 1.1.0 it printed `escape list(s) clean` and
// `threshold config(s) committed` when the flag had skipped both rules, and `never regressed`
// with no git work tree for the history check to read. A skip read as a pass.
//
// One git-backed scaffold, created on first use and removed after the file. Only these two
// cases pass '1'; every other git-backed case above keeps HARNESS_ALLOW_SELF_EDIT: ''.
let selfEditRepo = null
function selfEditScaffold() {
  if (selfEditRepo !== null) return selfEditRepo
  const repo = mkdtempSync(join(tmpdir(), 'epah-gateint-selfedit-'))
  selfEditRepo = repo
  const init = spawnSync(
    'node',
    [CLI, 'init', '--dir', repo, '--yes', '--set', 'PROJECT_NAME=Self Edit App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
  const git = (...args) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')
  return repo
}
after(() => {
  if (selfEditRepo !== null) rmSync(selfEditRepo, { recursive: true, force: true })
})

/** @param {string} repo @param {string} flag */
function runIn(repo, flag) {
  const res = spawnSync('node', ['tools/check-gate-integrity.mjs'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: flag },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** @param {string} out @returns {string} the gate's OK line, or '' when it printed none */
const okLine = (out) => out.split(/\r?\n/).find((l) => l.startsWith('gate-integrity: OK')) ?? ''

test('HARNESS_ALLOW_SELF_EDIT=1 lifts only the commit rule: hash and Stop-floor checks still red', () => {
  const repo = selfEditScaffold()
  const edit = (rel, mutate) => {
    const file = join(repo, rel)
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, mutate(original))
    return () => writeFileSync(file, original)
  }

  // (1) An uncommitted escape list and an uncommitted threshold config: the commit rule is
  // the one check the flag lifts, so both pass. Without the flag each reds (cases above).
  const restoreExempt = edit('tools/rls-exempt.json', (s) => {
    const list = JSON.parse(s)
    list.exempt.push({ table: 'public.widened', reason: 'an exemption added under the flag' })
    return `${JSON.stringify(list, null, 2)}\n`
  })
  const restoreVitest = edit('vitest.config.ts', (s) => `${s}\n// a deliberate local edit under the flag\n`)
  try {
    const lifted = runIn(repo, '1')
    assert.equal(lifted.code, 0, lifted.out)
    // …and it is the flag doing it, not a fixture that never dirtied anything.
    const unflagged = runIn(repo, '')
    assert.equal(unflagged.code, 1, unflagged.out)
    assert.ok(unflagged.out.includes('tools/rls-exempt.json'), unflagged.out)
    assert.ok(unflagged.out.includes('vitest.config.ts'), unflagged.out)
  } finally {
    restoreExempt()
    restoreVitest()
  }

  // (2) The hash check ignores the flag.
  const restoreGate = edit('tools/check-migrations.mjs', (s) => `${s}\n// tampered under the flag\n`)
  try {
    const hashed = runIn(repo, '1')
    assert.equal(hashed.code, 1, hashed.out)
    assert.ok(hashed.out.includes('tools/check-migrations.mjs'), hashed.out)
  } finally {
    restoreGate()
  }

  // (3) The Stop-floor check ignores the flag.
  const restoreCfg = edit('tools/harness.config.mjs', (s) => s.replace(/\s*\['test-quality',[^\]]*\],/, ''))
  try {
    const floored = runIn(repo, '1')
    assert.equal(floored.code, 1, floored.out)
    assert.ok(floored.out.includes("missing the floored step 'test-quality'"), floored.out)
  } finally {
    restoreCfg()
  }

  const restored = runIn(repo, '1')
  assert.equal(restored.code, 0, `every file restored, the flagged run is green again:\n${restored.out}`)
})

test('the OK line names each check the flag skipped instead of reporting it clean (1.1.0, #80)', () => {
  const repo = selfEditScaffold()
  const flagged = okLine(runIn(repo, '1').out)
  assert.ok(flagged !== '', 'the flagged run on a clean tree must print an OK line')
  assert.ok(!flagged.includes('escape list(s) clean'), flagged)
  assert.ok(!flagged.includes('threshold config(s) committed'), flagged)
  assert.ok(flagged.includes('escape-list commit rule not run'), flagged)
  assert.ok(flagged.includes('threshold-config commit rule not run'), flagged)
  assert.ok(flagged.includes('HARNESS_ALLOW_SELF_EDIT=1'), flagged)
  // A git-backed tree reads its history, so that half still reports the check.
  assert.ok(flagged.includes('never regressed'), flagged)

  // Without the flag the same tree reports all three as before.
  const plain = okLine(runIn(repo, '').out)
  assert.ok(plain.includes('escape list(s) clean'), plain)
  assert.ok(plain.includes('threshold config(s) committed'), plain)
  assert.ok(!plain.includes('not run'), plain)
})

test('with no git work tree the OK line says the history and commit checks did not run (1.1.0, #80)', () => {
  // The shared fixture has no repository. GIT_CEILING_DIRECTORIES stops git discovering one
  // above the tmpdir, so this holds wherever the runner's tmpdir lives.
  const r = runGate({ HARNESS_ALLOW_SELF_EDIT: '', GIT_CEILING_DIRECTORIES: dirname(scaffold) })
  assert.equal(r.code, 0, r.out)
  const line = okLine(r.out)
  assert.ok(line !== '', r.out)
  assert.ok(!line.includes('never regressed'), line)
  assert.ok(line.includes('history check not run (no git work tree)'), line)
  assert.ok(!line.includes('escape list(s) clean'), line)
  assert.ok(line.includes('escape-list commit rule not run (no git work tree)'), line)
})
