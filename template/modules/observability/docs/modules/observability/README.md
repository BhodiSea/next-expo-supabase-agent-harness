# Module: observability

OpenTelemetry for the API server, contract-first: the span-per-route CONTRACT
ships as a running test immediately (one server span per API route, named from
the route TEMPLATE, low-cardinality), and the NodeSDK + instrumentation-pino
wiring ships as a documented patch you apply when you have decided where traces
go. An OTLP endpoint is a runtime dependency and a data-egress decision — made
deliberately, not defaulted.

## What it adds

| File | Purpose |
| --- | --- |
| `apps/server/src/observability/span-routes.test.ts` | span-name manifest derived from the REAL route table + low-cardinality check + `it.todo` seams for the SDK-backed asserts |
| `docs/modules/observability/otel-server.patch.md` | NodeSDK + OTLP exporter + instrumentation-pino + @hono/otel wiring, env contract, and the seam-activation guide |

## Prerequisites

- None for the shipped test (it runs in the default vitest lane immediately).
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
an `InMemorySpanExporter`). No `tools/harness.config.mjs` change.

## How its gate can FAIL (anti-vacuity)

- Today: add any `/api/*` route to `apps/server/src/app.ts` without touching the
  test → the manifest expectation fails in the same PR. That friction is the
  contract: a route cannot ship without its span name being reviewed.
- Today: register a route with a resolved-looking segment
  (`/api/notes/123/pin`) → the low-cardinality check fails.
- After wiring: comment out the `otel()` middleware → the activated
  one-span-per-request assert fails with zero spans; drop
  `PinoInstrumentation` → the log-correlation assert fails (no `trace_id` on
  request-scoped lines).

## Honest limits

- Until the patch is applied, the `it.todo` seams are visible-but-inert — vitest
  reports them as todo on every run, so the unfinished half stays loud.
- Span coverage is asserted for the API surface; the mobile side (the Expo app)
  is out of scope here — trace context does not cross the HTTPS boundary in the
  scaffold (`apps/mobile/src/lib/api-client.ts` sends no `traceparent`). If you
  need end-to-end traces, propagate `traceparent` through the api-client
  one-door's headers (and add it to the server's CORS `allowHeaders` for the
  browser-based dev surfaces) and note it in the patch.
