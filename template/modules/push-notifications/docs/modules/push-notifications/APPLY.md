# Applying the push-notifications slice

The checklist for landing the device push-token slice, in vertical-slice order
(migration → contracts → vertical → router → the RLS extension → the mobile seam
→ provenance → gate). Everything below is ONE review-sized diff; nothing before
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

Two steps (7 and the two `tools/*.json` edits in step 6) touch
write-guard-protected review files — a human applies those edits (or sets
`HARNESS_ALLOW_SELF_EDIT=1` for the turn). Everything else is ordinary
agent-editable surface.

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
mkdir -p packages/verticals/push/src/{data,domain}
cp "$SLICE/packages/verticals/push/src/index.ts.txt"                 packages/verticals/push/src/index.ts
cp "$SLICE/packages/verticals/push/src/data/push-tokens.ts.txt"      packages/verticals/push/src/data/push-tokens.ts
cp "$SLICE/packages/verticals/push/src/domain/push-token-id.ts.txt"  packages/verticals/push/src/domain/push-token-id.ts
cp "$SLICE/packages/verticals/push/src/domain/push-token-id.test.ts.txt" \
   packages/verticals/push/src/domain/push-token-id.test.ts
cp "$SLICE/packages/verticals/push/src/domain/cursor.ts.txt"         packages/verticals/push/src/domain/cursor.ts
```

Add `packages/verticals/push/package.json`. It mirrors `@app/notes` with two
differences: NO `./client` subpath (push has no direct-read barrel — its writes
go through the tRPC client), and it DOES list `@types/node`, because
`domain/push-token-id.ts` uses `node:crypto`:

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

Add `packages/verticals/push/tsconfig.json`. Same as `@app/notes` EXCEPT
`"types": ["node"]` (notes pins `[]` because its `./client` barrel is bundled
into the native app; `@app/push` is never bundled there, so the Node dependency is
safe — see the README's honest limits), and it references only `contracts` and
`platform/errors` (push emits no events):

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
  "references": [
    { "path": "../../contracts" },
    { "path": "../../platform/errors" }
  ]
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
     notes: notesRouter,
     push: pushRouter,
     system: systemRouter,
   })
   ```

b. `packages/api/package.json` — add the dependency:

   ```json
   "@app/push": "workspace:*",
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

Append to `ISOLATION_TARGETS` in `tests/rls/db-context.ts` (keep the
`table:`-then-`ownerColumn:` key order the gate parses; the seed row is a plain
scalar a tenant may legitimately write):

```ts
  {
    table: 'push_device_tokens',
    ownerColumn: 'owner_id',
    seedRow: (ownerId) => ({
      owner_id: ownerId,
      token: 'ExponentPushToken[rls-probe]',
      platform: 'ios',
    }),
  },
```

Extend the structural pgTAP suite `supabase/tests/rls_structure.test.sql` — three
edits in one hunk: add the target row, add its existence assertion, and bump the
plan by one (the set-based checks already iterate `rls_targets`, so only the
explicit `has_table` adds a test):

```sql
-- plan(13) -> plan(14)
INSERT INTO rls_targets (table_name, owner_column) VALUES
  ('profiles', 'id'),
  ('notes', 'owner_id'),
  ('push_device_tokens', 'owner_id');

SELECT has_table('public', 'push_device_tokens', 'public.push_device_tokens exists');
```

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
codec `@app/notes` defines, duplicated because dependency-cruiser forbids a
vertical importing another (README honest limits). After applying, the
duplication step names the clone:

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

(If your notes side has drifted from the scaffold, `check-duplication.mjs` may
report no clone at all — in which case skip the entry: an allowance nothing
matches is dead review weight.)

## 8. Provenance

The slice files carry their `SOURCE:` citations inline. Emit the ADR
(`/adr push-notifications`) so the decision record exists — the interesting
decisions to record are the deterministic-id upsert (and why not a two-column
unique index), the composite owner index, the deferred packages/shared codec
promotion, and the plugin/permission pairs — then run `/verify-citations` and
require `CITATIONS: CLEAN` before finishing.

## 9. Verify (gate)

Regenerate the derived artifacts, rebuild the database, and run the suites:

```sh
pnpm gen              # db types + the contract inventory the `contracts` gate diffs
pnpm db:reset         # rebuild local Postgres from migrations + seed
pnpm db:test          # pgTAP: rls_push_tokens + the extended rls_structure suite
pnpm validate         # the gate chain: schema-rls, migrations, contracts, expo-policy, architecture, …
pnpm test             # unit incl. the pinned id-derivation test
pnpm test:rls         # needs pnpm db:up — the client isolation matrix, now covering push_device_tokens
pnpm test:mobile      # unchanged — the slice ships no mobile code
node tools/check-duplication.mjs   # the step-7 acceptance holds
```

Expected: `pnpm db:test` reports `rls_push_tokens` green (positive control,
cross-tenant SELECT/UPDATE/DELETE empty, smuggled INSERT → SQLSTATE 42501,
absent-identity fails closed, anon denied at the table) and the structural suite
now covers `push_device_tokens`; `pnpm test:rls` reports it alongside `notes` in
the client isolation matrix; and `schema-rls` confirms the declared schema, the
structural suite, and the client matrix all name the same table set.
