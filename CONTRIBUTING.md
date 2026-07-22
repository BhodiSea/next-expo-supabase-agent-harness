# Contributing

## Ground rules

1. **The selftest matrix is the contract.** Any change must keep
   `node scripts/check-syntax.mjs`, `node scripts/hygiene.mjs`, and
   `node --test tests/` green, and the `bootstrap` CI jobs (linux **and**
   windows) must still produce a project where `pnpm validate` passes out of
   the box.
2. **Nothing project-specific in `template/`.** The hygiene gate greps for
   leaked strings (real tenant IDs, DSNs, signing material, store credentials)
   and for cross-porting residue from the sibling harnesses (Tauri/cargo/Vite
   and Next.js/Supabase vocabulary must never appear in the shipped template);
   add to `scripts/hygiene.mjs` if you spot a class it misses.
3. **Zero runtime dependencies in `installer/`.** Node built-ins only — the
   installer must never itself be a supply-chain vector.
4. **Placeholder closure.** Every `{{TOKEN}}` used in `template/` must be
   registered in `installer/lib/placeholders.mjs`, and vice versa (enforced by
   hygiene).
5. **Pin everything.** GitHub Actions by full commit SHA (`@sha # vX.Y.Z`),
   npm versions via the workspace catalog (the Expo SDK and its
   `expo install --check` compatibility map are the native-side pin).
   Renovate maintains the pins with a cooldown.
6. **Gate proposals**: open a `gate-proposal` issue first. A gate must be
   deterministic, fast, and pass on the fresh scaffold — projects grow into
   gates; gates never block a fresh install. Every gate lands with its
   anti-vacuity proof (inject the violation, show the red) recorded in
   `docs/harness/gates-catalog.md`.
7. **Toolchain asymmetry is doctrine.** Gates that need Docker/Postgres, an
   Android emulator, or the Maestro binary self-skip **loudly** when the
   prerequisite is absent locally and fail closed in CI
   (`HARNESS_REQUIRE_TOOLCHAINS=1`). Never let a skip look like a pass
   silently. No selftest job may require EAS, Apple, or Google credentials —
   the harness proves itself credential-free.

## Local development

```sh
node scripts/check-syntax.mjs   # syntax over installer + template (.tmpl aware)
node scripts/hygiene.mjs        # leaked-string + placeholder closure
node scripts/check-reuse.mjs    # REUSE dual-license structure (offline mirror of `reuse lint`)
node --test tests/              # installer lifecycle + hook contracts
node installer/cli.mjs init --dir /tmp/scratch --yes   # manual smoke test

# The machinery under its own bar (pnpm install once at the repo root):
pnpm exec eslint .              # complexity <= 15 (ratcheted) + no-unused-vars over the machinery
pnpm exec tsc --noEmit          # checkJs over installer/, scripts/, tests/, template gate scripts + hooks
pnpm exec knip                  # dead exports/files/deps in the machinery
```

Root `devDependencies` are exact-pinned and never ship: the npm `files` list
excludes every root config/lockfile, and with no `prepare` script `npx
github:…` never installs them.

## Releases

1. Add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md`.
2. Bump the version everywhere the lockstep gate looks: `package.json`,
   `.claude-plugin/plugin.json`, `CITATION.cff`, and the five
   `HARNESS_HOOK_VERSION` stamps under `template/base/.claude/hooks/`.
3. Run `node scripts/check-release-lockstep.mjs` — the same check runs on every
   PR in the selftest matrix and again at tag time.
4. Tag `vx.y.z` and push — `release.yml` re-runs the gates, waits for a green
   selftest matrix on the tagged SHA, verifies the changelog section, packs,
   attests provenance, and publishes the GitHub Release.
