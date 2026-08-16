import { describe, expect, it } from 'vitest'
import {
  AAD_ROLE_DEK,
  AAD_ROLE_DEVICE_SYNC,
  AAD_ROLE_ITEM,
  AAD_ROLE_RECIPIENT_WRAP,
  AAD_ROLE_RECOVERY,
  buildAad,
  buildAadBytes,
} from './envelope.js'
import type { CryptoProvider, X25519KeyPair, X25519Provider } from './ports.js'
import { RECIPIENT_WIRE_VERSION, unwrapDekWith, wrapDekFor } from './recipient-wrap.js'
import { createWebCryptoProvider } from './webcrypto-provider.js'
import { createWebCryptoX25519Provider } from './webcrypto-x25519.js'

// The org-sharing seam over the REAL providers (both are vector-proven in
// their own suites next door) — these tests own the CONSTRUCTION: the wire
// format, the sealed-box property, and the refusals that make a moved or
// tampered blob fail authentication instead of opening in the wrong hands.

// Declared locally: the package sets `types: []` so platform globals stay out
// of the shared graph — see the note in envelope.ts.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const maybeProvider = createWebCryptoProvider()
const maybeX = createWebCryptoX25519Provider()
if (maybeProvider === null || maybeX === null) {
  throw new Error('vitest runs on Node >= 22 — WebCrypto and X25519 must exist here')
}
const provider: CryptoProvider = maybeProvider
const x25519: X25519Provider = maybeX

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// Same branched read as the sibling suites: noUncheckedIndexedAccess makes
// `x[i] ^= 1` unwritable, and `!` is the habit the rubric names.
const flipByte = (bytes: Uint8Array, index: number): Uint8Array => {
  const out = bytes.slice()
  out[index] = (out.at(index) ?? 0) ^ 0x01
  return out
}

async function pairOrThrow(): Promise<X25519KeyPair> {
  const pair = await x25519.generateKeyPair()
  if (pair === null) throw new Error('generateKeyPair refused on an engine with X25519')
  return pair
}
async function wrapOrThrow(dek: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
  const r = await wrapDekFor(provider, x25519, { dek, recipientPublicKey })
  if (!r.ok) throw new Error(`wrapDekFor refused: ${r.reason}`)
  return r.value
}

describe('wrap → unwrap roundtrip', () => {
  it('unwraps to the exact DEK with the recipient secret key alone', async () => {
    const recipient = await pairOrThrow()
    const dek = provider.randomBytes(32)
    const wire = await wrapOrThrow(dek, recipient.publicKey)
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: wire,
      recipientSecretKey: recipient.secretKey,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(toHex(opened.value)).toBe(toHex(dek))
  })

  it('carries wire version 0x01, the ephemeral point, and a 98-byte total for a 32-byte DEK', async () => {
    const recipient = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    expect(wire.at(0)).toBe(RECIPIENT_WIRE_VERSION)
    // 1 wireV + 32 eph_pk + 5 header + 12 iv + (32 ct + 16 tag)
    expect(wire).toHaveLength(98)
  })

  it('mints a FRESH ephemeral per wrap — two wraps of one DEK share no bytes past the version', async () => {
    const recipient = await pairOrThrow()
    const dek = provider.randomBytes(32)
    const a = await wrapOrThrow(dek, recipient.publicKey)
    const b = await wrapOrThrow(dek, recipient.publicKey)
    // The sealed-box property: reusing an ephemeral would link every wrap it
    // made. The ephemeral point occupies bytes 1..33 — compare exactly those.
    expect(toHex(a.slice(1, 33))).not.toBe(toHex(b.slice(1, 33)))
  })
})

describe('the committed known answer — the wire format, frozen', () => {
  // The RFC 7748 §6.1 pairs, reused as FIXED inputs: alice as the ephemeral,
  // bob as the recipient, so even the intermediate shared secret is a
  // published value (K). The expected wire below was computed at authoring
  // time by composing WebCrypto primitives directly (X25519 → HKDF-SHA-256
  // with the info string → AES-256-GCM under the role-0x02 AAD), independent
  // of the shipped source. What this test FREEZES is the construction — the
  // wire framing, the info string, the AAD layout, the field order; primitive
  // correctness is owned by the vector suites. Change any of them and this
  // hex changes, which is exactly the alarm it exists to raise.
  const ephemeral: X25519KeyPair = {
    secretKey: hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
    publicKey: hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'),
  }
  const bobSk = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
  const bobPk = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
  const dek = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
  const iv = hex('404142434445464748494a4b')
  const expectedWire =
    '018520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a' +
    'a7e101010c404142434445464748494a4b' +
    'c92e806c820a5982ac028b207c4bd8fd33dff26a6f4cbdafdd1d69bbe58dc593' +
    'b39c3029e335e6d36a687a3b9661a446'

  // THE INJECTION SEAM IS THE PROVIDER — both fixed inputs arrive through test
  // doubles that wrap the real implementations, so the production API carries
  // no test-only parameter: the X25519 double returns the fixed ephemeral from
  // generateKeyPair (and delegates the real math), the CryptoProvider double
  // returns the fixed IV from randomBytes (and delegates the real AEAD/HKDF).
  const fixedX25519: X25519Provider = {
    generateKeyPair: () => Promise.resolve(ephemeral),
    deriveSharedSecret: (args) => x25519.deriveSharedSecret(args),
  }
  const fixedIvProvider: CryptoProvider = {
    randomBytes: () => iv.slice(),
    aeadSeal: (args) => provider.aeadSeal(args),
    aeadOpen: (args) => provider.aeadOpen(args),
    hkdfSha256: (args) => provider.hkdfSha256(args),
  }

  it('wraps the fixed DEK to the exact committed wire bytes', async () => {
    const wire = await wrapDekFor(fixedIvProvider, fixedX25519, {
      dek,
      recipientPublicKey: bobPk,
    })
    if (!wire.ok) throw new Error(`wrapDekFor refused the known answer: ${wire.reason}`)
    expect(toHex(wire.value)).toBe(expectedWire)
  })

  it('unwraps the committed wire with the REAL providers', async () => {
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: hex(expectedWire),
      recipientSecretKey: bobSk,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(toHex(opened.value)).toBe(toHex(dek))
  })
})

describe('refusals, each with its own reason', () => {
  it("refuses another principal's secret key — the moved-recipient case", async () => {
    const recipient = await pairOrThrow()
    const other = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: wire,
      recipientSecretKey: other.secretKey,
    })
    expect(opened).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('refuses a tampered ephemeral point', async () => {
    const recipient = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: flipByte(wire, 1), // first ephemeral byte
      recipientSecretKey: recipient.secretKey,
    })
    expect(opened).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('refuses a tampered ciphertext byte', async () => {
    const recipient = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: flipByte(wire, wire.length - 1),
      recipientSecretKey: recipient.secretKey,
    })
    expect(opened).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('too short → envelope_malformed', async () => {
    const recipient = await pairOrThrow()
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: new Uint8Array(20),
      recipientSecretKey: recipient.secretKey,
    })
    expect(opened).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('wire version 2 → unsupported_version (a future fleet, not corruption)', async () => {
    const recipient = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    const bumped = wire.slice()
    bumped[0] = 0x02
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: bumped,
      recipientSecretKey: recipient.secretKey,
    })
    expect(opened).toMatchObject({ ok: false, reason: 'unsupported_version' })
  })

  it("a corrupted INNER envelope reports the envelope decoder's own reason", async () => {
    const recipient = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    const badMagic = wire.slice()
    badMagic[33] = 0x00 // the envelope magic's first byte, past wireV + eph_pk
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: badMagic,
      recipientSecretKey: recipient.secretKey,
    })
    expect(opened).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('refuses a wrong-length recipient secret key with key_missing', async () => {
    const recipient = await pairOrThrow()
    const wire = await wrapOrThrow(provider.randomBytes(32), recipient.publicKey)
    const opened = await unwrapDekWith(provider, x25519, {
      wrapped: wire,
      recipientSecretKey: new Uint8Array(31),
    })
    expect(opened).toMatchObject({ ok: false, reason: 'key_missing' })
  })

  it('refuses to WRAP to a low-order recipient point — the contributory check, end to end', async () => {
    const r = await wrapDekFor(provider, x25519, {
      dek: provider.randomBytes(32),
      recipientPublicKey: new Uint8Array(32),
    })
    expect(r).toMatchObject({ ok: false, reason: 'key_missing' })
  })
})

describe('the role byte — a role-0x02 blob authenticates in no other slot', () => {
  it('every role pair builds a DIFFERENT AAD over identical field bytes', () => {
    // Asserted on the builders DIRECTLY, the keyring.test.ts precedent: an
    // end-to-end swap is also refused by key and framing differences, so only
    // the builder comparison can prove the ROLE BYTE does its own work. The
    // string builder's output for a row is reproduced byte-for-byte through
    // the byte builder minus the role, so each pair below differs in exactly
    // one byte — index 2.
    const enc = new TextEncoder()
    const ctx = { userId: 'u1', table: 'notes', itemId: 'n1', field: 'body' }
    const fields = [enc.encode('u1'), enc.encode('notes'), enc.encode('n1'), enc.encode('body')]
    const aads = [
      buildAad(AAD_ROLE_ITEM, ctx),
      buildAad(AAD_ROLE_DEK, ctx),
      buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, fields),
      buildAadBytes(AAD_ROLE_RECOVERY, fields),
      buildAadBytes(AAD_ROLE_DEVICE_SYNC, fields),
    ]
    for (let a = 0; a < aads.length; a += 1) {
      for (let b = a + 1; b < aads.length; b += 1) {
        const left = aads.at(a)
        const right = aads.at(b)
        if (left === undefined || right === undefined) throw new Error('unreachable')
        expect(toHex(left.slice(3))).toBe(toHex(right.slice(3))) // identical past the prefix…
        expect(toHex(left)).not.toBe(toHex(right)) // …so only the role byte separates them
      }
    }
  })

  it('a blob sealed under one role refuses to open under every other, all else EQUAL', async () => {
    // End to end with everything held constant except the role byte: same key,
    // same IV, same field bytes. This is the swap an attacker would attempt
    // with database access — moving sealed bytes between role slots — reduced
    // to its essential byte.
    const key = provider.randomBytes(32)
    const iv = provider.randomBytes(12)
    const fields = [provider.randomBytes(32)]
    const sealed = await provider.aeadSeal({
      key,
      iv,
      plaintext: provider.randomBytes(32),
      aad: buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, fields),
    })
    if (sealed === null) throw new Error('aeadSeal refused')
    for (const role of [AAD_ROLE_RECOVERY, AAD_ROLE_DEVICE_SYNC] as const) {
      expect(
        await provider.aeadOpen({
          key,
          iv,
          ciphertext: sealed,
          aad: buildAadBytes(role, fields),
        }),
      ).toBeNull()
    }
    // …and its own role still opens, so the refusals above mean the role byte.
    expect(
      await provider.aeadOpen({
        key,
        iv,
        ciphertext: sealed,
        aad: buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, fields),
      }),
    ).not.toBeNull()
  })
})
