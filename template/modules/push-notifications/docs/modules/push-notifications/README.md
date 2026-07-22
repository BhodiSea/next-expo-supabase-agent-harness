# Module: push-notifications

The worked vertical-slice example: a device push-token store shipped end to end
through the server — migration with FORCE row-level security, wire contracts,
DAL, routes, and the isolation-suite extension — plus the `expo-notifications`
native seam on the mobile side. The slice ships as reference files under
`docs/modules/push-notifications/slice/` with an apply checklist
(`APPLY.md`), not as silent edits to your `packages/` and `apps/` trees:
applying a database table, a native config plugin, and an Android permission
are reviewed decisions, and every one of them locksteps with a gate that must
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
| `docs/modules/push-notifications/APPLY.md` | the apply checklist — every copy step and every same-diff edit, in vertical-slice-recipe order |
| `…/slice/packages/contracts/src/push-tokens.contracts.txt` | wire DTOs (appended to the contracts index): bounded token/platform contracts, list query, keyset page |
| `…/slice/packages/schema/src/push-tokens.ts.txt` | the drizzle table + four per-operation RLS policies |
| `…/slice/packages/schema/drizzle/0003_push_device_tokens.sql` | hand-authored migration: table, ENABLE + FORCE RLS, per-op policies, composite owner index, GRANT |
| `…/slice/apps/server/src/dal/push-token-id.ts.txt` | deterministic version-5 UUID row id — the idempotence key for register() |
| `…/slice/apps/server/src/dal/push-tokens.ts.txt` | the DAL: single-statement idempotent register, keyset list, remove |
| `…/slice/apps/server/src/routes/push-tokens.ts.txt` | `@hono/zod-openapi` route contracts + handlers, registered from `app.ts` |
| `…/slice/apps/server/src/dal/push-token-id.test.ts.txt` | pins the id derivation (exact-value pin — re-keying cannot land silently) |
| `…/slice/apps/server/src/dal/push-tokens.statements.test.ts.txt` | statement-count invariance: register/list/remove are a FIXED statement count |
| `…/slice/apps/server/src/routes/push-tokens.test.ts.txt` | route wiring tests with an injected fake DAL (identity, decoding, statuses) |

`…` = `docs/modules/push-notifications`. The slice's code files carry a `.txt`
suffix ON PURPOSE: an un-applied `.ts` under docs/ would be claimed by eslint's
type-aware project service (any tracked `.ts` must belong to a tsconfig
project) and red `pnpm validate` the moment the module is enabled. `.txt` is
claimed by nothing; the APPLY copy strips it.

The RLS isolation extension is not a file of its own — it is two same-diff
edits (`tests/rls/db-context.ts` ISOLATION_TARGETS and `tests/rls/dal-shapes.ts`)
that plug the new table into the EXISTING isolation matrix and EXPLAIN plan
probe. APPLY.md carries the exact hunks.

## How enabling works

```
npx next-expo-supabase-agent-harness enable push-notifications
```

copies the files above into `docs/modules/push-notifications/`. No gate config
changes, no behavior changes — the docs tree sits outside every runner and
tsconfig reference, and the `.txt` suffix keeps the slice code invisible even
to filename-glob scanners (`pnpm validate` stays green with the module enabled
and nothing applied). When you are ready, work through `APPLY.md` (it follows
the `authoring-vertical-slice` skill's order: migration → DAL/DTO → route →
the mobile seam → tests → provenance → gate). Applying is one review-sized
diff; every verification command is listed there.

## The expo-notifications seam (mobile side)

`expo-notifications` is a config plugin: it rewrites the generated native
projects at prebuild time, which makes adding it a native-surface decision the
`expo-policy` gate refuses to let land un-reviewed. The gate locksteps the
RESOLVED config against two reviewed allowlists BIDIRECTIONALLY — an
unreviewed plugin reds, and a stale allowlist entry also reds. So both sides
of each pair below must land in the SAME diff (both `tools/*.json` files are
write-guard-protected: a human applies these two edits, or sets
`HARNESS_ALLOW_SELF_EDIT=1` for the turn).

1. Install the SDK-matched package (the `native-deps` gate runs
   `expo install --check`, so a hand-pinned wrong version cannot land):

   ```
   cd apps/mobile && npx expo install expo-notifications
   ```

2. Plugin — `apps/mobile/app.config.ts` `plugins` array gains:

   ```ts
   // SOURCE: expo-notifications config plugin (icon/color/sounds/defaultChannel
   // props exist when you want them) https://docs.expo.dev/versions/latest/sdk/notifications/
   'expo-notifications',
   ```

   and `tools/expo-plugins.json` gains, in the same diff:

   ```json
   {
     "name": "expo-notifications",
     "reason": "push-notifications module: notification handling + Expo push token registration; rewrites the generated native projects (Android notification resources, iOS notification wiring) at prebuild"
   }
   ```

3. Permission — Android 13 (API 33)+ requires the `POST_NOTIFICATIONS`
   runtime permission before an app may post notifications; the manifest must
   declare it and the app must request it at runtime.
   `apps/mobile/app.config.ts` `android` gains:

   ```ts
   // android.permissions entries are fully-qualified and are added to the
   // AndroidManifest at prebuild (https://docs.expo.dev/versions/latest/config/app/).
   // SOURCE: Android 13 notification runtime permission
   // https://developer.android.com/develop/ui/views/notifications/notification-permission
   permissions: ['android.permission.POST_NOTIFICATIONS'],
   ```

   (Comment order is deliberate: the provenance gate looks for `SOURCE:` within
   the three lines above a flagged decision site — keep the SOURCE pair
   directly above `permissions:`.)

   and `tools/expo-permissions.json` gains, in the same diff:

   ```json
   {
     "name": "android.permission.POST_NOTIFICATIONS",
     "reason": "push-notifications module: Android 13+ requires this runtime permission before the app may post notifications; declared explicitly so the grant is a reviewed config surface, not a library-manifest side effect"
   }
   ```

Then run `pnpm validate` — the `expo-policy` gate resolves the config through
the expo CLI and confirms both pairs agree. If a plugin you add ever grants a
permission you did not list, the same gate names it; add the reviewed entry or
drop the plugin.

### Registering a token from the app

The client-side worked example (wire it into your sign-in flow or a settings
screen; it is a function call, not a screen, which is why the mobile half of
this slice is a snippet rather than a shipped file):

```ts
// e.g. as apps/mobile/src/features/push/registerForPush.ts (relative imports —
// the mobile workspace uses no path alias)
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { apiPost } from '../../lib/api-client'

export async function registerForPush(): Promise<void> {
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
  const status = current.granted
    ? current
    : await Notifications.requestPermissionsAsync()
  if (!status.granted) return // the user said no — respect it, no nagging loop

  // projectId is REQUIRED; it resolves from the committed EAS project id.
  // getExpoPushTokenAsync calls Expo's servers — try/catch and retry later
  // rather than failing sign-in on a network blip.
  // SOURCE: https://docs.expo.dev/versions/latest/sdk/notifications/
  const projectId: unknown = Constants.expoConfig?.extra?.['eas']?.['projectId']
  if (typeof projectId !== 'string' || projectId === '' || projectId === 'TBD') return
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })

  await apiPost('/api/push/tokens', { platform: Platform.OS, token })
}
```

`register` is idempotent on the server (the same owner + token always lands on
the same upsert row), so calling this on every app start is safe and is the
normal pattern.
On sign-out, `DELETE /api/push/tokens/{id}` with the id the register response
returned.

## The server slice, in one paragraph

`push_device_tokens` is an owner-scoped table under ENABLE + FORCE row-level
security with four per-operation policies keyed on the transaction-local
`app.user_id` GUC — identical discipline to the shipped `notes` slice, and the
isolation matrix, the pooled-connection leak probe, and the EXPLAIN plan probe
all extend to it through two registry entries. The row id is a deterministic
version-5 UUID of (owner, token), which makes `register` a single-statement,
race-free upsert — `INSERT … ON CONFLICT (id) DO UPDATE` — with no second
unique index (see honest limits for why that shape was chosen). The list is
keyset-paginated behind an index that carries the ordering, and the routes sit
behind the same skew + auth + body-limit guards as every other `/api/*` route.

## After the slice: sending

Sending is a server-side loop you own, fed by this table:

- POST to `https://exp.host/--/api/v2/push/send` (or use `expo-server-sdk` for
  Node) — at most 100 notifications per request, 4096-byte payloads.
- Then fetch receipts from `https://exp.host/--/api/v2/push/getReceipts`. On a
  `DeviceNotRegistered` receipt you MUST stop sending to that token — delete
  its row (this is the pruning story for stale tokens; there is no other one).
- By default Expo's push API accepts unauthenticated sends for your tokens, so
  treat stored tokens as sensitive: enable "Enhanced push security" in the EAS
  dashboard and send with the access token when you harden for production.

SOURCE: https://docs.expo.dev/push-notifications/sending-notifications/

## Prerequisites and credentials (honest degrade)

- None to enable, none to apply: the whole slice runs against the local
  Postgres and the unit runners. No step here needs an EAS account.
- REMOTE pushes on a real device additionally need push credentials, held in
  your EAS project (never committed): Firebase Cloud Messaging (FCM V1)
  credentials for Android, and iOS credentials that require a PAID Apple
  developer account to generate. Expo's setup flow assumes a development build
  (EAS Build or a local build) — not the preinstalled Expo Go client. Until
  the credentials exist, local notifications and the whole token-store slice
  still work.
  SOURCE: https://docs.expo.dev/push-notifications/push-notifications-setup/

## How its gates can FAIL (anti-vacuity)

After applying, each layer is held by a gate that a one-line regression turns
red — try any of these to see the enforcement:

- Delete the `push_device_tokens` entry from ISOLATION_TARGETS →
  `schema-rls` reds (table not wired into the runtime matrix).
- Drop the `WITH CHECK` from the insert policy in a scratch database → the
  isolation suite's smuggled-INSERT probe stops raising SQLSTATE 42501 and
  fails its assertion.
- Remove the composite index migration statement → `schema-rls` reds on the
  leading-column check, and the plan probe reds with a Sort node at 25k rows.
- Add a DAL method without a `dal-shapes.ts` entry → the plan-registry closure
  test fails (an unmeasured query cannot be added by accident).
- Remove `'expo-notifications'` from the plugins array but keep the allowlist
  entry (or vice versa) → `expo-policy` reds in that direction too.
- Edit a route's response schema without regenerating → the `contracts` gate
  diffs `apps/server/openapi.json` and reds.
- Delete one of the two reviewed clone acceptances (APPLY step 7) → the
  duplication step reds naming the clone and its fingerprint.

## Honest limits

- **No unique index on (owner, token).** Idempotence is enforced through the
  deterministic primary key instead. A two-column unique constraint would work
  in production, but the harness's plan probe bulk-seeds isolation-target
  tables with constant per-column scalars (25 000 rows, 100 owners), which a
  (owner, token) uniqueness constraint rejects — so the slice uses the shape
  that keeps the table probe-compatible AND race-free, and says so here rather
  than quietly weakening the probe. Consequence to know: the same device token
  registered by two different accounts is two rows (each account's row is
  pruned by its own receipts).
- **The cursor codec is reused from the notes slice** (`dal/cursor.ts`) — the
  shape is generic over (createdAt, id) even though the names say notes.
  Renaming it to something neutral is a reasonable consumer refactor; copying
  it would just trip the duplication gate.
- **The register response returns the row (including the token you sent).**
  The token is scoped to the owner by RLS, so a user can only ever read back
  their own tokens; still, treat exports/logs of this table like credential
  material (see the sending section on unauthenticated push).
- **Tokens rot.** Nothing in the slice expires rows; pruning happens through
  push receipts once you build the sender. If you never build it, rows only
  ever accumulate for signed-in users who reinstall — bounded in practice, but
  the honest statement is: this module ships the STORE, not the lifecycle.
- **The drift test in `packages/schema/src/schema.test.ts` derives DTOs for
  the notes table only**; this slice's contracts are held by the migration
  self-check (which APPLY strengthens to cumulative SQL), the RLS matrix, and
  its own tests instead. Extending the drizzle-zod derivation comparison to
  this table is reasonable optional homework.
