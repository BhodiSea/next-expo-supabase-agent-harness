#!/usr/bin/env node
// check-tier-coverage — every one-surface gate DECLARES its surface.
//
// docs/harness/enforcement-tiers.md opens with "A tier is legitimate. An undeclared tier the
// docs deny is not," and then closed with a promise: making a gate author declare their
// surface "is a factory-side control … and it is 0.4.0". This is that control.
//
// It is factory-side, not chain step 32, because that is where gate scripts are authored. A
// consumer cannot answer for a scan root the harness hard-coded, and a red in their chain
// for the harness's undeclared tier is a red they can only silence.
//
// THE RULE. A shipped `template/base/tools/check-*.mjs` that hard-codes `apps/mobile` or
// `apps/web` in a scan-root position covers ONE product surface. Every such gate needs a row
// in the tiers table naming it in the `Gate` column — where a reviewer states what it does
// NOT cover, why, what compensates, and the release the gap closes in.
//
// Five layers were in exactly this state when the check was first run (`i18n`,
// `route-manifest`, `perf-budget`, `build`, `styleguide`), which is the answer to whether a
// control like this is worth its lines.
//
// 0.5.0: the derivation moved to template/base/tools/lib/live-controls.mjs and this script
// IMPORTS it. The direction matters and is the opposite of the obvious one — the npm
// `files` list ships only installer/ and template/, so a template gate could never import
// from scripts/. check-docs-sync.mjs needs the same "is this gate single-surface" answer to
// judge an arrived `Target`, and two copies of the derivation would let a gate be
// single-surface for one control and not the other.
// SOURCE: docs/harness/enforcement-tiers.md ("What this table does NOT do")
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { singleSurfaceGates } from '../template/base/tools/lib/live-controls.mjs'

const TOOLS = fileURLToPath(new URL('../template/base/tools', import.meta.url))
const TIERS = fileURLToPath(
  new URL('../template/base/docs/harness/enforcement-tiers.md', import.meta.url),
)
const CONFIG = fileURLToPath(new URL('../template/base/tools/harness.config.mjs', import.meta.url))

const problems = []

const tiersText = readFileSync(TIERS, 'utf8')
// The `Gate` column of every data row: the first cell, backticked.
const declared = new Set(
  [...tiersText.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1].replace(/\.mjs$/, '')),
)
if (declared.size < 8) {
  problems.push(
    `only ${String(declared.size)} row(s) parsed out of ${TIERS.replace(/.*template\//, 'template/')} — the Gate column must be a backticked first cell on every data row, or this closure passes vacuously`,
  )
}

const configText = readFileSync(CONFIG, 'utf8')
const singleSurface = singleSurfaceGates({ toolsDir: TOOLS, configText })
const stepFor = new Map(singleSurface.filter((g) => g.key !== g.file).map((g) => [g.file, g.key]))

if (singleSurface.length < 3) {
  problems.push(
    `only ${String(singleSurface.length)} single-surface gate(s) detected — the harness ships more than that, so SCAN_ROOT_RE is not matching and this closure is vacuous`,
  )
}

for (const g of singleSurface) {
  // A row may name the chain STEP (`i18n`) or the SCRIPT (`check-mutation-ratchet.mjs`).
  if (declared.has(g.key) || declared.has(g.file.replace(/\.mjs$/, ''))) continue
  const asStep = stepFor.has(g.file) ? ` (chain/Stop step \`${g.key}\`)` : ''
  problems.push(
    `${g.file}${asStep} scans only ${g.roots.join(', ')} — one product surface — but has no row in docs/harness/enforcement-tiers.md. Add one keyed \`${g.key}\` in the Gate column, stating what it does NOT cover, why, what compensates, and the release the gap closes in (or \`—\` when the other surface genuinely needs a different instrument). A tier is legitimate; an undeclared one is not.`,
  )
}

if (problems.length > 0) {
  console.error(`TIER COVERAGE: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThis is the control docs/harness/enforcement-tiers.md promised for 0.4.0. A gate that covers half the product is a defensible engineering position; one that does so without saying which half is a claim the docs deny.',
  )
  process.exit(1)
}

console.log(
  `TIER COVERAGE: CLEAN (${String(singleSurface.length)} single-surface gate(s), each declared in enforcement-tiers.md; ${String(declared.size)} row(s) parsed)`,
)
