# Patch: OpenTelemetry wiring for apps/server (observability module)

OPT-IN wiring — copy deliberately. The span-per-route CONTRACT already ships as a
test (`apps/server/src/observability/span-routes.test.ts`); this patch adds the
SDK that fulfills it. Two decisions are yours before pasting anything: the OTLP
target (your collector, on-prem) and the sampling rate.

## 1. Install (server workspace; pin in the catalog like everything else)

```
pnpm --filter server add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/instrumentation-pino @opentelemetry/semantic-conventions @hono/otel
```

## 2. Environment contract (`.env.example` additions)

```ini
# ---- observability (observability module) --------------------------------------
# OTLP/HTTP traces endpoint of YOUR collector. Empty = tracing disabled (default).
OTEL_EXPORTER_OTLP_ENDPOINT=
# Service name in traces. Default: server.
OTEL_SERVICE_NAME=
```

## 3. Wiring (`apps/server/src/instrumentation.ts`, imported FIRST in `src/index.ts`)

```ts
// SOURCE: OTel NodeSDK — register before any instrumented module loads
// [corpus: harness/doctrine]
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { NodeSDK } from '@opentelemetry/sdk-node'

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
if (endpoint !== undefined && endpoint !== '') {
  const sdk = new NodeSDK({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'server',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      // trace_id/span_id onto every request-scoped pino line — logs↔traces correlation.
      new PinoInstrumentation(),
    ],
  })
  sdk.start()
  process.on('SIGTERM', () => void sdk.shutdown())
}
```

## 4. One span per route (`src/app.ts`)

`@hono/otel` middleware creates the server span; register it FIRST — in
`createApp()`, ahead of the CORS and skew/auth middleware — so every route,
including `/healthz`, is covered, and name spans from the route TEMPLATE (that
is the contract `span-routes.test.ts` pins):

```ts
import { otel } from '@hono/otel'
// in createApp(), before the cors()/skew/auth middleware:
app.use('*', otel())
```

## 5. Activate the test seams

Replace the two `it.todo(...)` entries in `span-routes.test.ts` with real
assertions using `@opentelemetry/sdk-trace-node`'s `InMemorySpanExporter`:
request each route from the manifest, then assert exactly one server span exists
whose name equals the manifest entry, and that a captured pino line carries the
same `trace_id`. The manifest tests already fail on any route added without a
span name — the activated seams close the loop on the SDK actually emitting them.

## Anti-vacuity

With the SDK wired and the seams activated: comment out the `otel()` middleware →
the one-span-per-request test fails (zero spans). Rename a span to a resolved
path (`/api/notes/123`) in a scratch branch → the low-cardinality test fails.
