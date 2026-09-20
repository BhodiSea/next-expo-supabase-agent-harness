# CLI reference

```sh
npx --yes github:BhodiSea/next-expo-supabase-agent-harness[#<tag>] <command> [flags]
```

`help`, `--help` or no command prints a shorter version of this page.
`tests/gates/cli-docs-sync.test.mjs` fails if this page stops matching the
installer source on commands, flags, modules, tiers or placeholders.

The CLI has no runtime dependencies. It needs Node 22 or newer.

## Commands

### `init`

Scaffold the harness and reference app into a directory.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Target directory. Default `.` |
| `--tier core\|standard\|strict` | Which opt-in modules to install. Default `standard`. See [Tiers](#tiers). |
| `--modules a,b` | Explicit comma-separated module list. |
| `--set VAR=value` | Set a [placeholder](#placeholders). Repeatable. |
| `--yes` | Do not prompt. |
| `--dry-run` | Report what would be written and write nothing. |
| `--report json` | Print the install report as JSON instead of text. |
| `--consume` | For a copy made with GitHub's "Use this template": turn the checkout itself into a project, removing the installer and template trees. |

### `update`

Apply the harness version you are running to an existing install. Files the
harness owns are replaced. A file you have changed is kept, and the incoming
version is parked under `.harness/pending/` for you to merge.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Install to update. Default `.` |
| `--dry-run` | Report and write nothing. |
| `--force` | Overwrite owned files that have drifted locally instead of parking the incoming version. |
| `--refresh-seeded <path>` | Pull the template version of a seeded, project-owned file, or of a whole subtree when the path ends in `/`. Overwrites when untouched, parks on drift. Repeatable. |
| `--rollback` | Restore the tree recorded before the last update. Combines with no other update flag. |
| `--report json` | Print the update report as JSON. |

`update` refuses to run while a live Claude Code session holds
`.harness/turn.lock` for the tree.

### `doctor`

`doctor [--dir .]` reports whether an install is healthy.

### `graduate`

`graduate [--dir .]` advances the install's `baseVersion` once ramped checks
are clean. It runs validate and refuses while any ramp note remains.

### `enable <module>` and `disable <module>`

Add or remove one opt-in module in an existing install.

## Modules

`ci-mobile-release`, `ci-web-deploy`, `device-e2e`, `eas-update`,
`store-metadata`, `ci-provenance`, `gate-a11y-deep`, `crash-reporting`,
`push-notifications`, `eval-live`, `observability`, `e2ee`

## Tiers

| Tier | Modules installed |
|---|---|
| `core` | none |
| `standard` | `ci-provenance`, `ci-mobile-release`, `ci-web-deploy` |
| `strict` | all of them |

## Placeholders

Set with `--set NAME=value` on `init`, or answer the prompts. `--yes` accepts
the default for anything not set. Every value is validated.

| Placeholder | Meaning |
|---|---|
| `PROJECT_NAME` | Human-readable project name |
| `PROJECT_SLUG` | Package and machine name, kebab-case |
| `APP_IDENTIFIER` | Reverse-DNS app identifier: the iOS bundle id and Android package |
| `APP_SCHEME` | Deep-link URL scheme, lowercase alphanumerics |
| `WEB_ORIGIN` | Web app origin. Also the API host and cookie origin. |
| `DESIGN_TOKENS` | Design-token preset: `default` or `metal` |
| `SUPABASE_PROJECT_REF` | Supabase project ref, or `TBD` |
| `GITHUB_OWNER` | GitHub org or user that owns the repo |
| `SECURITY_OWNERS` | GitHub handle or team for auth and data sign-off in CODEOWNERS |
| `SECURITY_TXT_EXPIRES` | `Expires` date for the web app's `security.txt`, `YYYY-MM-DD`. Defaults to 180 days out. |
| `DEFAULT_BRANCH` | Default git branch |
| `EAS_PROJECT_ID` | EAS project id, or `TBD` |
| `ASC_APP_ID` | App Store Connect app id, or `TBD` |
| `APPLE_TEAM_ID` | Apple Developer team id, or `TBD` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error, or an unknown command |
| 2 | `init` or `update` finished, but the report lists conflicts or drift to resolve |

## Environment variables in a scaffolded project

These are read by the installed gates and hooks, not by this CLI.

| Variable | Meaning |
|---|---|
| `HARNESS_REQUIRE_TOOLCHAINS=1` | Gates that would skip because a database or toolchain is missing fail instead. `CI=true` has the same effect. |
| `HARNESS_ALLOW_SELF_EDIT=1` | Lets a human deliberately edit a guard-protected harness file. Not for routine use. |
