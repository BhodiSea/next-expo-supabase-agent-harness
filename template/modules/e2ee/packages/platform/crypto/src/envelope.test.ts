import { describe, expect, it } from 'vitest'
import {
  AAD_ROLE_DEK,
  AAD_ROLE_ITEM,
  ALG_AES_256_GCM,
  buildAad,
  decodeEnvelope,
  ENVELOPE_VERSION,
  encodeEnvelope,
} from './envelope.js'

// The decoder is the package's one input boundary for stored bytes — every
// refusal below is a DISTINCT named reason, because "malformed" and "from the
// future" call for different remedies (fix the data vs upgrade the client).

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
