import { z } from 'zod'

// Keyset-cursor codec for the notes list. The cursor is the (created_at, id)
// key of the last row on the page, base64url-encoded JSON — opaque to clients
// (they echo it back verbatim), fully validated on the way in.
// SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158

// createdAt is carried VERBATIM as the driver returned it (Postgres text form,
// microsecond precision). Re-encoding through a JS Date would truncate to
// milliseconds and make the keyset comparison skip rows that share a
// millisecond — precision is the correctness of the cursor.
//
// Anchored at BOTH ends, unlike the DTO's shape check in @app/contracts: this validates
// WIRE input (a cursor a client hands back), not driver output. An unanchored tail let
// `2024-01-01 12:00:00 (x)` through — V8's date parser skips parenthesized comments —
// and the driver then raised a cast error on the `::timestamptz` bind.
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Shape AND calendar. The shape check alone is not enough, in two directions:
 *
 * - The old refine was `!Number.isNaN(Date.parse(value))`, and Date.parse is NOT a calendar
 *   oracle — it silently ROLLS OVER an impossible day (`2024-02-30` -> Mar 1, `2023-02-29`
 *   -> Mar 1). Those decoded fine and were then bound as `::timestamptz`, where Postgres
 *   raised a cast error: a 500, where the contract below promises a 400.
 * - The old regex was unanchored at the END, so `2024-01-01 12:00:00 (x)` matched on its
 *   prefix (V8's date parser even skips parenthesized comments) and reached the driver too.
 *
 * So: anchor both ends, then require the instant to survive a canonical round-trip. `toJSON`
 * (not `toISOString`) returns null rather than THROWING on an out-of-range field like month
 * 13 or hour 25. One comparison, not six per-component ones — every rollover perturbs at
 * least two components at once, which makes per-component checks mutually redundant and
 * individually unpinnable by any test.
 * SOURCE: ECMA-262 MakeDay performs no calendar validation — out-of-range days roll over
 * https://tc39.es/ecma262/#sec-makeday
 */
function isRealTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false
  // Force the ISO form before parsing: the legacy `YYYY-MM-DD hh:mm:ss` parser resolves
  // against the LOCAL zone, which would shift the instant by the runner's offset.
  const iso = `${value.slice(0, 10)}T${value.slice(11, 19)}`
  return new Date(`${iso}Z`).toJSON() === `${iso}.000Z`
}

const CursorKey = z.strictObject({
  createdAt: z.string().max(64).refine(isRealTimestamp),
  id: z.guid(),
})

/** The decoded keyset position: strictly the last row's (createdAt, id). */
export type NoteCursorKey = z.infer<typeof CursorKey>

export function encodeNotesCursor(key: NoteCursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

/**
 * Strict decode: anything that is not exactly a cursor this server minted
 * (bad base64, bad JSON, extra fields, malformed timestamp/uuid) returns null
 * and the route answers 400 — never a driver-level cast error.
 */
export function decodeNotesCursor(cursor: string): NoteCursorKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return CursorKey.parse(parsed)
  } catch {
    return null
  }
}
