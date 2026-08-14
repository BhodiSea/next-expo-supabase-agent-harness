#!/usr/bin/env node
// Scheduled control: emit the dependency inventory, and PROVE it is the whole tree.
//
// WHY THIS IS NOT A CHAIN STEP. `pnpm validate` must be deterministic and offline, and this
// shells out to a subcommand whose output embeds a fresh `serialNumber` on every run — so a
// chain step over it would either compare artefacts that differ by construction or re-derive
// the lockfile facts the chain already holds in `version-sync`. The chain owns the VERSIONS;
// this owns the INVENTORY, on the same cadence as the scan it feeds.
//
// WHY IT SITS IN osv-scan.yml. Asset discovery exists to support vulnerability scanning —
// that is ASD's own wording — so the inventory and the scan belong on one lane and one
// schedule. Same reasoning that put floor-review here: same concern, same clock.
//
// NO INSTALL, DELIBERATELY. `--lockfile-only` reads pnpm-lock.yaml and never the store, so
// this runs on a checkout with no node_modules, costs seconds, and cannot flake on a
// registry — which is what makes a DAILY cadence honest rather than aspirational. Verified
// against a workspace with no node_modules present at all.
//
//   node tools/check-sbom.mjs                     # generate, judge, write sbom.cdx.json
//   node tools/check-sbom.mjs --out=path.json     # ... somewhere else
//   node tools/check-sbom.mjs --sbom=path.json    # judge an EXISTING artefact (the red-proofs)
// SOURCE: https://cyclonedx.org/docs/1.7/json/ (the emitted format)
// SOURCE: docs/harness/gates-catalog.md (skip-local / fail-closed-CI asymmetry)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { commandFailureOutput, fail, failures, ok, runCmd, skipOrFail } from './lib/gate.mjs'
import { sbomProblems } from './lib/sbom.mjs'

const GATE = 'sbom-inventory'
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const lockPath = arg('lock', 'pnpm-lock.yaml')
const outPath = arg('out', 'sbom.cdx.json')
const given = arg('sbom', null)

// A repository with no committed lockfile has no inventory to take, and cannot have one:
// the 0.10.0 version-sync expiry is what makes a committed lockfile universal, and an
// install that predates it is simply not yet in scope. Loud local skip, hard CI failure —
// on the scheduled lane CI is always true, so an operator who has upgraded gets the red.
if (!existsSync(lockPath)) {
  skipOrFail(GATE, `${lockPath} does not exist, so there is no resolved tree to inventory`)
}

let text
if (given !== null) {
  if (!existsSync(given)) fail(GATE, `--sbom=${given} does not exist`)
  text = readFileSync(given, 'utf8')
} else {
  // `--lockfile-only` is not an optimisation here, it is the contract: the artefact must
  // describe the COMMITTED tree, and a store read would describe whatever this runner
  // happens to have hydrated.
  try {
    text = runCmd('pnpm sbom --sbom-format cyclonedx --lockfile-only')
  } catch (e) {
    fail(
      GATE,
      `\`pnpm sbom\` failed, so no inventory was produced:\n${commandFailureOutput(e).slice(-2000)}`,
    )
  }
}

let sbom
try {
  sbom = JSON.parse(text)
} catch (e) {
  fail(
    GATE,
    `the inventory is not valid JSON (${e.message}) — an unreadable artefact fails CLOSED rather than being reported as an empty tree`,
  )
}

const problems = sbomProblems({
  sbom,
  lockText: readFileSync(lockPath, 'utf8'),
  sbomPath: given ?? `\`pnpm sbom\` output`,
  lockPath,
})

failures(
  GATE,
  problems,
  'The inventory is judged against pnpm-lock.yaml in BOTH directions: a resolved package with no component means the emission under-reports the tree, and a component no lockfile entry resolves means the artefact describes a different tree than the one committed here.',
)

// Written only once the artefact has been judged: a lane that uploads first and checks
// second publishes the broken inventory alongside the red, and the upload is what a reader
// downloads six months later.
if (given === null) writeFileSync(outPath, text)

ok(
  GATE,
  `${String(sbom.components.length)} component(s), closed both ways against ${lockPath}${given === null ? `; written to ${outPath}` : ''}`,
)
