# Module: ci-web-deploy

Supply-chain evidence for the web surface: a GitHub-built, **independently
rebuilt** and cryptographically **attested** record of what a tagged commit
produces, verified in CI. It is the web analog of `ci-provenance` (which attests
the npm packages) and `ci-mobile-release` (which attests the store binaries).

**It does not deploy.** Your web host — Vercel or another platform — runs its own
build pipeline off your git push and serves the result. This module reproduces
that production `next build` on a GitHub runner and attests *that* artifact, so
you hold a signed, third-party-verifiable record to compare against (or supplement)
whatever the host shipped. As the Next harness put it: *Vercel runs its own build
pipeline; this attests the GitHub-built artifact.*

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/web-deploy.yml` | tag-triggered build + attest + verify pipeline for the web build output |

## Prerequisites

- Nothing secret to sign: attestation uses GitHub OIDC (`id-token: write`) — no
  keys, and no Vercel/host token anywhere in this module.
- The **public** build-time env must be set as repo **Variables** (not Secrets):
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE`,
  `NEXT_PUBLIC_WEB_ORIGIN`. `@app/env` parses them at import, so `next build`
  reds on the runner if they are unset — a misconfigured release fails here, not
  in production. They are public by construction (the browser bundle inlines
  them; see `.env.example`, block **(b)**), which is why they are Variables.

## How enabling works

```
npx next-expo-supabase-agent-harness enable ci-web-deploy
```

copies the file; the workflow runs on the next `v*` tag (or `workflow_dispatch`).
The workflow IS the gate — no `tools/harness.config.mjs` change. This module is
part of the `standard` tier.

## How this gate can FAIL (anti-vacuity)

- **build**: unset one of the `NEXT_PUBLIC_*` Variables → `next build` reds when
  `@app/env` parses the empty value; a real compile error in `apps/web` → the
  build step fails before anything is attested.
- **attest/verify**: revoke `id-token: write` in a scratch branch → the attest
  step fails; or verify a tampered tarball locally
  (`gh attestation verify <modified>.tgz -R <org>/<repo>`) → verification fails.
  The in-CI verify step's exit code gates the job, so a build-and-upload with no
  verifiable attestation cannot pass.

## Honest limits

- **This is not the deploy.** The host builds and serves independently. A green
  run here does not prove the host shipped the same bytes — its build environment
  differs. It proves the tagged *source* rebuilds to a signed artifact, which is
  the property worth having: reproducibility and provenance, not a deploy receipt.
- SLSA **L2**, not L3: a valid attestation proves the artifact came out of this
  workflow — it does NOT prove the source was untampered (a stolen OIDC token
  mints valid attestations). L3 needs the isolated slsa-github-generator build.
- The attested subject is the tarball'd `.next` build output. If your
  `next.config` uses `output: 'standalone'`, narrow the package/subject to
  `apps/web/.next/standalone` so the attestation binds the deployable subset.
