// THE FACTORY GATE'S OWN RED-PROOF (0.7.0) — check-plugin-manifest had zero test
// references: the factory-gate class the 0.6.0 changelog names for `hygiene` (no
// canary-registry entry — that registry closes over the shipped chain and the Stop chain,
// and these scripts ship to nobody), so the gate could spend releases with no watched
// failure. No refactor was needed here: this gate's own `usage: ... [repo-root]` line is
// the convention the other 0.7.0 fixture-ability refactors follow — it only ever lacked a
// caller that watched it fail.
//
// The red fixture is the live repo's plugin surface COPIED, then skewed by exactly one
// dangling agent path — so the asserted problem count of 1 proves both halves at once:
// the dangling reference reds, and nothing else about an otherwise-green surface does.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts/check-plugin-manifest.mjs')

// The lane-env doctrine: the local suite runs CI-shaped, so scrub the vars a leaked
// environment could steer a spawned gate with, even where the gate reads none today.
function cleanEnv() {
  const env = { ...process.env }
  for (const k of ['CI', 'HARNESS_REQUIRE_TOOLCHAINS', 'HARNESS_ALLOW_SELF_EDIT', 'GITHUB_BASE_REF']) {
    delete env[k]
  }
  return env
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: cleanEnv() })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('RED: a manifest referencing a dangling agent path is dead on install, and it is the ONLY finding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-plugin-'))
  cpSync(join(REPO, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'template/base/.claude'), { recursive: true })
  // Every path surface the manifest references: agents (the roster), commands, skills.
  for (const sub of ['agents', 'commands', 'skills']) {
    cpSync(join(REPO, `template/base/.claude/${sub}`), join(dir, `template/base/.claude/${sub}`), {
      recursive: true,
    })
  }
  const manifestPath = join(dir, '.claude-plugin/plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.agents.push('./template/base/.claude/agents/ghost.md')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const { code, out } = run([dir])
  assert.equal(code, 1, `a dangling agent path must red:\n${out}`)
  // Exactly one problem: the fixture is the green surface plus one skew, so a second
  // finding would mean the copy itself reds — a fixture bug, not a gate finding.
  assert.match(out, /PLUGIN MANIFEST: 1 problem\(s\):/)
  assert.match(out, /plugin\.json agents: \.\/template\/base\/\.claude\/agents\/ghost\.md does not exist/)
})

test('GREEN: the repo that ships the plugin surface passes its own gate', () => {
  const { code, out } = run([])
  assert.equal(code, 0, out)
  assert.match(out, /PLUGIN MANIFEST: CLEAN/)
})
