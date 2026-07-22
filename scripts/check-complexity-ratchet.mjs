#!/usr/bin/env node
// check-complexity-ratchet (G16) — the harness's own machinery, held to the bar it enforces.
//
// The harness reds a CONSUMER whose function exceeds cognitive-complexity 15. Its own installer
// does not comply, and that was always known: eleven functions carry an inline
// `eslint-disable-next-line sonarjs/cognitive-complexity -- ratchet(v0.1.5): N today; do not
// raise`, and the CHANGELOG promised those "may not grow".
//
// NOTHING ENFORCED THAT PROMISE. A disable directive suppresses the rule ENTIRELY on its
// function, so `init()` could go from 133 to 500 and `eslint .` stayed green. The "N today" was
// prose, and it had already drifted (doctor.mjs claimed 74; it measures 73). The one thing the
// directive does catch is a function dropping back UNDER 15 — reportUnusedDisableDirectives reds
// a directive nothing uses. A floor, never a ceiling.
//
// This is the ceiling. It re-lints with --no-inline-config, so the disables are IGNORED and the
// rule reports every over-limit function WITH ITS ACTUAL SCORE, then compares each against a
// committed record (scripts/complexity-ratchet.json).
//
//   node scripts/check-complexity-ratchet.mjs           # the gate (machinery-lint, blocking)
//   node scripts/check-complexity-ratchet.mjs --write   # re-record after a REVIEWED refactor
//
// The comparison itself lives in scripts/lib/complexity.mjs so it can be proven red without a
// 15-second ESLint run (tests/gates/check-complexity-ratchet.test.mjs).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { compareComplexity, identify, keyScores, scoreOf } from './lib/complexity.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RECORD = 'scripts/complexity-ratchet.json'
const RULE = 'sonarjs/cognitive-complexity'
const WRITE = process.argv.includes('--write')

const eslint = spawnSync('pnpm', ['exec', 'eslint', '.', '--no-inline-config', '-f', 'json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
// ESLint exits 1 whenever it reports anything, and --no-inline-config deliberately
// un-suppresses every ratcheted function — so a non-zero exit is the NORMAL case here. Only a
// crash (no JSON at all) is fatal; treating exit≠0 as failure would make this gate unable to run.
if (eslint.stdout.trim() === '') {
  console.error(`COMPLEXITY RATCHET: eslint produced no output\n${eslint.stderr}`)
  process.exit(1)
}

const measured = new Map()
const collisions = []
for (const file of JSON.parse(eslint.stdout)) {
  const rel = file.filePath.replace(ROOT, '')
  const complexityMsgs = file.messages.filter(
    (m) => m.ruleId === RULE && scoreOf(m.message) !== null,
  )
  if (complexityMsgs.length === 0) continue
  const lines = readFileSync(file.filePath, 'utf8').split('\n')
  const entries = complexityMsgs.map((m) => ({
    base: `${rel}::${identify(lines[m.line - 1] ?? '')}`,
    score: scoreOf(m.message),
  }))
  const { measured: fileScores, collisions: fileCollisions } = keyScores(entries)
  for (const [key, score] of fileScores) measured.set(key, score)
  for (const base of fileCollisions) collisions.push(base)
}

// A collision is an identity failure the ratchet cannot resolve safely (see keyScores). It reds
// BEFORE anything else, in both --write and check mode — writing a record over an ambiguous name
// would bake the ambiguity in, and a false CLEAN is the exact failure mode this gate exists to
// prevent.
if (collisions.length > 0) {
  console.error(`COMPLEXITY RATCHET: ${String(collisions.length)} unresolvable name collision(s):`)
  for (const base of collisions) {
    console.error(
      `  - ${base}: two or more OVER-LIMIT functions map to this name in one file. The ratchet ` +
        'cannot track same-named functions independently (ESLint only reports the ones already over ' +
        'the limit, so an occurrence index is not stable). Give them distinct names, or extract one.',
    )
  }
  process.exit(1)
}

const record = existsSync(RECORD)
  ? JSON.parse(readFileSync(RECORD, 'utf8'))
  : { limit: 15, functions: {} }

if (WRITE) {
  writeFileSync(
    RECORD,
    `${JSON.stringify(
      {
        '//': record['//'] ?? 'Cognitive-complexity records for the harness machinery.',
        limit: record.limit ?? 15,
        functions: Object.fromEntries([...measured].sort(([a], [b]) => (a < b ? -1 : 1))),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`COMPLEXITY RATCHET: wrote ${RECORD} (${String(measured.size)} function(s))`)
  process.exit(0)
}

const { problems, improved } = compareComplexity(measured, record)

if (problems.length > 0) {
  console.error(`COMPLEXITY RATCHET: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    `\nThe harness enforces cognitive-complexity <= ${String(record.limit ?? 15)} on every consumer. ` +
      'This is the check that stops it from exempting itself. Re-record only after a reviewed ' +
      'refactor: node scripts/check-complexity-ratchet.mjs --write',
  )
  process.exit(1)
}

for (const [key, score, was] of improved) {
  console.log(
    `COMPLEXITY RATCHET: NOTE — ${key} improved to ${String(score)} (recorded ${String(was)}). ` +
      'Bank it with `--write` so the headroom cannot be quietly respent.',
  )
}
const worst = [...measured].sort((a, b) => b[1] - a[1])[0]
console.log(
  `COMPLEXITY RATCHET: CLEAN (${String(measured.size)} recorded function(s), none grew; ` +
    `worst is ${worst?.[0] ?? 'n/a'} at ${String(worst?.[1] ?? 0)})`,
)
