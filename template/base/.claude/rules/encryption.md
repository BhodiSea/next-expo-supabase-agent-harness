# Encryption invariants (always loaded; also hook- and lint-enforced)

These are non-negotiable wherever client-side encryption exists in this repo. Like
`security-invariants.md`, every bullet below states the MACHINE that holds it —
because a doctrine bullet with no twin is a sentence, and a sentence is what the
enforcement layers exist to replace. Where a bullet has no twin yet, it says so
in the same breath rather than borrowing credibility from its neighbours.
SOURCE: docs/harness/README.md (the always-loaded rules surface)

**This rule is always loaded; the `e2ee` module that implements it is opt-in.**
Until `npx next-expo-supabase-agent-harness enable e2ee` puts `@app/crypto` in
`packages/platform/crypto/`, bullets 2 through 5 have no code to govern — they
are the shape any encryption in this repo must take, and hand-rolling one
instead of enabling the module is the decision they exist to discourage. The
full statement of what the module does NOT solve, each loss with its cost, is
`docs/modules/e2ee/README.md`.

- **RLS keyed on `auth.uid()` remains THE authorization boundary. E2EE is
  confidentiality ON TOP of it, never a replacement for it.** Encryption decides
  whether bytes mean anything; RLS decides who may fetch them, and an encrypted
  table gets no relief from a single policy, grant, index, `FORCE`, or audit
  trigger. A table whose ciphertext columns are world-readable is a broken table
  with an intact cipher — the cipher is not the thing that failed. *Twin: the
  whole `schema-rls` / `tenancy` suite, UNCHANGED — `tools/check-rls-manifest.mjs`
  closing policy → grant, `tools/check-tenancy.mjs` on the tenant key, and both
  isolation twins (`supabase/tests/**` pgTAP and `tests/rls/`) proving tenant B
  cannot read A on every reset. Nothing in that suite knows or cares that a
  column is encrypted, which is the point.*

- **The server never holds plaintext, and never holds a key that decrypts it.**
  Keys are born client-side from the PLATFORM CSPRNG — `crypto.getRandomValues`
  on web, `expo-crypto` on device — and live in the platform keystore, reached
  through one door per host. Never `Math.random()`, never a passphrase without a
  memory-hard KDF, never a user id or a timestamp, never a value the server
  chose or ever saw. The DAL takes ciphertext DTOs and holds no key; a Server
  Component renders a locked state, not content. *Twins: the
  `crypto-primitives-one-door` ESLint rule — primitives arrive through the
  injected `CryptoProvider`, never a direct `crypto.subtle` reach or a
  `node:crypto` cipher/KDF import, with exactly two sanctioned homes named in
  `eslint.config.mjs` rather than inside the rule (the provider package
  `packages/platform/crypto/src/**` and the platform-native seam
  `apps/*/src/host/**`), so widening shows up in a config diff; the
  `no-insecure-random-in-crypto-scope` rule, scoped to those same two surfaces —
  where key material is BORN — and deliberately including tests, because a
  fixture key from `Math.random` is how a weak key reaches a snapshot and then a
  copy-paste; the `math-random-key-material` and `hardcoded-key-material`
  write-guard rules, which catch the same two acts on an Edit FRAGMENT and on
  files lint's globs do not reach (the second denies a 64-hex literal assigned
  into a key-shaped name — a fixture key one copy-paste from a production
  constant); the mobile host-seam restricted import (`expo-secure-store` under
  `apps/mobile/src/host/**` and nowhere else, with depcruise holding the same
  wall on the resolved graph); the `boundaries` gate over
  `tools/exports-walls.json`, which keeps the WebCrypto provider on the `.`
  barrel out of a Metro bundle that cannot tree-shake it away; and the `secrets`
  gate on `EXPO_PUBLIC_`/`NEXT_PUBLIC_` name shapes.*

- **AEAD only, versioned envelope only, and the AAD binds row identity.** Never
  a bare cipher, never a static or reused IV, never an unauthenticated mode,
  never a truncated tag. Every sealed byte-string is one envelope — `magic | v |
  alg | ivLen | iv | ct`, tag inside `ct` — so algorithm agility lives in one
  place and one decoder can refuse; the version byte lives INSIDE the bytes so
  no schema column can drift away from the format it claims. The AAD binds
  version, algorithm, a ROLE byte, and then `userId`, `table`, `itemId` and
  `field`, each preceded by its own 4-byte big-endian LENGTH — not joined by a
  separator, because a separator is injective only while no field can contain
  it, and an adversarial review broke both halves of that (an embedded NUL
  re-split the identity; `TextEncoder` folds every unpaired surrogate to one
  `U+FFFD`). So a ciphertext moved to another row, table, or user FAILS
  AUTHENTICATION rather than decrypting in the wrong place. *Twins: the `@app/crypto` API SHAPE, which
  offers no unauthenticated path — `CryptoProvider` has `aeadSeal`, `aeadOpen`,
  `hkdfSha256` and `randomBytes` and nothing else, so a provider written against
  it cannot be misused into a raw block operation; and its tests, which ride the
  `unit` Stop step: `webcrypto-provider.test.ts` holds seal to the published
  vectors byte-exactly (a roundtrip test passes for the wrong cipher — a vector
  test does not) and tampers ciphertext, AAD and tag; `keyring.test.ts` proves
  the moved-row, moved-user, role-swap and wrong-key refusals; `envelope.test.ts`
  gives every decode refusal its own distinct reason. And the
  `weak-crypto-algorithm` write-guard rule, which denies the WRITE that reaches
  for a broken construction — ECB (it leaks plaintext structure block by block),
  the legacy `createCipher()` (it derives a key with a static IV), MD5, SHA-1,
  DES, RC4 — matched in ALGORITHM-ARGUMENT position so prose, a variable named
  `md5sum`, or a migration comment cannot trip it. **Its stated limit: it names
  the broken constructions it knows.** A novel hand-rolled cipher in a file that
  never imports `@app/crypto` is caught by `crypto-primitives-one-door` if it
  reaches an engine, and by a reviewer if it does not.*

- **A wrapped-key column is the erase lever.** The DEK is WRAPPED, never derived,
  so deleting a row's `*_wrapped_dek` value renders that row's ciphertext
  permanently unreadable — by the user, by support, by an operator with the
  database — while the root key lives on for every other row. That is
  crypto-shredding, and it is the strongest erasure statement anything in this
  schema can make; state its limit in the same breath, because the ciphertext
  BYTES survive in the table and in every backup, and what is destroyed is only
  the ability to read them. This repo already has the "never readable back" SQL
  precedent: `public.invitations.token_digest` stores `sha256` of a token that
  `create_invitation` returns in plaintext EXACTLY ONCE, so no admin can read a
  pending token out of the table and redeem it. *Twin: the `authoring-e2ee-feature`
  skill's MANDATORY `tools/data-flow.json` record — every surviving column lands
  in `severed[]` or `retained[]` with a written reason, `node tools/check-data-flow.mjs`
  reds an unreviewed surviving site AND a reviewed site the schema no longer
  has, and a `retained[]` entry's `procedure` must name a file that exists. The
  gate cannot know a column holds a wrapped DEK; the reason text is where that
  fact is recorded, which is why the record is mandatory rather than advisory.*

- **An export must contain what the USER can decrypt.** GDPR Art. 20 asks for
  the subject's data, and a ZIP of bytes the subject cannot open is not
  portability — it is the appearance of compliance. An encrypted feature either
  decrypts client-side at export time (the natural fit: the export surface
  already runs AS THE CALLER under RLS, on a client that holds the key), or
  ships ciphertext plus wrapped keys LABELLED as such, which is honest only when
  the archive also carries the envelope format, the algorithm, the AAD
  construction and the key material. *Twins: the skill's mandatory export
  stance, plus `node tools/check-data-flow.mjs`'s two-way closure — a projected
  column no migration creates reds, and a subject-data table that is neither
  projected nor excluded reds, and `export.surface` must name a delivered
  procedure or carry a dated deferral. **Its stated limit: the gate closes
  column NAMES against the schema and cannot tell ciphertext from plaintext** —
  `body_ciphertext` in the projection satisfies it exactly as `body` would. That
  half is the reviewer's.*

- **Ciphertext columns join `tools/pii-columns.json`, because an audit trail
  must never capture even a ciphertext value.** The trail defaults to metadata —
  WHICH columns changed, never what they became — and capturing an encrypted
  value would carry every cost of value capture (a second, less-policied copy in
  a table every rank-30 admin can read; a trail larger than the table it audits)
  with none of the diagnostic benefit, since nothing server-side can open it.
  *Twin: `tools/check-tenancy.mjs`'s capture refusal, which reds when a listed
  column appears as a captured column in an `audit.write_row(...)` trigger
  argument — and reds again when an entry names a column no migration creates,
  so the deny list cannot go stale as the schema moves under it.*

- **Shipping real cryptography flips `tools/store-policy.json` `iosEncryption`
  WITH a reason, and declares `ITSAppUsesNonExemptEncryption`, in the same
  diff.** Standard TLS is exempt and an https-only app declares `false`; AES over
  user content is not that, and the two halves are one decision. *Twin:
  `node tools/check-expo-policy.mjs`, which already enforces the declaration in
  BOTH directions over the RESOLVED config — `ITSAppUsesNonExemptEncryption`
  must be a boolean (undeclared re-asks the question on every TestFlight build),
  `true` without `iosEncryption.nonExemptAllowed` reds, and `nonExemptAllowed:
  true` with an empty `reason` reds. The file is write-guard-protected, so this
  is a human's reviewed commit and never an agent's config edit; it is also a
  `mobile-security-reviewer` trigger path, so the diff owes that verdict.*
