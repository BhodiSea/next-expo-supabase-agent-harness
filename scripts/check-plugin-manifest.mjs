#!/usr/bin/env node
// Static structural validation of the Claude Code plugin manifests
// (plugin/.claude-plugin/plugin.json + .claude-plugin/marketplace.json): required fields
// present and every referenced agents/commands/skills path actually exists inside the
// plugin folder — a plugin shipping dangling paths is dead on install, and nothing else
// checks this surface (version equality is check-release-lockstep's job).
// Since #163 the marketplace installs plugin/, not the repository root, and this gate is
// also its drift check: plugin/'s agents, commands, skills and LICENSE must be byte copies
// of their sources (scripts/lib/plugin-folder.mjs; regenerate with
// scripts/generate-plugin-folder.mjs --write), within the plugin directory's file limits,
// and its README must clear the directory's 40-word floor.
// Also the repo-side mirror of the docs-sync agent-roster sub-check: the
// shipped template/base/.claude/agents/*.md frontmatter is validated at its
// SOURCE (same parser, same read-only policy — imported from the canonical
// tools/lib/agent-roster.mjs, the convention check-canary-coverage.mjs set by
// importing the template harness.config.mjs), so a PR that widens a reviewer
// reds this repo's CI before any scaffold ever runs docs-sync.
//   usage: node scripts/check-plugin-manifest.mjs [repo-root]
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REVIEWER_AGENTS,
  REVIEWER_READONLY_TOOLS,
  fallbackListProblems,
  parseFrontmatter,
  splitList,
} from '../template/base/tools/lib/agent-roster.mjs'
import { PLUGIN_DIR, pluginDrift, proseWordCount } from './lib/plugin-folder.mjs'

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
