# DAL + DTO + route reference

## The DAL law

`apps/server/src/db/client.ts` is the ONLY module that imports the database
driver (depcruise rule `postgres-driver-db-layer-only`). `apps/server/src/dal/**`
acquires the database exclusively through `withUserContext` from
`apps/server/src/db/context.ts` (depcruise rule `db-context-dal-only`):

```ts
// db/context.ts (already shipped — reuse, never reimplement)
export async function withUserContext<T>(
  userId: string,
  fn: (tx: UserTx) => Promise<T>,
): Promise<T> {
  // opens a drizzle transaction and binds identity transaction-locally:
  //   select set_config('app.user_id', ${userId}, true)
  // FORCE RLS keys on this GUC — the wrapper IS the authorization boundary.
}
```

The write-guard denies whole-file writes to `apps/server/src/dal/*.ts` that lack
`withUserContext`. `DATABASE_URL` is the unprivileged `app_api` role; there is no
code path to the database outside a user context.

## DAL module shape (`apps/server/src/dal/<feature>.ts`)

- Implement an interface declared in `src/types.ts` (the `NotesDal` pattern) so
  routes depend on the contract and tests inject fakes via `createApp({ ... })`.
- Query with the drizzle query builder against the schema from `@app/schema` —
  no raw SQL string triplication (see `dal/notes.ts` for the worked example).
- Zod-parse at the DAL exit (`NoteDto.parse` / `NotesPage.parse` from
  `@app/contracts`) — raw driver rows never escape. Internal columns (e.g.
  `embedding`) are never selected.
- **Every list query is keyset-paginated with an unconditional LIMIT** — an
  unbounded SELECT is a shipped regression at scale. The pattern (see
  `dal/notes.ts` + `dal/cursor.ts`): opaque base64url cursor over
  `{ createdAt, id }`, seek via row-wise comparison
  `("created_at","id") < ($1::timestamptz, $2::uuid)`, fetch `limit + 1` as the
  has-more sentinel, return `{ items, nextCursor }`. `createdAt` rides the
  cursor as VERBATIM timestamptz text — a JS `Date` round-trip truncates
  microseconds and skips/dups rows.
- Statement-count invariance: a DAL list call executes exactly ONE statement
  regardless of row count (`dal/notes.statements.test.ts` asserts it — the N+1
  class cannot land silently). Give new DAL functions the same test, and register
  the method plus its interesting argument shapes (first page, cursor page) in
  `tests/rls/dal-shapes.ts` so the plan probe EXPLAINs the real SQL at scale.
- No app-side owner filtering on reads — visibility is the RLS policies' job, and a
  `WHERE owner_id = ...` would mask a policy regression. On INSERT the owner column
  is `userId` (the verified token subject), never a wire value; the RLS `WITH CHECK`
  rejects anything else with SQLSTATE 42501.
- `noUncheckedIndexedAccess`: `rows[0]` is `T | undefined` — branch on it explicitly.

## Contracts (`packages/contracts`)

- **Every wire string carries a `.max()` bound** (and `.min(1)` where empty is
  meaningless); numbers carry ranges. Unbounded wire input is gate-red culture:
  follow the `NewNoteInput` bounds (title 1..200, body ≤ 20 000) as the scale
  reference.
- List responses are `{ items, nextCursor }` (`NotesPage` pattern); `limit`
  defaults to 50, caps at 200; cursors are opaque bounded strings.

## Route wiring (`@hono/zod-openapi`)

- Contracts are `createRoute` definitions with request/response schemas imported from
  `@app/contracts`; handlers registered via `app.openapi(route, handler)` in
  `apps/server/src/app.ts` (the composition root — new slices may factor their
  `createRoute` definitions into `apps/server/src/routes/<feature>.ts` and register
  from `app.ts`).
- **Errors are ONE envelope everywhere**: `{ error: { code, message, requestId } }`
  with a closed code enum — produced only through `src/errors.ts` (`apiError()`,
  `app.onError`, `app.notFound`, the OpenAPI `defaultHook`, and the `bodyLimit`
  handler). Every route DECLARES its 4xx/5xx responses (all routes declare 500;
  guarded routes declare 400/401/409). Unknown errors return a static message —
  internals go to the log with the requestId, never over the wire.
- Mount under `/api/*`: the version-skew middleware (409, `code: 'version_skew'`)
  and `requireAuth` (verified JWT → `c.set('userId', ...)`) cover exactly that
  prefix, and a unit test walks the route table to prove coverage. `bodyLimit`
  (1 MiB) rides the same prefix. `/healthz` and `/openapi.json` are the only
  routes outside it.
- Auth failures collapse to a bare 401 envelope — never leak why a credential was
  rejected.
- Protected routes declare `security: [{ Bearer: [] }]` so the contract documents it.
- SSE endpoints use `streamSSE` with `stream.onAbort` stopping the producer — an
  orphaned generator per dropped client is a slow server leak.
  `[corpus: hono/sse-abort]`
- After ANY route change, regenerate the committed contract: `pnpm openapi:emit`
  (stable-stringified `apps/server/openapi.json`; the `contracts` gate re-emits and
  fails on diff).

## Discipline

- `import type` for type-only imports (`verbatimModuleSyntax`); no non-null
  assertions on user data; sonarjs cognitive-complexity ≤ 15 is a lint ERROR —
  refactor, never suppress.
- New code ships with tests that hold the coverage floor (`vitest run --coverage`
  runs in the Stop hook — a feature landing without tests reds the turn).
- `// SOURCE: <authority> [corpus: <id>]` on every non-trivial decision — the
  provenance gate flags unsourced decision keywords (jwtVerify, timeouts, retries,
  set_config, ...) and requires payloads that RESOLVE (https URL, repo path, or
  corpus id).
