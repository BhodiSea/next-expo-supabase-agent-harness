# Security invariants (always loaded; also hook- and lint-enforced)

These are non-negotiable. They are enforced deterministically by the
PreToolUse/Stop hooks, ESLint/depcruise, the SQL RLS suite under
`supabase/tests/**`, and the gate scripts; write code that already satisfies
them so the gates never fire.
SOURCE: docs/harness/README.md (security-invariants rule)

- **RLS keyed on `auth.uid()` is THE authorization boundary.** Both surfaces
  reach the same database through the same policies, so an authorization mistake
  is a mistake in ONE place. Every table ships `ENABLE` + `FORCE ROW LEVEL
  SECURITY`, four per-operation policies `TO authenticated` (never `FOR ALL`,
  never `TO public`) each with a REAL predicate keyed on `(SELECT auth.uid())`
  (the scalar sub-select the planner hoists into an InitPlan — once per statement,
  not once per row), and a leading-column index on the owner column, in the SAME
  migration that creates the table. The caller runs as the `authenticated` role
  via a verified GoTrue JWT (`auth.uid()` resolves from `request.jwt.claims`); a
  forged or expired token matches no rows. **The mobile client, `LargeSecureStore`,
  and the app config are NOT authorization** — the app is an untrusted bearer of a
  scoped token; authorize in RLS. Exemptions live only in the human-reviewed
  `tools/rls-exempt.json`.
- **`FORCE`, because `ENABLE` alone leaves the table owner uncovered.** `FORCE ROW
  LEVEL SECURITY` subjects the `postgres` role that runs migrations, seeds, and
  SQL-editor sessions to the policies too. It does NOT close the BYPASSRLS hole —
  see the service-role bullet, which is why grants exist.
- **`service_role` BYPASSES RLS and has exactly one sanctioned home.** No policy
  in the repo constrains it and the RLS suite cannot cover it. It is reachable
  ONLY inside an ADR-governed Edge Function (`supabase/functions/<name>/index.ts`)
  via `createServiceRoleClient_BYPASSES_RLS(warrant)` — never a Server Action,
  never a tRPC procedure, never a script, never a screen. Migrations `REVOKE ALL`
  from `service_role` on every table, so a function holding the key reaches
  NOTHING until a later, ADR'd migration `GRANT`s it explicitly, per table, per
  operation. The factory is on the `.` barrel only, never `./client`, so Metro's
  no-tree-shaking rule keeps it structurally unreachable from the mobile bundle.
- **Server-side verification is `getUser()` / `getClaims()`, NEVER `getSession()`.**
  `getSession()` decodes whatever JWT it finds in the cookie and returns it
  WITHOUT verifying the signature — on a server the cookie is attacker-controlled
  input, so trusting it lets anyone claim any `sub`. `getUser()` authenticates
  against the auth server; `getClaims()` verifies locally against the project's
  published asymmetric key. Both are verifications; `getSession()` is not, and it
  is one autocomplete away (`apps/web/lib/supabase/server.ts`).
- **The request-scoped Supabase client is built PER REQUEST, never module-scope.**
  A client hoisted to a module constant is shared by every concurrent request the
  process serves, so one user's auth state renders under another's — the
  server-rendering equivalent of a pooled connection leaking a transaction-local
  identity. `createRequestScopedClient()` builds it from Next's request-scoped
  `cookies()` inside the call. The mobile provider is the mirror rule on the
  client: `useState(factory)`, never a module-scope client.
- **`proxy.ts` is NOT an authorization boundary.** Next middleware runs BEFORE
  routing and was bypassable in the wild (CVE-2025-29927), so an app whose only
  gate is a middleware redirect served protected pages to anonymous callers.
  `apps/web/proxy.ts` does exactly one job — rotate the Supabase auth cookie on
  the way past (via `getClaims()`, discarding the result) — and it excludes
  `api/trpc` and `.well-known` from its matcher for correctness, not cosmetics.
  The boundary is RLS plus the data layer, and it holds whether or not the proxy
  runs.
- **Every org-scoped table is audited, and the trail is append-only.** A new table
  ships an `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION
  audit.write_row('<tenant column>', '<identity column>')` trigger in the SAME
  migration that creates it — **never with a `WHEN` clause**, because a conditional
  audit trigger is a trail with a blind spot whose condition is written by the person
  the trail exists to record. The trail lives in the `audit` schema, which is absent
  from `[api].schemas` and grants USAGE to no client role: PostgREST exposes every
  table in an exposed schema, and RLS on a partitioned parent does NOT cascade to its
  partitions, so a `public.audit_events` partitioned by month is readable at
  `GET /rest/v1/audit_events_YYYY_MM` by any valid JWT. Rows are never updated or
  deleted — removal is a partition DROP. The trail records WHICH columns changed, not
  what they became; capturing a value is a reviewed entry in `tools/audit-columns.json`
  and is refused for anything in `tools/pii-columns.json`, because an audit table that
  copies values is a second, less-policied home for the data it audits.
- **A pooled session is not yours.** Supavisor runs transaction mode: the backend
  serving this request served another tenant's a moment ago and will serve a third
  next, so anything set at SESSION scope is inherited by strangers. `SET
  statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout`
  without `LOCAL` leaves your ceiling on their request — the per-role ceilings live
  in `tools/db-limits.json` and the resource-limits migration, and a one-off needs
  `SET LOCAL` inside the transaction. `pg_advisory_lock` is session-scoped, so an
  error path leaks a lock that blocks every later caller of that key and no pool
  release clears it — use `pg_advisory_xact_lock`. Every `postgres(...)`
  construction passes `prepare: false`, because a named prepared statement lives on
  one backend and the next request gets another, yielding an intermittent 26000 that
  no local test against a direct connection reproduces. All three are write-guard
  denied (`pg-session-timeout-set`, `pg-advisory-session-lock`,
  `pg-prepared-statement`) and closed tree-wide by `tools/check-db-limits.mjs`.
- **Migrations are append-only.** Never edit or delete a committed file under
  `supabase/migrations/` — `supabase db push` records a migration by FILENAME, so
  a retroactive edit yields a database that no file in the repo describes and no
  diff can see. Change the schema by editing `supabase/schemas/*.sql`
  (declarative), then `supabase db diff -f <slice>`, READ the draft, and commit
  the schema file and the new timestamped migration together. Migrations are
  DML-FREE (fixtures live in `supabase/seed.sql`); destructive DDL requires an
  `-- adr: docs/adr/<file>` marker. The `migrations` and `schema-rls` gates enforce
  both.
- **Mobile-bundle purity.** `apps/mobile` consumes `@app/api` `import type` only
  (a devDependency), and Supabase through `@app/supabase/client` and a vertical's
  `./client` — NEVER the `.` barrel, which carries the service-role factory and
  the cookie-bound server factories. Metro does not tree-shake, so a value import
  of the server graph, or a `.`-barrel import, is a shipped one. Backend access is
  the tRPC client (`apps/mobile/src/lib/trpc/client.ts`, Class-B default) or a
  vertical's direct RLS reads (`./client`, Class-A opt-in).
- **`LargeSecureStore` is the one door to the session.** The Supabase session
  lives in `apps/mobile/src/host/large-secure-store.ts` — a fresh
  AES-256-CTR key per value in `expo-secure-store` (the platform keychain), the
  ciphertext in AsyncStorage. `expo-secure-store` is imported nowhere else, and a
  credential never lands in plain AsyncStorage/kv/sqlite, module state that
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
- **Transport is pinned.** No `NSAllowsArbitraryLoads`; ATS exception domains are
  loopback-only (`localhost` / `127.0.0.1`); `usesCleartextTraffic` is banned
  everywhere in the resolved config (including an `expo-build-properties` plugin
  entry); `extra.apiOrigin` (now the web app's origin) is https-or-loopback. The
  `expo-policy` gate (`tools/check-expo-policy.mjs`) asserts all four over the
  RESOLVED config, so a plugin cannot smuggle a cleartext opt-in past a clean
  `app.config.ts`.
- **OTA update trust.** `runtimeVersion` stays exactly
  `{ "policy": "appVersion" }` — the deterministic, PR-reviewable OTA
  compatibility boundary — and `updates.url` (when present) embeds the locked
  EAS projectId: an update URL pointing at another project is a hijacked OTA
  channel.
- **Never put a secret behind an `EXPO_PUBLIC_` OR a `NEXT_PUBLIC_` name**
  (`*KEY|SECRET|TOKEN|PASSWORD|PRIVATE`) — both prefixes are inlined into their
  shipped client bundle (mobile and web respectively). The anon / publishable key
  is public BY DESIGN (RLS is the access boundary and the key only authenticates
  the request to the gateway), so it belongs in this channel; the service-role /
  secret key NEVER does, and the gates judge by NAME shape, not value, because a
  name-shape rule with an exception is not a rule.
- **Never render raw HTML from data** — no HTML-string rendering, no WebView
  `source={{ html }}` or script injection from untrusted content
  (`dangerouslySetInnerHTML` is write-guard-banned repo-wide); render text
  through the approved components.
- **`WITH RECURSIVE` requires a `CYCLE` clause or visited guard** — recursive
  queries over graph data loop forever otherwise.
- **Signing, store, and elevated credentials never touch the repo or shell.**
  Keystores (`*.keystore`, `*.jks`), Apple keys/identities (`*.p8`, `*.p12`),
  `google-services.json` / `GoogleService-Info.plist`, `EXPO_TOKEN`, and
  `SUPABASE_SERVICE_ROLE_KEY` live only in the EAS/CI/Supabase secret store —
  never read, generated, or echoed locally (`eas credentials` is a human-only
  console surface).
- **No `rm -rf`, no force-push, no `git reset --hard`, no `git commit
  --no-verify`, no reading `.env*` / `.dev-auth/`**, no `pnpm update` (Renovate
  owns dependency bumps), no `knip --fix`, no destructive raw SQL outside a
  reviewed migration, no editing an already-applied `supabase/migrations/*` file,
  no `git add` of the generated native dirs.
