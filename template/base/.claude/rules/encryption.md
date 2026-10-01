# Encryption invariants (always loaded; also hook- and lint-enforced)

This rule is always loaded, and it holds only what applies while the opt-in `e2ee`
module is OFF: until `npx next-expo-supabase-agent-harness enable e2ee` puts
`@app/crypto` in `packages/platform/crypto/`, there is no encryption code for the
full rule to govern. Every bullet names the check that holds it, and each of those
checks runs in a base install. The full rule, `.claude/rules/e2ee.md`, ships with the
module: `enable e2ee` installs it, and an install without the module does not have it.
SOURCE: docs/harness/README.md (the always-loaded rules surface)

- **RLS keyed on `auth.uid()` stays THE authorization boundary. Encryption sits ON
  TOP of it and never replaces it.** An encrypted table gets no relief from a single
  policy, grant, index, `FORCE`, or audit trigger. *Twin: the whole `schema-rls` /
  `tenancy` suite and both isolation twins (`supabase/tests/**` pgTAP and
  `tests/rls/`), none of which knows or cares that a column is encrypted.*

- **Enable the `e2ee` module rather than hand-rolling encryption.** The module is
  the reviewed shape any encryption in this repo takes; enabling it is a separate,
  reviewed act, and `docs/modules/e2ee/README.md` states what it does NOT solve.
  *Twin: `crypto-primitives-one-door` below, which reds a hand-rolled cipher that
  reaches an engine; one that reaches none is a reviewer's to catch.*

- **The server never holds plaintext, and never holds a key that decrypts it.
  Primitives arrive only through the injected `CryptoProvider`.** *Twins, both
  active in the base `eslint.config.mjs` with the module off: the
  `crypto-primitives-one-door` ESLint rule (no direct `crypto.subtle` reach and no
  `node:crypto` cipher/KDF import outside its two sanctioned homes,
  `packages/platform/crypto/src/**` and `apps/*/src/host/**`) and the
  `no-insecure-random-in-crypto-scope` rule, scoped to those same two surfaces,
  tests included.*

- **Key material comes only from the platform CSPRNG** — `crypto.getRandomValues`
  on web, `expo-crypto` on device. Never `Math.random()`, never a literal, never a
  passphrase without a memory-hard KDF. *Twins: the `math-random-key-material` and
  `hardcoded-key-material` write-guard rules, which deny the write on an Edit
  fragment and on files lint's globs do not reach (the second denies a 64-hex
  literal assigned into a key-shaped name), and `crypto-primitives-one-door`, which
  reds a `node:crypto` scrypt/pbkdf2/hkdf import and any `crypto.subtle` reach,
  `deriveKey` included, outside the two homes.*

- **No broken constructions.** Never ECB, the legacy `createCipher()`, MD5, SHA-1,
  DES or RC4. *Twin: the `weak-crypto-algorithm` write-guard rule, which denies the
  write that reaches for one, matched in ALGORITHM-ARGUMENT position so prose or a
  variable named `md5sum` cannot trip it. Its stated limit: it names the broken
  constructions it knows.*

- **Shipping real cryptography flips `tools/store-tunables.json` `iosEncryption`
  WITH a reason, and declares `ITSAppUsesNonExemptEncryption`, in the same
  diff.** Standard TLS is exempt and an https-only app declares `false`; AES over
  user content is not that, and the two halves are one decision. *Twin:
  `node tools/check-expo-policy.mjs` (the `expo-policy` step), which enforces the
  declaration in BOTH directions over the RESOLVED config —
  `ITSAppUsesNonExemptEncryption` must be a boolean, `true` without
  `iosEncryption.nonExemptAllowed` reds, and `nonExemptAllowed: true` with an empty
  `reason` reds. The file is write-guard-protected, so the flip is a human's
  reviewed commit, never an agent's config edit.*

The full rule, with the envelope and AAD construction, the wrapped-key erase lever,
the export stance and the audit-capture refusal, is `.claude/rules/e2ee.md`, which
`enable e2ee` installs (path-scoped; the `authoring-e2ee-feature` skill reads it first). What the module
deliberately does NOT solve, each loss with its cost, is
`docs/modules/e2ee/README.md`.
