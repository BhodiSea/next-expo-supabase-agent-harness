# Module: push-notifications

The worked vertical-slice example on the live stack: a device push-token store
shipped end to end over the ONE shared Supabase backend — an append-only
migration with FORCE row-level security, the wire contracts, the `@app/push`
vertical (DAL + domain), the tRPC `push` router, and a pgTAP isolation suite —
plus the `expo-notifications` native seam on the mobile side. The slice ships as
reference files under `docs/modules/push-notifications/slice/` with an apply
checklist (`APPLY.md`), not as silent edits to your `packages/`, `apps/` and
`supabase/` trees: applying a database table, a config plugin, and an Android
permission are reviewed decisions, and each one locksteps with a gate that must
be satisfied in the same diff. Enabling the module changes nothing until you
apply it.

What is deliberately NOT here: a sending pipeline. Storing tokens is repo code;
sending pushes needs store credentials (Firebase Cloud Messaging for Android,
Apple Push Notification service keys for iOS) and an operational decision about
who calls Expo's push API and when. See "After the slice: sending" below.

## What it adds

| File | Purpose |
| --- | --- |
| `docs/modules/push-notifications/README.md` | this document |
| `docs/modules/push-notifications/APPLY.md` | the apply checklist — every copy step and every same-diff edit, in vertical-slice order |
| `…/slice/supabase/migrations/20260101000200_push_tokens.sql` | the append-only migration: table, ENABLE + FORCE RLS, four per-op policies on `(select auth.uid())`, the leading `(owner_id, …)` index, REVOKE anon/service_role, GRANT authenticated |
| `…/slice/supabase/schemas/30_push_tokens.sql` | the declarative desired-state twin the diff engine reconciles against |
| `…/slice/supabase/tests/rls_push_tokens.test.sql` | pgTAP isolation: tenant B cannot see tenant A's tokens; smuggled INSERT → SQLSTATE 42501; account-sweep DELETE |
| `…/slice/packages/contracts/src/push-tokens.contracts.txt` | wire DTOs (appended to the contracts index): bounded token/platform contracts, list query, keyset page |
| `…/slice/packages/verticals/push/src/domain/push-token-id.ts.txt` | deterministic version-5 UUID row id — the idempotence key for `registerToken()` |
| `…/slice/packages/verticals/push/src/domain/push-token-id.test.ts.txt` | pins the id derivation (exact-value pin — re-keying cannot land silently) |
| `…/slice/packages/verticals/push/src/domain/cursor.ts.txt` | the (created_at, id) keyset codec for the list page |
| `…/slice/packages/verticals/push/src/data/push-tokens.ts.txt` | the DAL: idempotent upsert register, keyset list, remove — DTOs wrapped in `ActionOutcome`, never a raw row, never a thrown domain failure |
| `…/slice/packages/verticals/push/src/index.ts.txt` | the `@app/push` barrel |
| `…/slice/packages/api/src/routers/push.ts.txt` | the tRPC `push` router: `registerToken` / `listTokens` / `removeToken`, each delegating to the vertical |

`…` = `docs/modules/push-notifications`. The slice's TypeScript files carry a
`.txt` suffix ON PURPOSE: an un-applied `.ts` under `docs/` would be claimed by
the type-aware lint project (any tracked `.ts` must belong to a tsconfig
project) and red `pnpm validate` the moment the module is enabled. `.txt` is
claimed by nothing; the APPLY copy strips it. The `.sql` files need no suffix —
nothing runs `supabase/` files that live under `docs/`.

The RLS isolation extension is not a file of its own — it is two same-diff edits
(`ISOLATION_TARGETS` in `tests/rls/db-context.ts` and the `rls_targets` list in
`supabase/tests/rls_structure.test.sql`) that plug the new table into the
EXISTING client isolation matrix and the structural pgTAP suite. The `schema-rls`
gate holds all three lists — the declared schema, the structural suite, and the
client matrix — naming the SAME table set on the SAME owner columns, so a table
wired into one but not the others reds. APPLY.md carries the exact hunks.

## How enabling works

```
npx next-expo-supabase-agent-harness enable push-notifications
```

copies the files above into `docs/modules/push-notifications/`. No gate config
changes, no behavior changes — the docs tree sits outside every runner and
tsconfig reference, and the `.txt` suffix keeps the slice code invisible even to
filename-glob scanners (`pnpm validate` stays green with the module enabled and
nothing applied). When you are ready, work through `APPLY.md`
(migration → contracts/DAL → router → the mobile seam → the RLS extension →
provenance → gate). Applying is one review-sized diff; every verification
command is listed there.

## The server slice, in one paragraph

`push_device_tokens` is an owner-scoped table under ENABLE + FORCE row-level
security with four per-operation policies keyed on `(select auth.uid())` — the
same discipline as the seeded `notes` table, and the client isolation matrix,
the structural pgTAP suite, and the pgTAP isolation suite all extend to it
through the two registry edits above. The row id is a deterministic version-5
UUID of (owner, token), which makes `registerToken` a race-free idempotent
upsert — `INSERT … ON CONFLICT (id) DO UPDATE`, one statement, no
read-before-write — with no second unique index (see honest limits for why that
shape). `owner_id` is set from the VERIFIED actor on the tRPC context, never the
wire; the INSERT policy's `WITH CHECK` re-checks it against `auth.uid()`, and the
BEFORE UPDATE trigger bumps `updated_at` on the conflict path. The DAL returns
zod DTOs wrapped in `ActionOutcome` (a domain failure rides the data channel; it
is never thrown), and the `push` router's three `authedProcedure` procedures
each name an input schema and hand the call to the vertical.

## The expo-notifications seam (mobile side)

`expo-notifications` is a config plugin: it rewrites the generated native
projects at prebuild time, which makes adding it a native-surface decision the
`expo-policy` gate refuses to let land un-reviewed. The gate locksteps the
RESOLVED config against two reviewed allowlists BIDIRECTIONALLY — an unreviewed
plugin reds, and a stale allowlist entry also reds. So both sides of each pair
below must land in the SAME diff (both `tools/*.json` files are
write-guard-protected: a human applies these edits, or sets
`HARNESS_ALLOW_SELF_EDIT=1` for the turn).

1. Install the SDK-matched package (the `native-deps` gate runs
   `expo install --check`, so a hand-pinned wrong version cannot land):

   ```
   cd apps/mobile && npx expo install expo-notifications
   ```

2. Plugin — `apps/mobile/app.config.ts` `plugins` array gains
   `'expo-notifications'`, and `tools/expo-plugins.json` gains, in the same diff:

   ```json
   {
     "name": "expo-notifications",
     "reason": "push-notifications module: notification handling + Expo push token registration; rewrites the generated native projects (Android notification resources, iOS notification wiring) at prebuild"
   }
   ```

3. Permission — Android 13 (API 33)+ requires the `POST_NOTIFICATIONS` runtime
   permission before an app may post notifications. `apps/mobile/app.config.ts`
   `android` gains `permissions: ['android.permission.POST_NOTIFICATIONS']`, and
   `tools/expo-permissions.json` gains, in the same diff:

   ```json
   {
     "name": "android.permission.POST_NOTIFICATIONS",
     "reason": "push-notifications module: Android 13+ requires this runtime permission before the app may post notifications; declared explicitly so the grant is a reviewed config surface, not a library-manifest side effect"
   }
   ```

Then run `pnpm validate` — the `expo-policy` gate resolves the config through the
expo CLI and confirms both pairs agree. If a plugin you add ever grants a
permission you did not list, the same gate names it; add the reviewed entry or
drop the plugin.

### Registering a token from the app

The client-side worked example goes through the tRPC client (`push.registerToken`
is an `authedProcedure` mutation), wired into your sign-in flow or a settings
screen — it is a function call, not a screen, which is why the mobile half of
this slice is a snippet rather than a shipped file:

```ts
// e.g. as apps/mobile/src/features/push/registerForPush.ts (relative imports —
// the mobile workspace uses no path alias). `api` is the typed tRPC client from
// useApi() (apps/mobile/src/lib/trpc/use-api.ts); pass it in from a hook.
import type { ApiClient } from '../../lib/trpc/use-api'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

export async function registerForPush(api: ApiClient): Promise<void> {
  // Device platforms only: the wire contract's platform enum is android|ios,
  // and web builds have no push token to register.
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return
  // Channel BEFORE permission: the order Expo's setup guide uses — the default
  // channel must exist for notifications to display predictably on Android 8+.
  // SOURCE: https://docs.expo.dev/push-notifications/push-notifications-setup/
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    })
  }
  const current = await Notifications.getPermissionsAsync()
  const status = current.granted ? current : await Notifications.requestPermissionsAsync()
  if (!status.granted) return // the user said no — respect it, no nagging loop

  // projectId is REQUIRED; it resolves from the committed EAS project id.
  // getExpoPushTokenAsync calls Expo's servers — try/catch and retry later
  // rather than failing sign-in on a network blip.
  // SOURCE: https://docs.expo.dev/versions/latest/sdk/notifications/
  const projectId: unknown = Constants.expoConfig?.extra?.['eas']?.['projectId']
  if (typeof projectId !== 'string' || projectId === '' || projectId === 'TBD') return
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })

  // The DATA channel carries the outcome: a domain failure comes back as
  // `{ ok: false, error }`, never a throw — switch on it, do not try/catch it.
  const outcome = await api.push.registerToken.mutate({ platform: Platform.OS, token })
  if (!outcome.ok) return // log via your observability seam; retry on next app start
}
```

`registerToken` is idempotent on the server (the same owner + token always lands
on the same upsert row), so calling this on every app start is safe and is the
normal pattern. On sign-out, `api.push.removeToken.mutate({ id })` with the id
the register outcome returned.

## After the slice: sending

Sending is a server-side loop you own, fed by this table:

- POST to `https://exp.host/--/api/v2/push/send` (or use `expo-server-sdk` for
  Node) — at most 100 notifications per request, 4096-byte payloads.
- Then fetch receipts from `https://exp.host/--/api/v2/push/getReceipts`. On a
  `DeviceNotRegistered` receipt you MUST stop sending to that token — delete its
  row (this is the pruning story for stale tokens; there is no other one).
- By default Expo's push API accepts unauthenticated sends for your tokens, so
  treat stored tokens as sensitive: enable "Enhanced push security" in the EAS
  dashboard and send with the access token when you harden for production.

The row is owner-scoped by RLS, so a sender that reads the table must run with an
elevated credential and is therefore an ADR-governed decision — a service_role
Edge Function granted the table in its own migration, or a batch job holding the
key. The slice ships neither: it grants `push_device_tokens` to `authenticated`
only, and revokes `service_role`, so building the sender starts with the review
that grant deserves.
SOURCE: https://docs.expo.dev/push-notifications/sending-notifications/

## Prerequisites and credentials (honest degrade)

- None to enable, none to apply: the whole slice runs against the local Supabase
  stack (`pnpm db:up`) and the unit runners. No step here needs an EAS account.
- REMOTE pushes on a real device additionally need push credentials, held in your
  EAS project (never committed): Firebase Cloud Messaging (FCM V1) credentials
  for Android, and iOS credentials that require a PAID Apple developer account.
  Expo's setup flow assumes a development build — not the preinstalled Expo Go
  client. Until the credentials exist, local notifications and the whole
  token-store slice still work.
  SOURCE: https://docs.expo.dev/push-notifications/push-notifications-setup/

## How its gates can FAIL (anti-vacuity)

After applying, each layer is held by a gate that a one-line regression turns
red — try any of these to see the enforcement:

- Delete the `push_device_tokens` row from `rls_targets` in
  `rls_structure.test.sql` (or from `ISOLATION_TARGETS`) → `schema-rls` reds,
  because the three lists it holds in sync no longer name the same table set.
- Drop the `WITH CHECK` from the insert policy in a scratch database → the pgTAP
  isolation suite's smuggled-INSERT probe stops raising SQLSTATE 42501 and fails
  `throws_ok`.
- Downgrade a policy predicate to `USING (true)`, or grant a policy to `public` →
  the structural suite (`rls_structure.test.sql`) reds on the vacuous-predicate
  and no-public-grant checks, now iterating over `push_device_tokens` too.
- Replace the composite index with a bare `(owner_id)` one → `schema-rls` reds on
  the leading-column check only if you drop owner_id from the lead; a trailing
  reorder still serves `owner_id = $1` but loses the keyset order (measured by the
  list path, not a static gate — see honest limits).
- `import` anything from `@app/notes` inside `@app/push` → the `architecture`
  gate (dependency-cruiser `verticals-not-into-verticals`) reds.
- Change a router response shape without `pnpm gen` → the `contracts` gate diffs
  the regenerated contract inventory and reds.
- Add `'expo-notifications'` to `plugins` but not to `tools/expo-plugins.json`
  (or vice versa) → `expo-policy` reds in that direction too.

## Honest limits

- **No unique index on (owner, token).** Idempotence is enforced through the
  deterministic primary key instead — a version-5 UUID of (owner, token) computed
  by `domain/push-token-id.ts`, so the upsert's ON CONFLICT (id) arbiter is the
  primary key. A two-column unique constraint would also work in production;
  the deterministic key keeps `registerToken` a single race-free statement with
  no read-before-write, and the honest consequence is: the same device token
  registered by two different accounts is two rows (each pruned by its own
  receipts).
- **The keyset cursor codec is duplicated, not shared.** `domain/cursor.ts` is
  the same (created_at, id) codec the notes vertical defines. It is copied rather
  than imported because dependency-cruiser's `verticals-not-into-verticals` rule
  forbids a vertical reaching into another. The clean de-duplication is to lift a
  shared keyset codec into `packages/shared` (importable by every vertical, per
  the same rule) and point both verticals at it — a reasonable follow-up
  deliberately kept OUT of this slice, whose job is the token store, not a
  cross-vertical refactor. Until then the copy is a reviewed clone (APPLY step 8).
- **The push vertical compiles with `types: ["node"]`, unlike notes.**
  `domain/push-token-id.ts` uses `node:crypto`. That is safe because `@app/push`
  ships NO `./client` barrel — its writes go through the tRPC client, so nothing
  in it is ever bundled into the native app (where Node built-ins do not exist).
  The absence of a `./client` export is what makes the Node dependency honest; add
  one and the id helper must move behind the server barrier first.
- **`registerToken` returns the row, including the token you sent.** The token is
  scoped to the owner by RLS, so a user can only ever read back their own tokens;
  still, treat exports/logs of this table like credential material (see the
  sending section on unauthenticated push).
- **Keyset pagination is over-provisioned for a device fleet.** A user has a
  handful of devices, so the list will almost never spill past its default page —
  the keyset shape is carried anyway so the slice demonstrates the same
  index-serves-the-ordering discipline the notes list needs, and so a future
  fan-out (per-device metadata, shared-family accounts) does not have to retrofit
  pagination onto a live contract.
- **Tokens rot.** Nothing in the slice expires rows; pruning happens through push
  receipts once you build the sender. This module ships the STORE, not the
  lifecycle.
