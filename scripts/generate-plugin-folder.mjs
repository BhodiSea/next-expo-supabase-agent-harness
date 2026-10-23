#!/usr/bin/env node
// Plugin folder generator (#163). Copies the plugin's components from template/base/.claude/
// (agents/, commands/, skills/) and the root LICENSE into plugin/, as regular files, and
// deletes any other file there except the two hand-edited ones: plugin/.claude-plugin/
// plugin.json and plugin/README.md. The rule lives in scripts/lib/plugin-folder.mjs, and
// scripts/check-plugin-manifest.mjs reds on drift, so an agent, command or skill edited at
// its source without a regenerate fails CI.
//
//   --check (default): exit 1 naming each stale or extra file.
//   --write:           make plugin/ match.
//   usage: node scripts/generate-plugin-folder.mjs [--check | --write]
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_DIR, generatedFiles, pluginDrift } from './lib/plugin-folder.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const USAGE = 'usage: node scripts/generate-plugin-folder.mjs [--check | --write]'
const args = process.argv.slice(2)
if (args.length > 1 || args.some((a) => a !== '--check' && a !== '--write')) {
  console.error(USAGE)
  process.exit(1)
}

const { stale, extra, problems } = pluginDrift(ROOT)
if (args[0] === '--write') {
  const sources = generatedFiles(ROOT)
  for (const rel of stale) {
    const dest = join(ROOT, PLUGIN_DIR, rel)
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(dest, { force: true })
    copyFileSync(join(ROOT, /** @type {string} */ (sources.get(rel))), dest)
  }
  for (const rel of extra) rmSync(join(ROOT, PLUGIN_DIR, rel))
  console.log(`generate-plugin-folder --write: ${String(stale.length)} written, ${String(extra.length)} removed`)
  const after = pluginDrift(ROOT)
  for (const p of after.problems) console.error(`  ${p}`)
  process.exit(after.problems.length > 0 ? 1 : 0)
}

const lines = [
  ...stale.map((rel) => `  ${PLUGIN_DIR}/${rel}: differs from its source (or is missing)`),
  ...extra.map((rel) => `  ${PLUGIN_DIR}/${rel}: not generated and not hand-edited`),
  ...problems.map((p) => `  ${p}`),
]
if (lines.length > 0) {
  console.error('generate-plugin-folder --check: DRIFT')
  for (const l of lines) console.error(l)
  console.error('  run: node scripts/generate-plugin-folder.mjs --write')
  process.exit(1)
}
console.log('generate-plugin-folder --check: CLEAN')
