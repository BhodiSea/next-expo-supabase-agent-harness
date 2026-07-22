// tools/lib/bundle-measure.mjs — the ONE implementation of "how many gzip bytes
// is the bundle". The build gate (tools/build-check.mjs) and the baseline
// regenerator (tools/perf-baseline.mjs, `pnpm perf:baseline`) both measure
// through THIS module, so the ratchet can never compare a gate-measured byte
// against a differently-measured baseline byte. Bytes are hardware-independent:
// the baseline×ratioCap delta check is deterministic everywhere, agent time
// included — unlike wall-clock budgets, which stay in their own gate.
// SOURCE: docs/harness/gates-catalog.md (build gate — gzip ratchet) [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { walkFiles } from './fs-walk.mjs'

export const BASELINE_FILE = 'tools/perf-baseline.json'
// Canonical spelling of the regeneration ceremony (package.json script →
// node tools/perf-baseline.mjs). Installs whose seeded package.json predates
// the script run the node command directly — the FIX lines name both.
export const BASELINE_COMMAND = 'pnpm perf:baseline'

// Defaults seeded into a from-scratch baseline; both survive regeneration once
// a human has tuned them (composeBaseline preserves the previous values).
const DEFAULT_RATIO_CAP = 1.25
// Bounds the NIGHTLY CI device-lane Android artifact (prebuild →
// `gradlew assembleDebug` — a debug APK bundling Hermes, every ABI, and the
// whole native dependency graph) — a coarse bundled-dependency canary, not a
// ship-size promise. The first nightly run prints the real size; ratchet DOWN
// in a reviewed commit.
const DEFAULT_INSTALLER_BUDGET_BYTES = 350 * 1024 * 1024
const DEFAULT_COMMENT =
  'Committed gzip baseline for the build gate byte-true ratchet (tools/build-check.mjs): ' +
  'the bundle fails when measured gzip bytes exceed baseline × ratioCap — long before the ' +
  'absolute budgets in tools/bundle-budget.json (~3x headroom) would notice. Bytes are ' +
  'hardware-independent, so this check is deterministic everywhere, agent time included. ' +
  'Regenerate ONLY via `pnpm perf:baseline` after a DELIBERATE size change and commit the ' +
  'diff for review — the file is write-guard-protected. installerBudgetBytes bounds the ' +
  'nightly CI device-lane debug APK (a coarse bundled-dependency canary, not a ship-size ' +
  'promise) — the first nightly prints the real size; ratchet it DOWN in a reviewed commit.'

const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

// `expo export` emits the app bundle as Hermes bytecode at
// `_expo/static/js/<platform>/<entry>-<32 hex md5>.hbc` (plain `.js` under
// --no-bytecode) — the basename follows the entry module, the hash follows the
// bytes. Stripping the content hash and keying by `<platform>/<basename>`
// ("android/entry.hbc") names WHAT the chunk is, not the bytes it happens to
// contain today, so the key stays stable across builds while the hash churns.
// SOURCE: https://docs.expo.dev/guides/analyzing-bundles/
function logicalChunkKey(rel) {
  const parts = rel.split('/')
  const base = (parts.pop() ?? rel).replace(/-[0-9a-f]{32}(?=\.[a-z0-9]+$)/, '')
  const platform = parts.pop()
  return platform === undefined ? base : `${platform}/${base}`
}

// A bundle chunk is anything under the export's JS output root — `.hbc`
// bytecode by default, `.js` under --no-bytecode; both are the shipped program.
const isBundleChunk = (rel) => rel.startsWith('_expo/static/js/')

// Content-addressed assets (`assets/<md5>`, no extension, no stable name): the
// hash IS the filename, so per-file keys are content identity, not logical
// identity — a one-pixel icon edit would orphan its baseline key (a NOTE) and
// land the bytes on a fresh, unbounded key, making a per-file ratchet
// meaningless. They aggregate under the single stable key "assets" instead:
// every asset byte stays under one ratcheted key, and a heavyweight new asset
// (a font, an unoptimized image) reds the ratchet like any other chunk growth.
const isAsset = (rel) => rel.startsWith('assets/')
const ASSETS_KEY = 'assets'

// Magic-byte image sniffing: content-addressed assets carry NO extension (the
// hash is the filename), so the leading bytes are the only honest classifier.
// Covers the four formats Metro bundles for RN image sources.
// SOURCE: PNG signature (ISO/IEC 15948 §5.2), JPEG SOI marker, GIF87a/89a
// header, WebP RIFF container — first-bytes file identification
// https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Image_types
export function imageFormatOf(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return 'png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

// Walk the emitted dist/ EXHAUSTIVELY (same no-exclude contract as the purity
// scan) and gzip every file: totalBytes is the ratchet's primary invariant;
// chunks maps each logical bundle key to its gzip bytes (two files stripping
// to the same key sum — deterministic, and renames still land on the total),
// plus the "assets" aggregate. Remaining files (metadata.json) are bounded by
// the total alone.
export function measureDist(dist) {
  const files = []
  for (const rel of walkFiles(dist)) {
    const buffer = readFileSync(`${dist}/${rel}`)
    files.push({
      rel,
      gzipBytes: gzipSync(buffer).length,
      // Raw bytes + sniffed format feed the per-image budgets: images ship
      // stored (compressed formats barely gzip), so raw is the honest size.
      rawBytes: buffer.length,
      imageFormat: imageFormatOf(buffer),
      isBundle: isBundleChunk(rel),
    })
  }
  const chunks = {}
  for (const f of files) {
    const key = f.isBundle ? logicalChunkKey(f.rel) : isAsset(f.rel) ? ASSETS_KEY : undefined
    if (key !== undefined) chunks[key] = (chunks[key] ?? 0) + f.gzipBytes
  }
  return {
    files,
    totalBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0),
    chunks,
  }
}

// Parse + shape-check a baseline document. Throws (message only, no path — the
// caller owns the naming) on ANY defect: the ratchet fails closed on
// unreviewable data, never open.
export function parseBaseline(raw) {
  let b
  try {
    b = JSON.parse(raw)
  } catch (e) {
    throw new Error(`is not valid JSON (${e.message})`)
  }
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new Error('must be a JSON object')
  }
  if (
    b.gzip === null ||
    typeof b.gzip !== 'object' ||
    Array.isArray(b.gzip) ||
    !isPositiveNumber(b.gzip.total)
  ) {
    throw new Error('must carry gzip.total as a positive byte count')
  }
  if (typeof b.ratioCap !== 'number' || !Number.isFinite(b.ratioCap) || b.ratioCap < 1) {
    throw new Error('must carry ratioCap >= 1 (the growth ratio the gate allows over the baseline)')
  }
  if (b.gzip.chunks !== undefined) {
    if (
      b.gzip.chunks === null ||
      typeof b.gzip.chunks !== 'object' ||
      Array.isArray(b.gzip.chunks)
    ) {
      throw new Error('gzip.chunks, when present, must be an object of { "<chunk key>": bytes }')
    }
    for (const [key, bytes] of Object.entries(b.gzip.chunks)) {
      if (!isPositiveNumber(bytes)) {
        throw new Error(`gzip.chunks[${JSON.stringify(key)}] must be a positive byte count`)
      }
    }
  }
  if (b.installerBudgetBytes !== undefined && !isPositiveNumber(b.installerBudgetBytes)) {
    throw new Error('installerBudgetBytes, when present, must be a positive byte count')
  }
  return b
}

// The ratchet proper: measured vs baseline × ratioCap, total always, per chunk
// when the baseline declares chunks. Exactly AT the cap is green — the ratchet
// fails on strict growth past it. A baseline chunk key the build no longer
// emits is a NOTE, never a red: the total still bounds the bytes, and the
// refreshed map arrives with the next reviewed re-baseline.
export function ratchetFindings({ totalBytes, chunks }, baseline) {
  const errs = []
  const notes = []
  const fix = `find the regression, or after a DELIBERATE size change re-baseline via \`${BASELINE_COMMAND}\` in a reviewed commit`
  const totalCap = baseline.gzip.total * baseline.ratioCap
  if (totalBytes > totalCap) {
    errs.push(
      `bundle total ${String(totalBytes)} B gzip exceeds the committed ratchet: baseline ${String(baseline.gzip.total)} B × ratioCap ${String(baseline.ratioCap)} = ${String(Math.floor(totalCap))} B (${BASELINE_FILE}) — ${fix}`,
    )
  }
  for (const [key, baseBytes] of Object.entries(baseline.gzip.chunks ?? {})) {
    const nowBytes = chunks[key]
    if (nowBytes === undefined) {
      notes.push(
        `baseline chunk "${key}" is no longer emitted (renamed or merged; the total ratchet still bounds the bytes) — refresh the chunk map via \`${BASELINE_COMMAND}\` in a reviewed commit`,
      )
      continue
    }
    const chunkCap = baseBytes * baseline.ratioCap
    if (nowBytes > chunkCap) {
      errs.push(
        `chunk "${key}": ${String(nowBytes)} B gzip exceeds the committed ratchet: baseline ${String(baseBytes)} B × ratioCap ${String(baseline.ratioCap)} = ${String(Math.floor(chunkCap))} B (${BASELINE_FILE}) — ${fix}`,
      )
    }
  }
  return { errs, notes }
}

// Build the next baseline document from a fresh measurement, preserving the
// human-tuned knobs (comment, ratioCap, installerBudgetBytes) of the previous
// baseline when they are usable — regeneration refreshes the MEASURED numbers,
// never silently resets a reviewed policy value.
export function composeBaseline({ measured, prev }) {
  return {
    comment:
      typeof prev?.comment === 'string' && prev.comment.trim() !== ''
        ? prev.comment
        : DEFAULT_COMMENT,
    generatedBy: BASELINE_COMMAND,
    gzip: {
      chunks: { ...measured.chunks },
      total: measured.totalBytes,
    },
    installerBudgetBytes: isPositiveNumber(prev?.installerBudgetBytes)
      ? prev.installerBudgetBytes
      : DEFAULT_INSTALLER_BUDGET_BYTES,
    ratioCap:
      typeof prev?.ratioCap === 'number' && Number.isFinite(prev.ratioCap) && prev.ratioCap >= 1
        ? prev.ratioCap
        : DEFAULT_RATIO_CAP,
  }
}

// Stable serialization: every object level sorted by key, 2-space indent,
// trailing newline — byte-identical output for identical measurements, so a
// re-baseline diff shows ONLY what actually changed.
export function serializeBaseline(baseline) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sortDeep(v[k])]),
      )
    }
    return v
  }
  return `${JSON.stringify(sortDeep(baseline), null, 2)}\n`
}

// Human-readable regeneration report: what moved, by how much. Pure — the
// regenerator prints these lines, the tests assert them without an export.
export function diffBaseline(prev, next) {
  if (!prev) {
    return [
      `no previous ${BASELINE_FILE} — seeding gzip total ${String(next.gzip.total)} B, ${String(Object.keys(next.gzip.chunks).length)} chunk key(s)`,
    ]
  }
  const lines = []
  const pct = (from, to) =>
    from > 0 ? `${to >= from ? '+' : ''}${(((to - from) / from) * 100).toFixed(1)}%` : 'n/a'
  if (prev.gzip.total !== next.gzip.total) {
    lines.push(
      `gzip total: ${String(prev.gzip.total)} B → ${String(next.gzip.total)} B (${pct(prev.gzip.total, next.gzip.total)})`,
    )
  } else {
    lines.push(`gzip total: unchanged at ${String(next.gzip.total)} B`)
  }
  const prevChunks = prev.gzip.chunks ?? {}
  const keys = [...new Set([...Object.keys(prevChunks), ...Object.keys(next.gzip.chunks)])].sort()
  for (const key of keys) {
    const from = prevChunks[key]
    const to = next.gzip.chunks[key]
    if (from === undefined) lines.push(`chunk "${key}": NEW at ${String(to)} B`)
    else if (to === undefined) lines.push(`chunk "${key}": REMOVED (was ${String(from)} B)`)
    else if (from !== to)
      lines.push(`chunk "${key}": ${String(from)} B → ${String(to)} B (${pct(from, to)})`)
  }
  return lines
}
