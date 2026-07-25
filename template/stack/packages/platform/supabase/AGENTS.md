# packages/platform/supabase — `@app/supabase`

Owns Supabase client construction, the typed `Database` generic, and env resolution for BOTH
surfaces. Imports nothing from `next/*` (the reversibility wall) and nothing from a vertical —
it is platform, below the features. WHERE cookies or the keychain live is the host's job, so a
host passes an adapter in; this package never reaches into `next/headers` or `expo-secure-store`
itself.

## The factories (one per caller shape — pick by WHO is calling)

- **Browser** (`src/browser.ts`) — the client-side singleton for React components in the
  browser. Anon/publishable key; RLS enforces.
- **Server, cookie-backed** (`src/client.ts` + the host's cookie adapter) — Server Components,
  Server Actions, Route Handlers. Built PER REQUEST (never module-scope, or one request's
  identity leaks into another's render).
- **Server, bearer** (`createBearerSupabaseClient`) — the `apps/mobile` path through the web
  API: the raw access token is forwarded to PostgREST, `auth.uid()` resolves from the verified
  JWT, and a forged/expired token simply matches no rows.
- **Native** (`src/native.ts`) — the mobile app's own client, its session persisted through
  `LargeSecureStore` (`src/session-storage.ts` / `credentials.ts`; the AES-256-CTR key in
  `expo-secure-store`, ciphertext in AsyncStorage).
- **Service role** (`src/service-role.ts`) — see below.

## `getUser()` / `getClaims()`, NEVER `getSession()`

Server-side, verify: `getUser()` authenticates the token against the auth server; `getClaims()`
verifies it locally against the project's published asymmetric key. `getSession()` returns
whatever JWT it finds in an attacker-controlled cookie WITHOUT checking the signature — never
call it server-side. These are RENDERING affordances; the authorization boundary is RLS plus
the server-only data layer, which holds whether or not anyone calls them.

## `createServiceRoleClient_BYPASSES_RLS` — the elevated factory

It bypasses row security by role attribute, so whatever holds it IS the boundary and the RLS
suite cannot cover it. Its ONLY sanctioned home is an ADR-governed Edge Function
(`supabase/functions/<name>/index.ts`) — never a Server Action, tRPC procedure, Route Handler,
component, script, or the mobile bundle. It requires a `ServiceRoleWarrant` (a merged
`docs/adr/NNNN-slug.md` path + a sentence on what RLS cannot express), THROWS on a bad warrant
or in a client environment (`'document' in globalThis`), and disables session
persist/refresh/detect. Migrations `REVOKE ALL` from `service_role`; a function reaches a table
only via an explicit per-table grant attached to the ADR. The long name IS the grep for "does
anything elevated exist here?".

## Rules

- The bundle wall: this package is on the `.` server barrel only — never add a `./client`
  subpath (`tools/exports-walls.json`), or the service-role graph is one import from the native
  binary (Metro does not tree-shake).
- `select('*')` is banned in the data layer — an explicit column list keeps a later
  embedding/moderation/tombstone column from silently publishing.
- Reviewer: `security-reviewer` (the RLS/service-role boundary) + `web-security-reviewer` (the
  cookie/bearer split on the web host).
