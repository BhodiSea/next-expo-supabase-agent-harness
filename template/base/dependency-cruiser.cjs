// .dependency-cruiser.cjs (stored dotless; the installer renames it) — the architecture
// law, run as `depcruise apps packages --config .dependency-cruiser.cjs`.
// Path regexes match RESOLVED paths, so `node_modules/<pkg>/` also matches pnpm's
// `.pnpm/<pkg>@<v>/node_modules/<pkg>/` store layout.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Dependency cycles make builds, tests, and reasoning order-dependent.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'mobile-not-into-server',
      comment:
        'The mobile app talks to the API over HTTPS only. Importing server code would smuggle ' +
        'server-only modules (and their secrets/config assumptions) into the shipped bundle.',
      severity: 'error',
      from: { path: '^apps/mobile' },
      to: { path: '^apps/server' },
    },
    {
      name: 'mobile-no-server-stack',
      comment:
        'DB driver, ORM, logger, and HTTP framework are server-side; if the mobile bundle ' +
        'can resolve them, the client/server boundary has already been breached.',
      severity: 'error',
      from: { path: '^apps/mobile' },
      to: { path: 'node_modules/(postgres|drizzle-orm|pino|@hono)/' },
    },
    {
      name: 'mobile-contracts-not-schema',
      comment:
        'apps/mobile imports the pure-Zod wire contracts (@app/contracts) only. @app/schema ' +
        'carries the drizzle table/policy definitions and is server-side: resolving it from ' +
        'the mobile tree drags the ORM into the shipped bundle.',
      severity: 'error',
      from: { path: '^apps/mobile' },
      to: { path: '^packages/schema' },
    },
    {
      name: 'drizzle-orm-schema-and-server-only',
      comment:
        'drizzle-orm is allowed in packages/schema (table defs) and apps/server (queries via ' +
        'the DAL). Anywhere else means database access is leaking out of the DAL boundary.',
      severity: 'error',
      from: { pathNot: '^(packages/schema|apps/server)' },
      to: { path: 'node_modules/drizzle-orm/' },
    },
    {
      name: 'drizzle-zod-schema-only',
      comment:
        'drizzle-zod exists in packages/schema solely for the contracts-drift test (the ' +
        'derived shape must equal the hand-authored @app/contracts DTO); nothing else may ' +
        'import the derivation.',
      severity: 'error',
      from: { pathNot: '^packages/schema' },
      to: { path: 'node_modules/drizzle-zod/' },
    },
    {
      name: 'postgres-driver-db-layer-only',
      comment:
        'The postgres driver is the DAL substrate: only apps/server/src/db/** may import it. ' +
        'Routes and DAL modules reach the database exclusively through withUserContext ' +
        '(src/db/context.ts), where the transaction binds the RLS identity — a stray driver ' +
        'import is an unauthorized path around FORCE RLS.',
      severity: 'error',
      from: { pathNot: '^apps/server/src/db/' },
      to: { path: 'node_modules/postgres/' },
    },
    {
      name: 'db-context-dal-only',
      comment:
        'withUserContext (apps/server/src/db/context*) is THE authorization boundary; only the ' +
        'DAL layer (src/dal/**, including its colocated tests) and db internals may import it. ' +
        'Routes depend on the DAL port — a route importing the context could run queries ' +
        'outside the DAL law (Zod-parse at exit, no raw rows).',
      severity: 'error',
      from: { path: '^apps/server', pathNot: '^apps/server/src/(dal|db)/' },
      to: { path: '^apps/server/src/db/context' },
    },
    {
      name: 'secure-store-host-seam-only',
      comment:
        'expo-secure-store is the credential seam: only src/host/** may touch it. The auth ' +
        'providers own the credential lifecycle but store through AccessTokenProvider — a ' +
        'module reading the keychain directly bypasses that discipline (single door, ' +
        'corrupt-safe, mockable).',
      severity: 'error',
      from: { path: '^apps/mobile', pathNot: '^apps/mobile/src/host/' },
      to: { path: 'node_modules/expo-secure-store/' },
    },
    {
      name: 'llm-sdks-eval-adapters-only',
      comment:
        'LLM SDKs may only be touched by packages/eval/src/adapters — every other module ' +
        'programs against the InferenceProvider/EmbeddingProvider ports (no live-model creep).',
      severity: 'error',
      from: { pathNot: '^packages/eval/src/adapters' },
      to: { path: 'node_modules/(openai|@anthropic-ai|ollama)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: ['\\.d\\.ts$', '(^|/)dist/', '^apps/mobile/(android|ios)/', '(^|/)\\.expo/'],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
