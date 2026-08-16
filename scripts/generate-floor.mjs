#!/usr/bin/env node
// Floor snapshot generator/checker for the harness repo — BOTH chains.
//
// The CI floor (`node tools/validate.mjs --min-floor`) reads
// template/base/tools/validate.floor.json as the AUTHORITATIVE step list, so a
// locally-weakened harness.config.mjs can never weaken CI. The Stop hook got the same
// protection in 0.3.0: template/base/tools/stop.floor.json is the frozen snapshot of
// STOP_HOOK_STEPS, and stop-validate-gate.mjs runs the UNION of the local config and that
// floor — so a step deleted from the config still runs.
//
// Why the Stop chain needed it. harness.config.mjs is manifest mode `config`, and
// check-gate-integrity skips non-`owned` entries, so nothing hashed STOP_HOOK_STEPS at
// all: an agent could delete `test-quality` or `diff-coverage` from the array mid-turn and
// end the turn green, with gate-integrity reporting OK because a `config` file is
// human-tunable by design. Putting the floor under tools/ means it lands INSIDE
// gate-integrity's `^tools\/` surface and the write-guard table for free, without flipping
// the config to `owned` — projects may still APPEND steps; they may not subtract.
//
//   --check (default): exit 1 with a diff when a snapshot and its array disagree.
//   --write:           regenerate both snapshots (preserving each comment).
//   usage: node scripts/generate-floor.mjs [--check | --write]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(ROOT, 'template/base/tools/harness.config.mjs')

const VALIDATE_DOCTRINE =
  'frozen snapshot of the canonical VALIDATE_STEPS from tools/harness.config.mjs; ' +
  "CI's `node tools/validate.mjs --min-floor` treats THIS file as authoritative, so a " +
  'locally-weakened harness.config.mjs can never weaken CI. Regenerate with ' +
  '`node scripts/generate-floor.mjs --write` in the harness repo; tests assert it equals ' +
  'VALIDATE_STEPS. SOURCE: docs/harness/README.md (the CI floor).'

const STOP_DOCTRINE =
  'frozen snapshot of the canonical STOP_HOOK_STEPS from tools/harness.config.mjs. The ' +
  'Stop hook runs the UNION of the local config and this floor: a step present here but ' +
  'missing from the config STILL RUNS, so deleting a turn-fatal check from the config ' +
  'buys nothing. Projects may APPEND steps to the config; they may not subtract. Living ' +
  "under tools/ puts this file inside check-gate-integrity's hashed surface and the " +
  'write-guard table, which is how the Stop chain became tamper-evident without flipping ' +
  'harness.config.mjs from `config` to `owned`. Regenerate with ' +
  '`node scripts/generate-floor.mjs --write` in the harness repo. ' +
  'SOURCE: docs/harness/README.md (the CI floor).'

// file:// URL, not the raw path — Windows absolute paths (D:\…) are not
// importable by the ESM loader.
const { VALIDATE_STEPS, STOP_HOOK_STEPS } = await import(pathToFileURL(CONFIG).href)

/** The two snapshots this script owns, each pinned to the array it mirrors. */
const FLOORS = [
  {
    label: 'validate.floor.json',
    path: join(ROOT, 'template/base/tools/validate.floor.json'),
    array: 'VALIDATE_STEPS',
    steps: VALIDATE_STEPS,
    doctrine: VALIDATE_DOCTRINE,
  },
  {
    label: 'stop.floor.json',
    path: join(ROOT, 'template/base/tools/stop.floor.json'),
    array: 'STOP_HOOK_STEPS',
    steps: STOP_HOOK_STEPS,
    doctrine: STOP_DOCTRINE,
  },
]

// Stable 2-space serialization with each [name, command] tuple on its own line
// (matches the hand-authored snapshot; keeps diffs readable and --write idempotent).
//
// A tuple that would not fit the shipped biome.jsonc's lineWidth (100) is written the way
// biome would fold it — one element per line — because these files land inside a scaffold
// whose `format` step is `biome ci .`, and a --write that emits a line biome refuses is a
// generator that reds every fresh install's first validate. 1.0.0's three-script docs-sync
// entry is the first row to need it; --check compares data-to-data, so either shape passes.
const LINE_WIDTH = 100
function serialize(comment, steps) {
  const rows = steps.map(([name, cmd]) => {
    const flat = `    [${JSON.stringify(name)}, ${JSON.stringify(cmd)}]`
    // +1 for the trailing comma biome counts on every row but the last.
    return flat.length + 1 > LINE_WIDTH
      ? `    [\n      ${JSON.stringify(name)},\n      ${JSON.stringify(cmd)}\n    ]`
      : flat
  })
  return `{\n  "comment": ${JSON.stringify(comment)},\n  "steps": [\n${rows.join(',\n')}\n  ]\n}\n`
}

const flags = new Set(process.argv.slice(2))

if (flags.has('--write')) {
  for (const floor of FLOORS) {
    // Preserve a hand-tuned comment if one already exists; otherwise seed doctrine.
    let comment = floor.doctrine
    if (existsSync(floor.path)) {
      try {
        const cur = JSON.parse(readFileSync(floor.path, 'utf8'))
        if (typeof cur.comment === 'string' && cur.comment.trim()) comment = cur.comment
      } catch {
        // Corrupt existing file — regenerate from scratch with doctrine.
      }
    }
    writeFileSync(floor.path, serialize(comment, floor.steps))
    console.log(
      `generate-floor: wrote ${String(floor.steps.length)} steps to template/base/tools/${floor.label}`,
    )
  }
  process.exit(0)
}

// --check (default): each snapshot must equal its array, data-to-data.
const problems = []
for (const floor of FLOORS) {
  if (!existsSync(floor.path)) {
    problems.push(
      `template/base/tools/${floor.label} is MISSING — run \`node scripts/generate-floor.mjs --write\``,
    )
    continue
  }
  let snapshot
  try {
    snapshot = JSON.parse(readFileSync(floor.path, 'utf8'))
  } catch (err) {
    problems.push(
      `${floor.label} is not valid JSON (${err.message}) — run \`node scripts/generate-floor.mjs --write\``,
    )
    continue
  }
  const snapSteps = Array.isArray(snapshot?.steps) ? snapshot.steps : null
  const inSync =
    Array.isArray(snapSteps) &&
    snapSteps.length === floor.steps.length &&
    snapSteps.every(
      (s, i) => Array.isArray(s) && s[0] === floor.steps[i][0] && s[1] === floor.steps[i][1],
    )
  if (inSync) continue
  const fmt = (steps) =>
    Array.isArray(steps) ? steps.map((s) => `    ${JSON.stringify(s)}`).join('\n') : '    <invalid>'
  problems.push(
    `${floor.label} is OUT OF SYNC with ${floor.array}.\n  snapshot:\n${fmt(snapSteps)}\n  config:\n${fmt(floor.steps)}`,
  )
}

if (problems.length > 0) {
  console.error('generate-floor --check: FAILED')
  for (const p of problems) console.error(`  ${p}`)
  console.error('  fix: node scripts/generate-floor.mjs --write')
  process.exit(1)
}

console.log(
  `generate-floor --check: OK (${FLOORS.map((f) => `${f.array}: ${String(f.steps.length)}`).join(', ')} in lockstep)`,
)
