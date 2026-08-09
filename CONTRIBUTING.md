# Contributing

## Ground rules

1. **The selftest matrix is the contract.** Any change must keep
   `node scripts/check-syntax.mjs`, `node scripts/hygiene.mjs`, and
   `node --test tests/` green, and the scaffold-green jobs — `bootstrap-linux`
   (node 22 **and** 24) and `metal-bootstrap` — must still produce a project
   where `pnpm validate` passes out of the box. Both run on **ubuntu only**:
   the one Windows runner in the matrix is `installer-unit`, which exists for
   the path-separator/CRLF bug class and does not build a scaffold. (This
   sentence claimed a Windows `bootstrap` job through 0.5.0. There has never
   been one — so "green on Windows" has never meant "a Windows scaffold is
   green", and nobody should read it that way.)
2. **Nothing project-specific in `template/`.** The hygiene gate greps for
   leaked strings (real tenant IDs, DSNs, signing material, store credentials)
   and for cross-porting residue from the SIBLING harnesses — Hono, Drizzle,
   Tauri, cargo, Vite vocabulary must never appear in the shipped template. Next,
   Expo, Supabase and Vercel are this lineage's OWN stack and are expected there;
   they were deliberately dropped from the inherited deny set (see the comment
   block in `scripts/hygiene.mjs`). Add to that file if you spot a class it misses.
3. **Zero runtime dependencies in `installer/`.** Node built-ins only — the
   installer must never itself be a supply-chain vector.
4. **Placeholder closure.** Every `{{TOKEN}}` used in `template/` must be
   registered in `installer/lib/placeholders.mjs`, and vice versa (enforced by
   hygiene).
5. **Pin everything.** GitHub Actions by full commit SHA (`@sha # vX.Y.Z`),
   npm versions via the workspace catalog (the Expo SDK and its
   `expo install --check` compatibility map are the native-side pin).
   Renovate maintains the pins with a cooldown.
6. **Gate proposals**: open an issue first, labelled `gate-proposal`. A gate must
   be deterministic, HERMETIC, fast, and pass on the fresh scaffold — projects
   grow into gates; gates never block a fresh install. Hermetic is not a nicety:
   a gate that resolves its expectations from a live third-party endpoint will
   turn an untouched commit red overnight, and this repo has already paid for
   that once. Every gate lands with its anti-vacuity proof (inject the violation,
   show the red) recorded in `template/base/docs/harness/gates-catalog.md` and
   registered in `tests/canary/injections.json`.
7. **Toolchain asymmetry is doctrine.** Gates that need Docker/Postgres, an
   Android emulator, or the Maestro binary self-skip **loudly** when the
   prerequisite is absent locally and fail closed in CI
   (`HARNESS_REQUIRE_TOOLCHAINS=1`). Never let a skip look like a pass
   silently. No selftest job may require EAS, Apple, or Google credentials —
   the harness proves itself credential-free.

## Local development

This list is the whole of what CI blocks on. Run all of it — a subset is how four
of these came to be red at once behind a single early failure.

```sh
node scripts/check-syntax.mjs           # syntax over installer + template (.tmpl aware)
node scripts/hygiene.mjs                # leaked-string + placeholder closure + cross-porting detectors
node scripts/check-reuse.mjs            # REUSE dual-license structure (offline mirror of `reuse lint`)
node scripts/check-claims.mjs           # README/CHANGELOG numbers recomputed from the sources of truth
node scripts/check-release-lockstep.mjs # one version across package.json, plugin, hooks, CITATION, CHANGELOG
node scripts/check-plugin-manifest.mjs  # plugin/marketplace fields + every referenced path exists
node scripts/check-canary-coverage.mjs  # every gate AND every job in all eight shipped workflows has a registered, RUNNING red-proof
node scripts/generate-floor.mjs --check    # BOTH frozen snapshots (validate.floor.json, stop.floor.json) mirror the config
# RUN THE SUITE IN THE CI ENVIRONMENT SHAPE, not your shell's. Gate fixtures build a
# THROWAWAY git repo with no remote, and on a `pull_request` run GITHUB_BASE_REF names the
# base branch of the PR against THIS repo — so a gate that resolves a diff base looks for an
# `origin/main` the fixture does not have and fails CLOSED, correctly. Nine tests in one file
# then asserted against the fail-closed verdict: green in every maintainer's shell, red only
# on the PR. CI is the enforcement (this is exactly how it was caught); the export is how you
# find out in seconds instead of after a full matrix run.
GITHUB_BASE_REF=main CI=true node --test "tests/**/*.test.mjs"   # gate proofs + installer lifecycle + hook contracts

# The machinery under its own bar (pnpm install once at the repo root):
pnpm exec eslint . --max-warnings 0     # no-unused-vars + complexity <= 15 over the machinery
pnpm exec tsc --noEmit                  # checkJs over installer/, scripts/, tests/, gate scripts + hooks
pnpm exec knip                          # dead exports/files/deps in the machinery
node scripts/check-complexity-ratchet.mjs  # re-lints with --no-inline-config: a disable cannot hide growth
node scripts/check-rule-integrity.mjs      # the shipped boundary rules cannot be deleted or narrowed
# The other five lint.yml blockers. The four machinery-lint ones were missing from this
# list through 0.5.0, so a maintainer who ran the list literally went red in CI on four
# checks they never ran — precisely the "a subset is how four of these came to be red at
# once" failure the paragraph above this block warns about — and check-seeded-migrations
# was missing through 0.6.0. check-claims now derives lint.yml's blocking check list and
# refuses this section omitting any of it, so the closure is mechanical rather than
# remembered. The last three need full git history (fetch-depth: 0) and SKIP LOUDLY
# without a previous release tag rather than passing.
node scripts/check-escape-registry.mjs     # SEEDED_FILES / ESCAPE_LISTS / WRITE_PROTECTED reconcile
node scripts/check-tier-coverage.mjs       # every one-surface gate declares its surface
node scripts/check-ramp-ledger.mjs         # no never-armed ramp; the expiry population is derived
node scripts/check-dependency-channel.mjs  # every owned-config dependency has a channel to an EXISTING install
node scripts/check-seeded-migrations.mjs   # seedOnInitOnly completeness: an unregistered seeded addition auto-plants on `update`

# The one that matters most — the scaffold must be green with ZERO edits:
node installer/cli.mjs init --dir /tmp/scratch --tier core --yes
cd /tmp/scratch && pnpm install && git init -q && git add -A \
  && git -c user.email=x@y.z -c user.name=x commit -qm "chore: baseline" \
  && node tools/validate.mjs --report-all
```

`--report-all` runs all **34** steps and shows every red at once. The two added in
0.3.0 run before anything expensive and are the ones most likely to catch a
machinery mistake: `wiring` (step 3 — are the enforcement layers actually
connected) and `secrets` (step 4 — a hermetic credential scan, in rule-id lockstep
with `.gitleaks.toml`).

Root `devDependencies` are exact-pinned and never ship: the npm `files` list
excludes every root config/lockfile, and with no `prepare` script `npx
github:…` never installs them.

## Releases

1. Add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md`.
2. Bump the version everywhere the lockstep gate looks: `package.json`,
   `.claude-plugin/plugin.json`, `CITATION.cff`, and the **seven**
   `HARNESS_HOOK_VERSION` stamps under `template/base/.claude/hooks/`
   (`subagent-verdict.mjs` joined them in 0.6.0 — the gate iterates the
   directory, so the count follows the tree rather than this sentence).
3. Run `node scripts/check-release-lockstep.mjs` — the same check runs on every
   PR in the selftest matrix and again at tag time.
4. **Confirm `upgrade-linux` is green on the release commit.** It installs the
   PREVIOUS release tag, runs HEAD's `update`, and asserts what only an upgraded
   install can show: the injected chain steps arrived, the planted data files are
   there and the tolerated-absent ones are not, `doctor` never says broken, the
   chain is green, every ramp NOTE names the release it expires in, and
   `graduate` refuses while those NOTEs stand. **No `template/migrations.json`
   record is trustworthy until that lane has executed** — the 0.2.0 changelog
   records an update-planted defect found "by running the real upgrade, not by
   reading the plan", and this lane is that act's CI successor.
5. Tag `vx.y.z` and push — `release.yml` re-runs the gates, waits for a green
   selftest matrix on the tagged SHA, verifies the changelog section, packs,
   attests provenance, and publishes the GitHub Release.
