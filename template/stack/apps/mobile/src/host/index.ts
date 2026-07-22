// The host seam — the ONLY module that touches the platform keychain
// (dependency-cruiser rule: secure-store-host-seam-only). expo-secure-store
// keeps the credential in iOS Keychain / Android Keystore, never in JS-visible
// app storage: anything in the JS sandbox (a compromised dependency, an
// injected script in a webview) can read app storage; it cannot read the
// keychain entry of another process.
// SOURCE: the client holds a scoped bearer token only; authorization lives
// server-side on FORCE RLS [corpus: harness/doctrine]
import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY = 'access_token'
// The Entra refresh token — a LONG-LIVED credential, which is precisely why it
// may only ever exist behind this seam: JS-visible storage would hand it to
// anything running in the JS sandbox for the lifetime of the grant.
const REFRESH_TOKEN_KEY = 'refresh_token'

/**
 * The stored bearer token, or null when signed out. Corrupt-safe (the kv.ts
 * discipline): an unreadable keychain — fresh install, revoked entitlement,
 * jest's mocked native layer — reads as SIGNED OUT, never a boot crash.
 */
export async function secureGetToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY)
  } catch {
    return null
  }
}

/**
 * Store the bearer token. Deliberately NOT try/caught: a sign-in that cannot
 * persist its token must fail the sign-in, not report success and then read as
 * signed-out on the next launch.
 */
export async function secureSetToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}

/** Drop the stored token; absence is the goal, so an unreachable store counts. */
export async function secureDeleteToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY)
  } catch {
    // Indistinguishable from deleted on the next read.
  }
}

/** The stored refresh token, or null. Same corrupt-safe contract as the access token. */
export async function secureGetRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

/**
 * Store the refresh token. NOT try/caught, same reasoning as secureSetToken: a
 * sign-in that cannot persist its grant must fail the sign-in loudly.
 */
export async function secureSetRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token)
}

/** Drop the stored refresh token; an unreachable store already counts as deleted. */
export async function secureDeleteRefreshToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY)
  } catch {
    // Indistinguishable from deleted on the next read.
  }
}
