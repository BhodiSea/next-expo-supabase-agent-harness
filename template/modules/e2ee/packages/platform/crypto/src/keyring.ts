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
const HKDF_ZERO_SALT = new Uint8Array(32)

export type KekPurpose = 'item-wrap'

export async function deriveKek(
  provider: CryptoProvider,
  rootKey: Uint8Array,
  purpose: KekPurpose,
): Promise<Uint8Array> {
  return provider.hkdfSha256({
    ikm: rootKey,
    salt: HKDF_ZERO_SALT,
    info: new TextEncoder().encode(`app-e2ee/v${String(ENVELOPE_VERSION)}/${purpose}`),
    length: KEY_BYTES,
  })
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
): Promise<SealedItem> {
  const dek = provider.randomBytes(KEY_BYTES)
  const itemIv = provider.randomBytes(GCM_IV_BYTES)
  const itemCt = await provider.aeadSeal({
    key: dek,
    iv: itemIv,
    plaintext,
    aad: buildAad(AAD_ROLE_ITEM, ctx),
  })
  const wrapIv = provider.randomBytes(GCM_IV_BYTES)
  const wrappedCt = await provider.aeadSeal({
    key: kek,
    iv: wrapIv,
    plaintext: dek,
    aad: buildAad(AAD_ROLE_DEK, ctx),
  })
  return {
    envelope: encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv: itemIv, ct: itemCt }),
    wrappedDek: encodeEnvelope({
      v: ENVELOPE_VERSION,
      alg: ALG_AES_256_GCM,
      iv: wrapIv,
      ct: wrappedCt,
    }),
  }
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
