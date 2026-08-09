import {
  EXPORT_CURSOR_MAX,
  ExportMyDataSchema,
  NOTES_CURSOR_MAX,
  NotesListQuery,
} from '@app/contracts'
import { describe, expect, it } from 'vitest'
import {
  decodeNotesCursor,
  decodeNotesExportCursor,
  encodeNotesCursor,
  encodeNotesExportCursor,
  type NoteCursor,
  type NotesExportCursor,
} from './cursor.js'

const KEY: NoteCursor = {
  createdAt: '2026-01-01T00:00:00.123456+00:00',
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
}

describe('the base64url codec', () => {
  it('round-trips a cursor exactly', () => {
    expect(decodeNotesCursor(encodeNotesCursor(KEY))).toEqual(KEY)
  })

  it('preserves microsecond precision — the whole reason the cursor exists', () => {
    // A millisecond-truncating round trip would silently skip every row sharing
    // that millisecond on the next page.
    const decoded = decodeNotesCursor(encodeNotesCursor(KEY))
    expect(decoded?.createdAt).toBe('2026-01-01T00:00:00.123456+00:00')
  })

  it('emits only base64url characters — no padding, no + or /', () => {
    const token = encodeNotesCursor(KEY)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).not.toContain('=')
  })

  it('emits a token the wire contract accepts', () => {
    // Lockstep with @app/contracts: the alphabet AND the bound. A cursor the
    // server mints that its own query schema rejects is an unpageable list.
    const cursor = encodeNotesCursor(KEY)
    expect(cursor.length).toBeLessThanOrEqual(NOTES_CURSOR_MAX)
    expect(NotesListQuery.parse({ cursor }).cursor).toBe(cursor)
  })

  it.each([
    { pins: 'the shortest timestamp form', createdAt: '2026-01-01T00:00:00Z' },
    { pins: 'a space-separated form', createdAt: '2026-01-01 00:00:00+00' },
    { pins: 'an offset with a colon', createdAt: '2026-01-01T00:00:00+05:30' },
    { pins: 'an offset without a colon', createdAt: '2026-01-01T00:00:00+0530' },
    { pins: 'one fractional digit', createdAt: '2026-01-01T00:00:00.1Z' },
    { pins: 'six fractional digits', createdAt: '2026-12-31T23:59:59.999999-08:00' },
  ])('round-trips $pins', ({ createdAt }) => {
    const key = { ...KEY, createdAt }
    expect(decodeNotesCursor(encodeNotesCursor(key))).toEqual(key)
  })
})

describe('encode rejects what it cannot safely carry', () => {
  it.each([
    { createdAt: '2024-02-30T00:00:00Z', pins: 'an impossible day (Date.parse rolls it over)' },
    { pins: 'a non-leap 29 February', createdAt: '2023-02-29T00:00:00Z' },
    { pins: 'month 13', createdAt: '2026-13-01T00:00:00Z' },
    { pins: 'hour 25', createdAt: '2026-01-01T25:00:00Z' },
    { pins: 'a date with no time', createdAt: '2026-01-01' },
    { pins: 'free text', createdAt: 'yesterday' },
    { createdAt: '2026-01-01 12:00:00 (x)', pins: 'a comment tail V8 would parse' },
    { createdAt: '2026-01-01T00:00:00Z,id.gt.0', pins: 'a filter separator smuggled in' },
  ])('throws on $pins', ({ createdAt }) => {
    expect(() => encodeNotesCursor({ ...KEY, createdAt })).toThrow()
  })

  it('throws on a non-uuid id', () => {
    expect(() => encodeNotesCursor({ ...KEY, id: 'note-1' })).toThrow()
  })

  it('throws on extra fields — a cursor with a passenger is not our cursor', () => {
    const smuggled = { ...KEY, ownerId: '00000000-0000-4000-8000-000000000000' }
    expect(() => encodeNotesCursor(smuggled)).toThrow()
  })
})

describe('decode rejects everything that is not a token we minted', () => {
  it.each([
    { pins: 'the empty string', token: '' },
    { pins: 'a 4n+1 length — no whole byte can produce one leftover character', token: 'AAAAA' },
    { pins: 'a character outside the base64url alphabet', token: 'AA+A' },
    { pins: 'base64 padding, which this codec never emits', token: 'AA==' },
    { pins: 'valid base64url that is not JSON', token: 'AAAA' },
  ])('returns null for $pins', ({ token }) => {
    expect(decodeNotesCursor(token)).toBeNull()
  })

  it('returns null for a token longer than the contract bound', () => {
    expect(decodeNotesCursor('A'.repeat(NOTES_CURSOR_MAX + 1))).toBeNull()
  })

  it('returns null — never throws — for hostile input on a hot read path', () => {
    // A malformed cursor is untrusted wire input. An exception here turns a
    // client typo into a 500.
    for (const token of ['{}', '__proto__', 'null', 'W10', 'AAAAAAAAAAAAAAAA']) {
      expect(() => decodeNotesCursor(token)).not.toThrow()
    }
  })

  it('returns null for a well-formed JSON object that is not a cursor', () => {
    // '{"a":1}' encoded by hand through the same alphabet the codec uses.
    const notACursor = encodeAsciiForTest('{"a":1}')
    expect(decodeNotesCursor(notACursor)).toBeNull()
  })

  it('returns null for a cursor whose timestamp is a rolled-over calendar date', () => {
    const rolled = encodeAsciiForTest(
      JSON.stringify({ createdAt: '2024-02-30T00:00:00Z', id: KEY.id }),
    )
    expect(decodeNotesCursor(rolled)).toBeNull()
  })

  it('returns null when the decoded JSON carries an extra key', () => {
    const extra = encodeAsciiForTest(JSON.stringify({ ...KEY, evil: 1 }))
    expect(decodeNotesCursor(extra)).toBeNull()
  })
})

/**
 * An INDEPENDENT base64url encoder, written a different way from the one under
 * test (bit accumulator rather than 3-byte groups). Using the production
 * encoder to build these fixtures would let a bug in it hide the very
 * decode-side bugs these cases exist to catch.
 */
function encodeAsciiForTest(ascii: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = 0
  let count = 0
  let out = ''
  for (const char of ascii) {
    bits = ((bits << 8) | char.charCodeAt(0)) & 0xffff
    count += 8
    while (count >= 6) {
      count -= 6
      out += alphabet.charAt((bits >> count) & 0x3f)
    }
  }
  if (count > 0) out += alphabet.charAt((bits << (6 - count)) & 0x3f)
  return out
}

describe('the independent encoder agrees with the production one', () => {
  // Each row lands the encoded JSON on a DIFFERENT base64 group boundary
  // (payload length mod 3 = 2, 0, 1), which is where the three distinct tail
  // shapes of the algorithm live. If the two encoders disagreed anywhere, every
  // hand-built fixture above would be exercising the wrong bytes.
  it.each([
    { createdAt: '2026-01-01T00:00:00.123456+00:00', pins: 'a two-byte tail', tail: 2 },
    { createdAt: '2026-01-01T00:00:00.1', pins: 'no tail (whole groups)', tail: 0 },
    { createdAt: '2026-01-01T00:00:00+00', pins: 'a one-byte tail', tail: 1 },
  ])('produces the identical token for $pins', ({ createdAt, tail }) => {
    const key = { ...KEY, createdAt }
    const json = JSON.stringify({ createdAt: key.createdAt, id: key.id })
    // Guards the guard: if a bound above changed the payload length, this row
    // would silently stop covering the tail shape it was written for.
    expect(json.length % 3).toBe(tail)
    expect(encodeAsciiForTest(json)).toBe(encodeNotesCursor(key))
  })
})

// --- R3c mutation-kill tests (added by triage) ---
describe('length + codec guards each reject on their own, not by luck downstream', () => {
  const inner = `"createdAt":"2026-01-01T00:00:00Z","id":"${KEY.id}"`
  const decoded = { createdAt: '2026-01-01T00:00:00Z', id: KEY.id }

  it('accepts a token whose length is EXACTLY the contract bound (the bound is inclusive)', () => {
    // 192-byte whitespace-padded valid-cursor JSON -> exactly NOTES_CURSOR_MAX chars.
    const token = encodeAsciiForTest(`{${' '.repeat(192 - inner.length - 2)}${inner}}`)
    expect(token.length).toBe(NOTES_CURSOR_MAX)
    expect(decodeNotesCursor(token)).toEqual(decoded)
  })

  it('rejects a token PAST the bound purely on length — even one that would otherwise decode', () => {
    // 195-byte payload -> 260 chars (4n, valid alphabet, decodes to a real cursor):
    // only the length guard can reject it, so this exercises the guard the 4n+1 rule masks.
    const token = encodeAsciiForTest(`{${' '.repeat(195 - inner.length - 2)}${inner}}`)
    expect(token.length).toBe(NOTES_CURSOR_MAX + 4)
    expect(decodeNotesCursor(token)).toBeNull()
  })

  it('rejects a 4n+1 length outright instead of silently dropping the tail character', () => {
    const token = encodeNotesCursor({ ...KEY, createdAt: '2026-01-01T00:00:00.1' })
    expect(token.length % 4).toBe(0)
    // Appending one alphabet char makes it 4n+1; those 6 bits complete no byte, so a codec
    // that failed to reject on length would decode the SAME valid cursor.
    expect(decodeNotesCursor(`${token}A`)).toBeNull()
  })

  it('rejects a character outside the base64url alphabet, not treating it as value 0', () => {
    // Three JSON-legal leading spaces base64 to 'ICAg', so token[2] is the value-0 sextet 'A'.
    const token = encodeAsciiForTest(`   {${inner}}`)
    expect(token[2]).toBe('A')
    const hostile = `${token.slice(0, 2)}*${token.slice(3)}`
    expect(decodeNotesCursor(hostile)).toBeNull()
  })

  it('rejects a timestamp with a garbage prefix whose tail is a valid instant (^ anchor)', () => {
    // Unanchored, the regex would match the trailing instant to $ while the fixed slices
    // still see the leading canonical timestamp, letting a doubled value through.
    expect(() =>
      encodeNotesCursor({ ...KEY, createdAt: '2026-01-01T00:00:00Z2026-01-01T00:00:00Z' }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// The EXPORT cursor — the compound token, held to the same strictness.
// ---------------------------------------------------------------------------

describe('the export cursor codec', () => {
  const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
  const START: NotesExportCursor = { note: null, orgId: ORG_ID }
  const MID: NotesExportCursor = { note: encodeNotesCursor(KEY), orgId: ORG_ID }

  it('round-trips both positions: the start of an org and a keyset within one', () => {
    expect(decodeNotesExportCursor(encodeNotesExportCursor(START))).toEqual(START)
    expect(decodeNotesExportCursor(encodeNotesExportCursor(MID))).toEqual(MID)
  })

  it('the inner token is a REAL notes cursor — one codec validates it, not two', () => {
    const decoded = decodeNotesExportCursor(encodeNotesExportCursor(MID))
    expect(decoded).not.toBeNull()
    if (decoded?.note == null) return
    expect(decodeNotesCursor(decoded.note)).toEqual(KEY)
  })

  it('emits a token the wire contract accepts, within its own bound', () => {
    const token = encodeNotesExportCursor(MID)
    expect(token.length).toBeLessThanOrEqual(EXPORT_CURSOR_MAX)
    expect(() => ExportMyDataSchema.parse({ cursor: token })).not.toThrow()
  })

  it('rejects what it did not mint: bad org, smuggled fields, oversize, garbage', () => {
    expect(() => encodeNotesExportCursor({ note: null, orgId: 'not-a-uuid' })).toThrow()
    expect(() => encodeNotesExportCursor({ note: 'not base64url!', orgId: ORG_ID })).toThrow()
    expect(decodeNotesExportCursor('%%%')).toBeNull()
    expect(decodeNotesExportCursor('A'.repeat(EXPORT_CURSOR_MAX + 1))).toBeNull()
    // A decoded object with a passenger key is not our token.
    const smuggled = encodeNotesCursor(KEY) // a NOTES token is not an EXPORT token
    expect(decodeNotesExportCursor(smuggled)).toBeNull()
  })
})

describe('the export-cursor guards each reject on their own, not by luck downstream (mutation kills)', () => {
  const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
  const inner = `"note":null,"orgId":"${ORG_ID}"`
  const decoded = { note: null, orgId: ORG_ID }

  it('accepts a token whose length is EXACTLY the contract bound (the bound is inclusive)', () => {
    // 384-byte whitespace-padded valid-cursor JSON -> exactly EXPORT_CURSOR_MAX chars.
    // The `>` vs `>=` boundary: exactly-at-the-bound must PASS while past-the-bound
    // (the test below) must reject — the pair pins the operator, not just the guard.
    const token = encodeAsciiForTest(`{${' '.repeat(384 - inner.length - 2)}${inner}}`)
    expect(token.length).toBe(EXPORT_CURSOR_MAX)
    expect(decodeNotesExportCursor(token)).toEqual(decoded)
  })

  it('rejects a token PAST the bound purely on length — even one that would otherwise decode', () => {
    // 387-byte payload -> 516 chars: 4n length, valid alphabet, valid strict JSON.
    // Every later guard would wave it through, so only the length bound can say no —
    // which is exactly what makes this the discriminating case for the bound itself.
    const token = encodeAsciiForTest(`{${' '.repeat(387 - inner.length - 2)}${inner}}`)
    expect(token.length).toBe(EXPORT_CURSOR_MAX + 4)
    expect(decodeNotesExportCursor(token)).toBeNull()
  })

  it('rejects an inner token that merely ENDS in base64url — the alphabet check is anchored', () => {
    // Without the ^ anchor the regex would match the valid tail of '!AAAA' and let a
    // non-base64url inner token reach toBase64Url, which silently mangles it.
    expect(() => encodeNotesExportCursor({ note: '!AAAA', orgId: ORG_ID })).toThrow()
  })

  it('rejects a hand-built token whose inner note starts outside the alphabet', () => {
    // The decode-side twin of the anchor test: the schema is shared, so a token this
    // codec never minted must fail the strict parse on the way back in.
    const hostile = encodeAsciiForTest(`{"note":"!AAAA","orgId":"${ORG_ID}"}`)
    expect(decodeNotesExportCursor(hostile)).toBeNull()
  })
})
