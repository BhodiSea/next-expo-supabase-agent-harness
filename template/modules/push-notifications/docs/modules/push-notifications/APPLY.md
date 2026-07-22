# Applying the push-notifications slice

The checklist for landing the device push-token slice, in the
`authoring-vertical-slice` skill's order (migration → DAL/DTO → route → the
mobile seam → tests → provenance → gate). Everything below is ONE review-sized
diff; nothing before "Verify" needs to be green in isolation. Paths are
relative to the repo root; `SLICE=docs/modules/push-notifications/slice`
throughout:

```sh
SLICE=docs/modules/push-notifications/slice
```

The slice's code files are stored with a `.txt` suffix (`push-tokens.ts.txt`)
so the un-applied docs tree stays inert: nothing claims a `.txt` file — not
eslint's project service (which reds any `.ts` outside a tsconfig project),
not a test runner, not tsc. Each copy below strips the suffix; the copied file
is byte-identical to what you reviewed.

Three steps (5a, 5b, 7) touch write-guard-protected review files — a human
applies those edits (or sets `HARNESS_ALLOW_SELF_EDIT=1` for the turn). The
migration in step 1 is shell-write-protected for agents (see there). Everything
else is ordinary agent-editable surface.

## 1. Migration + RLS

Copy the schema declaration:

```sh
cp "$SLICE/packages/schema/src/push-tokens.ts.txt" packages/schema/src/push-tokens.ts
```

Land the migration at `packages/schema/drizzle/0003_push_device_tokens.sql`
with the exact content of `$SLICE/packages/schema/drizzle/0003_push_device_tokens.sql`.
HOW depends on who is applying: `packages/schema/drizzle/` is bash-guard
territory (shell writes bypass the write-guard), so an agent must land it via
the Write tool — one Write, full file content; a human can simply `cp`. Either
way the file is written ONCE: migrations are append-only (the write-guard
denies edits to any existing migration; corrections are a further new
migration).

If your `packages/schema/drizzle/` already advanced past `0003`, use your next
`NNNN` (keep the `_push_device_tokens` tag suffix) and use that index/tag in
the journal entry below.

Re-export the table from the schema entry — drizzle-kit
(`schema: './src/index.ts'`) and the drift/self-check tests only see what
`index.ts` exports. Append to `packages/schema/src/index.ts`:

```ts
export * from './push-tokens.js'
```

Register the migration in `packages/schema/drizzle/meta/_journal.json` — append
to `entries` (bump `idx`/`tag` if you renumbered; `when` just needs to stay
ascending):

```json
{
  "breakpoints": true,
  "idx": 3,
  "tag": "0003_push_device_tokens",
  "version": "7",
  "when": 1767225900000
}
```

Extend the migration self-check in `packages/schema/src/schema.test.ts`: it was
written when `0000_init.sql` was the only migration and asserts ENABLE + FORCE
for EVERY exported pgTable against that one file, so any new table reds it.
The fix is a strengthening, not a weakening — give the unit-lane mirror the
same cumulative-SQL definition the `schema-rls` gate already uses. Replace

```ts
const migrationSql = readFileSync(new URL('../drizzle/0000_init.sql', import.meta.url), 'utf8')
```

with

```ts
// Cumulative migration SQL — the same definition the schema-rls gate parses.
// (Was 0000_init.sql only, which would red EVERY table added after the initial
// migration; the notes-specific assertions below still hold on the superset.)
const migrationSql = readdirSync(new URL('../drizzle/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'))
  .join('\n')
```

and widen the node:fs import on line 4 to
`import { readdirSync, readFileSync } from 'node:fs'`.

Optional sanity: `pnpm --filter @app/schema exec drizzle-kit check`.

## 2. Contracts (DTO)

The push-token contracts are APPENDED to `packages/contracts/src/index.ts` —
not added as a second file. This is deliberate, not style: `@app/contracts` is
bundled by Metro for the mobile client, and under the package's NodeNext
module settings a re-export must be spelled `./push-tokens.js` — a specifier
Metro cannot resolve back to a `.ts` source (the server-only `@app/schema`
package CAN split, because Metro never bundles it). The append block needs no
import of its own (`z` is already in scope) and collides with nothing:

```sh
cat "$SLICE/packages/contracts/src/push-tokens.contracts.txt" >> packages/contracts/src/index.ts
```

## 3. DAL

```sh
cp "$SLICE/apps/server/src/dal/push-token-id.ts.txt" apps/server/src/dal/push-token-id.ts
cp "$SLICE/apps/server/src/dal/push-tokens.ts.txt" apps/server/src/dal/push-tokens.ts
```

Declare the DAL contract in `apps/server/src/types.ts` (the `NotesDal`
pattern — routes depend on the interface; tests inject fakes). Widen the
`@app/contracts` type import to include `NewPushDeviceToken`,
`PushDeviceToken`, and `PushDeviceTokensPageDto`, then append:

```ts
/**
 * The push device-token data-access contract (push-notifications module).
 * `register` is an idempotent upsert keyed on the deterministic row id; `page`
 * reuses the (createdAt, id) keyset shape the notes cursor codec defines.
 */
export interface PushTokensDal {
  register(userId: string, input: NewPushDeviceToken): Promise<PushDeviceToken>
  list(
    userId: string,
    page: { readonly limit: number; readonly cursor?: NoteCursorKey | undefined },
  ): Promise<PushDeviceTokensPageDto>
  remove(userId: string, id: string): Promise<boolean>
}
```

## 4. Route + contract regen

```sh
mkdir -p apps/server/src/routes
cp "$SLICE/apps/server/src/routes/push-tokens.ts.txt" apps/server/src/routes/push-tokens.ts
```

Wire it into `apps/server/src/app.ts` — three small edits:

a. Imports (the formatter's organize-imports will place them):

```ts
import { pushTokensDal } from './dal/push-tokens.js'
import { registerPushTokenRoutes } from './routes/push-tokens.js'
```

and widen the types import to
`import type { AppEnv, NotesDal, PushTokensDal } from './types.js'`.

b. `AppOptions` gains (next to the `notesDal` member):

```ts
  /** Push device-token DAL (push-notifications module); tests inject fakes here. */
  readonly pushTokensDal?: PushTokensDal
```

c. In `createApp`, AFTER the `app.openapi(deleteNoteRoute, …)` block (i.e.
after the `/api/*` middleware mounts, so the routes inherit skew + auth +
body-limit — the middleware walk in `middleware/skew.test.ts` will prove it):

```ts
  // push-notifications module — the device push-token slice
  // (docs/modules/push-notifications/). Registered after the /api/* guards.
  registerPushTokenRoutes(app, options.pushTokensDal ?? pushTokensDal)
```

Then regenerate the committed contract (the `contracts` gate re-emits and
diffs it):

```sh
pnpm --filter server openapi:emit
```

## 5. The expo-notifications seam (mobile)

See the README's seam section for the full reasoning; the mechanical steps:

```sh
cd apps/mobile && npx expo install expo-notifications && cd ../..
```

Then, in ONE diff (the `expo-policy` gate locksteps each pair bidirectionally):

- `apps/mobile/app.config.ts`: add `'expo-notifications'` to `plugins` and
  `permissions: ['android.permission.POST_NOTIFICATIONS']` to `android`.
- **5a (human/write-guarded)** `tools/expo-plugins.json`: add the
  `expo-notifications` entry (exact JSON in the README).
- **5b (human/write-guarded)** `tools/expo-permissions.json`: add the
  `android.permission.POST_NOTIFICATIONS` entry (exact JSON in the README).

The client registration function is a snippet in the README ("Registering a
token from the app") — wire it into your sign-in flow or a settings screen and
give it a jest-expo test alongside your screen tests.

## 6. Tests + the RLS isolation extension

```sh
cp "$SLICE/apps/server/src/dal/push-token-id.test.ts.txt" apps/server/src/dal/push-token-id.test.ts
cp "$SLICE/apps/server/src/dal/push-tokens.statements.test.ts.txt" \
   apps/server/src/dal/push-tokens.statements.test.ts
cp "$SLICE/apps/server/src/routes/push-tokens.test.ts.txt" apps/server/src/routes/push-tokens.test.ts
```

(They join the `unit-node` vitest project through the existing
`apps/server/src/**/*.test.ts` include — no config change.)

Wire the table into the runtime isolation matrix — append to
`ISOLATION_TARGETS` in `tests/rls/db-context.ts` (the cross-tenant matrix, the
pooled-connection GUC-leak probe, and the pg_catalog checks all iterate it;
`schema-rls` reds until this entry exists). Seed values are deliberately plain
scalars — the plan probe bulk-seeds them 25 000× with constant per-column
binds, and the cross-user UPDATE probe derives its SET column from the first
non-owner `seedRow` key (`platform` here — a value the CHECK accepts):

```ts
  {
    table: 'push_device_tokens',
    ownerColumn: 'owner_id',
    seedRow: (ownerId) => ({
      owner_id: ownerId,
      platform: 'ios',
      token: 'rls probe token',
    }),
  },
```

Register the DAL's query shapes in `tests/rls/dal-shapes.ts` (the plan-registry
closure test fails the moment `pushTokensDal` exists with no shapes — an
unmeasured query cannot be added by accident). Add the import:

```ts
import { pushTokensDal } from '../../apps/server/src/dal/push-tokens.js'
```

and append to `DAL_SHAPES` (EXPLAIN only — the register/remove shapes write and
delete nothing; `MID_CURSOR`/`ABSENT_ID` are already defined in the file):

```ts
  {
    id: 'pushTokensDal.register',
    method: 'pushTokensDal.register',
    table: 'push_device_tokens',
    run: (userId) => pushTokensDal.register(userId, { platform: 'ios', token: 'plan probe token' }),
  },
  {
    id: 'pushTokensDal.list:first-page',
    method: 'pushTokensDal.list',
    table: 'push_device_tokens',
    run: (userId) => pushTokensDal.list(userId, { limit: 20 }),
  },
  {
    // Page 2+ adds the row-value range condition — the shape where a missing
    // composite index shows up as a Sort node over the owner's whole partition.
    id: 'pushTokensDal.list:cursor-page',
    method: 'pushTokensDal.list',
    table: 'push_device_tokens',
    run: (userId) => pushTokensDal.list(userId, { limit: 20, cursor: MID_CURSOR }),
  },
  {
    id: 'pushTokensDal.remove',
    method: 'pushTokensDal.remove',
    table: 'push_device_tokens',
    run: (userId) => pushTokensDal.remove(userId, ABSENT_ID),
  },
```

## 7. Reviewed clone acceptances (human/write-guarded)

The slice repeats two blocks that the duplication step (Stop chain + CI) will
name, and both repetitions are doctrine, not rot:

- `packages/schema/src/push-tokens.ts` carries the same four explicit
  per-operation policies as the notes table — per-op policies are the audit
  surface, and a policy-generating helper would hide it to save 35 lines.
- the push list handler repeats the guarded keyset-list shape from `app.ts`
  (decode cursor → 400 on a foreign token → DAL → 200) — that flow IS the
  route's error contract; abstracting it would obscure exactly what a reviewer
  needs to see.

Accept both in `tools/duplication-allow.json` (write-guarded — human edit):

```json
{
  "fingerprint": "7124c2213f0f",
  "reason": "push-notifications module: push_device_tokens carries the same four explicit per-operation owner policies as notes. Per-op policies are doctrine (independently auditable, never FOR ALL) and the block is data the schema-rls gate parses - a policy-generating helper would hide the audit surface to save 35 lines. Irreducible by design."
},
{
  "fingerprint": "53e6092a345f",
  "reason": "push-notifications module: the guarded keyset-list handler (decode cursor -> 400 on a foreign token -> DAL -> 200) is the doctrine shape every keyset list route shares; the push route repeats the notes handler rather than hiding the route's error contract behind a helper. Irreducible by design."
}
```

(Fingerprints are content hashes of the clone's normalized tokens. If your
notes side has drifted from the scaffold, `node tools/check-duplication.mjs`
prints the fingerprints to use — or reports no clone at all, in which case
skip the entry: an allowance nothing matches is dead review weight.)

## 8. Provenance

The slice files carry their `SOURCE:` citations inline. Per the recipe's step
6: emit the ADR (`/adr push-notifications`) so the decision record exists —
the interesting decisions to record are the deterministic-id upsert (and why
not a two-column unique index), the composite owner index, and the
plugin/permission pairs — then run `/verify-citations` and require
`CITATIONS: CLEAN` before finishing.

## 9. Verify (gate)

COMMIT FIRST (one review-sized commit of everything above), for TWO gates:
(a) the `gate-integrity` step verifies the write-guarded review files (the two
expo allowlists, `duplication-allow.json`) against their committed state, so an
uncommitted escape-hatch edit reds it by design; (b) `diff-coverage` measures
the *uncommitted* diff against the per-file coverage floors — left uncommitted,
the whole slice is "the diff", and the schema barrel files
(`packages/schema/src/index.ts`, `push-tokens.ts`) red the vitest per-file
functions floor because their coverage lives in the RLS/DAL suites, not the
unit map. Committed, the Stop chain sees an empty diff and both gates pass on
their real inputs. (For a deliberate pre-commit local run,
`HARNESS_ALLOW_SELF_EDIT=1 pnpm validate` is the sanctioned override.) Then:

```sh
pnpm validate          # the 21-gate chain: schema-rls, migrations, contracts, expo-policy, …
pnpm test              # unit-node incl. the new tests + the DAL shape-closure check
pnpm test:rls          # needs pnpm db:up — isolation matrix + EXPLAIN plan probe
pnpm test:mobile       # unchanged — the slice ships no mobile code
node tools/check-duplication.mjs   # the step-7 acceptances hold (Stop chain runs this too)
```

Expected: the isolation matrix now reports `push_device_tokens` alongside
`notes` (positive control, cross-user SELECT/UPDATE/DELETE zero, smuggled
INSERT → SQLSTATE 42501, GUC-leak probe, pg_catalog checks), and the plan
probe EXPLAINs all four registered shapes with no Seq Scan, no Sort, and a
once-per-statement InitPlan.
