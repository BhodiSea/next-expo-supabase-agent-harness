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
  const ctx = { userId: 'u1', table: 'notes', itemId: 'n1' }

  it('binds role: an item AAD and a DEK AAD for the same row differ', () => {
    expect([...buildAad(AAD_ROLE_ITEM, ctx)]).not.toEqual([...buildAad(AAD_ROLE_DEK, ctx)])
  })

  it('is injective across field boundaries — NUL separation, not a printable join', () => {
    // With a printable separator these two identities would encode identically.
    const a = buildAad(AAD_ROLE_ITEM, { userId: 'u1', table: 'no', itemId: 'tes' })
    const b = buildAad(AAD_ROLE_ITEM, { userId: 'u1', table: 'not', itemId: 'es' })
    expect([...a]).not.toEqual([...b])
  })
})
