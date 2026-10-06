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
  performs against its own scoped client. It also exports the catalog as `EVENT_CATALOG`
  (`export { <slice>Events as EVENT_CATALOG } from './events.js'`): that name in this file is
  how `tools/gen-event-catalog.mjs` finds the vertical, and a vertical without it is not
  catalogued.
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
  verified. They take a `WriteContext` (`{ actorId, emit, now, orgId }`) alongside the
  client and input, and ONE builder makes it for every caller:
  `<slice>WriteContext(actor, org, ports)` in `src/data/write-context.ts`, exported from the
  server barrel beside the type (`noteWriteContext` is the pattern). It takes `actorId` from
  the verified actor and `orgId` from the resolved org, and passes the caller's `emit` and
  `now` through. Its own module, not `data/<slice>.ts`: `query-probes.ts` re-exports that
  file as the DAL, and generation fails on an exported function no probe drives.
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

### The query probes (`src/data/query-probes.ts`)

`tools/gen-query-shapes.mjs` runs every DAL function through a recording port and commits
what each one asks the database for; the `query-shapes` gate judges that manifest (bounded,
served by an `org_id`-leading index, keyset seek equal to the sort). The probe module decides
only WHICH function runs with WHAT inputs: export `DAL` as a namespace import of
`./<slice>.js` and a non-empty `QUERY_PROBES`, one entry per BRANCH (a first page, a cursor
seek and an archived-included list are three statements with three plans). Generation fails
when an exported function has no probe or a probe issues no query. Then `pnpm gen`. A probe
module with an empty manifest reds `query-shapes`.

## The tRPC procedure (`packages/api/src/routers/<slice>.ts`)

Copy `routers/notes.ts`. Every procedure is three lines or fewer, and that is the point: pick
a rung of the ladder (`packages/api/src/trpc.ts`), name an input schema, hand the call to the
vertical. Business rules in a router are rules the Server Action cannot reach — the moment one
lands here the two surfaces have forked.

The rung split says something real:

- **EVERY procedure is `orgProcedure`, reads included.** In the pre-org model reads rode
  `authedProcedure` because "their own rows are always in that set". Under org scope that
  stops being true in any useful way: a user in three orgs has three sets, RLS admits all
  of them at once, and a read with no active org returns them interleaved with no way to
  tell which org a row came from. The acting org is not an extra permission on top of the
  read — it is WHICH DATA the read is about.
- **The gate is an OUTCOME on the data channel, never a throw.** The middleware resolves
  membership once and the handler returns the gate verbatim on the failure path, so a
  caller with no active org gets a `forbidden(org_context_required)` it can render as
  "pick an organization" instead of an empty page that looks like data loss:

  <!-- skill-region:begin create-procedure source=packages/api/src/routers/notes.ts -->
  ```ts
  create: orgProcedure.input(CreateNoteSchema).mutation(({ ctx, input }) => {
    const gate = ctx.org
    if (!gate.ok) return gate
    return createNote(ctx.db, writeContext(ctx, gate.data.id), input)
  }),
  ```
  <!-- skill-region:end create-procedure -->

  That block is `packages/api/src/routers/notes.ts` verbatim, so it names notes: rename
  `Note` and `note` to your slice when you copy it.

  Assemble the `WriteContext` in a small `writeContext(ctx, orgId)` function that hands the
  vertical's builder `ctx.actor` (the verified actor), the RESOLVED gate's id and `ctx` itself
  as the ports (`noteWriteContext(ctx.actor, { id: orgId }, ctx)`), so there is no expression
  in it a future edit could accidentally point at the input instead, and `emit` and `now` are
  the ones the host handed `createContext`.
- **`orgProcedure` is not the isolation boundary.** It produces a good error BEFORE the
  round trip; the boundary is the RLS policies, which key on `public.memberships` at
  statement time and are indifferent to everything this rung believes. A bug here yields a
  database denial or an empty page — never a cross-tenant read. That asymmetry is why the
  rung is allowed to be this simple.

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
- The org is a BOUND argument, never a payload field:
  `actionClient.bindArgsSchemas<[orgSlug: typeof OrgSlug]>([OrgSlug]).inputSchema(<Slice>Schema)`
  (the same schema the procedure uses) parses both BEFORE any of it reaches domain code. The
  slug is the segment the form renders under; a tenant a request can NAME in its body is a
  tenant the first careless handler will trust.
- Resolve identity AND scope server-side in one call: `requireOrgContext(orgSlug)` verifies
  the user (`getUser()` under the hood — never `getSession()`) and looks the slug up in the
  caller's real seats. Return the gate verbatim when it fails, so an anonymous or seatless
  caller is refused on the data channel, not left to surface as an opaque RLS denial.
- Narrow the gate's client with `to<Slice>Port(gate.data.client)` (the port narrowing,
  below).
- Build the write context with the vertical's builder and the host's request ports, never
  with an object literal:
  `<slice>WriteContext({ userId: gate.data.userId }, gate.data.org, requestPorts())`. The
  actor is the verified user and the org the RESOLVED one, never anything from the input, and
  `requestPorts()` (`apps/web/lib/request-ports.ts`) is the event sink and instant the tRPC
  route hands `createContext`, so a sink wired there hears both transports.
- On success only, ``revalidatePath(`/o/${gate.data.org.slug}/<slice>`)``: the org's path, so
  one tenant's write never invalidates another's entry. Invalidating on failure refetches
  identical data and makes a rejected write look like a slow one.
- Fold next-safe-action's three out-of-band channels (`data` / `validationErrors` /
  `serverError`) back ONTO the data channel so the caller only ever sees one envelope shape.

## The port narrowing (`apps/web/lib/app-data/<slice>-port.ts`)

ONE function, `to<Slice>Port(client: SupabaseServerClient): <Slice>Database`, is the only
place apps/web casts a client to the vertical's port; the Server Action, the read seam and the
tRPC route call it. Checking a full `SupabaseServerClient` against the shallow port sends tsc
into TS2589 (supabase-js's `.from()` overload set), so the narrowing is the double-cast
`client as unknown as <Slice>Database`. It is sound, because the port is a hand-authored
SUBSET of what the DAL calls and the runtime value is a real client, and it changes nothing
RLS sees, because it is the same client through a narrower type. Written once with its
reason, it cannot become a cast per call site, each restating why. The scaffold writes it
commented out until the vertical exports its port.

## The web read seam (`apps/web/lib/app-data/<slice>.ts`)

The RSC read path, in one place and this order: `requireOrgContext(orgSlug)` (the per-request
client, the verified user and the org resolved from the caller's seats) ->
`to<Slice>Port(gate.data.client)` -> the vertical `./client` fn, scoped to the RESOLVED org's
id and never the slug -> match the outcome -> a render model -> the page. A gate failure is a
domain outcome and rides the model. Read it as prohibitions (copy `lib/app-data/notes.ts`):

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

## The web route (`apps/web/app/(protected)/o/[orgSlug]/<slice>/`)

The page is a segment under the org scope: the segment IS the tenant selector, it sits under
the signed-in layout and the org layout that resolves the slug, and the page reads `orgSlug`
from `params` and hands it to the read seam. Beside `page.tsx` sit `page.meta.ts` (`id`, a
`titleKey` that is a key in `apps/web/lib/i18n/catalog.ts`, and the three state test ids) and
`loading.tsx`. Render each state's id as `data-testid={meta.states.<key>}`, so the declared
and the rendered id cannot drift. `route-manifest` holds the rest: regenerate the registry
with `node tools/gen-web-routes.mjs`, and add a spec under `apps/web/e2e` that names one of
the route's state ids.

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
