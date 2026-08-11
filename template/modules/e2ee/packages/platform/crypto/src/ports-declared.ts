// DECLARED, NOT SOLVED — on purpose, and in writing.
//
// Each port below names a problem true E2EE eventually meets and this release
// deliberately does not ship an implementation for. Declaring the port now is
// what keeps a future implementation from inventing a second envelope or a
// second keyring; refusing to fake an implementation is what keeps the module
// honest (a recovery story that does not actually recover is worse than the
// stated loss). The full statement of what is NOT solved — and what that costs
// a user — is docs/modules/e2ee/README.md, "What this deliberately does NOT
// solve"; the obligations register row `e2ee-declared-ports-unimplemented`
// anchors these declarations so they cannot quietly become claims.

/**
 * Wrapping a DEK to ANOTHER principal's public key — the org-sharing seam
 * (X25519 sealed-box shaped; see the README section). UNIMPLEMENTED: without
 * it, encrypted data is single-principal — an org-mate's RLS-visible row is
 * ciphertext they cannot open, and that is the stated behaviour, not a bug.
 * SOURCE: https://doc.libsodium.org/public-key_cryptography/sealed_boxes [corpus: libsodium/sealed-boxes]
 */
export interface RecipientWrapPort {
  wrapDekFor(args: {
    dek: Uint8Array
    recipientPublicKey: Uint8Array
  }): Promise<Uint8Array>
  unwrapDekWith(args: {
    wrapped: Uint8Array
    recipientSecretKey: Uint8Array
  }): Promise<Uint8Array | null>
}

/**
 * Recovering the root key when the device is gone (passphrase-derived escrow,
 * Argon2id-shaped — see the README section). UNIMPLEMENTED, and the loss is
 * stated in exactly these words: a lost device is lost data. WebCrypto ships
 * no Argon2, and shipping PBKDF2 while calling it "the KDF" would be the
 * dishonest default this port exists to refuse.
 * SOURCE: https://www.rfc-editor.org/rfc/rfc9106 (Argon2) [corpus: ietf/rfc9106-argon2]
 */
export interface RecoveryPort {
  deriveRecoveryKey(args: { passphrase: Uint8Array; salt: Uint8Array }): Promise<Uint8Array>
  escrowRootKey(args: { rootKey: Uint8Array; recoveryKey: Uint8Array }): Promise<Uint8Array>
  recoverRootKey(args: {
    escrowed: Uint8Array
    recoveryKey: Uint8Array
  }): Promise<Uint8Array | null>
}

/**
 * Carrying the root key to a SECOND device. UNIMPLEMENTED: a second sign-in
 * has no path to the key, sees ciphertext, and that is the stated behaviour.
 * The honest shapes (QR handoff, recovery-escrow replay) both depend on ports
 * above, which is why this one is last.
 */
export interface DeviceSyncPort {
  exportForDevice(args: {
    rootKey: Uint8Array
    channelKey: Uint8Array
  }): Promise<Uint8Array>
  importFromDevice(args: {
    payload: Uint8Array
    channelKey: Uint8Array
  }): Promise<Uint8Array | null>
}
