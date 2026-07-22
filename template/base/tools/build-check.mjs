#!/usr/bin/env node
// Gate: build — the mobile app must actually export, the produced bundle must be
// PURE (no server/database modules, no secret-shaped strings, no privileged DSNs),
// and it must fit the BYTE BUDGETS in tools/bundle-budget.json (gzip, per-chunk and
// total). Bundle purity is the runtime backstop for the depcruise/lint rules — a
// transitive import that sneaks past static analysis still shows up in the emitted
// bundle. The budget is the deterministic performance floor: a Hermes bundle twice
// the SDK floor is a shipped cold-start regression whether or not anyone profiles it.
//
// The export runs `--platform android` only: one canonical platform keeps the byte
// accounting deterministic and laptop-fast; the same JS compiles to the same
// bytecode format for ios, and the CI device lanes exercise both platforms for real.
//
// RATCHET: the absolute budgets carry ~3x headroom by design, so a 2-3x
// regression would ship green on them alone. When tools/perf-baseline.json exists
// (committed gzip bytes, regenerated ONLY by `pnpm perf:baseline` in a reviewed
// commit), the gate ALSO fails on measured > baseline × ratioCap — total always,
// per logical chunk when declared. Bytes are hardware-independent: deterministic
// everywhere, agent time included. No baseline → a NOTE names the file and the
// command, and the absolute-cap behavior stays byte-identical; a MALFORMED
// baseline fails closed. Measurement lives in lib/bundle-measure.mjs, shared
// with the regenerator, so the two can never measure differently.
// SOURCE: docs/harness/README.md (build gate; mobile-bundle purity) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import {
  BASELINE_COMMAND,
  BASELINE_FILE,
  measureDist,
  parseBaseline,
  ratchetFindings,
} from './lib/bundle-measure.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'build'
const APP = 'apps/mobile'
const BUDGET_FILE = 'tools/bundle-budget.json'

if (!existsSync(`${APP}/package.json`)) skipOrFail(GATE, `${APP} not found (no mobile surface yet)`)
if (!existsSync('node_modules')) skipOrFail(GATE, 'node_modules missing — run pnpm install')

// Content-addressed local skip: a full expo export is the chain's most expensive
// step, and unchanged inputs (declared in lib/stamp-inputs.mjs) cannot change
// its verdict. CI always builds for real.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

try {
  runCmd(`pnpm --filter mobile exec expo export --platform android --output-dir dist`)
} catch (e) {
  fail(GATE, `expo export failed:\n${(e.stderr?.toString() ?? e.message).slice(-2000)}`)
}

const dist = `${APP}/dist`
if (!existsSync(dist)) fail(GATE, `expo export produced no ${dist}/`)

// Forbidden markers in the shipped client bundle. postgresql:// is the
// spec-equal alias of postgres:// — matching only one was a purity hole.
// EXPO_TOKEN is the EAS credential name and sk_live_ the live-mode secret-key
// prefix shape — neither has any business inside a shipped bundle.
const FORBIDDEN = [
  ['drizzle-orm', 'ORM code in the client bundle (server/db leak)'],
  ['MIGRATOR_DATABASE_URL', 'privileged DSN name in the client bundle'],
  ['postgres://', 'connection string in the client bundle'],
  ['postgresql://', 'connection string in the client bundle'],
  ['EXPO_TOKEN', 'EAS credential name in the client bundle'],
  ['sk_live_', 'live secret-key material reference in the client bundle'],
  ['BEGIN PRIVATE KEY', 'private key material in the client bundle'],
  ['BEGIN RSA PRIVATE KEY', 'private key material in the client bundle'],
]

const hits = []
// dist is walked EXHAUSTIVELY (no exclude set, no extension filter): purity
// markers must see every emitted file. The markers are ASCII, and latin1 is a
// lossless byte→char decode, so text files (metadata.json, --no-bytecode .js)
// match exactly — and the Hermes bytecode (.hbc) string table becomes
// searchable too, since Hermes stores ASCII strings contiguously. That half is
// BEST-EFFORT by nature (strings the compiler stores as UTF-16 are not
// contiguous under latin1); the depcruise/lint import rules remain the static
// first line, this scan is the runtime backstop. Byte accounting happens in
// the SHARED measurer below.
for (const rel of walkFiles(dist)) {
  const text = readFileSync(`${dist}/${rel}`).toString('latin1')
  for (const [marker, why] of FORBIDDEN) {
    if (text.includes(marker)) hits.push(`${dist}/${rel}: contains "${marker}" — ${why}`)
  }
}

// One measurement for BOTH byte checks (absolute budgets + ratchet), through the
// same lib the `pnpm perf:baseline` regenerator uses — gate and baseline can
// never disagree about what a byte is.
const measured = measureDist(dist)

// Byte budgets: gzip (what Hermes actually parses off device storage is closer
// to raw, but gzip normalizes compiler noise and matches how budgets are quoted).
// tools/bundle-budget.json is write-guard-protected — raising a budget is a
// human decision with a diff, never an agent convenience.
if (existsSync(BUDGET_FILE)) {
  let budget
  try {
    budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${BUDGET_FILE} is not valid JSON (${e.message}) — the budget must be reviewable data`,
    )
  }
  const kb = (bytes) => bytes / 1024
  const totalKb = kb(measured.totalBytes)
  const byBytes = (a, b) => b.gzipBytes - a.gzipBytes
  const biggestChunk = measured.files.filter((f) => f.isBundle).sort(byBytes)[0]
  const biggestAsset = measured.files.filter((f) => !f.isBundle).sort(byBytes)[0]

  if (typeof budget.totalGzipKb === 'number' && totalKb > budget.totalGzipKb) {
    hits.push(
      `bundle total ${totalKb.toFixed(1)} KB gzip exceeds the ${String(budget.totalGzipKb)} KB budget (${BUDGET_FILE}) — cut dependencies/assets or (human decision) raise the budget`,
    )
  }
  if (
    typeof budget.largestChunkGzipKb === 'number' &&
    biggestChunk !== undefined &&
    kb(biggestChunk.gzipBytes) > budget.largestChunkGzipKb
  ) {
    hits.push(
      `${dist}/${biggestChunk.rel}: ${kb(biggestChunk.gzipBytes).toFixed(1)} KB gzip exceeds the ${String(budget.largestChunkGzipKb)} KB per-chunk budget — cut the dependency that grew the entry bundle`,
    )
  }
  if (
    typeof budget.largestAssetGzipKb === 'number' &&
    biggestAsset !== undefined &&
    kb(biggestAsset.gzipBytes) > budget.largestAssetGzipKb
  ) {
    hits.push(
      `${dist}/${biggestAsset.rel}: ${kb(biggestAsset.gzipBytes).toFixed(1)} KB gzip exceeds the ${String(budget.largestAssetGzipKb)} KB per-asset budget`,
    )
  }

  // Per-image budgets (0.1.2, all optional — absent keys keep prior behavior
  // byte-identical). Images are classified by MAGIC BYTES (content-addressed
  // assets have no extensions) and measured RAW: compressed image formats
  // barely gzip, so raw bytes are what the device stores and decodes.
  const images = measured.files.filter((f) => f.imageFormat !== null)
  const biggestImage = [...images].sort((a, b) => b.rawBytes - a.rawBytes)[0]
  if (
    typeof budget.largestImageKb === 'number' &&
    biggestImage !== undefined &&
    kb(biggestImage.rawBytes) > budget.largestImageKb
  ) {
    hits.push(
      `${dist}/${biggestImage.rel}: ${kb(biggestImage.rawBytes).toFixed(1)} KB raw ${biggestImage.imageFormat} exceeds the ${String(budget.largestImageKb)} KB per-image budget (${BUDGET_FILE}) — resize/recompress the source asset (screens never need more pixels than they paint)`,
    )
  }
  if (typeof budget.maxImageCount === 'number' && images.length > budget.maxImageCount) {
    hits.push(
      `bundle ships ${String(images.length)} image file(s), over the maxImageCount ${String(budget.maxImageCount)} (${BUDGET_FILE}) — audit what rode in (unused densities, stray art, screenshots)`,
    )
  }
  if (typeof budget.pngOverKbPreferWebp === 'number') {
    for (const img of images) {
      if (img.imageFormat === 'png' && kb(img.rawBytes) > budget.pngOverKbPreferWebp) {
        hits.push(
          `${dist}/${img.rel}: ${kb(img.rawBytes).toFixed(1)} KB PNG exceeds the ${String(budget.pngOverKbPreferWebp)} KB PNG threshold (${BUDGET_FILE}) — convert the source to WebP (lossless WebP decodes natively on both RN platforms and typically cuts PNG bytes by a quarter or more), or keep the PNG deliberately by raising the threshold in review`,
        )
      }
    }
  }
} else {
  hits.push(
    `${BUDGET_FILE} missing — the bundle has no byte budget; restore it (write-guard-protected data)`,
  )
}

// The gzip ratchet: committed baseline × ratioCap, byte-true. Self-disables
// LOUDLY when the baseline is absent (a pre-baseline install keeps exactly the
// absolute-cap behavior above); fails CLOSED when it is malformed — an
// unreviewable ratchet must never fail open.
if (existsSync(BASELINE_FILE)) {
  let baseline
  try {
    baseline = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${BASELINE_FILE} ${e.message} — the ratchet FAILS CLOSED on unreviewable data; regenerate with \`${BASELINE_COMMAND}\` in a reviewed commit (the file is write-guard-protected)`,
    )
  }
  const { errs, notes } = ratchetFindings(measured, baseline)
  for (const note of notes) console.log(`${GATE}: NOTE — ${note}`)
  hits.push(...errs)
} else {
  console.log(
    `${GATE}: NOTE — ${BASELINE_FILE} absent: the gzip ratchet is OFF and only the absolute byte budgets in ${BUDGET_FILE} apply (~3x headroom — a sub-budget regression ships green). Generate the committed baseline with \`${BASELINE_COMMAND}\` (or \`node tools/perf-baseline.mjs\` on installs whose package.json predates the script) and commit it in a reviewed diff; see docs/runbooks/harness-upgrade.md (content-conditional checks)`,
  )
}

failures(GATE, hits)
recordGreen()
ok(
  GATE,
  `mobile bundle exports, is pure, and fits the byte budgets (gzip total ${String(measured.totalBytes)} B)`,
)
