// The package's whole failure vocabulary, closed on purpose. Crypto code that
// throws turns "this ciphertext is not yours" into a stack trace a screen
// renders as a crash; crypto code that returns a broad string invites callers
// to match on prose. Every refusal this package can produce is a named reason,
// and mapping a reason onto the app's error taxonomy (@app/errors) happens at
// the DAL — the same caller's-decision split as @app/ratelimit.
//
// `aead_auth_failed` deliberately covers BOTH tamper and wrong-key: an AEAD
// cannot tell them apart, and a vocabulary that pretended to would be lying.
// SOURCE: https://www.rfc-editor.org/rfc/rfc5116 (authenticated decryption has
// exactly one failure output) [corpus: ietf/rfc5116-aead]

export type CryptoFailureReason =
  | 'aead_auth_failed'
  | 'envelope_malformed'
  | 'unsupported_version'
  | 'unsupported_algorithm'
  | 'key_missing'
  | 'keystore_unavailable'

export type CryptoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CryptoFailureReason; readonly detail?: string }

export const cryptoOk = <T>(value: T): CryptoResult<T> => ({ ok: true, value })

export const cryptoErr = (reason: CryptoFailureReason, detail?: string): CryptoResult<never> =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
