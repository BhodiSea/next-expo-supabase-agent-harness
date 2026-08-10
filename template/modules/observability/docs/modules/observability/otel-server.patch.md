# Patch: OpenTelemetry wiring for the tRPC API (observability module)

OPT-IN wiring — copy deliberately. The span-per-procedure CONTRACT already ships
as a test (`packages/api/src/observability/span-routes.test.ts`); this patch adds
the SDK that fulfills it. The API is `@app/api`, mounted by the web app at
`apps/web/app/api/trpc/[trpc]/route.ts`, so the tracing SDK registers through the
Next.js instrumentation hook — NOT a server-framework middleware. Two decisions
are yours before pasting anything: the OTLP target (your collector, on-prem) and
the sampling rate.

> **SAME DIFF as its `tools/observability.json` register additions (0.8.0; rows
> corrected 0.9.0).** The `observability` chain gate reds any `@opentelemetry/*`
> or `@vercel/otel` import outside the reviewed sink register. THREE files this
> patch lands import the SDK, and each needs its own row — and each must
> reference `redactFields` (the seam's own pass, already in the seeded
> `redactionSymbols`) in code, which the snippets below do. The register is
> APPEND-ONLY consumer data: EXTEND the seeded `sinks[]`, never narrow
> `vendorSpecifiers` or `redactionSymbols` below their shipped floors. The exact
> additions:

```json
{
  "sinks": [
    {
      "file": "apps/web/instrumentation.ts",
      "vendors": ["@vercel/otel"],
      "redaction": "redactFields",
      "reason": "observability module: the OTel SDK registration — every span's attributes pass redactFields in the export-path span processor, behind the same pass the log seam applies."
    },
    {
      "file": "packages/api/src/trpc.ts",
      "vendors": ["@opentelemetry/"],
      "redaction": "redactFields",
      "reason": "observability module: the per-procedure tracing middleware — span names are static procedure paths, and every attribute set on a span passes redactFields first."
    },
    {
      "file": "packages/api/src/context.ts",
      "vendors": ["@opentelemetry/"],
      "redaction": "redactFields",
      "reason": "observability module: reads the active span context for log correlation; the ids join the request logger through the same redactFields pass as every other field."
    }
  ]
}
```

Land the rows, the imports, and the wiring in ONE reviewed diff.

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
import { redactFields } from '@app/observability'

export function register(): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (endpoint === undefined || endpoint === '') return
  // @vercel/otel configures the OTLP/HTTP trace exporter from
  // OTEL_EXPORTER_OTLP_ENDPOINT and skips the Node SDK on the Edge runtime.
  registerOTel({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'web',
    // Auto-instrumented HTTP spans carry request attributes, and a URL is a
    // value surface (tokens and e-mails ride in paths and query strings). Every
    // span's attributes pass the SAME redaction pass the log seam applies, on
    // the export path — attach behind the pass, like every sink. This is the
    // reference this file's sinks[] row declares.
    spanProcessors: [
      'auto',
      {
        onStart: () => undefined,
        onEnd: (span) => {
          Object.assign(span.attributes, redactFields(span.attributes))
        },
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    ],
  })
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

The dynamic imports are the same egress path to the gate's detector, so the
`sinks[]` row for this file is unchanged either way — and so is its declared
symbol: keep the primary form's `redactFields` span processor on the
`NodeSDK`'s `spanProcessors` (the row's symbol must stay referenced in code,
and the attributes must stay behind the pass regardless of which SDK owns
the exporter).

## 4. One span per procedure (`packages/api/src/trpc.ts`)

The Next instrumentation gives you the HTTP server span for the single route
(`POST /api/trpc`). tRPC does not name a span per procedure on its own, so add a
tracing middleware on the BASE of the ladder — beside the skew guard, on
`publicProcedure`, so every rung inherits it — and name the span from the tRPC
`path`. That `path` is the dotted procedure key (`notes.create`), which is
exactly the TEMPLATE the manifest in `span-routes.test.ts` pins:

```ts
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { redactFields } from '@app/observability'

// Alongside skewGuard, and folded into publicProcedure so no rung can dodge it:
const tracing = t.middleware(({ path, next }) =>
  trace.getTracer('@app/api').startActiveSpan(path, async (span) => {
    try {
      const result = await next()
      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        // Attribute discipline — the reference this file's sinks[] row declares:
        // anything set on a span passes the redaction pass first. The error code
        // is a static enum today; the pass is the habit that keeps tomorrow's
        // attribute behind it too.
        span.setAttributes(redactFields({ 'trpc.error_code': result.error.code }) as never)
      }
      return result
    } finally {
      span.end()
    }
  }),
)

export const publicProcedure = t.procedure.use(skewGuard).use(tracing)
```

Because the span name is the static `path` and never an input value, it stays
low-cardinality by construction — the property the second manifest test asserts.
(The `as never` bridges `LogFields`' `unknown` values to OTel's `Attributes`;
the pass only ever returns JSON-safe values.)

For log↔trace correlation, fold the active span context into the request-scoped
`@app/observability` logger where the context is assembled
(`packages/api/src/context.ts`), so every record on that request carries the ids:

```ts
import { trace } from '@opentelemetry/api'
import { redactFields } from '@app/observability'

const spanContext = trace.getActiveSpan()?.spanContext()
const requestLogger = baseLogger.child(
  redactFields(
    spanContext === undefined
      ? {}
      : { trace_id: spanContext.traceId, span_id: spanContext.spanId },
  ),
)
```

The fields pass the redaction pass AT THE MOUTH (the reference this file's
sinks[] row declares — the logger's emit path applies it again downstream, which
is the seam working, not a reason to skip it here); ids are not sensitive, so
they pass through unchanged and land on every line the request emits.

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
