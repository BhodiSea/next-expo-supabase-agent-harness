#!/usr/bin/env node
// Custom statusline — surfaces the harness context: model, branch, working-tree dirtiness,
// and the gate command. Live `pnpm validate` would be too slow per render, so the gate is
// shown as a reminder. SOURCE: docs/harness/README.md (statusline surfaces gate state)
import { execSync } from 'node:child_process'
import process from 'node:process'

let raw = ''
try {
  for await (const chunk of process.stdin) raw += chunk
} catch {
  /* statusline is best-effort: no stdin payload → render without model info */
}

let model = ''
try {
  model = JSON.parse(raw)?.model?.display_name ?? ''
} catch {
  /* malformed payload → render without model info */
}

const git = (args) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const branch = git('branch --show-current')
const dirtyCount = git('status --porcelain').split('\n').filter(Boolean).length
const dirty = dirtyCount ? ` ±${dirtyCount}` : ''

process.stdout.write(`\u{1F6E1}️ ${model} | ${branch}${dirty} | gate: pnpm validate`)
