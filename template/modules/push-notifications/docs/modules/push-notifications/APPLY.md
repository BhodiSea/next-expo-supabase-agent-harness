# Applying the push-notifications slice

The checklist for landing the device push-token slice, in vertical-slice order
(migration → contracts → vertical → router → the RLS extension → the mobile seam
→ the reviewed escapes → provenance → gate). Everything below is ONE review-sized diff; nothing before
"Verify" needs to be green in isolation. Paths are relative to the repo root;
`SLICE=docs/modules/push-notifications/slice` throughout:

```sh
SLICE=docs/modules/push-notifications/slice
```

The slice's TypeScript files are stored with a `.txt` suffix
(`push-tokens.ts.txt`) so the un-applied docs tree stays inert: nothing claims a
`.txt` file — not the type-aware lint project, not a test runner, not tsc. Each
copy below strips the suffix; the copied file is byte-identical to what you
reviewed. The `.sql` files carry no suffix and are copied as-is.

Three steps (7, 8 and the two `tools/*.json` edits in step 6) touch
write-guard-protected review files — a human applies those edits (or sets
`HARNESS_ALLOW_SELF_EDIT=1` for the turn). Everything else is ordinary
agent-editable surface.

A default install has no feature vertical; the worked example (`init
--with-demo`) adds the `notes` vertical, its router and its RLS rows. Where a
step differs between the two, it says what to do in each.

## 1. Migration + schema + pgTAP test

Copy the append-only migration, the declarative twin, and the isolation suite:

```sh
cp "$SLICE/supabase/migrations/20260101000200_push_tokens.sql" supabase/migrations/
cp "$SLICE/supabase/schemas/30_push_tokens.sql"                 supabase/schemas/
cp "$SLICE/supabase/tests/rls_push_tokens.test.sql"            supabase/tests/
```

Migrations are APPEND-ONLY: the file is written ONCE. If your `supabase/migrations/`
already contains a later timestamp than `20260101000200`, rename the copy to a
timestamp after your newest migration (keep the `_push_tokens` tag) — never
retroactively edit an applied migration, because `supabase db push` records it by
filename and a retroactive edit yields a database that no longer matches its own
history.

`supabase/config.toml`'s declared schema list already ends with a `./schemas/*.sql`
glob, so `30_push_tokens.sql` is picked up with no config edit; if you keep the
list explicit for ordered readability, add `"./schemas/30_push_tokens.sql"` before
that glob.

## 2. Contracts (DTO)

The push-token contracts are APPENDED to `packages/contracts/src/index.ts` — not
added as a second file. This is deliberate: `@app/contracts` is bundled by Metro
for the mobile client, and under the package's NodeNext module settings a
`./push-tokens.js` re-export is a specifier Metro cannot resolve back to a `.ts`
source. The append block needs no import of its own (`z` is already in scope):

```sh
cat "$SLICE/packages/contracts/src/push-tokens.contracts.txt" >> packages/contracts/src/index.ts
```

## 3. The vertical (`@app/push`)

Create the package and copy its source (the `.txt` suffix is stripped on copy):

```sh
mkdir -p packages/verticals/push/src/{data,domain,server}
cp "$SLICE/packages/verticals/push/src/index.ts.txt"                 packages/verticals/push/src/index.ts
cp "$SLICE/packages/verticals/push/src/data/port.ts.txt"             packages/verticals/push/src/data/port.ts
cp "$SLICE/packages/verticals/push/src/data/push-tokens.ts.txt"      packages/verticals/push/src/data/push-tokens.ts
cp "$SLICE/packages/verticals/push/src/server/push-token-id.ts.txt"  packages/verticals/push/src/server/push-token-id.ts
cp "$SLICE/packages/verticals/push/src/server/push-token-id.test.ts.txt" \
   packages/verticals/push/src/server/push-token-id.test.ts
cp "$SLICE/packages/verticals/push/src/domain/cursor.ts.txt"         packages/verticals/push/src/domain/cursor.ts
```

Add `packages/verticals/push/package.json`. It follows the worked example's
`@app/notes` manifest (in a `--with-demo` install; without the demo the block
below is the whole file all the same) with two differences: NO `./client`
subpath (push has no direct-read barrel — its writes go through the tRPC
client; step 8 records the reviewed escape the anatomy laws then need), and it
DOES list `@types/node`, because `server/push-token-id.ts` uses `node:crypto`:

```json
{
  "name": "@app/push",
  "version": "0.1.0",
  "description": "The device push-token vertical — deterministic-id domain, the Supabase DAL, and the keyset codec",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@app/contracts": "workspace:*",
    "@app/errors": "workspace:*",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

Add `packages/verticals/push/tsconfig.json`. It is the worked example's
`@app/notes` tsconfig (again, the block below is the whole file with or without
the demo) EXCEPT `"types": ["node"]` (notes pins `[]` because its `./client`
barrel is bundled into the native app; `@app/push` is never bundled there, so the
Node dependency is safe — see the README's honest limits), and it references
only `contracts` and `platform/errors` (push emits no events):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"],
  "references": [{ "path": "../../contracts" }, { "path": "../../platform/errors" }]
}
```

`pnpm-workspace.yaml`'s `packages/*/*` glob discovers the new package with no
edit; run `pnpm install` so the workspace links `@app/push`.

## 4. Router + appRouter

```sh
cp "$SLICE/packages/api/src/routers/push.ts.txt" packages/api/src/routers/push.ts
```

Wire it into `@app/api` — three small edits:

a. `packages/api/src/index.ts` — import and mount the router (the routers are FLAT
   and named after the vertical they front, so this is one line each):

   ```ts
   import { pushRouter } from './routers/push.js'
   ```

   ```ts
   export const appRouter = router({
     push: pushRouter,
     system: systemRouter,
   })
   ```

   A default install's router mounts only `system`. With the worked example it
   also mounts `notes: notesRouter`, which stays where it is, above `push`.

b. `packages/api/package.json` — add the dependencies. `zod` is for the
   router's own `PushTokenRef` schema; `@app/api` declares no `zod` of its own,
   with or without the demo, so without it the router does not compile:

   ```json
   "@app/push": "workspace:*",
   "zod": "catalog:",
   ```

c. `packages/api/tsconfig.json` — add the project reference so `tsc -b` builds it:

   ```json
   { "path": "../verticals/push" }
   ```

The router narrows `ctx.db` to the DAL's structural port with `as unknown as`,
the SAME pattern the web host uses at `apps/web/app/api/trpc/[trpc]/route.ts`;
no context change is needed.

## 5. The RLS isolation extension

The `schema-rls` gate holds three lists in sync — the declared schema, the
structural pgTAP suite's `rls_targets`, and the client suite's
`ISOLATION_TARGETS` — so `push_device_tokens` must be added to the two registry
lists or the gate reds (`not wired into ISOLATION_TARGETS`).

Append to `ISOLATION_TARGETS` in `tests/rls/db-context.ts`, after the last
entry, with or without the demo (keep the `table:`-then-`ownerColumn:` key order
the gate parses). A device token belongs to a user, not an org, so the entry is
user-scoped like `profiles`, and `authenticated` writes it directly under the
insert policy's WITH CHECK:

```ts
  {
    table: 'push_device_tokens',
    ownerColumn: 'owner_id',
    provision: 'direct',
    scopeValue: (ctx) => ctx.userId,
    row: (ctx) => ({
      owner_id: ctx.userId,
      token: 'ExponentPushToken[rls-probe]',
      platform: 'ios',
    }),
  },
```

Extend the structural pgTAP suite `supabase/tests/rls_structure.test.sql` — three
edits in one hunk: add the push row to `rls_targets`, add its existence
assertion after the last `has_table`, and bump the plan by one (the set-based
checks already iterate `rls_targets`, so only the explicit `has_table` adds a
test). The count and the rows already listed differ with and without the demo
(only the demo has a `notes` row), so bump whatever `plan(N)` your suite has to
`plan(N + 1)`, leave every existing row as it is, and add only the push row:

```sql
-- plan(N) -> plan(N + 1)
INSERT INTO rls_targets (table_name, owner_column) VALUES
  -- … every row already listed, unchanged, the last one now ending in a comma …
  ('push_device_tokens', 'owner_id');

SELECT has_table('public', 'push_device_tokens', 'public.push_device_tokens exists');
```

The exact-privilege assertions are GENERATED, not edited: after copying the migration,
run `node tools/gen-grant-assertions.mjs` (step 10's `pnpm gen` runs it too) and commit
the rewritten `supabase/tests/rls_grants.generated.test.sql`, which then asserts what anon,
authenticated and service_role hold on `push_device_tokens`. `schema-rls` reds while that
file is stale, and the slice's migration revokes the platform default from all three roles
first, which the gate requires of every table (1.1.0).

## 6. The expo-notifications seam (mobile)

See the README's seam section for the full reasoning; the mechanical steps:

```sh
cd apps/mobile && npx expo install expo-notifications && cd ../..
```

Then, in ONE diff (the `expo-policy` gate locksteps each pair bidirectionally):

- `apps/mobile/app.config.ts`: add `'expo-notifications'` to `plugins` and
  `permissions: ['android.permission.POST_NOTIFICATIONS']` to `android`.
- **(human / write-guarded)** `tools/expo-plugins.json`: add the
  `expo-notifications` entry (exact JSON in the README).
- **(human / write-guarded)** `tools/expo-permissions.json`: add the
  `android.permission.POST_NOTIFICATIONS` entry to `permissions` (exact JSON in
  the README).

The client registration function is a snippet in the README ("Registering a token
from the app") — it calls `api.push.registerToken.mutate(...)` through the tRPC
client. Wire it into your sign-in flow or a settings screen and give it a
jest-expo test alongside your screen tests.

## 7. Reviewed clone acceptance (human / write-guarded)

`packages/verticals/push/src/domain/cursor.ts` is the same (created_at, id) keyset
codec the worked example's `@app/notes` defines, duplicated because
dependency-cruiser forbids a vertical importing another (README honest limits).
With the demo installed, the duplication step names the clone after applying:

```sh
node tools/check-duplication.mjs
```

Add the reported fingerprint to `tools/duplication-allow.json` (write-guarded —
human edit), with a reason that states the constraint and the deferred fix:

```json
{
  "fingerprint": "<printed by check-duplication.mjs>",
  "reason": "push-notifications module: packages/verticals/push/src/domain/cursor.ts duplicates the notes keyset codec. Cross-vertical import is forbidden by dependency-cruiser's verticals-not-into-verticals rule; the clean de-duplication is a shared codec in packages/shared, deferred out of this slice. Irreducible until that promotion."
}
```

A default install has no notes vertical, so there is no clone and nothing to
accept: skip this step. Skip it too if your notes side has drifted from the
scaffold and `check-duplication.mjs` reports no clone. An allowance nothing
matches is dead review weight.

## 8. Reviewed single-barrel escape (human / write-guarded)

The vertical-anatomy laws (the `boundaries` gate) ask every vertical for two
barrels: `.` for the server and a Metro-safe `./client`. `@app/push` ships only
`.`, on purpose (README honest limits): the app reaches its writes through the
tRPC client, so no screen reads this vertical directly, and
`server/push-token-id.ts` imports `node:crypto`, which a native bundle cannot
carry. So after applying, with or without the demo, `boundaries` names two
`dual-barrel` findings for `@app/push` (the exports map lacks `./client`, and
`src/client.ts` is missing):

```sh
node tools/check-workspace-deps.mjs
```

Add one row to `tools/vertical-anatomy-allow.json` (write-guarded — human edit).
It leaves out `path`, so the one row covers both findings; set `reviewedOn` to
the day you review it:

```json
{
  "package": "@app/push",
  "law": "dual-barrel",
  "reason": "push-notifications module: @app/push ships only the `.` server barrel on purpose. Registering and removing a device token are writes the app reaches through the tRPC client, so no screen reads this vertical directly, and server/push-token-id.ts imports node:crypto, which a native bundle cannot carry. A ./client barrel would put a write vertical one import away from Metro with no mobile caller.",
  "reviewedOn": "<the review date, YYYY-MM-DD>"
}
```

The file is closed both ways: a row that matches no finding reds as stale, so
delete this row in the same diff that gives `@app/push` a `./client` barrel.

## 9. Provenance

The slice files carry their `SOURCE:` citations inline. Emit the ADR
(`/adr push-notifications`) so the decision record exists — the interesting
decisions to record are the deterministic-id upsert (and why not a two-column
unique index), the composite owner index, the deferred packages/shared codec
promotion, and the plugin/permission pairs — then run `/verify-citations` and
require `CITATIONS: CLEAN` before finishing.

## 10. Verify (gate)

Regenerate the derived artifacts, rebuild the database, and run the suites:

```sh
pnpm gen              # db types + the contract inventory the `contracts` gate diffs
pnpm db:reset         # rebuild local Postgres from migrations + seed
pnpm db:test          # pgTAP: rls_push_tokens + the extended rls_structure suite
pnpm validate         # the gate chain: schema-rls, migrations, contracts, expo-policy, architecture, …
pnpm test             # unit incl. the pinned id-derivation test
pnpm test:rls         # needs pnpm db:up — the client isolation matrix, now covering push_device_tokens
pnpm test:mobile      # unchanged — the slice ships no mobile code
node tools/check-workspace-deps.mjs  # the step-8 escape holds
node tools/check-duplication.mjs     # the step-7 acceptance holds (or, without the demo, no clone)
```

Expected: `pnpm db:test` reports `rls_push_tokens` green (positive control,
cross-tenant SELECT/UPDATE/DELETE empty, smuggled INSERT → SQLSTATE 42501,
absent-identity fails closed, anon denied at the table) and the structural suite
now covers `push_device_tokens`; `pnpm test:rls` reports it alongside the
tables already in the client isolation matrix; and `schema-rls` confirms the declared schema, the
structural suite, and the client matrix all name the same table set.
