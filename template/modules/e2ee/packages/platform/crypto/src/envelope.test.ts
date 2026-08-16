import { describe, expect, it } from 'vitest'
import {
  AAD_ROLE_DEK,
  AAD_ROLE_DEVICE_SYNC,
  AAD_ROLE_ITEM,
  AAD_ROLE_RECIPIENT_WRAP,
  AAD_ROLE_RECOVERY,
  ALG_AES_256_GCM,
  buildAad,
  buildAadBytes,
  decodeEnvelope,
  ENVELOPE_VERSION,
  encodeEnvelope,
} from './envelope.js'

// The decoder is the package's one input boundary for stored bytes — every
// refusal below is a DISTINCT named reason, because "malformed" and "from the
// future" call for different remedies (fix the data vs upgrade the client).

// Declared locally: the package sets `types: []` so platform globals stay out
// of the shared graph — see the note in envelope.ts.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const iv = new Uint8Array(12).fill(7)
const ct = new Uint8Array(20).fill(9) // >= 16: room for the notional tag

describe('encode/decode roundtrip', () => {
  it('is byte-faithful', () => {
    const bytes = encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct })
    const decoded = decodeEnvelope(bytes)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect([...decoded.value.iv]).toEqual([...iv])
      expect([...decoded.value.ct]).toEqual([...ct])
    }
  })
})

describe('decode refusals, each with its own reason', () => {
  const good = encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct })

  it('too short → envelope_malformed', () => {
    const r = decodeEnvelope(good.slice(0, 3))
    expect(r).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('bad magic → envelope_malformed', () => {
    const bytes = good.slice()
    bytes[0] = 0x00
    expect(decodeEnvelope(bytes)).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('version 2 → unsupported_version (a future fleet, not corruption)', () => {
    const bytes = good.slice()
    bytes[2] = 2
    expect(decodeEnvelope(bytes)).toMatchObject({ ok: false, reason: 'unsupported_version' })
  })

  it('reserved alg 0x02 → unsupported_algorithm (agility with no dead code)', () => {
    const bytes = good.slice()
    bytes[3] = 0x02
    expect(decodeEnvelope(bytes)).toMatchObject({ ok: false, reason: 'unsupported_algorithm' })
  })

  it('wrong iv length → envelope_malformed', () => {
    const bytes = good.slice()
    bytes[4] = 16
    expect(decodeEnvelope(bytes)).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('truncated inside the tag → envelope_malformed', () => {
    expect(decodeEnvelope(good.slice(0, 5 + 12 + 8))).toMatchObject({
      ok: false,
      reason: 'envelope_malformed',
    })
  })
})

describe('buildAad', () => {
  const ctx = { userId: 'u1', table: 'notes', itemId: 'n1', field: 'body' }

  it('binds role: an item AAD and a DEK AAD for the same row differ', () => {
    expect([...buildAad(AAD_ROLE_ITEM, ctx)]).not.toEqual([...buildAad(AAD_ROLE_DEK, ctx)])
  })

  it('separates fields by LENGTH, so no content can be mistaken for a boundary', () => {
    const aad = (userId: string, table: string, itemId: string, field = 'body') =>
      [...buildAad(AAD_ROLE_ITEM, { userId, table, itemId, field })].join(',')

    // A boundary shift — the case a no-separator scheme misses entirely.
    expect(aad('u1', 'no', 'tes')).not.toBe(aad('u1', 'not', 'es'))
    // An embedded NUL — the case a NUL-SEPARATED scheme misses, and this
    // package's previous encoding did.
    expect(aad('u1', 'notes', 'a\u0000b')).not.toBe(aad('u1', 'notes\u0000a', 'b'))
    // The field, which separates two encrypted columns of one row.
    expect(aad('u1', 'notes', 'n1', 'title')).not.toBe(aad('u1', 'notes', 'n1', 'body'))
  })

  it('does NOT distinguish a lone surrogate from U+FFFD — the stated residual', () => {
    // Asserted so the limit is a fact under test rather than a footnote that
    // rots. UTF-8 has no encoding for an unpaired surrogate, so TextEncoder
    // emits the replacement character for it; that collision is in the ENCODING,
    // and no framing can undo it. Harmless for UUID primary keys; it is the
    // reason the docs tell consumers to build `itemId` from real column values
    // rather than from anything user-supplied.
    const aad = (itemId: string) =>
      [...buildAad(AAD_ROLE_ITEM, { userId: 'u1', table: 'notes', itemId, field: 'body' })].join(
        ',',
      )
    expect(aad('\uD800')).toBe(aad('\uFFFD'))
  })
})

describe('buildAadBytes', () => {
  it('emits the same version | alg | role prefix as the string builder', () => {
    const aad = buildAadBytes(AAD_ROLE_RECOVERY, [])
    expect([...aad]).toEqual([ENVELOPE_VERSION, ALG_AES_256_GCM, AAD_ROLE_RECOVERY])
  })

  it('separates fields by LENGTH \u2014 a boundary shift changes the bytes', () => {
    // The injectivity argument for byte fields, at its sharpest: the same six
    // bytes split 2/4 and 4/2 must not collide, because a curve point's own
    // content must never be mistaken for a field boundary.
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6)
    const a = buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, [bytes.slice(0, 2), bytes.slice(2)])
    const b = buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, [bytes.slice(0, 4), bytes.slice(4)])
    expect([...a]).not.toEqual([...b])
  })

  it('all five roles are pairwise distinct over identical field bytes', () => {
    // The string builder's four encoded fields fed through the byte builder
    // reproduce its output past the prefix, so the five AADs below differ in
    // exactly one byte \u2014 the role. Asserted pairwise, because the role byte is
    // the ONLY thing standing between a blob and every other slot when key and
    // fields align (recipient-wrap.test.ts proves the end-to-end half).
    const enc = new TextEncoder()
    const fields = [enc.encode('u1'), enc.encode('notes'), enc.encode('n1'), enc.encode('body')]
    const aads = [
      buildAad(AAD_ROLE_ITEM, { userId: 'u1', table: 'notes', itemId: 'n1', field: 'body' }),
      buildAad(AAD_ROLE_DEK, { userId: 'u1', table: 'notes', itemId: 'n1', field: 'body' }),
      buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, fields),
      buildAadBytes(AAD_ROLE_RECOVERY, fields),
      buildAadBytes(AAD_ROLE_DEVICE_SYNC, fields),
    ]
    for (let a = 0; a < aads.length; a += 1) {
      for (let b = a + 1; b < aads.length; b += 1) {
        expect([...(aads.at(a) ?? [])]).not.toEqual([...(aads.at(b) ?? [])])
      }
    }
  })
})
