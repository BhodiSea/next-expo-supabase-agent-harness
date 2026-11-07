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
// else about an otherwise-green surface does. A skew of a source the plugin copies whole
// reds in the source and in its copy, and a skew of a generated copy alone also reds as
// drift, so those tests name both findings.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SHELL_AND_WRITE_TOOLS,
  allowedTools,
  generatedFiles,
  pluginCopy,
  toolEntries,
} from '../../scripts/lib/plugin-folder.mjs'

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

/** @param {string} dir @param {RegExp[]} wants */
function red(dir, wants) {
  const { code, out } = run([dir])
  assert.equal(code, 1, out)
  // Exactly these problems: the fixture is the green surface plus one skew, so another
  // finding would mean the copy itself reds — a fixture bug, not a gate finding.
  assert.match(out, new RegExp(`PLUGIN MANIFEST: ${String(wants.length)} problem\\(s\\):`))
  for (const want of wants) assert.match(out, want)
}

/** @param {string} dir @param {RegExp} want */
const redOnce = (dir, want) => red(dir, [want])

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

// The link's target holds the bytes the copy must, so the link alone reds.
test('RED (#163): a generated file replaced by a symbolic link', (t) => {
  const dir = surfaceCopy()
  const dest = join(dir, 'plugin/commands/adr.md')
  cpSync(dest, join(dir, 'adr.md'))
  rmSync(dest)
  try {
    symlinkSync(join(dir, 'adr.md'), dest)
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

// Claude Code 2.1.292 ends an entry at a comma or a space outside parentheses, and the first
// `)` closes a rule's parentheses.
test('toolEntries reads a list as Claude Code does', () => {
  assert.deepEqual(toolEntries(' Read,Grep Glob, Bash(git diff --name-only HEAD) Bash(a (b) c)'), [
    'Read',
    'Grep',
    'Glob',
    'Bash(git diff --name-only HEAD)',
    'Bash(a (b)',
    'c)',
  ])
})

// The plugin directory accepts a command or skill that pre-approves only Read, Grep, Glob and
// LS, with no `${...}`, `//` or `\\` path and no URL, and a frontmatter of keys it knows. The
// copy names the installed project's paths as its source does: the plugin ships no script.
test('pluginCopy: a command or skill pre-approves only reading and searching and keeps only its own keys; other files are byte copies', () => {
  const source = Buffer.from(
    [
      '---',
      'description: d',
      'argument-hint: "[x]"',
      'allowed-tools: Read, Bash(git status --short), LS, Grep(src/**), Read(${CLAUDE_PLUGIN_ROOT}/x), Glob(//etc/**), Read(\\\\host\\share), Read(https://example.com/a), WebFetch, mcp__x, Bash(node .claude/skills/s/scripts/x.mjs:*), Edit',
      'model: opus',
      'disable-model-invocation: true',
      'hooks:',
      '  PreToolUse: []',
      '---',
      '',
      'Run `node .claude/skills/s/scripts/x.mjs $1`.',
      '',
    ].join('\n'),
  )
  const want = ['---', 'description: d', 'argument-hint: "[x]"', 'allowed-tools: Read, LS, Grep(src/**)', 'model: opus', '---', '', 'Run `node .claude/skills/s/scripts/x.mjs $1`.', '']
  assert.equal(pluginCopy('commands/c.md', source).toString('utf8'), want.join('\n'))
  const skill = ['---', 'name: s', 'description: >', '  Two', '  lines.', 'allowed-tools: "Read, Grep, Glob, Bash(pnpm gen)"', 'argument-hint: "[x]"', 'model: opus', '---', 'Body.', '']
  assert.equal(
    pluginCopy('skills/s/SKILL.md', Buffer.from(skill.join('\n'))).toString('utf8'),
    [...skill.slice(0, 5), 'allowed-tools: "Read, Grep, Glob"', 'argument-hint: "[x]"', ...skill.slice(8)].join('\n'),
  )
  // Nothing left to pre-approve: the copy drops the key.
  assert.equal(pluginCopy('commands/c.md', Buffer.from('---\ndescription: d\nallowed-tools: Bash(pnpm gen)\n---\nBody.\n')).toString('utf8'), '---\ndescription: d\n---\nBody.\n')
  // YAML reads the blank and indented comment lines after the list as nothing, so they stay.
  assert.equal(
    pluginCopy('commands/c.md', Buffer.from('---\ndescription: d\nallowed-tools: Read, Bash(pnpm gen)\n\n  # gen needs the stack\nmodel: opus\n---\nBody.\n')).toString('utf8'),
    '---\ndescription: d\nallowed-tools: Read\n\n  # gen needs the stack\nmodel: opus\n---\nBody.\n',
  )
  for (const rel of ['skills/s/scripts/x.mjs', 'skills/s/references/r.md', 'LICENSE']) {
    assert.ok(pluginCopy(rel, source).equals(source), rel)
  }
})

// Claude Code reads mcp__<server> as every tool of whatever server the session has by that
// name, and the plugin ships no MCP server. harnessFallbackModels is the installed project's
// reviewer-verdict tooling's key, not Claude Code's.
test("pluginCopy: an agent keeps only its own keys, a block scalar whole, and drops each MCP entry from tools", () => {
  const agent = [
    '---',
    'name: a',
    'description: >',
    '  Reviews a diff.',
    '  Cannot edit.',
    'tools: Read, mcp__rls_verify, Grep, mcp__x__*, Glob, mcp__x__y',
    'disallowedTools: Write, Edit, mcp__z',
    'model: opus',
    'harnessFallbackModels: fable',
    'color: blue',
    '---',
    '',
    'Probe with `mcp__rls_verify` when the stack is up.',
    '',
  ]
  const copy = pluginCopy('agents/a.md', Buffer.from(agent.join('\n'))).toString('utf8')
  assert.equal(copy, [...agent.slice(0, 5), 'tools: Read, Grep, Glob', ...agent.slice(6, 8), ...agent.slice(10)].join('\n'))
  for (const [tools, want] of [
    ['tools: "Read, mcp__x, Grep"', 'tools: "Read, Grep"'],
    ["tools: 'mcp__x Read'", "tools: 'Read'"],
    // A blank line after the list, and an indented comment, stay after it.
    ['tools: Read, mcp__corpus_search\n\n  # the corpus server', 'tools: Read\n\n  # the corpus server'],
    // Nothing to drop: the line stays as it is written.
    ['tools:Read,Grep', 'tools:Read,Grep'],
    // A list it cannot read, or one the drop would empty, stays too, and check-plugin-manifest reds it.
    ['tools: [Read, mcp__x]', 'tools: [Read, mcp__x]'],
    ['tools: mcp__x', 'tools: mcp__x'],
  ]) {
    const text = `---\nname: a\n${tools}\n---\n`
    assert.equal(pluginCopy('agents/a.md', Buffer.from(text)).toString('utf8'), `---\nname: a\n${want}\n---\n`, tools)
  }
})

// By type, not by name: Markdown, text, JSON, YAML and five image formats, no `#!` start, and
// no package manager configuration.
test('generatedFiles copies only the file types the plugin directory accepts, so the slice scaffolder stays the installed project\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-plugin-types-'))
  const skill = join(dir, 'template/base/.claude/skills/s')
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  for (const [rel, body] of [
    ['SKILL.md', '---\nname: s\n---\n'],
    ['notes.txt', 'n\n'],
    ['data.json', '{}\n'],
    ['data.yml', 'a: 1\n'],
    ['icon.png', 'png'],
    ['scripts/run.mjs', '// x\n'],
    ['scripts/run.sh', 'x\n'],
    ['scripts/run.md', '#!/bin/sh\n'],
    ['package.json', '{}\n'],
    ['pnpm-workspace.yaml', 'packages: []\n'],
    ['bun.lockb', 'x'],
  ]) {
    writeFileSync(join(skill, rel), body)
  }
  writeFileSync(join(dir, 'LICENSE'), 'License.\n')
  assert.deepEqual([...generatedFiles(dir).keys()].sort(), [
    'LICENSE',
    'skills/s/SKILL.md',
    'skills/s/data.json',
    'skills/s/data.yml',
    'skills/s/icon.png',
    'skills/s/notes.txt',
  ])
  assert.ok(!generatedFiles(REPO).has('skills/authoring-vertical-slice/scripts/scaffold-slice.mjs'))
})

/** Every file under a folder, as POSIX paths inside it. @param {string} root */
const filesIn = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).split('\\').join('/'))

test('the shipped plugin runs nothing as it loads, pre-approves only reading and searching, names no MCP tool and ships no script', () => {
  const pluginDir = join(REPO, 'plugin')
  for (const rel of filesIn(pluginDir)) {
    const text = readFileSync(join(pluginDir, rel), 'utf8')
    assert.match(rel, /\.(?:md|json|png)$|^LICENSE$/, rel)
    assert.ok(!text.startsWith('#!'), rel)
    if (/^(?:commands|skills)\//.test(rel)) assert.doesNotMatch(text, /(?:^|\s)!`|```!/m, rel)
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
    const grants = allowedTools(/^allowed-tools:(.*)$/m.exec(frontmatter)?.[1] ?? '')
    const tools = allowedTools(/^tools:(.*)$/m.exec(frontmatter)?.[1] ?? '')
    assert.ok(grants !== null && tools !== null, rel)
    for (const entry of grants) assert.ok(['Read', 'Grep', 'Glob', 'LS'].includes(entry), `${rel}: ${entry}`)
    for (const tool of tools) assert.ok(!/^mcp__/i.test(tool), `${rel}: ${tool}`)
    if (rel.startsWith('agents/')) assert.doesNotMatch(frontmatter, /^harnessFallbackModels:/m, rel)
  }
})

// Claude Code passes a typed command's rules to the subagents it starts, and the shipped
// settings' Bash(pnpm test:*) admits `pnpm test <args>`, not `pnpm test:rls`.
test('/new-migration pre-approves pnpm test:rls, which its migration-rls-author subagent runs', () => {
  const read = (/** @type {string} */ rel) => readFileSync(join(REPO, 'template/base/.claude', rel), 'utf8')
  const command = read('commands/new-migration.md')
  assert.ok(command.includes('Delegate the authoring to the `migration-rls-author` subagent'), 'new-migration.md delegates to the subagent')
  assert.ok(read('agents/migration-rls-author.md').includes('`pnpm test:rls`'), 'the subagent verifies with pnpm test:rls')
  assert.match(command, /^allowed-tools: .*Bash\(pnpm test:rls\)/m)
})

// dal-author has no shell: it hands back the commands to run, and /new-action runs them.
test('/new-action pre-approves pnpm test:rls, which its dal-author subagent hands back', () => {
  const read = (/** @type {string} */ rel) => readFileSync(join(REPO, 'template/base/.claude', rel), 'utf8')
  const command = read('commands/new-action.md')
  assert.ok(command.includes('to the `dal-author` subagent'), 'new-action.md delegates to the subagent')
  assert.ok(read('agents/dal-author.md').includes('`pnpm test`, and `pnpm test:rls`'), 'the subagent hands back pnpm test:rls')
  assert.match(command, /^allowed-tools: .*Bash\(pnpm test:rls\)/m)
})

/** `rls-check` with its own list and one more entry: one skew, so one finding. @param {string} entry */
function redWith(entry) {
  const dir = surfaceCopy()
  const rel = 'commands/rls-check.md'
  setPrompt(dir, rel, withTools(dir, rel, `Read, Grep, Glob, Bash(git diff --name-only HEAD), Bash(pnpm db:test), ${entry}`))
  return dir
}

/** @param {string} text */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Each tool in SHELL_AND_WRITE_TOOLS runs a shell command or code, or writes a file. Claude
// Code's rule parser reads Tool() and Tool(*) as the bare Tool, which pre-approves every call
// while the command runs. A rule with a `*` or on a one-word prefix is nearly as wide: `*` is
// any text in a shell rule and a glob in a path rule, so `**`, `//**` and ` * ` each cover
// every command or path.
for (const tool of SHELL_AND_WRITE_TOOLS) {
  for (const entry of [tool, `${tool}()`, `${tool}(*)`]) {
    test(`RED: ${entry} grants every ${tool} call, as Claude Code reads it`, () => {
      redOnce(redWith(entry), new RegExp(`commands/rls-check\\.md: allowed-tools grants every ${tool} call`))
    })
  }
  for (const entry of [`${tool}(**)`, `${tool}(//**)`, `${tool}( * )`, `${tool}(pnpm:*)`]) {
    test(`RED: ${entry} pre-approves more than one command or path`, () => {
      redOnce(redWith(entry), new RegExp(`commands/rls-check\\.md: ${literal(entry)} pre-approves more than one command or path`))
    })
  }
}

test('RED: a Bash rule on a wildcard after a word', () => {
  redOnce(redWith('Bash(pnpm *)'), /Bash\(pnpm \*\) pre-approves more than one command/)
})

// Claude Code reads mcp__<server> and mcp__<server>__* as every tool of that server, and a `*`
// in a tool name as a glob. It names MCP tools that run shell commands or code
// (mcp__workspace__bash, mcp__remote-devices__device_bash, mcp__ide__executeCode), and what any
// other server's tool runs is that server's to say. So no entry names an MCP tool.
for (const entry of ['mcp__workspace__bash', 'mcp__workspace', 'mcp__workspace__b*', 'mcp__ide__executeCode(*)']) {
  test(`RED: ${entry}, an MCP tool`, () => {
    redOnce(redWith(entry), new RegExp(`commands/rls-check\\.md: allowed-tools grants ${literal(entry)}, an MCP tool`))
  })
}

// Claude Code splits the list at spaces too, so a missing comma, or a list written with
// spaces, grants what it names.
test('RED: a bare Bash in a list with a missing comma, or in a list written with spaces', () => {
  for (const [rel, tools, want] of /** @type {Array<[string, string, RegExp]>} */ ([
    [
      'commands/rls-check.md',
      'Read, Grep, Glob Bash, Bash(git diff --name-only HEAD), Bash(pnpm db:test)',
      /commands\/rls-check\.md: allowed-tools grants every Bash call/,
    ],
    ['skills/designing-mobile-ui/SKILL.md', 'Read Grep Glob Bash', /designing-mobile-ui\/SKILL\.md: allowed-tools grants every Bash call/],
  ])) {
    const dir = surfaceCopy()
    setPrompt(dir, rel, withTools(dir, rel, tools))
    redOnce(dir, want)
  }
})

// Claude Code parses the frontmatter as YAML, and ends it at the first `---`, even mid-line,
// so it reads each of these lists otherwise than its text. YAML reads a no-break space as
// text, so the line after the list continues it, and by its spec a lone carriage return as a
// line break, so the comment ends there. The plugin copy keeps a list it cannot read as it is,
// so that list reds in the copy too; the entry before the mid-line `---` is not one the copy
// keeps, and neither is the comment line that holds the carriage return.
const NOT_PLAIN = 'allowed-tools is not a plain or wholly quoted list'
/** @type {Array<[string, string, string, string, boolean]>} */
const LIST_FORMS = [
  ['a flow list', 'skills/designing-mobile-ui/SKILL.md', 'allowed-tools: [Read, Grep, Glob, Bash]', NOT_PLAIN, true],
  ['a quoted list and a comment', 'skills/designing-mobile-ui/SKILL.md', 'allowed-tools: "Read, Grep, Glob, Bash" # read-only', NOT_PLAIN, true],
  ['an alias', 'skills/designing-mobile-ui/SKILL.md', 'shared: &tools Read, Grep, Glob, Bash\nallowed-tools: *tools', NOT_PLAIN, true],
  ['a block scalar', 'skills/designing-mobile-ui/SKILL.md', 'allowed-tools: |\n  Read, Grep, Glob\n    Bash', NOT_PLAIN, true],
  ['a double-quoted escape', 'skills/designing-mobile-ui/SKILL.md', 'allowed-tools: "Read, Grep, Glob, \\x42ash"', NOT_PLAIN, true],
  ['a comment', 'commands/verify-invariants.md', 'allowed-tools: Read, Grep, Glob # Bash(git diff --name-only HEAD)', NOT_PLAIN, true],
  ['a --- inside it', 'skills/designing-mobile-ui/SKILL.md', 'allowed-tools: Read, Grep, Glob, Bash---', 'a `---` inside the frontmatter ends it there', false],
  ['an entry that is not a tool', 'skills/authoring-e2ee-feature/SKILL.md', 'allowed-tools: Bash(pnpm gen), "Bash"', NOT_PLAIN, true],
  ['a no-break space', 'skills/designing-mobile-ui/SKILL.md', 'allowed-tools: Read, Grep, Glob\n  \u00a0#, Bash', 'the frontmatter holds U+00A0', true],
  ['a carriage return', 'skills/designing-mobile-ui/SKILL.md', '# tools\rallowed-tools: Read, Grep, Glob, Bash', 'the frontmatter holds U+000D', false],
]
for (const [form, rel, lines, problem, inCopy] of LIST_FORMS) {
  test(`RED: allowed-tools written as ${form}`, () => {
    const dir = surfaceCopy()
    const text = readFileSync(join(dir, 'template/base/.claude', rel), 'utf8')
    setPrompt(dir, rel, text.replace(/^allowed-tools: .*$/m, () => lines))
    const roots = inCopy ? ['template/base/.claude', 'plugin'] : ['template/base/.claude']
    red(dir, roots.map((root) => new RegExp(`${literal(`${root}/${rel}: ${problem}`)}`)))
  })
}

// A wholly quoted list is the text it shows.
test('GREEN: a wholly quoted list is read for what it names, and its plugin copy keeps the quotes', () => {
  const dir = surfaceCopy()
  const rel = 'commands/rls-check.md'
  setPrompt(dir, rel, withTools(dir, rel, '"Read, Grep, Glob, Bash(git diff --name-only HEAD), Bash(pnpm db:test)"'))
  const { code, out } = run([dir])
  assert.equal(code, 0, out)
  assert.match(readFileSync(join(dir, 'plugin', rel), 'utf8'), /^allowed-tools: "Read, Grep, Glob"$/m)
})

// Claude Code runs a `!` code span at a line start or after white space, and a fenced block
// opened with three backticks and `!`, as a command or skill loads, and the plugin directory
// refuses either. The check reds both in every Markdown file under commands/ and skills/, a
// skill's references included, and an empty block too. A command or skill asks Claude to run
// the command instead. The plugin copies every file under commands/ and skills/ whole, so the
// source and the copy both red.
const fence = '`'.repeat(3)
/** @type {Array<[string, string, string]>} */
const INLINE_SHELL = [
  ['commands/verify-invariants.md', 'Files changed in the working tree: !`git diff --name-only HEAD`', '!`git diff --name-only HEAD`'],
  ['skills/designing-mobile-ui/SKILL.md', `${fence}!\ngit log -1 --format=%cd\n${fence}`, `${fence}!`],
  ['skills/designing-mobile-ui/references/motion.md', `${fence}!\n${fence}`, `${fence}!`],
  ['skills/authoring-vertical-slice/references/tests.md', 'Today:\n!`date +%Y%m%d`', '!`date +%Y%m%d`'],
]
for (const [rel, added, shell] of INLINE_SHELL) {
  test(`RED: inline shell ${shell} in ${rel}`, () => {
    const dir = surfaceCopy()
    setPrompt(dir, rel, `${readFileSync(join(dir, 'template/base/.claude', rel), 'utf8')}\n${added}\n`)
    red(
      dir,
      ['template/base/.claude', 'plugin'].map((root) => new RegExp(`${literal(`${root}/${rel}`)}:\\d+: ${literal(shell)} is inline shell;`)),
    )
  })
}

test('GREEN: a `!` code span, and a `!` right after a word, run nothing', () => {
  const dir = surfaceCopy()
  const rel = 'commands/verify-invariants.md'
  setPrompt(dir, rel, `${readFileSync(join(dir, 'template/base/.claude', rel), 'utf8')}\nA \`!\` on a result is no command, and neither is a!\`b\`.\n`)
  const { code, out } = run([dir])
  assert.equal(code, 0, out)
})

// The copies of plugin/: what the plugin directory accepts. A copy skewed alone also differs
// from its source.
/** @param {string} dir @param {string} rel @param {(text: string) => string} edit */
function editCopy(dir, rel, edit) {
  const path = join(dir, 'plugin', rel)
  writeFileSync(path, edit(readFileSync(path, 'utf8')))
}
/** @param {string} rel */
const drifted = (rel) => new RegExp(`${literal(`plugin/${rel}`)}: differs from its source`)

for (const entry of [
  'Bash(git diff --name-only HEAD)',
  'WebFetch',
  'mcp__corpus_search',
  'Read(${CLAUDE_PLUGIN_ROOT}/skills)',
  'Grep(//etc)',
  'Glob(\\\\host\\share)',
  'Read(https://example.com/a)',
]) {
  test(`RED: a plugin command's copy that pre-approves ${entry}`, () => {
    const dir = surfaceCopy()
    const rel = 'commands/rls-check.md'
    editCopy(dir, rel, (text) => text.replace(/^allowed-tools: .*$/m, () => `allowed-tools: Read, Grep, Glob, ${entry}`))
    red(dir, [drifted(rel), new RegExp(`plugin/commands/rls-check\\.md: allowed-tools pre-approves ${literal(entry)};`)])
  })
}

test('a plugin copy may pre-approve LS, and Read, Grep or Glob on a path in the project', () => {
  const dir = surfaceCopy()
  const rel = 'commands/rls-check.md'
  editCopy(dir, rel, (text) => text.replace(/^allowed-tools: .*$/m, 'allowed-tools: Read, Grep, Glob, LS, Read(docs/**), Grep(src)'))
  redOnce(dir, drifted(rel))
})

test("RED: a plugin copy's allowed-tools that is not a plain or wholly quoted list", () => {
  const dir = surfaceCopy()
  const rel = 'commands/adr.md'
  editCopy(dir, rel, (text) => text.replace(/^allowed-tools: .*$/m, 'allowed-tools: [Read, Grep, Glob]'))
  red(dir, [drifted(rel), /plugin\/commands\/adr\.md: allowed-tools is not a plain or wholly quoted list/])
})

test('RED: a plugin file of a type the plugin directory refuses, or a package manager configuration file', () => {
  const OTHER_TYPE = 'is not Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image'
  for (const [rel, body, problem] of [
    ['skills/authoring-vertical-slice/scripts/scaffold-slice.mjs', '// x\n', OTHER_TYPE],
    ['skills/designing-mobile-ui/icon.svg', '<svg/>\n', OTHER_TYPE],
    ['package.json', '{}\n', 'is a package manager configuration file'],
    ['skills/designing-mobile-ui/pnpm-workspace.yaml', 'packages: []\n', 'is a package manager configuration file'],
    ['.npmrc', 'x\n', 'is a package manager configuration file'],
    ['skills/designing-mobile-ui/references/yarn.lock', '\n', 'is a package manager configuration file'],
  ]) {
    const dir = surfaceCopy()
    mkdirSync(dirname(join(dir, 'plugin', rel)), { recursive: true })
    writeFileSync(join(dir, 'plugin', rel), body)
    red(dir, [new RegExp(`${literal(`plugin/${rel}`)}: neither generated nor hand-edited`), new RegExp(literal(`plugin/${rel} ${problem}`))])
  }
})

test('RED: a plugin file that starts with #!, holds a NUL byte or is not UTF-8', () => {
  for (const [edit, want] of /** @type {Array<[(text: string) => Buffer, RegExp]>} */ ([
    [(text) => Buffer.from(`#!/bin/sh\n${text}`), /plugin\/README\.md starts with `#!`/],
    [(text) => Buffer.from(`${text}\0\n`), /plugin\/README\.md holds a NUL byte/],
    [(text) => Buffer.concat([Buffer.from(text), Buffer.from([0xc3, 0x28, 0x0a])]), /plugin\/README\.md is not valid UTF-8/],
  ])) {
    const dir = surfaceCopy()
    const path = join(dir, 'plugin/README.md')
    writeFileSync(path, edit(readFileSync(path, 'utf8')))
    redOnce(dir, want)
  }
})

test('RED: a plugin agent, command or skill with a frontmatter key its copy does not keep', () => {
  for (const [rel, line, kind, keys] of [
    ['agents/architecture-reviewer.md', 'harnessFallbackModels: opus', 'agent', 'name, description, tools, disallowedTools, model'],
    ['commands/adr.md', 'disable-model-invocation: true', 'command', 'description, argument-hint, allowed-tools, model'],
    ['skills/designing-mobile-ui/SKILL.md', 'model: opus', 'skill', 'name, description, argument-hint, allowed-tools'],
  ]) {
    const dir = surfaceCopy()
    editCopy(dir, rel, (text) => text.replace(/^---\n/, `---\n${line}\n`))
    const key = line.slice(0, line.indexOf(':'))
    red(dir, [drifted(rel), new RegExp(literal(`plugin/${rel}: frontmatter key '${key}' is not one a plugin ${kind} keeps (${keys})`))])
  }
})

// Claude Code's plugin loader takes a command whose name ends in .MD, so the copy and the
// check read `.md` in any case.
test('RED: a .MD command is a command: its copy keeps only its own keys and reading tools, and its inline shell reds', () => {
  const dir = surfaceCopy()
  const rel = 'commands/extra.MD'
  const text = ['---', 'description: d', 'allowed-tools: Read, Bash(pnpm gen)', 'disable-model-invocation: true', '---', '', '!`git status --short`', ''].join('\n')
  assert.equal(pluginCopy(rel, Buffer.from(text)).toString('utf8'), ['---', 'description: d', 'allowed-tools: Read', '---', '', '!`git status --short`', ''].join('\n'))
  const shell = (/** @type {string} */ root) => new RegExp(`${literal(`${root}/${rel}`)}:\\d+: ${literal('!`git status --short`')} is inline shell;`)
  setPrompt(dir, rel, text)
  red(dir, ['template/base/.claude', 'plugin'].map(shell))
  // A byte copy, as the generator wrote one before.
  writeFileSync(join(dir, 'plugin', rel), text)
  red(dir, [
    drifted(rel),
    new RegExp(literal(`plugin/${rel}: frontmatter key 'disable-model-invocation' is not one a plugin command keeps`)),
    new RegExp(literal(`plugin/${rel}: allowed-tools pre-approves Bash(pnpm gen);`)),
    ...['template/base/.claude', 'plugin'].map(shell),
  ])
})

// YAML reads a plain value that holds `: ` or ` #`, ends with `:` or starts with an indicator
// otherwise than its text. With `: ` inside or `:` at the end it cannot read the frontmatter
// at all, and a strict reader then sees none of the copy's keys or its tool list.
for (const [rel, line] of [
  ['commands/adr.md', 'description: Emit an ADR: one per slice.'],
  ['commands/adr.md', 'description: Emit an ADR #slice'],
  ['skills/designing-mobile-ui/SKILL.md', 'argument-hint: [surface-type]'],
]) {
  test(`RED: ${line}, which YAML reads otherwise than its text`, () => {
    const dir = surfaceCopy()
    const key = line.slice(0, line.indexOf(':'))
    const text = readFileSync(join(dir, 'template/base/.claude', rel), 'utf8')
    setPrompt(dir, rel, text.replace(new RegExp(`^${key}: .*$`, 'm'), () => line))
    redOnce(dir, new RegExp(literal(`plugin/${rel}: ${key} is a plain YAML value that YAML reads otherwise than its text`)))
  })
}

test('RED: a plugin agent whose tools names an MCP tool', () => {
  const dir = surfaceCopy()
  const rel = 'agents/security-reviewer.md'
  editCopy(dir, rel, (text) => text.replace(/^tools: .*$/m, 'tools: Read, Grep, Glob, mcp__rls_verify'))
  red(dir, [drifted(rel), /plugin\/agents\/security-reviewer\.md: tools names mcp__rls_verify;/])
})

// A source agent's tools in a form the copy cannot read, or one of MCP tools alone, stays in
// the copy as it is written, and the copy reds. A reviewer names only allowlisted tools here,
// so the copy is the one finding.
for (const [rel, tools, want] of /** @type {Array<[string, string, string]>} */ ([
  ['agents/security-reviewer.md', 'tools: [Read, Grep, Glob, mcp__rls_verify]', 'tools is not a plain or wholly quoted list'],
  ['agents/security-reviewer.md', 'tools: mcp__rls_verify', 'tools names mcp__rls_verify;'],
  ['agents/test-author.md', 'tools: Read, Grep, Glob, Bash # mcp__x', 'tools is not a plain or wholly quoted list'],
  ['agents/test-author.md', 'tools: >\n  Read, mcp__x', 'tools is not a plain or wholly quoted list'],
  ['agents/test-author.md', 'tools: "Read, \\x6dcp__x"', 'tools is not a plain or wholly quoted list'],
  ['agents/test-author.md', 'tools: *', 'tools is not a plain or wholly quoted list'],
])) {
  test(`RED: an agent's ${tools.replaceAll('\n', ' ')} reds in its plugin copy`, () => {
    const dir = surfaceCopy()
    const source = join(dir, 'template/base/.claude', rel)
    const text = readFileSync(source, 'utf8').replace(/^tools: .*$/m, () => tools)
    writeFileSync(source, text)
    writeFileSync(join(dir, 'plugin', rel), pluginCopy(rel, Buffer.from(text, 'utf8')))
    redOnce(dir, new RegExp(literal(`plugin/${rel}: ${want}`)))
  })
}

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
    writeFileSync(join(dir, 'plugin/agents/security-reviewer.md'), pluginCopy('agents/security-reviewer.md', Buffer.from(planted)))
    redOnce(dir, want)
  }
})

test('GREEN: the repo that ships the plugin surface passes its own gate', () => {
  const { code, out } = run([])
  assert.equal(code, 0, out)
  assert.match(out, /PLUGIN MANIFEST: CLEAN/)
})
