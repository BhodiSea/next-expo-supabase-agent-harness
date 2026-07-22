---
paths:
  - "apps/mobile/**"
  - "apps/server/**"
---

# Mobile / server split (best-effort scoped; never rely on conditional loading for invariants)

`paths:` scoping is best-effort — the hard invariants live in
security-invariants.md (always loaded) plus the write guard, ESLint, and
depcruise. SOURCE: docs/harness/README.md (mobile-server split)

The trust boundary: **the mobile app is an untrusted client**. The server
and Postgres (FORCE RLS) are the only authoritative layers.

- **The client never authorizes.** The app config, the platform keychain, and
  device state are containment for the client process — not authorization for
  data. Never gate data access on client state; every authorization decision
  happens in the server DAL via `withUserContext(userId, fn)` over FORCE RLS.
- **The client never imports server/database modules** (`postgres`,
  `drizzle-orm`, `pg`, `@hono/*`, `pino`, anything in `apps/server`). It speaks
  HTTPS to the API using typed contracts from `@app/contracts` and Zod-parses
  every response (including the `/healthz` connection probe).
- **The api-client is the one door.** Every request goes through
  `src/lib/api-client.ts` (`apiFetch`/`apiPost`): origin resolution, the bearer
  token, and error-envelope decoding live there and nowhere else — a feature
  never calls `fetch()` directly. SSE rides the same client (the hand-rolled
  parser in `src/lib/sse.ts`), never an extra transport dependency.
- **The keychain is wrapped.** `expo-secure-store` is imported only inside
  `apps/mobile/src/host/**` (the credential seam); feature and screen code stays
  storage-agnostic. New native surface = an `app.config.ts` change + an
  allowlisted config plugin, not a scattered native import.
- **The server DAL is the only db surface.** Routes (`@hono/zod-openapi`) parse
  input, call `apps/server/src/dal/*`, and return DTOs from `@app/contracts`.
  Every DAL function runs inside `withUserContext` (`src/db/context.ts`:
  transaction + `SET LOCAL app.user_id`). No driver call outside the DAL; no raw
  rows outside it. Route changes require `pnpm openapi:emit` (the committed
  `apps/server/openapi.json` is regen-diffed by the `contracts` gate).
- **Version-skew contract.** The app sends `x-client-version` (the app version
  derived in app.config.ts); server middleware compares MAJOR versions and
  answers `409 { "error": { "code": "version_skew" } }` on mismatch. It applies
  to every `/api/*` route (a unit test walks the route table to prove coverage);
  `/healthz` is exempt so the connection probe still works. Mobile fleets lag
  releases by store review + staged rollout + users who never update — design
  API changes to tolerate an N-1 client (see
  `docs/runbooks/expand-contract.md`).
