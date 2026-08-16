#!/usr/bin/env node
// sweep-registry-deprecations — the REVIEW METHOD tools/eol.json's header describes, as a
// tool instead of a paragraph. Reads a rendered scaffold's pnpm-lock.yaml, asks the npm
// registry about EVERY resolved package@version, and prints the ones the vendor has
// deprecated — which is the only way to answer the question the register's review window
// exists for: has anything become deprecated SINCE the last resolution? Re-reading the
// committed lockfile can only prove no row went stale (pnpm copies the `deprecated` flag
// in at resolve time), so a review that does not touch the registry is not a review.
//
//   usage: node scripts/sweep-registry-deprecations.mjs <path/to/pnpm-lock.yaml> [--concurrency=16]
//   output: one line per deprecated package@version (JSON on stdout), a summary on stderr.
//
// FACTORY-SIDE, NOT A GATE: it is network-bound by subject and its output is reviewed data
// (a maintainer compares it to tools/eol.json's rows and moves reviewedOn/reviewedUntil in
// a diff). It never writes.
// SOURCE: https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseLockVersions } from '../template/base/tools/lib/framework-floor.mjs'

const lockPath = process.argv[2]
if (!lockPath || lockPath.startsWith('--')) {
  console.error(
    'usage: node scripts/sweep-registry-deprecations.mjs <path/to/pnpm-lock.yaml> [--concurrency=16]',
  )
  process.exit(2)
}
const concurrency = Number(
  process.argv.find((a) => a.startsWith('--concurrency='))?.slice('--concurrency='.length) ?? 16,
)

const pairs = [...parseLockVersions(readFileSync(lockPath, 'utf8')).entries()].flatMap(
  ([name, versions]) => [...versions].map((version) => ({ name, version })),
)
if (pairs.length === 0) {
  console.error(
    'sweep: the lockfile resolved zero package@version pairs — nothing to sweep is a broken input, not a clean one',
  )
  process.exit(1)
}

let errors = 0
const deprecated = []
async function probe({ name, version }) {
  const res = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    errors += 1
    console.error(`sweep: ${name}@${version} → HTTP ${String(res.status)}`)
    return
  }
  const body = await res.json()
  if (typeof body.deprecated === 'string' && body.deprecated.trim() !== '') {
    deprecated.push({ name, version, deprecated: body.deprecated })
  }
}
let at = 0
async function worker() {
  while (at < pairs.length) {
    const i = at
    at += 1
    await probe(pairs[i])
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))

deprecated.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
for (const d of deprecated) console.log(JSON.stringify(d))
console.error(
  `sweep: ${String(pairs.length)} package@version pair(s) probed, ${String(deprecated.length)} deprecated, ${String(errors)} error(s)`,
)
process.exit(errors > 0 ? 1 : 0)
