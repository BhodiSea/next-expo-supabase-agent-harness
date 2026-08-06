// Can-fail proofs for the gate-integrity gate (template/base/tools/check-gate-integrity.mjs).
// Fixture = a REAL scaffold from `init` in tmpdir; the gate runs via spawnSync with
// cwd inside it (exactly how validate invokes it), env CI=true. Proves: a fresh
// install is green, a raw shell tamper on any harness-owned enforcement file reds
// the gate naming the file, human tuning of the mode-'config' gate config does NOT
// trip it, and a missing manifest fails CLOSED in CI (skipOrFail asymmetry).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  assert.equal(runGate().code, 0, 'restoring the file must return the gate to green')
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
    assert.equal(runGate().code, 0, 'chmod must not red gate-integrity — it hashes content')
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

  assert.equal(runGate().code, 0, 'restoring settings.json must return the gate to green')
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
  assert.equal(runGate().code, 0, 'restoring the step must return the gate to green')
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
  assert.equal(run().code, 0, 'baseline')

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
