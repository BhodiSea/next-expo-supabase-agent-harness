# npm trusted publishing and provenance, as of 2026-10-02

The brief behind #161.

**Where these facts come from:**
- **npm docs:** docs.npmjs.com was blocked by the egress proxy, so they were read from their
  source repository, `npm/documentation` at commit `ef0a369` (2026-09-30).
- **Tool behaviour:** read from source: `npm/cli` `latest`, pacote, Scorecard, zizmor and pnpm.
- **GitHub changelog entries:** seen only in search extracts; the npm docs restate them.
- **"Inferred":** marks a claim that was reasoned out, not tested.

Source keys refer to the list at the end.

## 1. Mechanics

**Versions and runners.**
- Trusted publishing needs npm 11.5.1 or later and Node 22.14.0 or later [TP].
- It runs on GitHub-hosted runners, GitLab.com shared runners and CircleCI cloud. Self-hosted runners are not supported [TP].
- Which npm each Node line bundles [NODE]:

  | Node | Bundled npm | Enough? |
  |---|---|---|
  | 22.23.3 | 10.9.9 | no |
  | 24.21.0 | 11.19.0 | yes |
  | 26.10.0 | 11.19.1 | yes |

- npm's `latest` is 12.2.0, which needs Node `^22.22.2`, `^24.15.0` or 26 and later [NPMREG].

**Workflow permissions:** `id-token: write`, plus `contents: read` [TP].

**Configuration on npmjs.com.**
- Fields: user or organization, repository, workflow file name, environment (optional), and allowed actions.
- All fields are case-sensitive, and npm does not validate them when they are saved [TP].

**Changes in 2026.**
- Since 2026-09-03, a package can hold up to ten configurations [TP][CLG-0903].
- A configuration created after that date allows `npm stage publish` by default. Direct `npm publish` must be ticked separately [TP].
- Dist-tag permission is opt-in since 2026-09-30 [TP][CLG-0930].

**`npm trust`** (npm 11.15 and later).
- Form: `npm trust github <pkg> --file release.yml --repo owner/repo [--env X] --allow-publish | --allow-stage-publish`.
- Requires 2FA on the account and a package that already exists [TRUST].

## 2. The first publish

The first version cannot be published over OIDC, because both the settings page and `npm trust`
need an existing package [TP][TRUST]. "Allow publishing initial version with OIDC" has been an
open npm/cli request since 2025-09-01 [I8544]. No pending-publisher mechanism was found.

**Staged publishing** can create a package, but it leaves a public placeholder version
`0.0.0-stage` [STAGE].

**Name reservation.**
- npm has no way to reserve a name.
- A package published only to hold a name is squatting under npm's dispute policy ("no genuine function") [DISP].
- So the first version should be a real release.

**Recommended path:**
1. The maintainer publishes the attested release tarball by hand, with 2FA [2FA].
2. They then configure the trusted publisher.
3. They select "Require two-factor authentication and disallow tokens", and never create a token.

## 3. Provenance

**When it is generated.** It is automatic under trusted publishing, with no `--provenance` flag, for a public repository and
a public package [TP]. The CLI checks the `repository_visibility` OIDC claim [OIDCSRC].

**`repository.url` must match the repository.**
- The match is case-sensitive [TP][PROV].
- The `git+` prefix and the `.git` suffix are normalised.
- A reported E422 failed on letter case alone, and only after the signature was already in the transparency log [DF193].

**What npmjs.com shows.** A check mark on the version. Its details list the build environment, the workflow run,
the source commit, the build file and the public ledger entry [VIEW].

**Verifying it.** `npm audit signatures` checks registry signatures and provenance in an installed project [VIEW].

## 4. npm provenance and `actions/attest-build-provenance`

**Two separate bundles.** Both are signed through the same public Sigstore instance, under the same workflow identity:
- npm signs a statement whose subject is `pkg:npm/<name>@<version>`, with a sha512 digest [LIBPUB];
- `attest-build-provenance` names the file, with a sha256 digest, and stores the statement in GitHub's attestation store [ATTEST].

**Publishing the attested file.**
- `npm publish ./x.tgz` uploads that file's bytes, and `dist.integrity` is computed from them [PUB12][LIBPUB][PUBSRC]. So publishing the attested release asset gives one artifact with two attestations (inferred).
- Re-packing is designed to be reproducible, but byte-identity across npm versions is unconfirmed [PACK]. Publish the file itself.
- Lifecycle scripts do not run when a tarball is published [PUBSRC].
- `--provenance-file` (npm 12.1 and later) replaces the automatic statement, and needs a purl subject [CFG12][LIBPUB].

## 5. Hardening

**Package settings.** Publishing access → "Require two-factor authentication and disallow tokens". OIDC keeps
working [TP][2FA].

**Tokens.**
- Classic tokens were removed in November 2025 [TOK].
- Since August 2026, bypass-2FA tokens can no longer perform account or governance actions [TOK].
- Direct publishing with granular tokens ends in January 2027 [TOK].

**Stage-only trusted publishing.** Every CI publish waits for a maintainer's 2FA approval on npmjs.com, which npm
describes as its strongest setting [TP][STAGE].

**GitHub environments.**
- Required reviewers are available for public repositories.
- "Prevent self-review" would lock out a sole maintainer.
- Deployments can be restricted to `v*` tags [GHENV].
- An environment changes the OIDC subject to `repo:O/R:environment:NAME` [GHOIDC], so the npm configuration must name the same environment [TP].

## 6. pnpm

pnpm 11 publishes natively [PNPM1100]. Its OIDC fixes came in two steps:
- 11.0.7 made OIDC win over a stored token [PNPM1107];
- 11.1.3 fixed a 404 seen with setup-node's `.npmrc` [PNPM1113][PNPM11513].

pnpm's docs describe neither OIDC nor provenance, and suggest `pnpm pack` then `npm publish` [PNPMPUB].
Publish with the npm CLI.

## 7. Dist-tags and prereleases

- Since npm 11, a prerelease is refused without `--tag`, and so is `latest` for a version below
  the current highest [CL11][PUBSRC].
- Semver ranges skip prereleases [SEMVER].
- `npm create foo@next` runs `create-foo@next` [INIT12].

## 8. Names

**Availability.** On 2026-10-02 the registry returned 404 for:
- `next-expo-supabase-agent-harness`;
- `create-next-expo-supabase-agent-harness`;
- the punctuation-stripped form `nextexposupabaseagentharness` [REG].

**Similar names.** npm blocks a new unscoped name equal to an existing one with punctuation removed. This is
undocumented, and scoped names are exempt [COMM205030][THREATS].

**Trademarks.** The name guidelines advise against names built on others' trademarks [NAME][DISP].

**`create-` wrappers.** They are common: `create-storybook` pins `storybook` exactly [REG]. Each one needs its own
first publish and its own trusted publisher [TRUST].

## 9. Pitfalls

- **Called or dispatched workflows.** With `workflow_call` or `workflow_dispatch`, npm checks the *caller's* workflow file name [TP].
- **Silent fallback.** The OIDC exchange never throws: on failure npm falls back to other credentials [OIDCSRC]. A post-publish check is the only proof of what happened.
- **`registry-url`.** setup-node's `registry-url` writes `_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`. Failures were reported with npm 11.14.1 [DOC1960][SN1551], and setup-node v7 removed the dummy-token fallback [SN]. Never set `NODE_AUTH_TOKEN` on the publish step.
- **npm 12 and git sources.** npm 12 defaults `allow-git` to `none` [CFG12][CL12], and pacote then refuses git sources [PACOTE]. Reproduced: see [README.md](README.md).

## 10. Scorecard and zizmor

**Scorecard.**
- **Packaging** recognises an npm publish only when one job has `actions/setup-node` with `registry-url: https://registry.npmjs.org` and a step matching `npm.*publish`, and the workflow has a successful run [SCSRC].
- **Signed-Releases** reads release assets, so the `.intoto.jsonl` asset stays [SC].
- **Token-Permissions** penalises top-level write permissions, not `id-token` [SC][SCSRC].
- **Pinned-Dependencies** counts `npm install -g npm@X` as unpinned [SCSRC]. Node 24's bundled npm avoids it.

**zizmor.**
- `use-trusted-publishing` flags publish steps in jobs without `id-token` [ZZ].
- `cache-poisoning` asks release workflows to disable caches (`package-manager-cache: false`) [ZZ][SN].

## 11. How `npx` and `pnpm dlx` choose a version

**npx (npm 10 and later).** With a bare name that is in neither the project nor the global install, npm re-fetches the
registry entry and installs a newer version than the one in the npx cache [EXECSRC]. npm 10 reused
a cached version for a range; npm 11.2.0 fixed that [CL11]. Document `@latest` for "newest" and
`@<version>` for "exactly this" [INIT12].

**pnpm dlx (pnpm 10 and later).** It keys its cache by the resolved version [PNPMDLX]. pnpm 11's default
`minimumReleaseAge` (1,440 minutes) can make `pnpm dlx` resolve the previous version for a day after a
release; an exact version still resolves [PNPMRES][PNPMCREATE].

## 12. Publishing an existing tarball by hand

`npm publish ./next-expo-supabase-agent-harness-1.0.4.tgz` with 2FA works, and unscoped packages are
public [PUB12][2FA]. That version has no provenance [PROV].

Effects on later versions:
- `npm audit signatures` reports invalid attestations and missing registry signatures, not missing provenance [VSIG].
- pnpm's `trustPolicy: no-downgrade` fails only when trust drops between versions [PNPMRES]. So no version after the first may be published by hand.

## Sources

- [TP] docs.npmjs.com/trusted-publishers (source: npm/documentation, `content/packages-and-modules/securing-your-code/trusted-publishers.mdx`)
- [PROV] docs.npmjs.com/generating-provenance-statements
- [VIEW] docs.npmjs.com/viewing-package-provenance
- [STAGE] docs.npmjs.com/staged-publishing
- [TRUST] docs.npmjs.com/cli/v12/commands/npm-trust
- [TOK] docs.npmjs.com/about-access-tokens
- [2FA] docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification
- [NAME] docs.npmjs.com/package-name-guidelines
- [DISP] docs.npmjs.com/policies/disputes
- [THREATS] docs.npmjs.com/threats-and-mitigations
- [CFG12] docs.npmjs.com/cli/v12/using-npm/config
- [PUB12] docs.npmjs.com/cli/v12/commands/npm-publish
- [INIT12] docs.npmjs.com/cli/v12/commands/npm-init
- [CL11], [CL12] docs.npmjs.com/cli/v11/using-npm/changelog, docs.npmjs.com/cli/v12/using-npm/changelog
- [NODE] nodejs.org/dist/index.json
- [NPMREG], [REG] registry.npmjs.org (`npm`, `create-storybook`, and the names above)
- [OIDCSRC], [PUBSRC], [LIBPUB], [EXECSRC], [VSIG] npm/cli `latest`: `lib/utils/oidc.js`, `lib/commands/publish.js`, `workspaces/libnpmpublish/lib/`, `workspaces/libnpmexec/lib/index.js`, `lib/utils/verify-signatures.js`
- [PACK], [PACOTE] npm/pacote: `lib/util/tar-create-options.js`, `lib/fetcher.js`
- [I8544] npm/cli issue 8544
- [DOC1960] npm/documentation issue 1960; [SN1551] actions/setup-node issue 1551; [SN] actions/setup-node README
- [ATTEST] actions/attest-build-provenance, actions/attest
- [DF193] DeviceFarmer/STFService.apk pull request 193
- [COMM205030] GitHub community discussion 205030
- [GHENV], [GHOIDC] GitHub Docs: deployments and environments; OIDC reference
- [CLG-0903], [CLG-0930] GitHub changelog, 2026-09-03 and 2026-09-30 (npm trusted publishing)
- [PNPMPUB], [PNPMRES], [PNPMCREATE], [PNPMDLX] pnpm.io: `cli/publish`, `settings`, `cli/create`; pnpm `exec/commands/src/dlx.ts`
- [PNPM1100], [PNPM1107], [PNPM1113], [PNPM11513] pnpm releases 11.0.0, 11.0.7, 11.1.3; pnpm issue 11513
- [SC], [SCSRC] ossf/scorecard `docs/checks.md`; `checks/fileparser/github_workflow.go`, `checks/raw/github/packaging.go`, `checks/evaluation/permissions.go`
- [ZZ] docs.zizmor.sh/audits
- [SEMVER] npm/node-semver, "Prerelease Tags"
