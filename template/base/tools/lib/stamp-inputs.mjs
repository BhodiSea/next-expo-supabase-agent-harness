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
  // contract inventory regen-diff (action + event inventories) + tsconfig project-
  // references sync + the G18 bounded-wire-string sweep (its reviewed allow list is an
  // input: narrowing an entry must re-arm the gate on the very next validate, never ride
  // a warm stamp). `apps`/`packages` cover the tsconfig topology + the router/catalog/DTO
  // sources; the generators + their shared serializer + the committed inventories are named
  // so a generator edit or a hand-edit to an inventory also re-arms the stamp.
  contracts: [
    'apps',
    'packages',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'knip.json',
    'tools/dto-bounds-allow.json',
    'tools/gen-action-inventory.mjs',
    'tools/gen-event-catalog.mjs',
    'tools/gen-query-shapes.mjs',
    'tools/lib/inventory.mjs',
    'tools/lib/query-recorder.mjs',
    'tools/generated/action-inventory.json',
    'tools/generated/event-catalog.json',
    'tools/generated/query-shapes.json',
  ],
  // the whole jest-expo/RNTL fast lane (screens + states + a11y sweeps).
  // Deliberate exclusions: the tRPC/API server graph is mocked at the seam (the
  // suites stub the client via src/testing/mock-server.ts, never a live API); the
  // web app + server-only packages are unreachable from the mobile graph by
  // depcruise + bundle purity, so they cannot change a mobile e2e verdict. The
  // Maestro device lane is CI-only and never stamped. CI always re-runs (inCI),
  // so nothing under-tested ever ships. packages/contracts is IN the list: its
  // zod DTOs are the wire shape the mobile suites parse, so a contract change
  // must invalidate a warm e2e stamp.
  e2e: [
    'apps/mobile/src',
    'apps/mobile/app',
    'apps/mobile/__tests__',
    'apps/mobile/jest.config.js',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
    'packages/contracts/src',
    'packages/contracts/package.json',
    'pnpm-lock.yaml',
  ],
  // identity lock + ATS/cleartext + permissions/plugins allowlists + CNG purity +
  // secret-shaped `extra` ban + eas.json sanity. @app/design-tokens' committed native
  // adapter is an input because the gate asserts the splash background color equals its
  // GENERATED dark canvas token — a retuned palette must invalidate a warm stamp or the
  // splash check would ride a stale green.
  // The store-readiness inputs join the list: the reviewed policy, the icon
  // assets (integrity checks parse their bytes), and the account-deletion
  // closure's two reads — the actions registry (the surface) and the backing
  // delete-account Edge Function + config.toml declaration (the endpoint). A
  // change to any of them must invalidate a warm expo-policy stamp.
  'expo-policy': [
    'apps/mobile/app.config.ts',
    'apps/mobile/package.json',
    'tools/identity.lock.json',
    'tools/expo-permissions.json',
    'tools/expo-plugins.json',
    'apps/mobile/eas.json',
    'packages/design-tokens/src/generated/native.ts',
    'tools/store-policy.json',
    'apps/mobile/assets',
    'apps/mobile/src/features/actions/registry.ts',
    'supabase/functions/delete-account/index.ts',
    'supabase/config.toml',
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
  // root+mobile lockstep + web/api major agreement + node-major agreement + rc-pin +
  // single-zod-instance + single-react-per-surface. Every version the gate reads
  // (root/mobile package.json for the lockstep; apps/web + packages/api package.json for
  // the web-major==api-major check; app.config.ts — it derives version/buildNumber/
  // versionCode — and eas.json's appVersionSource pin), both node-version files, and the
  // catalog. The zod AND react single-instance walks read the INSTALLED graph, but that
  // graph is fully determined by pnpm-lock.yaml — hashing the lockfile (not node_modules)
  // captures every resolution that could flip either verdict, and lets a warm run skip
  // WITHOUT spawning `pnpm list -r`. CI always re-runs.
  // tools/framework-floor.json joins the list in 0.5.0 and is the input a missing entry
  // would hurt most: it is the only one whose EDIT (a raised minPatch after a new
  // advisory) is meant to red a tree whose code did not change at all. Without it here,
  // `update` shipping a new floor would ride the warm stamp and the very advisory the
  // release exists to close would not be judged until the next unrelated version edit.
  'version-sync': [
    'package.json',
    'tools/framework-floor.json',
    'apps/mobile/package.json',
    'apps/web/package.json',
    'packages/api/package.json',
    'apps/mobile/app.config.ts',
    'apps/mobile/eas.json',
    '.nvmrc',
    '.node-version',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  ],
}
