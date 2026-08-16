// The ports the package is built over — every contract a HOST must supply,
// declared here and implemented NOWHERE in it: the SessionStorageAdapter
// precedent (@app/supabase src/session-storage.ts): the shared package states
// the contract, the HOSTS implement it, and that split is what keeps platform
// SDKs and runtime globals out of the shared graph. The web/node
// implementations ship on the `.` barrel (webcrypto-provider.ts for
// CryptoProvider, webcrypto-x25519.ts for X25519Provider); each mobile
// implementation is a consumer decision documented in
// docs/modules/e2ee/mobile-provider.patch.md, because a native crypto
// dependency is a decision made deliberately, not defaulted (the observability
// module's OTLP stance, applied to primitives).

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
  /**
   * AES-256-GCM seal: ciphertext ‖ 16-byte tag, or NULL when the engine refuses
   * (a key that is not 32 bytes, an engine without AES-GCM). Never throws — an
   * adversarial review found a wrong-length key rejecting out of the package
   * through a `sealItem` that had no way to express failure.
   * The iv MUST be 12 bytes and MUST NEVER repeat under one key.
   */
  // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (96-bit iv, full tag) [corpus: nist/sp800-38d-gcm]
  aeadSeal(args: {
    key: Uint8Array
    iv: Uint8Array
    plaintext: Uint8Array
    aad: Uint8Array
  }): Promise<Uint8Array | null>
  /** AES-256-GCM open: null on ANY authentication failure — never throws. */
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (one failure output) [corpus: ietf/rfc5116-aead]
  aeadOpen(args: {
    key: Uint8Array
    iv: Uint8Array
    ciphertext: Uint8Array
    aad: Uint8Array
  }): Promise<Uint8Array | null>
  /**
   * HKDF-SHA-256 (extract + expand), or NULL when the engine refuses. Never
   * throws, for the same reason as aeadSeal above.
   */
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 [corpus: ietf/rfc5869-hkdf]
  hkdfSha256(args: {
    ikm: Uint8Array
    salt: Uint8Array
    info: Uint8Array
    length: number
  }): Promise<Uint8Array | null>
}

/** A raw X25519 key pair: 32-byte scalar, 32-byte u-coordinate. */
export interface X25519KeyPair {
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
}

/**
 * The X25519 primitive the recipient-wrap seam (recipient-wrap.ts) is built
 * over. A SECOND port rather than two more members on CryptoProvider —
 * deliberately: a provider that cannot do X25519 must still be able to satisfy
 * CryptoProvider whole (Hermes-side AES/HKDF and X25519 come from DIFFERENT
 * libraries — @noble/ciphers + @noble/hashes vs @noble/curves — and a merged
 * contract would force every host to wire all of them before sealing its first
 * item). It lives HERE with the other host-implemented contracts, not beside
 * the seam that consumes it, because ports.ts is the one file that answers
 * "what must a host supply" — the same reason CryptoProvider does not live in
 * keyring.ts.
 *
 * Keys are RAW BYTES (32-byte scalars and u-coordinates), never engine
 * handles, so a WebCrypto implementation and a future @noble/curves mobile
 * implementation produce interchangeable material — the cross-platform parity
 * the byte-shaped KeystoreAdapter below already committed this package to.
 * Null-not-throw throughout: `deriveSharedSecret` returns null when the engine
 * refuses — a malformed key, a missing algorithm, or the ALL-ZERO shared
 * secret a low-order peer point produces, which a conforming WebCrypto engine
 * rejects as an OperationError rather than handing to the caller.
 * SOURCE: https://www.rfc-editor.org/rfc/rfc7748 (X25519; the public key is
 * X25519(secret, 9)) [corpus: ietf/rfc7748-x25519] ·
 * https://wicg.github.io/webcrypto-secure-curves/ (deriveBits MUST error on an
 * all-zero result) [corpus: wicg/webcrypto-secure-curves]
 */
export interface X25519Provider {
  /** A fresh key pair from the platform engine, or null when it refuses. */
  generateKeyPair(): Promise<X25519KeyPair | null>
  /** X25519(secretKey, publicKey) — 32 bytes, or null on ANY refusal. Never throws. */
  deriveSharedSecret(args: {
    secretKey: Uint8Array
    publicKey: Uint8Array
  }): Promise<Uint8Array | null>
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
 * problem. Documented in docs/modules/e2ee/README.md.
 *
 * The byte shape is now DECISIVE, not historical. Recovery and device sync
 * (recovery.ts, device-sync.ts) both SEAL THE ROOT KEY ITSELF — escrowRootKey
 * and exportForDevice take the raw 32 bytes as AEAD plaintext — and a
 * non-extractable handle whose bytes JavaScript cannot read could never feed
 * either one. A handle-shaped port would not be a hardening; it would be the
 * quiet return of "lost device is lost data", because the key that cannot be
 * read is also the key that cannot be escrowed or carried to a second device.
 * The trade is recorded here so nobody "fixes" the web weakness by breaking
 * both shipped seams.
 */
export interface KeystoreAdapter {
  getRootKey(userId: string): Promise<Uint8Array | null>
  setRootKey(userId: string, key: Uint8Array): Promise<void>
  deleteRootKey(userId: string): Promise<void>
}
