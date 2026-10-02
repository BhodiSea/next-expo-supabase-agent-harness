# CLI reference

```sh
npx --yes next-expo-supabase-agent-harness@<latest|version> <command> [flags]
```

`@latest` runs the newest release and `@<version>` an exact one. The older
`github:BhodiSea/next-expo-supabase-agent-harness#<tag>` spelling fetches the
repository at a git ref instead; npm 12 refuses it unless run with `--allow-git=root`.

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

"Changed" means the bytes are not ones a release shipped. A file that still
matches its record in `.harness/manifest.json` is replaced only when that
record is a sha the harness actually shipped for that path. A fork whose sha
you re-recorded (the way to keep `gate-integrity` green on a deliberate fork)
is kept: the incoming version is parked when upstream changed that file since
your install's version, and nothing is parked when it did not. The upgrade
runbook's "Forking an owned file" section describes the flow.

A file at a harness-owned path with no record in `.harness/manifest.json` is
judged by its bytes alone. It is replaced only when some release of the harness
shipped exactly those bytes for that path. Otherwise it is kept and the
incoming version is parked, whether or not upstream changed the file. A
`removed` or `renamed` migration leaves such a file in place in the same case.
The upgrade runbook's 1.0.4 section describes how to resolve it.

When `update` keeps your `.claude/settings.json` (a fork, or a retrofit merge),
a hook new in the incoming version that your settings do not wire is parked
under `.harness/pending/.claude/hooks/` beside the parked settings instead of
being written, because `wiring` reds a hook on disk that nothing wires. Merge
its entry into your settings and run `update` again to have it written and
recorded. The upgrade runbook's 1.1.0 section describes the flow.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Install to update. Default `.` |
| `--dry-run` | Report and write nothing. The report names every path a real run would write and every path it would park. |
| `--force` | Overwrite owned files that have drifted locally, that you forked and re-recorded, or that have no manifest record and bytes no release shipped, instead of parking the incoming version. |
| `--refresh-seeded <path>` | Pull the template version of a seeded, project-owned file, or of a whole subtree when the path ends in `/`. Overwrites when untouched, parks on drift. Repeatable. |
| `--rollback` | Restore the tree recorded before the last update. Combines with no other update flag. |
| `--report json` | Print the update report as JSON. |

`--rollback` also removes a directory the update created where the snapshot
shows nothing was there, and restores a file the update replaced with a
directory. A directory at a path where the snapshot found something other than
a regular file is left in place, with a note. Two cases are left in place as
conflicts: a directory at a path a snapshot written by 1.0.3 or earlier records
as absent, because such a snapshot cannot show the path was empty, and a
directory whose parent leads outside the install through a symlink. Every other
path and the manifest are still restored.

`update` refuses to run while a live Claude Code session holds
`.harness/turn.lock` for the tree.

### `doctor`

`doctor [--dir .]` reports whether an install is healthy. It lists each
re-recorded fork of a harness-owned file as `info`, which does not change the
exit code.

It also prints a toolchain report as `info` lines. For `node`, `pnpm`, the
Supabase CLI (the workspace copy in `node_modules/.bin` and the one on `PATH`)
and `psql`, each line names the binary it found, that binary's version, and the
pin it is compared with: `.node-version`, the `packageManager` field of
`package.json`, the `supabase` entry of the `pnpm-workspace.yaml` catalog, and
`major_version` under `[db]` in `supabase/config.toml`. A tool that could not be
run, or did not answer within 10 seconds, is reported as not probed, with the
reason. The report never changes the exit code.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Install to check. Default `.` |
| `--clean` | Delete ignored residue that nothing else deletes: `.harness/stop-output/` (the Stop hook's full step logs), `apps/mobile/dist/` (the build gate's export), and the ignored build output and tool caches `apps/web/.next/`, `apps/mobile/.expo/`, `coverage/`, `.stryker-tmp/` and `.eslintcache`, which the bash guard's `rm-rf` deny points here for. Each removed path is printed. An entry is skipped, with a note, unless it is inside the install, not reached through a symlink, ignored by git and holds no tracked file; in a directory that is not a git repository every entry is skipped. The list is fixed. The install manifest, `.harness/pending/`, `.harness/rollback/`, `.harness/turn.lock`, the `.jsonl` ledgers and the `.ok` stamps are never on it. |
| `--dry-run` | With `--clean`, list what would be deleted and delete nothing. |

`--clean` does not change the exit code either.

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
| 2 | `init`, `update` or `update --rollback` finished, but the report lists conflicts or drift to resolve. For `update` that includes a forked file whose incoming version was parked because upstream changed it, and a file with no manifest record whose bytes no release shipped. For `update --rollback` it is a directory left in place that the update may have created |

## Environment variables in a scaffolded project

These are read by the installed gates and hooks, not by this CLI.

| Variable | Meaning |
|---|---|
| `HARNESS_REQUIRE_TOOLCHAINS=1` | Gates that would skip because a database or toolchain is missing fail instead, and no gate honours a stamp from its last green run. `CI=true` has the same effect. `node tools/validate.mjs --ci-parity` sets it for one run and closes by naming each missing prerequisite. |
| `HARNESS_ALLOW_SELF_EDIT=1` | Lets a human deliberately edit a guard-protected harness file. Not for routine use. |
