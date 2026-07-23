#!/usr/bin/env node
// Generator: the ACTION inventory — every tRPC procedure the composed appRouter exposes,
// as a committed, regen-diffed artifact the `contracts` gate holds the router to. Adding or
// removing a procedure without regenerating reds contracts.
//
// Enumeration is a RUNTIME WALK of the composed router, never a source lex: tRPC v11 stores
// procedures as a flat dotted-path record (`appRouter._def.procedures`), and Object.keys is
// the exact idiom packages/api/src/skew.test.ts asserts against. A regex over routers/*.ts
// would silently drop any procedure whose name carries a digit. Runs under tsx (@app/api is
// source-only ESM), so it needs an install — the `contracts` gate skips loudly without one
// and fails closed in CI.
//   node tools/gen-action-inventory.mjs           # write the committed inventory
//   node tools/gen-action-inventory.mjs --check    # regen-diff (exit 1 on drift)
// SOURCE: packages/api/src/index.ts (appRouter = router({ notes, system }))
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { renderActions } from './lib/inventory.mjs'

export const OUTPUT = 'tools/generated/action-inventory.json'

// Lazy value import: only when the CLI actually runs, so nothing (a test, another tool)
// imports OUTPUT and pulls the server graph as a side effect.
const { appRouter } = await import('@app/api')
const next = renderActions(appRouter._def.procedures)

if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
  if (next !== committed) {
    process.stderr.write(
      `${OUTPUT} is stale — the tRPC router changed without regenerating. Run \`pnpm gen\` and commit the diff.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(
    `${OUTPUT}: in sync (${String(Object.keys(appRouter._def.procedures).length)} actions)\n`,
  )
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, next)
  process.stdout.write(`wrote ${OUTPUT}\n`)
}
