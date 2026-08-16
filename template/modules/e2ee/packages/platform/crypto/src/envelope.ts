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
    return cryptoErr(
      'envelope_malformed',
      `${String(bytes.length)} bytes is shorter than the header`,
    )
  }
  // The header bytes are read through `.at() ?? 0` rather than `bytes[i]`: the length
  // guard above proves all five exist, but noUncheckedIndexedAccess types every index
  // read as `number | undefined` and reaching for `!` to silence that is the habit the
  // torvalds rubric names. The fallback is unreachable, and harmless if it ever were
  // not — a zero magic, version or alg byte is refused by the very next branch.
  if ((((bytes.at(0) ?? 0) << 8) | (bytes.at(1) ?? 0)) !== ENVELOPE_MAGIC) {
    return cryptoErr('envelope_malformed', 'bad magic — not an envelope this package produced')
  }
  const v = bytes.at(2) ?? 0
  if (v !== ENVELOPE_VERSION) {
    return cryptoErr('unsupported_version', `envelope version ${String(v)}`)
  }
  const alg = bytes.at(3) ?? 0
  if (alg !== ALG_AES_256_GCM) {
    return cryptoErr('unsupported_algorithm', `alg id 0x${alg.toString(16).padStart(2, '0')}`)
  }
  const ivLen = bytes.at(4) ?? 0
  if (ivLen !== GCM_IV_BYTES) {
    // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (96-bit iv) [corpus: nist/sp800-38d-gcm]
    return cryptoErr(
      'envelope_malformed',
      `iv length ${String(ivLen)} (AES-256-GCM envelopes carry a 12-byte iv)`,
    )
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
// byte (five roles, 0x00–0x04 — an item ciphertext, a wrapped DEK, a
// recipient-wrapped DEK, a recovery escrow and a device-sync payload must
// never authenticate in each other's slots), and then the identity the role
// truly has — for a row, user, table, item and FIELD — each length-prefixed,
// so no field's own content can be mistaken for a boundary.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5116 §2.1 (associated data binds
// context) [corpus: ietf/rfc5116-aead]

export interface KeyContext {
  readonly userId: string
  readonly table: string
  readonly itemId: string
  /**
   * The COLUMN this ciphertext belongs to. Load-bearing, and added after an
   * adversarial review demonstrated the gap: a row with two encrypted columns
   * sealed both under the same {userId, table, itemId}, so their AADs were
   * byte-identical and a database operator could copy `title` into `body` and
   * have the client render it as authentic. This field is what makes "a moved
   * ciphertext fails authentication" true for a move WITHIN a row, not only
   * across rows.
   */
  readonly field: string
}

export const AAD_ROLE_ITEM = 0x00
export const AAD_ROLE_DEK = 0x01
/** A DEK sealed to another principal's X25519 public key (recipient-wrap.ts). */
export const AAD_ROLE_RECIPIENT_WRAP = 0x02
/** A root key escrowed under a recovery-code-derived key (recovery.ts). */
export const AAD_ROLE_RECOVERY = 0x03
/** A root key in transit to a second device under a channel key (device-sync.ts). */
export const AAD_ROLE_DEVICE_SYNC = 0x04

// Declared locally and narrowly, the same call webcrypto-provider.ts makes about
// `crypto` and @app/ratelimit makes about `fetch`: the package sets `types: []` so a
// shared module cannot reach for a DOM or Node global by accident, which means the
// handful it DOES use are declared where they are used. TextEncoder is WinterCG — Node
// 22, every browser, and Hermes — and UTF-8 is the only encoding it produces, which is
// what makes the AAD bytes identical on every surface that opens a ciphertext.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

export function buildAad(
  role: typeof AAD_ROLE_ITEM | typeof AAD_ROLE_DEK,
  ctx: KeyContext,
): Uint8Array {
  // LENGTH-PREFIXED, not separator-joined. A NUL separator is injective only
  // while no field can CONTAIN a NUL — and an adversarial review demonstrated
  // both halves of that failing: an embedded NUL re-split the identity (u1 /
  // 'notes' / 'a<NUL>b' collided with u1 / 'notes<NUL>a' / 'b'), and TextEncoder maps
  // every unpaired surrogate to the same U+FFFD, so distinct itemIds collided
  // too. A 4-byte big-endian length before each field removes every collision
  // the FRAMING can cause, which is what this section already claimed. It does
  // not remove the one the ENCODING causes: UTF-8 has no representation for an
  // unpaired surrogate, so TextEncoder emits U+FFFD and a lone surrogate is
  // indistinguishable from a literal replacement character. That residual is
  // asserted in envelope.test.ts rather than left as a footnote, and it is why
  // itemId should be built from real column values (a UUID primary key is
  // unaffected) rather than from anything user-supplied.
  const enc = new TextEncoder()
  const parts = [ctx.userId, ctx.table, ctx.itemId, ctx.field].map((f) => enc.encode(f))
  const out = new Uint8Array(3 + parts.reduce((n, part) => n + 4 + part.length, 0))
  out[0] = ENVELOPE_VERSION
  out[1] = ALG_AES_256_GCM
  out[2] = role
  let at = 3
  for (const part of parts) {
    out[at] = (part.length >>> 24) & 0xff
    out[at + 1] = (part.length >>> 16) & 0xff
    out[at + 2] = (part.length >>> 8) & 0xff
    out[at + 3] = part.length & 0xff
    out.set(part, at + 4)
    at += 4 + part.length
  }
  return out
}

/** The roles whose AAD binds BYTE-shaped identity fields, not a row's KeyContext. */
export type ByteAadRole =
  | typeof AAD_ROLE_RECIPIENT_WRAP
  | typeof AAD_ROLE_RECOVERY
  | typeof AAD_ROLE_DEVICE_SYNC

// A SECOND builder beside buildAad, not an overload of it — deliberately. The
// string builder's four-field KeyContext IS its contract: role 0x00/0x01 binds
// a row identity, always all four fields, and a signature that also accepted
// "any byte fields" would let a call site bind a partial identity by accident.
// The roles above bind identities that are not rows at all — curve points
// (recipient wrap), a user id (recovery escrow, device sync) — and some of
// them (an X25519 public key) are bytes with no string form, so encoding them
// through TextEncoder would corrupt them. Same prefix, same framing: the two
// builders emit version | alg | role and then 4-byte-BE length-prefixed
// fields, so cross-role separation rests on the role byte alone and the
// length-prefix injectivity argument holds for byte fields exactly as it does
// for encoded strings.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5116 §2.1 (associated data binds
// context) [corpus: ietf/rfc5116-aead]
export function buildAadBytes(role: ByteAadRole, fields: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(3 + fields.reduce((n, field) => n + 4 + field.length, 0))
  out[0] = ENVELOPE_VERSION
  out[1] = ALG_AES_256_GCM
  out[2] = role
  let at = 3
  for (const field of fields) {
    out[at] = (field.length >>> 24) & 0xff
    out[at + 1] = (field.length >>> 16) & 0xff
    out[at + 2] = (field.length >>> 8) & 0xff
    out[at + 3] = field.length & 0xff
    out.set(field, at + 4)
    at += 4 + field.length
  }
  return out
}
