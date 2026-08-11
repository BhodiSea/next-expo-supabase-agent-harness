// @app/crypto — THE METRO-SAFE BARREL. Pure logic over injected primitives:
// the result vocabulary, the envelope codec, the keyring, and the ports —
// nothing here touches a runtime global, so Metro may carry all of it. The
// WebCrypto provider lives on the `.` barrel ONLY (Hermes ships no Web
// Crypto); the census entry in tools/exports-walls.json records exactly that
// reason.
export {
  type CryptoFailureReason,
  type CryptoResult,
  cryptoErr,
  cryptoOk,
} from './result.js'
export {
  AAD_ROLE_DEK,
  AAD_ROLE_ITEM,
  ALG_AES_256_GCM,
  ALG_RESERVED_XCHACHA20,
  type AeadAlgId,
  buildAad,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  GCM_IV_BYTES,
  type KeyContext,
} from './envelope.js'
export {
  deriveKek,
  type KekPurpose,
  openItem,
  type SealedItem,
  sealItem,
} from './keyring.js'
export type { CryptoProvider, KeystoreAdapter } from './ports.js'
export type { DeviceSyncPort, RecipientWrapPort, RecoveryPort } from './ports-declared.js'
