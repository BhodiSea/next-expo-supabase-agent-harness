// tools/harness.config.mjs — the single source of truth for the quality gate.
// Consumed by tools/validate.mjs (`pnpm validate`), the Stop hook, and CI, so the three
// enforcement layers can never disagree about what "done" means.
//
// HARNESS-PROTECTED: the write-guard hook denies agent edits to this file unless
// HARNESS_ALLOW_SELF_EDIT=1 is set, and CI re-runs the same steps with a hardcoded
// floor (`node tools/validate.mjs --min-floor`) — so editing this config can ADD
// steps but can never weaken the non-negotiable ones.
// SOURCE: docs/harness/README.md (the gate config is harness-protected and mirrored in CI) [corpus: harness/doctrine]

// Each step is [name, shellCommand]. Steps run sequentially, cheap → expensive;
// the first failure stops the run. Toolchain-dependent steps and surface-dependent
// gate scripts self-skip LOUDLY when their prerequisite is absent locally and fail
// closed in CI (HARNESS_REQUIRE_TOOLCHAINS=1) — a skip must never be mistakable
// for a pass.
export const VALIDATE_STEPS = [
  ['format', 'pnpm exec biome ci .'],
  ['gate-integrity', 'node tools/check-gate-integrity.mjs'],
  // `tsc -b .` builds the composite package graph; `apps/web apps/mobile` are added as
  // extra build ROOTS so the two non-composite leaf apps are typechecked in the same
  // invocation (they cannot be `references` of the solution — a referenced project must be
  // composite, and an app that emits a declaration reds on the tRPC client's private
  // symbol; see apps/*/tsconfig.json). One command, whole workspace. SOURCE: design/W1-STACK-SPEC.md §3
  ['types', 'pnpm exec tsc -b . apps/web apps/mobile'],
  ['lint', 'pnpm exec eslint . --max-warnings 0 --cache'],
  ['provenance', 'node tools/check-sources.mjs'],
  ['expo-policy', 'node tools/check-expo-policy.mjs'],
  ['native-deps', 'node tools/check-native-deps.mjs'],
  ['version-sync', 'node tools/check-version-sync.mjs'],
  ['prompts', 'node tools/check-prompts-lock.mjs'],
  ['licenses', 'node tools/check-licenses.mjs'],
  ['schema-rls', 'node tools/check-rls-manifest.mjs'],
  ['types-drift', 'node tools/check-types-drift.mjs'],
  ['migrations', 'node tools/check-migrations.mjs'],
  ['contracts', 'node tools/check-contract-drift.mjs'],
  ['dead-code', 'pnpm exec knip --strict'],
  ['architecture', 'pnpm exec depcruise apps packages --config .dependency-cruiser.cjs'],
  ['build', 'node tools/build-check.mjs'],
  ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
  ['perf-budget', 'node tools/check-perf-budget.mjs'],
  ['route-manifest', 'node tools/check-route-manifest.mjs'],
  ['e2e', 'node tools/check-e2e.mjs'],
  ['docs-sync', 'node tools/check-docs-sync.mjs'],
]

// What the Stop hook runs before a turn may end. These invoke the gate DIRECTLY —
// `node tools/validate.mjs`, `node tests/rls/run-rls.mjs`, `pnpm exec vitest` — never
// through a package.json script name. Script indirection (`pnpm validate`) would let an
// agent redefine "validate" to `true` in package.json (an auto-accepted, unguarded edit)
// and pass a hollow gate; direct invocation keeps the Stop gate tamper-evident, since this
// config and those runners are all write-guard-protected.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]
export const STOP_HOOK_STEPS = [
  // --report-all: the Stop block must show EVERY red at once — serial
  // one-red-per-turn discovery would exhaust the agent's block budget.
  ['validate', 'node tools/validate.mjs --report-all'],
  ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  // --coverage enforces the thresholds in vitest.config.ts (write-guard-protected)
  // so a turn cannot end with a coverage-cratering change.
  ['unit', 'pnpm exec vitest run --coverage --silent'],
  // The RN component/screen half of the unit floor: react-native code cannot run
  // under vitest without a fragile transform pipeline, so apps/mobile tests run
  // under jest-expo. Both runners emit istanbul coverage-final.json and
  // diff-coverage merges the two maps.
  ['mobile-unit', 'pnpm --filter mobile exec jest --coverage --silent'],
  // Per-file floors on every CHANGED source file (uncommitted + untracked work
  // included), read from the merged coverage maps the unit steps just wrote — a
  // new module cannot land 0%-covered inside a green aggregate.
  ['diff-coverage', 'node tools/check-diff-coverage.mjs'],
  // Copy-paste rot: a token clone detector over apps/*/src + packages/*/src. A
  // Stop-chain step, NOT a floor member (the floor stays frozen) — fast and
  // deterministic.
  ['duplication', 'node tools/check-duplication.mjs'],
  // The locale seam: no hardcoded user-facing string, and locale-sensitive formatting
  // (Intl, toLocale*, toFixed) only inside apps/mobile/src/i18n/. The behavioural half
  // (a pseudo-locale + RTL sweep over every route) runs in the e2e fast lane (RNTL)
  // and on-device in the Maestro CI lane.
  ['i18n', 'node tools/check-i18n.mjs'],
  // Assertion PRESENCE — the cheap, fast half of the assertion-quality control. Coverage
  // counts lines a test EXECUTED; nothing else in this chain notices that the test body has
  // no `expect`, or that a committed `.only` has silently disabled every other test in the
  // suite. ~50ms, so it belongs here. What it CANNOT do is prove a test would notice the
  // code breaking — that is the mutation lane (tools/check-mutation-ratchet.mjs), which runs
  // in CI because it takes minutes and this chain has a ~6s budget.
  ['test-quality', 'node tools/check-test-quality.mjs'],
  // CLOSURE half of the mobile perf floor: every route in src/routes.ts must have a
  // Maestro flow file AND a committed row in tools/startup-budget.json (and stale
  // rows red). Static (~10ms — it reads three files), so it belongs here: an agent
  // cannot end a turn having added a screen that no machine check will ever time.
  // The MEASUREMENT half needs an emulator (minutes) and runs in the CI perf lane.
  ['mobile-perf', 'node tools/check-mobile-perf.mjs --closure'],
]
