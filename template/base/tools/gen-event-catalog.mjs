#!/usr/bin/env node
// Generator: the EVENT catalog — every event the platform + vertical catalogs declare, as a
// committed, regen-diffed artifact the `contracts` gate holds the registries to. Adding or
// removing an event without regenerating reds contracts.
//
// Enumeration walks each catalog through @app/events' own `listEvents()` (code-unit sorted),
// then merges + globally re-sorts + dedups. The catalog IMPORT LIST is curated on purpose,
// NOT a barrel scan: a barrel walk silently drops a catalog a vertical forgot to re-export,
// and there is no runtime brand to duck-type against (defineEventCatalog returns its argument
// unchanged). A new vertical adds ONE import line here — visible, reviewable, and impossible
// to forget without the diff showing it. Runs under tsx (needs an install), like its sibling.
//   node tools/gen-event-catalog.mjs           # write
//   node tools/gen-event-catalog.mjs --check    # regen-diff (exit 1 on drift)
// SOURCE: packages/platform/events/src/index.ts (listEvents + platformEvents)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { renderEvents } from './lib/inventory.mjs'

export const OUTPUT = 'tools/generated/event-catalog.json'

const { listEvents, platformEvents } = await import('@app/events')
// The Metro-safe barrel exposes noteEvents without pulling the vertical's DAL/write graph.
const { noteEvents } = await import('@app/notes/client')

// Every catalog the generator walks. ADD A LINE PER VERTICAL — the curation is the point.
const CATALOGS = [platformEvents, noteEvents]

const events = CATALOGS.flatMap((catalog) => listEvents(catalog))
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
