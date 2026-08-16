import type { CryptoProvider } from './ports.js'

// The web/node CryptoProvider — the ONE shipped implementation, and it lives on
// the `.` barrel only. Hermes ships no Web Crypto (the LargeSecureStore
// doctrine's own words: "the global would be whatever a polyfill package
// installed — and a key derived from Math.random is not a key"), so this file
// must be structurally unreachable from the mobile bundle; that is the census
// reason @app/crypto ships the dual barrel. The mobile provider is a consumer
// decision: docs/modules/e2ee/mobile-provider.patch.md.
//
// Declared locally and NARROWLY, the @app/ratelimit pattern: `types: []` in
// tsconfig keeps DOM out of a shared package, and the four members named here
// are the WinterCG-shaped subset every host this file runs on provides
// (Node >= 22, every evergreen browser).
// SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (AES-GCM params, HKDF deriveBits)
// [corpus: w3c/webcrypto]
// `| undefined` is not decoration: Hermes has no Web Crypto, so on the surface this
// package most needs to be honest about, the global is genuinely absent. Typing it as
// always-present would make the guard below read as dead code to the linter (it did —
// `no-unnecessary-condition` fired) while the runtime failure it prevents is real.
// The two parameter shapes this provider ever hands the engine, named once so
// each is one cited declaration rather than a literal repeated per call site.
// SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (AesGcmParams: iv, additionalData, tagLength) [corpus: w3c/webcrypto]
interface AesGcmParams {
  name: 'AES-GCM'
  iv: Uint8Array
  additionalData: Uint8Array
  tagLength: 128
}
// SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (HkdfParams: hash, salt, info) [corpus: w3c/webcrypto]
interface HkdfParams {
  name: 'HKDF'
  hash: 'SHA-256'
  salt: Uint8Array
  info: Uint8Array
}
interface WebCryptoGlobal {
  getRandomValues<T extends Uint8Array>(array: T): T
  subtle: {
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (importKey algorithm identifiers) [corpus: w3c/webcrypto]
      algorithm: { name: 'AES-GCM' } | { name: 'HKDF' },
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<unknown>
    encrypt(algorithm: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
    decrypt(algorithm: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
    // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (HKDF deriveBits) [corpus: w3c/webcrypto]
    deriveBits(algorithm: HkdfParams, baseKey: unknown, length: number): Promise<ArrayBuffer>
  }
}
declare const crypto: WebCryptoGlobal | undefined

// AES-256 ONLY. WebCrypto's importKey happily accepts a 16- or 24-byte key, and
// an adversarial review showed the consequence: a 16-byte KEK sealed AES-128
// under an envelope whose alg byte DECLARES AES-256-GCM, so the envelope lied
// about its own algorithm and the "one decoder that can refuse" could not tell.
// The length check is here, once, in front of every key this provider imports.
const AES_256_KEY_BYTES = 32
async function importAesKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<unknown> {
  // `crypto` is typed `| undefined` because Hermes genuinely lacks it; this
  // helper sits outside createWebCryptoProvider's guard, so it re-checks rather
  // than assert. Same answer either way: a refusal, never a throw.
  if (crypto === undefined || key.length !== AES_256_KEY_BYTES) return null
  // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (importKey raw AES-GCM, non-extractable) [corpus: w3c/webcrypto]
  return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [usage]).catch(() => null)
}

/**
 * Build the WebCrypto-backed provider, or return null when the runtime has no
 * Web Crypto (Hermes, very old Node) — null-not-throw so a host can choose its
 * failure surface, the KeystoreAdapter contract's own style.
 */
export function createWebCryptoProvider(): CryptoProvider | null {
  if (typeof crypto?.subtle === 'undefined') return null
  return {
    randomBytes(length) {
      // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (getRandomValues is the
      // platform CSPRNG) [corpus: w3c/webcrypto]
      return crypto.getRandomValues(new Uint8Array(length))
    },
    // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AEAD seal: ciphertext carries the tag) [corpus: ietf/rfc5116-aead]
    async aeadSeal({ key, iv, plaintext, aad }) {
      // importKey INSIDE the guard, not beside it: WebCrypto rejects here with a
      // DataError on a wrong-length key, and an adversarial review showed that
      // rejection escaping the package as a thrown error — through a sealItem
      // that had no way to express failure. The port's contract is a typed
      // refusal, so the throw becomes one.
      const k = await importAesKey(key, 'encrypt')
      if (k === null) return null
      // tagLength pinned to 128 — the full GCM tag; a shorter tag is a reviewed
      // weakening this port refuses to express.
      // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (128-bit tag) [corpus: nist/sp800-38d-gcm]
      const params: AesGcmParams = { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }
      try {
        return new Uint8Array(await crypto.subtle.encrypt(params, k, plaintext))
      } catch {
        return null
      }
    },
    // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AEAD open: one failure output) [corpus: ietf/rfc5116-aead]
    async aeadOpen({ key, iv, ciphertext, aad }) {
      const k = await importAesKey(key, 'decrypt')
      if (k === null) return null
      // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (128-bit tag) [corpus: nist/sp800-38d-gcm]
      const params: AesGcmParams = { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }
      try {
        return new Uint8Array(await crypto.subtle.decrypt(params, k, ciphertext))
      } catch {
        // WebCrypto reports authentication failure as an OperationError with no
        // detail ON PURPOSE (padding-oracle history); the port's contract is
        // null, and adding detail here would subtract safety. An engine that
        // cannot do AES-GCM at all also lands here — indistinguishable by
        // construction, which is why the key length is checked ABOVE, where the
        // common misuse actually is.
        return null
      }
    },
    // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (HKDF-SHA-256 extract-and-expand) [corpus: ietf/rfc5869-hkdf]
    async hkdfSha256({ ikm, salt, info, length }) {
      // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (HKDF importKey raw, deriveBits usage) [corpus: w3c/webcrypto]
      const k = await crypto.subtle
        .importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits'])
        .catch(() => null)
      if (k === null) return null
      // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (HkdfParams; deriveBits length in bits) [corpus: w3c/webcrypto]
      const params: HkdfParams = { name: 'HKDF', hash: 'SHA-256', salt, info }
      try {
        return new Uint8Array(await crypto.subtle.deriveBits(params, k, length * 8))
      } catch {
        return null
      }
    },
  }
}
