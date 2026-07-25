# packages/api — `@app/api` (the tRPC router)

The framework-neutral tRPC v11 router that `apps/web` SERVES (at
`app/api/trpc/[trpc]/route.ts`) and `apps/mobile` consumes `import type` only. It imports
NO `next/*` — the reversibility wall (`packages/api ↛ next/*`, depcruise-pinned in
`scripts/rule-integrity.json`); the whole package promotes to a standalone `apps/api` by
moving one `route.ts`.

## The procedure ladder (`src/trpc.ts`)

Build every procedure on a rung, never on the bare `t.procedure`:

- **`publicProcedure`** — open, but behind the version-skew guard. The guard is on the BASE
  so every rung inherits it: a major `x-client-version` mismatch, or a build below the
  minimum-supported-client floor, throws `CONFLICT` with machine code `version_skew` before
  any handler runs. Requests with no version header pass (curl, health tooling).
- **`authedProcedure`** — throws `UNAUTHORIZED` when `ctx.actor === null`. This is the ONE
  sanctioned domain-adjacent throw; it narrows `ctx.actor` to non-null for everything
  downstream, so no authed handler re-checks identity and none can forget to.
- **`memberProcedure`** — membership is an AUTHORIZATION outcome, not a transport fact, so it
  does NOT throw: `const gate = ctx.member; if (!gate.ok) return gate` — the same two lines
  in every member procedure, which makes a missing gate visible in review.

No transformer: every payload is JSON-safe by construction, so a plain `curl` sees the same
bytes the typed client does.

## The envelope

Procedures return `ActionOutcome<T>` from `@app/errors` on the DATA channel; a domain failure
is a returned `outcomeErr(appError.X())`, NEVER a thrown `TRPCError`. Only two throws cross the
wire — the auth `UNAUTHORIZED` and the skew `CONFLICT` — both transport facts a handler could
not have produced (an `.input()` parse failure is the framework's `BAD_REQUEST`). The
`errorFormatter` stamps `data.appCode` so clients switch on a stable code, never a message.

## Rules

- A router delegates to a vertical (`@app/<slice>`); no business logic and no direct database
  access lives in the router. Reads go through the vertical's `./client`, writes through its
  server barrel.
- Add or change a procedure → run `pnpm gen`: the `contracts` gate regen-diffs the committed
  action inventory, and the `parity` gate holds the mobile ledger to it.
- `IsAny<AppRouter>` is the compile-time guard the mobile side re-asserts, so a router typed
  `any` (a lost import, a broken generic) reds at build rather than shipping an untyped client.
- Reviewer: `security-reviewer` on any procedure that reads/writes user data; `web-security-reviewer`
  if the change touches the route handler's client selection.
