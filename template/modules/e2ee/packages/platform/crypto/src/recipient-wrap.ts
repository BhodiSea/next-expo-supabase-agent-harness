import {
  AAD_ROLE_RECIPIENT_WRAP,
  ALG_AES_256_GCM,
  buildAadBytes,
  decodeEnvelope,
  ENVELOPE_VERSION,
  type Envelope,
  encodeEnvelope,
  GCM_IV_BYTES,
} from './envelope.js'
import type { CryptoProvider, X25519Provider } from './ports.js'
import { type CryptoResult, cryptoErr, cryptoOk } from './result.js'

// Wrapping a DEK to ANOTHER principal's public key — the org-sharing seam,
// implemented as X25519 ECIES with sealed-box semantics: a fresh ephemeral key
// pair per wrap, ECDH against the recipient's static public key, HKDF to an
// AES-256-GCM wrap key, and the ephemeral public key carried on the wire so
// only the recipient's secret key can open it. The sender cannot decrypt its
// own output afterwards — the ephemeral secret is dropped on the floor here
// and never returned.
// SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes (the
// construction: ephemeral pair per message, X25519, ephemeral pk prepended)
// [corpus: libsodium/sealed-boxes]
//
// Two refusals, recorded where the alternatives were considered:
// - NOT libsodium: the zero-dependency doctrine. Browsers and Node ship X25519
//   in WebCrypto (the Secure Curves spec), so the web/node half needs no
//   library at all, and the mobile half prices its own dependency in
//   docs/modules/e2ee/mobile-provider.patch.md like every other primitive.
// - NOT full RFC 9180 HPKE: its generality — three extra modes (auth/PSK), a
//   negotiable KEM/KDF/AEAD matrix, an exporter interface — is surface this
//   ONE seam does not need, and under this package's own envelope doctrine it
//   would be dead code behind an alg byte ("a reserved id that decodes to a
//   refusal is agility; an implemented mode nothing calls is not"). The
//   construction below IS the DHKEM(X25519)+HKDF+AES-GCM corner of HPKE,
//   without the negotiation surface.

// Declared locally and narrowly — see the note beside the same declaration in
// envelope.ts: `types: []` keeps platform globals out of the shared package.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const KEY_BYTES = 32
const X25519_POINT_BYTES = 32
// Zero salt for the same reason keyring.ts derives with one: RFC 5869 §3.1
// defines absent salt as HashLen zeros, and the separation lives in `info`.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 §3.1 [corpus: ietf/rfc5869-hkdf]
const HKDF_ZERO_SALT = new Uint8Array(32)
// The u-coordinate 9 — the X25519 base point. X25519(secret, 9) IS the public
// key, which is how unwrapDekWith recovers the recipient's public key from the
// secret alone instead of asking the caller to carry both halves (the API a
// caller can misuse by pairing the right secret with the wrong public key).
// SOURCE: https://www.rfc-editor.org/rfc/rfc7748 §4.1 (base point u = 9; the
// public key is X25519(a, 9)) [corpus: ietf/rfc7748-x25519]
const X25519_BASEPOINT = (() => {
  const u = new Uint8Array(X25519_POINT_BYTES)
  u[0] = 9
  return u
})()

/**
 * The wire format, one byte-string per wrapped DEK:
 *
 *   wireV u8 (0x01) | ephemeralPublicKey (32) | envelope
 *
 * The wire version is OUTSIDE the envelope because it frames what the envelope
 * cannot: how many bytes precede it and what they mean. 0x01 is the only value
 * this decoder accepts; anything else is `unsupported_version` — the same
 * decode-branch-not-fleet-migration argument the envelope version byte makes.
 */
export const RECIPIENT_WIRE_VERSION = 0x01
const WIRE_HEADER_BYTES = 1 + X25519_POINT_BYTES

/**
 * The org-sharing contract a consumer depends on — beside its implementation,
 * where the old ports-declared.ts declaration used to point. The methods
 * mirror wrapDekFor/unwrapDekWith below with the providers already bound; a
 * host builds one with createRecipientWrapPort at its composition root.
 */
export interface RecipientWrapPort {
  // SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes [corpus: libsodium/sealed-boxes]
  wrapDekFor(args: {
    dek: Uint8Array
    recipientPublicKey: Uint8Array
  }): Promise<CryptoResult<Uint8Array>>
  // SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes [corpus: libsodium/sealed-boxes]
  unwrapDekWith(args: {
    wrapped: Uint8Array
    recipientSecretKey: Uint8Array
  }): Promise<CryptoResult<Uint8Array>>
}

// ONE decoder for the wire, one distinct refusal per failure — the same
// contract decodeEnvelope holds one layer down, and it is reused here so the
// inner envelope's refusals (bad magic, future version, reserved alg,
// truncation) stay ITS refusals rather than being re-reported vaguely.
function decodeRecipientWire(
  bytes: Uint8Array,
): CryptoResult<{ ephemeralPublicKey: Uint8Array; envelope: Envelope }> {
  if (bytes.length < WIRE_HEADER_BYTES) {
    return cryptoErr(
      'envelope_malformed',
      `${String(bytes.length)} bytes is shorter than the wire version and ephemeral public key`,
    )
  }
  const wireV = bytes.at(0) ?? 0
  if (wireV !== RECIPIENT_WIRE_VERSION) {
    return cryptoErr('unsupported_version', `recipient-wrap wire version ${String(wireV)}`)
  }
  const ephemeralPublicKey = bytes.slice(1, WIRE_HEADER_BYTES)
  const envelope = decodeEnvelope(bytes.slice(WIRE_HEADER_BYTES))
  if (!envelope.ok) return envelope
  return cryptoOk({ ephemeralPublicKey, envelope: envelope.value })
}

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// The HKDF info binds BOTH public keys, not just a label: the wrap key is then
// a function of who sealed (the ephemeral) and who may open (the recipient),
// so a ciphertext replayed against a different recipient key derives a
// different key even before the AAD refuses it — the same context binding
// HPKE's KEM step performs with its enc ‖ pkR concatenation.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (info is the domain
// separator) [corpus: ietf/rfc5869-hkdf] ·
// https://doc.libsodium.org/public-key_cryptography/sealed_boxes (the sealed
// box binds both keys into its nonce derivation) [corpus: libsodium/sealed-boxes]
const wrapInfo = (ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array =>
  concatBytes(
    new TextEncoder().encode(`app-e2ee/v${String(ENVELOPE_VERSION)}/recipient-wrap`),
    ephemeralPublicKey,
    recipientPublicKey,
  )

/**
 * Seal a DEK to a recipient's X25519 public key. Returns the wire bytes
 * (`wireV | eph_pk | envelope`) — store them in the share row; they are
 * useless without the recipient's secret key, including to the caller.
 */
// SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes (seal) [corpus: libsodium/sealed-boxes]
export async function wrapDekFor(
  provider: CryptoProvider,
  x25519: X25519Provider,
  args: { dek: Uint8Array; recipientPublicKey: Uint8Array },
): Promise<CryptoResult<Uint8Array>> {
  // A fresh ephemeral per wrap — the sealed-box property. Reusing one would
  // link every wrap it made and hand a future compromise all of them at once.
  const ephemeral = await x25519.generateKeyPair()
  if (ephemeral === null) {
    return cryptoErr(
      'keystore_unavailable',
      'the crypto engine refused to mint an ephemeral X25519 key pair',
    )
  }
  const shared = await x25519.deriveSharedSecret({
    secretKey: ephemeral.secretKey,
    publicKey: args.recipientPublicKey,
  })
  if (shared === null) {
    // The engine refuses a malformed recipient key AND a low-order point (the
    // all-zero shared secret the Secure Curves spec makes deriveBits reject) —
    // both are a caller-supplied key that cannot receive, the same class as
    // sealItem's wrong-length KEK.
    // SOURCE: https://wicg.github.io/webcrypto-secure-curves/ [corpus: wicg/webcrypto-secure-curves]
    return cryptoErr(
      'key_missing',
      'the recipient public key was refused (wrong length, or a low-order point)',
    )
  }
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (info binds both public keys) [corpus: ietf/rfc5869-hkdf]
  const wrapKey = await provider.hkdfSha256({
    ikm: shared,
    salt: HKDF_ZERO_SALT,
    info: wrapInfo(ephemeral.publicKey, args.recipientPublicKey),
    length: KEY_BYTES,
  })
  if (wrapKey === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to derive the wrap key')
  }
  const iv = provider.randomBytes(GCM_IV_BYTES)
  // The AAD binds both curve points as length-prefixed byte fields under role
  // 0x02 — a recipient-wrapped DEK can never authenticate as an item, a
  // KEK-wrapped DEK, an escrow, or a sync payload, and a blob whose ephemeral
  // key was swapped fails authentication before the wrong shared secret even
  // matters.
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 §2.1 (AAD binds context) [corpus: ietf/rfc5116-aead]
  const ct = await provider.aeadSeal({
    key: wrapKey,
    iv,
    plaintext: args.dek,
    aad: buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, [ephemeral.publicKey, args.recipientPublicKey]),
  })
  if (ct === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to seal the wrapped key')
  }
  const envelope = encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct })
  return cryptoOk(concatBytes(Uint8Array.of(RECIPIENT_WIRE_VERSION), ephemeral.publicKey, envelope))
}

/**
 * Open a recipient-wrapped DEK with the recipient's X25519 secret key. The
 * public key is recovered from the secret (X25519(sk, 9)) rather than taken as
 * a second argument — only the secret key can open a sealed box, and an API
 * that also asked for the public half would add a way to fail without adding a
 * capability.
 */
// SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes (open) [corpus: libsodium/sealed-boxes]
export async function unwrapDekWith(
  provider: CryptoProvider,
  x25519: X25519Provider,
  args: { wrapped: Uint8Array; recipientSecretKey: Uint8Array },
): Promise<CryptoResult<Uint8Array>> {
  const wire = decodeRecipientWire(args.wrapped)
  if (!wire.ok) return wire
  const recipientPublicKey = await x25519.deriveSharedSecret({
    secretKey: args.recipientSecretKey,
    publicKey: X25519_BASEPOINT,
  })
  if (recipientPublicKey === null) {
    return cryptoErr('key_missing', 'the recipient secret key was refused (is it 32 bytes?)')
  }
  const shared = await x25519.deriveSharedSecret({
    secretKey: args.recipientSecretKey,
    publicKey: wire.value.ephemeralPublicKey,
  })
  if (shared === null) {
    // The secret key already proved well-formed one call above, so this is the
    // BLOB's ephemeral point being refused — tamper-shaped, and reported like
    // every other does-not-authenticate outcome.
    return cryptoErr(
      'aead_auth_failed',
      'the ephemeral public key on the wire was refused (malformed, or a low-order point)',
    )
  }
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (info binds both public keys) [corpus: ietf/rfc5869-hkdf]
  const wrapKey = await provider.hkdfSha256({
    ikm: shared,
    salt: HKDF_ZERO_SALT,
    info: wrapInfo(wire.value.ephemeralPublicKey, recipientPublicKey),
    length: KEY_BYTES,
  })
  if (wrapKey === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to derive the wrap key')
  }
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AAD binds context; one failure output) [corpus: ietf/rfc5116-aead]
  const dek = await provider.aeadOpen({
    key: wrapKey,
    iv: wire.value.envelope.iv,
    ciphertext: wire.value.envelope.ct,
    aad: buildAadBytes(AAD_ROLE_RECIPIENT_WRAP, [
      wire.value.ephemeralPublicKey,
      recipientPublicKey,
    ]),
  })
  if (dek === null) {
    return cryptoErr('aead_auth_failed', 'the wrapped key did not authenticate for this recipient')
  }
  return cryptoOk(dek)
}

/** Bind both providers once, at the host's composition root. */
export function createRecipientWrapPort(
  provider: CryptoProvider,
  x25519: X25519Provider,
): RecipientWrapPort {
  // SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes [corpus: libsodium/sealed-boxes]
  return {
    wrapDekFor: (args) => wrapDekFor(provider, x25519, args),
    unwrapDekWith: (args) => unwrapDekWith(provider, x25519, args),
  }
}
