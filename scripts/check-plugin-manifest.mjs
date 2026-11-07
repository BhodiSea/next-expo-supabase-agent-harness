#!/usr/bin/env node
// Static structural validation of the Claude Code plugin manifests
// (plugin/.claude-plugin/plugin.json + .claude-plugin/marketplace.json): required fields
// present and every referenced agents/commands/skills path actually exists inside the
// plugin folder — a plugin shipping dangling paths is dead on install, and nothing else
// checks this surface (version equality is check-release-lockstep's job).
// Since #163 the marketplace installs plugin/, not the repository root, and this gate is
// also its drift check: plugin/'s agents, commands, skills and LICENSE must be the copies
// scripts/lib/plugin-folder.mjs makes of their sources (regenerate with
// scripts/generate-plugin-folder.mjs --write), within the plugin directory's file limits,
// its README must clear the directory's 40-word floor, and plugin.json's icon must name a
// square PNG of 512 to 2048 pixels a side, under 2 MB. plugin/ must also meet the plugin
// directory's rules, and no command or skill, at its source or in plugin/, holds inline shell.
// Also the repo-side mirror of the docs-sync agent-roster sub-check: the
// shipped template/base/.claude/agents/*.md frontmatter is validated at its
// SOURCE (same parser, same read-only policy — imported from the canonical
// tools/lib/agent-roster.mjs, the convention check-canary-coverage.mjs set by
// importing the template harness.config.mjs), so a PR that widens a reviewer
// reds this repo's CI before any scaffold ever runs docs-sync. The shipped commands' and
// skills' allowed-tools are read at their source too, to catch a broad grant added by mistake.
//   usage: node scripts/check-plugin-manifest.mjs [repo-root]
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFiles } from '../installer/lib/fs-walk.mjs'
import {
  REVIEWER_AGENTS,
  REVIEWER_READONLY_TOOLS,
  fallbackListProblems,
  parseFrontmatter,
  splitList,
} from '../template/base/tools/lib/agent-roster.mjs'
import {
  COPY_KEYS,
  PLUGIN_DIR,
  READ_ONLY_TOOLS,
  allowedTools,
  componentKind,
  fileProblem,
  iconProblem,
  inlineShell,
  pluginDrift,
  proseWordCount,
  readOnlyGrant,
  wholeToolGrant,
  wideRule,
} from './lib/plugin-folder.mjs'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const errs = []

function load(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    errs.push(`${rel}: missing`)
    return null
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    errs.push(`${rel}: invalid JSON (${e.message})`)
    return null
  }
}

const MANIFEST = `${PLUGIN_DIR}/.claude-plugin/plugin.json`
const plugin = load(MANIFEST)
if (plugin !== null) {
  for (const field of ['name', 'version', 'description']) {
    if (typeof plugin[field] !== 'string' || plugin[field].trim() === '') {
      errs.push(`plugin.json: missing/empty ${field}`)
    }
  }
  if (typeof plugin.version === 'string' && !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    errs.push(`plugin.json: version "${plugin.version}" is not plain x.y.z`)
  }
  // Component paths are optional (Claude Code finds agents/, commands/ and skills/ at the
  // plugin root by default); one that is given resolves inside the plugin folder.
  for (const agent of Array.isArray(plugin.agents) ? plugin.agents : []) {
    if (!existsSync(join(ROOT, PLUGIN_DIR, agent))) errs.push(`plugin.json agents: ${agent} does not exist`)
  }
  for (const field of ['commands', 'skills']) {
    if (typeof plugin[field] === 'string' && !existsSync(join(ROOT, PLUGIN_DIR, plugin[field]))) {
      errs.push(`plugin.json ${field}: ${plugin[field]} does not exist`)
    }
  }
  errs.push(...iconProblems(plugin.icon))
}

/**
 * plugin.json's `icon`: an image inside the plugin that iconProblem accepts.
 * @param {unknown} icon
 * @returns {string[]}
 */
function iconProblems(icon) {
  if (typeof icon !== 'string' || !icon.startsWith('./') || icon.split('/').includes('..')) {
    return ['plugin.json: icon must name an image inside the plugin, such as "./.claude-plugin/icon.png"']
  }
  const abs = join(ROOT, PLUGIN_DIR, icon)
  if (!existsSync(abs)) return [`plugin.json icon: ${icon} does not exist`]
  const problem = iconProblem(readFileSync(abs))
  return problem === null ? [] : [`plugin.json icon: ${icon} ${problem}`]
}

const marketplace = load('.claude-plugin/marketplace.json')
if (marketplace !== null) {
  if (typeof marketplace.name !== 'string' || marketplace.name.trim() === '') {
    errs.push('marketplace.json: missing/empty name')
  }
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  if (plugins.length === 0) errs.push('marketplace.json: plugins must be a non-empty array')
  for (const [i, entry] of plugins.entries()) {
    for (const field of ['name', 'source', 'description']) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
        errs.push(`marketplace.json plugins[${i}]: missing/empty ${field}`)
      }
    }
  }
  if (plugin !== null && plugins[0]?.name !== plugin.name) {
    errs.push('marketplace.json plugins[0].name must match plugin.json name')
  }
  if (plugins.length > 0 && plugins[0]?.source !== `./${PLUGIN_DIR}`) {
    errs.push(
      `marketplace.json plugins[0].source must be "./${PLUGIN_DIR}": any other folder installs files the plugin does not ship`,
    )
  }
}

// ── the plugin folder (#163): generated copies in sync, within the directory's limits ──
const drift = pluginDrift(ROOT)
for (const rel of drift.stale) {
  errs.push(`${PLUGIN_DIR}/${rel}: differs from its source or is missing — run node scripts/generate-plugin-folder.mjs --write`)
}
for (const rel of drift.extra) {
  errs.push(`${PLUGIN_DIR}/${rel}: neither generated nor hand-edited — run node scripts/generate-plugin-folder.mjs --write`)
}
errs.push(...drift.problems)
const readmeAbs = join(ROOT, PLUGIN_DIR, 'README.md')
if (existsSync(readmeAbs)) {
  const words = proseWordCount(readFileSync(readmeAbs, 'utf8'))
  if (words < 40) {
    errs.push(`${PLUGIN_DIR}/README.md has ${String(words)} words outside code blocks: the plugin directory asks for at least 40`)
  }
}

// ── the shipped commands' and skills' allowed-tools, read at their source ──
// allowed-tools lets a command or skill run what it names without asking, so each names
// exactly the commands it runs. This check guards against a broad grant added by mistake, in
// the forms below; it is not a sandbox against one written to get past it. Claude Code ends
// the frontmatter at the first `---` after its opening line, even mid-line, and parses it as
// YAML, which reads only a space or tab as a space, and by its spec a lone carriage return as
// a line break, where parseFrontmatter reads JavaScript's white space (frontmatterProblem).
// So the list must be a plain or wholly quoted string, which YAML reads as its text
// (allowedTools); and a missing comma still grants what it names. A bare entry, Tool() or
// Tool(*) of one of SHELL_AND_WRITE_TOOLS pre-approves every call of it while the command
// runs (wholeToolGrant), and that tool's rule on a one-word prefix (Bash(node:*)) or with a *
// wildcard nearly as many (wideRule). An MCP rule can name every tool of a server or a glob
// of tool names, and some MCP tools run shell commands, so no entry names an MCP tool.
// plugin/'s copies keep only the entries readOnlyGrant accepts (below).
// The check reads only commands/**/*.md and skills/<name>/SKILL.md, in that case, though
// Claude Code's plugin loader takes a .MD command, and a case-insensitive disk opens SKILL.MD
// or skill.md as SKILL.md. Of their frontmatter keys it judges only allowed-tools, though a
// hooks entry there or in plugin.json can allow any call. A rule on a prefix of two words or
// more passes whatever it runs (Bash(node -e:*)), and so does a path rule naming a folder
// outside the project (Edit(//Users)).
const PROMPTS_DIR = 'template/base/.claude'

/**
 * What reds in one allowed-tools entry: a whole tool of SHELL_AND_WRITE_TOOLS, an MCP tool,
 * or a rule wideRule holds wide.
 * @param {string} rel
 * @param {string} entry
 * @returns {string[]}
 */
function entryProblems(rel, entry) {
  const tool = wholeToolGrant(entry)
  if (tool !== null) return [`${rel}: allowed-tools grants every ${tool} call; name what it needs, as Bash(<command>) or Edit(<path>)`]
  if (entry.startsWith('mcp__')) {
    return [`${rel}: allowed-tools grants ${entry}, an MCP tool; an MCP rule can cover a whole server, and some MCP tools run shell commands`]
  }
  if (wideRule(entry)) return [`${rel}: ${entry} pre-approves more than one command or path; name it, or a command's first two words before :*`]
  return []
}

/**
 * Two ways Claude Code reads a frontmatter otherwise than parseFrontmatter does: a `---`
 * inside it, and white space YAML reads otherwise than JavaScript. Which one, or null.
 * @param {string} frontmatter the text from the opening line to the first `---`
 * @returns {string | null}
 */
function frontmatterProblem(frontmatter) {
  if (frontmatter !== '' && !frontmatter.endsWith('\n')) return 'a `---` inside the frontmatter ends it there for Claude Code'
  const space = /[^\S \t\r\n]|\r(?!\n)/u.exec(frontmatter)?.[0]
  if (space === undefined) return null
  const code = (space.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
  return `the frontmatter holds U+${code}, which YAML reads otherwise than JavaScript; use only spaces, tabs and newlines`
}

/**
 * @param {string} rel path under template/base/.claude/
 * @returns {string[]}
 */
function grantProblems(rel) {
  const text = readFileSync(join(ROOT, PROMPTS_DIR, rel), 'utf8')
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return [`${PROMPTS_DIR}/${rel}: frontmatter does not parse (${parsed.error})`]
  const frontmatter = /^\uFEFF?---\s*\n([\s\S]*?)---/.exec(text)?.[1] ?? ''
  const problem = frontmatterProblem(frontmatter)
  if (problem !== null) return [`${PROMPTS_DIR}/${rel}: ${problem}`]
  const entries = allowedTools(/^allowed-tools:(.*)$/m.exec(frontmatter)?.[1] ?? '')
  if (entries === null) {
    return [`${PROMPTS_DIR}/${rel}: allowed-tools is not a plain or wholly quoted list, so Claude Code's YAML reading of it can differ from its text`]
  }
  return entries.flatMap((entry) => entryProblems(`${PROMPTS_DIR}/${rel}`, entry))
}

const promptFiles = ['commands', 'skills'].flatMap((sub) =>
  walkFiles(join(ROOT, PROMPTS_DIR, sub))
    .filter((rel) => (sub === 'commands' ? rel.endsWith('.md') : /^[^/]+\/SKILL\.md$/.test(rel)))
    .map((rel) => `${sub}/${rel}`),
)
for (const rel of promptFiles) errs.push(...grantProblems(rel))

// ── inline shell: no command or skill holds a `!` code span or a fenced `!` block ──
// Claude Code runs either as a command or skill loads (inlineShell), and the plugin directory
// refuses either. The plugin's commands and skills are the template's, one text in both
// places, so each asks Claude to run its command instead: under its own Bash rule in an
// installed project, and the user's permission settings in the plugin. Every Markdown file
// under commands/ and skills/ is read, at its source and in plugin/, a skill's references
// included.
for (const root of [PROMPTS_DIR, PLUGIN_DIR]) {
  for (const sub of ['commands', 'skills']) {
    for (const rel of walkFiles(join(ROOT, root, sub)).filter((f) => /\.md$/i.test(f))) {
      const file = `${root}/${sub}/${rel}`
      for (const { line, shell } of inlineShell(readFileSync(join(ROOT, file), 'utf8'))) {
        errs.push(`${file}:${String(line)}: ${shell} is inline shell; write it as an instruction to Claude to run the command`)
      }
    }
  }
}

// ── plugin/ against the plugin directory's rules ──
// Every file is Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image (a license,
// a readme or .gitignore by name), none starts with `#!` or is a package manager's
// configuration, and a text file is UTF-8 with no NUL byte (fileProblem). An agent's,
// command's or skill's frontmatter holds only the keys its copy keeps (COPY_KEYS), read with
// the sources' parser. A command's or skill's allowed-tools pre-approves only reading and
// searching (readOnlyGrant). An agent's tools names no MCP tool: the plugin ships no MCP
// server, and Claude Code reads mcp__<server> as every tool of whatever server the session
// has by that name. A list the parser cannot read reds, as at the source. So does a plain
// value YAML reads otherwise than its text, or not at all: one that holds `: ` or ` #`, ends
// with `:`, or starts with an indicator. One with `: ` inside or `:` at the end stops a strict
// YAML reader reading the file at all.
const KIND_NAME = { agents: 'agent', commands: 'command', skills: 'skill' }
const PLAIN_MISREAD = /: |\s#|:$|^[,[\]{}#&*!%@`]|^[-?:](?:\s|$)/

/**
 * The keys whose plain value YAML reads otherwise than its text. A quoted value, a block
 * scalar and the tool list, which allowedTools reads, are judged elsewhere.
 * @param {string} frontmatter
 * @param {string} listKey
 * @returns {string[]}
 */
function misreadKeys(frontmatter, listKey) {
  return [...frontmatter.matchAll(/^([A-Za-z][\w-]*):[ \t]*(.*)$/gm)]
    .filter(([, key, value]) => key !== listKey && !/^(?:["']|[>|][+-]?\s*$|$)/.test(value) && PLAIN_MISREAD.test(value.trimEnd()))
    .map(([, key]) => key)
}

/**
 * A plugin agent's, command's or skill's frontmatter: its copy's keys only, and the list it
 * grants read as Claude Code reads it.
 * @param {string} file
 * @param {'agents' | 'commands' | 'skills'} kind
 * @param {string} text
 * @returns {string[]}
 */
function copyProblems(file, kind, text) {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return [`${file}: frontmatter does not parse (${parsed.error})`]
  const frontmatter = /^\uFEFF?---\s*\n([\s\S]*?)---/.exec(text)?.[1] ?? ''
  const problem = frontmatterProblem(frontmatter)
  if (problem !== null) return [`${file}: ${problem}`]
  const listKey = kind === 'agents' ? 'tools' : 'allowed-tools'
  const out = [
    ...Object.keys(parsed.data)
      .filter((key) => !COPY_KEYS[kind].includes(key))
      .map((key) => `${file}: frontmatter key '${key}' is not one a plugin ${KIND_NAME[kind]} keeps (${COPY_KEYS[kind].join(', ')})`),
    ...misreadKeys(frontmatter, listKey).map(
      (key) => `${file}: ${key} is a plain YAML value that YAML reads otherwise than its text, or not at all; quote it`,
    ),
  ]
  const value = new RegExp(`^${listKey}:(.*)$`, 'm').exec(frontmatter)?.[1]
  const entries = value === undefined ? [] : allowedTools(value)
  if (entries === null) {
    return [...out, `${file}: ${listKey} is not a plain or wholly quoted list, so Claude Code's YAML reading of it can differ from its text`]
  }
  const refused = entries.filter((entry) => (kind === 'agents' ? /^mcp__/i.test(entry) : !readOnlyGrant(entry)))
  if (refused.length === 0) return out
  if (kind === 'agents') {
    return [...out, `${file}: tools names ${refused.join(', ')}; a plugin agent names no MCP tool, because the plugin ships no MCP server`]
  }
  return [
    ...out,
    `${file}: allowed-tools pre-approves ${refused.join(', ')}; a plugin's command or skill may pre-approve only ${READ_ONLY_TOOLS.join(', ')}, with no \`\${...}\`, \`//\` or \`\\\\\` path and no URL`,
  ]
}

/**
 * What the plugin directory refuses in one file of plugin/.
 * @param {string} rel path inside plugin/
 * @returns {string[]}
 */
function pluginFileProblems(rel) {
  let bytes
  try {
    bytes = readFileSync(join(ROOT, PLUGIN_DIR, rel))
  } catch {
    return [] // not a file it can read: the drift check names the path
  }
  const problem = fileProblem(rel, bytes)
  if (problem !== null) return [`${PLUGIN_DIR}/${rel} ${problem}, which the plugin directory refuses`]
  const kind = componentKind(rel)
  return kind === null ? [] : copyProblems(`${PLUGIN_DIR}/${rel}`, kind, bytes.toString('utf8'))
}

for (const rel of walkFiles(join(ROOT, PLUGIN_DIR))) errs.push(...pluginFileProblems(rel))

// ── agent roster (mirror of the docs-sync roster sub-check, over the source) ──
// Universal: every agent parses (parse failure = red, never a skip) and carries
// name (== filename)/description/model, and a `harnessFallbackModels` list, where
// present, names at least one model and each once (1.1.0, #62). Reviewers: tools ⊆
// the read-only allowlist AND disallowedTools ⊇ {Write, Edit}. Authors stay
// unconstrained.
const AGENTS_DIR = 'template/base/.claude/agents'
const DOCTRINE = 'reviewers are read-only by construction (README "The agent roster")'
const agentsAbs = join(ROOT, AGENTS_DIR)
const rosterFiles = existsSync(agentsAbs)
  ? readdirSync(agentsAbs)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : []
if (rosterFiles.length === 0) {
  errs.push(`${AGENTS_DIR}: no agent files found — the shipped roster is a required surface`)
}
const rosterStems = new Set(rosterFiles.map((f) => f.slice(0, -3)))
for (const reviewer of REVIEWER_AGENTS) {
  if (!rosterStems.has(reviewer)) {
    errs.push(`${AGENTS_DIR}/${reviewer}.md: reviewer agent missing from the shipped roster`)
  }
}
for (const file of rosterFiles) {
  const rel = `${AGENTS_DIR}/${file}`
  const stem = file.slice(0, -3)
  const parsed = parseFrontmatter(readFileSync(join(agentsAbs, file), 'utf8'))
  if (!parsed.ok) {
    errs.push(`${rel}: frontmatter does not parse (${parsed.error}) — fails closed, fix the frontmatter`)
    continue
  }
  const fm = parsed.data
  for (const field of ['name', 'description', 'model']) {
    if (!fm[field]?.trim()) errs.push(`${rel}: missing/empty frontmatter field '${field}'`)
  }
  if (fm.name?.trim() && fm.name.trim() !== stem) {
    errs.push(`${rel}: name '${fm.name.trim()}' must match the filename ('${stem}')`)
  }
  for (const problem of fallbackListProblems(fm)) errs.push(`${rel}: ${problem}`)
  if (!REVIEWER_AGENTS.includes(stem)) continue
  if (!fm.tools?.trim()) {
    errs.push(
      `${rel}: reviewer declares no 'tools' list (absent = inherit EVERY tool) — ${DOCTRINE}; pin tools to a subset of: ${REVIEWER_READONLY_TOOLS.join(', ')}`,
    )
  } else {
    for (const tool of splitList(fm.tools)) {
      if (!REVIEWER_READONLY_TOOLS.includes(tool)) {
        errs.push(
          `${rel}: reviewer granted '${tool}' — ${DOCTRINE}; the read-only allowlist is: ${REVIEWER_READONLY_TOOLS.join(', ')}`,
        )
      }
    }
  }
  const disallowed = splitList(fm.disallowedTools ?? '')
  for (const t of ['Write', 'Edit']) {
    if (!disallowed.includes(t)) {
      errs.push(`${rel}: reviewer 'disallowedTools' must include ${t} — ${DOCTRINE}`)
    }
  }
}
if (errs.length > 0) {
  console.error(`PLUGIN MANIFEST: ${errs.length} problem(s):`)
  for (const e of errs) console.error(`  ${e}`)
  process.exit(1)
}
console.log('PLUGIN MANIFEST: CLEAN')
