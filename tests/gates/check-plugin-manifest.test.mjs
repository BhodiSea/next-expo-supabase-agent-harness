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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PLUGIN_SCRIPT, inlineCommands, pluginCopy, toolEntries } from '../../scripts/lib/plugin-folder.mjs'

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
  rmSync(join(dir, 'plugin/commands/new-feature.md'))
  const gen = (/** @type {string} */ mode) =>
    spawnSync(process.execPath, [join(dir, 'scripts/generate-plugin-folder.mjs'), mode], {
      encoding: 'utf8',
      env: cleanEnv(),
    })
  const before = gen('--check')
  assert.equal(before.status, 1, before.stderr)
  assert.match(before.stderr, /plugin\/agents\/dal-author\.md: differs/)
  assert.match(before.stderr, /plugin\/commands\/new-feature\.md: differs/)
  assert.match(before.stderr, /plugin\/stray\.md: not generated and not hand-edited/)
  const write = gen('--write')
  assert.equal(write.status, 0, write.stderr)
  assert.match(write.stdout, /2 written, 1 removed/)
  // A command is written as the plugin's copy of it, not byte for byte.
  const command = readFileSync(join(dir, 'template/base/.claude/commands/new-feature.md'))
  const written = readFileSync(join(dir, 'plugin/commands/new-feature.md'))
  assert.ok(!written.equals(command))
  assert.ok(written.equals(pluginCopy('commands/new-feature.md', command)))
  assert.equal(gen('--check').status, 0)
  assert.equal(run([dir]).code, 0)
})

/**
 * A command's or skill's source and the plugin copy generated from it, written together so a
 * skew of the source is one finding, never a second one for drift.
 * @param {string} dir @param {string} rel @param {string} text
 */
function setPrompt(dir, rel, text) {
  writeFileSync(join(dir, 'template/base/.claude', rel), text)
  writeFileSync(join(dir, 'plugin', rel), pluginCopy(rel, Buffer.from(text, 'utf8')))
}

/** @param {string} dir @param {string} rel @param {string} tools */
function withTools(dir, rel, tools) {
  const text = readFileSync(join(dir, 'template/base/.claude', rel), 'utf8')
  const out = text.replace(/^allowed-tools: .*$/m, `allowed-tools: ${tools}`)
  assert.notEqual(out, text, `${rel} must carry an allowed-tools line to skew`)
  return out
}

test('pluginCopy: a command keeps the commands its `!` lines run and runs the plugin\'s own script; other files are byte copies', () => {
  const source = Buffer.from(
    [
      '---',
      'description: d',
      'allowed-tools: Read, Bash(git status --short), Bash(node .claude/skills/s/scripts/x.mjs:*), Bash(pnpm gen), Bash(node tools/t.mjs), Bash',
      '---',
      '',
      'Run `node .claude/skills/s/scripts/x.mjs $1`, then `pnpm gen`.',
      '',
      'Tree: !`git status --short`',
      '',
    ].join('\n'),
  )
  const copy = pluginCopy('commands/c.md', source).toString('utf8')
  assert.match(copy, /^allowed-tools: Read, Bash\(git status --short\), Bash\(node \$\{CLAUDE_PLUGIN_ROOT\}\/skills\/s\/scripts\/x\.mjs:\*\)$/m)
  assert.ok(copy.includes('Run `node ${CLAUDE_PLUGIN_ROOT}/skills/s/scripts/x.mjs $1`, then `pnpm gen`.'), copy)
  for (const rel of ['agents/a.md', 'skills/s/scripts/x.mjs', 'LICENSE']) {
    assert.ok(pluginCopy(rel, source).equals(source), rel)
  }
})

test('the shipped plugin pre-approves only the commands its `!` lines run and its own scripts', () => {
  const pluginDir = join(REPO, 'plugin')
  const files = [
    ...readdirSync(join(pluginDir, 'commands')).map((f) => `commands/${f}`),
    ...readdirSync(join(pluginDir, 'skills')).map((s) => `skills/${s}/SKILL.md`),
  ]
  for (const rel of files) {
    const text = readFileSync(join(pluginDir, rel), 'utf8')
    const own = inlineCommands(text)
    for (const entry of toolEntries(/^allowed-tools:(.*)$/m.exec(text)?.[1] ?? '')) {
      assert.ok(!['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(entry), `${rel}: ${entry}`)
      const command = /^Bash\((.*)\)$/.exec(entry)?.[1]
      if (command === undefined || own.includes(command)) continue
      assert.ok(command.startsWith(PLUGIN_SCRIPT) && command.endsWith(':*'), `${rel}: ${entry} is neither a \`!\` command nor the plugin's script`)
      assert.ok(existsSync(join(pluginDir, 'skills', command.slice(PLUGIN_SCRIPT.length, -2))), `${rel}: ${entry} names no file`)
    }
  }
})

// A bare entry pre-approves every call of the tool while the command runs; Bash(node:*) and
// a * wildcard are nearly as wide. One skew, one finding.
test('RED: a command that grants every call of a tool, or a rule nearly as wide', () => {
  for (const [extra, want] of /** @type {Array<[string, RegExp]>} */ ([
    ['Bash', /commands\/rls-check\.md: allowed-tools grants every Bash call/],
    ['Edit', /commands\/rls-check\.md: allowed-tools grants every Edit call/],
    ['Write', /commands\/rls-check\.md: allowed-tools grants every Write call/],
    ['Bash(node:*)', /Bash\(node:\*\) pre-approves more than one command/],
    ['Bash(pnpm *)', /Bash\(pnpm \*\) pre-approves more than one command/],
  ])) {
    const dir = surfaceCopy()
    const rel = 'commands/rls-check.md'
    setPrompt(dir, rel, withTools(dir, rel, `Read, Grep, Glob, Bash(git diff --name-only HEAD), Bash(pnpm db:test), ${extra}`))
    redOnce(dir, want)
  }
})

test('RED: a `!` line whose command allowed-tools does not name', () => {
  const dir = surfaceCopy()
  setPrompt(dir, 'commands/verify-citations.md', withTools(dir, 'commands/verify-citations.md', 'Read, Grep, Glob'))
  redOnce(dir, /a `!` line runs `git diff --name-only HEAD`, and allowed-tools has no Bash\(git diff --name-only HEAD\) rule/)
})

test('RED: a script rule naming a file the skills do not ship', () => {
  const dir = surfaceCopy()
  const rel = 'skills/authoring-vertical-slice/SKILL.md'
  const text = readFileSync(join(dir, 'template/base/.claude', rel), 'utf8')
  setPrompt(dir, rel, text.replace('scripts/scaffold-slice.mjs:*)', 'scripts/scaffold.mjs:*)'))
  redOnce(dir, /Bash\(node \.claude\/skills\/authoring-vertical-slice\/scripts\/scaffold\.mjs:\*\) names a script the skills do not ship/)
})

/**
 * A PNG of the given size. The gate reads the signature, the IHDR size and the IEND, not the
 * checksums or the pixels.
 * @param {number} width @param {number} height @param {number} [padding]
 */
function png(width, height, padding = 0) {
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(padding > 0 ? [chunk('IDAT', Buffer.alloc(padding))] : []),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('RED: an icon that is missing, or not a square PNG of 512 to 2048 pixels under 2 MB', () => {
  /** @param {string} dir @param {(m: Record<string, unknown>) => void} edit */
  const setManifest = (dir, edit) => {
    const path = join(dir, 'plugin/.claude-plugin/plugin.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    edit(manifest)
    writeFileSync(path, JSON.stringify(manifest, null, 2))
  }
  /** @param {string} dir @param {Buffer} bytes */
  const setIcon = (dir, bytes) => writeFileSync(join(dir, 'plugin/.claude-plugin/icon.png'), bytes)
  for (const [skew, want] of /** @type {Array<[(dir: string) => void, RegExp]>} */ ([
    [(dir) => setManifest(dir, (m) => delete m['icon']), /plugin\.json: icon must name an image inside the plugin/],
    [(dir) => setManifest(dir, (m) => (m['icon'] = './.claude-plugin/logo.png')), /icon: \.\/\.claude-plugin\/logo\.png does not exist/],
    [(dir) => setIcon(dir, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n')), /icon\.png is not a complete PNG/],
    [(dir) => setIcon(dir, png(1024, 512)), /icon\.png is 1024 x 512 pixels; an icon must be square/],
    [(dir) => setIcon(dir, png(256, 256)), /icon\.png is 256 x 256 pixels/],
    [(dir) => setIcon(dir, png(1024, 1024, 2_000_000)), /icon\.png is \d+ bytes; an icon must be under 2 MB/],
  ])) {
    const dir = surfaceCopy()
    skew(dir)
    redOnce(dir, want)
  }
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
