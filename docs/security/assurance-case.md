# Security assurance case

This document covers the harness itself: the installer, the template it
distributes, and the pipeline that releases them. The security of the
application a scaffold contains is covered by the documents that ship into that
scaffold, chiefly
[`template/base/docs/security/threat-model.md`](../../template/base/docs/security/threat-model.md).

It states what the harness must guarantee, who it defends against, where the
trust boundaries are, how each guarantee is met, and what is not covered.
Reviewed 2026-09-20 against the tree at 1.0.2. It was written by the maintainer
with an AI assistant and has had no independent review.

## What the harness is, in security terms

A user runs `npx github:BhodiSea/next-expo-supabase-agent-harness init`. That
fetches this repository at a ref and runs `installer/cli.mjs` on their machine
with their privileges. The installer writes several hundred files into their
project. Some of those files are hooks that later run inside their AI coding
agent's session, and some are CI workflows that later run with their
repository's permissions. `update` repeats this against a project that already
has code in it.

So the harness is a supply-chain component. A defect or a compromise here is
delivered into every project that installs or updates.

## Security requirements

| # | Requirement |
|---|---|
| R1 | Running the CLI executes only code from this repository at the ref the user chose. |
| R2 | A rendered scaffold contains no credential, no unrendered placeholder, and nothing specific to this project or its maintainer. |
| R3 | The installer writes only inside the target directory, and `update` does not destroy a consumer's changes. |
| R4 | A guard hook that cannot run blocks the action. It does not fail open. |
| R5 | Weakening an installed gate is detectable: locally at once, and in CI regardless of what happened locally. |
| R6 | A change to the enforcement surface of this repository is a deliberate human act, visible in review. |
| R7 | A release asset can be verified as built by this repository's release workflow from a tagged commit. |
| R8 | The CI of this repository gives an untrusted pull request no write access and no secrets. |
| R9 | Known vulnerabilities in what the scaffold pins are found and fixed within a bounded time. |

## Who it defends against

- **An AI agent working in an installed project** that takes a shortcut:
  editing a gate so it passes, deleting a failing test, reading a secrets file,
  force-pushing. This is the adversary the hooks are designed for. It is assumed
  capable and unaligned with the project's rules, and it is not assumed to be
  deliberately evading detection.
- **A compromised or malicious dependency** in the factory's development
  toolchain or in the scaffold's dependency tree.
- **A malicious pull request** to this repository that tries to widen an escape
  list, weaken a gate, or reach CI credentials.
- **Tampering with a release asset** between the build and the user.
- **Compromise of the maintainer's account or of this repository.** This is
  only partly defended. See the residual risks.

## Trust boundaries

```
 user's shell ──npx──▶ GitHub (this repo @ ref) ──▶ installer process ──▶ consumer working tree
                                                                              │
        agent session ──tool call──▶ hook process ──allow/deny──▶ shell, files, MCP
                                                                              │
        consumer CI ◀── workflows and gates from the template ◀───────────────┘

 contributor PR ──▶ factory CI (read-only token, no secrets) ──▶ maintainer review ──▶ main
 tag ──▶ release.yml (OIDC identity) ──▶ attested tarball ──▶ GitHub Release
```

1. **The user and this repository.** The user trusts the ref they name.
   Everything the installer does follows from that one decision.
2. **The installer and the consumer's tree.** The installer is trusted code
   acting on the user's files.
3. **The agent and the hooks.** The agent is untrusted. The hooks are the
   reference monitor, and they run as separate processes that the agent's tool
   calls pass through.
4. **A contributor and the factory's CI.** Pull request code is untrusted and
   runs with a read-only token.
5. **The release workflow and the user.** The user can check the asset against
   the workflow's identity.

## How each requirement is met

**R1. Only this repository's code runs.** The installer has no runtime
dependencies: `package.json` has no `dependencies` key, and CONTRIBUTING ground
rule 3 keeps it that way. `package.json` defines no `prepare`, `preinstall` or
`postinstall` script, so fetching the package runs nothing. The installer makes
no network requests. It starts other programs in four places (`git` twice,
`node tools/validate.mjs`, and its own lock generator), each time with an
argument array and never through a shell.

**R2. A clean scaffold.** Every `{{TOKEN}}` in `template/` must be registered
in `installer/lib/placeholders.mjs` and every registered token must be used.
`scripts/hygiene.mjs` checks both directions on every pull request. The same
script scans `template/` for credential shapes, for the upstream owner's
handle, and for the vocabulary of sibling harnesses. `selftest.yml`
`render-smoke` renders a scaffold and `scripts/check-residue.mjs` fails on any
unrendered token. Every placeholder value is validated before use.

**R3. Writes stay in the target and preserve local changes.** Destination
paths come from the file tree packaged with the CLI, joined to the resolved
`--dir`. They do not come from free-form user input. Each installed file is
recorded with a sha256. `update` replaces an owned file only when it still
matches its recorded hash; otherwise it keeps the consumer's copy and parks the
incoming one under `.harness/pending/`. It never writes to seeded files. It
snapshots every path it may touch before its first write, writes atomically,
and supports `--rollback`. It refuses to run while a live agent session holds
the tree's turn lock. `tests/installer/` covers these paths, and
`upgrade-linux` runs real upgrades from thirteen starting points on every pull
request.

**R4. Fail closed.** Every hook is started through
`template/base/.claude/hooks/launch.mjs`, which exits 2, the blocking status,
when the hook or one of its imports cannot load. The MCP guard denies any
server or tool that is not in `tools/approved-tools.json`, and denies
everything when that registry is missing or unparseable. `tests/hooks/` holds
a behavioural test for each of the 142 guard rule ids, and
`scripts/check-canary-coverage.mjs` fails if a rule has none.

**R5. Tamper evidence.** The `gate-integrity` step hashes every owned file
against the manifest, so an edited gate script turns the chain red in the same
turn. Escape lists are separate reviewed data files, guarded against agent
writes. CI does not depend on any of that: it runs the chain with `--min-floor`
against `tools/validate.floor.json`, a frozen copy of the step list, so a local
config with a step removed still fails in CI. The Stop hook runs the union of
the local step list and `tools/stop.floor.json`.

**R6. Deliberate changes here.** This repository runs the shipped bash guard
and an equivalent write guard on itself. Writes to `scripts/`, `installer/`,
`.github/workflows/`, `template/base/tools/`, the shipped hooks,
`template/migrations.json`, the canary registry and `.claude/` are denied
unless a human has set `HARNESS_ALLOW_SELF_EDIT=1` in the environment the
session was started from. `.github/CODEOWNERS` covers every one of those paths.
`scripts/check-rule-integrity.mjs` fails if a shipped boundary rule is deleted
or narrowed, and `scripts/check-complexity-ratchet.mjs` re-lints with inline
suppressions disabled.

**R7. Verifiable releases.** `release.yml` runs only on a `v*` tag, waits for
green `selftest.yml` and `lint.yml` runs on that exact commit, and signs a
build provenance attestation for the tarball with an identity issued to that
workflow run. No long-lived signing key exists. SECURITY.md gives the
verification command, which was tested against the v1.0.1 asset and fails for
any other repository or workflow.

**R8. Untrusted pull requests.** Every factory workflow sets
`permissions: contents: read` at the top and grants more only per job. No
workflow uses `pull_request_target`. No `run` block interpolates a
`github.event` or `head_ref` value. Every checkout sets
`persist-credentials: false`. Every action is pinned to a full commit SHA.
Every job that defines its own steps starts with `step-security/harden-runner`;
the one exception calls Google's reusable OSV scanner workflow, pinned by SHA.
The repository has no
Actions secrets. `zizmor` and `actionlint` check all of this on every pull
request, and a finding fails the job.

**R9. Known vulnerabilities.** `tools/framework-floor.json` records the
reviewed minimum patch version of each framework pin, and the `version-sync`
step compares the resolved lockfile to it offline on every run. The register is
harness-owned, so `update` delivers a raised floor to existing installs.
`tools/eol.json` does the same for vendor-deprecated packages. Both have a
review window of at most 31 days, checked nightly. A nightly OSV scan covers
the factory's own lockfile, and the template ships an OSV lane to consumers.
SECURITY.md commits to response times for reported vulnerabilities.

## Secure design principles

| Principle | Where it is applied |
|---|---|
| Fail-safe defaults | MCP calls are default-deny. Hooks that cannot load block. Gates that lack a toolchain fail in CI instead of skipping. |
| Complete mediation | `PreToolUse` matchers cover shell, every file-writing tool and `mcp__.*`. The Stop chain cannot be shortened below its frozen floor. |
| Least privilege | Read-only workflow tokens with per-job grants. In the scaffold, `service_role` is revoked on every table and reachable only from an ADR-governed Edge Function. |
| Economy of mechanism | One file, `tools/harness.config.mjs`, defines the chain for the Stop hook, the CLI and CI. Guard rules are data tables, not code paths. |
| Open design | Every rule, gate and escape list is a readable file in the consumer's own repository. Nothing depends on a rule being secret. |
| Separation of privilege | Editing the enforcement surface needs both an environment flag only a human can set and code-owner review. |
| Input validation | Placeholders are validated against per-field patterns. CLI flags are parsed by `node:util` `parseArgs` against a closed option table. Tiers and modules are closed sets. |
| Defence in depth | The same property is usually held twice, for example secrets by gitleaks after a push and by the hermetic `secrets` step on every run, with their rule ids kept in lockstep. |

## Common weaknesses considered

| Weakness | Status |
|---|---|
| Command injection (CWE-78) | The installer never invokes a shell. Workflows interpolate no untrusted expression into `run`. |
| Path traversal (CWE-22) | Destinations are derived from the packaged template tree. See the residual risk below. |
| Secrets in source or output (CWE-798) | Hygiene scan of `template/`, two secret scanners in the scaffold, and credential patterns in both `.gitignore` files. |
| Vulnerable components (CWE-1395) | R9. |
| Insufficient verification of authenticity (CWE-345) | R7 for release assets. The `npx github:` path relies on GitHub and on the chosen ref. |
| Regular expression denial of service | Guard rules are regular expressions over agent-supplied text, run under a 10 second hook timeout. The rules have not been analysed for catastrophic backtracking, and what Claude Code does with a guard that times out has not been verified here. |
| Code injection in CI | CodeQL's `actions` and `javascript-typescript` analyses run on every pull request as of 1.0.2. |

## Residual risks

Stated plainly, because a reader deciding whether to run this needs them more
than they need the mechanisms above.

1. **The local guards are tamper-evident, not tamper-proof.** An agent with
   shell access that sets out to evade them can. They match command text, so an
   unanticipated spelling can pass, and a quoted denied string can be blocked
   when it is harmless. CI and human review are the actual boundary.
2. **`npx github:` runs whatever the ref points at.** A branch name moves. Only
   a tag or a commit SHA pins the code, and the build provenance attestation
   covers release assets, not the `npx github:` fetch. A compromise of the
   maintainer's GitHub account or of this repository would reach users who
   install from an unpinned ref.
3. **There is one maintainer.** No change is reviewed by a second person, so R6
   reduces to one person's diligence plus automation.
   [GOVERNANCE.md](../../GOVERNANCE.md) records this.
4. **`update` executes instructions from `template/migrations.json` in someone
   else's repository**, including file deletions. A malicious record merged
   here would run for every consumer who updates. The file is write-guarded and
   code-owned, and the `upgrade-linux` lane executes every record for real.
   Consumers should commit before updating and read the report.
5. **The installer has no explicit check that a destination stays inside
   `--dir`.** It relies on destinations coming from its own packaged tree. A
   template entry with a `..` segment would be a bug in this repository, and
   nothing currently tests for one.
6. **A review window bounds how stale a review can be. It does not make anyone
   look sooner.** The Next.js floor was 26 days behind two critical advisories
   in September 2026 for this reason, and the nightly run that should have
   raised it had already been red for weeks. The 1.0.2 CHANGELOG entry gives
   the account.
7. **A green test says something about the environment it ran in, and that
   environment can differ from production.** The scaffold's database tests
   asserted from 0.2.0 onward that `authenticated` held no write privilege on
   the seat tables, and passed. They passed because the local Supabase stack
   did not apply the platform's default privileges to migration-created
   tables. When a newer local stack did, the assertion failed on an unchanged
   tree, and the privileges turned out to have been there all along. Row
   security held throughout. The 1.0.2 CHANGELOG entry and
   `template/base/docs/adr/20260920-authenticated-write-revoke.md` give the
   account. The same class of gap may exist wherever a local emulator stands
   in for a hosted service.
8. **`launch.mjs` itself still fails open** if it is the file that cannot load.
   The fail-open surface was reduced to that one small import-free file. It was
   not eliminated.
9. **Everything outside the repository is outside the harness.** Branch
   protection, account security, and the hosting platform's configuration are
   the consumer's, and the harness can only recommend them.
