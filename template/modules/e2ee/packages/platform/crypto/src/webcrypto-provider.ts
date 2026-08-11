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
declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T
  subtle: {
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      algorithm: { name: 'AES-GCM' } | { name: 'HKDF' },
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<unknown>
    encrypt(
      algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array; tagLength: 128 },
      key: unknown,
      data: Uint8Array,
    ): Promise<ArrayBuffer>
    decrypt(
      algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array; tagLength: 128 },
      key: unknown,
      data: Uint8Array,
    ): Promise<ArrayBuffer>
    deriveBits(
      algorithm: { name: 'HKDF'; hash: 'SHA-256'; salt: Uint8Array; info: Uint8Array },
      baseKey: unknown,
      length: number,
    ): Promise<ArrayBuffer>
  }
}

/**
 * Build the WebCrypto-backed provider, or return null when the runtime has no
 * Web Crypto (Hermes, very old Node) — null-not-throw so a host can choose its
 * failure surface, the KeystoreAdapter contract's own style.
 */
export function createWebCryptoProvider(): CryptoProvider | null {
  if (typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') return null
  return {
    randomBytes(length) {
      // SOURCE: https://www.w3.org/TR/WebCryptoAPI/ (getRandomValues is the
      // platform CSPRNG) [corpus: w3c/webcrypto]
      return crypto.getRandomValues(new Uint8Array(length))
    },
    async aeadSeal({ key, iv, plaintext, aad }) {
      const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
      // tagLength pinned to 128 — the full GCM tag; a shorter tag is a reviewed
      // weakening this port refuses to express.
      // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
      // [corpus: nist/sp800-38d-gcm]
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        k,
        plaintext,
      )
      return new Uint8Array(ct)
    },
    async aeadOpen({ key, iv, ciphertext, aad }) {
      const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt'])
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
          k,
          ciphertext,
        )
        return new Uint8Array(pt)
      } catch {
        // WebCrypto reports authentication failure as an OperationError with no
        // detail ON PURPOSE (padding-oracle history); the port's contract is
        // null, and adding detail here would subtract safety.
        return null
      }
    },
    async hkdfSha256({ ikm, salt, info, length }) {
      const k = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits'])
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        k,
        length * 8,
      )
      return new Uint8Array(bits)
    },
  }
}
