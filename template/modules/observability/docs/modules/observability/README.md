# Module: observability

OpenTelemetry for the tRPC API served by `apps/web`, contract-first: the
span-per-procedure CONTRACT ships as a running test immediately (one server span
per procedure, named from the tRPC PROCEDURE PATH, low-cardinality), and the
Next.js `instrumentation.ts` + OTLP exporter wiring ships as a documented patch
you apply when you have decided where traces go. An OTLP endpoint is a runtime
dependency and a data-egress decision — made deliberately, not defaulted.

The API is the framework-neutral `@app/api` router mounted at
`apps/web/app/api/trpc/[trpc]/route.ts`; the server span is created by the
Next/tRPC layer, and the span-NAME manifest is pinned against the router itself.
Structured logging and span timing already live in `@app/observability`
(`packages/platform/observability`) — a redacting, vendor-neutral seam. This
module is what attaches OTLP export to that surface without teaching the seam a
vendor SDK.

## What it adds

| File | Purpose |
| --- | --- |
| `packages/api/src/observability/span-routes.test.ts` | span-name manifest derived from the REAL tRPC router (`appRouter._def.procedures`) + low-cardinality check + `it.todo` seams for the SDK-backed asserts |
| `docs/modules/observability/otel-server.patch.md` | `apps/web/instrumentation.ts` wiring (via `@vercel/otel`, or the `@opentelemetry/sdk-node` register hook), a per-procedure tracing middleware, the OTLP env contract, and the seam-activation guide |

## Prerequisites

- None for the shipped test (it runs in the default vitest lane immediately —
  `@app/api` already depends on vitest, and the file type-checks against the real
  `appRouter`).
- For the wiring: an OTLP/HTTP collector you operate (on-prem doctrine), then the
  patch's install list — pinned through the workspace catalog like everything
  else.

## How enabling works

```
npx next-expo-supabase-agent-harness enable observability
```

copies the files; the manifest tests join `pnpm exec vitest run` (and therefore
the Stop hook and CI) at once. Apply
`docs/modules/observability/otel-server.patch.md` when the collector exists, then
convert the two `it.todo` seams into real assertions (the patch shows how, with
an `InMemorySpanExporter` and `createCallerFactory(appRouter)`). No
`tools/harness.config.mjs` change.

## How its gate can FAIL (anti-vacuity)

- Today: add any procedure to a router under `packages/api/src/routers/` (or a new
  router to `appRouter`) without touching the test → the manifest expectation
  fails in the same PR. That friction is the contract: a procedure cannot ship
  without its span name being reviewed.
- Today: name a procedure with a resolved-looking segment (a numeric or uuid key)
  → the low-cardinality check fails.
- After wiring: remove the `register()` body from `apps/web/instrumentation.ts`
  (or comment out the tracing middleware) → the activated one-span-per-call assert
  fails with zero spans; drop the log-correlation wiring → the correlation assert
  fails (no `trace_id` on request-scoped `@app/observability` records).

## Honest limits

- Until the patch is applied, the `it.todo` seams are visible-but-inert — vitest
  reports them as todo on every run, so the unfinished half stays loud. They are
  reviewed escapes in `tools/test-quality-allow.json`, keyed by the file's new
  path.
- Span coverage is asserted for the API surface (the tRPC procedures `apps/web`
  serves). The mobile side (the Expo app) is out of scope here — trace context
  does not cross the HTTPS boundary in the scaffold: the mobile tRPC client
  (`apps/mobile/src/lib/trpc/client.ts`) sends no `traceparent`. If you need
  end-to-end traces, propagate `traceparent` through that client's headers and
  add it to the accepted headers on the web route handler, then note it in the
  patch.
- This module exports traces, not logs. `@app/observability` stays the logging
  seam; correlation is the bridge (a `trace_id` on each record), not a second log
  transport.
