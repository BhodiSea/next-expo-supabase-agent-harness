import {
  AAD_ROLE_RECOVERY,
  ALG_AES_256_GCM,
  buildAadBytes,
  decodeEnvelope,
  ENVELOPE_VERSION,
  encodeEnvelope,
  GCM_IV_BYTES,
} from './envelope.js'
import type { CryptoProvider } from './ports.js'
import { type CryptoResult, cryptoErr, cryptoOk } from './result.js'

// Recovering the root key when the device is gone — built on a GENERATED
// high-entropy recovery code, NOT a passphrase, and that word choice is the
// whole design. 32 CSPRNG bytes shown to the user exactly once (the
// invitations.token_digest precedent one layer down: create_invitation returns
// the plaintext token exactly once and stores only its digest —
// supabase/migrations/20260201000000_tenancy_spine.sql), then escrowed as an
// AEAD envelope the server can store but never open.
//
// THE PASSPHRASE REFUSAL SURVIVES: a human-chosen passphrase has guessable
// entropy, so deriving a key from one demands a memory-hard KDF — Argon2id —
// and WebCrypto ships none. Shipping PBKDF2 while calling it "the KDF" would
// be a dishonest default (it has no memory hardness, and a GPU farm treats it
// as a speed bump), so passphrase-derived escrow stays a CONSUMER decision,
// priced like the mobile provider prices its dependency: @noble/hashes or a
// native argon2, wired against these same envelope and AAD rules. A GENERATED
// 256-bit code needs none of that — there is nothing to brute-force better
// than the key itself, so plain HKDF-SHA-256 is the honest derivation.
// SOURCE: https://www.rfc-editor.org/rfc/rfc9106 (Argon2id for
// human-chosen secrets; PBKDF2 is not a substitute) [corpus: ietf/rfc9106-argon2]

// Declared locally and narrowly — see the note beside the same declaration in
// envelope.ts: `types: []` keeps platform globals out of the shared package.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const KEY_BYTES = 32
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 §3.1 (absent salt = HashLen zeros) [corpus: ietf/rfc5869-hkdf]
const HKDF_ZERO_SALT = new Uint8Array(32)

// Crockford base32 for the DISPLAY encoding: no I, L, O or U, so the alphabet
// survives handwriting and read-aloud (1/I/L and 0/O collapse to one symbol on
// decode), and 32 bytes render as 52 characters instead of base64's
// shift-key-riddled 44. Grouped 4 chars × 13 with dashes — the shape of a
// thing to be transcribed, not remembered.
// SOURCE: https://www.crockford.com/base32.html [corpus: crockford/base32]
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 52 // ceil(256 / 5) — 32 bytes in 5-bit symbols
const CODE_GROUP = 4

/**
 * The recovery contract a consumer depends on — beside its implementation,
 * where the old ports-declared.ts declaration used to point. A host builds one
 * with createRecoveryPort at its composition root.
 */
export interface RecoveryPort {
  generateRecoveryCode(): string
  deriveRecoveryKey(code: string): Promise<CryptoResult<Uint8Array>>
  escrowRootKey(args: {
    rootKey: Uint8Array
    recoveryKey: Uint8Array
    userId: string
  }): Promise<CryptoResult<Uint8Array>>
  recoverRootKey(args: {
    escrowed: Uint8Array
    recoveryKey: Uint8Array
    userId: string
  }): Promise<CryptoResult<Uint8Array>>
}

const encodeCrockford = (bytes: Uint8Array): string => {
  let acc = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) >>> 0
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD.charAt((acc >>> bits) & 31)
    }
  }
  // The final symbol carries the last bit of data left-aligned over zero
  // padding — the padding the decoder below VERIFIES is zero, so a mangled
  // last character is a decode refusal rather than a silently different key.
  if (bits > 0) out += CROCKFORD.charAt((acc << (5 - bits)) & 31)
  return out
}

const decodeCrockford = (code: string): CryptoResult<Uint8Array> => {
  // Crockford's own error tolerance: case-insensitive, I/L read as 1, O as 0,
  // and the dashes/spaces a human adds while transcribing are ignored. Every
  // OTHER deviation refuses — this decodes a code this package generated, so
  // anything the normalization cannot explain is a typo the user can fix.
  const normalized = code
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (normalized.length !== CODE_CHARS) {
    return cryptoErr(
      'recovery_code_malformed',
      `${String(normalized.length)} symbols after normalization — a recovery code has ${String(CODE_CHARS)}`,
    )
  }
  const out = new Uint8Array(KEY_BYTES)
  let acc = 0
  let bits = 0
  let at = 0
  for (const char of normalized) {
    const index = CROCKFORD.indexOf(char)
    if (index === -1) {
      return cryptoErr('recovery_code_malformed', `'${char}' is not a Crockford base32 symbol`)
    }
    acc = ((acc << 5) | index) >>> 0
    bits += 5
    if (bits >= 8 && at < KEY_BYTES) {
      bits -= 8
      out[at] = (acc >>> bits) & 0xff
      at += 1
    }
  }
  // 52 symbols carry 260 bits; the last 4 are padding and must be zero — a
  // nonzero pad is a corrupted final character, not a different code.
  if ((acc & ((1 << bits) - 1)) !== 0) {
    return cryptoErr('recovery_code_malformed', 'nonzero padding bits in the final symbol')
  }
  return cryptoOk(out)
}

/**
 * Mint a recovery code: 32 bytes from the platform CSPRNG, displayed as 13
 * dash-separated groups of 4 Crockford symbols. SHOW IT ONCE and never store
 * it — the server keeps only the escrow envelope, which the code-derived key
 * alone can open. A user who loses the device AND the code has lost the data;
 * that residual is the README's, stated rather than softened.
 */
export const generateRecoveryCode = (provider: CryptoProvider): string => {
  const raw = encodeCrockford(provider.randomBytes(KEY_BYTES))
  const groups: string[] = []
  for (let at = 0; at < raw.length; at += CODE_GROUP) groups.push(raw.slice(at, at + CODE_GROUP))
  return groups.join('-')
}

/**
 * The code-derived escrow key: plain HKDF-SHA-256, and PLAIN IS THE POINT —
 * the input is 256 bits of CSPRNG output, so there is no dictionary to walk
 * and memory hardness would buy nothing but latency. (A human-CHOSEN secret
 * must never take this path; see the Argon2id refusal in the header.)
 */
export async function deriveRecoveryKey(
  provider: CryptoProvider,
  code: string,
): Promise<CryptoResult<Uint8Array>> {
  const bytes = decodeCrockford(code)
  if (!bytes.ok) return bytes
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (full-entropy ikm; info is the domain separator) [corpus: ietf/rfc5869-hkdf]
  const recoveryKey = await provider.hkdfSha256({
    ikm: bytes.value,
    salt: HKDF_ZERO_SALT,
    info: new TextEncoder().encode(`app-e2ee/v${String(ENVELOPE_VERSION)}/recovery`),
    length: KEY_BYTES,
  })
  return recoveryKey === null
    ? cryptoErr('keystore_unavailable', 'the crypto engine refused to derive the recovery key')
    : cryptoOk(recoveryKey)
}

/**
 * Seal the root key under the recovery key. The AAD binds role 0x03 and the
 * ACCOUNT — the one identity this ceremony truly has (an escrow belongs to a
 * user, not to a row) — as a length-prefixed UTF-8 field. An escrow blob moved
 * to another user's account row therefore FAILS AUTHENTICATION even for a
 * caller who somehow holds the right code, and a blob presented in any other
 * role's slot is refused by the role byte alone.
 */
export async function escrowRootKey(
  provider: CryptoProvider,
  args: { rootKey: Uint8Array; recoveryKey: Uint8Array; userId: string },
): Promise<CryptoResult<Uint8Array>> {
  const iv = provider.randomBytes(GCM_IV_BYTES)
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 §2.1 (AAD binds the account) [corpus: ietf/rfc5116-aead]
  const ct = await provider.aeadSeal({
    key: args.recoveryKey,
    iv,
    plaintext: args.rootKey,
    aad: buildAadBytes(AAD_ROLE_RECOVERY, [new TextEncoder().encode(args.userId)]),
  })
  if (ct === null) {
    return cryptoErr(
      'key_missing',
      'the crypto engine refused to escrow the root key (is the recovery key 32 bytes?)',
    )
  }
  return cryptoOk(encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct }))
}

/** Open an escrow envelope back into the root key — the recovery half. */
export async function recoverRootKey(
  provider: CryptoProvider,
  args: { escrowed: Uint8Array; recoveryKey: Uint8Array; userId: string },
): Promise<CryptoResult<Uint8Array>> {
  const envelope = decodeEnvelope(args.escrowed)
  if (!envelope.ok) return envelope
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AAD binds context; one failure output) [corpus: ietf/rfc5116-aead]
  const rootKey = await provider.aeadOpen({
    key: args.recoveryKey,
    iv: envelope.value.iv,
    ciphertext: envelope.value.ct,
    aad: buildAadBytes(AAD_ROLE_RECOVERY, [new TextEncoder().encode(args.userId)]),
  })
  if (rootKey === null) {
    return cryptoErr(
      'aead_auth_failed',
      'the escrow did not authenticate for this account (wrong code, or a moved escrow)',
    )
  }
  return cryptoOk(rootKey)
}

/** Bind the provider once, at the host's composition root. */
export function createRecoveryPort(provider: CryptoProvider): RecoveryPort {
  return {
    generateRecoveryCode: () => generateRecoveryCode(provider),
    deriveRecoveryKey: (code) => deriveRecoveryKey(provider, code),
    escrowRootKey: (args) => escrowRootKey(provider, args),
    recoverRootKey: (args) => recoverRootKey(provider, args),
  }
}
