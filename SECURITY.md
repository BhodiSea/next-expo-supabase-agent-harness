# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/BhodiSea/next-expo-supabase-agent-harness/security/advisories/new).
Do not open public issues for security reports, and never include live
credentials (database DSNs, Supabase service-role keys or JWT secrets, Expo
access tokens, App Store Connect API keys, Play service-account JSON, Android
upload keystores, Vercel tokens) in a report.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that a human has it | 3 working days |
| An initial assessment — is it reproducible, what is the impact | 10 working days |
| Status updates while it is open | every 10 working days |

If you have not heard anything within the acknowledgement window, assume the
mail went astray and escalate through the advisory form.

These are the same targets `template/base/SECURITY.md` has shipped to every
scaffolded project since v0.9.0. Until 0.10.0 this file named a reporting
channel and no times at all — so the harness asked its consumers to make a
commitment it had not made itself. That asymmetry, not an absence, is what the
register carried as `vuln-response-sla`, and this section is its discharge.

## Supported versions

The latest tagged release and `main` are supported. Installed projects should
run `npx --yes github:BhodiSea/next-expo-supabase-agent-harness update` to pick up
fixes.

Confirmed vulnerabilities are published as GitHub Security Advisories on this
repository and recorded in `CHANGELOG.md` under the release that fixes them.

## Verifying a release

Each GitHub Release carries two assets: the `npm pack` tarball and, beside it,
`<tarball>.intoto.jsonl`. The release workflow signs a build provenance
attestation for the tarball with `actions/attest-build-provenance`, and that
second asset is the signed bundle itself. The signature is bound to the
workflow's identity and recorded in a public transparency log. There is no
long-lived signing key, so there is no public key to fetch and no private key
that could be taken from the distribution site.

Every release carries both, back to 0.1.3. On releases up to and including 1.0.2
the bundle was attached after the fact, on 2026-09-22, copied from the attestation
store where their release builds had filed it. The attestation inside is the
original one signed at release time — an old artifact re-signed today would prove
nothing about how it was built.

To verify a downloaded asset with the GitHub CLI:

```sh
gh release download v1.0.1 -R BhodiSea/next-expo-supabase-agent-harness
gh attestation verify next-expo-supabase-agent-harness-1.0.1.tgz \
  --repo BhodiSea/next-expo-supabase-agent-harness \
  --signer-workflow BhodiSea/next-expo-supabase-agent-harness/.github/workflows/release.yml
```

Exit status 0 means the tarball's digest matches an attestation signed by
`.github/workflows/release.yml` in this repository, running on the release tag.
Any other tarball, repository or workflow fails. `--format json` prints the
signer identity.

Where a release carries the `.intoto.jsonl` asset, `--bundle` reads the
attestation from that file instead of querying the store, so the two assets
verify together without a call to this repository:

```sh
gh attestation verify <tarball> --bundle <tarball>.intoto.jsonl \
  --repo BhodiSea/next-expo-supabase-agent-harness \
  --signer-workflow BhodiSea/next-expo-supabase-agent-harness/.github/workflows/release.yml
```

The attestation covers release assets. `npx github:...` fetches the repository
at a ref rather than a release asset, so pin a tag (`#v1.0.1`) when you use it.

## Known Scorecard findings

This repository runs OpenSSF Scorecard and publishes the results. Some findings
are open for reasons a code change cannot fix:

- **Code-Review.** There is one maintainer, so no change is approved by a second
  person. Every change still lands through a pull request and the full CI matrix.
- **Branch-Protection.** A ruleset on `main` requires a pull request and passing
  checks, and blocks force-pushes and deletion. It requires no approval, for the
  reason above, and the maintainer can bypass the required checks when merging
  their own pull request. Nobody can push to `main` directly. Scorecard scores
  that as partial.
- **Maintained.** Scorecard scores any repository younger than 90 days as
  unmaintained. This one was created on 2026-07-22.
- **SAST.** CodeQL has run on every pull request since 1.0.2. Scorecard measures
  the share of recent commits that were analysed, so the score rises as commits
  accumulate.

## Scope notes

- The harness's guard hooks and permission denies are **tamper-evident, not
  tamper-proof**: a determined agent with shell access can bypass local
  enforcement. CI parity (`tools/validate.mjs --min-floor`), manifest hashing
  (the `gate-integrity` step, which runs on every install), the frozen
  `tools/stop.floor.json` the Stop hook UNIONs into its chain, and CODEOWNERS
  review are the backstops. Reports that "the agent can edit its own gate with
  `HARNESS_ALLOW_SELF_EDIT=1`" describe the documented human escape hatch, not a
  vulnerability.
- **MCP tool calls are default-deny** (0.3.0). `.claude/hooks/pretool-mcp-guard.mjs`
  (matcher `mcp__.*`) reads the registry in `tools/approved-tools.json` and denies
  unregistered servers, tools outside a server's list, and write-shaped tool names
  on a server registered `readOnly` — the last by NAME SHAPE, so it covers verbs a
  vendor has not shipped yet. It fails closed on every ambiguity, including a
  missing or unparseable registry. Before 0.3.0 the `PreToolUse` matchers were
  literally `Bash` and `Edit|Write|MultiEdit`, so an `mcp__` call matched no hook at
  all; a report that an MCP server reached the database on **0.2.1 or earlier** is
  describing that gap, which is fixed, not a new finding.
- **A schema change is a reviewed file, never a tool call.** `supabase/migrations/`
  is what the write-guard's SQL rules judge as it is written, what `schema-rls` /
  `tenancy` / `migrations` judge tree-wide, and what a human sees under CODEOWNERS.
  Any path that reaches DDL without producing a migration file — an MCP
  `apply_migration`, a raw `psql`, an interpreter one-liner — bypasses all four, and
  a report showing a NEW such path is in scope.
- **Credential scanning runs in two places on purpose.** `gitleaks` (deep: entropy,
  the default ruleset, history) runs after a push; the `secrets` chain step (hermetic,
  zero-dependency) runs on every machine in every turn. Their **rule ids are held in
  lockstep** in both directions, so the two may differ in expression but never in
  scope. A shape one catches and the other does not is a bug worth reporting.
- Template workflows are stored dotless under `template/` precisely so they
  can never execute in this repository's own Actions context.
- The scaffolded stack's authorization boundary is Postgres row-level
  security, enforced identically for both client surfaces. The web session
  cookie (`Secure`, `SameSite=Lax`, script-readable — sign-in happens
  browser-side, and a user agent ignores `HttpOnly` on a `document.cookie`
  write, so `tools/auth-posture.json` records httpOnly as UNAVAILABLE on this
  architecture rather than merely unset), the mobile SecureStore token cache,
  and any client-side
  check are defense-in-depth only; reports demonstrating "the web or mobile
  client can call a procedure it shouldn't render UI for" must show the
  RLS/DAL layer failing, not the client hiding a button.
- Signing and store-submission material (EAS credentials, ASC keys, Play
  service accounts) lives in the EAS credentials service or GitHub
  environment secrets, never in the repo or a scaffold; workflows degrade
  honestly (labeled unsigned artifacts) when it is absent.
