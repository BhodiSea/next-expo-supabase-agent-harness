import { defineConfig } from 'vitest/config'

// Root Vitest config — the ONLY vitest config (BUILD-SPEC §Vitest). Two projects:
//   unit-node: packages/** (contracts, api, design-tokens, platform/*, verticals/*)
//              + apps/web's non-DOM modules, plain node environment
//   rls:       tests/rls/** — the isolation suite. It self-skips politely unless
//              RLS_SUITE_READY=1, which only `node tests/rls/run-rls.mjs` sets after
//              fresh-applying migrations to a real Postgres (and which FAILS CLOSED
//              in CI). Plain `vitest run` therefore stays green without a database.
// apps/mobile component/screen tests are NOT a vitest project: react-native code
// does not run under vitest without a fragile transform pipeline, so they run
// under jest-expo (the mobile-unit step in tools/harness.config.mjs). The PURE
// mobile modules — import closure reaches zero react-native/expo native code —
// DO run here, listed file-by-file in the unit-node include below.
// Tests are colocated as *.test.ts or live under <workspace>/tests/unit/.

// Source files the UNIT-coverage bar cannot measure honestly — excluded from
// coverage AND from the diff-coverage gate (tools/check-diff-coverage.mjs parses
// THIS array, so the two surfaces cannot drift):
//   - the live-database surface (the Supabase client factories) is deliberately
//     unreachable by unit tests (they never open a connection — determinism
//     doctrine); the RLS isolation suite in the same Stop chain proves it
//     against a real database instead.
//   - generated files are transcriptions of a source of truth, not decisions:
//     the regen-diff gate proves them, coverage would only dilute the bar.
const COVERAGE_EXCLUDE = [
  '**/*.d.ts',
  'packages/platform/supabase/src/browser.ts',
  'packages/platform/supabase/src/cookie-server.ts',
  'packages/platform/supabase/src/native.ts',
  'packages/platform/supabase/src/service-role.ts',
  'packages/platform/supabase/src/access-token.ts',
  'packages/platform/supabase/src/database.types.ts',
  'packages/design-tokens/src/generated/**',
]

// Per-file coverage floors — deliberately BELOW the aggregate thresholds: their
// one job is making an untested file impossible (a 0% file hides comfortably
// inside a green 70% aggregate). Vitest cannot enforce an aggregate bar and a
// per-file bar in the same run (thresholds.perFile is a single global switch),
// so the '**/*' glob entry below pins these numbers where vitest tolerates them
// (an all-files group at lower numbers than the global bar can never
// independently fail), and tools/check-diff-coverage.mjs — the Stop-chain step
// right after `unit` — enforces them PER CHANGED FILE from
// coverage/coverage-final.json. Calibrated on the fresh scaffold (lowest shipped
// file per metric: statements 63 / branches 44 / functions 50 / lines 67);
// raising floors as real coverage grows is a reviewed human decision — this
// config is write-guard-protected.
const PER_FILE_FLOORS = {
  statements: 50,
  branches: 40,
  functions: 45,
  lines: 50,
}

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // The measured surface is the surface THIS runner tests: the server, the
      // packages, and the PURE mobile modules (LOCKSTEP with the unit-node
      // include list below — same runner split, same file set). The rest of
      // apps/mobile is jest-expo's coverage surface (its own collectCoverageFrom
      // + coverageThreshold); counting those files here as 0% would make this
      // aggregate a lie in both directions, and the diff-coverage gate already
      // merges both maps into the one per-file floor.
      // BOTH glob depths are required: the layered groups (platform/*,
      // verticals/*) sit one level deeper than the flat packages, and a
      // single-depth glob would silently measure half the workspace while
      // reporting a healthy aggregate.
      include: [
        'packages/*/src/**',
        'packages/*/*/src/**',
        'apps/mobile/src/i18n/**',
        'apps/mobile/src/routes.ts',
        'apps/mobile/src/lib/kv.ts',
        'apps/mobile/src/features/actions/fuzzyScore.ts',
        'apps/mobile/src/features/actions/recents.ts',
        'apps/mobile/src/features/matrix/matrixData.ts',
      ],
      exclude: COVERAGE_EXCLUDE,
      // The vitest defaults, pinned explicitly because a sibling gate depends on
      // one of them: `json` writes coverage/coverage-final.json, the artifact
      // tools/check-diff-coverage.mjs reads.
      reporter: ['text', 'html', 'clover', 'json'],
      // Aggregate floor, enforced wherever `--coverage` runs (the Stop hook's unit
      // step and CI): calibrated ~5-10 points under the fresh-scaffold measurement
      // so shipped code starts green while a feature landing without tests turns
      // the gate red. Raising floors as real coverage grows is a reviewed human
      // decision — this config is write-guard-protected.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 65,
        lines: 70,
        '**/*': PER_FILE_FLOORS,
      },
    },
    projects: [
      {
        test: {
          name: 'unit-node',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/tests/unit/**/*.test.ts',
            // The layered groups sit one level deeper — see the coverage note above.
            'packages/*/*/src/**/*.test.ts',
            'packages/*/*/tests/unit/**/*.test.ts',
            // apps/mobile PURE suites — an explicit FILE list, never a glob.
            // The runner split: a mobile module (and its test) belongs to vitest
            // ONLY when its import closure reaches zero react-native/expo native
            // code (this Node runner has no RN transform pipeline); everything
            // touching react-native runs under jest-expo. LOCKSTEP:
            // apps/mobile/jest.config.js testPathIgnorePatterns names exactly
            // these paths so no suite ever runs under both runners.
            'apps/mobile/src/i18n/i18n.test.ts',
            'apps/mobile/src/routes.test.ts',
            'apps/mobile/src/lib/kv.test.ts',
            'apps/mobile/src/features/actions/fuzzyScore.test.ts',
            'apps/mobile/src/features/actions/recents.test.ts',
            'apps/mobile/src/features/matrix/matrixData.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'rls',
          environment: 'node',
          include: ['tests/rls/**/*.test.ts'],
        },
      },
    ],
  },
})
