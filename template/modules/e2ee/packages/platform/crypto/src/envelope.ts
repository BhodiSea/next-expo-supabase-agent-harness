import { type CryptoResult, cryptoErr, cryptoOk } from './result.js'

// The ONE ciphertext container. Every sealed byte-string this package produces
// — item ciphertexts and wrapped DEKs alike — is an envelope, so there is
// exactly one place algorithm agility lives and one decoder that can refuse.
//
// Layout, byte by byte:  magic u16 BE | v u8 | alg u8 | ivLen u8 | iv | ct
// The GCM tag rides INSIDE ct (ciphertext ‖ 16-byte tag — the AEAD interface's
// own framing), so the envelope never re-frames what the primitive already
// authenticates. The version byte is what makes a future format change a
// DECODE branch instead of a fleet migration; alg 0x02 is RESERVED for
// XChaCha20-Poly1305 and deliberately not implemented — a reserved id that
// decodes to `unsupported_algorithm` today is algorithm agility with no
// dead code behind it.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AEAD: ciphertext carries the
// tag) [corpus: ietf/rfc5116-aead] · https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
// (96-bit IV recommendation) [corpus: nist/sp800-38d-gcm]

export const ENVELOPE_MAGIC = 0xa7e1
export const ENVELOPE_VERSION = 1
export const ALG_AES_256_GCM = 0x01
/** Reserved, never implemented here — decodes to `unsupported_algorithm`. */
export const ALG_RESERVED_XCHACHA20 = 0x02
export const GCM_IV_BYTES = 12

export type AeadAlgId = typeof ALG_AES_256_GCM

export interface Envelope {
  readonly v: typeof ENVELOPE_VERSION
  readonly alg: AeadAlgId
  readonly iv: Uint8Array
  readonly ct: Uint8Array
}

const HEADER_BYTES = 5

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + envelope.iv.length + envelope.ct.length)
  out[0] = ENVELOPE_MAGIC >> 8
  out[1] = ENVELOPE_MAGIC & 0xff
  out[2] = envelope.v
  out[3] = envelope.alg
  out[4] = envelope.iv.length
  out.set(envelope.iv, HEADER_BYTES)
  out.set(envelope.ct, HEADER_BYTES + envelope.iv.length)
  return out
}

export function decodeEnvelope(bytes: Uint8Array): CryptoResult<Envelope> {
  if (bytes.length < HEADER_BYTES) {
    return cryptoErr('envelope_malformed', `${String(bytes.length)} bytes is shorter than the header`)
  }
  if (((bytes[0] << 8) | bytes[1]) !== ENVELOPE_MAGIC) {
    return cryptoErr('envelope_malformed', 'bad magic — not an envelope this package produced')
  }
  const v = bytes[2]
  if (v !== ENVELOPE_VERSION) {
    return cryptoErr('unsupported_version', `envelope version ${String(v)}`)
  }
  const alg = bytes[3]
  if (alg !== ALG_AES_256_GCM) {
    return cryptoErr('unsupported_algorithm', `alg id 0x${alg.toString(16).padStart(2, '0')}`)
  }
  const ivLen = bytes[4]
  if (ivLen !== GCM_IV_BYTES) {
    return cryptoErr('envelope_malformed', `iv length ${String(ivLen)} (AES-256-GCM envelopes carry a 12-byte iv)`)
  }
  if (bytes.length < HEADER_BYTES + ivLen) {
    return cryptoErr('envelope_malformed', 'truncated inside the iv')
  }
  const iv = bytes.slice(HEADER_BYTES, HEADER_BYTES + ivLen)
  const ct = bytes.slice(HEADER_BYTES + ivLen)
  if (ct.length < 16) {
    return cryptoErr('envelope_malformed', 'ciphertext shorter than the GCM tag')
  }
  return cryptoOk({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct })
}

// ── AAD: the envelope's binding to WHERE the ciphertext lives ──────────────────
// Associated data is what makes a ciphertext moved to another row, another
// table, or another user FAIL AUTHENTICATION instead of decrypting in the
// wrong place — confidentiality alone does not stop a copy-paste attack
// inside the same key's reach. The AAD binds: version byte, alg byte, a ROLE
// byte (an item ciphertext and a wrapped DEK must never authenticate in each
// other's slot), and the row identity as NUL-separated UTF-8 — NUL because a
// join character that can appear inside a field ('/' can appear in an id)
// would make two different identities encode identically.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5116 §2.1 (associated data binds
// context) [corpus: ietf/rfc5116-aead]

export interface KeyContext {
  readonly userId: string
  readonly table: string
  readonly itemId: string
}

export const AAD_ROLE_ITEM = 0x00
export const AAD_ROLE_DEK = 0x01

export function buildAad(role: typeof AAD_ROLE_ITEM | typeof AAD_ROLE_DEK, ctx: KeyContext): Uint8Array {
  const identity = new TextEncoder().encode(`${ctx.userId}\u0000${ctx.table}\u0000${ctx.itemId}`)
  const out = new Uint8Array(3 + identity.length)
  out[0] = ENVELOPE_VERSION
  out[1] = ALG_AES_256_GCM
  out[2] = role
  out.set(identity, 3)
  return out
}
