// THE FACTORY GATE'S OWN RED-PROOF (0.7.0) — check-plugin-manifest had zero test
// references: the factory-gate class the 0.6.0 changelog names for `hygiene` (no
// canary-registry entry — that registry closes over the shipped chain and the Stop chain,
// and these scripts ship to nobody), so the gate could spend releases with no watched
// failure. No refactor was needed here: this gate's own `usage: ... [repo-root]` line is
// the convention the other 0.7.0 fixture-ability refactors follow — it only ever lacked a
// caller that watched it fail.
//
// Each red fixture is the live repo's plugin surface COPIED, then skewed exactly once — so
// the asserted problem count of 1 proves both halves at once: the skew reds, and nothing
// else about an otherwise-green surface does.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

/** The live plugin surface, copied: the green baseline a single skew is measured against. */
function surfaceCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-plugin-'))
  for (const rel of ['.claude-plugin', 'plugin', 'LICENSE']) {
    cpSync(join(REPO, rel), join(dir, rel), { recursive: true })
  }
  mkdirSync(join(dir, 'template/base/.claude'), { recursive: true })
  for (const sub of ['agents', 'commands', 'skills']) {
    cpSync(join(REPO, `template/base/.claude/${sub}`), join(dir, `template/base/.claude/${sub}`), {
      recursive: true,
    })
  }
  return dir
}

/** @param {string} dir @param {RegExp} want */
function redOnce(dir, want) {
  const { code, out } = run([dir])
  assert.equal(code, 1, out)
  // Exactly one problem: the fixture is the green surface plus one skew, so a second
  // finding would mean the copy itself reds — a fixture bug, not a gate finding.
  assert.match(out, /PLUGIN MANIFEST: 1 problem\(s\):/)
  assert.match(out, want)
}

test('GREEN: the copied surface is clean (the baseline every RED below skews once)', () => {
  const { code, out } = run([surfaceCopy()])
  assert.equal(code, 0, out)
})

test('RED: a manifest referencing a dangling agent path is dead on install, and it is the ONLY finding', () => {
  const dir = surfaceCopy()
  const manifestPath = join(dir, 'plugin/.claude-plugin/plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.agents = ['./agents/ghost.md']
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  redOnce(dir, /plugin\.json agents: \.\/agents\/ghost\.md does not exist/)
})

// #163: the marketplace installs plugin/, and plugin/ is generated. Each skew below is one
// way the installed folder stops being the component files plus README, LICENSE and manifest.
test('RED (#163): an agent edited at its source without regenerating plugin/', () => {
  const dir = surfaceCopy()
  const agent = join(dir, 'template/base/.claude/agents/test-author.md')
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nOne more line.\n`)
  redOnce(dir, /plugin\/agents\/test-author\.md: differs from its source or is missing/)
})

test('RED (#163): a file in plugin/ that is neither generated nor hand-edited', () => {
  const dir = surfaceCopy()
  writeFileSync(join(dir, 'plugin/notes.txt'), 'stray\n')
  redOnce(dir, /plugin\/notes\.txt: neither generated nor hand-edited/)
})

test('RED (#163): a generated file replaced by a symbolic link', (t) => {
  const dir = surfaceCopy()
  const dest = join(dir, 'plugin/commands/adr.md')
  rmSync(dest)
  try {
    symlinkSync(join(dir, 'template/base/.claude/commands/adr.md'), dest)
  } catch {
    t.skip('this platform cannot create a symbolic link')
    return
  }
  redOnce(dir, /plugin\/commands\/adr\.md: differs from its source or is missing/)
})

test('RED (#163): the marketplace pointing at the repository root again', () => {
  const dir = surfaceCopy()
  const path = join(dir, '.claude-plugin/marketplace.json')
  const market = JSON.parse(readFileSync(path, 'utf8'))
  market.plugins[0].source = '.'
  writeFileSync(path, JSON.stringify(market, null, 2))
  redOnce(dir, /plugins\[0\]\.source must be "\.\/plugin"/)
})

test("RED (#163): a plugin README under the directory's 40-word floor, code blocks not counted", () => {
  const dir = surfaceCopy()
  const words = Array.from({ length: 39 }, (_, i) => `w${String(i)}`).join(' ')
  const fence = '`'.repeat(3)
  writeFileSync(join(dir, 'plugin/README.md'), `# Title\n\n${fence}sh\n${words}\n${fence}\n`)
  redOnce(dir, /plugin\/README\.md has 1 words outside code blocks/)
})

test('RED (#163): a non-image file over 256 KiB, which the directory holds for a reviewer', () => {
  const dir = surfaceCopy()
  const big = `${'x'.repeat(256 * 1024)}\n`
  for (const root of ['template/base/.claude', 'plugin']) {
    writeFileSync(join(dir, root, 'skills/designing-mobile-ui/references/motion.md'), big)
  }
  redOnce(dir, /plugin\/skills\/designing-mobile-ui\/references\/motion\.md is 262145 bytes/)
})

test('generate-plugin-folder: --check reds a drifted mirror, --write makes it clean', () => {
  const dir = surfaceCopy()
  for (const rel of [
    'scripts/generate-plugin-folder.mjs',
    'scripts/lib/plugin-folder.mjs',
    'installer/lib/fs-walk.mjs',
  ]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    cpSync(join(REPO, rel), join(dir, rel))
  }
  const agent = join(dir, 'template/base/.claude/agents/dal-author.md')
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nOne more line.\n`)
  writeFileSync(join(dir, 'plugin/stray.md'), 'stray\n')
  const gen = (/** @type {string} */ mode) =>
    spawnSync(process.execPath, [join(dir, 'scripts/generate-plugin-folder.mjs'), mode], {
      encoding: 'utf8',
      env: cleanEnv(),
    })
  const before = gen('--check')
  assert.equal(before.status, 1, before.stderr)
  assert.match(before.stderr, /plugin\/agents\/dal-author\.md: differs/)
  assert.match(before.stderr, /plugin\/stray\.md: not generated and not hand-edited/)
  const write = gen('--write')
  assert.equal(write.status, 0, write.stderr)
  assert.match(write.stdout, /1 written, 1 removed/)
  assert.equal(gen('--check').status, 0)
  assert.equal(run([dir]).code, 0)
})

// 1.1.0 (#62): the repo-side mirror applies docs-sync's fallback-list rule to the SHIPPED
// roster, so a list that splits to nothing, or repeats an entry, reds this repository's CI
// before a scaffold ever runs docs-sync. One skew, one finding.
test('RED (#62): a shipped reviewer whose harnessFallbackModels list is empty or repeats an entry', () => {
  for (const [skew, want] of /** @type {Array<[string, RegExp]>} */ ([
    ['harnessFallbackModels: ,', /security-reviewer\.md: 'harnessFallbackModels' is present but lists no model/],
    ['harnessFallbackModels: fable, fable', /security-reviewer\.md: 'harnessFallbackModels' repeats 'fable'/],
  ])) {
    const dir = surfaceCopy()
    const agent = join(dir, 'template/base/.claude/agents/security-reviewer.md')
    const body = readFileSync(agent, 'utf8')
    const planted = body.replace(/^harnessFallbackModels:.*$/m, skew)
    assert.ok(planted.includes(skew), `the shipped file must carry a list to skew (${skew})`)
    writeFileSync(agent, planted)
    // The source changed, so plugin/'s copy changes with it, or the drift check adds a
    // second finding.
    writeFileSync(join(dir, 'plugin/agents/security-reviewer.md'), planted)
    redOnce(dir, want)
  }
})

test('GREEN: the repo that ships the plugin surface passes its own gate', () => {
  const { code, out } = run([])
  assert.equal(code, 0, out)
  assert.match(out, /PLUGIN MANIFEST: CLEAN/)
})
