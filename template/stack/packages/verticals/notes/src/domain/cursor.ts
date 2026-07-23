import { NOTES_CURSOR_MAX } from '@app/contracts'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Keyset-cursor codec. The cursor is the (created_at, id) key of the last row
// on a page, base64url-encoded JSON — opaque to clients (they echo it back
// verbatim), fully validated on the way back in.
// SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158
//
// The base64 codec below is HAND-WRITTEN rather than delegated to `Buffer` or
// `atob`. This module is on the ./client barrel, so it is bundled into the
// native app: `Buffer` is a Node built-in that Metro does not shim, and
// `atob`/`btoa` are not part of the Hermes global set. A ~30-line pure codec is
// the only version of this that runs unchanged on Node, on the Edge runtime and
// on a phone — and the only one a unit test can exercise on all three.
// SOURCE: base64url alphabet per RFC 4648 §5 https://www.rfc-editor.org/rfc/rfc4648#section-5
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// Reverse table built once at module load. A Map (not an object) so a token
// character like '__proto__' resolves to `undefined` instead of walking the
// prototype chain and returning a function.
const DECODE = new Map<string, number>()
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE.set(ALPHABET.charAt(index), index)
}

/**
 * ASCII -> base64url, unpadded. `charAt` (not `[i]`) on purpose: under
 * `noUncheckedIndexedAccess` a string index is `string | undefined`, and the
 * six-bit values here are provably in range, so the check would be noise the
 * reader has to disprove.
 *
 * Input is ASCII by construction — every caller runs `CursorKey.parse` first,
 * and both fields of that schema are constrained to ASCII. A code point above
 * 0x7F would silently lose its high bytes here; the guard against that is the
 * schema, upstream, where it can produce a useful error.
 */
function toBase64Url(ascii: string): string {
  let out = ''
  for (let i = 0; i < ascii.length; i += 3) {
    const hasSecond = i + 1 < ascii.length
    const hasThird = i + 2 < ascii.length
    const b0 = ascii.charCodeAt(i)
    const b1 = hasSecond ? ascii.charCodeAt(i + 1) : 0
    const b2 = hasThird ? ascii.charCodeAt(i + 2) : 0
    out += ALPHABET.charAt(b0 >> 2)
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4))
    if (hasSecond) out += ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6))
    if (hasThird) out += ALPHABET.charAt(b2 & 0x3f)
  }
  return out
}

/**
 * base64url -> ASCII, or null for anything that is not a token this codec
 * emitted. Returning null rather than throwing is deliberate: a malformed
 * cursor is untrusted WIRE input on a hot read path, and exceptions on that
 * path turn a client typo into a 500.
 *
 * A length of 4n+1 is rejected outright — no whole input byte can produce a
 * single leftover base64 character, so such a token cannot have come from here.
 */
function fromBase64Url(token: string): string | null {
  if (token.length % 4 === 1) return null
  let out = ''
  let buffer = 0
  let bits = 0
  for (const char of token) {
    const value = DECODE.get(char)
    if (value === undefined) return null
    // Masked to 16 bits: at most 13 are ever live (up to 7 carried + 6 added),
    // and an unmasked accumulator would drift past int32 on a long token and
    // start sign-extending. The mask makes the bound obvious instead of
    // something the reader has to re-derive.
    buffer = ((buffer << 6) | value) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((buffer >> bits) & 0xff)
    }
  }
  return out
}

/**
 * Anchored at BOTH ends, unlike `WireTimestamp` in @app/contracts. That schema
 * validates driver OUTPUT and may see added precision; THIS one validates wire
 * INPUT that is interpolated back into a PostgREST filter string. An unanchored
 * tail once let `2024-01-01 12:00:00 (x)` through — V8's date parser skips
 * parenthesized comments — and the value then reached the database as a cast
 * error: a 500 where the contract promises a rejected cursor.
 */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Shape AND calendar. The shape check alone is not enough in two directions:
 *
 * - `Date.parse` is NOT a calendar oracle — it silently ROLLS OVER an
 *   impossible day (2024-02-30 -> Mar 1, 2023-02-29 -> Mar 1). Such a value
 *   decodes fine and then reaches the database, which raises a cast error.
 * - Without the end anchor, a trailing comment or filter metacharacter rides
 *   along into the query string that quotes this value.
 *
 * So: anchor both ends, then require the instant to survive a canonical round
 * trip. `toJSON` (not `toISOString`) returns null rather than THROWING on an
 * out-of-range field like month 13. One comparison, not six per-component ones
 * — every rollover perturbs at least two components at once, which makes
 * per-component checks mutually redundant and individually unpinnable.
 * SOURCE: ECMA-262 MakeDay performs no calendar validation — out-of-range days
 * roll over https://tc39.es/ecma262/#sec-makeday
 */
function isRealTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false
  // Force the ISO form before parsing: the legacy `YYYY-MM-DD hh:mm:ss` parser
  // resolves against the LOCAL zone, which would shift the instant by whatever
  // offset the runner (or the phone) happens to be in.
  const iso = `${value.slice(0, 10)}T${value.slice(11, 19)}`
  return new Date(`${iso}Z`).toJSON() === `${iso}.000Z`
}

/**
 * `strictObject`: a decoded cursor carrying EXTRA keys is not a cursor this
 * codec minted, and silently ignoring the extras would let a caller smuggle
 * fields into a shape the DAL trusts.
 */
const CursorKey = z.strictObject({
  createdAt: z.string().max(64).refine(isRealTimestamp),
  id: z.uuid(),
})

/** The decoded keyset position: strictly the last row's (createdAt, id). */
export type NoteCursor = z.infer<typeof CursorKey>

/**
 * Validate THEN encode. The parse is not belt-and-braces: it is what makes the
 * ASCII precondition of `toBase64Url` true, and what guarantees the decoded
 * value can never carry a PostgREST filter metacharacter into a query.
 */
export function encodeNotesCursor(key: NoteCursor): string {
  const safe = CursorKey.parse(key)
  return toBase64Url(JSON.stringify({ createdAt: safe.createdAt, id: safe.id }))
}

/**
 * Strict decode: anything that is not exactly a cursor this codec minted (bad
 * length, bad alphabet, bad JSON, extra fields, impossible calendar date,
 * non-uuid) returns null, and the caller answers with a rejected-input envelope
 * — never a driver-level cast error, never a 500.
 */
export function decodeNotesCursor(token: string): NoteCursor | null {
  if (token.length === 0 || token.length > NOTES_CURSOR_MAX) return null
  const json = fromBase64Url(token)
  if (json === null) return null
  try {
    // Annotated `unknown`, not left as JSON.parse's `any`: an `any` flowing
    // into a zod parse silently disables every downstream type check the
    // lint rules exist to enforce.
    const decoded: unknown = JSON.parse(json)
    return CursorKey.parse(decoded)
  } catch {
    return null
  }
}
