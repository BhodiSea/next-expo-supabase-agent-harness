// @app/crypto — THE METRO-SAFE BARREL. Pure logic over injected primitives:
// the result vocabulary, the envelope codec, the keyring, the three seams
// (recipient wrap, recovery, device sync), and the ports — nothing here
// touches a runtime global, so Metro may carry all of it. The two WebCrypto
// factories live on the `.` barrel ONLY (Hermes ships no Web Crypto); the
// census entry in tools/exports-walls.json records exactly that reason.

export {
  createDeviceSyncPort,
  type DeviceSyncPort,
  exportForDevice,
  importFromDevice,
} from './device-sync.js'
export {
  AAD_ROLE_DEK,
  AAD_ROLE_DEVICE_SYNC,
  AAD_ROLE_ITEM,
  AAD_ROLE_RECIPIENT_WRAP,
  AAD_ROLE_RECOVERY,
  type AeadAlgId,
  ALG_AES_256_GCM,
  ALG_RESERVED_XCHACHA20,
  type ByteAadRole,
  buildAad,
  buildAadBytes,
  decodeEnvelope,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  type Envelope,
  encodeEnvelope,
  GCM_IV_BYTES,
  type KeyContext,
} from './envelope.js'
// The keyring: rootKey → KEK (HKDF) → per-item DEK, wrapped not derived.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5869 [corpus: ietf/rfc5869-hkdf]
export {
  deriveKek,
  type KekPurpose,
  openItem,
  rewrapItemKey,
  type SealedItem,
  sealItem,
} from './keyring.js'
export type {
  CryptoProvider,
  KeystoreAdapter,
  X25519KeyPair,
  X25519Provider,
} from './ports.js'
export {
  createRecipientWrapPort,
  RECIPIENT_WIRE_VERSION,
  type RecipientWrapPort,
  // SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes [corpus: libsodium/sealed-boxes]
  unwrapDekWith,
  wrapDekFor,
} from './recipient-wrap.js'
export {
  createRecoveryPort,
  deriveRecoveryKey,
  escrowRootKey,
  generateRecoveryCode,
  type RecoveryPort,
  recoverRootKey,
} from './recovery.js'
export {
  type CryptoFailureReason,
  type CryptoResult,
  cryptoErr,
  cryptoOk,
} from './result.js'
