import { defineConfig } from 'drizzle-kit'

// SOURCE: harness doctrine — migrations always connect as the dedicated migrator
// role (schema owner); the runtime app_api role has zero DDL rights and stays
// permanently subject to FORCE RLS. Never point this at DATABASE_URL.
// [corpus: harness/doctrine]
// Fall back to an empty string when unset (rather than throwing at import) so
// static tooling — knip, editors — can load this config without the env; a real
// drizzle-kit command then fails loudly at connect time. env.example documents it.
const url = process.env['MIGRATOR_DATABASE_URL'] ?? ''

export default defineConfig({
  dbCredentials: { url },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/index.ts',
  strict: true,
  verbose: true,
})
