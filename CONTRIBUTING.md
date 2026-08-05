# Contributing

## Ground rules

1. **The selftest matrix is the contract.** Any change must keep
   `node scripts/check-syntax.mjs`, `node scripts/hygiene.mjs`, and
   `node --test tests/` green, and the `bootstrap` CI jobs (linux **and**
   windows) must still produce a project where `pnpm validate` passes out of
   the box.
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
node --test "tests/**/*.test.mjs"       # gate proofs + installer lifecycle + hook contracts

# The machinery under its own bar (pnpm install once at the repo root):
pnpm exec eslint . --max-warnings 0     # no-unused-vars + complexity <= 15 over the machinery
pnpm exec tsc --noEmit                  # checkJs over installer/, scripts/, tests/, gate scripts + hooks
pnpm exec knip                          # dead exports/files/deps in the machinery
node scripts/check-complexity-ratchet.mjs  # re-lints with --no-inline-config: a disable cannot hide growth
node scripts/check-rule-integrity.mjs      # the shipped boundary rules cannot be deleted or narrowed

# The one that matters most — the scaffold must be green with ZERO edits:
node installer/cli.mjs init --dir /tmp/scratch --tier core --yes
cd /tmp/scratch && pnpm install && git init -q && git add -A \
  && git -c user.email=x@y.z -c user.name=x commit -qm "chore: baseline" \
  && node tools/validate.mjs --report-all
```

`--report-all` runs all **31** steps and shows every red at once. The two added in
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
   `.claude-plugin/plugin.json`, `CITATION.cff`, and the **six**
   `HARNESS_HOOK_VERSION` stamps under `template/base/.claude/hooks/`
   (`pretool-mcp-guard.mjs` joined them in 0.3.0 — the gate iterates the
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
