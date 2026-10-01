#!/usr/bin/env node
// Generator: the EVENT catalog — every event the platform + vertical catalogs declare, as a
// committed, regen-diffed artifact the `contracts` gate holds the registries to. Adding or
// removing an event without regenerating reds contracts.
//
// The catalogs are the platform's, plus each packages/verticals/* whose `./client` entry
// names EVENT_CATALOG (tools/lib/event-catalogs.mjs finds them, reading the code with its
// comments blanked). The opt-in lives in the vertical, not here, because this file is
// harness-owned and hash-pinned: an import list here could only grow by forking it. A
// vertical without the opt-in is never imported. A direct run of this generator lists it as
// "not catalogued" on stdout, but the `contracts` gate discards that output, so the line is
// for whoever runs `pnpm gen`. Each catalog is walked through @app/events' own
// `listEvents()` (code-unit sorted), then the rows are merged and globally re-sorted, and a
// name two catalogs share throws. Runs under tsx (needs an install), like its sibling.
//   node tools/gen-event-catalog.mjs           # write
//   node tools/gen-event-catalog.mjs --check    # regen-diff (exit 1 on drift)
// SOURCE: packages/platform/events/src/index.ts (listEvents + platformEvents)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { CATALOG_EXPORT, catalogOf, discoverVerticals } from './lib/event-catalogs.mjs'
import { renderEvents } from './lib/inventory.mjs'

export const OUTPUT = 'tools/generated/event-catalog.json'

const { listEvents, platformEvents } = await import('@app/events')
const verticals = discoverVerticals()
const catalogs = [platformEvents]
for (const v of verticals.filter((x) => x.declares)) {
  const mod = await import(pathToFileURL(join(process.cwd(), v.file)).href)
  catalogs.push(catalogOf(mod[CATALOG_EXPORT], v.file))
}
// The 1.0.x compatibility entry (the one import 1.0.x hard-coded) left with the example
// at 2.0.0 (#85): a vertical is catalogued by its own EVENT_CATALOG export, or not at all.
for (const v of verticals) {
  if (v.declares) continue
  process.stdout.write(
    `${OUTPUT}: ${v.pkg} is not catalogued (its ./client declares no ${CATALOG_EXPORT})\n`,
  )
}

const events = catalogs.flatMap((catalog) => listEvents(catalog))
const next = renderEvents(events)

if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
  if (next !== committed) {
    process.stderr.write(
      `${OUTPUT} is stale — an event catalog changed without regenerating. Run \`pnpm gen\` and commit the diff.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${OUTPUT}: in sync (${String(events.length)} events)\n`)
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, next)
  process.stdout.write(`wrote ${OUTPUT}\n`)
}
