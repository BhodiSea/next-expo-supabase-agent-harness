// docs/cli.md IS A CLAIM ABOUT installer/cli.mjs, and until this test nothing read it. The
// page exists because the CLI's only reference was the USAGE literal behind `--help`; a
// reference that can drift from the code it describes is the class this repo refuses
// everywhere else (check-claims for the README, check-docs-sync for the shipped docs).
//
// The source of truth is the CODE, not the USAGE text: the parseArgs option table, the
// `command === '...'` dispatch, MODULES and TIERS in installer/lib/layout.mjs, and the
// placeholder registry. USAGE is itself prose and has drifted before (it lists eleven of
// the twelve modules), so closing the page over USAGE would copy that drift rather than
// catch it. cli.mjs is PARSED, never imported: it parses argv and exits on import.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MODULES, TIERS } from '../../installer/lib/layout.mjs'
import { PLACEHOLDERS } from '../../installer/lib/placeholders.mjs'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const cli = read('installer/cli.mjs')
const page = read('docs/cli.md')

const optionTable = cli.slice(cli.indexOf('options: {'), cli.indexOf('const command'))
const flags = [...optionTable.matchAll(/^ {4}'?([a-z][a-z-]*)'?: \{ type:/gm)].map((m) => m[1])
const commands = [...new Set([...cli.matchAll(/command === '([a-z]+)'/g)].map((m) => m[1]))]

test('the parse of cli.mjs is not vacuous', () => {
  // Every assertion below is a filter over these lists, so an empty parse would pass them all.
  assert.ok(flags.length >= 10, `only ${String(flags.length)} flag(s) parsed from the option table`)
  assert.ok(commands.includes('init') && commands.includes('graduate'), commands.join(', '))
  assert.ok(MODULES.length >= 10 && Object.keys(PLACEHOLDERS).length >= 10)
})

test('docs/cli.md names every flag the CLI parses', () => {
  for (const flag of flags) {
    assert.ok(page.includes(`--${flag}`), `docs/cli.md never mentions --${flag}, which installer/cli.mjs parses`)
  }
})

test('docs/cli.md names every command the CLI dispatches', () => {
  for (const command of commands) {
    assert.ok(page.includes(`\`${command}`), `docs/cli.md never mentions the \`${command}\` command`)
  }
})

test('docs/cli.md names every module, tier and placeholder, and no module that does not exist', () => {
  for (const name of [...MODULES, ...Object.keys(TIERS), ...Object.keys(PLACEHOLDERS)]) {
    assert.ok(page.includes(`\`${name}\``), `docs/cli.md never mentions \`${name}\``)
  }
  const section = page.slice(page.indexOf('## Modules'), page.indexOf('## Tiers'))
  const listed = [...section.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
  assert.deepEqual([...listed].sort(), [...MODULES].sort())
})

test('the USAGE text behind --help names every module, placeholder and command (1.0.2)', () => {
  // USAGE listed eleven of twelve modules and thirteen of fourteen placeholders through
  // 1.0.1, and its own header comment omitted `graduate`. It is prose, so it gets the same
  // closure the page gets.
  const usage = cli.slice(cli.indexOf('const USAGE = `'), cli.indexOf('`\n\ntry {'))
  assert.ok(usage.length > 200, 'the USAGE literal was not found in installer/cli.mjs')
  for (const name of [...MODULES, ...Object.keys(PLACEHOLDERS)]) {
    assert.ok(usage.includes(name), `--help never mentions ${name}`)
  }
  for (const command of commands.filter((c) => c !== 'help')) {
    assert.match(usage, new RegExp(`^ {2}${command}\\b`, 'm'), `--help has no line for the ${command} command`)
  }
})

test('the tier table matches TIERS', () => {
  for (const [tier, modules] of Object.entries(TIERS)) {
    const row = page.split('\n').find((line) => line.startsWith(`| \`${tier}\` |`))
    assert.ok(row, `no tier table row for \`${tier}\``)
    if (modules.length === MODULES.length) assert.match(row, /all of them/)
    else if (modules.length === 0) assert.match(row, /none/)
    else for (const m of modules) assert.ok(row.includes(`\`${m}\``), `tier \`${tier}\` row omits \`${m}\``)
  }
})
