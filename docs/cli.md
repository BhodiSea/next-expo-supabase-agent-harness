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
| `--with-demo` | Also plant the worked example (2.0.0): the notes vertical, its web route, Server Action and read seam, the mobile notes and matrix screens, its router, its migrations, and the example's rows in the seeded registers. A default `init` plans none of it. Recorded as `demo: true` in `.harness/manifest.json`, carried by `init --force`, and refused for a retrofit. `eject` removes it again. |

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

`update` never edits `pnpm-workspace.yaml` or `package.json`. When a release
recorded a security floor for a catalog pin (`catalogPinFloors` in
`template/migrations.json`) and your catalog does not provably meet it, `update`
prints a `CATALOG PIN FLOOR` note naming the package, the pin and the floor,
and parks the list at `.harness/pending/pin-floors.json`. The exit code does not
change, and the file is deleted once every floor is met.

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
exit code. It also lists, as `info`, each register proposal waiting in
`harness-proposals/` for [`apply-proposal`](#apply-proposal-id).

It warns once for each catalog pin below a security floor a release recorded,
which makes the exit code 2; a floor never makes it 1. The pin is judged by the
lower bound of its catalog value, and a value that is not a version is treated
as below the floor. Once every floor is met, `doctor` deletes
`.harness/pending/pin-floors.json` and says so as `info`.

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

### `eject`

Remove the worked example from an install made with `init --with-demo`
(2.0.0). It works in three parts:

1. A file only the demo ships is deleted while it is still the demo's: its
   bytes match its record in `.harness/manifest.json`, and that record is the
   demo's bytes. A file you changed, or forked and re-recorded, is kept, its
   record is dropped, and `eject` lists it.
2. A shared file the demo replaced (the API router, the mobile home tab, the
   command palette, the seeded registers) gets the default install's bytes back
   while it is still the demo's. One you changed is kept, and the default copy
   is parked under `.harness/pending/`.
3. In a seeded register you changed, only the demo's rows are deleted, and
   only where they still equal the row the demo shipped. `template/demo-index.json`
   lists those rows, as `{file, jsonPointer}` or, for `PARITY.md`, `{file, rowKey}`.

`eject` also drops the root `tsconfig.json` reference to each package it
deleted, and records each migration it deleted, with the sha256 of the deleted
bytes, as `ejectedMigrations` in the manifest. The `migrations` gate accepts the
deletion of exactly those bytes and still fails on any other deleted or edited
migration. If a database you keep has already applied the demo's migrations,
read the upgrade runbook's 2.0.0 section before you commit their deletion.

After `eject` on an untouched demo install, the tree outside `.harness/` is
byte for byte the tree a default `init` with the same answers writes. Run
`pnpm install` next, because the lockfile still names the demo's workspace
packages. Then commit, and only then run `pnpm validate`: `eject` rewrites
registers that `gate-integrity` holds to a commit, so a validate before the
commit fails on each of them.

`eject` exits 1 on an install without the demo: one made without
`--with-demo`, or one made before 2.0.0, whose example is written into the spine
migrations and cannot be removed file by file. It exits 2 when it kept anything.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Install to eject the demo from. Default `.` |
| `--dry-run` | List what a real run would remove and write nothing. |
| `--report json` | Print the eject report as JSON. |

### `apply-proposal [<id>]`

Apply a register edit an agent staged for you. The write guard denies an agent
every reviewed register under `tools/` (the allowlists, budgets and registers).
Instead of asking you to type the edit, or to relaunch the session with
`HARNESS_ALLOW_SELF_EDIT=1`, an agent writes the whole proposed file as one JSON
document in `harness-proposals/<id>.json`, a committed directory outside every
path the guards protect:

```json
{
  "version": 1,
  "target": "tools/i18n-allow.json",
  "reason": "Why the register should change.",
  "base": "<output of git rev-parse HEAD:tools/i18n-allow.json, or null if the file is not in HEAD>",
  "content": "<the whole proposed file>"
}
```

With no id, `apply-proposal` lists the pending proposals. With an id it
validates the proposal, prints its reason and a `git diff --no-index` of the
current file against the proposed one, and asks you to type the target path.
Only that answer writes the file. It then deletes the proposal and prints
`commit <target>`. The register is left uncommitted, and `gate-integrity` fails
on an uncommitted escape list until you commit it.

It refuses, exits 1 and writes nothing when the target is not a register a
proposal may target, when the id or the target resolves outside `--dir`, when
`content` is not JSON, when `base` does not equal `git rev-parse HEAD:<target>`
(a null `base` for a file that is in `HEAD`, or a non-null one for a file that
is not, included), when the target has uncommitted changes, when stdin or
stdout is not a terminal, and when the reason, target or content carries a
control or bidirectional-format character. The base and uncommitted-changes
checks run again after you answer. A proposal may target the escape lists in
`tools/lib/enforcement-surface.mjs`, except `tools/perf-baseline.json` and
`tools/mutation-baseline.json`, which only their generators write, plus
`tools/field-notes.json`. The bash guard denies an agent this command
(`apply-proposal-invocation`).

| Flag | Meaning |
|---|---|
| `--dir <path>` | The install. Default `.` |
| `--dry-run` | Print the reason and the diff, ask nothing and write nothing. |

There is no `--yes`, and `--yes` or `--force` is refused.

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
| 1 | Error, or an unknown command. For `eject`, also an install without the demo |
| 2 | `init`, `update`, `update --rollback` or `eject` finished, but the report lists conflicts or drift to resolve. For `update` that includes a forked file whose incoming version was parked because upstream changed it, and a file with no manifest record whose bytes no release shipped. For `update --rollback` it is a directory left in place that the update may have created. For `eject` it is a demo file, row or reference it kept because you changed it |

## Environment variables in a scaffolded project

These are read by the installed gates and hooks, not by this CLI.

| Variable | Meaning |
|---|---|
| `HARNESS_REQUIRE_TOOLCHAINS=1` | Gates that would skip because a database or toolchain is missing fail instead, and no gate honours a stamp from its last green run. `CI=true` has the same effect. `node tools/validate.mjs --ci-parity` sets it for one run and closes by naming each missing prerequisite. |
| `HARNESS_ALLOW_SELF_EDIT=1` | Lets a human deliberately edit a guard-protected harness file. Not for routine use. What it relaxes: [the doctrine](../template/base/docs/harness/README.md), section "What `HARNESS_ALLOW_SELF_EDIT=1` relaxes". |
