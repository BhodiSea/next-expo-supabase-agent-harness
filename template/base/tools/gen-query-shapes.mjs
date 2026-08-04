#!/usr/bin/env node
// Generator: the QUERY-SHAPE manifest — every database query the DALs actually issue,
// recorded by EXECUTING them through the harness-owned recording port
// (tools/lib/query-recorder.mjs) and committed as a regen-diffed artifact the
// `contracts` gate holds the source to.
//
// WHY THIS IS GENERATED AND NOT WRITTEN DOWN. A hand-authored query manifest is a
// tautology: the same turn authors the DAL and the manifest, and the moment a check
// reds the cheapest repair is to edit the manifest until it agrees with the code. The
// only manifest worth gating on is one no edit survives — this file rebuilds it from
// the DAL's own behaviour, and `contracts` reds if the committed copy disagrees.
//
// THE CLOSURE THAT MAKES IT NON-VACUOUS. A generator driven by a hand-written probe
// list has a second hole: add a DAL function, add no probe, and the manifest is
// complete-looking and blind. Each probe module therefore re-exports its DAL as `DAL`,
// and generation FAILS unless every exported function of that module is driven by at
// least one probe. Adding an unprobed query is a red, not a silence.
//
//   node tools/gen-query-shapes.mjs           # write the committed manifest
//   node tools/gen-query-shapes.mjs --check   # regen-diff (exit 1 on drift)
//
// Runs under tsx (the verticals are source-only ESM), so it needs an install — the
// `contracts` gate skips loudly without one and fails closed in CI.
// SOURCE: docs/harness/README.md (generated artifacts are runtime walks) [corpus: harness/doctrine]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { renderQueryShapes } from './lib/inventory.mjs'
import { createRecorder, normalizeChain } from './lib/query-recorder.mjs'
// Convention-based probe discovery is SHARED with check-query-shapes.mjs: the gate has
// to tell an uninstrumented DAL (ramped) from an empty manifest beside an instrumented
// one (fatal), and those two verdicts must be derived from one definition, not two.
import { probeModules } from './lib/query-shapes.mjs'

export const OUTPUT = 'tools/generated/query-shapes.json'

function die(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function recordVertical({ path, vertical }) {
  const mod = await import(pathToFileURL(join(process.cwd(), path)).href)
  const probes = mod.QUERY_PROBES
  const dal = mod.DAL
  if (!Array.isArray(probes) || probes.length === 0) {
    die(`${path}: must export a non-empty QUERY_PROBES array`)
  }
  if (dal === undefined || dal === null || typeof dal !== 'object') {
    die(
      `${path}: must re-export its DAL module namespace as \`DAL\` (the coverage closure reads it)`,
    )
  }

  // The closure. `DAL` is a namespace import of the REAL data module, so this compares
  // the probe list against the functions that exist right now — not against a list
  // somebody remembered to update.
  const dalFns = Object.keys(dal)
    .filter((k) => typeof dal[k] === 'function')
    .sort()
  const probed = new Set(probes.map((p) => p.fn))
  const unprobed = dalFns.filter((fn) => !probed.has(fn))
  if (unprobed.length > 0) {
    die(
      `${path}: ${unprobed.join(', ')} — every exported DAL function must be driven by at least one QUERY_PROBES entry, or its query is never in the manifest and no gate can see it`,
    )
  }
  const unknown = [...probed].filter((fn) => !dalFns.includes(fn))
  if (unknown.length > 0) {
    die(`${path}: probe(s) name ${unknown.join(', ')}, which the DAL module does not export`)
  }

  const shapes = []
  for (const probe of probes) {
    const { chains, db } = createRecorder()
    await probe.run(db)
    if (chains.length === 0) {
      die(
        `${path}: probe ${probe.id} issued NO query — a probe that records nothing certifies nothing (check the inputs reach the query rather than an early return)`,
      )
    }
    chains.forEach((chain, i) => {
      shapes.push({
        id: chains.length === 1 ? `${vertical}.${probe.id}` : `${vertical}.${probe.id}/${i}`,
        vertical,
        fn: probe.fn,
        ...normalizeChain(chain),
      })
    })
  }
  return shapes
}

const modules = probeModules()
const shapes = []
for (const entry of modules) shapes.push(...(await recordVertical(entry)))
const next = renderQueryShapes(shapes)

// Nothing to record and nothing recorded. An install that predates the probes has no
// query-probes.ts (seedOnInitOnly — `update` withholds them deliberately) and no
// manifest, and "regenerate from zero probes" can never reproduce a file that does not
// exist, so a plain diff would red it forever with advice it cannot take. This is the
// ONLY tolerated pair: probes present, or a manifest present, and the diff runs.
// check-query-shapes.mjs draws the same line from the same probeModules(), so the tree
// this exits 0 on is exactly the tree that gate ramps.
if (modules.length === 0 && !existsSync(OUTPUT)) {
  process.stdout.write(
    `${OUTPUT}: no packages/verticals/*/src/data/query-probes.ts and no manifest — nothing to record (pre-0.2.0 install; adopt with \`update --refresh-seeded packages/verticals/\`)\n`,
  )
  process.exit(0)
}

if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
  if (next !== committed) {
    process.stderr.write(
      `${OUTPUT} is stale — a DAL query changed without regenerating. Run \`pnpm gen\` and commit the diff.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${OUTPUT}: in sync (${String(shapes.length)} query shapes)\n`)
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, next)
  process.stdout.write(`wrote ${OUTPUT} (${String(shapes.length)} query shapes)\n`)
}
