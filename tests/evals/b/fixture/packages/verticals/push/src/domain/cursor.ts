import { PUSH_TOKENS_CURSOR_MAX } from '@app/contracts'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Keyset-cursor codec for the push-token list (push-notifications module). The
// cursor is the (created_at, id) key of the last row on a page, base64url-encoded
// JSON — opaque to clients (they echo it back verbatim), fully validated on the
// way back in.
// SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158
//
// This is the (created_at, id) keyset shape the notes codec
// (packages/verticals/notes/src/domain/cursor.ts) also uses. It is DUPLICATED
// rather than imported: dependency-cruiser's `verticals-not-into-verticals` rule
// forbids a vertical importing another, and the clean de-duplication is to lift a
// shared keyset codec into packages/shared — a reasonable follow-up the module
// README's honest limits records, deferred out of this slice. The base64 codec is
// HAND-WRITTEN rather than delegated to `Buffer`/`atob`: a vertical's domain layer
// must stay bundle-safe (Metro ships no Node built-ins, Hermes has no atob/btoa).
// SOURCE: base64url alphabet per RFC 4648 §5 https://www.rfc-editor.org/rfc/rfc4648#section-5
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// Reverse table built once at module load. A Map (not an object) so a token
// character like '__proto__' resolves to `undefined` instead of walking the
// prototype chain.
const DECODE = new Map<string, number>()
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE.set(ALPHABET.charAt(index), index)
}

/**
 * ASCII -> base64url, unpadded. Input is ASCII by construction — every caller
 * runs `PushCursorKey.parse` first, and both fields of that schema are
 * constrained to ASCII, so the high-byte-loss hazard is guarded upstream where
 * it can produce a useful error.
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
 * emitted. Returning null rather than throwing is deliberate: a malformed cursor
 * is untrusted WIRE input on a hot read path, and exceptions there turn a client
 * typo into a 500. A length of 4n+1 is rejected outright — no whole input byte
 * can produce a single leftover base64 character.
 */
function fromBase64Url(token: string): string | null {
  if (token.length % 4 === 1) return null
  let out = ''
  let buffer = 0
  let bits = 0
  for (const char of token) {
    const value = DECODE.get(char)
    if (value === undefined) return null
    // Masked to 16 bits: at most 13 are ever live, and an unmasked accumulator
    // would drift past int32 on a long token and start sign-extending.
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
 * Anchored at BOTH ends. This validates wire INPUT that is interpolated back into
 * a PostgREST filter string, so an unanchored tail (a trailing comment or filter
 * metacharacter) would ride along into the query. See the notes codec for the
 * `2024-01-01 12:00:00 (x)` history that motivates the end anchor.
 */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Shape AND calendar. The shape check alone is not enough: `Date.parse` silently
 * ROLLS OVER an impossible day (2024-02-30 -> Mar 1), and such a value would
 * decode fine and then reach the database as a cast error. So: anchor both ends,
 * then require the instant to survive a canonical round trip. `toJSON` (not
 * `toISOString`) returns null rather than THROWING on an out-of-range field.
 * SOURCE: ECMA-262 MakeDay performs no calendar validation — out-of-range days
 * roll over https://tc39.es/ecma262/#sec-makeday
 */
function isRealTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false
  // Force the ISO form before parsing: the legacy `YYYY-MM-DD hh:mm:ss` parser
  // resolves against the LOCAL zone, which would shift the instant.
  const iso = `${value.slice(0, 10)}T${value.slice(11, 19)}`
  return new Date(`${iso}Z`).toJSON() === `${iso}.000Z`
}

/**
 * `strictObject`: a decoded cursor carrying EXTRA keys is not a cursor this codec
 * minted, and silently ignoring the extras would let a caller smuggle fields into
 * a shape the DAL trusts.
 */
const PushCursorKey = z.strictObject({
  createdAt: z.string().max(64).refine(isRealTimestamp),
  id: z.uuid(),
})

/** The decoded keyset position: strictly the last row's (createdAt, id). */
export type PushCursor = z.infer<typeof PushCursorKey>

/**
 * Validate THEN encode. The parse is what makes the ASCII precondition of
 * `toBase64Url` true, and what guarantees the decoded value can never carry a
 * PostgREST filter metacharacter into a query.
 */
export function encodePushCursor(key: PushCursor): string {
  const safe = PushCursorKey.parse(key)
  return toBase64Url(JSON.stringify({ createdAt: safe.createdAt, id: safe.id }))
}

/**
 * Strict decode: anything that is not exactly a cursor this codec minted (bad
 * length, bad alphabet, bad JSON, extra fields, impossible calendar date,
 * non-uuid) returns null, and the caller answers with a rejected-input envelope —
 * never a driver-level cast error, never a 500.
 */
export function decodePushCursor(token: string): PushCursor | null {
  if (token.length === 0 || token.length > PUSH_TOKENS_CURSOR_MAX) return null
  const json = fromBase64Url(token)
  if (json === null) return null
  try {
    // Annotated `unknown`, not JSON.parse's `any`: an `any` into a zod parse
    // silently disables every downstream type check.
    const decoded: unknown = JSON.parse(json)
    return PushCursorKey.parse(decoded)
  } catch {
    return null
  }
}
