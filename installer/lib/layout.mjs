// Shared layout constants for the installer.
// Template storage conventions: files that install to dot-paths are stored
// dotless (npm-packlist strips .gitignore/.npmrc and treats nested .gitignore
// as pack-ignore manifests; storing .github dotless also prevents template
// workflows from executing in this repo's own Actions). `.claude/` is the one
// dotted exception: verified to survive npm pack, and hooks reference it.
export const RENAMES = new Map([
  ['gitignore', '.gitignore'],
  ['github', '.github'],
  ['gitattributes', '.gitattributes'],
  ['editorconfig', '.editorconfig'],
  ['nvmrc', '.nvmrc'],
  ['node-version', '.node-version'],
  ['gitleaks.toml', '.gitleaks.toml'],
  ['dependency-cruiser.cjs', '.dependency-cruiser.cjs'],
  ['mcp.json', '.mcp.json'],
  ['env.example', '.env.example'],
])

// Opt-in modules under template/modules/<name>/ (same storage conventions).
export const MODULES = [
  'ci-mobile-release',
  'device-e2e',
  'eas-update',
  'store-metadata',
  'ci-provenance',
  'gate-a11y-deep',
  'crash-reporting',
  'push-notifications',
  'ops-backup',
  'eval-live',
  'observability',
]

// Modules folded into the default harness by a release (template/migrations.json
// promotedModules). `enable` refuses these with the promotion story instead of a
// bare "unknown module". Empty at 0.1.0 — this lineage starts fresh.
export const RETIRED_MODULES = new Map([])

export const TIERS = {
  core: [],
  standard: ['ci-provenance', 'ci-mobile-release'],
  strict: [...MODULES],
}

// Installed paths written once and never overwritten by `update` (the project
// owns them after init). Matched by prefix or exact path.
export const SEEDED_PREFIXES = [
  'apps/',
  'packages/',
  // The database is the authorization boundary, and its migrations are
  // append-only history: once a consumer has applied one, an `update` that
  // rewrote it would be rewriting deployed schema. Seeded — written at init,
  // never touched again. (The GATES over this tree live in tools/ and stay
  // `owned`, so the harness can still ship migration-safety fixes.)
  'supabase/',
  'tests/unit/',
]
export const SEEDED_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'CITATION.cff',
  'LICENSE',
  'SECURITY.md',
  '.env.example',
  '.gitignore',
  'package.json',
  'pnpm-workspace.yaml',
  'tools/rls-exempt.json',
  'tools/provenance-overrides.json', // reviewed cross-group cites — consumer-owned like rls-exempt
  'tools/license-exceptions.json',
  'tools/identity.lock.json',
  'tools/prompts.lock.json',
  // Human-tuned budget/design data: write-guard-protected against agents, but a
  // project raises them deliberately — update must plant-when-absent, never clobber.
  'tools/styleguide.manifest.json',
  'tools/perf-budget.json',
  // Wall-clock budgets for the CI-only interaction-latency lane — human-tuned
  // like perf-budget.json, and seedOnInitOnly: update withholds it so the lane
  // arms only when a consumer adopts the budget deliberately.
  'tools/interaction-budget.json',
  // Startup budgets for the device perf lane (cold-start / fully-drawn / per-
  // screen nav). seedOnInitOnly: its screens[] name THIS project's routes, so
  // planting the template's rows into a repo with its own routes would be
  // planting a wrong file — `update` withholds it and the floor self-disables
  // with an adoption NOTE.
  'tools/startup-budget.json',
  'tools/bundle-budget.json',
  // The gzip-ratchet baseline: a project's committed measurement, regenerated
  // only by `pnpm perf:baseline` — plant-when-absent, never clobber (and it is
  // seedOnInitOnly: `update` withholds it from existing installs so the
  // template scaffold's bytes never ratchet someone else's bundle).
  'tools/perf-baseline.json',
  'tools/route-allowlist.json',
  'tools/dto-bounds-allow.json',
  'tools/duplication-allow.json',
  'tools/decision-groups.json',
  'tools/i18n-allow.json',
  // Reviewed platform-capability data: every entry carries a reason. The
  // expo-policy/native-deps gates read them; a project extends them
  // deliberately — write-guard-protected against agents.
  'tools/expo-permissions.json',
  'tools/expo-plugins.json',
  // The accepted-survivor list for the mutation lane, and the reviewed escapes for the
  // assertion gate. Both are project-owned JUDGEMENTS ("this mutant is genuinely
  // equivalent", "this test is deliberately pending") — write-guard-protected against
  // agents, hashed by gate-integrity, and seedOnInitOnly so `update` never plants one
  // project's judgements into another's repo.
  'tools/mutation-baseline.json',
  'tools/test-quality-allow.json',
  'tests/rls/db-context.ts',
  // The DAL query-shape registry the plan probe drives: it names THIS project's
  // DAL methods, so only the project can write it. seedOnInitOnly — `update` withholds it
  // and the probe self-disables with an adoption NOTE rather than ambushing an upgrade.
  'tests/rls/dal-shapes.ts',
])

// The gate config is seeded (projects tune it) but hash-tracked so `doctor`
// can surface drift. SOURCE: docs/harness/README.md (tamper evidence)
export const CONFIG_FILES = new Set(['tools/harness.config.mjs'])

// Stack files installed in retrofit mode only when absent (additive seeds).
// Workspace packages are additive-only: never merged into existing apps.
//
// Only the SHARED SEAM packages are additive. A retrofit target already has its
// own screens, its own vertical, and its own design system — planting ours would
// collide with real code. What it does NOT have is the seam this harness gates:
// the wire contracts, the error kernel, the event registry, and the single token
// source. Those are the packages the boundary/contract/token gates read, so
// seeding their manifests is what lets a retrofit reach a green chain at all.
// apps/* are never additive; @app/api is not either (it composes verticals the
// retrofit target does not have yet).
export const RETROFIT_ADDITIVE = new Set([
  'packages/contracts/package.json',
  'packages/platform/errors/package.json',
  'packages/platform/events/package.json',
  'packages/design-tokens/package.json',
])

// Existing root configs the installer must never clobber on retrofit: if the
// project already has one, ours lands alongside as <base>.harness.<ext>.
// pnpm-workspace.yaml is the exception — it is MERGED (glob union, catalog
// add-missing/never-downgrade) by merge-workspace-yaml.mjs, not suffixed.
export const CONFLICTABLE = [
  { installed: 'eslint.config.mjs', existing: /^eslint\.config\.(js|mjs|cjs|ts|mts)$/ },
  { installed: 'biome.jsonc', existing: /^biome\.jsonc?$/ },
  { installed: 'tsconfig.json', existing: /^tsconfig\.json$/ },
  { installed: 'knip.json', existing: /^knip\.(json|jsonc|ts)$/ },
  { installed: '.dependency-cruiser.cjs', existing: /^\.dependency-cruiser\.(js|cjs|mjs)$/ },
  { installed: 'lefthook.yml', existing: /^lefthook\.(yml|yaml)$/ },
  { installed: 'commitlint.config.mjs', existing: /^commitlint\.config\.(js|mjs|cjs|ts)$/ },
  { installed: 'vitest.config.ts', existing: /^vitest\.config\.(ts|mts|js|mjs)$/ },
  { installed: 'cspell.json', existing: /^\.?cspell\.(json|jsonc|yaml|yml)$/ },
  { installed: '.gitleaks.toml', existing: /^\.gitleaks\.toml$/ },
  { installed: '.mcp.json', existing: /^\.mcp\.json$/ },
]
