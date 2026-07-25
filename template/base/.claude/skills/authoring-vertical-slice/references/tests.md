# Tests reference

Three test surfaces, split by what they can prove: **vitest** (pure domain/logic + the DAL
against a faked client), **jest-expo** (react-native components/screens), and the **RLS
suites** (pgTAP + the supabase-js client isolation suite). A suite runs under exactly ONE
runner. NEVER create a `vitest.workspace` file or call `defineWorkspace` — the write-guard
denies it (single gate surface).

## The two unit runners

- The root `vitest.config.ts` defines `unit-node` (`packages/**` plus the PURE mobile modules
  it lists file-by-file — anything with zero react-native in its import closure) and the rls
  project.
- react-native components/screens run under **jest-expo** in `apps/mobile` (config
  `apps/mobile/jest.config.js`; tests in `apps/mobile/__tests__/`).
- A pure mobile suite is listed in the vitest include AND the jest `testPathIgnorePatterns` in
  LOCKSTEP — one runner each, never both.

## RLS — the keystone, proven TWICE

Both suites run from `pnpm test:rls` (`node tests/rls/run-rls.mjs`, which boots the local
stack via `pnpm db:up`/`supabase start`, exports `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
`SUPABASE_SERVICE_ROLE_KEY`, then runs both halves). Skips are LOUD locally and FAIL CLOSED in
CI — a SKIPPED line is never a pass.

For every new user-scoped table you add TWO registry rows:

1. **`rls_targets`** in `supabase/tests/rls_structure.test.sql` — `(table_name, owner_column)`.
2. **`ISOLATION_TARGETS`** in `tests/rls/db-context.ts` — `{ table, ownerColumn, seedRow }`.
   Keep `table:` IMMEDIATELY followed by `ownerColumn:` (the `schema-rls` gate,
   `tools/check-rls-manifest.mjs`, parses that key order and holds the two registries in
   sync).

### pgTAP (`supabase/tests/*.sql`) — the DATABASE boundary, read back from `pg_catalog`

Run via `supabase test db`; each suite is one transaction ending in `ROLLBACK`.

- `rls_structure.test.sql` reads what the database COMPILED: `ENABLE` + `FORCE` on every
  target, a separate policy per SELECT/INSERT/UPDATE/DELETE (no blanket `FOR ALL`), no vacuous
  `USING (true)`, every policy resolving identity through a scalar sub-select (the InitPlan
  shape), no policy granted to `public`/`anon`, the owner column as the LEADING column of some
  index, `anon` and `service_role` holding no DML grant, and the positive control that
  `authenticated` holds all four grants (so a too-locked-down database fails too).
- `rls_isolation.test.sql` proves BEHAVIOUR through raw role-switch: it impersonates a tenant
  with `SET LOCAL "request.jwt.claims"` + `SET LOCAL ROLE authenticated` (the shape a real
  request arrives with — no identity GUC), and pins the empty-set principle: a cross-tenant
  read returns the EMPTY SET (existence is data — a 403 on "row 91c3…" confirms it exists),
  a cross-tenant UPDATE/DELETE matches nothing and raises nothing, an INSERT smuggling another
  tenant's owner id raises SQLSTATE 42501 (`WITH CHECK`), an unqualified DELETE removes only
  the caller's rows (the account-deletion guard), an empty-claim connection fails CLOSED, and
  `anon` is denied at the table level. The POSITIVE CONTROL (a tenant sees exactly its own one
  row) comes FIRST — against a deny-all database every isolation assertion passes for the
  worst reason.

### supabase-js client suite (`tests/rls/`) — the same boundary through the real transport

`tests/rls/cross-tenant-isolation.test.ts` proves isolation through the SAME PostgREST + GoTrue
path a Class-A mobile write and a web Server Action take — what pgTAP's raw role-switch cannot
see is whether the deployed CLIENT transport enforces the boundary. `tests/rls/db-context.ts`
creates two ephemeral tenants via the admin API (the service-role client is for FIXTURE SETUP
ONLY; every ASSERTION runs through a tenant client that carries a real GoTrue JWT), and the
suite iterates `ISOLATION_TARGETS`: A sees its OWN row (positive control), a cross-tenant
SELECT returns 0 rows with no error, a cross-tenant DELETE matches nothing, an INSERT smuggling
B's owner id is rejected by `WITH CHECK`, and an anonymous client reads zero rows. It self-skips
unless `RLS_SUITE_READY=1`, so a bare `vitest run` never touches the network.

There is NO EXPLAIN plan probe and no `dal-shapes.ts` here — the leading-column index and the
initPlan shape are asserted statically by the pgTAP structural suite and the `schema-rls` gate.

## Vertical / domain units (vitest)

- **Domain functions are pure** — exhaustively unit-tested with no client (`domain/note.test.ts`,
  `domain/cursor.test.ts` are the pattern). The cursor codec is a parser (see fast-check below).
- **The DAL is tested against a FAKED client**, not a container and not a fake-DAL injected into
  a server app. The client arrives through the structural port (`data/port.ts`), which is
  fakeable in a few lines — a plain object with `.from()` returning a chainable `{ data, error }`
  — so every branch is reachable in-process: DTO mapping including the `undefined` branches
  `noUncheckedIndexedAccess` forces, the `error`-first branch (a PostgREST error maps to
  `rlsDenied`/the right kind, NOT an empty list), the malformed-row `contractDrift` branch, the
  unreadable-write branch, and the keyset first-page vs cursor-page shapes.
- **Owner injection is asserted:** the write sets the owner column from the actor context, never
  from the input (the contract does not carry the field).
- **Procedures** are thin; test them through `createCallerFactory` (`packages/api/src/trpc.ts`)
  with a literal context — a passing `member` gate returns the vertical's outcome, a failing one
  returns the `forbidden` envelope verbatim — rather than re-testing the vertical through them.
- **The envelope, everywhere:** a domain failure is a RETURNED `outcomeErr`, never a throw; a
  test asserts the exact `error.kind`/`code`, not that "it ran".

## Mobile (jest-expo)

React Native Testing Library for feature components and screens (accessible-name/role queries;
`renderRouter` from `expo-router/testing-library` for router-aware screens). Drive the
loading/empty/error states through the testIDs the screen declares in `src/routes.ts` (the
states-sweep pattern iterates `ROUTES`). Stub the API at the `src/testing/mock-server.ts` seam
(`mockApiClient()` / `installMockServer(handlers)`), never a bare global `fetch` stub. Fabric
view flattening can detach `testID`s on nested plain Views — put them on interactive/accessible
LEAF elements. Real HTTP + on-device behaviour belong to the Maestro CI lane.

## Coverage floor

Both runners run `--coverage` in the Stop hook and emit istanbul `coverage-final.json`;
`tools/check-diff-coverage.mjs` MERGES the two maps and holds every CHANGED file to the per-file
floor. Write the tests WITH the feature — a slice that drops a changed file below its floor
cannot end its turn.

## Parsers (fast-check)

Deterministic parsers (the keyset cursor codec, any importer) get property tests plus one
pinned fixture: round-trip (`decode(encode(x))` round-trips) and escape/boundary invariants over
generated inputs, ALWAYS with a FIXED `{ seed, numRuns }` (the `FC_PARAMS` pattern — a
randomly-seeded property test is a flake generator). No live model calls anywhere.

## Rules that keep the gate honest

- Never edit a test and its implementation in the same turn to turn red green; if a test is
  wrong, report it and stop (`tools/check-test-quality.mjs` reds assertion-free tests, `.only`,
  and dead `.skip`).
- Never weaken assertions, remove a positive control, or `.skip` a failing test.
- Mutation-survivable assertions: specific values and fail-closed behaviour (0 rows, exact
  SQLSTATE 42501, exact DTO shape, exact `error.kind`), not "it resolved".
- Annotate non-obvious fixtures (minted tenants, seeded users) with `// SOURCE:`.

Commands: `pnpm test` · `pnpm test:mobile` · `pnpm test:rls` · `pnpm validate` (the Stop hook
runs them all directly — done means green).
