# Patch: a mobile `CryptoProvider` + `X25519Provider` + `KeystoreAdapter` (e2ee module)

OPT-IN wiring — copy deliberately. `@app/crypto` ships the whole hierarchy and
exactly two providers, and both are WebCrypto-backed:
`createWebCryptoProvider()` and `createWebCryptoX25519Provider()` live on the
`.` barrel and **return `null` under Hermes**, which ships no Web Crypto. So on
a device this module computes nothing until you supply the host implementations
below. Two decisions are yours before pasting anything: which primitive library
provides AES-256-GCM and HKDF-SHA-256 (and X25519, if the feature shares), and
whether that choice is a native dependency.

## Why no primitive dependency ships in base

The same stance the observability module takes toward an OTLP endpoint: **a
native dependency is a decision made deliberately, not defaulted.** For
cryptography the price is higher than for a trace exporter, in four ways this
repo can name:

1. **A native module forces a prebuild.** `apps/mobile/android/**` and
   `apps/mobile/ios/**` are generated CNG output — never committed, never
   hand-edited, and `expo prebuild` is bash-guard denied locally (the device CI
   lane is the sanctioned place it runs, hermetically, from a clean tree). A
   dependency that needs native code moves the app out of Expo Go and into a
   development build for every contributor.
2. **A config plugin is a reviewed act.** Every plugin needs an entry with a
   reason in `tools/expo-plugins.json` (write-guard-protected; the `expo-policy`
   gate locksteps the resolved `plugins[]` against the file BIDIRECTIONALLY, and
   `native-deps` asserts the reason is non-empty), and it summons the
   `mobile-security-reviewer` for a verdict.
3. **A crypto library is the one dependency where "it works" is not evidence.**
   A wrong implementation roundtrips perfectly with itself. That is why the
   provider is held to published vectors rather than to a roundtrip
   (`webcrypto-provider.test.ts`), and why whichever library you pick must be
   held to the same ones.
4. **Defaulting it would make the choice invisible.** The port exists so the
   decision is a file a reviewer reads, not a line in a lockfile.

The port is deliberately AEAD-shaped rather than cipher-shaped: there is no way
to ask it for an unauthenticated encryption, a static IV, or a raw block
operation. Whatever library you wire in, it cannot be misused into one through
this seam.

## 1. Choose the primitive library

You need two primitives and one CSPRNG: **AES-256-GCM** (seal/open, 12-byte IV,
128-bit tag, with AAD), **HKDF-SHA-256** (extract + expand), and
**cryptographically secure random bytes**. Three real options, with what each
costs:

### `@noble/ciphers` + `@noble/hashes` — MIT, pure JS, audited — **the default**

- **Take these.** No native code, so no prebuild, no config plugin, no
  `tools/expo-plugins.json` entry, no `mobile-security-reviewer` summons for the
  dependency itself, and the app still runs in Expo Go. Both packages are MIT,
  both are on the `check-licenses.mjs` allowlist, and neither needs a
  `tools/license-exceptions.json` entry.
- Two packages, not one: AES-GCM is in `@noble/ciphers`, HKDF-SHA-256 is in
  `@noble/hashes`. Wiring only the first leaves `hkdfSha256` unimplemented.
- **The caveat, stated plainly: a pure-JS cipher cannot guarantee constant-time
  execution, because the JS engine is not under the library's control.** The
  code is written to avoid data-dependent branches and table lookups; Hermes'
  interpreter, its optimizer and its garbage collector are not, and nothing in
  JS can pin them down. AES on a CPU with hardware AES instructions runs in
  constant time because the *hardware* does; AES in JavaScript does not get that
  guarantee at any layer.
- Whether that matters is a threat-model question, and for this module's stated
  model it usually does not: the adversary this design defends against is
  server-side (an operator, a backup, a leaked dump), and an attacker who can
  measure your JS timing is already executing on the device, where the root key
  is one keychain read away regardless. If your model includes a co-resident
  local attacker, that is the case for going native.

### `react-native-quick-crypto` — MIT, native/JSI

- Faster by a wide margin (native AES through JSI, no bridge hop) and exposes a
  `node:crypto`-shaped API, so the provider body reads like the WebCrypto one.
- **It is a native dependency**, so it pays every cost in the section above:
  `tools/expo-plugins.json` review, a development build instead of Expo Go, a
  prebuild in the device CI lane, and the SDK-version discipline `native-deps`
  enforces over Expo-managed packages.
- Take it when you are encrypting enough data per screen that JS AES shows up in
  a profile — not before. Sealing a note body is microseconds of work; sealing a
  10 MB attachment is not.

### `react-native-libsodium` — ISC, native, batteries-included

- A full libsodium binding: AEADs, X25519 sealed boxes, Argon2id. The last one
  is its remaining edge — **Argon2id is what a passphrase-derived escrow would
  need**, and that construction stays a consumer decision (the shipped
  `RecoveryPort` uses a GENERATED full-entropy code precisely so it needs no
  memory-hard KDF; see the README's recovery section). If your product insists
  on a human-chosen passphrase, this binding or `@noble/hashes` is where the
  Argon2id comes from — priced, reviewed, and held to RFC 9106 vectors.
- Same native costs as `react-native-quick-crypto`, plus one shape mismatch:
  libsodium's marquee AEAD is XChaCha20-Poly1305, and this envelope's `alg 0x02`
  is RESERVED and unimplemented — a `0x02` envelope decodes to
  `unsupported_algorithm` today. So you would use libsodium's AES-256-GCM to fit
  `alg 0x01`, and libsodium gates that construction on CPU AES support and
  exposes an availability check you must honour before calling it.
- ISC is on the licenses allowlist; no exception entry needed.

**Default recommendation: `@noble/ciphers` + `@noble/hashes`, plus
`@noble/curves` if the feature shares.** The noble stack is the only option
that adds zero native surface, and the one whose downside (JS-engine timing) is
orthogonal to the adversary this module actually defends against. Move to a
native binding when a profile says so, or when a product decision demands
Argon2id for a passphrase-derived escrow — and land that move as its own
reviewed diff with the plugin entry and the reviewer verdict.

## 2. Install and pin

Versions live ONLY in the `pnpm-workspace.yaml` catalog — add the entries there
first, then take them as `catalog:` from the mobile app, and add the workspace
dependency on `@app/crypto` (add `@noble/curves` only if the feature calls
`wrapDekFor` — an X25519 provider nothing shares through is dead weight in the
bundle):

```
pnpm --filter mobile add @noble/ciphers @noble/hashes @app/crypto
```

Then edit `apps/mobile/package.json` so the external deps read `catalog:`
and `@app/crypto` reads `workspace:*`, and add the pinned versions to the
catalog. `pnpm validate` runs the `licenses` gate over the production tree: MIT
and ISC are both inside the allowlist, so a green `licenses` line is the proof
that the choice above did not drag in something copyleft through a transitive
edge. If it reds, read the failing package name before reaching for
`tools/license-exceptions.json` — an exception is a human decision, and that
file is write-guard-protected.

`expo-crypto` and `expo-secure-store` are already in the mobile app (they back
`LargeSecureStore`), so neither adds a dependency here.

## 3. The `CryptoProvider` (`apps/mobile/src/host/crypto-provider.ts`)

**The path is not incidental.** `apps/*/src/host/**` is one of the two
sanctioned homes for `crypto-primitives-one-door` — the ESLint rule that keeps
application code away from `crypto.subtle` and from `node:crypto`'s cipher/KDF
surface, so primitives arrive only through the injected port. The other home is
`packages/platform/crypto/src/**`. Put this file anywhere else and lint reds,
which is the rule working: a second primitive door is a second envelope format
nobody reviewed.

The same directory is the ONLY scope (with the crypto package) where
`no-insecure-random-in-crypto-scope` applies — `Math.random` is an error here
whatever it is nominally computing, **tests included**, because a fixture key
from `Math.random` is how a weak key reaches a snapshot and then a copy-paste.

Against the port signatures exactly: `randomBytes`, `aeadSeal`, `aeadOpen`,
`hkdfSha256`. Note the two non-obvious lines.

```ts
import { gcm } from '@noble/ciphers/aes'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import type { CryptoProvider } from '@app/crypto/client'
import * as Crypto from 'expo-crypto'

/**
 * The mobile half of @app/crypto's injected primitives. The package is pure
 * logic; this file is the platform's crypto engine, and it is the only file in
 * the mobile graph that names a primitive library.
 */
export const nativeCryptoProvider: CryptoProvider = {
  randomBytes(length) {
    // expo-crypto, NOT the library's own randomBytes helper: @noble's helper
    // reads crypto.getRandomValues, and Hermes ships no Web Crypto — the global
    // would be whatever a polyfill package installed, and a key derived from
    // Math.random is not a key. expo-crypto reads the platform CSPRNG
    // (SecRandomCopyBytes / SecureRandom) through the native module this app
    // already depends on. Same reasoning as LargeSecureStore, one layer down.
    // SOURCE: https://docs.expo.dev/versions/latest/sdk/crypto/
    return Crypto.getRandomBytes(length)
  },

  aeadSeal({ key, iv, plaintext, aad }) {
    // Returns ciphertext ‖ 16-byte tag — the AEAD framing the envelope stores
    // verbatim. The 12-byte iv is minted per seal by the keyring, never reused.
    return Promise.resolve(gcm(key, iv, aad).encrypt(plaintext))
  },

  aeadOpen({ key, iv, ciphertext, aad }) {
    try {
      return Promise.resolve(gcm(key, iv, aad).decrypt(ciphertext))
    } catch {
      // MANDATORY. The library signals authentication failure by THROWING; the
      // port's contract is null, and an AEAD has exactly one failure output. A
      // throw here would escape openItem's typed result and turn "not your
      // ciphertext" into a crash on a screen — the precise failure the closed
      // CryptoFailureReason union exists to prevent. Nothing is caught but the
      // auth failure this line exists for; no detail is extracted, because
      // detail on a decryption failure is what padding oracles are made of.
      return Promise.resolve(null)
    }
  },

  hkdfSha256({ ikm, salt, info, length }) {
    // Extract + expand in one call. SOURCE: https://www.rfc-editor.org/rfc/rfc5869
    return Promise.resolve(hkdf(sha256, ikm, salt, info, length))
  },
}
```

Two properties to hold in review:

- **`aeadOpen` returns `null` and never throws**, for every failure mode — wrong
  key, tampered ciphertext, tampered AAD, tampered tag. This is the single most
  important line in the file.
- **Nothing here logs.** Not the key, not the IV, not a length, not on a failure
  path. A `console.log` in a provider is a key in a device log.

### Prove it against the same vectors

Copy the assertions from `packages/platform/crypto/src/webcrypto-provider.test.ts`
into a jest-expo test beside this file and point them at
`nativeCryptoProvider`, reusing the known-answer vectors inlined in
`src/webcrypto-provider.test.ts`. Seal must reproduce the published `ct‖tag` **byte-exactly**
— a roundtrip test proves only that the library agrees with itself, which is
exactly what a wrong cipher also does. Then keep the three tamper cases
(ciphertext byte, AAD byte, tag byte), because they are what prove `aeadOpen`
returns `null` on the path that matters.

## 3b. The `X25519Provider` — only if the feature shares (`apps/mobile/src/host/x25519-provider.ts`)

The recipient-wrap seam (`wrapDekFor`/`unwrapDekWith`) is built over a SECOND
port, deliberately separate from `CryptoProvider` so a host that never shares
never wires it. On web it is free (WebCrypto's Secure Curves); on Hermes the
priced consumer decision is **`@noble/curves`** — MIT, pure JS, audited, same
zero-native cost profile as `@noble/ciphers`, and the same caveat about
JS-engine timing, which is again orthogonal to this module's server-side
adversary. The port trades in raw 32-byte keys, which is exactly the shape
`@noble/curves` speaks natively — no PKCS#8 bridge needed on this side (that
bridge exists in `webcrypto-x25519.ts` only because WebCrypto refuses raw
private keys; cross-platform parity of the BYTES is the point of the port).

```ts
import { x25519 } from '@noble/curves/ed25519'
import type { X25519Provider } from '@app/crypto/client'
import * as Crypto from 'expo-crypto'

/** The mobile half of @app/crypto's X25519 port — raw 32-byte keys, null-not-throw. */
export const nativeX25519Provider: X25519Provider = {
  generateKeyPair() {
    // expo-crypto for the scalar, NOT the library's randomPrivateKey helper,
    // for the same reason nativeCryptoProvider avoids @noble's randomBytes:
    // Hermes has no crypto.getRandomValues, and the platform CSPRNG is the
    // only key source this repo accepts.
    const secretKey = Crypto.getRandomBytes(32)
    return Promise.resolve({ secretKey, publicKey: x25519.getPublicKey(secretKey) })
  },
  deriveSharedSecret({ secretKey, publicKey }) {
    try {
      const shared = x25519.getSharedSecret(secretKey, publicKey)
      // CONTRIBUTORY-BEHAVIOUR CHECK, by hand: WebCrypto engines refuse an
      // all-zero shared secret per the Secure Curves spec, but @noble/curves
      // returns it (RFC 7748 permits either). The port's contract is the
      // stricter one, so the check lives here — without it, a low-order
      // recipient point would silently derive a wrap key every attacker knows.
      return Promise.resolve(shared.every((b) => b === 0) ? null : shared)
    } catch {
      return Promise.resolve(null) // malformed key — a refusal, never a throw
    }
  },
}
```

Prove it the same way: point the RFC 7748 §5.2 and §6.1 vectors from
`src/webcrypto-x25519.test.ts` at this provider in a jest-expo test, and KEEP
the all-zero refusal case — it is the one behaviour the library does not give
you for free.

## 4. The `KeystoreAdapter` (`apps/mobile/src/host/crypto-keystore.ts`)

It goes in `apps/mobile/src/host/` and nowhere else: ESLint's
`no-restricted-imports` admits `expo-secure-store` under `apps/mobile/src/host/**`
and bans it everywhere else in the app, and depcruise holds the same wall on the
resolved module graph. That directory is also already a
`mobile-security-reviewer` trigger path (`tools/reviewer-triggers.json`), so this
file summons a verdict without any new row.

**The root key is 32 bytes, so it fits SecureStore directly.** That is the whole
difference from `LargeSecureStore`: a Supabase session is several kilobytes of
JSON against a ~2 KB value cap (Android's Keystore-backed path warns and
truncates above it, which surfaces days later as "the user is randomly signed
out"), so the session has to be split — a key in the keychain, ciphertext in
AsyncStorage. A 32-byte key is two orders of magnitude under the cap and needs
no split at all.

```ts
import type { KeystoreAdapter } from '@app/crypto/client'
import * as SecureStore from 'expo-secure-store'

const KEY_BYTES = 32
const slot = (userId: string): string => `e2ee.rootKey.${userId}`

const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const secureRootKeyStore: KeystoreAdapter = {
  /**
   * Null on missing OR unreadable — the LargeSecureStore contract. A
   * half-restored backup that carried AsyncStorage but not the keychain, a
   * revoked entitlement, jest's mocked native layer: all read as NO KEY, never
   * a boot crash. openItem then answers key_missing and the screen renders an
   * error state, which is the honest interpretation of data we cannot decrypt.
   */
  async getRootKey(userId) {
    try {
      const hex = await SecureStore.getItemAsync(slot(userId))
      if (hex === null) return null
      const bytes = fromHex(hex)
      // A short read is a truncated write, not a key. Refuse it rather than
      // derive a KEK from it — a KEK from 11 bytes decrypts nothing and reports
      // aead_auth_failed forever, which is indistinguishable from tamper.
      return bytes.length === KEY_BYTES ? bytes : null
    } catch {
      return null
    }
  },

  /**
   * NOT try/caught, deliberately: a key that cannot persist must fail the write
   * LOUDLY. Swallowing it would let the caller seal rows under a key that does
   * not exist anywhere — ciphertext that is unreadable from the moment it is
   * written, and unreadable identically to correctly-encrypted data.
   */
  async setRootKey(userId, key) {
    await SecureStore.setItemAsync(slot(userId), toHex(key))
  },

  /** Absence is the goal, so an unreachable keychain already counts as deleted. */
  async deleteRootKey(userId) {
    try {
      await SecureStore.deleteItemAsync(slot(userId))
    } catch {
      // Indistinguishable from deleted on the next read.
    }
  },
}
```

**The keystore is per user id, and sign-out is a decision, not a default.**
`deleteRootKey` on sign-out makes every encrypted row on that device unreadable
until the key RETURNS — which it now can, but only through a path you built:
a recovery escrow the user's code opens (`recoverRootKey`) or a device-sync
import from another signed-in device (`importFromDevice`). A user with neither
— no escrow issued, or the code lost — is permanently locked out of their own
rows by your sign-out. Keeping the key across sign-out leaves decryptable
material on a shared device. Pick one, in the ADR, and say which — and if you
pick deletion, issue the recovery code BEFORE the first seal, not at sign-out.

Minting the key is the caller's job and belongs wherever your session becomes
known:

```ts
const existing = await secureRootKeyStore.getRootKey(userId)
const rootKey = existing ?? nativeCryptoProvider.randomBytes(32)
if (existing === null) await secureRootKeyStore.setRootKey(userId, rootKey)
const kek = await deriveKek(nativeCryptoProvider, rootKey, 'item-wrap')
```

Mint it **once**, from the platform CSPRNG, and never from a passphrase, a user
id, a timestamp, or `Math.random` — which is lint-refused in this directory and
write-guard-refused as an assignment into a key-shaped name
(`math-random-key-material`), on top of not being a CSPRNG on any engine. Never
from a literal either: a 64-hex string assigned into a key-shaped name is denied
by `hardcoded-key-material`, because a fixture key is one copy-paste from a
production constant. A second mint for a user who already has rows is not a
reset — it is silent, permanent data loss for every row sealed under the first
key.

## 5. Import the Metro-safe barrel, always

The mobile graph imports `@app/crypto/client`. **Never `@app/crypto`** — the `.`
barrel carries `createWebCryptoProvider` and `createWebCryptoX25519Provider`,
both of which reach for `crypto.subtle`, and Metro does not tree-shake, so an
unreachable-in-practice import is still a shipped one. The census reason is
already recorded in `tools/exports-walls.json` and the `boundaries` gate holds
the wall.

## 6. Flip the export-compliance declaration — in the SAME diff

**Shipping real cryptography changes what you owe Apple, and the two halves must
land together.** Standard HTTPS is exempt and an https-only app declares
`false`; this module is not that. In one commit:

`apps/mobile/app.config.ts`:

```ts
ios: {
  infoPlist: {
    ITSAppUsesNonExemptEncryption: true,
  },
}
```

`tools/store-tunables.json`:

```json
"iosEncryption": {
  "nonExemptAllowed": true,
  "reason": "The e2ee module ships AES-256-GCM + HKDF-SHA-256 over user content (packages/platform/crypto). This is non-exempt cryptography beyond standard TLS; expect export documentation at submission."
}
```

`check-expo-policy.mjs` enforces this in **both** directions, over the RESOLVED
config, and each direction has its own message:

- `ITSAppUsesNonExemptEncryption` must be a boolean. Undeclared is not neutral —
  it re-asks the question on every TestFlight and App Store build.
- `ITSAppUsesNonExemptEncryption: true` with `nonExemptAllowed: false` reds:
  shipping non-exempt cryptography is a reviewed decision, not a config edit.
- `nonExemptAllowed: true` with an empty `reason` reds: the escape exists to
  carry the reasoning, and an empty reason is the escape hollowed out.

Two operational facts before you make the edit:

- **`tools/store-tunables.json` is write-guard-protected.** An agent cannot write
  it; a human makes this edit, in a reviewed commit, and it lands under
  CODEOWNERS with the dependency and the provider in one PR.
- **It is YOURS — seeded, never re-planted.** Since the 1.0.0 floor/tunable
  split, the harness FLOOR (`tools/store-policy.json`: the Xcode floor,
  `androidTargetSdk`, the usage-description key map) stays owned and keeps
  arriving on `update`, while the consumer TUNABLES (`tools/store-tunables.json`:
  `iosEncryption`, the account-deletion surface, privacy-manifest rows, icon
  policy) are seeded once at `init` and never rewritten. So the flip you make
  here survives every harness upgrade, and `gate-integrity` never reads it as
  tampering — the two-halves-in-one-file trap 0.9.5 fell into is closed, and the
  obligations row that tracked it (`store-policy-consumer-tunable-split`) is
  discharged.

`tools/store-tunables.json` is also a `mobile-security-reviewer` trigger path, so
this diff owes that reviewer a `VERDICT: PASS` before the turn can end.

## Anti-vacuity

With the provider wired: point `aeadSeal` at a different cipher or truncate the
tag to 96 bits → the copied vector test fails on the exact `ct‖tag` comparison.
Replace the `catch` in `aeadOpen` with a rethrow → the three tamper cases fail,
and `openItem` stops returning `aead_auth_failed`. Swap `Crypto.getRandomBytes`
for anything that is not the platform CSPRNG → the fresh-DEK test in
`keyring.test.ts` is the only thing standing between you and repeated keys, and
it only catches an RNG that repeats outright. With the X25519 provider wired:
drop the all-zero check → the copied contributory-refusal case fails; feed
`getSharedSecret` a wrong argument order → the §5.2 vectors fail, because
X25519 is not symmetric in scalar and point.
