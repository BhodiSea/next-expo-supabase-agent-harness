// jest.config.js — the react-native component/screen half of the unit floor
// (jest-expo preset). PURE mobile modules run under the ROOT vitest config
// instead; the runner split is documented there (vitest.config.ts unit-node).

// HERMETIC ENV: jest's own CLI defaults NODE_ENV to 'test' only when it is
// UNSET. An ambient NODE_ENV=development — exported job-wide by a CI job that
// hosts the dev API server, or by any shell running one — leaks through and
// flips the babel-preset-expo/expo-router stack into dev behavior, under which
// renderRouter mounts an EMPTY route tree: 7 suites / 34 tests red, every
// dump a bare <RNCSafeAreaProvider /> (proven live by selftest's Canary 19,
// reproduced with NODE_ENV=development alone and nothing else). Config load
// runs in the jest main process before workers spawn, so this one line makes
// every caller hermetic — the mobile-unit chain step, the e2e gate, and a bare
// `pnpm --filter mobile exec jest` alike.
process.env.NODE_ENV = 'test'

// DIFF-COVERAGE FLOORS — parsed fail-closed by tools/check-diff-coverage.mjs
// (the Stop chain's diff-coverage step): every CHANGED file this config measures
// must clear these per-file percentages, read from coverage/coverage-final.json.
// LOCKSTEP with the PER_FILE_FLOORS block in the root vitest.config.ts — one
// floor, two runners; the values mirror it by design. They double as the jest
// aggregate threshold below (the reference that keeps this const live), so the
// gate's parse and jest's own enforcement can never disagree. Raising floors as
// real coverage grows is a reviewed human decision — this config is
// write-guard-protected.
const PER_FILE_FLOORS = {
  statements: 50,
  branches: 40,
  functions: 45,
  lines: 50,
}

module.exports = {
  preset: 'jest-expo',
  // @app/supabase ships TS SOURCE with NodeNext `.js` relative specifiers
  // (`import ... from './mfa-flow.js'`). tsc, Metro and Vitest all map that
  // back to the .ts file; jest's resolver does not, and the screens now import
  // the package's `./client` barrel directly (the mfa-flow machine), so the
  // suite dies at `Cannot find module './access-token.js'` without this.
  // Scoped to RELATIVE specifiers: a bare package name never matches, and a
  // node_modules file that really is `./x.js` still resolves because `js` is
  // in moduleFileExtensions. Merged WITH the jest-expo preset's own map, not
  // replacing it — jest gives config entries precedence per key.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Jest's 5000ms default is calibrated for unit tests on developer hardware.
  // The heavy RNTL flow tests (matrix pagination, notes optimistic-create)
  // legitimately cross 5s on 2-core CI runners under coverage instrumentation
  // (observed: whole jest-expo suites take 12-16s there; both selftest canary
  // jobs reddened on exactly these two tests while passing locally). 30s keeps
  // genuinely-hung tests failing while giving slow-runner flows headroom;
  // RNTL waitFor's own 1s timeout still bounds each individual assertion.
  testTimeout: 30000,
  // RNTL's findBy/waitFor bound gets the same CI-runner headroom treatment —
  // see jest.setup.ts for the evidence.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // pnpm keeps the real packages under node_modules/.pnpm/<pkg>@<v>/node_modules/,
  // so the must-be-transformed lookahead needs `.pnpm` in the set — without it
  // every RN/Expo module is served untranspiled and the suite dies on ESM/JSX
  // syntax (design record: EXPO-FACTS, jest under pnpm). `standard-navigation`
  // (expo-router 57's navigation core) and the @formatjs polyfills ship
  // ESM-only — same treatment.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm|(?:jest-)?react-native|@react-native(?:-community)?|expo(?:nent)?|@expo(?:nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|standard-navigation|@formatjs/.*|@sentry/react-native|native-base|react-native-svg))',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    // tsc -b emits declaration files (including *.test.d.ts) here.
    '<rootDir>/dist/',
    // LOCKSTEP with the root vitest.config.ts unit-node include list: these
    // suites are pure (zero react-native in their import closure) and run
    // under vitest — ignored here so no test ever runs under both runners.
    '<rootDir>/src/i18n/i18n\\.test\\.ts$',
    '<rootDir>/src/routes\\.test\\.ts$',
    '<rootDir>/src/lib/kv\\.test\\.ts$',
    '<rootDir>/src/lib/sse\\.test\\.ts$',
    '<rootDir>/src/features/actions/fuzzyScore\\.test\\.ts$',
    '<rootDir>/src/features/actions/recents\\.test\\.ts$',
    '<rootDir>/src/features/matrix/matrixData\\.test\\.ts$',
  ],
  // `json` writes coverage/coverage-final.json — the istanbul artifact the
  // diff-coverage step merges with the vitest map (both runners feed one floor).
  coverageReporters: ['json', 'text-summary'],
  // The floors const doubles as jest's own aggregate enforcement, so the gate's
  // textual parse and the runner's threshold can never disagree.
  coverageThreshold: { global: PER_FILE_FLOORS },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'app/**/*.{ts,tsx}',
    '!**/*.test.{ts,tsx}',
    // The generated token module used to live under src/theme and was excluded
    // here (regen-diffed, so coverage over its lines only diluted the signal).
    // It now lives in @app/design-tokens, outside this app's coverage surface
    // entirely, so the exclusion is gone rather than stale — a path exclusion
    // matching nothing is a rule nobody can tell is dead.
  ],
}
