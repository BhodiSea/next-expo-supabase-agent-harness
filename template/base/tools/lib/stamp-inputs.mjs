// Declared stamp inputs per stamped gate (see stampGate in lib/gate.mjs) — this is
// REVIEWED DATA: an input class missing from a gate's list means edits to it could
// ride a stale green stamp locally (CI always re-runs, so nothing ships wrong, but
// the Stop hook would under-check). The selftest mutates a representative of each
// class and asserts invalidation; extend BOTH together.
// SOURCE: docs/harness/README.md (stamped gates) [corpus: harness/doctrine]

// Every entry also carries, via withMachinery below:
//   - '.harness/manifest.json' — baseVersion/harnessVersion feed every rampNote
//     verdict, so an `update` or a deliberate graduation changes what a gate would
//     CONCLUDE about unchanged inputs; the manifest is therefore an input to every
//     stamp, and a warm green must never outlive it.
//   - the gate's own script, plus the stamp machinery itself (lib/gate.mjs and this
//     register) — a rewritten check must re-prove the tree, never skip on the stamp
//     its previous version recorded.
const MACHINERY = ['.harness/manifest.json', 'tools/lib/gate.mjs', 'tools/lib/stamp-inputs.mjs']
const withMachinery = (script, inputs) => [...inputs, script, ...MACHINERY]

export const STAMP_INPUTS = {
  // expo export + bundle purity + byte budgets + the gzip ratchet baseline
  // (tools/perf-baseline.json is declared even where absent: the missing-path
  // token means the baseline APPEARING — e.g. `pnpm perf:baseline` — also
  // invalidates a warm stamp, so the ratchet arms on the very next validate).
  // app.config.ts and the bundler configs are inputs because each can change
  // what the export emits without touching a source file.
  build: withMachinery('tools/build-check.mjs', [
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
  ]),
  // contract inventory regen-diff (action + event inventories) + tsconfig project-
  // references sync + the G18 bounded-wire-string sweep (its reviewed allow list is an
  // input: narrowing an entry must re-arm the gate on the very next validate, never ride
  // a warm stamp). `apps`/`packages` cover the tsconfig topology + the router/catalog/DTO
  // sources; the generators + their shared serializer + the committed inventories are named
  // so a generator edit or a hand-edit to an inventory also re-arms the stamp.
  contracts: withMachinery('tools/check-contract-drift.mjs', [
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
  ]),
  // per-role ceilings + per-org quota machinery. The source roots are stamp inputs
  // too, not only the SQL surface: the gate's session-hygiene sweep walks them, so a
  // stamp blind to them would serve a warm green after exactly the edit that adds a
  // session-scoped lock to a file the previous run judged clean.
  'db-limits': withMachinery('tools/check-db-limits.mjs', [
    'supabase/migrations',
    'tools/db-limits.json',
    'supabase/config.toml',
    'apps',
    'packages',
    'supabase/functions',
    'tools',
    'tests',
  ]),
  // the whole jest-expo/RNTL fast lane (screens + states + a11y sweeps).
  // Deliberate exclusions: the tRPC/API server graph is mocked at the seam (the
  // suites stub the client via src/testing/mock-server.ts, never a live API); the
  // web app + server-only packages are unreachable from the mobile graph by
  // depcruise + bundle purity, so they cannot change a mobile e2e verdict. The
  // Maestro device lane is CI-only and never stamped. CI always re-runs (inCI),
  // so nothing under-tested ever ships. packages/contracts is IN the list: its
  // zod DTOs are the wire shape the mobile suites parse, so a contract change
  // must invalidate a warm e2e stamp.
  e2e: withMachinery('tools/check-e2e.mjs', [
    'apps/mobile/src',
    'apps/mobile/app',
    'apps/mobile/__tests__',
    'apps/mobile/jest.config.js',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
    'packages/contracts/src',
    'packages/contracts/package.json',
    'pnpm-lock.yaml',
  ]),
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
  'expo-policy': withMachinery('tools/check-expo-policy.mjs', [
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
  ]),
  // `expo install --check` version alignment + the config-plugin allowlist +
  // the local config-plugins dir (declared even where absent: the missing-path
  // token means the dir APPEARING — a first local plugin — invalidates a warm
  // stamp, so the plugin tests-and-allowlist closure arms immediately).
  'native-deps': withMachinery('tools/check-native-deps.mjs', [
    'apps/mobile/package.json',
    'tools/expo-plugins.json',
    'plugins',
    'pnpm-lock.yaml',
  ]),
  // pnpm license metadata + the exception list
  // + the citeability surface (G25): LICENSE and CITATION.cff are gate inputs now, so a
  // drifted citation version can never ride a warm stamp.
  licenses: withMachinery('tools/check-licenses.mjs', [
    'pnpm-lock.yaml',
    'package.json',
    'tools/license-exceptions.json',
    'LICENSE',
    'CITATION.cff',
  ]),
  // every DAL read serves its declared shape from a real index: the generated
  // manifest, both reviewed configs it cross-reads, the applied history, and the
  // DAL sources themselves.
  'query-shapes': withMachinery('tools/check-query-shapes.mjs', [
    'tools/generated/query-shapes.json',
    'tools/tenancy.json',
    'tools/db-limits.json',
    'supabase/migrations',
    'packages/verticals',
  ]),
  // reviewed budgets closed over the GENERATED mutation inventory, the by-value
  // module diff, and both wiring reads (the tRPC host + the Server Actions dir).
  'rate-limits': withMachinery('tools/check-rate-limits.mjs', [
    'tools/rate-limit-budget.json',
    'apps/web/lib/rate-limit.ts',
    'tools/generated/action-inventory.json',
    'apps/web/app/api/trpc/[trpc]/route.ts',
    'apps/web/app/actions',
  ]),
  // by-value evaluation of the headers module against the reviewed policy — the
  // gate's whole verdict is a function of exactly these two files.
  'security-headers': withMachinery('tools/check-security-headers.mjs', [
    'apps/web/lib/security-headers.ts',
    'tools/security-headers.json',
  ]),
  // org-isolation predicate forms over the applied history. The stamp must cover
  // EVERY input the verdict depends on. The two capture lists are judgment data,
  // not decoration: editing pii-columns.json alone changes what this gate permits,
  // so a stamp blind to them would serve a stale green after exactly the edit most
  // worth re-checking.
  tenancy: withMachinery('tools/check-tenancy.mjs', [
    'supabase/migrations',
    'tools/tenancy.json',
    'supabase/config.toml',
    'tools/audit-columns.json',
    'tools/pii-columns.json',
  ]),
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
  // tools/cc-floor.json (0.6.0's Claude Code floor, judged by judgeCcFloor) and
  // tools/store-policy.json (0.7.0's iosToolchain record, the floor the production
  // ios.image is resolved against) join in 0.7.0 for the identical reason: each is a
  // reviewed floor whose edit is MEANT to re-judge a tree whose code did not change,
  // and both were read by this gate while missing from this list — so a warm local
  // stamp rode over exactly the edits the records exist to make visible.
  'version-sync': withMachinery('tools/check-version-sync.mjs', [
    'package.json',
    'tools/framework-floor.json',
    'tools/cc-floor.json',
    // 0.9.9's end-of-life register, here for the identical reason its two neighbours are:
    // accepting or removing a vendor-abandoned dependency is MEANT to re-judge a tree whose
    // code did not change, and a warm stamp would ride straight over the edit.
    'tools/eol.json',
    'apps/mobile/package.json',
    'apps/web/package.json',
    'packages/api/package.json',
    'apps/mobile/app.config.ts',
    'apps/mobile/eas.json',
    'tools/store-policy.json',
    '.nvmrc',
    '.node-version',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  ]),
}
