# Architecture

How this repository is put together, for someone about to change it. The
architecture of the application it scaffolds is described in the scaffold's own
`AGENTS.md` and in [`design/W1-STACK-SPEC.md`](../design/W1-STACK-SPEC.md).

## Two products in one repository

1. **The installer**, a Node CLI with no runtime dependencies (`installer/`).
2. **The template** it installs (`template/`): the gate scripts, hooks,
   workflows and reference app that end up in a consumer's repository.

Everything else, `scripts/`, `tests/` and `.github/`, exists to hold those two
to the same standard the template imposes on a consumer. This repository is
called the factory in its own comments, and an installed project the consumer.

```
installer/          the CLI: commands/ (init, update, doctor, enable, graduate) and lib/
template/
  base/             installed into every consumer: tools/ (gates), .claude/ (hooks,
                    agents, rules, skills), github/ (workflows), docs/
  stack/            the reference app: apps/web, apps/mobile, packages/, supabase/
  modules/          twelve opt-in modules, each a partial tree overlaid on the install
  presets/          alternative design-token sets
  migrations.json   per-release instructions that `update` executes on existing installs
scripts/            factory-only gates (check-*.mjs), release and CI helpers
tests/              gates/, hooks/, installer/, canary/ (the can-fail registry)
design/             dated, sourced facts that the template and gates are written against
```

Template workflows live under `template/base/github/`, without the leading
dot, so that they can never run in this repository's own Actions context. The
installer renames the directory on the way out.

## The installer

`init` renders the template into a target directory. It resolves `base` plus
`stack`, plus the modules chosen by tier or `--modules`, substitutes
`{{PLACEHOLDER}}` tokens from a closed registry
(`installer/lib/placeholders.mjs`), and writes `.harness/manifest.json`.

The manifest is what makes upgrades possible. It records:

- `harnessVersion`, the version that last wrote the install, and `baseVersion`,
  the version whose rules the project has fully adopted. The gap between them
  is how a new gate reaches an old project without breaking it on arrival (see
  Ramps below).
- The tier, the modules and the placeholder answers.
- For every installed file, a mode and a sha256.

The mode decides what `update` may do to a file:

| Mode | Meaning | On `update` |
|---|---|---|
| `owned` | Harness machinery: gate scripts, hooks, workflows, harness docs | Replaced when the file still matches its recorded sha. If the consumer changed it, their copy is kept and the incoming version is parked under `.harness/pending/`. |
| `seeded` | The consumer's code and decisions: app source, the pnpm catalog, reviewed allowlists | Never touched. `--refresh-seeded <path>` pulls a new template version on request. |
| `config` | `tools/harness.config.mjs`, the gate chain definition | Edited only through recorded `configSteps`, so a new gate can be inserted without overwriting local additions. |

`update` snapshots every path it might touch under `.harness/rollback/` before
its first write, writes atomically, and writes the manifest last, so an
interrupted update can be re-run or rolled back. `doctor` reports drift.
`graduate` advances `baseVersion` once no ramp note remains.

## The three enforcement layers in an installed project

All three read the same definition of the gate chain,
`tools/harness.config.mjs`, so they cannot disagree about what is required.

1. **Before a tool runs.** Claude Code `PreToolUse` hooks judge every shell
   command, file write and MCP call against data tables in
   `.claude/hooks/lib/guard-rules.mjs`. Each hook is started through
   `launch.mjs`, which exits 2 (block) if the hook cannot load, so a broken
   hook does not fail open.
2. **Before a turn ends.** The `Stop` hook runs the validate chain and the
   Stop-only steps (RLS isolation, both unit suites with coverage, diff
   coverage, duplication, i18n, test quality, the mobile perf closure, reviewer
   verdicts) and refuses to end the turn until they pass.
3. **Before a merge.** The consumer's workflows run the same chain with
   `--min-floor`, against `tools/validate.floor.json`, a frozen copy of the
   step list. A project can add steps to its chain. It cannot remove one
   without CI noticing, because the floor ships as an owned, hash-pinned file.
   `tools/stop.floor.json` does the same for the Stop chain.

`gate-integrity`, the second step of the chain, hashes the owned files against
the manifest. Editing a gate to make it pass turns that step red.

The local layers are tamper-evident, not tamper-proof: an agent with shell
access can get around them. CI and code-owner review are the backstop.
[SECURITY.md](../SECURITY.md) and
[security/assurance-case.md](security/assurance-case.md) state the limits.

## Ramps: how a new gate reaches an existing install

A new gate would turn every existing project red on the day it upgrades. So a
gate can ship with a ramp. For an install whose `baseVersion` is older than the
gate, its findings are printed as notes, not failures, until a named release.
After that release they are failures. `template/migrations.json` records each
release's ramps, and `scripts/check-ramp-ledger.mjs` computes which installed
versions a release will turn red and requires the record to say so.

Ramps are for new gates. A raised security floor is not ramped, and reaches
every install at once.

## How the factory checks itself

| Mechanism | What it establishes |
|---|---|
| `tests/` (`node --test`) | Unit tests for the installer, every gate script and every hook |
| `tests/canary/injections.json` and `scripts/check-canary-coverage.mjs` | Every gate, every guard rule and every CI job has a registered proof that it can fail. A gate that cannot go red is treated as decoration. |
| `selftest.yml` `bootstrap-linux` | A scaffold rendered with no edits passes the whole chain, against a live Supabase stack |
| `selftest.yml` `canary` | Each registered violation, injected into a real scaffold, turns the matching gate red |
| `selftest.yml` `upgrade-linux` | Thirteen legs, from v0.1.3 to the previous release, each install an old version, update it to HEAD and judge the result. This is the test of `template/migrations.json`. |
| `scripts/check-claims.mjs` | Every number in the README, CHANGELOG and shipped docs is recomputed from its source of truth |
| `scripts/hygiene.mjs` | Nothing specific to this project leaks into `template/`, and the placeholder registry is closed in both directions |
| `scripts/check-release-lockstep.mjs` | One version across the package, plugin manifest, citation file, hook stamps and changelog |
| `scripts/check-sbom-drift.mjs` | Every dependency added since the previous release has a reviewed row |
| `.claude/` | The shipped bash guard and an equivalent write guard and Stop gate run on this repository, so a maintainer meets a bug in the guards before a consumer does |

Checks whose verdict depends on the date or the network, such as review
windows, dated obligations, dead citations and the vulnerability scan of the
factory lockfile, run only on a schedule in `hygiene.yml`, so they cannot turn
an unrelated pull request red.

## Release path

A tag `v*` starts `release.yml`. It re-runs the gates, waits for green
`selftest.yml` and `lint.yml` runs on the tagged commit, checks that the
CHANGELOG has a section for the tag, runs `npm pack`, signs a build provenance
attestation for the tarball, and publishes a GitHub Release. Nothing is
published to the npm registry. CONTRIBUTING.md, "Releases", is the procedure.

## Further reading

| File | Subject |
|---|---|
| [`design/CONTROL-PLANE-FACTS.md`](../design/CONTROL-PLANE-FACTS.md) | What Claude Code passes to a hook, verified |
| [`design/CI-LANE-FACTS.md`](../design/CI-LANE-FACTS.md) | Facts the device and e2e lanes depend on |
| [`design/RELEASE-FACTS.md`](../design/RELEASE-FACTS.md) | Facts the release and module workflows depend on |
| [`design/EXPO-FACTS.md`](../design/EXPO-FACTS.md) | Platform facts behind the mobile template |
| [`design/CONFORMANCE-FACTS.md`](../design/CONFORMANCE-FACTS.md) | What the mapped standards and their deadlines say |
| [`template/base/docs/harness/README.md`](../template/base/docs/harness/README.md) | The doctrine, as shipped to consumers |
| [`template/base/docs/harness/gates-catalog.md`](../template/base/docs/harness/gates-catalog.md) | Every gate, with its can-fail proof |
| [`template/base/docs/runbooks/harness-upgrade.md`](../template/base/docs/runbooks/harness-upgrade.md) | What each release does to an existing install |
