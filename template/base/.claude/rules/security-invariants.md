# Security invariants (always loaded; also hook- and lint-enforced)

These are non-negotiable. They are enforced deterministically by the
PreToolUse/Stop hooks, ESLint/depcruise, and the gate scripts; write code that
already satisfies them so the gates never fire.
SOURCE: docs/harness/README.md (security-invariants rule)

- **`withUserContext(userId, fn)` is THE authorization boundary.** Every
  `apps/server/src/dal/*` module acquires the database through it (transaction +
  `SET LOCAL app.user_id`, over FORCE RLS) and returns Zod-parsed DTOs, never raw
  driver rows. Routes never import the db driver. **The mobile client, its
  keychain, and the app config are NOT authorization** — the app is an untrusted
  bearer of a scoped token; authorize in the DAL, on FORCE RLS.
- **GUC discipline.** RLS identity is `set_config('app.user_id', $uuid, true)` /
  `SET LOCAL` inside a transaction. Never `set_config(..., false)`, `SET SESSION
  app.*`, or bare `SET app.*` — a session GUC leaks the previous user's identity
  across pooled connections.
- **Migrations are append-only.** Never edit or delete a committed file under
  `packages/schema/drizzle/` — add a new migration (`drizzle-kit generate`).
  `drizzle-kit push` and `drizzle-kit drop` are blocked. Destructive DDL requires
  `-- adr: docs/adr/<file>`; DML requires `-- harness-allow-dml: <reason>`.
- **`MIGRATOR_DATABASE_URL` is the RLS-bypassing role** (schema owner). Only
  drizzle-kit migrate/generate/check and the harness RLS runners
  (`tests/migrations/`, `tests/rls/` — plan-probe seeding + ANALYZE) may use
  it — never app, test-assertion, or script code.
- **Every table ships `ENABLE` + `FORCE ROW LEVEL SECURITY`**, four
  per-operation policies scoped to
  `(select current_setting('app.user_id', true)::uuid)` (initPlan pattern), and
  a leading-column index on the owner column (every policy filters by it on
  every statement), in the same migration that creates it. Exemptions live only
  in the human-reviewed `tools/rls-exempt.json`.
- **Mobile-bundle purity.** `apps/mobile` never imports `postgres`,
  `drizzle-orm`, `pg`, `@hono/*`, `pino`, `@app/schema`, or anything in
  `apps/server`; it talks to the API via typed contracts from `@app/contracts` —
  resolving `@app/schema` from the mobile tree drags the ORM into the shipped
  bundle.
- **The api-client is the one door to the API.** Every request goes through
  `src/lib/api-client.ts` (`apiFetch`/`apiPost` — origin, bearer token, and
  error-envelope decoding live there and nowhere else). Never call `fetch()`
  directly from a feature: an unauthenticated request 401s against the real
  server, and every unit test mocks the network, so nothing local would tell you.
- **SecureStore is the one door to credentials.** Tokens live in the platform
  keychain behind `src/host/**` only — `expo-secure-store` is imported nowhere
  else, and a credential never lands in kv/sqlite/AsyncStorage, module state that
  outlives the session, or a log line.
- **CNG purity.** `apps/mobile/android/**` and `apps/mobile/ios/**` are GENERATED
  dirs — never committed, never hand-edited (write-guard-denied). Native surface
  changes go through `app.config.ts` + config plugins allowlisted with a reason in
  `tools/expo-plugins.json`; new permissions register in
  `tools/expo-permissions.json` (both human-reviewed). `expo prebuild` runs only
  in the device CI lane.
- **Identity is locked.** `ios.bundleIdentifier` / `android.package` (and the
  slug + URL scheme) match `tools/identity.lock.json` — store identity is upgrade
  identity and never changes.
- **Transport is pinned.** No `NSAllowsArbitraryLoads`; ATS exception domains
  are loopback-only (`localhost` / `127.0.0.1`); `usesCleartextTraffic` is
  banned everywhere in the resolved config (including an `expo-build-properties`
  plugin entry); `extra.apiOrigin` is https-or-loopback. The `expo-policy` gate
  (`tools/check-expo-policy.mjs`) asserts all four over the RESOLVED config, so
  a plugin cannot smuggle a cleartext opt-in past a clean `app.config.ts`.
- **OTA update trust.** `runtimeVersion` stays exactly
  `{ "policy": "appVersion" }` — the deterministic, PR-reviewable OTA
  compatibility boundary — and `updates.url` (when present) embeds the locked
  EAS projectId: an update URL pointing at another project is a hijacked OTA
  channel.
- **Never put a secret behind an `EXPO_PUBLIC_` name** (`EXPO_PUBLIC_*KEY|SECRET|
  TOKEN|PASSWORD|PRIVATE`) — EXPO_PUBLIC_ vars are inlined into the shipped
  client bundle.
- **Never render raw HTML from data** — no HTML-string rendering, no WebView
  `source={{ html }}` or script injection from untrusted content
  (`dangerouslySetInnerHTML` is write-guard-banned repo-wide); render text
  through the approved components.
- **`WITH RECURSIVE` requires a `CYCLE` clause or visited guard** — recursive
  queries over graph data loop forever otherwise.
- **Signing and store-credential material never touches the repo or shell.**
  Keystores (`*.keystore`, `*.jks`), Apple keys/identities (`*.p8`, `*.p12`),
  `google-services.json` / `GoogleService-Info.plist`, and `EXPO_TOKEN` live only
  in the EAS/CI secret store — never read, generated, or echoed locally
  (`eas credentials` is a human-only console surface).
- **No `rm -rf`, no force-push, no `git reset --hard`, no `git commit
  --no-verify`, no reading `.env*` / `.dev-auth/`**, no `pnpm update`
  (Renovate owns dependency bumps), no `knip --fix`, no destructive raw SQL
  outside a reviewed migration, no `git add` of the generated native dirs.
