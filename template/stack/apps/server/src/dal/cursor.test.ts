// The keyset-cursor codec is a trust boundary: a cursor the server did not mint
// must NEVER reach SQL as a `::timestamptz` / `::uuid` cast. Every rejection arm
// of the strict decode is pinned here, plus the byte-exact round-trip —
// microsecond precision IS the correctness of the keyset comparison, so a
// silently lossy encode would skip rows rather than fail loudly.
import { describe, expect, it } from 'vitest'
import { decodeNotesCursor, encodeNotesCursor, type NoteCursorKey } from './cursor.js'

const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

/** Mint a token the way a hostile client would — bypassing the encoder entirely. */
const token = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

/** A cursor whose only variable is the timestamp text — the shape under test. */
const decodeWithCreatedAt = (createdAt: string) =>
  decodeNotesCursor(token({ createdAt, id: NOTE_ID }))

describe('notes cursor codec: round-trip', () => {
  it('round-trips the Postgres text form with MICROSECOND precision, verbatim', () => {
    const key: NoteCursorKey = { createdAt: '2024-01-01 12:00:00.123456+00', id: NOTE_ID }
    const decoded = decodeNotesCursor(encodeNotesCursor(key))
    // A Date round-trip would truncate .123456 -> .123 and make the keyset seek
    // silently skip every row sharing that millisecond.
    expect(decoded).toEqual(key)
    expect(decoded?.createdAt).toBe('2024-01-01 12:00:00.123456+00')
  })

  it('accepts BOTH separators the wire carries: the ISO "T" and the Postgres SPACE', () => {
    const iso: NoteCursorKey = { createdAt: '2024-01-01T12:00:00.000Z', id: NOTE_ID }
    const postgres: NoteCursorKey = { createdAt: '2024-01-01 12:00:00.123456+00', id: NOTE_ID }
    expect(decodeNotesCursor(encodeNotesCursor(iso))).toEqual(iso)
    expect(decodeNotesCursor(encodeNotesCursor(postgres))).toEqual(postgres)
  })

  it('encodes UTF-8 bytes into a padding-free base64url token the route contract accepts', () => {
    const encoded = encodeNotesCursor({ createdAt: '2024-01-01 12:00:00+00', id: NOTE_ID })
    // NotesListQuery bounds cursors to /^[A-Za-z0-9_-]+$/ — a '+', '/' or '=' would 400.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    // Byte-exact pin: these are the UTF-8 bytes of {"createdAt":…,"id":…}, base64url'd.
    expect(encoded).toBe(
      'eyJjcmVhdGVkQXQiOiIyMDI0LTAxLTAxIDEyOjAwOjAwKzAwIiwiaWQiOiIzZjI1MDRlMC00Zjg5LTQxZDMtOWEwYy0wMzA1ZTgyYzMzMDEifQ',
    )
  })

  it('decodes multi-byte UTF-8 content faithfully — and still refuses it (not our shape)', () => {
    // A latin1/ascii read of the transport would mangle these bytes; the decode
    // must reproduce the JSON text exactly, then reject it on the schema, not on
    // a mojibake accident.
    const bytes = Buffer.from(token({ createdAt: 'héllo☃', id: NOTE_ID }), 'base64url')
    expect(bytes.toString('utf8')).toContain('héllo☃')
    expect(decodeNotesCursor(token({ createdAt: 'héllo☃', id: NOTE_ID }))).toBeNull()
  })
})

describe('notes cursor codec: strict decode refuses anything the server did not mint', () => {
  it('refuses a token that is not base64url at all', () => {
    expect(decodeNotesCursor('!!! not a token !!!')).toBeNull()
  })

  it('refuses base64url that does not carry JSON', () => {
    expect(decodeNotesCursor(Buffer.from('not-json{', 'utf8').toString('base64url'))).toBeNull()
  })

  it('refuses an EXTRA field: z.strictObject means a smuggled key is not our token', () => {
    const smuggled = {
      createdAt: '2024-01-01 12:00:00+00',
      id: NOTE_ID,
      ownerId: '00000000-0000-4000-8000-000000000001',
    }
    expect(decodeNotesCursor(token(smuggled))).toBeNull()
  })

  it('refuses a missing field and a non-object payload', () => {
    expect(decodeNotesCursor(token({ id: NOTE_ID }))).toBeNull()
    expect(decodeNotesCursor(token(['2024-01-01 12:00:00+00', NOTE_ID]))).toBeNull()
  })

  it('refuses a non-uuid id — the cursor is cast to ::uuid downstream', () => {
    expect(
      decodeNotesCursor(token({ createdAt: '2024-01-01 12:00:00+00', id: 'not-a-uuid' })),
    ).toBeNull()
  })

  it('refuses junk PREFIXED to a valid timestamp — the regex is ANCHORED', () => {
    // Leading whitespace is the sharp case: Date.parse() happily accepts it, so
    // ONLY the ^ anchor stands between this and a cursor built from junk.
    expect(decodeWithCreatedAt(' 2024-01-01 12:00:00')).toBeNull()
    expect(decodeWithCreatedAt('x2024-01-01 12:00:00')).toBeNull()
  })

  it('refuses a truncated seconds field — the time needs TWO digits, not one', () => {
    // Date.parse('2024-01-01 12:00:5') resolves fine; the regex is the only guard.
    expect(decodeWithCreatedAt('2024-01-01 12:00:5')).toBeNull()
    expect(decodeWithCreatedAt('2024-01-01 12:00')).toBeNull()
    expect(decodeWithCreatedAt('2024-01-01')).toBeNull()
  })

  it('refuses a wrong-shaped timestamp outright', () => {
    expect(decodeWithCreatedAt('01/01/2024 12:00:00')).toBeNull()
    expect(decodeWithCreatedAt('')).toBeNull()
  })

  it('refuses a timestamp the SHAPE admits but a calendar rejects (month 13, hour 25)', () => {
    // Well-formed shapes that timestamptz would throw on. Date's ISO parser does reject
    // these two outright — it is the DAY rollover below that it does not.
    expect(decodeWithCreatedAt('2024-13-01T12:00:00')).toBeNull()
    expect(decodeWithCreatedAt('2024-01-01T25:00:00')).toBeNull()
  })

  it('refuses an IMPOSSIBLE DAY that Date silently ROLLS OVER (2024-02-30 -> Mar 1)', () => {
    // The sharp one. Date.parse does NOT reject these — it rolls them into the next month
    // and returns a perfectly valid instant. They therefore decoded cleanly, reached SQL as
    // a `::timestamptz` bind, and Postgres raised a cast error: a 500 where the decode
    // contract promises a 400. Only the canonical round-trip in isRealTimestamp catches it.
    expect(Number.isNaN(Date.parse('2024-02-30T12:00:00Z'))).toBe(false) // Date says "fine"
    expect(decodeWithCreatedAt('2024-02-30T12:00:00')).toBeNull() // the cursor says no
    expect(decodeWithCreatedAt('2024-04-31T12:00:00')).toBeNull() // April has 30 days
    expect(decodeWithCreatedAt('2023-02-29T12:00:00')).toBeNull() // 2023 is not a leap year
  })

  it('ACCEPTS a real leap day — the calendar check must not be a blunt Feb-29 ban', () => {
    const key: NoteCursorKey = { createdAt: '2024-02-29 12:00:00+00', id: NOTE_ID }
    expect(decodeNotesCursor(encodeNotesCursor(key))).toEqual(key)
  })

  it('refuses junk APPENDED to a valid timestamp — the regex is anchored at BOTH ends', () => {
    // V8's date parser skips a trailing parenthesized comment, so Date.parse accepts this
    // and an END-unanchored regex matched it on its prefix. Postgres does not: it reached
    // the driver as a cast error. The $ anchor is the only thing standing here.
    expect(Number.isNaN(Date.parse('2024-01-01 12:00:00 (x)'))).toBe(false)
    expect(decodeWithCreatedAt('2024-01-01 12:00:00 (x)')).toBeNull()
    expect(decodeWithCreatedAt('2024-01-01 12:00:00+00; DROP TABLE notes')).toBeNull()
    // Trailing whitespace is trimmed by Date.parse; the anchor rejects it.
    expect(decodeWithCreatedAt(`2024-01-01 12:00:00.123456+00${' '.repeat(40)}`)).toBeNull()
  })
})

// Each arm below is the ONLY thing distinguishing one optional group of the timestamp
// pattern. Drop the fractional group's `?` and the bare form stops decoding; require a
// colon in the offset and `+0000` stops decoding. These are the forms the driver and the
// wire actually produce, so each one is a real contract, not a regex-shaped unit test.
describe('notes cursor codec: every timestamp form the wire carries decodes', () => {
  const ACCEPTED = [
    ['no fraction, no offset', '2024-01-01 12:00:00'],
    ['fraction, no offset', '2024-01-01 12:00:00.123456'],
    ['fraction + hour-only offset (the Postgres text form)', '2024-01-01 12:00:00.123456+00'],
    ['offset with no colon', '2024-01-01 12:00:00+0000'],
    ['offset with a colon', '2024-01-01 12:00:00+00:00'],
    ['negative offset', '2024-01-01 12:00:00-05:00'],
    ['ISO with Z', '2024-01-01T12:00:00.000Z'],
    ['millisecond precision', '2024-01-01T12:00:00.123Z'],
  ] as const

  it.each(ACCEPTED)('accepts %s', (_label, createdAt) => {
    const key: NoteCursorKey = { createdAt, id: NOTE_ID }
    expect(decodeNotesCursor(encodeNotesCursor(key))).toEqual(key)
  })
})
