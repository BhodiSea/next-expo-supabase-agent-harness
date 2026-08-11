// The two ports the package is built over, declared here and implemented
// NOWHERE in it — the SessionStorageAdapter precedent (@app/supabase
// src/session-storage.ts): the shared package states the contract, the HOSTS
// implement it, and that split is what keeps platform SDKs and runtime globals
// out of the shared graph. The web/node implementation of CryptoProvider ships
// on the `.` barrel (webcrypto-provider.ts); the mobile implementation is a
// consumer decision documented in docs/modules/e2ee/mobile-provider.patch.md,
// because a native crypto dependency is a decision made deliberately, not
// defaulted (the observability module's OTLP stance, applied to primitives).

/**
 * The injected primitives. Everything above this line of the stack is pure
 * logic; everything below it is a platform's crypto engine.
 *
 * The contract is deliberately AEAD-shaped rather than cipher-shaped: there is
 * no way to ask this port for an unauthenticated encryption, a static IV, or a
 * raw block operation, so a provider implemented against it cannot be misused
 * into one. `aeadOpen` returns null on authentication failure and NEVER throws
 * — an AEAD has exactly one failure output, and a throwing path here would
 * turn "not your ciphertext" into a crash surface.
 * SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AEAD interface: the
 * ciphertext carries the tag; decryption fails as a unit) [corpus: ietf/rfc5116-aead]
 */
export interface CryptoProvider {
  /** Cryptographically secure random bytes — a platform CSPRNG, never Math.random. */
  randomBytes(length: number): Uint8Array
  /** AES-256-GCM seal: returns ciphertext ‖ 16-byte tag. iv MUST be 12 bytes and NEVER reused per key. */
  aeadSeal(args: {
    key: Uint8Array
    iv: Uint8Array
    plaintext: Uint8Array
    aad: Uint8Array
  }): Promise<Uint8Array>
  /** AES-256-GCM open: null on ANY authentication failure — never throws. */
  aeadOpen(args: {
    key: Uint8Array
    iv: Uint8Array
    ciphertext: Uint8Array
    aad: Uint8Array
  }): Promise<Uint8Array | null>
  /** HKDF-SHA-256 (extract + expand). SOURCE: https://www.rfc-editor.org/rfc/rfc5869 [corpus: ietf/rfc5869-hkdf] */
  hkdfSha256(args: {
    ikm: Uint8Array
    salt: Uint8Array
    info: Uint8Array
    length: number
  }): Promise<Uint8Array>
}

/**
 * Where the root key lives — the platform keystore, behind the same contract
 * LargeSecureStore taught: `getRootKey` returns null on missing OR unreadable
 * (a half-restored backup reads as no-key, never a boot crash), and `setRootKey`
 * fails LOUD — a key that cannot persist must not pretend to.
 *
 * Hosts implement this (mobile: expo-secure-store through the src/host/**
 * one-door — the platform Keychain/Keystore). The package never sees a platform
 * API.
 *
 * THE WEB COST, stated precisely rather than as "a browser has no hardware
 * keychain": this port returns RAW BYTES, and that shape forecloses the
 * strongest browser option. A browser's best available store is a
 * NON-EXTRACTABLE CryptoKey handle in IndexedDB, whose bytes JavaScript cannot
 * read at all — which cannot satisfy a `Uint8Array` contract. So a web root key
 * under this port is extractable-by-JS by construction, and one XSS is a total
 * loss of every ciphertext that key protects. The mobile side does not have this
 * problem. Documented in docs/modules/e2ee/README.md; changing it means a
 * handle-shaped port, which is a breaking change nothing has yet paid for.
 */
export interface KeystoreAdapter {
  getRootKey(userId: string): Promise<Uint8Array | null>
  setRootKey(userId: string, key: Uint8Array): Promise<void>
  deleteRootKey(userId: string): Promise<void>
}
