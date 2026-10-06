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
// exactly once. The stub shapes below are modelled on the worked example, which `init --with-demo`
// plants and the skill's references/*.md carry as regions generated from its source (2.0.0: a
// default scaffold ships no vertical, so a stub cites the references, never an example path).
//
// The shape is the example's, file for file (#155): the web screen is a segment under the org
// scope with its page.meta.ts and loading.tsx, every data seam the example has is a stub, and
// the one narrowing cast lives in apps/web/lib/app-data/<slice>-port.ts and nowhere else. A
// stub that cannot compile until the vertical resolves is comment-only, as the router stub is.
// What the script must not do itself (a catalog key, a regenerated registry, a spec, the
// vertical's package.json) is a printed `next:` line.
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
const table = slice.replaceAll('-', '_')

const vertical = join(base, 'packages', 'verticals', slice, 'src')
// The org-scoped segment: the route IS the tenant selector, under the signed-in layout and the
// org layout that resolves the slug against the caller's seats.
const segment = join(base, 'apps', 'web', 'app', '(protected)', 'o', '[orgSlug]', slice)
const appData = join(base, 'apps', 'web', 'lib', 'app-data')

const files = [
  [
    join(vertical, 'schemas.ts'),
    '// Input schemas for this slice — what a procedure or a Server Action validates before\n' +
      '// anything touches the database. DERIVE them from @app/contracts (the wire bounds live\n' +
      '// in exactly one place); add only refinements that need domain knowledge. See the\n' +
      '// skill\'s references/dal-dto.md (the worked example\'s CreateNoteSchema = NewNoteInput.refine(...)).\n',
  ],
  [
    join(vertical, 'events.ts'),
    "// The facts this vertical publishes, declared through @app/events' defineEventCatalog so\n" +
      '// the event-catalog generator can walk them. Payloads carry IDENTIFIERS, never content;\n' +
      '// constructors are PURE (occurredAt is a parameter — the row\'s own timestamp — never\n' +
      '// Date.now()). See the skill\'s references/dal-dto.md.\n',
  ],
  [
    join(vertical, 'client.ts'),
    `// @app/${slice}/client — the METRO-SAFE barrel. Everything reachable from here must be\n` +
      '// bundleable into a native binary: pure domain functions, zod schemas, and the DIRECT\n' +
      '// RLS READS a phone performs against its own scoped Supabase client. Nothing here may\n' +
      '// reach a service-role client, a Next-coupled leaf, or a Node built-in (Metro does not\n' +
      '// tree-shake). Re-export the reads, the input schemas, the event vocabulary and the pure\n' +
      '// domain. Writes stay OFF this barrel. See the skill\'s references/dal-dto.md.\n' +
      '// Export the event catalog under the name the generator looks for, then run `pnpm gen`:\n' +
      `// export { ${camel}Events as EVENT_CATALOG } from './events.js'\n`,
  ],
  [
    join(vertical, 'index.ts'),
    `// @app/${slice} — the vertical. src/domain (pure), src/data (the DAL: takes a client,\n` +
      '// returns zod DTOs from @app/contracts wrapped in ActionOutcome, never rows, never throws\n' +
      '// for a domain failure), src/schemas, src/events, src/client (Metro-safe), src/index (this\n' +
      '// file). A vertical MUST NOT import another vertical. See the skill\'s references/dal-dto.md.\n' +
      '\n' +
      "export * from './client.js'\n" +
      '\n' +
      '// The server-only surface below is NOT on ./client: each write sets an ownership column\n' +
      '// from a verified actor and emits an event, so it must run where the actor was verified.\n' +
      `// export { create${pascal}, delete${pascal}, type ${pascal}WriteContext, update${pascal} } from './data/${slice}.js'\n`,
  ],
  [
    join(vertical, 'data', 'port.ts'),
    '// The DAL\'s structural port: a hand-authored SUBSET of the PostgREST query builder this\n' +
      '// vertical calls, with `data: unknown`, never the generated Database type (a generated type\n' +
      '// makes rows look trustworthy at the entrance, the illusion the re-parse in rows.ts exists to\n' +
      '// prevent). Fakeable in three lines, so every branch is reachable from a unit test. Export it\n' +
      `// as ${pascal}Database; apps/web narrows its client to it in one place,\n` +
      `// apps/web/lib/app-data/${slice}-port.ts.\n` +
      "// See the skill's references/dal-dto.md (the three DAL laws, law 1).\n" +
      '//\n' +
      `// export interface ${pascal}Database {\n` +
      '//   from(table: string): /* the select / insert / update / delete chains the DAL calls */\n' +
      '// }\n',
  ],
  [
    join(vertical, 'data', 'rows.ts'),
    '// The row boundary: the ONE module that parses a row. snake_case columns in, the\n' +
      '// @app/contracts record out, against a schema whose fields are BORROWED from the contract\'s\n' +
      '// shape (never a restated bound). An explicit column projection, never select(\'*\'), and\n' +
      '// rows.test.ts asserts it covers exactly the row schema\'s keys. Name the table once, here.\n' +
      '// See the skill\'s references/dal-dto.md (the three DAL laws, law 2).\n' +
      '//\n' +
      `// export const ${table.toUpperCase()}_TABLE = '${table}'\n`,
  ],
  [
    join(vertical, 'data', 'errors.ts'),
    '// The ONE file in this vertical that builds an AppError. The DAL reads `error` before `data`\n' +
      '// (PostgREST resolves rather than rejects, so reading data first renders an RLS denial as an\n' +
      '// empty list) and maps the failure through this file, 42501 -> rlsDenied, into an outcome it\n' +
      '// RETURNS: a domain failure is never thrown.\n' +
      '// See the skill\'s references/dal-dto.md (the three DAL laws, law 3, and "error FIRST, always").\n',
  ],
  [
    join(vertical, 'data', 'query-probes.ts'),
    '// The query probes: the drivers tools/gen-query-shapes.mjs runs each DAL function through to\n' +
      '// record what it asks the database for, which the query-shapes gate judges. Export `DAL`, a\n' +
      `// namespace import of ./${slice}.js, and a non-empty QUERY_PROBES with one entry per branch of\n` +
      '// every function it exports, then run `pnpm gen`. Until then query-shapes reds this file: a\n' +
      '// probe module exists and the manifest is empty.\n' +
      "// See the skill's references/dal-dto.md (the query probes).\n",
  ],
  [
    join(vertical, 'data', `${slice}.ts`),
    `// The DAL: the ONE implementation the tRPC procedure, the Server Action and the web read seam\n` +
      `// all call. Every function TAKES the client (typed as ${pascal}Database from ./port.js),\n` +
      '// returns an ActionOutcome of a DTO, never a row and never a throw for a domain failure.\n' +
      `// Reads (list${pascal}, get${pascal}) take a scope { orgId } and go on ./client; writes take a\n` +
      `// ${pascal}WriteContext { actorId, emit, now, orgId } and stay on the server barrel. Every list is\n` +
      '// keyset-paginated with an unconditional LIMIT. No app-side owner filter: RLS decides who\n' +
      '// sees a row. See the skill\'s references/dal-dto.md (the three DAL laws; reads, writes, and\n' +
      '// the barrel split).\n',
  ],
  [
    join(base, 'packages', 'api', 'src', 'routers', `${slice}.ts`),
    '// The tRPC router for this slice — copy the create-procedure region of references/dal-dto.md. Each procedure\n' +
      '// is three lines: pick a rung of the ladder (orgProcedure, READS INCLUDED — the acting\n' +
      '// org is WHICH DATA a read is about, not an extra permission on top of it),\n' +
      '// for writes), name an input schema from @app/' +
      slice +
      ", hand the call to the vertical.\n" +
      '// Return the ActionOutcome envelope; NEVER throw a domain failure. Then wire this router\n' +
      "// into appRouter (packages/api/src/index.ts) and run `pnpm gen` to regenerate the committed\n" +
      '// inventories. See references/dal-dto.md.\n' +
      '//\n' +
      `// import { orgProcedure, router } from '../trpc.js'\n` +
      '// const gate = ctx.org; if (!gate.ok) return gate   // the failure path, returned verbatim\n' +
      `// export const ${camel}Router = router({ /* list, get, create, update, remove */ })\n`,
  ],
  [
    join(base, 'apps', 'web', 'app', 'actions', `${slice}.ts`),
    "'use server'\n" +
      '\n' +
      `// The web write path for this slice — the twin of the ${camel} tRPC procedure apps/mobile calls.\n` +
      `// SAME @app/contracts schema, SAME @app/${slice} implementation, SAME ActionOutcome envelope;\n` +
      "// only the transport differs. 'use server' makes every export a public POST endpoint, so\n" +
      '// validate first with actionClient.bindArgsSchemas<[orgSlug: typeof OrgSlug]>([OrgSlug])\n' +
      '// .inputSchema(...): the org is a BOUND argument, the slug of the segment the form renders\n' +
      '// under, never a payload field. Then requireOrgContext(orgSlug) resolves the client, the\n' +
      '// verified user (getUser under the hood, never getSession) and the org from the caller\'s\n' +
      '// real seats; return the gate verbatim when it fails. Narrow the client with\n' +
      `// to${pascal}Port(gate.data.client) from lib/app-data/${slice}-port.ts, take actorId from\n` +
      '// gate.data.userId and orgId from gate.data.org.id, and on success only\n' +
      `// revalidatePath(\`/o/\${gate.data.org.slug}/${slice}\`). Add this file ONLY when the web\n` +
      '// surface writes this entity. See the skill\'s references/dal-dto.md (the optional web\n' +
      '// Server Action).\n',
  ],
  [
    join(segment, 'page.meta.ts'),
    "import type { WebRouteMeta } from '../../../../../lib/routes'\n" +
      '\n' +
      `// One org's ${slice}. The registry (apps/web/lib/routes.generated.ts) and the browser tab read\n` +
      '// this one declaration, and the route-manifest gate checks that the segment renders each\n' +
      '// state test id below.\n' +
      'export const meta = {\n' +
      `  id: '${slice}',\n` +
      `  titleKey: 'route.${camel}',\n` +
      '  states: {\n' +
      `    loading: '${slice}-loading',\n` +
      `    empty: '${slice}-empty',\n` +
      `    error: '${slice}-error',\n` +
      '  },\n' +
      '} as const satisfies WebRouteMeta\n',
  ],
  [
    join(segment, 'page.tsx'),
    "import { EmptyState } from '@app/design-system'\n" +
      "import type { ReactNode } from 'react'\n" +
      "import { requireOrgContext } from '../../../../../lib/auth/session'\n" +
      "import { t } from '../../../../../lib/i18n'\n" +
      "import { errorCopy } from '../../../../../lib/i18n/errors'\n" +
      "import { meta } from './page.meta'\n" +
      '\n' +
      `// One org's ${slice}. The route segment IS the tenant selector. Read through\n` +
      `// apps/web/lib/app-data/${slice}.ts (the RSC read seam: requireOrgContext(orgSlug) -> the\n` +
      "// vertical ./client fn scoped to the RESOLVED org's id -> match the outcome -> a render\n" +
      '// model), NEVER a Supabase query in this component and NEVER a fetch() to /api/trpc. Writes\n' +
      "// go through the Server Action, bound to this segment's slug. Each state renders its test id\n" +
      '// from meta.states.*, the form route-manifest names as the one that cannot drift. See the\n' +
      "// skill's references/dal-dto.md (the web read seam).\n" +
      '//\n' +
      '// Until the read seam exists this page knows only whether the org gate admits the caller, so\n' +
      `// it renders the error state or the empty one. Replace the gate with \`const model = await\n` +
      `// load${pascal}Page(orgSlug)\` and render the model's states.\n` +
      '\n' +
      'export const metadata = { title: t(meta.titleKey) }\n' +
      '\n' +
      `export default async function ${pascal}Page({\n` +
      '  params,\n' +
      '}: {\n' +
      '  readonly params: Promise<{ readonly orgSlug: string }>\n' +
      '}): Promise<ReactNode> {\n' +
      '  const { orgSlug } = await params\n' +
      '  const gate = await requireOrgContext(orgSlug)\n' +
      '\n' +
      '  return (\n' +
      '    <section className="mt-6 flex flex-col gap-6">\n' +
      '      {gate.ok ? (\n' +
      '        <EmptyState title={t(meta.titleKey)} testID={meta.states.empty} />\n' +
      '      ) : (\n' +
      '        <p role="alert" className="text-sm text-danger" data-testid={meta.states.error}>\n' +
      '          {errorCopy(gate.error)}\n' +
      '        </p>\n' +
      '      )}\n' +
      '    </section>\n' +
      '  )\n' +
      '}\n',
  ],
  [
    join(segment, 'loading.tsx'),
    "import { Skeleton } from '@app/design-system'\n" +
      "import type { ReactNode } from 'react'\n" +
      "import { t } from '../../../../../lib/i18n'\n" +
      "import { meta } from './page.meta'\n" +
      '\n' +
      `// The ${slice} route's loading UI: the App Router wraps the segment in a Suspense boundary, so\n` +
      '// the org chrome streams at once and only this region waits. Skeletons shaped like what\n' +
      '// arrives, never prose; `<output aria-busy>` is the live region (each Skeleton is aria-hidden),\n' +
      '// and its test id is meta.states.loading, so the declared id and the rendered one cannot drift.\n' +
      `export default function ${pascal}Loading(): ReactNode {\n` +
      '  return (\n' +
      '    <output\n' +
      '      aria-busy="true"\n' +
      '      aria-label={t(meta.titleKey)}\n' +
      '      data-testid={meta.states.loading}\n' +
      '      className="mt-6 flex flex-col gap-3"\n' +
      '    >\n' +
      '      <Skeleton fullWidth height={64} rounded="lg" />\n' +
      '      <Skeleton fullWidth height={64} rounded="lg" />\n' +
      '      <Skeleton fullWidth height={64} rounded="lg" />\n' +
      '    </output>\n' +
      '  )\n' +
      '}\n',
  ],
  [
    join(appData, `${slice}.ts`),
    `// The RSC read seam for ${slice}, in one place and this order: requireOrgContext(orgSlug) ->\n` +
      `// to${pascal}Port(gate.data.client) -> the vertical ./client read, scoped to the RESOLVED org's\n` +
      "// id (never the slug) -> match the outcome -> a render model the page renders. A gate failure\n" +
      '// is a domain outcome and rides the model. No caching (every read is RLS-scoped to the caller),\n' +
      '// no fetch() to /api/trpc, and an infrastructure throw is left to the route\'s error.tsx. See\n' +
      "// the skill's references/dal-dto.md (the web read seam).\n" +
      '//\n' +
      `// export async function load${pascal}Page(orgSlug: string): Promise<${pascal}PageModel> { ... }\n`,
  ],
  [
    join(appData, `${slice}-port.ts`),
    `// The ONE place apps/web narrows a Supabase client to @app/${slice}'s structural port. The\n` +
      '// Server Action, the read seam and the tRPC route call it rather than repeating a cast.\n' +
      '//\n' +
      '// Why a double-cast at all: checking a full SupabaseServerClient against the shallow port\n' +
      "// instantiates supabase-js's `.from()` overload set and sends tsc into TS2589 (\"excessively\n" +
      '// deep"). The assertion is SOUND: the port is a hand-authored SUBSET of the surface the DAL\n' +
      '// calls and the runtime value is a real client. RLS is unchanged, since it is the same\n' +
      '// request-scoped client seen through a narrower type. The double-cast (never a single `as`)\n' +
      '// says the two types are not directly comparable, which is the whole reason.\n' +
      '//\n' +
      `// Uncomment it once @app/${slice} exports ${pascal}Database (src/data/port.ts). See the skill's\n` +
      '// references/dal-dto.md (the port narrowing).\n' +
      '//\n' +
      `// import type { ${pascal}Database } from '@app/${slice}'\n` +
      "// import type { SupabaseServerClient } from '@app/supabase'\n" +
      '//\n' +
      `// export function to${pascal}Port(client: SupabaseServerClient): ${pascal}Database {\n` +
      '//   // On a const, never in the return position: there no-unnecessary-type-assertion\n' +
      '//   // reads the assertion as redundant, blind to the deep check that makes it load-bearing.\n' +
      `//   const port = client as unknown as ${pascal}Database\n` +
      '//   return port\n' +
      '// }\n',
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
    `supabase/schemas/NN_${slice}.sql in the org_id shape of references/migration-rls.md ` +
    '(org_id NOT NULL with its FK as the tenant key, PRIMARY KEY (org_id, id), the freeze_org_id ' +
    'trigger, ENABLE + FORCE RLS, four per-op policies on private.member_org_ids(), an ' +
    'org_id-leading index carrying the list ORDER BY, REVOKE ALL from anon, service_role and ' +
    'authenticated, then GRANT authenticated exactly what the policies admit)',
)
console.log(
  'next: add an ISOLATION_TARGET to tests/rls/db-context.ts AND an rls_targets row to ' +
    'supabase/tests/rls_structure.test.sql for each org-scoped table',
)
console.log(
  `next: add packages/verticals/${slice}/package.json (name @app/${slice}, exports "." -> ` +
    './src/index.ts and "./client" -> ./src/client.ts) and its tsconfig.json, reference that ' +
    'from the root and apps/web tsconfig.json, then run: pnpm install',
)
console.log(
  `next: export the catalog from src/client.ts as EVENT_CATALOG (export { ${camel}Events as EVENT_CATALOG } from './events.js'), or its events are never catalogued`,
)
console.log('next: wire the router into appRouter (packages/api/src/index.ts), then run: pnpm gen')
console.log(
  'next: fill QUERY_PROBES in src/data/query-probes.ts (one per branch of every DAL export), ' +
    'then run: pnpm gen (query-shapes reds an empty manifest while a probe module exists)',
)
console.log(
  `next: add the key 'route.${camel}' (the page's titleKey) to apps/web/lib/i18n/catalog.ts`,
)
console.log(
  'next: run node tools/gen-web-routes.mjs to regenerate apps/web/lib/routes.generated.ts ' +
    '(pnpm gen does it too, but needs a local database)',
)
console.log(
  `next: add a spec under apps/web/e2e that names one state id ('${slice}-empty') as a quoted ` +
    'literal (route-manifest asks a browser test to render every route)',
)
console.log(
  'next: register the screen in apps/mobile/src/routes.ts + add its app/ route file rendering ' +
    '<Screen testID="<route-id>-screen"> (the device lane asserts that id)',
)
console.log(`next: scaffold the Maestro flow (after registering): node tools/gen-maestro-flows.mjs --flow ${slice}`)
console.log('next: add the tools/startup-budget.json row (human-reviewed budget)')
console.log('next: prove the boundary — pnpm test:rls (pgTAP + the supabase-js client suite)')
