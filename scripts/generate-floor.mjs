#!/usr/bin/env node
// Floor snapshot generator/checker for the harness repo.
// The CI floor (`node tools/validate.mjs --min-floor`) reads
// template/base/tools/validate.floor.json as the AUTHORITATIVE step list, so a
// locally-weakened harness.config.mjs can never weaken CI. This script keeps that
// frozen snapshot in lockstep with the canonical VALIDATE_STEPS:
//   --check (default): exit 1 with a diff when the snapshot and VALIDATE_STEPS disagree.
//   --write:           regenerate the snapshot from VALIDATE_STEPS (preserving the comment).
//   usage: node scripts/generate-floor.mjs [--check | --write]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(ROOT, 'template/base/tools/harness.config.mjs')
const FLOOR = join(ROOT, 'template/base/tools/validate.floor.json')

const DOCTRINE =
  'frozen snapshot of the canonical VALIDATE_STEPS from tools/harness.config.mjs; ' +
  "CI's `node tools/validate.mjs --min-floor` treats THIS file as authoritative, so a " +
  'locally-weakened harness.config.mjs can never weaken CI. Regenerate with ' +
  '`node scripts/generate-floor.mjs --write` in the harness repo; tests assert it equals ' +
  'VALIDATE_STEPS. SOURCE: docs/harness/README.md (the CI floor).'

// file:// URL, not the raw path — Windows absolute paths (D:\…) are not
// importable by the ESM loader.
const { VALIDATE_STEPS } = await import(pathToFileURL(CONFIG).href)

// Stable 2-space serialization with each [name, command] tuple on its own line
// (matches the hand-authored snapshot; keeps diffs readable and --write idempotent).
function serialize(comment, steps) {
  const rows = steps.map(([name, cmd]) => `    [${JSON.stringify(name)}, ${JSON.stringify(cmd)}]`)
  return `{\n  "comment": ${JSON.stringify(comment)},\n  "steps": [\n${rows.join(',\n')}\n  ]\n}\n`
}

const flags = new Set(process.argv.slice(2))

if (flags.has('--write')) {
  // Preserve a hand-tuned comment if one already exists; otherwise seed doctrine.
  let comment = DOCTRINE
  if (existsSync(FLOOR)) {
    try {
      const cur = JSON.parse(readFileSync(FLOOR, 'utf8'))
      if (typeof cur.comment === 'string' && cur.comment.trim()) comment = cur.comment
    } catch {
      // Corrupt existing file — regenerate from scratch with doctrine.
    }
  }
  writeFileSync(FLOOR, serialize(comment, VALIDATE_STEPS))
  console.log(
    `generate-floor: wrote ${String(VALIDATE_STEPS.length)} steps to template/base/tools/validate.floor.json`,
  )
  process.exit(0)
}

// --check (default): the snapshot must equal VALIDATE_STEPS, data-to-data.
if (!existsSync(FLOOR)) {
  console.error(
    'generate-floor --check: template/base/tools/validate.floor.json is MISSING — run `node scripts/generate-floor.mjs --write`',
  )
  process.exit(1)
}

let snapshot
try {
  snapshot = JSON.parse(readFileSync(FLOOR, 'utf8'))
} catch (err) {
  console.error(
    `generate-floor --check: validate.floor.json is not valid JSON (${err.message}) — run \`node scripts/generate-floor.mjs --write\``,
  )
  process.exit(1)
}

const floor = Array.isArray(snapshot?.steps) ? snapshot.steps : null
const inSync =
  Array.isArray(floor) &&
  floor.length === VALIDATE_STEPS.length &&
  floor.every(
    (s, i) => Array.isArray(s) && s[0] === VALIDATE_STEPS[i][0] && s[1] === VALIDATE_STEPS[i][1],
  )

if (!inSync) {
  const fmt = (steps) =>
    Array.isArray(steps) ? steps.map((s) => `    ${JSON.stringify(s)}`).join('\n') : '    <invalid>'
  console.error('generate-floor --check: validate.floor.json is OUT OF SYNC with VALIDATE_STEPS.')
  console.error(`  snapshot:\n${fmt(floor)}`)
  console.error(`  config:\n${fmt(VALIDATE_STEPS)}`)
  console.error('  fix: node scripts/generate-floor.mjs --write')
  process.exit(1)
}

console.log(`generate-floor --check: OK (${String(VALIDATE_STEPS.length)} steps in lockstep)`)
