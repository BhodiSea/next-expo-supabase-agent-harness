import { describe, expect, it } from 'vitest'
import type { X25519Provider } from './ports.js'
import { createWebCryptoX25519Provider } from './webcrypto-x25519.js'

// The X25519 provider held to the PUBLISHED vectors, not to a roundtrip — the
// same discipline as webcrypto-provider.test.ts, because a curve
// implementation that only agrees with itself is exactly what a wrong curve
// also does. Two suites of published answers:
//   §5.2 — raw scalar multiplication (scalar, input u, output u), which proves
//   the PKCS#8 prefix bridge delivers the exact scalar to the engine (a
//   one-byte offset error would clamp different bits and miss the answer);
//   §6.1 — a full Diffie-Hellman exchange with both key pairs and the shared
//   secret K published, which proves the two sides of deriveSharedSecret
//   agree with the RFC and with each other.
// SOURCE: https://www.rfc-editor.org/rfc/rfc7748 §5.2, §6.1 [corpus: ietf/rfc7748-x25519]

const RFC7748_SCALARMULT = [
  {
    name: 'rfc7748 §5.2 vector 1',
    scalar: 'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4',
    u: 'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c',
    out: 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
  },
  {
    name: 'rfc7748 §5.2 vector 2',
    scalar: '4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d',
    u: 'e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493',
    out: '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957',
  },
] as const

// RFC 7748 §6.1 — Alice and Bob, both halves published, plus K.
const DH = {
  aliceSk: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  alicePk: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
  bobSk: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
  bobPk: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
  k: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
} as const

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// The base point u = 9 — X25519(sk, 9) is the public key (RFC 7748 §4.1).
const basepoint = (() => {
  const u = new Uint8Array(32)
  u[0] = 9
  return u
})()

// The REAL engine, deliberately: Node >= 22 ships X25519 WebCrypto (the Secure
// Curves spec), so a null here is an environment failure worth stopping the
// suite for — weakening these vectors to a mock would prove the mock.
const maybeProvider = createWebCryptoX25519Provider()
if (maybeProvider === null) {
  throw new Error('vitest runs on Node >= 22, which ships X25519 WebCrypto — refusing to mock')
}
const provider: X25519Provider = maybeProvider

describe('deriveSharedSecret against the published RFC 7748 vectors', () => {
  for (const v of RFC7748_SCALARMULT) {
    it(`computes ${v.name} to the exact output u-coordinate`, async () => {
      const out = await provider.deriveSharedSecret({
        secretKey: hex(v.scalar),
        publicKey: hex(v.u),
      })
      if (out === null) throw new Error(`${v.name}: deriveSharedSecret refused a published vector`)
      expect(toHex(out)).toBe(v.out)
    })
  }

  it('agrees with the §6.1 Diffie-Hellman exchange from BOTH sides', async () => {
    const fromAlice = await provider.deriveSharedSecret({
      secretKey: hex(DH.aliceSk),
      publicKey: hex(DH.bobPk),
    })
    const fromBob = await provider.deriveSharedSecret({
      secretKey: hex(DH.bobSk),
      publicKey: hex(DH.alicePk),
    })
    if (fromAlice === null || fromBob === null) {
      throw new Error('deriveSharedSecret refused the published §6.1 keys')
    }
    expect(toHex(fromAlice)).toBe(DH.k)
    expect(toHex(fromBob)).toBe(DH.k)
  })

  it('derives the §6.1 PUBLIC keys from the secret keys via the base point', async () => {
    // X25519(sk, 9) == pk — the identity unwrapDekWith relies on to recover
    // the recipient public key from the secret alone. Held to the published
    // pairs so the base-point constant and the PKCS#8 bridge are both proven.
    const alicePk = await provider.deriveSharedSecret({
      secretKey: hex(DH.aliceSk),
      publicKey: basepoint,
    })
    const bobPk = await provider.deriveSharedSecret({
      secretKey: hex(DH.bobSk),
      publicKey: basepoint,
    })
    if (alicePk === null || bobPk === null) {
      throw new Error('deriveSharedSecret refused the base point')
    }
    expect(toHex(alicePk)).toBe(DH.alicePk)
    expect(toHex(bobPk)).toBe(DH.bobPk)
  })
})

describe('generateKeyPair', () => {
  it('returns a 32/32 byte pair whose halves actually correspond', async () => {
    const pair = await provider.generateKeyPair()
    if (pair === null) throw new Error('generateKeyPair refused on an engine with X25519')
    expect(pair.publicKey).toHaveLength(32)
    expect(pair.secretKey).toHaveLength(32)
    // The correspondence proof: the exported secret, pushed back through the
    // PKCS#8 bridge and multiplied by the base point, must land on the
    // exported public key. This is what catches a bridge that strips the wrong
    // 32 bytes — each export alone looks plausible; only the pair can't lie.
    const derived = await provider.deriveSharedSecret({
      secretKey: pair.secretKey,
      publicKey: basepoint,
    })
    if (derived === null) throw new Error('the generated secret key was refused')
    expect(toHex(derived)).toBe(toHex(pair.publicKey))
  })

  it('mints a fresh pair per call', async () => {
    const a = await provider.generateKeyPair()
    const b = await provider.generateKeyPair()
    if (a === null || b === null) throw new Error('generateKeyPair refused')
    expect(toHex(a.secretKey)).not.toBe(toHex(b.secretKey))
  })
})

describe('refusals are null, never a throw', () => {
  it('refuses the all-zero peer point — the contributory-behaviour check', async () => {
    // A low-order point makes the X25519 output all zeros, and the Secure
    // Curves spec requires deriveBits to reject that as an OperationError
    // rather than hand it over — so the port must answer null, and no all-zero
    // "shared secret" can reach the HKDF above this seam.
    // SOURCE: https://wicg.github.io/webcrypto-secure-curves/ [corpus: wicg/webcrypto-secure-curves]
    const out = await provider.deriveSharedSecret({
      secretKey: hex(DH.aliceSk),
      publicKey: new Uint8Array(32),
    })
    expect(out).toBeNull()
  })

  it('refuses a wrong-length secret key', async () => {
    expect(
      await provider.deriveSharedSecret({
        secretKey: new Uint8Array(31),
        publicKey: hex(DH.bobPk),
      }),
    ).toBeNull()
  })

  it('refuses a wrong-length public key', async () => {
    expect(
      await provider.deriveSharedSecret({
        secretKey: hex(DH.aliceSk),
        publicKey: new Uint8Array(33),
      }),
    ).toBeNull()
  })
})
