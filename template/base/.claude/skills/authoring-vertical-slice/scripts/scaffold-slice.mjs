#!/usr/bin/env node
// Scaffolds the empty file skeleton for a vertical slice across the monorepo.
// Usage: node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs <slice>
// Idempotent: writes a file only when it does not already exist. Node built-ins only.
//
// Deliberately does NOT create the migration file: supabase/migrations/* is APPLIED,
// timestamped, append-only history (supabase db push records a migration by filename, so a
// retroactive edit yields a database that no longer matches its own history). A scaffolded
// stub could never be filled in without hand-editing applied history, so the migration-rls-
// author composes the complete migration with `supabase migration new <slice>` and writes it
// exactly once. The stub shapes below are modelled on the real packages/verticals/notes/*.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

const [, , slice = 'slice'] = process.argv

if (!/^[a-z][a-z0-9-]*$/.test(slice)) {
  process.stderr.write(
    `invalid slice name: ${JSON.stringify(slice)} (expected /^[a-z][a-z0-9-]*$/)\n`,
  )
  process.exit(1)
}

const base = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd()
const pascal = slice
  .split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('')
const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1)

const vertical = join(base, 'packages', 'verticals', slice, 'src')

const files = [
  [
    join(vertical, 'schemas.ts'),
    '// Input schemas for this slice — what a procedure or a Server Action validates before\n' +
      '// anything touches the database. DERIVE them from @app/contracts (the wire bounds live\n' +
      '// in exactly one place); add only refinements that need domain knowledge. See the real\n' +
      '// packages/verticals/notes/src/schemas.ts (CreateNoteSchema = NewNoteInput.refine(...)).\n',
  ],
  [
    join(vertical, 'events.ts'),
    "// The facts this vertical publishes, declared through @app/events' defineEventCatalog so\n" +
      '// the event-catalog generator can walk them. Payloads carry IDENTIFIERS, never content;\n' +
      '// constructors are PURE (occurredAt is a parameter — the row\'s own timestamp — never\n' +
      '// Date.now()). See packages/verticals/notes/src/events.ts.\n',
  ],
  [
    join(vertical, 'client.ts'),
    `// @app/${slice}/client — the METRO-SAFE barrel. Everything reachable from here must be\n` +
      '// bundleable into a native binary: pure domain functions, zod schemas, and the DIRECT\n' +
      '// RLS READS a phone performs against its own scoped Supabase client. Nothing here may\n' +
      '// reach a service-role client, a Next-coupled leaf, or a Node built-in (Metro does not\n' +
      '// tree-shake). Re-export the reads, the input schemas, the event vocabulary and the pure\n' +
      '// domain. Writes stay OFF this barrel. See packages/verticals/notes/src/client.ts.\n',
  ],
  [
    join(vertical, 'index.ts'),
    `// @app/${slice} — the vertical. src/domain (pure), src/data (the DAL: takes a client,\n` +
      '// returns zod DTOs from @app/contracts wrapped in ActionOutcome, never rows, never throws\n' +
      '// for a domain failure), src/schemas, src/events, src/client (Metro-safe), src/index (this\n' +
      '// file). A vertical MUST NOT import another vertical. See packages/verticals/notes/src/index.ts.\n' +
      '\n' +
      "export * from './client.js'\n" +
      '\n' +
      '// The server-only surface below is NOT on ./client: each write sets an ownership column\n' +
      '// from a verified actor and emits an event, so it must run where the actor was verified.\n' +
      `// export { create${pascal}, delete${pascal}, type ${pascal}WriteContext, update${pascal} } from './data/${slice}.js'\n`,
  ],
  [
    join(base, 'packages', 'api', 'src', 'routers', `${slice}.ts`),
    '// The tRPC router for this slice — copy packages/api/src/routers/notes.ts. Each procedure\n' +
      '// is three lines: pick a rung of the ladder (authedProcedure for reads, memberProcedure\n' +
      '// for writes), name an input schema from @app/' +
      slice +
      ", hand the call to the vertical.\n" +
      '// Return the ActionOutcome envelope; NEVER throw a domain failure. Then wire this router\n' +
      "// into appRouter (packages/api/src/index.ts) and run `pnpm gen` to regenerate the committed\n" +
      '// inventories. See references/dal-dto.md.\n' +
      '//\n' +
      `// import { authedProcedure, memberProcedure, router } from '../trpc.js'\n` +
      `// export const ${camel}Router = router({ /* list, get, create, update, remove */ })\n`,
  ],
  [
    join(base, 'apps', 'web', 'app', 'actions', `${slice}.ts`),
    "'use server'\n" +
      '\n' +
      '// The web write path for this slice — the twin of the ' +
      camel +
      ' tRPC procedure apps/mobile calls.\n' +
      '// SAME @app/contracts schema, SAME @app/' +
      slice +
      ' implementation, SAME ActionOutcome envelope;\n' +
      "// only the transport differs. 'use server' makes every export a public POST endpoint, so\n" +
      '// validate with actionClient.inputSchema(...) first, resolve identity with getVerifiedUser()\n' +
      '// (getUser under the hood — never getSession), mint the client with createRequestScopedClient()\n' +
      '// narrowed `as unknown as <Slice>Database`, and revalidatePath on success only. Add this file\n' +
      '// ONLY when the web surface writes this entity. See apps/web/app/actions/notes.ts.\n',
  ],
  [
    join(base, 'apps', 'web', 'app', slice, 'page.tsx'),
    '// The web screen for this slice. Read via apps/web/lib/app-data/' +
      slice +
      '.ts (the RSC read\n' +
      '// seam: per-request client -> the vertical ./client fn -> match the outcome -> a render\n' +
      '// model), NEVER a Supabase query in this component and NEVER a fetch() to /api/trpc. Writes\n' +
      '// go through the Server Action. getVerifiedUser() for rendering decisions only — RLS is the\n' +
      '// boundary. See apps/web/app/page.tsx + apps/web/lib/app-data/notes.ts.\n' +
      '\n' +
      'export default async function ' +
      pascal +
      'Page() {\n' +
      '  return null\n' +
      '}\n',
  ],
  [
    join(base, 'apps', 'mobile', 'src', 'features', slice, 'index.tsx'),
    `// Mobile feature '${slice}'. Compose it from the src/components primitives; data via useApi()\n` +
      '// + callProcedure (Class-B, the default) or the vertical ./client (Class-A read); strings are\n' +
      '// catalog keys rendered with t(); styling through useThemedStyles + @app/design-tokens.\n' +
      '// REGISTER the screen in src/routes.ts (id, titleKey, path, file, state testIDs) and give it\n' +
      '// an app/ route file whose root renders <Screen testID="<route-id>-screen"> (the device lane\n' +
      '// asserts that container id for every ROUTES entry). See references/mobile-screen.md.\n' +
      `export function ${pascal}View() {\n  return null\n}\n`,
  ],
  [
    join(vertical, 'data', `${slice}.test.ts`),
    "import { describe, it } from 'vitest'\n\n" +
      `describe('${slice} DAL', () => {\n` +
      "  it.todo('maps rows to zod-parsed DTOs and handles the undefined branches')\n" +
      "  it.todo('branches on error before data (an RLS denial is not an empty list)')\n" +
      "  it.todo('injects the owner id from the verified actor, never from the wire')\n})\n",
  ],
  [
    join(base, 'apps', 'mobile', '__tests__', `${slice}-flow.test.tsx`),
    '// jest-expo (RNTL) suite for the mobile feature — drive the loading/empty/error states\n' +
      '// through the testIDs registered in src/routes.ts, stubbing the API at the\n' +
      '// src/testing/mock-server.ts seam (mockApiClient/installMockServer). See references/tests.md.\n' +
      `describe('${pascal}View', () => {\n` +
      "  it.todo('renders an accessible screen and its declared data states')\n})\n",
  ],
]

for (const [path, body] of files) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    console.log('exists, skipped:', path)
    continue
  }
  writeFileSync(path, body)
  console.log('scaffolded:', path)
}

console.log(
  `next: compose the migration ONCE — \`supabase migration new ${slice}\` + the declarative ` +
    `supabase/schemas/NN_${slice}.sql (ENABLE + FORCE RLS, four per-op policies on auth.uid(), ` +
    'leading-column owner index, REVOKE service_role, GRANT authenticated)',
)
console.log(
  'next: add an ISOLATION_TARGET to tests/rls/db-context.ts AND an rls_targets row to ' +
    'supabase/tests/rls_structure.test.sql for each user-scoped table',
)
console.log('next: wire the router into appRouter (packages/api/src/index.ts), then run: pnpm gen')
console.log(
  'next: register the screen in apps/mobile/src/routes.ts + add its app/ route file rendering ' +
    '<Screen testID="<route-id>-screen"> (the device lane asserts that id)',
)
console.log(`next: scaffold the Maestro flow (after registering): node tools/gen-maestro-flows.mjs --flow ${slice}`)
console.log('next: add the tools/startup-budget.json row (human-reviewed budget)')
console.log('next: prove the boundary — pnpm test:rls (pgTAP + the supabase-js client suite)')
