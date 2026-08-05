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
