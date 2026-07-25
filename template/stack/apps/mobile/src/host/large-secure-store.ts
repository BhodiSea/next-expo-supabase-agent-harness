// AsyncStorage's package exposes the store as its DEFAULT export (it is an
// instance, not a namespace) — a named import silently yields undefined and the
// first getItem throws inside Supabase's auth boot.

import type { SessionStorageAdapter } from '@app/supabase/client'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as aesjs from 'aes-js'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'

// THE credential store behind Supabase Auth on this host — a SPLIT store, and
// the split is the whole point.
//
// expo-secure-store writes to the iOS Keychain / Android Keystore, which is the
// only place in this app a long-lived credential may live: anything running in
// the JS sandbox (a compromised dependency, an injected script) can read app
// storage, but it cannot read another process's keychain entry. What it CANNOT
// do is hold a Supabase session — a session is an access token plus a refresh
// token plus user metadata, several kilobytes of JSON, and SecureStore's value
// limit is ~2 KB (Android's Keystore-backed EncryptedSharedPreferences path
// warns and truncates above it). Handing it a whole session is a write that
// silently fails or a read that returns a truncated string, and BOTH surface as
// "the user is randomly signed out", days later, on one platform only.
//
// So: a fresh AES-256 key per stored value goes in SecureStore (32 bytes — two
// orders of magnitude under the cap), and the CIPHERTEXT goes in AsyncStorage,
// which has no practical size limit. The refresh token therefore never exists
// in plain AsyncStorage, and the only thing small enough for the keychain is
// the only thing that needs to be there.
// SOURCE: the documented Supabase + Expo session-storage recipe (SecureStore
// size limit → AES key in SecureStore, ciphertext in AsyncStorage)
// https://supabase.com/docs/guides/auth/quickstarts/react-native

/** AES-256: the key is 32 bytes. Named, because 256/8 as a literal reads as noise. */
const KEY_BYTES = 32

/**
 * The encrypted half of the split store, implementing @app/supabase's
 * `SessionStorageAdapter` — the platform package deliberately declares that
 * interface and nothing else, so the Expo/RN dependencies (SecureStore,
 * AsyncStorage, aes-js) stay HERE, in the one app that has a keychain, instead
 * of leaking into a package the Next surface also imports.
 *
 * CTR mode with a counter starting at 1 and a per-value key: because the key is
 * never reused across values, a fixed counter start cannot produce the keystream
 * reuse that would make CTR unsafe. Rotating the key on every `setItem` (rather
 * than keeping one app-lifetime key) is what buys that guarantee cheaply —
 * Supabase rewrites the session on every token refresh, so a shared key would be
 * reused for dozens of distinct plaintexts per session.
 */
export class LargeSecureStore implements SessionStorageAdapter {
  /** Mint a key, encrypt, park the key in the keychain, return the ciphertext hex. */
  private async encrypt(key: string, value: string): Promise<string> {
    // expo-crypto, NOT a `crypto.getRandomValues` polyfill: Hermes ships no Web
    // Crypto, so the global would be whatever a polyfill package installed —
    // and a key derived from Math.random is not a key. expo-crypto reads the
    // platform CSPRNG (SecRandomCopyBytes / SecureRandom) through the native
    // module that is already in this app's dependency set.
    const encryptionKey = Crypto.getRandomBytes(KEY_BYTES)
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1))
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value))
    // NOT try/caught, deliberately: a session that cannot persist its key must
    // fail the write loudly. Swallowing it would store ciphertext whose key does
    // not exist — an unreadable session that reads as "signed out" forever.
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey))
    return aesjs.utils.hex.fromBytes(encrypted)
  }

  /** Null when the keychain half is gone — see getItem for why that is a NULL, not a throw. */
  private async decrypt(key: string, value: string): Promise<string | null> {
    const keyHex = await SecureStore.getItemAsync(key)
    if (keyHex === null) return null
    const cipher = new aesjs.ModeOfOperation.ctr(
      aesjs.utils.hex.toBytes(keyHex),
      new aesjs.Counter(1),
    )
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)))
  }

  /**
   * Corrupt-safe by contract (the src/lib/kv.ts discipline): an unreadable store —
   * a half-restored backup that carried AsyncStorage but not the keychain, a
   * revoked entitlement, jest's mocked native layer — reads as SIGNED OUT, never
   * a boot crash. Supabase treats a null here as "no session" and shows sign-in,
   * which is the honest interpretation of a credential we cannot decrypt.
   */
  async getItem(key: string): Promise<string | null> {
    try {
      const encrypted = await AsyncStorage.getItem(key)
      if (encrypted === null) return null
      return await this.decrypt(key, encrypted)
    } catch {
      return null
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    const encrypted = await this.encrypt(key, value)
    await AsyncStorage.setItem(key, encrypted)
  }

  /**
   * BOTH halves, always. Dropping only the ciphertext would leave an orphan key
   * in the keychain that a later `setItem` overwrites anyway — but dropping only
   * the key would leave undecryptable ciphertext that `getItem` answers null for
   * forever, which is a sign-out that never lets the user back in.
   */
  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key)
    // Absence is the goal, so an unreachable keychain already counts as deleted.
    try {
      await SecureStore.deleteItemAsync(key)
    } catch {
      // Indistinguishable from deleted on the next read.
    }
  }
}
