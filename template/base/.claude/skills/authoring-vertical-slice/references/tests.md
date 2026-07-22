# Tests reference

Two runners split the unit floor. The root `vitest.config.ts` defines `unit-node`
(packages/**, apps/server, plus the PURE mobile modules it lists file-by-file) and
the rls project; react-native components/screens run under **jest-expo** in
`apps/mobile` (config: `apps/mobile/jest.config.js`; tests in
`apps/mobile/__tests__/`). A suite runs under exactly ONE runner — pure suites are
listed in the vitest include AND the jest `testPathIgnorePatterns` in LOCKSTEP.
NEVER create a `vitest.workspace` file or call `defineWorkspace` — the write-guard
denies it (single gate surface).

## RLS isolation (the keystone)

For every new user-scoped table, add one entry to `ISOLATION_TARGETS` in
`tests/rls/db-context.ts`:

```ts
{
  table: '<table>',
  ownerColumn: 'owner_id',
  seedRow: (ownerId) => ({ owner_id: ownerId, /* NOT NULL columns */ }),
}
```

The existing suite (`tests/rls/cross-tenant-isolation.test.ts`) then asserts the full
matrix per target: seeded POSITIVE CONTROL (user A sees its own row — a deny-all
database must not pass), cross-user SELECT → 0 rows, UPDATE/DELETE → count 0, INSERT
smuggling the other user's id → SQLSTATE 42501 (`WITH CHECK`), the pooled-connection
GUC-leak probe (pool max=1 on purpose), and the pg_catalog gate (ENABLE + FORCE +
per-op policies, leading-column owner index, initPlan-shaped predicates, no
BYPASSRLS). The plan probe (`tests/rls/plan-regression.test.ts`) additionally
bulk-seeds 10k rows and drives the REAL DAL through the shapes registered in
`tests/rls/dal-shapes.ts`, asserting via EXPLAIN that every target is reached through
its owner index with a once-per-statement InitPlan — register every new DAL method
AND its interesting argument shapes (a first page and a cursor page plan
differently). Run: `pnpm test:rls` (needs `pnpm db:up`; it fresh-applies all
migrations from zero into a SCRATCH database `<db>_rls` under an advisory lock — dev
data is never dropped). Skips are loud locally and FAIL CLOSED in CI. Test bodies
are editable; `tests/rls/run-rls.mjs` and `tests/migrations/migration-apply.mjs` are
write-guard-protected.

## Server units (vitest)

- Inject a fake DAL through `createApp({ notesDal })`-style options — routes depend
  on the interface in `src/types.ts`, so no database is needed.
- Cover: DTO mapping including the `undefined` branches `noUncheckedIndexedAccess`
  forces; bad/missing token → bare 401 envelope; error-envelope shape on
  validation/unknown-route/oversized-body paths (see `app.errors.test.ts`);
  middleware coverage (walk `app.routes` and assert every `/api/*` route sits
  behind skew + auth — see `middleware/skew.test.ts`); SSE abort propagation
  in-process (client abort → producer stops — see `app.sse.test.ts`); auth
  clock-skew boundaries (±4 min passes, ±6 min fails, `clockTolerance: 300`).
- Every new DAL list function gets a statement-count invariance test
  (`dal/notes.statements.test.ts` pattern): the call executes a FIXED number of
  statements regardless of row count.

## Coverage floor

Both runners run `--coverage` in the Stop hook (vitest thresholds in
`vitest.config.ts`; both emit istanbul `coverage-final.json`), and
`tools/check-diff-coverage.mjs` merges the two maps and holds every CHANGED file to
the per-file floor — write the tests WITH the feature, not after; a slice that
drops coverage below the floor cannot end its turn.

## Parsers (fast-check)

Deterministic parsers get property tests plus one pinned fixture — see
`packages/importer/src/parse.test.ts`: round-trip (`format(parse(x)) === x`-shaped)
and quote/escape invariants over generated inputs, always with a FIXED
`{ seed, numRuns }` (the `FC_PARAMS` pattern — a randomly-seeded property test is
a flake generator). No live model calls anywhere; LLM-shaped code tests against
`FakeInferenceProvider` from `@app/eval`, and extraction outputs are accepted
ONLY through `parseExtraction` (schema-valid AND evidence-grounded — offsets
must slice to the quoted text).

## Mobile (jest-expo)

React Native Testing Library for feature components and screens
(accessible-name/role queries; `renderRouter` from `expo-router/testing-library`
for router-aware screens). Drive the loading/empty/error states through the
testIDs the screen declares in `src/routes.ts` (the states-sweep pattern in
`__tests__/states-sweep.test.tsx` iterates ROUTES); stub the network at the
`src/testing/mock-server.ts` seam, never a bare global fetch stub. Fabric view
flattening can detach `testID`s on nested plain Views — put them on
interactive/accessible LEAF elements. Real HTTP + on-device behaviour belong to
the Maestro CI lane.

## Rules that keep the gate honest

- Never edit a test and its implementation in the same turn to turn red green; if a
  test is wrong, report it and stop.
- Never weaken assertions, remove positive controls, or `.skip` a failing test.
- Mutation-survivable assertions: specific values and fail-closed behaviour (0 rows,
  exact SQLSTATE, exact DTO shape), not "it ran".
- Annotate non-obvious fixtures (token minting, seeded users) with `// SOURCE:`.

Commands: `pnpm test` · `pnpm test:mobile` · `pnpm test:rls` · `pnpm validate` (the
Stop hook runs them all directly — done means green).
