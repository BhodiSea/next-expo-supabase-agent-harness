// Declared stamp inputs per stamped gate (see stampGate in lib/gate.mjs) — this is
// REVIEWED DATA: an input class missing from a gate's list means edits to it could
// ride a stale green stamp locally (CI always re-runs, so nothing ships wrong, but
// the Stop hook would under-check). The selftest mutates a representative of each
// class and asserts the stamp invalidates; extend BOTH together.
// SOURCE: docs/harness/README.md (stamped gates) [corpus: harness/doctrine]
export const STAMP_INPUTS = {
  // expo export + bundle purity + byte budgets + the gzip ratchet baseline
  // (tools/perf-baseline.json is declared even where absent: the missing-path
  // token means the baseline APPEARING — e.g. `pnpm perf:baseline` — also
  // invalidates a warm stamp, so the ratchet arms on the very next validate).
  // app.config.ts and the bundler configs are inputs because each can change
  // what the export emits without touching a source file.
  build: [
    'apps/mobile/src',
    'apps/mobile/app',
    // assets ship into the export verbatim (content-addressed under dist/assets),
    // so an added/edited icon or font changes the verdict and must invalidate.
    'apps/mobile/assets',
    'apps/mobile/app.config.ts',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
    'apps/mobile/metro.config.js',
    'apps/mobile/babel.config.js',
    'tools/bundle-budget.json',
    'tools/perf-baseline.json',
    'pnpm-lock.yaml',
  ],
  // openapi regen-diff + tsconfig project-references sync + the G18 bounded-
  // wire-string sweep (its reviewed allow list is an input: narrowing an entry
  // must re-arm the gate on the very next validate, never ride a warm stamp).
  contracts: [
    'apps/server/src',
    'apps/server/scripts',
    'apps/server/openapi.json',
    'apps/server/package.json',
    'apps/server/tsconfig.json',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
    'packages',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'knip.json',
    'tools/dto-bounds-allow.json',
  ],
  // the whole jest-expo/RNTL fast lane (screens + states + a11y sweeps).
  // Deliberate exclusions: apps/server is mocked at the network seam (the suites
  // stub fetch/SSE, never a live API); packages/importer + packages/eval are
  // unreachable from the mobile graph by depcruise + bundle purity, so they
  // cannot change a mobile e2e verdict. The Maestro device lane is CI-only and
  // never stamped. CI always re-runs (inCI), so nothing under-tested ever ships.
  e2e: [
    'apps/mobile/src',
    'apps/mobile/app',
    'apps/mobile/__tests__',
    'apps/mobile/jest.config.js',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
    'packages/schema/src',
    'packages/schema/package.json',
    'pnpm-lock.yaml',
  ],
  // identity lock + ATS/cleartext + permissions/plugins allowlists + CNG purity +
  // secret-shaped `extra` ban + eas.json sanity. tokens.gen.ts and the styleguide
  // manifest are inputs because the gate asserts the splash background color
  // equals the GENERATED dark canvas token — a retuned palette must invalidate
  // a warm stamp or the splash check would ride a stale green.
  // The 0.1.2 store-readiness inputs join the list: the reviewed policy, the
  // icon assets (integrity checks parse their bytes), the actions registry +
  // openapi contract (the account-deletion closure reads both).
  'expo-policy': [
    'apps/mobile/app.config.ts',
    'apps/mobile/package.json',
    'tools/identity.lock.json',
    'tools/expo-permissions.json',
    'tools/expo-plugins.json',
    'apps/mobile/eas.json',
    'apps/mobile/src/theme/tokens.gen.ts',
    'tools/styleguide.manifest.json',
    'tools/store-policy.json',
    'apps/mobile/assets',
    'apps/mobile/src/features/actions/registry.ts',
    'apps/server/openapi.json',
    'pnpm-lock.yaml',
  ],
  // `expo install --check` version alignment + the config-plugin allowlist +
  // the local config-plugins dir (declared even where absent: the missing-path
  // token means the dir APPEARING — a first local plugin — invalidates a warm
  // stamp, so the plugin tests-and-allowlist closure arms immediately).
  'native-deps': [
    'apps/mobile/package.json',
    'tools/expo-plugins.json',
    'plugins',
    'pnpm-lock.yaml',
  ],
  // pnpm license metadata + the exception list
  // + the citeability surface (G25): LICENSE and CITATION.cff are gate inputs now, so a
  // drifted citation version can never ride a warm stamp.
  licenses: [
    'pnpm-lock.yaml',
    'package.json',
    'tools/license-exceptions.json',
    'LICENSE',
    'CITATION.cff',
  ],
  // one-version-everywhere + node-major agreement + rc-pin + single-zod-instance.
  // Every version the gate reads (root/server/mobile package.json, app.config.ts —
  // it derives version/buildNumber/versionCode — and eas.json's appVersionSource
  // pin), both node-version files, and the catalog. The zod single-instance check
  // reads the INSTALLED graph, but that graph is fully determined by
  // pnpm-lock.yaml — hashing the lockfile (not node_modules) captures every
  // resolution that could flip the verdict, and lets a warm run skip WITHOUT
  // spawning `pnpm list -r`. CI always re-runs.
  'version-sync': [
    'package.json',
    'apps/mobile/package.json',
    'apps/server/package.json',
    'apps/mobile/app.config.ts',
    'apps/mobile/eas.json',
    '.nvmrc',
    '.node-version',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  ],
}
