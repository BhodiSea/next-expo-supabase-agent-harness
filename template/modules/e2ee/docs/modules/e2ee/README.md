# Module: e2ee

Client-side encryption rails for one user's own rows: a versioned AEAD envelope,
a local key hierarchy, and a closed failure vocabulary — all pure logic over
INJECTED primitives, so the package imports nothing and the server never holds
plaintext or a key that decrypts it. What ships is the half that is whole:
`@app/crypto` at `packages/platform/crypto`, its WebCrypto provider, and the
published-vector tests that prove the provider is the cipher it claims to be.

What does NOT ship is as much of the module as what does, and it is enumerated
in "What this deliberately does NOT solve" below rather than left for a consumer
to discover in production. Three ports are DECLARED with no implementation
(`src/ports-declared.ts`) precisely so a future implementation cannot invent a
second envelope or a second keyring, and so the gaps have names.

**E2EE is confidentiality ON TOP of the authorization boundary, never a
replacement for it.** RLS keyed on `auth.uid()` still decides which rows a
caller may read; encryption decides whether the bytes mean anything once they
are read. A table whose ciphertext columns are world-readable is a broken table
with an intact cipher.

## What it adds

| File | Purpose |
| --- | --- |
| `packages/platform/crypto/src/result.ts` | `CryptoResult<T>` + the CLOSED `CryptoFailureReason` union (`aead_auth_failed`, `envelope_malformed`, `unsupported_version`, `unsupported_algorithm`, `key_missing`, `keystore_unavailable`). The package never throws — a crypto refusal that arrives as a stack trace becomes a crash surface on a screen |
| `packages/platform/crypto/src/envelope.ts` | The ONE ciphertext container (`encodeEnvelope`/`decodeEnvelope`) and the AAD builder (`buildAad`, `KeyContext`, `AAD_ROLE_ITEM`/`AAD_ROLE_DEK`) |
| `packages/platform/crypto/src/keyring.ts` | `deriveKek` / `sealItem` / `openItem` — the rootKey → KEK → per-item DEK hierarchy |
| `packages/platform/crypto/src/ports.ts` | `CryptoProvider` (AEAD-shaped, never cipher-shaped) and `KeystoreAdapter`. DECLARED here, implemented NOWHERE in the package — the `SessionStorageAdapter` precedent |
| `packages/platform/crypto/src/ports-declared.ts` | `RecipientWrapPort` / `RecoveryPort` / `DeviceSyncPort` — declared, unimplemented, and each one names a loss stated below |
| `packages/platform/crypto/src/webcrypto-provider.ts` | `createWebCryptoProvider()` — the ONE shipped provider (Node >= 22, every evergreen browser). Returns `null` where there is no Web Crypto rather than throwing |
| `packages/platform/crypto/src/index.ts` | The `.` barrel: everything on `./client`, plus `createWebCryptoProvider` |
| `packages/platform/crypto/src/client.ts` | The `./client` barrel: the Metro-safe surface — result vocabulary, envelope codec, keyring, and the port TYPES. Reaches for no runtime global |
| `packages/platform/crypto/src/envelope.test.ts` | Roundtrip byte-faithfulness, one distinct reason per decode refusal, and the two AAD properties (role separation; NUL-separation injectivity) |
| `packages/platform/crypto/src/keyring.test.ts` | The hierarchy over the REAL provider: fresh DEK per seal, wrap/unwrap, and the four refusals — moved row, moved user, role swap, wrong root key |
| `packages/platform/crypto/src/webcrypto-provider.test.ts` | VECTOR conformance (seal must reproduce the published `ct‖tag` byte-exactly), plus tamper cases on ciphertext, AAD and tag |
| `packages/platform/crypto/src/testing/vectors.gcm.json` · `vectors.hkdf.json` | The published AES-256-GCM and RFC 5869 appendix-A vectors the provider is held to |
| `docs/modules/e2ee/mobile-provider.patch.md` | The documented patch for a MOBILE `CryptoProvider` + `KeystoreAdapter` — a primitive dependency is a decision made deliberately, not defaulted |

`@app/crypto` is a dual-barrel package and its census entry is already in
`tools/exports-walls.json` with the reason: `.` carries a provider that reaches
for `crypto.subtle`, **Hermes ships no Web Crypto**, and Metro does not
tree-shake — so a mobile import of `.` would put a factory reaching for an
absent global into the native binary. That is the whole reason for the split.

## Prerequisites

- Node >= 22 (or any evergreen browser) for the shipped provider and for the
  vitest lane. Nothing else: the package has no runtime dependency, only
  `vitest` as a devDependency.
- For a MOBILE surface: a provider and a keystore you supply, per
  `docs/modules/e2ee/mobile-provider.patch.md`. Nothing in this module works on
  a device until you apply it — the module ships no native crypto dependency and
  `createWebCryptoProvider()` returns `null` under Hermes.
- Before any of it: a decision recorded in an ADR (`/adr <slice>`) about WHICH
  columns are encrypted and which losses below you are accepting. The losses are
  not recoverable after the fact — a column encrypted for a year cannot be
  retroactively made searchable, and a user whose device is gone cannot be given
  their data back.

## How enabling works

```
npx next-expo-supabase-agent-harness enable e2ee
```

copies `packages/platform/crypto/**` and these docs. The three test files join
`pnpm test` — and therefore the Stop hook and CI — at once, with no wiring step:
they prove the shipped code against published vectors, not against a mock. No
`tools/harness.config.mjs` change; no gate is added.

Nothing consumes the package until you write a feature that does. The authoring
recipe is the `authoring-e2ee-feature` skill.

## The key hierarchy

```
rootKey — 32 bytes from the platform CSPRNG, lives in the platform keystore
  └─ KEK = HKDF-SHA-256(rootKey, salt = 32 zero bytes, info = "app-e2ee/v1/item-wrap")
       └─ per-item DEK — a FRESH 32 CSPRNG bytes on EVERY seal
            ├─ item envelope    = AES-256-GCM(DEK, plaintext, AAD(role=item, ctx))
            └─ wrapped-DEK env  = AES-256-GCM(KEK, DEK,       AAD(role=dek,  ctx))
```

Four choices carry the weight, and each buys something specific:

- **The root key never encrypts anything.** It is HKDF input only. `info` is the
  domain separator (`app-e2ee/v1/<purpose>`), the salt is 32 zero bytes because
  RFC 5869 §3.1 defines absent salt exactly that way and the separation this
  hierarchy needs lives in `info` — a per-install salt would buy nothing and
  cost a second stored secret.
- **A fresh DEK per seal.** No key ever encrypts twice, so a 96-bit random IV
  never approaches the birthday bound that makes IV reuse under GCM
  catastrophic. This is the same key-never-repeats argument `LargeSecureStore`
  documents for its CTR counter, applied to AEAD. It is also why sealing the
  same plaintext twice produces two different envelopes — a property
  `keyring.test.ts` asserts.
- **The DEK is WRAPPED, not derived.** A derived DEK would be recomputable from
  the root key forever. A wrapped DEK exists only in its column — which is what
  makes crypto-shredding real: **deleting a row's `*_wrapped_dek` column renders
  that row's ciphertext permanently unreadable, while the root key lives on for
  every other row.** That is the erase lever, and it is the one deletion in this
  design that is a cryptographic fact rather than a promise.
- **AAD is mandatory and binds the row.** `buildAad` binds the version byte, the
  alg byte, a ROLE byte, and `userId\0table\0itemId` as UTF-8. A ciphertext
  copied into another row, another table, or another user's row **fails
  authentication** — confidentiality alone does not stop a copy-paste attack
  inside one key's reach. The role byte (`0x00` item, `0x01` wrapped DEK) means
  an item ciphertext and a wrapped DEK can never authenticate in each other's
  slot. NUL is the separator because a printable join character that can appear
  inside an id would let two different identities encode identically —
  `envelope.test.ts` asserts exactly that pair.

### The envelope, byte by byte

```
magic u16 BE (0xa7e1) | v u8 (1) | alg u8 | ivLen u8 (12) | iv (12) | ct (ciphertext ‖ 16-byte GCM tag)
```

`alg 0x01` is AES-256-GCM. **`alg 0x02` is RESERVED for XChaCha20-Poly1305 and
deliberately unimplemented** — it decodes to `unsupported_algorithm`, which is
algorithm agility with no dead code behind it. The version byte is what makes a
future format change a DECODE BRANCH instead of a fleet migration, and it lives
INSIDE the envelope so no separate schema column can drift away from the bytes
it describes.

The tag rides inside `ct` because that is the AEAD interface's own framing; the
envelope never re-frames what the primitive already authenticates. Overhead is
therefore exact and worth knowing before you choose columns: **an item envelope
is `plaintext + 33` bytes** (5 header + 12 IV + 16 tag, and GCM is a stream mode
so `|ct| == |pt|`), and **a wrapped DEK is a constant 65 bytes**.

### The failure vocabulary

`CryptoResult<T>` is `{ ok: true, value }` or `{ ok: false, reason, detail? }`.
Six reasons, closed:

| Reason | What it means | What a caller does |
| --- | --- | --- |
| `aead_auth_failed` | Authentication failed | Render an error state. **This covers BOTH tamper and wrong-key on purpose** — an AEAD cannot tell them apart, and a vocabulary that pretended to would be lying |
| `envelope_malformed` | Not an envelope, or truncated | The data is broken, not the key. Fix the data |
| `unsupported_version` | An envelope from a FUTURE fleet | Upgrade the client. Distinct from `envelope_malformed` because the remedies are opposite |
| `unsupported_algorithm` | A reserved or unknown alg id | Same: a newer or foreign writer |
| `key_missing` | No root key on this device | On this device, this data is unreadable — see recovery, below |
| `keystore_unavailable` | The keystore could not be read | Possibly transient (a half-restored backup, a revoked entitlement) |

The package NEVER throws. Mapping a reason onto `appError` codes is the caller's
decision and happens at the boundary — the same split `@app/ratelimit` uses.

## Wiring a host

The package sees no platform API. A host supplies two things.

### `CryptoProvider`

- **Web / Node:** `createWebCryptoProvider()` from the `.` barrel. It returns
  `CryptoProvider | null` — `null` when the runtime has no Web Crypto — so the
  host chooses its own failure surface rather than inheriting a throw. It pins
  `tagLength: 128` (the full GCM tag; a shorter tag is a weakening this port
  refuses to express) and returns `null` from `aeadOpen` on WebCrypto's
  detail-free `OperationError`, which is detail-free for padding-oracle reasons
  that adding detail here would undo.
- **Mobile:** yours, per `docs/modules/e2ee/mobile-provider.patch.md`. Import
  `@app/crypto/client` in the mobile graph and inject the host-built provider —
  **never `@app/crypto`**, whose `.` barrel is the WebCrypto factory.

### `KeystoreAdapter`

`getRootKey(userId)` returns `null` on missing OR unreadable (a half-restored
backup reads as no-key, never a boot crash — the `LargeSecureStore` contract).
`setRootKey` fails LOUD, because a key that cannot persist must not pretend to.
`deleteRootKey` is the local half of sign-out.

**Nothing in the package implements it. Both hosts write their own.**

- **Mobile** — `expo-secure-store` through the existing `apps/mobile/src/host/`
  one door (ESLint's `no-restricted-imports` allows `expo-secure-store` there
  and nowhere else; depcruise holds the same wall on the resolved graph). The
  root key is 32 bytes, two orders of magnitude under SecureStore's ~2 KB value
  cap, so unlike a Supabase session it fits directly and needs none of
  `LargeSecureStore`'s split. Code shape in the patch doc.
- **Web** — yours to create (a browser-only module beside the browser Supabase
  seam, e.g. `apps/web/lib/crypto/keystore.ts`). Read the weakness section
  below before you write it: this is the half of the module that is honestly
  weaker on web, and the port's own shape is part of why.

## What this deliberately does NOT solve

Every item below is a real capability of "end-to-end encryption" as users
understand the phrase, and this module does not have it. Each is stated with
what it costs.

### Multi-device — a second device sees ciphertext

The root key is minted on one device and lives in that device's keystore. There
is **no path** by which a second sign-in obtains it: `DeviceSyncPort` is
declared in `src/ports-declared.ts` and implemented nowhere. **A user who signs
in on a second device sees their rows, and cannot read them** — RLS admits the
rows, `openItem` returns `key_missing` or `aead_auth_failed`, and the screen
renders an error state. That is the stated behaviour, not a bug. The honest
shapes (a QR handoff, a recovery-escrow replay) both depend on the recovery port
below, which is why device sync is declared last.

### Recovery — **lost device is lost data**

`RecoveryPort` is declared and unimplemented. If the keystore entry is gone —
device lost, app uninstalled, keychain wiped, backup restored without it — the
ciphertext is unreadable **by anyone, permanently, including you**. There is no
escrow, no reset link, no support path. Every encrypted column is a column your
support team cannot recover for a user who asks.

The reason is a refusal, not an oversight: passphrase-derived escrow needs a
memory-hard KDF, **WebCrypto ships no Argon2**, and shipping PBKDF2 while
calling it "the KDF" would be a dishonest default — a recovery story that does
not actually resist an offline attack on a human-chosen passphrase is worse than
the stated loss, because users would rely on it. If you need recovery, implement
`RecoveryPort` against a real Argon2id, and price the native dependency the way
the mobile-provider patch prices its own.

### Org sharing — an org-mate's readable row is unreadable content

`RecipientWrapPort` (X25519 sealed-box shaped) is declared and unimplemented, so
a DEK can be wrapped to exactly one principal: the author's own KEK. **In this
B2B scaffold the tenant key is `org_id`, so RLS admits an org-mate to the row —
and they get ciphertext they cannot open.** Sharing is the default expectation
of a team product; encrypting a shared column removes it.

The AAD makes this concrete rather than incidental: `KeyContext` binds `userId`,
so a row sealed by user A authenticates only under A's identity. There is no
configuration that changes this.

### Metadata leakage — encryption hides content, not shape

Everything about the row except the plaintext bytes stays server-visible: which
user has how many rows, when each was created and updated, who shares an org
with whom, the access pattern, and **the exact size of every plaintext** — GCM
is a stream mode, so a ciphertext column is `plaintext + 33` bytes and the
length is readable to the byte. No padding ships. A server operator, a database
backup, or anyone with the RLS-admitted read still learns the shape of the data
and everything the surrounding columns say.

If a size or a timestamp is itself the secret, this module does not address it,
and padding or timing defences are yours to design.

### Searchability — gone, at the database

There is **no server-side search over ciphertext**. Not `LIKE`, not `ILIKE`, not
full-text (`tsvector`), not a trigram index, not a vector index, not `ORDER BY`
on the column, not a `WHERE` filter, not a `CHECK` constraint on its content,
not a uniqueness constraint on its value. Every one of those reads bytes the
database cannot interpret.

A consumer who needs search over an encrypted column has exactly two honest
choices, and must pick one per column in the ADR:

1. **Client-side search over a downloaded set** — the client fetches the rows it
   is allowed to see, opens them, and searches in memory. This bounds the
   feature by what a device can hold and download, and it does not paginate:
   keyset pagination over a column the server cannot read is not a thing.
2. **Do not encrypt that column.** A title that must be searchable and a body
   that must be private is a normal, defensible split — and far more honest than
   a scheme that leaks order or equality to make an index work.

Deterministic encryption and order-preserving encryption would restore equality
and range queries respectively, at the cost of leaking equality and order to the
server. Neither is implemented here and neither should be added casually.

### Key rotation — a full client-side re-encryption pass, unorchestrated

The keyring exports `deriveKek`, `sealItem` and `openItem`. **It exports no
rewrap primitive**, so the only shipped path from an old root key to a new one
is `openItem` under the old KEK then `sealItem` under the new — which mints a
fresh DEK and rewrites BOTH columns of every affected row. That is a full
re-encryption pass, it runs on a client that can decrypt (there is no other
kind), and **nothing ships to orchestrate it**: no batch runner, no resume
point, no progress record, no way to verify it completed, no way to serve a row
that is half-migrated. A compromised key therefore has no fast remedy, and a
rotation interrupted at row 4,000 of 10,000 leaves a table in two key eras with
nothing recording which is which.

### The web keystore — a browser has no hardware keychain

On mobile, the root key sits in the iOS Keychain / Android Keystore: a different
process's storage, unreadable by anything running in the JS sandbox, which is
exactly the property `LargeSecureStore` was built to buy. **On web there is no
equivalent.** Whatever a browser KeystoreAdapter uses — IndexedDB, localStorage
— is same-origin storage readable by any JavaScript that runs on the origin. One
XSS, one compromised dependency in the web bundle, one malicious extension with
host access, and the root key leaves with the attacker; and because the key
decrypts every row, that is a total loss, not a session loss.

**The port's own shape forecloses the strongest available web option.**
`KeystoreAdapter.getRootKey` returns `Uint8Array | null` — raw bytes. The
strongest thing a browser offers is a NON-extractable `CryptoKey` handle stored
in IndexedDB, whose raw bytes JavaScript cannot read at all; that handle cannot
satisfy a `Uint8Array` contract. A web host that wants non-extractable key
material must go around this port rather than through it.

So: mobile E2EE here is meaningfully strong against sandbox-level compromise;
web E2EE here defends against a **server-side** adversary (an operator, a
backup, a leaked dump) and not against a client-side one. If the web surface is
your main surface, say that plainly in the ADR rather than letting "end-to-end
encrypted" carry an implication the browser cannot honour.

### Portability (GDPR Art. 20) — an export the user cannot read is not an export

`tools/data-flow.json` `export.projection` is this repo's reviewed answer to
"what is my data", delivered by `system.exportMyData` running AS THE CALLER
under RLS. That surface projects **columns**, and an encrypted column projects
as ciphertext. **A ZIP of bytes the subject cannot decrypt is not portability**;
it is the appearance of compliance.

An encrypted feature must therefore pick one, in the ADR and in the
`tools/data-flow.json` reason text:

- **Decrypt client-side at export time.** The export already runs as the
  subject, on a client that holds the key, so this is the natural fit: open each
  row and put plaintext in the archive. It is also the only option that produces
  a genuinely portable file.
- **Ship ciphertext plus wrapped keys, LABELLED honestly.** Legitimate when the
  subject can actually reconstruct the plaintext — which means the archive must
  also carry the envelope format, the algorithm, the AAD construction, and the
  root key or an escrow of it. Without the key material this is not portability
  and must not be described as such.

Whichever you choose, record it. The `data-flow` gate closes projection against
the schema in both directions, but **it cannot tell ciphertext from plaintext**
— a `body_ciphertext` column in the projection satisfies the gate exactly as a
`body` column would. That check is on you and on the reviewer.

## How its gate can FAIL (anti-vacuity)

The module adds no gate; it adds tests that ride the existing lanes, and they
are falsifiable:

- Swap the provider's cipher, truncate the GCM tag, or drop the AAD from the
  WebCrypto calls → the vector tests fail, because sealing must reproduce the
  published `ct‖tag` byte-exactly. A roundtrip-only test would pass all three.
- Remove the AAD from `sealItem`/`openItem`, or drop the role byte → the
  moved-row, moved-user and role-swap cases in `keyring.test.ts` go green in the
  wrong direction and fail.
- Reuse a DEK across seals (derive instead of mint) → the fresh-DEK test fails,
  because two seals of the same plaintext would produce identical bytes.
- Add a version byte or alg id without a decode branch → the decode-refusal
  tests fail, each of which asserts its own distinct reason.
- The vector file itself is checked before anything is asserted against it:
  `|ciphertext| == |plaintext|` and a 16-byte tag per vector. That invariant
  caught one vector's published answer transcribed under another's inputs during
  authoring — a typo that would otherwise have surfaced as an implementation-bug
  report.

## Honest limits of the shipped half

- **`unsupported_version` has no upgrade path attached.** The version byte makes
  a format change a decode branch; it does not write the branch, and nothing
  ships that reads a v2 envelope.
- **`KeyContext` carries no org.** It binds `userId`, `table`, `itemId`. On a
  table whose primary key is `(org_id, id)` the AAD binds only `id`, which is
  safe while ids are `gen_random_uuid()` and unsafe the moment a consumer uses a
  composite or natural key. If your row identity needs more than one column,
  encode the whole identity into `itemId` yourself.
- **The `cryptography` provenance group keys on the construction CHOICE, not on
  the vocabulary.** `aeadSeal`/`aeadOpen`, an AEAD or KDF naming, and the
  wrapping structure owe a citation; `getRandomValues`, `randomUUID` and
  `createHash` deliberately do not, because reading the platform CSPRNG is the
  correct act at a dozen sites that are not cryptographic trade-offs. A
  hand-rolled construction that avoids all four patterns owes nothing to the
  gate and everything to the reviewer.
- **`deriveKek` accepts exactly one purpose** (`'item-wrap'`). Adding a second
  is a one-line union widening, but every purpose is a new domain-separated key
  and therefore a new thing to rotate.
