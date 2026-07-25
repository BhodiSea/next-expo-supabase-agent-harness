# Data layer reference — vertical, procedure, Server Action, web read

One operation, two callers. The vertical package holds the ONE implementation; the tRPC
procedure and the web Server Action are thin transports over it. The moment a rule lives in
only one of them ("web trims the title but mobile doesn't") the two surfaces have become two
products. `packages/verticals/notes/**` is the worked example every layer below is copied
from.

## The vertical (`packages/verticals/<slice>/`)

Shape (mirror `packages/verticals/notes/src/*`):

- `src/domain/` — pure functions. No IO, no clock, no client. The exhaustively testable layer
  where the rules actually live.
- `src/data/` — the DAL. Takes a client, returns DTOs (never rows), returns outcomes (never
  throws for a domain failure).
- `src/schemas.ts` — the input schemas, DERIVED from `@app/contracts` (add only the
  refinements that need domain knowledge; a refinement that could have been a wire bound
  belongs upstream in the contract, where the client sees it too).
- `src/events.ts` — the facts this vertical publishes, through `@app/events`'
  `defineEventCatalog` so the `event-catalog` generator can walk them. Payloads carry
  IDENTIFIERS, never content; constructors are PURE (`occurredAt` is a parameter, the row's
  own timestamp, never `Date.now()`).
- `src/client.ts` — the METRO-SAFE barrel: pure domain + zod + the DIRECT RLS READS a phone
  performs against its own scoped client.
- `src/index.ts` — re-exports `./client` and adds the SERVER-ONLY surface (the writes).

### The three DAL laws (visible in every `data/<slice>.ts` function)

1. **It takes a client, it never makes one.** The client handed in is the per-request,
   RLS-scoped one. A DAL that could reach for a service-role client would make every caller a
   privilege decision. The client arrives through a small STRUCTURAL port (`data/port.ts`) —
   a hand-authored subset of the PostgREST query builder with `data: unknown` — not the
   generated `Database` type: a generated type makes rows look trustworthy at the entrance,
   the exact illusion the re-parse at the exit exists to prevent, and it is fakeable in three
   lines so every branch (RLS denial, malformed row) is reachable from a unit test with no
   container.
2. **It returns DTOs, never rows.** A single row-boundary module (`data/rows.ts`) parses each
   row ONCE against a schema whose fields are BORROWED from the `@app/contracts` shape
   (`NoteRecord.shape.title`, never a restated bound) and renames snake_case -> camelCase. An
   explicit column projection, never `select('*')` — `*` welds the wire payload to the
   physical table, so an internal column (an embedding, a moderation flag) silently grows
   every response past the contract. `rows.test.ts` asserts the projection string covers
   exactly the row schema's keys.
3. **It returns outcomes, never throws for a domain failure.** Every exit is
   `outcomeOk(dto)` / `outcomeErr(appError.X())` from `@app/errors`.

And one absence that is load-bearing: **no app-side owner filter on reads.** Visibility is the
RLS policies' job, enforced against `auth.uid()`. A `WHERE owner_id = …` in the app would MASK
a policy regression — the tests would pass the day a policy is dropped. On INSERT the owner
column comes from the VERIFIED actor on a write context, never a wire value; the contract does
not even carry the field, and the `WITH CHECK` re-rejects anything else with SQLSTATE 42501.

### Reads, writes, and the barrel split

- **Reads** (`getNote`, `listNotes`) go on `./client`: they are safe to run from a phone
  because RLS is the boundary and the token is scoped to one user.
- **Writes** (`createNote`, `updateNote`, `deleteNote`) stay OFF `./client`: they set an
  ownership column from a verified actor and emit an event, so they belong where the actor was
  verified. They take a `WriteContext` (`{ actorId, emit, now, workspaceId }`) alongside the
  client and input.
- **Every list query is keyset-paginated with an unconditional LIMIT.** Opaque base64url
  cursor over `{ createdAt, id }`, an `or(...)` seek expressing the two lexicographic cases
  (never OFFSET), `limit + 1` fetched as the has-more sentinel. `createdAt` rides the cursor
  as VERBATIM timestamptz text — a JS `Date` round-trip truncates microseconds and
  skips/dups rows. `data/notes.ts` + `domain/cursor.ts` are the pattern.
- **`error` FIRST, always.** PostgREST resolves rather than rejects, so reading `data` before
  `error` renders an RLS denial as an empty list. Map a Postgres failure through the
  vertical's error mapper (42501 -> `rlsDenied`, etc.).
- **`noUncheckedIndexedAccess`:** `rows[0]` is `T | undefined` — branch on it. An INSERT that
  reports no error and returns no row means a SELECT policy filtered the RETURNING projection
  (an unreadable-write misconfiguration), NOT a user error.

## The tRPC procedure (`packages/api/src/routers/<slice>.ts`)

Copy `routers/notes.ts`. Every procedure is three lines or fewer, and that is the point: pick
a rung of the ladder (`packages/api/src/trpc.ts`), name an input schema, hand the call to the
vertical. Business rules in a router are rules the Server Action cannot reach — the moment one
lands here the two surfaces have forked.

The rung split says something real:

- **Reads are `authedProcedure`** — any signed-in user may read what RLS lets them see.
- **Writes are `memberProcedure`** — writing consumes a seat. Membership is an authorization
  OUTCOME, not a transport fact, so the middleware resolves it once and the handler returns it
  verbatim on the failure path:

  ```ts
  create: memberProcedure.input(CreateNoteSchema).mutation(({ ctx, input }) => {
    const gate = ctx.member
    if (!gate.ok) return gate
    return createNote(ctx.db, writeContext(ctx, gate.data.workspaceId), input)
  }),
  ```

  Assemble the `WriteContext` in a small `writeContext(ctx, workspaceId)` function so
  `actorId` can only ever come from `ctx.actor.userId` (the verified actor), never the input.

**The envelope rule.** Procedures return `ActionOutcome` on the DATA channel. A domain failure
is NEVER a thrown `TRPCError` — throwing flattens the `AppError` discriminant the screens
switch on into an HTTP status, and "someone else deleted this note" becomes "something went
wrong". Exactly two things bypass the envelope, both transport facts a handler could not
produce: the auth middleware's `UNAUTHORIZED` and the skew guard's `CONFLICT`. A `.input()`
parse failure is the framework's, not yours. `no transformer` — every payload is JSON-safe by
construction.

**After ANY router change, regenerate the committed inventories: `pnpm gen`** (rewrites
`tools/generated/action-inventory.json` + `event-catalog.json`; the `contracts` gate
regen-diffs them, and `parity` holds the mobile ledger to the action inventory).

## The optional web Server Action (`apps/web/app/actions/<slice>.ts`)

Add it only when the WEB surface writes this entity. It is the procedure's twin — SAME
`@app/contracts` schema, SAME vertical implementation, SAME `ActionOutcome`. Copy
`app/actions/notes.ts`:

- `'use server'` marks the whole module — every export becomes a POST endpoint callable by
  anyone who can read the client bundle. Treat each exported function as a public API.
- Validate with `actionClient.inputSchema(<Slice>Schema)` (the same schema the procedure
  uses) BEFORE any of it reaches domain code.
- Resolve identity server-side: `getVerifiedUser()` (which uses `getUser()` under the hood —
  never `getSession()`); an anonymous caller is refused on the data channel with
  `outcomeErr(appError.unauthorized())`, not left to surface as an opaque RLS denial.
- Mint the request-scoped client with `createRequestScopedClient()` and narrow it to the
  vertical's port with the sanctioned double-cast `as unknown as <Slice>Database` (checking a
  full `SupabaseServerClient` against the shallow port sends tsc into TS2589 — the assertion
  is a hand-authored SUBSET, sound, and matches the tRPC route and the read seam).
- On success only, `revalidatePath('/<slice>')` — invalidating on failure refetches identical
  data and makes a rejected write look like a slow one.
- Fold next-safe-action's three out-of-band channels (`data` / `validationErrors` /
  `serverError`) back ONTO the data channel so the caller only ever sees one envelope shape.

## The web read seam (`apps/web/lib/app-data/<slice>.ts`)

The RSC read path, in one place and this order: per-request client
(`createRequestScopedClient()`) -> the vertical `./client` fn -> match the outcome -> a render
model -> the page. Read it as prohibitions (copy `lib/app-data/notes.ts`):

- A Server Component NEVER queries Supabase directly — the table access, the projection and
  the ordering belong to the vertical.
- The vertical NEVER constructs its own client — it receives a request-scoped one, which is
  what keeps it free of `next/*` and reusable from the mobile-facing bearer path unchanged.
- No `fetch()` and no HTTP hop to the app's own `/api/trpc` — this runs in the same process as
  the API; that would be pure latency plus a second copy of the auth story.
- Caching is deliberately absent: every read is RLS-scoped to the calling user, and a cache
  keyed on anything less specific than the verified identity is a cross-tenant leak in a
  performance costume. Add caching per query with the identity in the key, or not at all.
- Infrastructure throws (Supabase unreachable, env unparsed) are NOT caught here — they belong
  to the route's `error.tsx` boundary, which can offer a retry. Domain failures come back
  inside the model.

## Contracts (`packages/contracts`)

- **Every wire string carries a `.max()` bound** (and `.min(1)` where empty is meaningless);
  numbers carry ranges. Follow `NewNoteInput` (title 1..200, body <= 20 000) and the
  `NOTE_*_MAX` constants as the scale reference. An unbounded wire string is a
  memory-amplification primitive.
- Two shapes per entity: `*Record` (persisted contract, the DAL's exit shape, camelCased) and
  `*View` (the ONE render shape both surfaces import — a field rename is a compile error on
  both at once). The Record -> View map is a single pure function in the vertical.
- List responses are `{ items, nextCursor }`; `limit` defaults and caps live in the contract
  (`NOTES_PAGE_LIMIT_*`); cursors are opaque bounded base64url strings.

## Class-A vs Class-B — default every write to Class-B

- **Class-B (DEFAULT):** mobile writes through the tRPC procedure served by web. One
  implementation, verified server-side, events emitted where the actor was verified. Reach for
  this unless there is a stated reason not to.
- **Class-A (opt-in):** mobile writes DIRECT to Supabase through the vertical's `./client` and
  TanStack Query, relying on RLS `WITH CHECK` as the sole write guard. It is a
  security-census decision (a reasoned entry, reviewed), never a reflex — it trades the
  server-side seam (input refinement beyond the contract, event emission, a single audited
  code path) for a round trip saved.

## Discipline

- `import type` for type-only imports (`verbatimModuleSyntax`); no non-null assertions on user
  data; cognitive complexity <= 15 is a lint ERROR — refactor, never suppress.
- New code ships with tests that hold the per-file coverage floor (see `references/tests.md`).
- `// SOURCE: <authority> [corpus: <id>]` on every non-trivial decision (RLS predicate, keyset
  seek, error mapping, cursor codec) — the `provenance` gate flags unsourced decision keywords
  and requires payloads that RESOLVE.
