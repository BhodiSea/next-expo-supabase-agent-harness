// ---------------------------------------------------------------------------
// Where a session lives, declared as an interface and NOWHERE implemented.
//
// This package deliberately ships no implementation of the interface below.
// The obvious one — `expo-secure-store` — cannot live here: it is a native
// module, and importing it would make @app/supabase unresolvable from the Next
// server, from a Node test runner, and from any future non-Expo host. The whole
// point of taking the store as a parameter is that the ONE package both
// surfaces depend on stays free of either surface's platform SDK.
// ---------------------------------------------------------------------------

/**
 * Async key/value storage for the auth session. Satisfies
 * @supabase/supabase-js's `SupportedStorage` (which accepts sync or async
 * members; this one is uniformly async so a caller never has to branch).
 *
 * ─── THE EXPECTED IMPLEMENTATION (apps/mobile) ──────────────────────────────
 * `apps/mobile/src/host/large-secure-store.ts` implements this as a
 * SPLIT store, and the split is not an optimisation — it is the only shape that
 * works:
 *
 *   · A fresh AES-256 key per stored value goes in `expo-secure-store`
 *     (iOS Keychain / Android Keystore). 32 bytes.
 *   · The CIPHERTEXT goes in `@react-native-async-storage/async-storage`,
 *     which has no practical size limit.
 *
 * Why not put the session straight in SecureStore: a Supabase session is an
 * access token plus a refresh token plus user metadata — several kilobytes of
 * JSON — and SecureStore's per-value limit is ~2 KB. Above it, Android's
 * Keystore-backed path warns and truncates. Handing it a whole session is a
 * write that silently fails or a read that returns a truncated string, and BOTH
 * present as "the user is randomly signed out", days later, on one platform
 * only. The refresh token therefore never sits in plain AsyncStorage, and the
 * only thing small enough for the keychain is the only thing that needs to be
 * there.
 *
 * CTR mode with a per-value key: because the key is never reused across values,
 * a fixed counter start cannot produce the keystream reuse that would make CTR
 * unsafe. Rotating on every `setItem` is what buys that — Supabase rewrites the
 * session on every token refresh, so one long-lived key would be reused for
 * dozens of distinct plaintexts.
 * SOURCE: the documented Supabase + Expo session-storage recipe (AES key in
 * SecureStore, ciphertext in AsyncStorage, because of the SecureStore size cap)
 * https://supabase.com/docs/guides/auth/quickstarts/react-native
 *
 * ─── THE CONTRACT EVERY IMPLEMENTATION MUST HOLD ────────────────────────────
 * `getItem` RETURNS NULL ON A CORRUPT OR UNREADABLE STORE. It does not throw.
 * A half-restored device backup (AsyncStorage restored, keychain not), a
 * revoked entitlement, or a mocked native layer under test must all read as
 * SIGNED OUT — which is the honest interpretation of a credential we cannot
 * decrypt — and never as a crash during auth boot, which is a launch failure
 * with no recovery path on the device.
 */
export interface SessionStorageAdapter {
  getItem(key: string): Promise<string | null>
  removeItem(key: string): Promise<void>
  setItem(key: string, value: string): Promise<void>
}
