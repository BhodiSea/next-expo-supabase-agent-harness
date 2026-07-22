// Regenerates the COMMITTED apps/server/openapi.json from the live route table.
// Run via `pnpm --filter server openapi:emit` (tsx). The contracts gate re-runs
// this and fails on any diff, so the committed file can never drift.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'

// Stable stringify: recursively sorted keys + trailing newline, so regeneration
// is byte-deterministic regardless of route registration order.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeysDeep(child)]),
    )
  }
  return value
}

const response = await createApp().request('/openapi.json')
if (!response.ok) {
  throw new Error(`openapi route returned ${String(response.status)}`)
}
const doc: unknown = await response.json()
const serialized = `${JSON.stringify(sortKeysDeep(doc), null, 2)}\n`

// --stdout: print the document without touching disk — the contracts gate diffs
// this against the committed file (regenerate-and-compare, no working-tree write).
if (process.argv.includes('--stdout')) {
  process.stdout.write(serialized)
} else {
  const target = new URL('../openapi.json', import.meta.url)
  writeFileSync(target, serialized)
  console.log(`wrote ${fileURLToPath(target)}`)
}
