// Shared layout constants for the installer.
// Template storage conventions: files that install to dot-paths are stored
// dotless (npm-packlist strips .gitignore/.npmrc and treats nested .gitignore
// as pack-ignore manifests; storing .github dotless also prevents template
// workflows from executing in this repo's own Actions). `.claude/` is the one
// dotted exception: verified to survive npm pack, and hooks reference it.
// The template spellings an INSTALL-relative path may live under: itself, and —
// for the top-level dotless-storage entries below — the RENAMES source name
// ('.gitignore' ships as 'gitignore'). Factory tooling that resolves a record's
// install paths back to template sources (check-seeded-migrations, the upgrade
// sweep's adopt()) must try every candidate, or a dotless-stored path silently
// reads as "the template does not ship this".
/** @param {string} installRel @returns {string[]} */
export function templateCandidates(installRel) {
  const out = [installRel]
  // The `.tmpl` spelling, because storageToInstall STRIPS it: a manifest stored
  // as package.json.tmpl installs as package.json, and a caller resolving that
  // install path back to a template source found nothing. Both callers treat a
  // missing source as "the template does not ship this" — the sweep skips it in
  // SILENCE (check-seeded-migrations says so in its own failure text), so a
  // seededSourceFixes entry naming a rendered manifest would quietly stop being
  // applied while the runbook kept telling consumers to apply it. Found when the
  // 0.9.5 env source-fix needed the env package's exports map, which is exactly
  // such a file.
  out.push(`${installRel}.tmpl`)
  for (const [templateName, installName] of RENAMES) {
    if (installRel === installName) out.push(templateName, `${templateName}.tmpl`)
    else if (installRel.startsWith(`${installName}/`)) {
      const renamed = `${templateName}${installRel.slice(installName.length)}`
      out.push(renamed, `${renamed}.tmpl`)
    }
  }
  return out
}

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
  'ci-web-deploy',
  'device-e2e',
  'eas-update',
  'store-metadata',
  'ci-provenance',
  'gate-a11y-deep',
  'crash-reporting',
  'push-notifications',
  'eval-live',
  'observability',
  'e2ee',
]

// Modules folded into the default harness by a release (template/migrations.json
// promotedModules). `enable` refuses these with the promotion story instead of a
// bare "unknown module". Empty at 0.1.0 — this lineage starts fresh.
export const RETIRED_MODULES = new Map([])

// Design-token presets: template/presets/<tree>/ overlays the STACK plan at
// init (same-installPath replacement + preset-only additions — see copy.mjs
// walkStack). Deliberately NOT modules: seeded files already exist by the time
// `enable` could run, and `disable` deleting token files would strand the
// scaffold — a preset is an init-time choice carried in manifest.answers,
// switchable only by a deliberate `init --force --set DESIGN_TOKENS=<preset>`.
export const TOKEN_PRESETS = new Map([
  ['default', null], // no overlay — the stack tree as-is
  ['metal', 'presets/tokens-metal'],
])

export const TIERS = {
  core: [],
  standard: ['ci-provenance', 'ci-mobile-release', 'ci-web-deploy'],
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
  // The surface-parity ledger the `parity` gate reads: its rows name THIS project's actions
  // and screens, so `update` must plant-when-absent and never clobber a project's tuned rows.
  'PARITY.md',
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
  // 0.6.0, and it belongs here for the reason the block below spells out rather than by
  // analogy: check-web-routes.mjs's own failure text says "allowlist the chrome page … with a
  // reason in tools/web-route-allowlist.json", and check-gate-integrity's SURFACE is
  // /^tools\//. Left `owned` (the default for a new tools/ file, which is what it was until
  // this line), the harness would tell a consumer to edit a file, call the edit tampering on
  // the next validate, and revert it on the next `update`.
  'tools/web-route-allowlist.json',
  'tools/dto-bounds-allow.json',
  'tools/duplication-allow.json',
  // 0.9.5: the vertical-anatomy escape. Same seeded-because-the-gate-says-edit-it
  // logic as duplication-allow — the boundaries gate's own failure text points the
  // consumer at a reviewed entry here.
  'tools/vertical-anatomy-allow.json',
  'tools/decision-groups.json',
  'tools/i18n-allow.json',
  // The 0.2.0 reviewed-data files, ALL of them. SEEDED, not owned, because every
  // gate that reads one tells the consumer in its own failure text to edit it
  // ("register the constraint in tools/tenancy.json", "register it with a reason",
  // "raise the bucket") — and check-gate-integrity's SURFACE is /^tools\//, so an
  // `owned` file here is sha-pinned. Leaving the last six owned made the harness
  // issue two contradictory demands at once: the gate says "edit this file and
  // commit the widening so it lands under CODEOWNERS", gate-integrity says "your
  // hash moved, restore it from git", and `update` reverted the edit anyway. Every
  // one of these is in check-gate-integrity's ESCAPE_LISTS, whose own header states
  // the rule this list now actually implements — escape hatches are seeded so their
  // CONTENT is not hash-pinned, and the reviewed act is the commit.
  'tools/tenancy.json',
  'tools/security-definer-allow.json',
  'tools/audit-columns.json',
  'tools/pii-columns.json',
  'tools/db-limits.json',
  'tools/data-flow.json',
  'tools/reviewer-triggers.json',
  'tools/security-headers.json',
  'tools/rate-limit-budget.json',
  'tools/db-perf-baseline.json',
  // The query-shape manifest is GENERATED from the consumer's own DAL by the probes in
  // packages/verticals/*/src/data/query-probes.ts — which are themselves seedOnInitOnly.
  // Shipping it `owned` meant `update` planted a description of the TEMPLATE's DAL into a
  // repo whose DAL is different and whose probes were deliberately withheld: the
  // regen-diff then reds forever, because regenerating from no probes can never
  // reproduce it. Seeded + seedOnInitOnly is the honest pairing — the artifact arrives
  // with the code that produces it, or not at all. Its integrity is the `contracts`
  // regen-diff plus the write-guard, never a mode.
  'tools/generated/query-shapes.json',
  // Same defect, one artifact over, found by leg E at 0.7.0: the action inventory is
  // GENERATED from the consumer's own tRPC router by `pnpm gen`. Shipping it `owned`
  // meant `update` planted a description of the TEMPLATE's router into a repo whose
  // router is different — the moment 0.7.0 added system.exportMyData, every upgraded
  // install's inventory named a procedure its router does not mount, and `contracts`
  // redded on a tree the consumer never touched. Seeded (plant-when-absent, never
  // clobber): the regen-diff in `contracts` plus `pnpm gen` keep it honest, never a mode.
  'tools/generated/action-inventory.json',
  // Reviewed platform-capability data: every entry carries a reason. The
  // expo-policy/native-deps gates read them; a project extends them
  // deliberately — write-guard-protected against agents.
  'tools/expo-permissions.json',
  'tools/expo-plugins.json',
  // The MCP approved-tools registry (0.3.0). Seeded for exactly the reason stated in the
  // 0.2.0 block above: the guard's own deny message tells the consumer to add a row here,
  // and an `owned` file under tools/ is sha-pinned — so the harness would be demanding an
  // edit and then calling that edit tampering. NOT seedOnInitOnly: the guard fails closed
  // without it, so `update` must PLANT it into an existing install or the first mcp__ call
  // after the upgrade is denied with no registry to point at. Its integrity is the
  // write-guard rule plus gate-integrity's escape-list dirty check — the widening is the
  // commit, under CODEOWNERS.
  'tools/approved-tools.json',
  // The observability sink register (0.8.0). Seeded for the approved-tools reason: the
  // gate's own failure text asks the consumer to add a sinks[] row (their egress
  // decision), and an owned file under tools/ is sha-pinned — the harness would be
  // demanding an edit and then calling it tampering. NOT seedOnInitOnly: the gate fails
  // closed without it (after scanning on the built-in detector floor), so `update` must
  // PLANT it or the first post-upgrade validate asks for a file update withheld. Its
  // integrity is the observability-sinks write-guard rule plus gate-integrity's
  // escape-list dirty check — the widening is the commit, under CODEOWNERS.
  'tools/observability.json',
  // The accepted-survivor list for the mutation lane, and the reviewed escapes for the
  // assertion gate. Both are project-owned JUDGEMENTS ("this mutant is genuinely
  // equivalent", "this test is deliberately pending") — write-guard-protected against
  // agents, hashed by gate-integrity, and seedOnInitOnly so `update` never plants one
  // project's judgements into another's repo.
  'tools/mutation-baseline.json',
  'tools/test-quality-allow.json',
  // The isolation-target registry the schema-rls gate closes over AND the supabase-js
  // suite drives: it names THIS project's user-scoped tables + owner columns, so only
  // the project can write it. seedOnInitOnly — `update` withholds it from existing
  // installs so one project's targets never overwrite another's.
  'tests/rls/db-context.ts',
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
