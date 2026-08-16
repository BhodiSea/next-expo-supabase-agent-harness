# Module: e2ee

Client-side encryption rails for a user's rows: a versioned AEAD envelope, a
local key hierarchy, a closed failure vocabulary, and the three seams that make
E2EE mean what users think it means — org sharing (X25519 recipient wrap),
recovery (a generated code and an escrow the server cannot open), and
multi-device (a channel-key transit envelope) — all pure logic over INJECTED
primitives, so the package imports nothing and the server never holds plaintext
or a key that decrypts it. What ships is `@app/crypto` at
`packages/platform/crypto`, its two WebCrypto providers, and the
published-vector tests that prove each provider is the primitive it claims to
be.

Every shipped capability carries an honest RESIDUAL, and every residual is
stated below beside the capability rather than left for a consumer to discover
in production: a recovery code the user loses is still lost data, a recipient
wrap needs a public-key directory the consumer builds, device sync ships the
cryptography and deliberately not the ceremony. What the module still does NOT
solve is enumerated in "What this deliberately does NOT solve" — shorter than
it was, and honest about why each remaining loss remains.

**E2EE is confidentiality ON TOP of the authorization boundary, never a
replacement for it.** RLS keyed on `auth.uid()` still decides which rows a
caller may read; encryption decides whether the bytes mean anything once they
are read. A table whose ciphertext columns are world-readable is a broken table
with an intact cipher.

## What it adds

| File | Purpose |
| --- | --- |
| `packages/platform/crypto/src/result.ts` | `CryptoResult<T>` + the CLOSED `CryptoFailureReason` union (`aead_auth_failed`, `envelope_malformed`, `unsupported_version`, `unsupported_algorithm`, `key_missing`, `keystore_unavailable`, `recovery_code_malformed`). The package never throws — a crypto refusal that arrives as a stack trace becomes a crash surface on a screen |
| `packages/platform/crypto/src/envelope.ts` | The ONE ciphertext container (`encodeEnvelope`/`decodeEnvelope`) and the two AAD builders: `buildAad` (row identity, roles `0x00`/`0x01`) and `buildAadBytes` (byte-shaped identities, roles `0x02`–`0x04`) |
| `packages/platform/crypto/src/keyring.ts` | `deriveKek` / `sealItem` / `openItem` / `rewrapItemKey` — the rootKey → KEK → per-item DEK hierarchy, plus the one-column rotation primitive |
| `packages/platform/crypto/src/ports.ts` | `CryptoProvider` (AEAD-shaped, never cipher-shaped), `X25519Provider` (byte-shaped curve keys), and `KeystoreAdapter`. DECLARED here, implemented NOWHERE in the package — the `SessionStorageAdapter` precedent |
| `packages/platform/crypto/src/recipient-wrap.ts` | `wrapDekFor` / `unwrapDekWith` / `RecipientWrapPort` — X25519 sealed-box org sharing: fresh ephemeral per wrap, HKDF binding both public keys, AAD role `0x02` |
| `packages/platform/crypto/src/recovery.ts` | `generateRecoveryCode` / `deriveRecoveryKey` / `escrowRootKey` / `recoverRootKey` / `RecoveryPort` — Crockford-encoded 256-bit code, escrow envelope under AAD role `0x03` |
| `packages/platform/crypto/src/device-sync.ts` | `exportForDevice` / `importFromDevice` / `DeviceSyncPort` — the root key in transit under a channel-key-derived key, AAD role `0x04` |
| `packages/platform/crypto/src/webcrypto-provider.ts` | `createWebCryptoProvider()` — the shipped AEAD/HKDF provider (Node >= 22, every evergreen browser). Returns `null` where there is no Web Crypto rather than throwing |
| `packages/platform/crypto/src/webcrypto-x25519.ts` | `createWebCryptoX25519Provider()` — the shipped X25519 provider (the Secure Curves spec), bridging raw 32-byte keys to WebCrypto through the fixed RFC 8410 PKCS#8 prefix |
| `packages/platform/crypto/src/index.ts` | The `.` barrel: everything on `./client`, plus both WebCrypto factories |
| `packages/platform/crypto/src/client.ts` | The `./client` barrel: the Metro-safe surface — result vocabulary, envelope codec, keyring, the three seams, and the port TYPES. Reaches for no runtime global |
| `packages/platform/crypto/src/envelope.test.ts` | Roundtrip byte-faithfulness, one distinct reason per decode refusal, the AAD injectivity properties, and the five-role pairwise-distinctness matrix |
| `packages/platform/crypto/src/keyring.test.ts` | The hierarchy over the REAL provider: fresh DEK per seal, wrap/unwrap, the moved-row/user/table/column and role-swap refusals, and the rewrap suite (same DEK, untouched item envelope, old KEK refused) |
| `packages/platform/crypto/src/webcrypto-provider.test.ts` | VECTOR conformance (seal must reproduce the published AES-256-GCM `ct‖tag` and RFC 5869 OKM byte-exactly), plus tamper cases on ciphertext, AAD and tag |
| `packages/platform/crypto/src/webcrypto-x25519.test.ts` | The RFC 7748 §5.2 scalar-mult and §6.1 Diffie-Hellman vectors against the REAL engine, the base-point public-key identity, and the all-zero contributory refusal |
| `packages/platform/crypto/src/recipient-wrap.test.ts` | Wrap/unwrap roundtrip, a COMMITTED known-answer wire (fixed ephemeral injected through a provider double), and the refusal set: moved recipient, tampered ephemeral, wire-version, role swap |
| `packages/platform/crypto/src/recovery.test.ts` | Code format and confusable tolerance, a committed encoding answer, escrow/recover roundtrip, moved-escrow and malformed-code refusals |
| `packages/platform/crypto/src/device-sync.test.ts` | Export/import roundtrip, wrong-channel-key and moved-account refusals, and the same-key role-byte cross-refusal against recovery |
| `docs/modules/e2ee/mobile-provider.patch.md` | The documented patch for a MOBILE `CryptoProvider` + `X25519Provider` + `KeystoreAdapter` — a primitive dependency is a decision made deliberately, not defaulted |

`@app/crypto` is a dual-barrel package and its census entry is already in
`tools/exports-walls.json` with the reason: `.` carries providers that reach
for `crypto.subtle`, **Hermes ships no Web Crypto**, and Metro does not
tree-shake — so a mobile import of `.` would put factories reaching for an
absent global into the native binary. That is the whole reason for the split.

## Prerequisites

- Node >= 22 (or any evergreen browser) for the shipped providers and for the
  vitest lane — both AES-GCM/HKDF and X25519 (the Secure Curves spec). Nothing
  else: the package has no runtime dependency, only `vitest` as a
  devDependency.
- For a MOBILE surface: providers and a keystore you supply, per
  `docs/modules/e2ee/mobile-provider.patch.md`. Nothing in this module works on
  a device until you apply it — the module ships no native crypto dependency
  and both WebCrypto factories return `null` under Hermes.
- Before any of it: a decision recorded in an ADR (`/adr <slice>`) about WHICH
  columns are encrypted and which residuals below you are accepting. Some are
  not recoverable after the fact — a column encrypted for a year cannot be
  retroactively made searchable, and a user who loses the device AND the
  recovery code cannot be given their data back.

## How enabling works

```
npx next-expo-supabase-agent-harness enable e2ee
```

copies `packages/platform/crypto/**` and these docs. The seven test files join
`pnpm test` — and therefore the Stop hook and CI — at once, with no wiring
step: they prove the shipped code against published vectors and committed
known answers, not against a mock. No `tools/harness.config.mjs` change; no
gate is added.

Nothing consumes the package until you write a feature that does. The authoring
recipe is the `authoring-e2ee-feature` skill.

## The key hierarchy

```
rootKey — 32 bytes from the platform CSPRNG, lives in the platform keystore
  ├─ KEK = HKDF-SHA-256(rootKey, salt = 32 zero bytes, info = "app-e2ee/v1/item-wrap")
  │    └─ per-item DEK — a FRESH 32 CSPRNG bytes on EVERY seal
  │         ├─ item envelope    = AES-256-GCM(DEK, plaintext, AAD role 0x00)
  │         ├─ wrapped-DEK env  = AES-256-GCM(KEK, DEK,       AAD role 0x01)
  │         └─ recipient wire   = 0x01 ‖ eph_pk ‖ AES-256-GCM(wrapKey, DEK, AAD role 0x02)
  │              where wrapKey = HKDF(X25519(eph_sk, recipient_pk),
  │                                   info = "app-e2ee/v1/recipient-wrap" ‖ eph_pk ‖ recipient_pk)
  ├─ escrow envelope = AES-256-GCM(recoveryKey, rootKey, AAD role 0x03)
  │    where recoveryKey = HKDF(recovery-code bytes, info = "app-e2ee/v1/recovery")
  └─ sync envelope   = AES-256-GCM(syncKey, rootKey, AAD role 0x04)
       where syncKey = HKDF(channelKey, info = "app-e2ee/v1/device-sync")
```

Four choices carry the weight, and each buys something specific:

- **The root key never encrypts anything.** It is HKDF input — or, for escrow
  and sync, AEAD *plaintext* — but never an AEAD key. `info` is the domain
  separator (`app-e2ee/v1/<purpose>`), the salt is 32 zero bytes because
  RFC 5869 §3.1 defines absent salt exactly that way and the separation this
  hierarchy needs lives in `info` — a per-install salt would buy nothing and
  cost a second stored secret.
- **A fresh DEK per seal, a fresh ephemeral per wrap.** No key ever encrypts
  twice, so a 96-bit random IV never approaches the birthday bound that makes
  IV reuse under GCM catastrophic — and a reused X25519 ephemeral would link
  every wrap it made, so `wrapDekFor` mints one per call and drops it. Sealing
  the same plaintext twice produces different bytes on every seam; the tests
  assert it.
- **The DEK is WRAPPED, not derived.** A derived DEK would be recomputable from
  the root key forever. A wrapped DEK exists only in its column — which is what
  makes crypto-shredding real: **deleting a row's `*_wrapped_dek` column renders
  that row's ciphertext permanently unreadable, while the root key lives on for
  every other row.** It is also what makes both sharing and rotation possible:
  the SAME DEK can be wrapped again — to an org-mate's public key
  (`wrapDekFor`) or under a new KEK (`rewrapItemKey`) — without the item
  ciphertext moving or the plaintext appearing.
- **AAD is mandatory, and the ROLE BYTE spans the whole module.** Five roles:
  `0x00` item, `0x01` wrapped DEK, `0x02` recipient wrap, `0x03` recovery
  escrow, `0x04` device sync. `buildAad` binds a row's full identity
  (`userId`, `table`, `itemId`, `field`); `buildAadBytes` binds each seam's
  honest identity — both curve points for a recipient wrap, the account for
  escrow and sync — with the same version/alg/role prefix and the same 4-byte
  big-endian length framing. A ciphertext moved to another row, another user,
  another account, or another SLOT **fails authentication** — the tests hold
  all five roles pairwise distinct with everything else equal.

  **Length prefixes rather than a NUL join, and the difference is not
  cosmetic.** A separator is injective only while no field can contain it, and
  the adversarial review demonstrated both halves of that failing: an embedded
  NUL re-split the identity (`u1 / notes / a<NUL>b` collided with
  `u1 / notes<NUL>a / b`), and `TextEncoder` maps every unpaired surrogate to
  the same `U+FFFD`, so distinct `itemId`s collided too. A length prefix removes
  every collision the FRAMING can cause. It does not remove the one the
  ENCODING causes — UTF-8 has no representation for an unpaired surrogate — so
  that residual is asserted in `envelope.test.ts` rather than left as a
  footnote, and it is why `itemId` should come from real column values (a UUID
  primary key is unaffected) rather than from anything user-supplied. Byte
  fields (curve points) never meet TextEncoder and have no such residual.

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
so `|ct| == |pt|`), **a wrapped DEK, an escrow envelope and a sync payload are a
constant 65 bytes each**, and **a recipient wire is a constant 98 bytes** — one
wire-version byte and the 32-byte ephemeral public key in front of a 65-byte
envelope:

```
wireV u8 (0x01) | ephemeralPublicKey (32) | envelope
```

The recipient wire has its own version byte OUTSIDE the envelope because it
frames what the envelope cannot — how many bytes precede it — and its own
decoder refuses with the same discipline: too short and bad wire version get
their own reasons, then the envelope decoder's refusals apply unchanged.

### The failure vocabulary

`CryptoResult<T>` is `{ ok: true, value }` or `{ ok: false, reason, detail? }`.
Seven reasons, closed:

| Reason | What it means | What a caller does |
| --- | --- | --- |
| `aead_auth_failed` | Authentication failed | Render an error state. **This covers BOTH tamper and wrong-key on purpose** — an AEAD cannot tell them apart, and a vocabulary that pretended to would be lying. A wrong recovery code and a moved escrow land here too, for the same reason |
| `envelope_malformed` | Not an envelope, or truncated | The data is broken, not the key. Fix the data |
| `unsupported_version` | An envelope — or a recipient wire — from a FUTURE fleet | Upgrade the client. Distinct from `envelope_malformed` because the remedies are opposite |
| `unsupported_algorithm` | A reserved or unknown alg id | Same: a newer or foreign writer |
| `key_missing` | No root key on this device, or a caller-supplied key the engine refused (a wrong-length KEK, a low-order recipient point) | On this device, this data is unreadable — see recovery, below |
| `keystore_unavailable` | The keystore or engine could not perform | Possibly transient (a half-restored backup, a revoked entitlement) |
| `recovery_code_malformed` | A recovery code that fails DECODING — wrong length, a symbol outside the Crockford alphabet, mangled padding | Ask the user to re-type the code. Distinct from `aead_auth_failed` because "fix your typing" is actionable and "wrong code" deliberately is not |

The package NEVER throws. Mapping a reason onto `appError` codes is the caller's
decision and happens at the boundary — the same split `@app/ratelimit` uses.

## Wiring a host

The package sees no platform API. A host supplies three things.

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
  **never `@app/crypto`**, whose `.` barrel carries the WebCrypto factories.

### `X25519Provider` — only if the feature shares

- **Web / Node:** `createWebCryptoX25519Provider()` from the `.` barrel.
  Browsers and Node >= 22 ship X25519 in WebCrypto (the Secure Curves spec).
  The port trades in RAW 32-byte keys; WebCrypto cannot export a raw X25519
  private key, so the provider bridges through the fixed 16-byte RFC 8410
  PKCS#8 prefix — byte concatenation one way, a VERIFIED strip the other, no
  DER parser to get wrong. A low-order peer point yields an all-zero shared
  secret, which the spec makes the engine reject — the provider answers `null`
  and no all-zero key can reach the HKDF above it.
- **Mobile:** `@noble/curves`, priced in the patch doc like every other
  primitive dependency. A feature that never calls `wrapDekFor` needs no
  X25519 provider on either surface.

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
  weaker on web, and the port's byte shape is now load-bearing — see the
  web-keystore section for why a "stronger" handle-shaped store would break
  recovery and device sync outright.

## The three seams, shipped — each with its honest residual

These were declared, unimplemented ports through 0.x, and each README of that
era stated the loss in full. They are implemented now, and each implementation
retires its loss by CONVERTING it into a smaller, permanent residual — stated
here with the same bluntness, because a shipped seam that hides its residual is
worse than a declared gap.

### Multi-device — crypto shipped, ceremony yours

`exportForDevice` seals the root key under a key derived from a CHANNEL KEY;
`importFromDevice` opens it on the second device; the envelope can transit any
channel — the server included, which cannot open it. **The residual: the
channel key's transport and ceremony are the consumer's,** because pairing UX
is a threat-model decision (a QR code the new device scans assumes the screen
is private; a numeric comparison assumes the user actually compares) that no
shared package should default. The AAD binds the account, so a payload
exported for user A refuses to import into user B's session even over the same
channel key. Entropy in is entropy out: a 6-digit channel code is
brute-forceable by anyone who captures the payload — write the ceremony down,
in the ADR, with the entropy arithmetic.

### Recovery — a generated code, shown once, and an escrow the server cannot open

`generateRecoveryCode` mints 32 CSPRNG bytes and renders them as 13
dash-separated groups of 4 Crockford base32 symbols (no I, L, O or U; case and
confusables are forgiven on decode). `escrowRootKey` seals the root key under
the code-derived key; the escrow envelope is safe to store server-side — it is
ciphertext to everyone without the code, the same show-once discipline as
`invitations.token_digest`. `deriveRecoveryKey` is PLAIN HKDF-SHA-256, and
plain is the point: the input is full-entropy CSPRNG output, so there is no
dictionary to walk and memory hardness would buy latency and nothing else.

**The residual, in the old loss's own words: a lost device AND a lost code is
still lost data** — permanently, for the user and for support, because the
escrow opens with the code-derived key and nothing else. The code must be
stored by the USER (a password manager, paper in a safe); a product that
stores it server-side has reinvented a password reset and should say so.

**The passphrase refusal SURVIVES intact.** A human-CHOSEN passphrase has
guessable entropy and would demand a memory-hard KDF — Argon2id — and WebCrypto
ships none. Shipping PBKDF2 while calling it "the KDF" would be a dishonest
default (no memory hardness; a GPU farm treats it as a speed bump), so
passphrase-derived escrow stays a CONSUMER decision, priced like the mobile
provider prices its dependency: `@noble/hashes` (pure JS, audited) or a native
argon2, wired against this same envelope and AAD role. If you build it, hold it
to RFC 9106 test vectors the way this module holds its providers to theirs.

### Org sharing — a DEK wrapped to a public key; the directory is yours to build

`wrapDekFor` seals a row's DEK to an org-mate's X25519 public key — fresh
ephemeral per wrap, HKDF info and AAD both binding BOTH public keys, sealed-box
semantics: the sender cannot reopen its own output. `unwrapDekWith` needs only
the recipient's secret key (the public half is recomputed from it via the base
point). Deliberately NOT full RFC 9180 HPKE: its modes, PSKs and exporter are
surface this one seam does not need — dead code behind an alg byte — though the
construction is exactly HPKE's DHKEM(X25519)+HKDF+AES-GCM corner.

**The residual: a recipient wrap requires the recipient to HAVE a key pair and
you to FIND their public key — a directory this module does not ship,** because
its trust model (who attests that this public key belongs to that org-mate?) is
a product decision. The honest storage recipe:

```sql
-- The public-key directory: one X25519 public key per user. PUBLIC keys —
-- never a secret key, never an escrow, never a wrapped DEK for someone else.
CREATE TABLE public.user_public_keys (
  user_id    uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_public_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_public_keys FORCE ROW LEVEL SECURITY;

-- Anyone AUTHENTICATED may read any directory row: a public key is public,
-- and sharing requires reading your org-mate's. Writes are self-only: a
-- caller who could write another user's directory row could substitute their
-- own key and receive every future wrap meant for the victim.
CREATE POLICY user_public_keys_select ON public.user_public_keys
  FOR SELECT TO authenticated USING (true);
CREATE POLICY user_public_keys_insert ON public.user_public_keys
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY user_public_keys_update ON public.user_public_keys
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY user_public_keys_delete ON public.user_public_keys
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_public_keys TO authenticated;
REVOKE ALL ON TABLE public.user_public_keys FROM service_role;
```

This is a RECIPE, not a shipped migration — it lands only when a feature
actually shares, in that feature's own reviewed migration, with the usual
company: the audit trigger, the `tools/data-flow.json` record (`user_public_keys`
rows are subject data: `severed[]` on deletion via the CASCADE, and the
projection should include the public key — it is the user's), and a
`security-reviewer` verdict. A `*_shares` table holding the recipient wire
bytes (`bytea`, 98 per share) follows the same pattern, keyed
`(item_id, recipient_user_id)`.

**The trust residual under the recipe: the directory is
trust-on-first-use.** RLS stops a user overwriting someone ELSE's key, but a
compromised server — the adversary this module exists to resist — could serve
the wrong public key at wrap time, and the wrapper would seal to the attacker.
Key fingerprint verification in the UI (or cross-signing) is the next rung on
that ladder, and it is a product decision this README names rather than solves.

## What this deliberately does NOT solve

Each remaining item is a real capability, absent, with its cost stated.

### Key rotation — the primitive ships; the ORCHESTRATION is yours

`rewrapItemKey` makes rotation a one-column rewrite: open the wrapped DEK under
the old KEK, re-seal the SAME DEK (fresh IV) under the new — the item
ciphertext is never touched and no plaintext appears, so a rotation pass is
`SELECT wrapped_dek` → `rewrapItemKey` → `UPDATE wrapped_dek`, per row, on a
client that holds both KEKs. What still does not ship is everything AROUND that
call: **no batch runner, no resume point, no progress record, no way to verify
completion, no serving strategy for a table temporarily in two KEK eras.** A
rotation interrupted at row 4,000 of 10,000 leaves rows under two keys with
nothing recording which is which — design the orchestration as a reviewed data
migration before you need it, not during the incident. (Recipient wraps
reference the DEK, not the KEK, so rotating the root key does not invalidate
shares; a SHARED row's rotation story — re-wrapping to every recipient — is
part of the same orchestration design.)

### Metadata leakage — encryption hides content, not shape

Everything about the row except the plaintext bytes stays server-visible: which
user has how many rows, when each was created and updated, who shares an org
with whom, the access pattern, and **the exact size of every plaintext** — GCM
is a stream mode, so a ciphertext column is `plaintext + 33` bytes and the
length is readable to the byte. The new seams ADD legible metadata of their
own: a share row says WHO can open WHAT (the sharing graph is plaintext to the
server), an escrow row says a recovery code exists, a directory row says the
user can receive shares. No padding ships. If a size, a timestamp, or an edge
in the sharing graph is itself the secret, this module does not address it.

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

### The web keystore — a browser has no hardware keychain

On mobile, the root key sits in the iOS Keychain / Android Keystore: a different
process's storage, unreadable by anything running in the JS sandbox, which is
exactly the property `LargeSecureStore` was built to buy. **On web there is no
equivalent.** Whatever a browser KeystoreAdapter uses — IndexedDB, localStorage
— is same-origin storage readable by any JavaScript that runs on the origin. One
XSS, one compromised dependency in the web bundle, one malicious extension with
host access, and the root key leaves with the attacker; and because the key
decrypts every row, that is a total loss, not a session loss.

**The port's byte shape forecloses the strongest web option — and that is now a
DECISION, not an accident.** `KeystoreAdapter.getRootKey` returns
`Uint8Array | null`; a browser's strongest store is a NON-extractable
`CryptoKey` handle in IndexedDB, whose bytes JavaScript cannot read. Those were
always incompatible. What changed in 1.0.0 is that two shipped seams now
REQUIRE readable bytes: `escrowRootKey` and `exportForDevice` take the root key
as AEAD *plaintext*, and a handle whose bytes cannot be read is a root key that
can never be escrowed or carried to a second device — the non-extractable
"hardening" would quietly reinstate "lost device is lost data". The trade is
recorded on the port itself (`ports.ts`); a web host that wants non-extractable
key material must go around this port AND accept losing both seams, in writing.

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
  root key or an escrow of it. The recovery seam makes the second option less
  hypothetical than it was — an archive can carry the escrow envelope and the
  user's code can open it — but the labelling duty is unchanged. Without key
  material this is not portability and must not be described as such.

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
- Break the X25519 bridge — a wrong PKCS#8 prefix byte, a stripped-at-the-wrong-
  offset scalar, a swapped argument order — and the RFC 7748 §5.2/§6.1 vectors
  fail, because the engine receives a different scalar than the RFC published.
- Change the recipient wire format, the HKDF info string, the AAD field order,
  or the role byte → the COMMITTED known-answer wire in `recipient-wrap.test.ts`
  changes byte-for-byte and the test fails. The fixed ephemeral it needs is
  injected through a provider double — the production API carries no test seam.
- Return the all-zero shared secret instead of refusing a low-order point → the
  contributory-behaviour test fails (`deriveSharedSecret` must answer null).
- Remove the AAD from `sealItem`/`openItem`, drop a role byte, or collapse two
  roles to one value → the moved-row/user/table/column cases, the five-role
  pairwise matrix, and the same-key cross-role refusals all go green in the
  wrong direction and fail.
- Make `rewrapItemKey` mint a fresh DEK instead of carrying the old one → the
  same-DEK test fails (it unwraps both columns and compares the keys, not the
  envelopes).
- Change the recovery alphabet, bit order, or grouping → the committed encoding
  answer fails; accept a mangled final symbol → the padding-bits refusal fails.
- Reuse a DEK across seals (derive instead of mint) → the fresh-DEK test fails.
- Add a version byte or alg id without a decode branch → the decode-refusal
  tests fail, each of which asserts its own distinct reason.
- The vector data is checked before anything is asserted against it:
  `|ciphertext| == |plaintext|` and a 16-byte tag per GCM vector. That invariant
  caught one vector's published answer transcribed under another's inputs during
  authoring — a typo that would otherwise have surfaced as an implementation-bug
  report.

## Honest limits of the shipped half

- **`unsupported_version` has no upgrade path attached.** The version bytes
  (envelope and recipient wire) make a format change a decode branch; they do
  not write the branch, and nothing ships that reads a v2 of either.
- **`KeyContext` carries no org.** It binds `userId`, `table`, `itemId`,
  `field`. On a table whose primary key is `(org_id, id)` the AAD binds only
  `id`, which is safe while ids are `gen_random_uuid()` and unsafe the moment a
  consumer uses a composite or natural key. If your row identity needs more
  than one column, encode the whole identity into `itemId` yourself.
- **The escrow and sync AADs bind the ACCOUNT and nothing else.** That is the
  honest identity those ceremonies have — there is no row — so a moved escrow
  fails only across accounts, not within one: a user's newest escrow envelope
  and an old, superseded one are distinguishable only by your own storage
  discipline (keep one escrow row per user, replace on re-issue).
- **The `cryptography` provenance group keys on the construction CHOICE, not on
  the vocabulary.** `aeadSeal`/`aeadOpen`, an AEAD or KDF naming, and the
  wrapping structure owe a citation; `getRandomValues`, `randomUUID` and
  `createHash` deliberately do not, because reading the platform CSPRNG is the
  correct act at a dozen sites that are not cryptographic trade-offs. A
  hand-rolled construction that avoids all four patterns owes nothing to the
  gate and everything to the reviewer.
- **`deriveKek` accepts exactly one purpose** (`'item-wrap'`). The three seams
  derive their keys through their own fixed `info` strings, not through
  `deriveKek` — adding a second KEK purpose is a one-line union widening, but
  every purpose is a new domain-separated key and therefore a new thing to
  rotate.
