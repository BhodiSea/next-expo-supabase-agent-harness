import type { X25519KeyPair, X25519Provider } from './ports.js'

// The web/node X25519Provider — the ONE shipped implementation, and it lives
// on the `.` barrel only, for exactly the webcrypto-provider.ts reason: Hermes
// ships no Web Crypto, Metro does not tree-shake, and this file reaches for
// `crypto.subtle`, so it must be structurally unreachable from the mobile
// bundle. Browsers and Node (>= 22) ship X25519 in WebCrypto via the Secure
// Curves spec; the mobile implementation is a consumer decision
// (docs/modules/e2ee/mobile-provider.patch.md — @noble/curves, priced there).
// SOURCE: https://wicg.github.io/webcrypto-secure-curves/ (X25519 in
// crypto.subtle: generateKey/importKey/exportKey/deriveBits)
// [corpus: wicg/webcrypto-secure-curves]
//
// Declared locally and NARROWLY, the same call webcrypto-provider.ts makes:
// `types: []` keeps DOM out of the shared package, so the members this file
// uses are declared at the use site. `| undefined` because Hermes genuinely
// lacks the global.
interface WebCryptoX25519Global {
  subtle: {
    generateKey(
      algorithm: { name: 'X25519' },
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<{ publicKey: unknown; privateKey: unknown }>
    exportKey(format: 'raw' | 'pkcs8', key: unknown): Promise<ArrayBuffer>
    importKey(
      format: 'raw' | 'pkcs8',
      keyData: Uint8Array,
      algorithm: { name: 'X25519' },
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<unknown>
    // SOURCE: https://wicg.github.io/webcrypto-secure-curves/ (X25519 deriveBits: EcdhKeyDeriveParams-shaped `public`) [corpus: wicg/webcrypto-secure-curves]
    deriveBits(
      algorithm: { name: 'X25519'; public: unknown },
      baseKey: unknown,
      length: number,
    ): Promise<ArrayBuffer>
  }
}
declare const crypto: WebCryptoX25519Global | undefined

const X25519_KEY_BYTES = 32

// THE PKCS#8 BRIDGE. The port trades in raw 32-byte scalars (cross-platform
// parity with a @noble/curves mobile implementation), but WebCrypto refuses to
// export or import a raw X25519 PRIVATE key — raw format is public-keys-only
// under the Secure Curves spec. RFC 8410's encoding closes the gap: an X25519
// private key with no attributes is a CONSTANT 48-byte DER — this fixed
// 16-byte prefix (SEQUENCE, version 0, the id-X25519 OID 1.3.101.110, and the
// nested OCTET STRING headers) followed by the raw 32-byte scalar — so the
// bridge is byte concatenation in one direction and a verified strip in the
// other, with no DER parser to get wrong.
// SOURCE: https://www.rfc-editor.org/rfc/rfc8410 §7 (CurvePrivateKey: the raw
// key inside OneAsymmetricKey's OCTET STRING) [corpus: ietf/rfc8410-x25519-pkcs8]
const PKCS8_X25519_PREFIX_HEX = '302e020100300506032b656e04220420'
const PKCS8_X25519_PREFIX = Uint8Array.from(PKCS8_X25519_PREFIX_HEX.match(/../g) ?? [], (byte) =>
  Number.parseInt(byte, 16),
)
const PKCS8_X25519_BYTES = PKCS8_X25519_PREFIX.length + X25519_KEY_BYTES

const rawToPkcs8 = (secretKey: Uint8Array): Uint8Array => {
  const out = new Uint8Array(PKCS8_X25519_BYTES)
  out.set(PKCS8_X25519_PREFIX)
  out.set(secretKey, PKCS8_X25519_PREFIX.length)
  return out
}

// The strip VERIFIES the prefix rather than trusting offset 16: an engine that
// emitted any other DER layout (attributes, a different OID) would otherwise
// hand back 32 bytes of the wrong thing labelled as a key. Refuse instead.
const pkcs8ToRaw = (pkcs8: Uint8Array): Uint8Array | null => {
  if (pkcs8.length !== PKCS8_X25519_BYTES) return null
  for (let i = 0; i < PKCS8_X25519_PREFIX.length; i += 1) {
    if (pkcs8.at(i) !== PKCS8_X25519_PREFIX.at(i)) return null
  }
  return pkcs8.slice(PKCS8_X25519_PREFIX.length)
}

/**
 * Build the WebCrypto-backed X25519 provider, or return null when the runtime
 * has no Web Crypto at all — null-not-throw, the CryptoProvider factory's own
 * contract. The check is presence-of-subtle only: whether the engine actually
 * implements X25519 is only learnable by calling it, so an engine without the
 * algorithm surfaces as null from the METHODS (a runtime refusal, one seam up
 * a named CryptoResult), not from this factory.
 */
export function createWebCryptoX25519Provider(): X25519Provider | null {
  if (typeof crypto?.subtle === 'undefined') return null
  return {
    async generateKeyPair(): Promise<X25519KeyPair | null> {
      // extractable: true is REQUIRED by the port's byte shape, and it is the
      // honest cost of cross-platform parity: the ephemeral secret this seam
      // mints lives for one wrap and is dropped, and a recipient's static
      // secret already had to be byte-shaped to live in the KeystoreAdapter.
      // (The non-extractable alternative is foreclosed for the same reason it
      // is on the keystore port — bytes that cannot be read cannot be carried
      // to the other primitives.)
      // SOURCE: https://wicg.github.io/webcrypto-secure-curves/ (X25519 generateKey; deriveBits usage) [corpus: wicg/webcrypto-secure-curves]
      try {
        const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
        const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
        const secretKey = pkcs8ToRaw(
          new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
        )
        if (secretKey === null || publicKey.length !== X25519_KEY_BYTES) return null
        return { publicKey, secretKey }
      } catch {
        // No X25519 in this engine (pre-Secure-Curves browsers) — a refusal,
        // never a throw, so the caller's failure surface stays a CryptoResult.
        return null
      }
    },
    async deriveSharedSecret({ secretKey, publicKey }) {
      if (secretKey.length !== X25519_KEY_BYTES || publicKey.length !== X25519_KEY_BYTES) {
        return null
      }
      try {
        // The raw scalar rides in through the RFC 8410 PKCS#8 bridge (raw is public-keys-only).
        // SOURCE: https://www.rfc-editor.org/rfc/rfc8410 §7 [corpus: ietf/rfc8410-x25519-pkcs8] · https://wicg.github.io/webcrypto-secure-curves/ (pkcs8 import; deriveBits usage) [corpus: wicg/webcrypto-secure-curves]
        const pkcs8 = rawToPkcs8(secretKey)
        const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, [
          'deriveBits',
        ])
        const pub = await crypto.subtle.importKey('raw', publicKey, { name: 'X25519' }, false, [])
        // 256 bits, the whole X25519 output. CONTRIBUTORY-BEHAVIOUR NOTE: when
        // the peer point is low-order the X25519 output is all zeros, and the
        // Secure Curves spec REQUIRES deriveBits to reject that as an
        // OperationError instead of returning it — the engine refuses, this
        // catch turns the refusal into null, and no all-zero "shared secret"
        // can ever reach the HKDF above this seam.
        // SOURCE: https://wicg.github.io/webcrypto-secure-curves/ (X25519
        // deriveBits errors on an all-zero result)
        // [corpus: wicg/webcrypto-secure-curves]
        const bits = await crypto.subtle.deriveBits(
          { name: 'X25519', public: pub },
          priv,
          X25519_KEY_BYTES * 8,
        )
        return new Uint8Array(bits)
      } catch {
        return null
      }
    },
  }
}
