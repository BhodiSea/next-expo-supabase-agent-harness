#!/usr/bin/env node
// Generator: the WEB route registry — every page apps/web/app serves, as a committed,
// regen-diffed artifact the `route-manifest` gate holds the App Router's file tree to.
// Adding, moving or deleting a page without regenerating reds route-manifest.
//
//   node tools/gen-web-routes.mjs           # write the committed registry
//   node tools/gen-web-routes.mjs --check   # regen-diff (exit 1 on drift)
//
// Enumeration is a FILE WALK, not a runtime import, and that is the opposite choice from
// gen-action-inventory.mjs on purpose. The tRPC router is a value: the only honest way to
// enumerate its procedures is to build it and read `_def.procedures`, which costs an install.
// The App Router's route set is a FILE TREE — position IS the definition — so walking it needs
// no install, no Next build and no network, which is what lets this run inside the chain on a
// laptop with cold node_modules and inside CI's static lane.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/page (a `page` file makes
// its folder a route; the folder path is the URL)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { discoverPages, readAllowlist, readMetas, renderRegistry } from './lib/web-routes.mjs'

export const APP_DIR = 'apps/web/app'
export const OUTPUT = 'apps/web/lib/routes.generated.ts'
const ALLOWLIST = 'tools/web-route-allowlist.json'

if (!existsSync(APP_DIR)) {
  process.stderr.write(`${APP_DIR} not found — nothing to generate (no web surface here).\n`)
  process.exit(0)
}

// The allowlist is read here for ONE reason: chrome pages carry no meta, so without it the
// generator would report every reviewed chrome surface as un-registrable and refuse to run.
// Its parse errors are reported and fatal — a malformed allowlist must never read as "nothing
// is allowlisted", which would be the same refusal wearing a different message.
const { allow, errors: allowErrs } = readAllowlist(ALLOWLIST)
if (allowErrs.length > 0) {
  process.stderr.write(`${ALLOWLIST} is unusable:\n`)
  for (const e of allowErrs) process.stderr.write(`  - ${e}\n`)
  process.exit(1)
}

const pages = discoverPages(APP_DIR)
const { entries, problems } = readMetas(pages, allow)
if (problems.length > 0) {
  process.stderr.write(
    `${OUTPUT} cannot be generated — ${String(problems.length)} page(s) are not registrable:\n`,
  )
  for (const p of problems) process.stderr.write(`  - ${p}\n`)
  process.stderr.write(
    'Give each page a page.meta.ts ({id, titleKey, states}), or (human decision) allowlist it as chrome with a reason in tools/web-route-allowlist.json. `node tools/check-web-routes.mjs` reports the same set with the allowlist applied.\n',
  )
  process.exit(1)
}

const next = renderRegistry(entries)

if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
  if (next !== committed) {
    process.stderr.write(
      `${OUTPUT} is stale — apps/web/app's route set changed without regenerating. Run \`pnpm gen\` and commit the diff.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${OUTPUT}: in sync (${String(entries.length)} route(s))\n`)
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, next)
  process.stdout.write(`wrote ${OUTPUT} (${String(entries.length)} route(s))\n`)
}
