---
name: authoring-e2ee-feature
description: >
  The decide-the-columns -> schema -> ciphertext DAL -> seal/open at the screen -> store-policy
  -> DSR record -> reviewers recipe for encrypting one feature end-to-end with the opt-in e2ee
  module, so the server never holds plaintext or a key that decrypts it. Use when asked to
  encrypt a feature, add client-side encryption, or make a column unreadable to the server.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
argument-hint: "[feature-name]"
---

# Authoring an E2EE feature

Encryption sits ON TOP of the authorization boundary, never in place of it: RLS keyed on
`auth.uid()` still decides which rows a caller may read, and `@app/crypto` decides whether
the bytes mean anything once read. Everything in the `authoring-vertical-slice` recipe still
applies — migration, RLS, `./client` read, procedure, both screens, tests, provenance, green
gate. This recipe is what that slice gains when a column must be unreadable to the server,
and what it LOSES in exchange.

Build in this strict order. Steps 1, 5, 6 and 7 are irreversible-ish in different ways: a
column encrypted for a month cannot be retroactively indexed, and a user whose device is gone
cannot be given their data back.

## Step 0 — preconditions, all three

Do not start until all of these are true:

1. **The module is enabled** — `packages/platform/crypto/` exists (`@app/crypto`). If it does
   not, the module is opt-in and enabling it is a separate, reviewed act: read
   `docs/modules/e2ee/README.md` first, in particular "What this deliberately does NOT solve".
2. **Host adapters are wired.** `createWebCryptoProvider()` covers web and Node and returns
   `null` where there is no Web Crypto. The MOBILE `CryptoProvider` and BOTH surfaces'
   `KeystoreAdapter` are consumer code — `docs/modules/e2ee/mobile-provider.patch.md` is the
   recipe. Hermes ships no Web Crypto, so on a device the whole feature computes nothing until
   the patch is applied. Check before writing a screen that assumes otherwise.
3. **The decision is recorded in an ADR** (`/adr <slice>`), naming the columns, the losses
   accepted from step 1, the sign-out policy for the root key, and the export stance from
   step 6. This ADR is the one a reviewer reads instead of re-deriving your threat model.

## The order

### 1. Decide WHICH columns are encrypted, and accept the consequences

Per column, not per table. Encrypt the column that carries the secret; leave the columns that
carry the shape. For each column you choose, you are accepting all of the following, and the
ADR must say so in words:

- **No server-side search, sort, or filter.** Not `LIKE`, not `ILIKE`, not `tsvector`
  full-text, not trigram, not a vector index, not `ORDER BY`, not a `WHERE` predicate on
  content. Every one of those reads bytes the database cannot interpret. If the feature needs
  search, choose per column: client-side search over a downloaded set (bounded by what a
  device can hold, and it does not paginate), or do not encrypt that column. A searchable
  title beside an encrypted body is a normal, defensible split.
- **No server-side validation of content.** No `CHECK` on the value, no length constraint that
  means anything (the ciphertext length is `plaintext + 33` bytes and tells you only that),
  no uniqueness constraint, no trigger that reads it. Validation moves to the client, where it
  is advisory — a client is an untrusted bearer, so a malicious client can write whatever
  ciphertext it likes into its own row.
- **No audit value capture, ever.** The trail records WHICH columns changed, never what they
  became. Capturing a ciphertext value would be pointless and would still make `audit.events`
  a second, less-policied copy — step 2 puts both columns on the deny list.
- **No server-side derived data.** No excerpt, no word count, no embedding, no thumbnail, no
  notification body quoting the content. Anything the server computes from the plaintext is a
  plaintext leak with extra steps.
- **Org-mates cannot read it.** `RecipientWrapPort` is declared and unimplemented, so a DEK is
  wrapped to exactly one principal. In this org-scoped scaffold RLS admits the org-mate to the
  row and they receive ciphertext they cannot open. If the column is meant to be shared, this
  recipe is the wrong tool.

### 2. Schema — two columns, and the same RLS as any other table

Two `bytea` columns per encrypted field, both `NOT NULL`:

```sql
  body_ciphertext  bytea NOT NULL,
  body_wrapped_dek bytea NOT NULL,
```

- **No version column.** The envelope version byte lives INSIDE the envelope (`magic | v |
  alg | ivLen | iv | ct`), so there is nothing to drift: a row and its declared version cannot
  disagree, because they are the same bytes. A separate `*_version smallint` column would be a
  second source of truth that a partial write can desynchronize.
- `NOT NULL` on both is correct for the WRITE path — a row must never exist with ciphertext
  and no key. Crypto-shredding (step 6) is then either deleting the row, or overwriting the
  wrapped-DEK column with a zero-length `bytea`, which `decodeEnvelope` refuses as
  `envelope_malformed` — a typed, deliberate tombstone that keeps the constraint intact.
- **No index on either column.** Nothing can use one.

Everything else is EXACTLY the ordinary table, because RLS is still the authorization
boundary and an encrypted table gets no relief from it. In the SAME migration: `ENABLE` +
`FORCE ROW LEVEL SECURITY`, four per-operation policies `TO authenticated` (never `FOR ALL`,
never `TO public`) using only the two legal predicate shapes over `org_id`, a leading-column
owner index that carries the ORDERING as well as the filter, `REVOKE ALL` from `service_role`,
the explicit `GRANT` per operation the policies admit, and the audit trigger with **no `WHEN`
clause**. Read `.claude/skills/authoring-vertical-slice/references/migration-rls.md` and
follow it exactly — including re-casing the RLS statements to UPPERCASE so the provenance
heuristic can see them.

Order by `created_at`/`id` as always; the encrypted column can never participate in a cursor.

Then register both columns in `tools/pii-columns.json`, one entry each with a reason:

```json
{
  "table": "notes",
  "column": "body_ciphertext",
  "reason": "Customer content under client-side encryption. Capturing the VALUE in the audit trail would copy an unreadable blob into a table read by every rank-30 admin — all of the storage cost and republication risk of value capture, none of the diagnostic value, since nothing server-side can open it."
}
```

`tools/check-tenancy.mjs` closes this both ways: it reds when a listed column appears as a
captured column in an `audit.write_row(...)` trigger argument, and reds again when an entry
names a column no migration creates — so the list cannot go stale as the schema moves. The
file is a seeded escape list: edit it, commit it, and the widening appears in the PR under
CODEOWNERS.

### 3. The DAL returns ciphertext DTOs on `./client`, and never sees a key

The vertical's `./client` barrel exports the direct RLS read exactly as always: it TAKES a
per-request Supabase client, returns zod DTOs from `@app/contracts` wrapped in the
`ActionOutcome` envelope from `@app/errors`, never raw rows and never a thrown domain failure.
The only change is what the DTO carries.

- **The DTO carries ciphertext, and the DAL holds no key, no provider, and no `KeyContext`.**
  It cannot open a row and must not try. This is the property that makes the server-rendered
  path honest: a Server Component reading this DAL renders a skeleton or a locked state, never
  content.
- `bytea` arrives over PostgREST as a hex-encoded string (`\x…`), so the DTO field is a
  BOUNDED string like every wire string in the repo (`.max()`; the escape is a reviewed
  `tools/dto-bounds-allow.json` entry) and the vertical converts to `Uint8Array` at its edge.
  Verify the encoding against your own query probe before pinning the schema rather than
  trusting this sentence.
- Both columns travel together or neither does. A DTO that carries `*_ciphertext` without
  `*_wrapped_dek` is a row nothing can open; make them one object in the DTO so a select list
  cannot drop half of it.
- Keyset pagination, unconditional `LIMIT`, and the query probe under
  `src/data/query-probes.ts` as usual — then `pnpm gen` so the committed manifests match.

### 4. Seal and open at the screen layer, through the injected provider

The plaintext exists in exactly one place: the client, above the DAL.

```ts
const ctx: KeyContext = { userId, table: 'notes', itemId: noteId }
const sealed = await sealItem(provider, kek, new TextEncoder().encode(body), ctx)
// sealed.envelope   -> body_ciphertext
// sealed.wrappedDek -> body_wrapped_dek
```

- **The `KeyContext` is built from `{ userId, table, itemId }` and is the AAD.** A ciphertext
  moved to another row, another table, or another user FAILS AUTHENTICATION. Build it from the
  verified session's user id and the row's own id — never from a value the form supplied,
  which would let a caller bind their ciphertext to somebody else's identity string.
- **`itemId` must be the WHOLE row identity.** `KeyContext` has no org field, so on a table
  keyed `(org_id, id)` the AAD binds only `id`. That is safe while ids are
  `gen_random_uuid()`; if your identity is composite or natural, encode all of it into
  `itemId` yourself.
- The provider and the KEK are INJECTED — from the host provider plus `deriveKek(provider,
  rootKey, 'item-wrap')`. A screen never imports `@app/crypto` on mobile (that barrel carries
  the WebCrypto factory and Metro does not tree-shake); it imports `@app/crypto/client`.
- **A screen cannot reach a primitive directly and should not try.** The
  `crypto-primitives-one-door` ESLint rule reds a `crypto.subtle` reach or a `node:crypto`
  cipher/KDF import anywhere outside its two sanctioned homes — the provider package and
  `apps/*/src/host/**` — so the only path from a feature to a cipher is the injected port.
  If you find yourself wanting a primitive here, the design took a wrong turn one layer up.

**Map `CryptoResult` reasons onto `appError` codes at the boundary, once**, the same
caller's-decision split `@app/ratelimit` uses. A defensible mapping, and the ADR records
whichever you pick:

| reason | code | why |
| --- | --- | --- |
| `aead_auth_failed` | `appError.unknown()` | Tamper OR wrong key — an AEAD cannot distinguish them, so the message must not claim to. Never `validation`: the user typed nothing wrong |
| `envelope_malformed` | `appError.unknown()` | Broken data, not a broken key |
| `unsupported_version` | `appError.conflict()` | The client is behind the data — the same fact the version-skew guard already signals with CONFLICT |
| `unsupported_algorithm` | `appError.conflict()` | Same shape: a newer or foreign writer |
| `key_missing` | `appError.unavailable()` | No key on THIS device. Honest limit: no code in the taxonomy means "unreadable here forever", so the copy has to carry that, not the code |
| `keystore_unavailable` | `appError.unavailable()` | Possibly transient — a half-restored backup, a revoked entitlement |

- **A corrupt read renders an error state, never a crash.** `@app/crypto` never throws, so the
  only way to get a crash is to write one: a non-exhaustive switch, a `!` on a result, a
  `JSON.parse` of a failed open. The route's `states.error` testID is what the sweep asserts.
- Error copy comes from the envelope's stable `code` through `src/i18n/errors.ts`, never a raw
  message — and **never the `detail` field**, which names row identities.
- **No key, no plaintext, and no `detail` in a log line, a DTO, an error message, an analytics
  event, or a crash report.** The provider does not log; neither does this layer.

### 5. Flip the export-compliance declaration, in the SAME diff

Shipping real cryptography is a store-review fact. In one commit: `tools/store-policy.json`
`iosEncryption` to `{ "nonExemptAllowed": true, "reason": "<why, non-empty>" }`, and
`ios.infoPlist.ITSAppUsesNonExemptEncryption: true` in `apps/mobile/app.config.ts`.
`node tools/check-expo-policy.mjs` enforces both directions over the RESOLVED config — the
declaration must be a boolean either way, `true` without the policy escape reds, and the
escape without a reason reds. `tools/store-policy.json` is write-guard-protected: an agent
cannot make this edit, a human does. Mechanics and the gate-integrity caveat are in
`docs/modules/e2ee/mobile-provider.patch.md` §6.

### 6. The DSR work the feature MUST do

`tools/data-flow.json` is the reviewed inventory of what survives a deletion and what a
portability request returns, and `node tools/check-data-flow.mjs` closes it against the schema
both ways. An encrypted surface has to appear in it, with three things written down:

- **A record for the surviving columns.** Both new columns land in `severed[]` or `retained[]`
  by the same rule as any other column — the bucket follows the foreign-key graph, not the
  encryption. A `retained[]` entry needs a `procedure` naming a committed file that answers
  the request, and the gate requires that file to exist.
- **The crypto-shred note on erasure.** Say it explicitly in the reason text: deleting a row's
  `*_wrapped_dek` value renders that row's ciphertext permanently unreadable by anyone,
  including the operator, while the root key lives on for every other row. That makes erasure
  a cryptographic fact rather than a promise about a backup rotation — and it is the strongest
  erasure statement anything in this schema can make. State its limit in the same breath: the
  ciphertext BYTES remain in the table and in every backup; what is destroyed is the ability to
  read them.
- **The export stance.** An export of ciphertext the subject cannot decrypt is not
  portability. Either decrypt client-side at export time (the natural fit — `system.exportMyData`
  already runs AS THE CALLER under RLS, on a client that holds the key), or ship
  ciphertext plus wrapped keys and LABEL it as such, which is only honest if the archive also
  carries the envelope format, the algorithm, the AAD construction, and the key material.
  Record which, and know that the gate **cannot tell ciphertext from plaintext** in a
  projection — `body_ciphertext` satisfies it exactly as `body` would, so this one is on you
  and the reviewer.

Then add the addendum to `docs/runbooks/data-subject-requests.md`: a row in the "What it does
NOT do" table for the encrypted surface, and a paragraph under the portability section saying
what an operator can and cannot do. The honest sentence to include: support cannot read,
recover, or re-key this content for a user, because no server-side path to the key exists —
that is the design working, and it is what makes the runbook's other promises credible.

### 7. Reviewers — two of them, and one new trigger row

`security-reviewer` and `mobile-security-reviewer` MUST both return `VERDICT: PASS`. The
migration, the DAL and the API paths already summon `security-reviewer`; the host adapters and
`tools/store-policy.json` already summon `mobile-security-reviewer`. What no trigger covers is
the crypto package itself, so add the row to `tools/reviewer-triggers.json`:

```json
{ "agent": "security-reviewer", "paths": ["packages/platform/crypto/**"] }
```

merged into that reviewer's existing `paths[]` (keep its `why` and `except`). The file is a
SEEDED escape list — `update` plants it once and never clobbers it — so an existing install
adds this row itself, in a reviewed commit; it does not arrive with an upgrade.

The checklist those reviewers are running, and that you run first:

- [ ] **AAD binds row identity.** Every `sealItem`/`openItem` call passes a `KeyContext` built
      from the verified user id and the row's own id — not a form value, not a constant, not a
      partial identity on a composite key.
- [ ] **No key material anywhere it can be read.** Not in a log line, a DTO, an error message,
      a crash report, an analytics event, a test fixture that is also a seed, or module state
      that outlives the session. `detail` strings name row identities and are for developers,
      not for users or logs.
- [ ] **The vectors are untouched.** The known-answer vectors in `src/webcrypto-provider.test.ts`
      are published answers. A diff that edits a vector to make a test pass has inverted the
      test: the vector is the oracle, the implementation is the subject.
- [ ] **The store policy is flipped**, with a non-empty reason, in this diff.
- [ ] The DAL holds no key. The server holds no plaintext. Neither claim has an exception
      "just for the export path" or "just for the admin screen".

### 8. Provenance, ADR, green gate

- `// SOURCE:` on every non-trivial decision site, citing an entry whose `groups` cover the
  **`cryptography`** class. That group is BUILT IN (`tools/lib/provenance-rules.mjs`), not a
  `tools/decision-groups.json` entry — deliberately, because that file is seeded and an edit
  there never reaches an existing install, while this doctrine binds every consumer. It is
  keyed on the CONSTRUCTION CHOICE, so these are the sites that owe a citation: `aeadSeal` /
  `aeadOpen` calls and their parameters, an `AES-GCM` / `XChaCha20` / `ChaCha20-Poly1305`
  naming, a KDF selection (`hkdf`, `deriveBits`, `Argon2`, `scrypt`, `PBKDF2`), and the
  wrapping structure (`deriveKek`, `wrapDek`, `unwrapDek`). It deliberately does NOT key on
  `getRandomValues`, `randomUUID` or `createHash` — reading the platform CSPRNG is the correct
  act at a dozen sites that are not cryptographic trade-offs at all.
  The corpus already carries the authorities, each tagged `cryptography`: `ietf/rfc5116-aead`
  (the AEAD interface — the ciphertext carries the tag; decryption fails as a unit),
  `nist/sp800-38d-gcm` (the 96-bit IV recommendation and IV uniqueness per key),
  `ietf/rfc5869-hkdf` (extract-and-expand; `info` is the domain separator), `w3c/webcrypto`,
  `ietf/rfc9106-argon2` and `libsodium/sealed-boxes`. Verify each resolves with the
  `corpus_search` MCP tool mid-turn; if your decision needs an authority none of them
  grounds, extend the corpus in the PR that first cites it.
- Emit the ADR via `/adr <slice>`; its **Sources** section mirrors every inline `// SOURCE:`,
  and its Consequences section carries the losses from step 1 in plain words. Run
  `/verify-citations` until it returns `CITATIONS: CLEAN`.
- Finish only when `pnpm validate`, `pnpm test:rls`, `pnpm test` and `pnpm test:mobile` are
  green, both security reviewers have answered `PASS`, and the `design-reviewer` has answered
  `PASS` on any UI the slice touched.

## What this recipe will NOT let you do

Three ports in `packages/platform/crypto/src/ports-declared.ts` are declared and implemented
nowhere, and no step above works around them:

- **`RecipientWrapPort`** — you cannot share an encrypted row. An org-mate whose RLS policy
  admits the row receives ciphertext they cannot open.
- **`RecoveryPort`** — you cannot recover. Lost device is lost data, for the user and for
  support, permanently. WebCrypto ships no Argon2 and shipping PBKDF2 as "the KDF" would be a
  dishonest default, so the port refuses rather than pretends.
- **`DeviceSyncPort`** — you cannot carry the key to a second device. A second sign-in sees
  the rows and cannot read them.

And two things no port names: **rotation** (the keyring exports no rewrap primitive, so
changing the root key is an `openItem`→`sealItem` pass over every row with nothing shipped to
orchestrate, resume or verify it) and **metadata** (row counts, sizes to the byte, timestamps
and who-has-how-many stay server-visible — encryption hides content, not shape).

If the feature needs one of these, say so in the ADR and design it deliberately; do not
half-build it inside a slice. The full statement of the losses, each with its cost, is
`docs/modules/e2ee/README.md` under "What this deliberately does NOT solve".
