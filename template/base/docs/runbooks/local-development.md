# Runbook: local development

How to bring up the whole stack — one Supabase backend, the Next.js web app, and
the Expo mobile app — on your machine, in the order they depend on each other.
Short version: `pnpm db:up`, then `pnpm dev:web`, then `pnpm dev:mobile`. The order
is not cosmetic: the web app hosts the tRPC router the mobile app consumes, and
both talk to Supabase, so the database must be up first and the web dev server
before mobile if you want the tRPC path live.

## Prerequisites

- **Docker** running — the Supabase local stack is containers.
- **Node ≥ 22** and **pnpm 11** (the repo pins both; `corepack enable` picks up the
  `packageManager` pin).
- `pnpm install` once at the root.
- `cp .env.example .env` and fill in the local values. The web (`NEXT_PUBLIC_*`) and
  mobile (`EXPO_PUBLIC_*`) publishable keys are printed by `pnpm db:up` /
  `supabase status`; the URLs default to the local ports in the table below. See
  `.env.example` for the blast-radius doctrine on each class — no real credential
  belongs in that file.

## 1. Start the backend — `pnpm db:up`

```
pnpm db:up      # supabase start — Postgres + Auth (GoTrue) + PostgREST + Studio + mail
```

First run pulls images and applies every migration in `supabase/migrations/` plus
`supabase/seed.sql`. When it finishes it prints the API URL and the **anon /
publishable key** and **service-role key** — copy the publishable key into the
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE` slots in
`.env` (the service-role key belongs only in an Edge Function, never in either app —
see `.env.example` block (a)). Re-print anytime with `supabase status`.

- `pnpm db:reset` — drop, re-migrate, re-seed (the fastest way back to a known state).
- `pnpm db:types` — regenerate the committed Supabase type mirror after a schema
  change (the `types-drift` gate reds if you forget).
- `pnpm db:test` — the pgTAP suite. `pnpm test:rls` — the cross-tenant isolation suite.
- `pnpm db:down` — stop the stack (data persists to the next `db:up`).

## 2. Start the web app — `pnpm dev:web`

```
pnpm dev:web    # next dev — the App Router UI AND the tRPC router at /api/trpc
```

`apps/web` is both the web UI and the API host: it mounts the framework-neutral
`@app/api` router at `/api/trpc/[trpc]`. It reads the `NEXT_PUBLIC_*` values from
`.env`. Default origin is `http://127.0.0.1:3000` — this is the committed
`WEB_ORIGIN` default that `app.config.ts` also bakes into the mobile build's `extra`,
so the two agree out of the box.

## 3. Start the mobile app — `pnpm dev:mobile`

```
pnpm dev:mobile # expo start — Metro bundler + the dev client
```

`apps/mobile` reads its `EXPO_PUBLIC_*` values, talks **directly** to Supabase for
reads/writes (Class-A) and to the tRPC router served by the web app for the rest
(Class-B). If you are exercising the Class-B path, keep `pnpm dev:web` running; for
Class-A-only work the web server is optional. On a device/emulator, `127.0.0.1`
means the device itself — point `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_WEB_ORIGIN`
at your machine's LAN IP (or a tunnel) so the phone can reach the stack.

## Port table

| Service | URL / port | Started by |
|---|---|---|
| Supabase API (Kong → PostgREST / GoTrue / Storage) | `127.0.0.1:54321` | `pnpm db:up` |
| Postgres — direct (migrations, `test:rls`) | `127.0.0.1:54322` | `pnpm db:up` |
| Postgres — migration shadow DB (`db reset`/`db diff`) | `127.0.0.1:54320` | `pnpm db:up` |
| Supabase Studio (DB browser) | `127.0.0.1:54323` | `pnpm db:up` |
| Inbucket (local mail: auth confirmation links) | `127.0.0.1:54324` | `pnpm db:up` |
| Next.js web — UI + tRPC at `/api/trpc` | `127.0.0.1:3000` | `pnpm dev:web` |
| Metro / Expo dev server | `127.0.0.1:8081` | `pnpm dev:mobile` |

Ports come from `supabase/config.toml` (54320–54324) and the framework defaults
(`next dev` 3000, Metro 8081). Change the Supabase ports in `config.toml`; change the
web port with `pnpm dev:web -- -p <port>` (and update `WEB_ORIGIN`).
