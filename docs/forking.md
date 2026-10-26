# Forking the harness itself

A fork of the harness is your own copy of the installer, `template/` and the
selftest machinery, to rebrand and extend into a sibling for a different stack.
It does not produce an app. To scaffold an app, use the `npx` command in the
[README](../README.md).

This repository is not a GitHub template repository. Its template flag is off
(#166), because "Use this template" gave a visitor who wanted an app a copy of
the harness instead. A fork starts from a clone with a fresh history: one
commit, with no upstream history or tags.

```sh
git clone --no-tags --single-branch https://github.com/BhodiSea/next-expo-supabase-agent-harness.git <your-harness>
cd <your-harness>
upstream_sha="$(git rev-parse --short HEAD)"
git checkout --orphan fresh
git commit -m "chore: start from next-expo-supabase-agent-harness at ${upstream_sha}"
git branch -M main
git remote rename origin upstream
git remote add origin <your repository URL>
git push -u origin main
```

Clone without tags. `check-ramp-ledger`, `check-dependency-channel`,
`check-sbom-drift`, `check-eol-target`, `check-seeded-migrations` and
`check-released-shas` read `git tag`, and the upstream tags name commits your
history does not contain. The `upstream` remote keeps the `--no-tags` setting,
so a later `git fetch upstream` for upstream fixes brings no tags either.

Expect `lint.yml`'s `machinery-lint` job to be red at first.
`check-ramp-ledger`, `check-dependency-channel`, `check-sbom-drift` and
`check-eol-target` compare a release with the one before it, and in CI they
fail rather than skip until a `vX.Y.Z` tag below the version in `package.json`
is reachable. `check-ramp-ledger` also fails while `VINTAGES` in
`scripts/lib/ramp-sites.mjs` names a release your history has no tag for.

The selftest, hygiene and lint workflows do not depend on the upstream owner.

## What to rewrite

The shipped `template/` tree needs no rebranding. It is placeholder-clean, and
the hygiene gate denies upstream references inside it. What does need rewriting
is the set of repo-root sites that hardcode the upstream owner:

- `package.json`: `name` and `bin` (the npm name is this repository's),
  `repository.url`, `homepage`, `bugs.url`, `author`
- `.github/workflows/release.yml`: the `publish-npm` job runs only in this
  repository. Point its `if:` at yours once the package is renamed and has its own
  first publish and trusted publisher, or delete the job. The `release` job also
  opens a discussion for each release in the `Announcements` category; in a
  repository without Discussions or without that category, that step prints a
  warning and the job still succeeds
- `README.md`: the `npx` command and the lineage links
- `docs/forking.md`: this checklist
- `CITATION.cff`: `title`, `authors`, `repository-code`
- `CHANGELOG.md`: the lineage note at the top (it names this repo as the
  ancestor of yours) and the version line you continue from
- `CONTRIBUTING.md`: rule 2 names the vocabulary your lineage owns
- `SECURITY.md`: the advisories URL, the `update` command and the release
  verification command
- `.github/CODEOWNERS`: every owner handle
- `.github/ISSUE_TEMPLATE/config.yml`: the advisory, discussions and repro URLs,
  and the `npx` line in `bug-report.yml`
- `.claude/settings.json`: you inherit the upstream maintainer's permissions.
  Review the default mode before your first agent turn.
- `.claude-plugin/plugin.json`: the `npx` command in `description`, plus
  `author`, `homepage`, `repository`
- `.claude-plugin/marketplace.json`: `owner`
- `REUSE.toml` and `LICENSES/`: keep the upstream copyright and append yours
- `tests/gates/check-reuse.test.mjs`: it asserts the upstream copyright string
- `scripts/check-corpus-fidelity.mjs`: the User-Agent contact URL
- `scripts/check-floor-advisories.mjs`: the User-Agent contact URL
- `installer/lib/detect.mjs`: the sibling-harness redirect messages
- `scripts/hygiene.mjs`: two edits, described below

## The two `scripts/hygiene.mjs` edits

1. Keep the upstream-handle deny pattern, which stops upstream references from
   entering your `template/`, and add your own handle alongside it.
2. Re-seed the cross-porting detectors. They ban a sibling harness's stack
   vocabulary anywhere under `template/`, so a lineage whose stack is that
   vocabulary goes red on its own first file. Drop only the words your lineage
   now owns, and add the words of the lineage you forked away from. Never delete
   a pattern to make a run pass.

Expect the detectors to arm last. Until the port is complete they would go red
on the code you are still porting. This fork dropped `/supabase/i` and
`/vercel/i` immediately, and armed `/\bhono\b/i` and `/drizzle/i` once every
carrier had been retargeted.

## Check that nothing was missed

```sh
grep -rn "BhodiSea\|Cogvera" --exclude-dir=node_modules .
```

This should return only the attribution you deliberately kept and the hygiene
deny pattern.
