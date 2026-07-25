# Patch: OpenTelemetry wiring for the tRPC API (observability module)

OPT-IN wiring — copy deliberately. The span-per-procedure CONTRACT already ships
as a test (`packages/api/src/observability/span-routes.test.ts`); this patch adds
the SDK that fulfills it. The API is `@app/api`, mounted by the web app at
`apps/web/app/api/trpc/[trpc]/route.ts`, so the tracing SDK registers through the
Next.js instrumentation hook — NOT a server-framework middleware. Two decisions
are yours before pasting anything: the OTLP target (your collector, on-prem) and
the sampling rate.

## 1. Install (pin in the catalog like everything else)

```
pnpm --filter web add @vercel/otel @opentelemetry/api
pnpm --filter @app/api add @opentelemetry/api
```

`@vercel/otel` handles the Node/Edge runtime split the Next.js instrumentation
hook straddles, and reads the OTLP endpoint from the env below. If you would
rather own the SDK directly, swap it for the `@opentelemetry/sdk-node` register
hook shown in §3 (add `@opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http`
to `web` instead). The per-procedure span in §4 needs `@opentelemetry/api` in
`@app/api` either way.

## 2. Environment contract (`.env.example` additions — server-only, never `NEXT_PUBLIC_`)

```ini
# ---- observability (observability module) --------------------------------------
# OTLP/HTTP traces endpoint of YOUR collector. Empty = tracing disabled (default).
OTEL_EXPORTER_OTLP_ENDPOINT=
# Service name in traces. Default: web.
OTEL_SERVICE_NAME=
```

These are read at process start inside `register()` (below) and by the exporter.
They are server-side by construction — a traces endpoint is not something the
browser bundle may see — so they are NOT `NEXT_PUBLIC_` and MUST stay out of the
`@app/env` public block.

## 3. Wiring (`apps/web/instrumentation.ts` — Next runs `register()` once, before app code)

```ts
// SOURCE: Next.js instrumentation hook — register() runs before any route module
// loads, in the Node.js runtime. https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
import { registerOTel } from '@vercel/otel'

export function register(): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (endpoint === undefined || endpoint === '') return
  // @vercel/otel configures the OTLP/HTTP trace exporter from
  // OTEL_EXPORTER_OTLP_ENDPOINT and skips the Node SDK on the Edge runtime.
  registerOTel({ serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'web' })
}
```

Direct-SDK alternative (drop `@vercel/otel`; guard on the runtime yourself so the
Node SDK never loads on an Edge invocation):

```ts
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (endpoint === undefined || endpoint === '') return
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const sdk = new NodeSDK({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'web',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  })
  sdk.start()
  process.on('SIGTERM', () => void sdk.shutdown())
}
```

## 4. One span per procedure (`packages/api/src/trpc.ts`)

The Next instrumentation gives you the HTTP server span for the single route
(`POST /api/trpc`). tRPC does not name a span per procedure on its own, so add a
tracing middleware on the BASE of the ladder — beside the skew guard, on
`publicProcedure`, so every rung inherits it — and name the span from the tRPC
`path`. That `path` is the dotted procedure key (`notes.create`), which is
exactly the TEMPLATE the manifest in `span-routes.test.ts` pins:

```ts
import { trace } from '@opentelemetry/api'

// Alongside skewGuard, and folded into publicProcedure so no rung can dodge it:
const tracing = t.middleware(({ path, next }) =>
  trace.getTracer('@app/api').startActiveSpan(path, async (span) => {
    try {
      return await next()
    } finally {
      span.end()
    }
  }),
)

export const publicProcedure = t.procedure.use(skewGuard).use(tracing)
```

Because the span name is the static `path` and never an input value, it stays
low-cardinality by construction — the property the second manifest test asserts.

For log↔trace correlation, fold the active span context into the request-scoped
`@app/observability` logger where the context is assembled
(`packages/api/src/context.ts`), so every record on that request carries the ids:

```ts
import { trace } from '@opentelemetry/api'

const spanContext = trace.getActiveSpan()?.spanContext()
const requestLogger = baseLogger.child(
  spanContext === undefined
    ? {}
    : { trace_id: spanContext.traceId, span_id: spanContext.spanId },
)
```

The redaction pass runs on these like any field; ids are not sensitive, so they
pass through and land on every line the request emits.

## 5. Activate the test seams

Replace the two `it.todo(...)` entries in `span-routes.test.ts` with real
assertions using `@opentelemetry/sdk-trace-node`'s `InMemorySpanExporter` and a
`NodeTracerProvider`: register the provider with the in-memory exporter, then for
each manifest entry call the procedure through `createCallerFactory(appRouter)(ctx)`,
flush, and assert exactly one span exists whose name equals the manifest entry —
and that an `@app/observability` record captured during that call carries the same
`trace_id`. The manifest tests already fail on any procedure added without a span
name; the activated seams close the loop on the SDK actually emitting them.

Update the two matching keys in `tools/test-quality-allow.json` as you delete the
`it.todo`s — an activated assertion no longer needs (or matches) its escape entry.

## Anti-vacuity

With the SDK wired and the seams activated: empty the `register()` body in
`apps/web/instrumentation.ts` (or remove `.use(tracing)`) → the one-span-per-call
test fails (zero spans). Name a span from an input value instead of `path` in a
scratch branch → the low-cardinality test fails.
