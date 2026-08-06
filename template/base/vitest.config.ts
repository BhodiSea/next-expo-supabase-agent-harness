import { defineConfig } from 'vitest/config'

// Root Vitest config (BUILD-SPEC §Vitest). Three projects:
//   unit-node: packages/** (contracts, api, design-tokens, platform/*, verticals/*)
//              + an explicit FILE LIST of pure apps/mobile modules, plain node env.
//   web-unit:  apps/web/__tests__/** — declared by REFERENCE to apps/web/vitest.config.ts
//              rather than inlined here, and that is not a style choice: the web project
//              needs an `esbuild.jsx` override (tsconfig sets `jsx: "preserve"` because
//              Next must receive untransformed JSX, so without it esbuild hands raw JSX
//              to node and every .tsx suite dies at import). `esbuild` sits at the TOP
//              level of a config object, outside `test`, so it cannot be expressed by an
//              inline project entry. Referencing the file keeps one config for `pnpm --filter web test`
//              and for `pnpm test`, which is what stops the two from drifting.
//              0.4.0 closes the enforcement tier this project's absence used to declare;
//              see docs/harness/enforcement-tiers.md for what is still tiered (apps/web's
//              app/ directory, whose compensating control is the web-e2e browser lane).
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
  // A GENERATOR INPUT, not application code (0.4.0). The query probes exist to be executed
  // by tools/gen-query-shapes.mjs through the harness-owned recording port — that run is
  // what writes tools/generated/query-shapes.json, and the `contracts` gate regen-diffs it
  // byte-for-byte. A unit test that called a probe would assert the probe calls the DAL,
  // which the recording already proves; the file is measured by the mechanism that owns it.
  // Named here (rather than left to fail the per-file floor) because 0.4.0 corrected
  // check-diff-coverage.mjs's SRC_RE to actually reach packages/verticals/*/src.
  'packages/verticals/*/src/data/query-probes.ts',
  // The two DESIGN-SYSTEM packages (0.4.0). Neither runner measures them and neither
  // should: `design-system-native` is NativeWind/RN components that only render under
  // jest-expo — whose `collectCoverageFrom` is rooted at apps/mobile and so never
  // attributes a package file — and `design-system` is web/Radix components whose honest
  // proof is a real browser. The mutation ratchet already excludes both for the matching
  // reason ("mutating React rendering yields survivors that are style, not behaviour").
  //
  // The compensating controls are real and run: the `styleguide` gate regen-diffs the token
  // source and computes WCAG contrast fail-closed, the jest-expo RNTL suites render the
  // native primitives through the screens (primitives-a11y, the states sweep), and the
  // web-e2e lane sweeps the web primitives with axe in a browser. Declared as a tier in
  // docs/harness/enforcement-tiers.md — 0.4.0 corrected SRC_RE to reach these paths, which
  // is what made an undeclared tier visible.
  'packages/design-system/src/**',
  'packages/design-system-native/src/**',
  // apps/web's request-bound surface (0.4.0). Same rule as the Supabase factories above:
  // these modules exist to touch something a unit test must not — Next's request-scoped
  // `cookies()`, the live database, the next-safe-action builder, the rate-limit backend.
  // A unit test that reached them would have to mock the request, and a mocked request
  // proves the mock. The browser lane (apps/web/e2e, playwright + axe) exercises them for
  // real; tools/check-diff-coverage.mjs parses THIS array, so the gate and the runner
  // cannot disagree about what is measured.
  'apps/web/lib/supabase/client.ts',
  'apps/web/lib/supabase/server.ts',
  'apps/web/lib/auth/session.ts',
  'apps/web/lib/safe-action.ts',
  'apps/web/lib/rate-limit-runtime.ts',
  'apps/web/lib/app-data/notes.ts',
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
        // apps/web's POLICY-AND-FOLD layer (0.4.0), measured by the web-unit project.
        // `lib/**` only, never `app/**`: the App Router directory is Server Components,
        // Server Actions and route handlers, whose honest proof is the browser lane —
        // including it here would report eighteen files at 0% and the only edit that
        // restored a green aggregate would be lowering the floors, which is the harness
        // reward-hacking its own bar. That remains a DECLARED tier.
        'apps/web/lib/**',
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
          // @app/env parses the whole environment EAGERLY at import (fail-fast
          // doctrine), so any module that reaches it — e.g. the service-role
          // factory — throws at load without these. They are hygiene-safe
          // placeholders (loopback DB with the dev password; non-key-shaped
          // secrets), NOT real credentials, and exist only so those modules
          // LOAD; the tests that assert env-parsing behaviour set their own
          // values per-test via setHostEnv and restore afterwards.
          env: {
            SUPABASE_DB_URL: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
            SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_unit_test_placeholder_do_not_use',
            NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE: 'sb_publishable_unit_test_placeholder',
            NEXT_PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
          },
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
      // The web half of the unit floor. A PATH, not an inline object — see the header:
      // apps/web/vitest.config.ts carries a root-level `esbuild.jsx` override that an
      // inline `test:` entry has no way to express, and referencing the file is what keeps
      // `pnpm test` and `pnpm --filter web test` running the same project.
      './apps/web/vitest.config.ts',
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
