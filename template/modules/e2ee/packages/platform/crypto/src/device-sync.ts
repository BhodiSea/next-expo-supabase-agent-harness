import {
  AAD_ROLE_DEVICE_SYNC,
  ALG_AES_256_GCM,
  buildAadBytes,
  decodeEnvelope,
  ENVELOPE_VERSION,
  encodeEnvelope,
  GCM_IV_BYTES,
} from './envelope.js'
import type { CryptoProvider } from './ports.js'
import { type CryptoResult, cryptoErr, cryptoOk } from './result.js'

// Carrying the root key to a SECOND device: seal it under a key derived from a
// CHANNEL KEY the two devices already share, move the envelope over any
// transport (the server included — it cannot open it), open it on the other
// side. This file is deliberately ONLY the cryptography. The ceremony that
// puts the same channel key on both devices — a QR code the new device scans,
// a numeric comparison the user confirms, a BLE handshake — is the CONSUMER's,
// because it is a UX and threat-model decision (who can see the screen? who
// types the digits?) that no shared package should default. The honest
// division: this seam guarantees the payload opens only with the channel key;
// the ceremony decides who can have that key.
//
// The channel key is HKDF-stretched rather than used raw so a ceremony that
// produces lower-entropy material (a short numeric code) still meets a
// 32-byte AES key — but entropy in means entropy out: a 6-digit channel code
// is brute-forceable by anyone who captures the payload, and the ceremony doc
// a consumer writes must say which side of that line it stands on.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (extract-and-expand; info is
// the domain separator) [corpus: ietf/rfc5869-hkdf]

// Declared locally and narrowly — see the note beside the same declaration in
// envelope.ts: `types: []` keeps platform globals out of the shared package.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const KEY_BYTES = 32
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 §3.1 (absent salt = HashLen zeros) [corpus: ietf/rfc5869-hkdf]
const HKDF_ZERO_SALT = new Uint8Array(32)

/**
 * The device-sync contract a consumer depends on — beside its implementation,
 * where the old ports-declared.ts declaration used to point. A host builds one
 * with createDeviceSyncPort at its composition root.
 */
export interface DeviceSyncPort {
  exportForDevice(args: {
    rootKey: Uint8Array
    channelKey: Uint8Array
    userId: string
  }): Promise<CryptoResult<Uint8Array>>
  importFromDevice(args: {
    payload: Uint8Array
    channelKey: Uint8Array
    userId: string
  }): Promise<CryptoResult<Uint8Array>>
}

const deriveSyncKey = async (
  provider: CryptoProvider,
  channelKey: Uint8Array,
): Promise<Uint8Array | null> =>
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5869 (info is the domain separator) [corpus: ietf/rfc5869-hkdf]
  provider.hkdfSha256({
    ikm: channelKey,
    salt: HKDF_ZERO_SALT,
    info: new TextEncoder().encode(`app-e2ee/v${String(ENVELOPE_VERSION)}/device-sync`),
    length: KEY_BYTES,
  })

/**
 * Seal the root key for transit. The AAD binds role 0x04 and the ACCOUNT as a
 * length-prefixed UTF-8 field — the one identity both ends of the ceremony
 * share before the key moves — so a payload exported for user A refuses to
 * import into user B's session even over the same channel key, and a payload
 * presented in any other role's slot (an escrow, a wrapped DEK) is refused by
 * the role byte alone.
 */
export async function exportForDevice(
  provider: CryptoProvider,
  args: { rootKey: Uint8Array; channelKey: Uint8Array; userId: string },
): Promise<CryptoResult<Uint8Array>> {
  const syncKey = await deriveSyncKey(provider, args.channelKey)
  if (syncKey === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to derive the sync key')
  }
  const iv = provider.randomBytes(GCM_IV_BYTES)
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 §2.1 (AAD binds the account) [corpus: ietf/rfc5116-aead]
  const ct = await provider.aeadSeal({
    key: syncKey,
    iv,
    plaintext: args.rootKey,
    aad: buildAadBytes(AAD_ROLE_DEVICE_SYNC, [new TextEncoder().encode(args.userId)]),
  })
  if (ct === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to seal the sync payload')
  }
  return cryptoOk(encodeEnvelope({ v: ENVELOPE_VERSION, alg: ALG_AES_256_GCM, iv, ct }))
}

/** Open a sync payload on the receiving device — the import half. */
export async function importFromDevice(
  provider: CryptoProvider,
  args: { payload: Uint8Array; channelKey: Uint8Array; userId: string },
): Promise<CryptoResult<Uint8Array>> {
  const envelope = decodeEnvelope(args.payload)
  if (!envelope.ok) return envelope
  const syncKey = await deriveSyncKey(provider, args.channelKey)
  if (syncKey === null) {
    return cryptoErr('keystore_unavailable', 'the crypto engine refused to derive the sync key')
  }
  // SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (AAD binds context; one failure output) [corpus: ietf/rfc5116-aead]
  const rootKey = await provider.aeadOpen({
    key: syncKey,
    iv: envelope.value.iv,
    ciphertext: envelope.value.ct,
    aad: buildAadBytes(AAD_ROLE_DEVICE_SYNC, [new TextEncoder().encode(args.userId)]),
  })
  if (rootKey === null) {
    return cryptoErr(
      'aead_auth_failed',
      'the sync payload did not authenticate for this account (wrong channel key, or a moved payload)',
    )
  }
  return cryptoOk(rootKey)
}

/** Bind the provider once, at the host's composition root. */
export function createDeviceSyncPort(provider: CryptoProvider): DeviceSyncPort {
  return {
    exportForDevice: (args) => exportForDevice(provider, args),
    importFromDevice: (args) => importFromDevice(provider, args),
  }
}
