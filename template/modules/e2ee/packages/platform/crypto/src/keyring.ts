import {
  AAD_ROLE_DEK,
  AAD_ROLE_ITEM,
  ALG_AES_256_GCM,
  buildAad,
  decodeEnvelope,
  ENVELOPE_VERSION,
  encodeEnvelope,
  GCM_IV_BYTES,
  type KeyContext,
} from './envelope.js'
import type { CryptoProvider } from './ports.js'
import { type CryptoResult, cryptoErr, cryptoOk } from './result.js'

// The local key hierarchy — the half of E2EE that is whole and working.
//
//   rootKey (32 CSPRNG bytes, lives in the platform keystore)
//     └─ KEK = HKDF-SHA-256(rootKey, info = "app-e2ee/v1/<purpose>")
//          └─ per-item DEK (fresh 32 CSPRNG bytes per seal)
//               ├─ item envelope   = AEAD(DEK, plaintext, AAD(item, ctx))
//               └─ wrapped-DEK env = AEAD(KEK, DEK,       AAD(dek,  ctx))
//
// A FRESH DEK PER SEAL is the load-bearing choice: no key ever encrypts twice,
// so the 96-bit random IV never meets the birthday bound that makes IV reuse
// under GCM catastrophic — the same key-never-repeats argument
// LargeSecureStore documents for its CTR mode, applied to AEAD. Wrapping the
// DEK (rather than deriving it) is what makes crypto-shredding real: deleting
// a row's wrapped-DEK column renders its ciphertext permanently unreadable
// while the root key lives on for every other row.
// SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
// (IV uniqueness per key is GCM's cardinal requirement) [corpus: nist/sp800-38d-gcm] ·
// https://www.rfc-editor.org/rfc/rfc5869 (HKDF extract-and-expand; info is the
// domain separator) [corpus: ietf/rfc5869-hkdf]

// Declared locally and narrowly — see the note beside the same declaration in
// envelope.ts: `types: []` keeps platform globals out of the shared package, so the
// few WinterCG ones it uses are declared at their use site.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const KEY_BYTES = 32
// Zero salt, constant on purpose: RFC 5869 §3.1 defines absent salt as a
// zero-filled string, and the domain separation this hierarchy needs lives in
// `info` — a per-install salt here would buy nothing and cost a second stored
// secret.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 §3.1 (absent salt = HashLen zeros) [corpus: ietf/rfc5869-hkdf]
const HKDF_ZERO_SALT = new Uint8Array(32)

export type KekPurpose = 'item-wrap'

// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (info is the domain separator) [corpus: ietf/rfc5869-hkdf]
export async function deriveKek(
  provider: CryptoProvider,
  rootKey: Uint8Array,
  purpose: KekPurpose,
): Promise<CryptoResult<Uint8Array>> {
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (extract-and-expand) [corpus: ietf/rfc5869-hkdf]
  const kek = await provider.hkdfSha256({
    ikm: rootKey,
    salt: HKDF_ZERO_SALT,
    info: new TextEncoder().encode(`app-e2ee/v${String(ENVELOPE_VERSION)}/${purpose}`),
    length: KEY_BYTES,
  })
  // A refusing engine is a NAMED refusal, not a rejected promise: these two
  // entry points returned bare values until an adversarial review pointed out
  // that neither could express failure, so any provider error escaped the
  // package as a throw — through the exact seam result.ts exists to close.
  return kek === null
    ? cryptoErr('keystore_unavailable', 'the crypto engine refused to derive a key')
    : cryptoOk(kek)
}

export interface SealedItem {
  /** The item ciphertext, enveloped. Store it in the row's `*_ciphertext` column. */
  readonly envelope: Uint8Array
  /** The item's DEK wrapped by the KEK, enveloped. Store it beside the ciphertext — deleting it IS the erase lever. */
  readonly wrappedDek: Uint8Array
}

export async function sealItem(
  provider: CryptoProvider,
  kek: Uint8Array,
  plaintext: Uint8Array,
  ctx: KeyContext,
): Promise<CryptoResult<SealedItem>> {
  const dek = provider.randomBytes(KEY_BYTES)
  const itemIv = provider.randomBytes(GCM_IV_BYTES)
  // A fresh DEK and a fresh 96-bit IV per seal — no key ever encrypts twice.
  // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf [corpus: nist/sp800-38d-gcm]
  const itemCt = await provider.aeadSeal({
    key: dek,
    iv: itemIv,
    plaintext,
    aad: buildAad(AAD_ROLE_ITEM, ctx),
  })
  if (itemCt === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to seal the item')
  }
  const wrapIv = provider.randomBytes(GCM_IV_BYTES)
  // The DEK is WRAPPED under the KEK, never derived — the crypto-shred lever.
  // SOURCE: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html [corpus: owasp/key-management]
  const wrappedCt = await provider.aeadSeal({
    key: kek,
    iv: wrapIv,
    plaintext: dek,
    aad: buildAad(AAD_ROLE_DEK, ctx),
  })
  if (wrappedCt === null) {
    // The KEK is the caller's; a refusal here is almost always a wrong-length
    // key, which the provider checks precisely so this is a reason and not a
    // silently AES-128 envelope claiming to be AES-256.
    return cryptoErr(
      'key_missing',
      'the crypto engine refused to wrap the item key (is the KEK 32 bytes?)',
    )
  }
  return cryptoOk({
    envelope: encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv: itemIv, ct: itemCt }),
    wrappedDek: encodeEnvelope({
      v: ENVELOPE_VERSION,
      alg: ALG_AES_256_GCM,
      iv: wrapIv,
      ct: wrappedCt,
    }),
  })
}

export async function openItem(
  provider: CryptoProvider,
  kek: Uint8Array,
  sealed: { envelope: Uint8Array; wrappedDek: Uint8Array },
  ctx: KeyContext,
): Promise<CryptoResult<Uint8Array>> {
  // The crypto-shred tombstone, read BEFORE the decoder so it gets its own
  // answer. A `*_wrapped_dek bytea NOT NULL` column cannot be nulled, so erasing
  // a row's key means overwriting it with zero bytes — and the decoder would
  // report that as `envelope_malformed`, which is indistinguishable from
  // corruption. A shredded row is not damaged; it is deliberately unreadable,
  // and a screen should be able to say so.
  if (sealed.wrappedDek.length === 0) {
    return cryptoErr(
      'key_missing',
      'the wrapped DEK is a zero-length tombstone — this row was crypto-shredded and no key can open it again',
    )
  }
  const wrapped = decodeEnvelope(sealed.wrappedDek)
  if (!wrapped.ok) return wrapped
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AAD binds context; one failure output) [corpus: ietf/rfc5116-aead]
  const dek = await provider.aeadOpen({
    key: kek,
    iv: wrapped.value.iv,
    ciphertext: wrapped.value.ct,
    aad: buildAad(AAD_ROLE_DEK, ctx),
  })
  if (dek === null) {
    return cryptoErr(
      'aead_auth_failed',
      'the wrapped DEK did not authenticate for this row identity',
    )
  }
  const item = decodeEnvelope(sealed.envelope)
  if (!item.ok) return item
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AAD binds context; one failure output) [corpus: ietf/rfc5116-aead]
  const plaintext = await provider.aeadOpen({
    key: dek,
    iv: item.value.iv,
    ciphertext: item.value.ct,
    aad: buildAad(AAD_ROLE_ITEM, ctx),
  })
  if (plaintext === null) {
    return cryptoErr(
      'aead_auth_failed',
      'the item ciphertext did not authenticate for this row identity',
    )
  }
  return cryptoOk(plaintext)
}

/**
 * Rotate ONE row's wrapped DEK from an old KEK to a new one: open the
 * wrapped-DEK envelope under the old KEK, re-seal the SAME DEK — fresh IV —
 * under the new. The item ciphertext is never touched and the item plaintext
 * is never seen, so a root-key rotation becomes a rewrite of ONE column per
 * row instead of an open→seal pass over every plaintext. This is exactly the
 * property the KEK/DEK split was bought for: rotating the outer key must not
 * require re-encrypting the data.
 * SOURCE: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
 * (separate KEKs from DEKs so rotating the outer key does not re-encrypt all
 * data) [corpus: owasp/key-management]
 *
 * What this deliberately is NOT: an orchestrator. Batching rows, resuming an
 * interrupted pass, recording progress, and serving a table that is
 * temporarily in two KEK eras are the CONSUMER's — this function is the one
 * cryptographic step, kept primitive so the orchestration above it stays an
 * ordinary reviewed data migration rather than crypto code.
 */
export async function rewrapItemKey(
  provider: CryptoProvider,
  oldKek: Uint8Array,
  newKek: Uint8Array,
  wrappedDek: Uint8Array,
  ctx: KeyContext,
): Promise<CryptoResult<Uint8Array>> {
  // The crypto-shred tombstone, read before the decoder for the same reason
  // openItem reads it: a shredded row is deliberately unreadable, not damaged,
  // and a rotation pass that meets one must SKIP it, never "repair" it.
  if (wrappedDek.length === 0) {
    return cryptoErr(
      'key_missing',
      'the wrapped DEK is a zero-length tombstone — this row was crypto-shredded and cannot be rewrapped',
    )
  }
  const wrapped = decodeEnvelope(wrappedDek)
  if (!wrapped.ok) return wrapped
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AAD binds context; one failure output) [corpus: ietf/rfc5116-aead]
  const dek = await provider.aeadOpen({
    key: oldKek,
    iv: wrapped.value.iv,
    ciphertext: wrapped.value.ct,
    aad: buildAad(AAD_ROLE_DEK, ctx),
  })
  if (dek === null) {
    return cryptoErr(
      'aead_auth_failed',
      'the wrapped DEK did not authenticate under the old KEK for this row identity',
    )
  }
  // Fresh IV, same AAD role and identity: the rewrapped column still binds the
  // SAME row, so a rewrap is invisible to openItem except through the new KEK.
  const iv = provider.randomBytes(GCM_IV_BYTES)
  // SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (fresh iv per seal) [corpus: nist/sp800-38d-gcm]
  const rewrapped = await provider.aeadSeal({
    key: newKek,
    iv,
    plaintext: dek,
    aad: buildAad(AAD_ROLE_DEK, ctx),
  })
  if (rewrapped === null) {
    return cryptoErr(
      'key_missing',
      'the crypto engine refused to rewrap the item key (is the new KEK 32 bytes?)',
    )
  }
  return cryptoOk(encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct: rewrapped }))
}
