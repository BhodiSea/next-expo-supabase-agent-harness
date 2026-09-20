# next-expo-supabase-agent-harness

A CLI that scaffolds a pnpm monorepo with a Next.js 16 web app and an Expo 57
mobile app on one Supabase backend, plus Claude Code hooks and CI gates that
block an agent turn or a merge until validation passes.

```sh
npx --yes github:BhodiSea/next-expo-supabase-agent-harness init
```

Pin a release by appending a tag, for example
`github:BhodiSea/next-expo-supabase-agent-harness#v1.0.1`. Then, in the new
directory:

```sh
git init          # first: the prepare script (lefthook install) needs a repository
pnpm install
git add -A && git commit -m "chore: scaffold"   # the first commit must include pnpm-lock.yaml
pnpm validate
```

The package installs from GitHub. It is not published to the npm registry. Each
GitHub Release carries the packed tarball with a build provenance attestation;
see [Verifying a release](SECURITY.md#verifying-a-release).

**Status: stable (1.0.x).** CI proves the scaffold on Linux only. The installer's
unit tests also run on Windows. `pnpm validate` has never run in CI on macOS or
Windows. See [Limitations](#limitations).

## Requirements

- Node 22 or newer
- pnpm 11 (`corepack enable` picks up the pinned version)
- Docker, for the local Supabase stack that the database gates run against
- Optional: the `gitleaks` binary. The pre-commit secrets scan prints a skip
  notice without it.

## What you get

```
apps/web        Next.js 16 App Router. Serves the tRPC API for both clients.
apps/mobile     Expo 57, expo-router, React Native 0.86.
packages/api            framework-neutral tRPC v11 router
packages/contracts      zod DTOs shared by both apps
packages/platform/*     env, errors, events, observability, ratelimit, supabase
packages/verticals/notes   one worked feature, end to end on both apps
packages/design-tokens, design-system, design-system-native
supabase/       SQL-first schema, migrations, RLS policies, pgTAP tests, one Edge Function
tools/, .claude/, .github/   the gates, hooks and workflows described below
```

Postgres row-level security keyed on `auth.uid()` is the one authorization
boundary for both apps. Versions are pinned in a single pnpm catalog
(`pnpm-workspace.yaml`): Next 16.3, Expo 57, React 19.2, TypeScript 6, Biome 2.5,
supabase-js 2, tRPC 11, zod 4.

## How it works

- **PreToolUse guards.** Hooks check every shell command, file write and MCP
  call against a data table of 142 guard-rule ids before the agent's tool runs.
  Eight hooks are wired: seven guards and a launcher that fails closed if a
  hook cannot load.
- **Stop hook.** The agent cannot end a turn until `pnpm validate`, the RLS
  isolation tests against a real Postgres, both unit suites with coverage,
  per-file diff coverage, duplication, i18n, test quality, the mobile perf
  closure and the reviewer verdicts all pass.
- **`pnpm validate`.** One chain of 36 gates, ordered cheap to expensive, driven
  by `tools/harness.config.mjs`. Each gate is documented with a proof that it
  can fail in the [gates catalog](template/base/docs/harness/gates-catalog.md).
- **CI.** The same chain runs against a frozen copy of the step list
  (`tools/validate.floor.json`), so a project can add gates but cannot quietly
  remove one. Gates that need a database or a toolchain skip loudly on a
  laptop and fail closed in CI.
- **Commit hooks.** lefthook runs Biome and gitleaks before a commit and
  commitlint on the message.

The design is described in the
[harness doctrine](template/base/docs/harness/README.md), which ships into every
scaffold.

## Commands

| Command | What it does |
|---|---|
| `init` | Scaffold into `--dir` (default `.`). `--tier core\|standard\|strict`, `--modules a,b`, `--set VAR=value`, `--dry-run`. |
| `update` | Apply a newer harness version to an existing install. `--rollback` restores the tree recorded before the last update. |
| `doctor` | Report whether an install is healthy. |
| `enable <module>` / `disable <module>` | Add or remove an opt-in module. |
| `graduate` | Advance the install's base version once ramped checks are clean. |

Full flag and placeholder reference: [docs/cli.md](docs/cli.md), or `--help`.

Tiers choose which opt-in modules are installed. `core` installs none.
`standard` (the default) installs `ci-provenance`, `ci-mobile-release` and
`ci-web-deploy`. `strict` installs all twelve: those three plus `device-e2e`,
`eas-update`, `store-metadata`, `gate-a11y-deep`, `crash-reporting`,
`push-notifications`, `eval-live`, `observability` and `e2ee`. The Vercel deploy
workflow, EAS Build/Submit and release-please come from modules, not the base.

## Limitations

- **Linux-only proof.** Every CI lane that runs the scaffold runs on
  `ubuntu-latest`. There is no macOS lane.
- **Rate limiting covers the application layer only.** It binds the tRPC router
  and Next.js Server Actions. It does not bound direct PostgREST calls made
  with a user's JWT, or sign-in and sign-up, which go to Supabase Auth. If the
  rate-limit backend is unreachable, it degrades to an in-process limiter, and
  it fails open if that also fails.
- **The `e2ee` module ships building blocks, not an encrypted app.** No shipped
  feature is encrypted; the `notes` example stores plaintext. The module's own
  README lists what it does not solve.
- **Device tests are not per-PR.** The Android emulator and Maestro lane runs on
  a schedule and on manual dispatch.
- **The guards are tamper-evident, not tamper-proof.** See the scope notes in
  [SECURITY.md](SECURITY.md).

The longer list is kept per release under "What stays open" in the
[CHANGELOG](CHANGELOG.md).

## Measured cost

Recorded by CI on a GitHub-hosted Linux x64 runner on 2026-08-16 and committed
in `scripts/chain-budget.json`. They are that runner's numbers, not a promise
about your machine.

| Run | Wall time |
|---|---|
| `pnpm validate`, warm | warm ≈ 23 s (23030 ms) |
| `pnpm validate`, cold | cold ≈ 110 s (110224 ms) |
| Stop hook, full turn end | 52.7 s (52665 ms) |

## Compliance mappings

The scaffold ships two registers that map published requirements to the gate,
hook or test that addresses each one, including the requirements it does not
meet. These are mappings. They are not certifications, and the project claims
no conformance level. The gates print the current standing as:

```
149 ML3 requirements: 8 effective, 13 alternate-control, 11 not-implemented, 61 not-applicable, 56 organisation-boundary; 8 shared clauses
392 mapped requirements: 11 covered, 149 partial, 105 not-covered, 127 not-applicable — ASVS 5.0.0 (345), MASVS 2.1 (24), CRA Annex I (23)
```

The first line counts the requirements of ASD's Essential Eight
([register](template/base/docs/compliance/essential-eight.md)). The second
counts the requirements of three further standards
([crosswalk](template/base/docs/compliance/controls-crosswalk.md)).

## Contributing and feedback

- Bugs and gate proposals: [open an issue](https://github.com/BhodiSea/next-expo-supabase-agent-harness/issues/new/choose)
- Questions: [Discussions](https://github.com/BhodiSea/next-expo-supabase-agent-harness/discussions)
- Pull requests: read [CONTRIBUTING.md](CONTRIBUTING.md) first. It lists every check CI blocks on.
- Vulnerabilities: report privately, as described in [SECURITY.md](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

This repository is also a GitHub template repository. To fork the harness
itself into a sibling for a different stack, follow
[docs/forking.md](docs/forking.md). It is descended from
[expo-postgres-agent-harness](https://github.com/BhodiSea/expo-postgres-agent-harness)
and
[tauri-postgres-agent-harness](https://github.com/BhodiSea/tauri-postgres-agent-harness).

## License

Apache-2.0 for the repository. Everything under `template/**` is
"Apache-2.0 OR 0BSD": recipients choose either, so scaffolded code carries no
attribution requirement.
