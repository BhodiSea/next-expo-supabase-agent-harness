---
paths:
  - "apps/mobile/**"
  - "apps/web/**"
  - "packages/api/**"
---

# Mobile / server split (best-effort scoped; never rely on conditional loading for invariants)

`paths:` scoping is best-effort — the hard invariants live in
security-invariants.md (always loaded) plus the write guard, ESLint, and
depcruise. SOURCE: docs/harness/README.md (mobile-server split)

The trust boundary: **the mobile app is an untrusted client**. The only
authoritative layers are Postgres RLS (every table `FORCE`s row-level security)
and the server-only data layer served by `apps/web` — the tRPC router in
`packages/api` mounted at `apps/web/app/api/trpc/[trpc]/route.ts`, and the
Server Actions under `apps/web/app/actions/*`.

- **The client never authorizes.** The app config, `LargeSecureStore`, and device
  state are containment for the client process — not authorization for data.
  Never gate data access on client state: every authorization decision is a
  Supabase RLS policy keyed on `auth.uid()` (four per-operation policies, `TO
  authenticated`) plus the server-only data layer. A forged or expired token is
  not rejected by the app — it simply matches no rows.
- **The client never imports a server-graph or service-role module into the
  bundle.** Metro does not tree-shake, so an import that is unreachable in
  practice still ships. `@app/api` is a DEVDEPENDENCY consumed `import type` only
  (`apps/mobile/src/lib/trpc/client.ts`) — a value import drags the whole router
  graph, including the service-role client, into the native binary. Mobile takes
  Supabase through `@app/supabase/client` and a vertical's `./client` barrel,
  NEVER the `.` barrel (which carries the service-role factory and the
  cookie-bound server factories).
- **Data flows through one of two transports, and Class-B is the default.**
  Class-B (the default): mobile writes and reads go through the tRPC client
  (`apps/mobile/src/lib/trpc/client.ts`), a single door that resolves the web
  origin from `extra.apiOrigin`, attaches the bearer token PER REQUEST inside
  `headers()` (so a refreshed access token is picked up with no wiring), and
  sends `x-client-version` on every call. Class-A is an explicit, reasoned
  opt-in — a security-census decision — where the phone reads DIRECT from
  Supabase through the vertical's `./client` (TanStack Query over an RLS-scoped
  client). A feature never calls `fetch()` directly.
- **The Supabase session lives in `LargeSecureStore`, never JS-visible storage.**
  `apps/mobile/src/lib/supabase/large-secure-store.ts` is a split store: a fresh
  AES-256-CTR key per value in `expo-secure-store` (the iOS Keychain / Android
  Keystore), the ciphertext in AsyncStorage. `expo-secure-store` is imported
  nowhere else, and a credential never lands in plain AsyncStorage/kv/sqlite,
  module state that outlives the session, or a log line — nor behind a
  `NEXT_PUBLIC_`/`EXPO_PUBLIC_` name (those are inlined into a shipped bundle).
- **The server-only data layer is the only db surface on the web side.** A Server
  Component reads via `apps/web/lib/app-data/*`; a write goes through a Server
  Action in `apps/web/app/actions/*`. Both resolve identity from a VERIFIED user
  (`getVerifiedUser()` → `getUser()`, never `getSession()`) on a per-request
  client (`apps/web/lib/supabase/server.ts`), never from the wire. Each web
  operation shares its EXACT implementation with the matching tRPC procedure in
  `packages/api` — one operation, two transports. The moment a rule lives in only
  one of them the two surfaces have quietly become two products.
- **Version-skew contract.** The app sends `x-client-version` (derived in
  `app.config.ts` from the binary's own version). The skew guard rides the BASE
  of the tRPC procedure ladder (`packages/api/src/trpc.ts`), so with a single
  mount point there is no route table to walk and every procedure inherits it by
  construction. It answers `CONFLICT` with the machine code `version_skew` on a
  MAJOR mismatch or a build below the minimum-supported-client floor — both mean
  "please update". Requests WITHOUT the header pass (curl, health tooling), and a
  skewed client hitting any procedure learns it is skewed immediately. Mobile
  fleets lag releases by store review + staged rollout + users who never update:
  design API changes to tolerate an N-1 client.
