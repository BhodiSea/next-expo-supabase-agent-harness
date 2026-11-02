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
// square PNG of 512 to 2048 pixels a side, under 2 MB.
// Also the repo-side mirror of the docs-sync agent-roster sub-check: the
// shipped template/base/.claude/agents/*.md frontmatter is validated at its
// SOURCE (same parser, same read-only policy — imported from the canonical
// tools/lib/agent-roster.mjs, the convention check-canary-coverage.mjs set by
// importing the template harness.config.mjs), so a PR that widens a reviewer
// reds this repo's CI before any scaffold ever runs docs-sync. The shipped commands and
// skills are held at their source too, to pre-approve only the commands they run.
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
  PLUGIN_DIR,
  iconProblem,
  inlineCommands,
  pluginDrift,
  proseWordCount,
  toolEntries,
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

// ── what the shipped commands and skills pre-approve, judged at their source ──
// allowed-tools lets a command or skill run what it names without asking, so each names
// exactly the commands it runs. A bare Bash, Edit or Write pre-approves every call of that
// tool while it runs, and a prefix rule on one word (Bash(node:*)) or a * wildcard is
// nearly as wide. Each command a `!` line runs needs its exact rule: Claude Code runs the
// line as the file loads and refuses to load a file whose line it may not run. A script
// rule names a file the skills ship. plugin/'s copies keep a subset of these rules.
const PROMPTS_DIR = 'template/base/.claude'
const BARE_GRANTS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * What one Bash rule pre-approves beyond the command it names.
 * @param {string} rel
 * @param {string} command
 * @returns {string[]}
 */
function bashRuleProblems(rel, command) {
  const prefix = command.endsWith(':*') ? command.slice(0, -2) : command
  if (prefix.includes('*') || (prefix !== command && !prefix.includes(' '))) {
    return [`${rel}: Bash(${command}) pre-approves more than one command; name the command, or its first two words before :*`]
  }
  const script = /^node \.claude\/skills\/(\S+)$/.exec(prefix)?.[1]
  if (script !== undefined && !existsSync(join(ROOT, PROMPTS_DIR, 'skills', script))) {
    return [`${rel}: Bash(${command}) names a script the skills do not ship`]
  }
  return []
}

/**
 * @param {string} rel path under template/base/.claude/
 * @returns {string[]}
 */
function grantProblems(rel) {
  const text = readFileSync(join(ROOT, PROMPTS_DIR, rel), 'utf8')
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return [`${PROMPTS_DIR}/${rel}: frontmatter does not parse (${parsed.error})`]
  const entries = toolEntries(parsed.data['allowed-tools'] ?? '')
  const out = []
  for (const entry of entries) {
    if (BARE_GRANTS.has(entry)) {
      out.push(`${PROMPTS_DIR}/${rel}: allowed-tools grants every ${entry} call; name what it needs, as Bash(<command>) or Edit(<path>)`)
    }
    const command = /^Bash\((.*)\)$/.exec(entry)?.[1]
    if (command !== undefined) out.push(...bashRuleProblems(`${PROMPTS_DIR}/${rel}`, command))
  }
  for (const command of inlineCommands(text)) {
    if (!entries.includes(`Bash(${command})`)) {
      out.push(`${PROMPTS_DIR}/${rel}: a \`!\` line runs \`${command}\`, and allowed-tools has no Bash(${command}) rule for it`)
    }
  }
  return out
}

const promptFiles = ['commands', 'skills'].flatMap((sub) =>
  walkFiles(join(ROOT, PROMPTS_DIR, sub))
    .filter((rel) => (sub === 'commands' ? rel.endsWith('.md') : /^[^/]+\/SKILL\.md$/.test(rel)))
    .map((rel) => `${sub}/${rel}`),
)
for (const rel of promptFiles) errs.push(...grantProblems(rel))

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
