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
const WEB_APP = 'apps/web'
const BUDGET_FILE = 'tools/bundle-budget.json'

// Forbidden markers in a shipped CLIENT bundle. postgresql:// is the spec-equal alias of
// postgres:// — matching only one was a purity hole. EXPO_TOKEN is the EAS credential name,
// sk_live_ the live-mode secret-key prefix shape, and sb_secret_ Supabase's current secret
// key prefix (the legacy service-role key is a JWT, so its NAME is what is greppable;
// the new format has a literal prefix, which is greppable by VALUE).
// Hoisted above the surface branch because both surfaces are judged against the same list:
// a service-role key is exactly as fatal in a `.next` chunk as in a Hermes bundle, and two
// lists would drift the way every other duplicated list in this repo has.
//
// AND WHY sb_secret_ IS JUDGED ON THE WEB SURFACE ONLY. Two facts, both measured on a real
// Hermes export rather than reasoned about:
//   1. `packages/platform/supabase/src/credentials.ts` ships
//      `const SECRET_KEY_PREFIX = 'sb_secret_'` — the constant the runtime uses to REFUSE a
//      secret key on a client surface — and the mobile app imports it, so the literal is in
//      every Hermes bundle by construction. As a bare substring this reddened `build` on
//      every scaffold that had run an export, accusing the code that prevents the leak of
//      being the leak.
//   2. Tightening it to a SHAPE does not help on that surface, which is the part only
//      execution showed. Hermes stores its string table contiguously with no delimiter
//      between entries, so the shipped constant runs straight into whatever was interned
//      next. The observed bytes were `…(received \`%s\`).%` + `sb_secret_` +
//      `_getObserverIDcrk-Cans-CAdd`, which satisfies any "prefix plus N characters of key
//      material" rule for a healthy N. There is no quantifier that is safe there, and
//      picking a bigger one would only move the coincidence.
// `.next/static` has no such problem: it is JavaScript text, so the value sits inside
// quotes and a shape rule means what it says. So the VALUE scan runs on the web surface,
// where it is decidable, and the mobile surface keeps the NAME markers — which is what the
// original comment above already claimed was the greppable half for the legacy JWT key.
// `sk_live_` stays on BOTH as a plain substring: nothing in the template ships it as a
// constant, so it has neither problem. The asymmetry is evidence, not oversight.
const SB_SECRET_KEYLIKE = /sb_secret_[A-Za-z0-9_-]{16,}/g
const PLACEHOLDER = /example|placeholder|not[-_]a[-_]real|do[-_]not[-_]use|dummy|fake/i

/**
 * Does `text` carry this forbidden marker? A string marker is a plain substring; a RegExp
 * marker must match at least one hit that is NOT placeholder-shaped.
 * @param {string} text
 * @param {string | RegExp} marker
 * @returns {boolean}
 */
function carries(text, marker) {
  if (typeof marker === 'string') return text.includes(marker)
  return (text.match(marker) ?? []).some((hit) => !PLACEHOLDER.test(hit))
}

/**
 * How a marker is named in a finding.
 * @param {string | RegExp} marker
 * @returns {string}
 */
function label(marker) {
  return typeof marker === 'string' ? marker : marker.source
}

const FORBIDDEN = [
  ['SUPABASE_SERVICE_ROLE_KEY', 'the RLS-bypassing service-role key in the client bundle'],
  [
    'createServiceRoleClient_BYPASSES_RLS',
    'the RLS-bypassing service-role factory in the client bundle',
  ],
  ['postgres://', 'connection string in the client bundle'],
  ['postgresql://', 'connection string in the client bundle'],
  ['EXPO_TOKEN', 'EAS credential name in the client bundle'],
  ['sk_live_', 'live secret-key material reference in the client bundle'],
  ['BEGIN PRIVATE KEY', 'private key material in the client bundle'],
  ['BEGIN RSA PRIVATE KEY', 'private key material in the client bundle'],
]

// Judged on `.next/static` only — see the note above on why a value scan is decidable in
// JavaScript text and is not on a Hermes string table.
const FORBIDDEN_WEB_ONLY = [
  [SB_SECRET_KEYLIKE, 'a Supabase SECRET key (sb_secret_…) in the client bundle'],
]

// ── the WEB surface (0.5.0) ────────────────────────────────────────────────────────
//
// WHY THIS IS A SEPARATE MODE AND NOT PART OF THE CHAIN STEP. docs/harness/
// enforcement-tiers.md carried `build … Target 0.5.0` with the reason written into the row:
// a web equivalent needs a `next build`, which is minutes, not seconds. Putting it in the
// validate chain would either slow every validate by a full Next build or — worse — make the
// chain gate fail closed in CI jobs that never run one. So the chain keeps the mobile
// export, and this mode runs in the path-filtered `web-build` job that DOES have a build.
//
// AND WHY IT SCANS `.next/static` ONLY. `.next/server/**` legitimately contains the
// service-role factory, the server env schema and every server-only import — that is what
// a server build IS. Scanning it would red on correct code, and a gate that reds on correct
// code gets deleted. `.next/static/**` is what a browser downloads, so a forbidden marker
// there is a shipped leak by definition.
if (process.argv.includes('--web')) {
  const out = `${WEB_APP}/.next`
  const client = `${out}/static`
  if (!existsSync(client)) {
    skipOrFail(
      GATE,
      `${client} not found — run \`pnpm --filter web build\` first. This mode reads a real build's CLIENT output; there is nothing to scan without one.`,
    )
  }
  // A build that FAILED still leaves client chunks behind. Next emits `.next/static` during
  // compilation and writes BUILD_ID only after the whole build succeeds, so a run that died
  // later — collecting page data, say — leaves a populated `static/` and no BUILD_ID. That
  // was not hypothetical: the first real execution of this mode scanned 34 chunks from a
  // build that had exited 1 and reported the bundle pure. In the shipped lane the build step
  // fails first and this step never runs, so the job is red either way; but "the job ordering
  // saves us" is not a property of this gate, and anyone running it by hand has no ordering.
  if (!existsSync(`${out}/BUILD_ID`)) {
    fail(
      GATE,
      `${client} exists but ${out}/BUILD_ID does not — Next writes BUILD_ID only after a build SUCCEEDS, so this output is from a build that did not finish. A partial bundle cannot be judged pure: the chunks that would have carried a leak may simply not have been emitted yet.`,
    )
  }
  const webHits = []
  let scanned = 0
  for (const rel of walkFiles(client)) {
    scanned += 1
    const text = readFileSync(`${client}/${rel}`).toString('latin1')
    for (const [marker, why] of [...FORBIDDEN, ...FORBIDDEN_WEB_ONLY]) {
      if (carries(text, marker)) {
        webHits.push(`${client}/${rel}: contains "${label(marker)}" — ${why}`)
      }
    }
  }
  // Anti-vacuity: a build whose client output is empty would report a pure bundle. That is
  // the same shape as a scanner that stopped matching, and it must not read as a pass.
  if (scanned === 0) {
    fail(
      GATE,
      `${client} exists but contains no files — a build that emitted no client chunks cannot be judged pure, and reporting it as pure is the exact vacuous-green this gate exists to prevent.`,
    )
  }
  failures(GATE, webHits)
  ok(
    GATE,
    `web client bundle is pure (${String(scanned)} file(s) under ${client}, no forbidden marker)`,
  )
}

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
    if (carries(text, marker)) hits.push(`${dist}/${rel}: contains "${label(marker)}" — ${why}`)
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
