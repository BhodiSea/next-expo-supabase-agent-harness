# Module: ci-provenance

Supply-chain evidence for what you ship: SLSA Build L2 provenance attestations for
`npm pack`ed workspace packages, an SBOM for the npm ecosystem (syft/SPDX — one
ecosystem is the whole production surface here: native platform dependencies enter
this stack through npm packages, via Expo modules, config plugins, and
autolinking), an in-CI `gh attestation verify` gate, and a NOTICES drift check
that keeps third-party attributions honest.

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/provenance.yml` | tag-triggered attest + SBOM + verify pipeline |
| `tools/check-notices.mjs` | regenerates NOTICES.md from the live prod dependency set; fails on drift |

## Prerequisites

- Nothing secret: attestation uses GitHub OIDC (`id-token: write`) — no keys to
  manage, and no EAS, Apple, or Google credential anywhere in this module.
- One-time: `node tools/check-notices.mjs --write` to create the initial
  `NOTICES.md`, review it, commit it. Until then the notices gate fails loudly
  (that first failure is the anti-vacuity proof — see below).

## How enabling works

```
npx next-expo-supabase-agent-harness enable ci-provenance
```

copies the files; the workflow runs on the next `v*` tag (or `workflow_dispatch`).
The workflow IS the gate — no `tools/harness.config.mjs` change. This module is
part of the `standard` tier.

## How this gate can FAIL (anti-vacuity)

- **notices**: enable the module and run the workflow BEFORE writing NOTICES.md →
  fails with the `--write` hint. After committing it, `pnpm add` any prod
  dependency without regenerating → fails on drift.
- **attest/verify**: revoke `id-token: write` in a scratch branch → the attest
  step fails; or verify a tampered tarball locally
  (`gh attestation verify <modified>.tgz -R <org>/<repo>`) → verification fails.

## Honest limits

- SLSA **L2**, not L3: a valid attestation proves the artifact came out of this
  workflow — it does NOT prove the source was untampered (a stolen OIDC token
  mints valid attestations). L3 needs the isolated slsa-github-generator build.
- The store binaries are attested where they are verified, not here: the
  `.aab`/`.ipa` never pass through this workflow (EAS builds them off-runner).
  Extend the verify-and-attach job in `release-mobile.yml` (ci-mobile-release)
  with the same attest/verify pair if your consumers verify the store binaries
  rather than the packages. Read that attestation for what it is: it binds the
  binary to the release workflow's download → checksum → attach path, not to the
  EAS build machine itself.
