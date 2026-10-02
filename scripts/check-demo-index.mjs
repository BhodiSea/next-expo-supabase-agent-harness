#!/usr/bin/env node
// Factory check: demo-index (2.0.0, #85) — the worked example stays removable.
//
// `init --with-demo` overlays template/demo on the default plan; `eject` takes it back out
// (installer/commands/eject.mjs). This check holds the two things `eject` relies on, and it
// is the gate-proposal #85 carries, accepted with the issue:
//
//   1. template/demo-index.json lists every row the demo's copy of a seeded register adds or
//      changes, in BOTH directions: a row that differs from the default copy and is missing
//      from the index reds (eject would leave it behind), and so does an index entry that
//      resolves to nothing or names a row both copies share. The demo may replace only
//      seeded files, and a markdown register's copies may differ only in table rows.
//   2. No owned config, tool or register names a demo path (an install path only the demo
//      ships, or a package only it ships, such as `@app/notes`). Prose may; a JSON object
//      that says "demo": true is not read. scripts/lib/demo-index.mjs has the rules.
//
// Deterministic and hermetic: it reads the template trees and nothing else, one walk each.
// It runs in the factory (lint.yml, CONTRIBUTING's Local development list, the factory Stop
// hook), never in an install's chain.
//
//   node scripts/check-demo-index.mjs                     # check (exit 1 on any finding)
//   node scripts/check-demo-index.mjs --write             # regenerate the index; refuses
//                                                         # while any other finding stands
//   node scripts/check-demo-index.mjs --template <dir>    # judge another template root
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  demoNeedles,
  expectedIndex,
  INDEX_FILE,
  INDEX_LABEL,
  indexProblems,
  ownedProblems,
  readCommittedIndex,
  renderIndex,
} from './lib/demo-index.mjs'

const USAGE = 'usage: node scripts/check-demo-index.mjs [--write] [--template <dir>]'

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { write: false, template: fileURLToPath(new URL('../template/', import.meta.url)) }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') opts.write = true
    else if (argv[i] === '--template' && i + 1 < argv.length) opts.template = argv[++i]
    else {
      console.error(USAGE)
      process.exit(1)
    }
  }
  return opts
}

/** @param {string[]} problems @returns {never} */
function failWith(problems) {
  console.error(`demo-index: FAIL (${problems.length})`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(`Regenerate the index with \`node scripts/check-demo-index.mjs --write\` once every other finding is fixed; never edit ${INDEX_LABEL} by hand.`)
  process.exit(1)
}

const opts = parseArgs(process.argv.slice(2))
const expected = expectedIndex(opts.template)
const structural = [...expected.problems, ...ownedProblems(opts.template, demoNeedles(opts.template))]
const rendered = renderIndex(expected.rows)

if (opts.write) {
  if (structural.length > 0) failWith(structural)
  writeFileSync(join(opts.template, INDEX_FILE), rendered)
  console.log(`demo-index: wrote ${INDEX_LABEL} — ${expected.rows.length} row(s) over ${expected.registers.size} register(s)`)
  process.exit(0)
}

const committed = readCommittedIndex(opts.template)
if ('problem' in committed) failWith([...structural, committed.problem])
const problems = [...structural, ...indexProblems(opts.template, committed.rows, expected.rows)]
if (problems.length === 0 && readFileSync(join(opts.template, INDEX_FILE), 'utf8') !== rendered) {
  problems.push(`${INDEX_LABEL} lists the right rows but is not in generated form (order, keys or comment) — regenerate it with --write`)
}
if (problems.length > 0) failWith(problems)
console.log(
  `demo-index: OK — ${expected.rows.length} row(s) over ${expected.registers.size} register(s), indexed both ways; no owned file names a demo path`,
)
