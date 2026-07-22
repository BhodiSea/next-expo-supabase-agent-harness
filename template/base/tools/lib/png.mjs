// tools/lib/png.mjs — zero-dependency PNG introspection for the expo-policy
// gate's icon-integrity checks: dimensions + alpha from the IHDR/tRNS chunks,
// and a solid-color detector (inflate + un-filter + all-pixels-equal) for the
// scaffold's placeholder art. Honesty rule: anything this parser cannot analyze
// (exotic bit depths, interlacing, palette images) returns null — "unknown",
// never a guessed verdict.
// SOURCE: PNG (ISO/IEC 15948) — signature, IHDR layout, filter algorithms
// https://www.w3.org/TR/png-3/#5DataRep
import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Iterate chunks as { type, data } — returns null on any structural defect. */
function chunksOf(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null
  const chunks = []
  let at = 8
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    const dataEnd = at + 8 + length
    if (dataEnd + 4 > buffer.length) return null
    chunks.push({ type, data: buffer.subarray(at + 8, dataEnd) })
    at = dataEnd + 4 // skip CRC
    if (type === 'IEND') return chunks
  }
  return null
}

/**
 * Dimensions + alpha from the header chunks. hasAlpha is true for color types
 * carrying an alpha channel (4, 6) or a tRNS transparency chunk. Returns null
 * when the buffer is not a structurally sound PNG.
 */
export function readPngMeta(buffer) {
  const chunks = chunksOf(buffer)
  const ihdr = chunks?.[0]
  if (chunks === null || ihdr?.type !== 'IHDR' || ihdr.data.length < 13) return null
  const colorType = ihdr.data[9]
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType,
    interlaced: ihdr.data[12] !== 0,
    hasAlpha: colorType === 4 || colorType === 6 || chunks.some((c) => c.type === 'tRNS'),
  }
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** Paeth predictor — the PNG spec's tie-break order is load-bearing. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Reverse the per-scanline filters in place; returns the raw pixel rows. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- the five PNG filter cases are one cohesive decoder; ceiling machine-enforced by scripts/complexity-ratchet.json
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    const dst = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? dst[x - bpp] : 0
      const up = prev === null ? 0 : prev[x]
      const upLeft = prev === null || x < bpp ? 0 : prev[x - bpp]
      let value = row[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += Math.floor((left + up) / 2)
      else if (filter === 4) value += paeth(left, up, upLeft)
      else if (filter !== 0) return null
      dst[x] = value & 0xff
    }
  }
  return out
}

/**
 * Is every pixel the same color? true / false when decodable; null when the
 * image is outside this parser's honest reach (not a PNG, palette-indexed,
 * bit depth != 8, interlaced, or corrupt) — callers must treat null as
 * "unknown", never as "not solid".
 */
export function isSolidColor(buffer) {
  const meta = readPngMeta(buffer)
  const bpp = meta === null ? undefined : CHANNELS[meta.colorType]
  if (meta === null || bpp === undefined || meta.bitDepth !== 8 || meta.interlaced) return null
  const chunks = chunksOf(buffer)
  if (chunks === null) return null
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  let raw
  try {
    raw = inflateSync(idat)
  } catch {
    return null
  }
  if (raw.length !== (meta.width * bpp + 1) * meta.height) return null
  const pixels = unfilter(raw, meta.width, meta.height, bpp)
  if (pixels === null) return null
  for (let at = bpp; at < pixels.length; at += bpp) {
    for (let channel = 0; channel < bpp; channel += 1) {
      if (pixels[at + channel] !== pixels[channel]) return false
    }
  }
  return true
}
