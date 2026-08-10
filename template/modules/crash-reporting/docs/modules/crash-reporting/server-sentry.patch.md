# Patch: server crash reporting (`@sentry/nextjs`, self-hosted)

OPT-IN wiring for the Next.js server (`apps/web`) — the tRPC API (`@app/api`) it mounts
at `app/api/trpc/[trpc]/route.ts` is the server crash surface. Nothing here is applied
automatically; copy the snippets deliberately, after your self-hosted Sentry (or
GlitchTip) instance exists. The mobile app and the web server are separate crash surfaces
with separate SDKs; the POLICY is the same on both.

> **SAME DIFF as its `tools/observability.json` register additions (0.8.0; rows
> corrected 0.9.0).** The `observability` chain gate reds any `@sentry/*` import
> outside the reviewed sink register. TWO files this patch lands import the SDK
> (`sentry.server.config.ts` and `instrumentation.ts` — the tRPC route captures
> through a named export instead, §5), and each needs its own row referencing a
> redaction symbol it actually calls. The register is APPEND-ONLY consumer data:
> EXTEND the seeded `redactionSymbols` and `sinks[]` lists, never replace them —
> `redactFields` and the seeded `vendorSpecifiers` are floor entries the gate
> reds you for removing. The exact additions:

```json
{
  "redactionSymbols": ["redactCrashEvent", "redactText"],
  "sinks": [
    {
      "file": "apps/web/sentry.server.config.ts",
      "vendors": ["@sentry/"],
      "redaction": "redactCrashEvent",
      "reason": "crash-reporting module: the server Sentry init — beforeSend routes every outbound event through the copied redaction policy in apps/web/lib/crash/redact.ts before transport."
    },
    {
      "file": "apps/web/instrumentation.ts",
      "vendors": ["@sentry/"],
      "redaction": "redactText",
      "reason": "crash-reporting module: onRequestError hands Next's RSC/route errors to the client whose beforeSend redacts, and scrubs the request path through redactText at the mouth."
    }
  ]
}
```

Land the rows, the imports, and the wiring in ONE reviewed diff.

## 1. Install (web workspace)

```
pnpm --filter web add @sentry/nextjs
```

Pin it in the workspace catalog like every other dependency (`pnpm-workspace.yaml`),
then reference `catalog:` from `apps/web/package.json`.

## 2. Share the policy — the reviewed-copy flow

The shipped policy lives in `apps/mobile/src/crash/redact.ts`. The web server gets a
COPY, not an import — the same deliberate duplication this module documents (promoting
one dependency-free ~90-line policy to a shared `@app/crash` package would add a workspace
importer, a tsconfig project reference, and a knip entry; the duplication gate's
fingerprint proves the copies match instead):

```
mkdir -p apps/web/lib/crash
cp apps/mobile/src/crash/redact.ts      apps/web/lib/crash/redact.ts
cp apps/mobile/src/crash/redact.test.ts apps/web/lib/crash/redact.test.ts
```

Then adjust the test copy for the web runner (vitest, which does not inject globals): add
as its first line

```ts
import { describe, expect, it } from 'vitest'
```

The web app resolves the production import extensionlessly, so `from './redact'` needs no
change. The suite joins `pnpm exec vitest run` automatically (the web unit lane), so the
policy is enforced on the server side from the moment you copy it.

`pnpm validate` will now red the `duplication` gate on the identical pair — that is the
gate working as designed, and its message prints the exact resolution: add the printed
`{"fingerprint": …, "reason": …}` entry to `tools/duplication-allow.json`
(write-guard-protected — a reviewed human edit). Suggested reason:

```
crash-reporting module: the redaction policy is deliberately duplicated across the app boundary — a shared workspace package for one dependency-free ~90-line policy would add a lockfile importer, a tsconfig project reference, and a knip workspace; the pinned fingerprint proves the copies still match.
```

Honest limit of the flow: the fingerprint proves the copies match only WHILE they match.
If you edit one copy, the clone disappears from the gate's view and the copies drift
silently from then on — so treat every policy edit as a two-sided edit (change both files
and both test suites in the same diff), or promote the policy to a real shared package at
that point.

## 3. Environment contract (`.env.example` additions — server-only, never `NEXT_PUBLIC_`)

```ini
# ---- crash reporting (crash-reporting module) ---------------------------------
# Self-hosted Sentry ingest DSN. Empty = crash reporting disabled (the default).
# Server-only — an errors endpoint is not something the browser bundle may see, so it is
# NOT NEXT_PUBLIC_ and stays out of the @app/env public block.
# On-prem doctrine: events go to YOUR ingest host, never a third-party SaaS.
SENTRY_DSN=
# Release tag; set from CI so events map to a build. Default: package version.
SENTRY_RELEASE=
```

## 4. Wiring (Next.js instrumentation — `apps/web`)

`@sentry/nextjs` initializes through the Next.js instrumentation hook, NOT a
server-framework middleware — the same hook the `observability` module registers OTel in.
If both modules are enabled, their `register()` bodies coexist in the one
`apps/web/instrumentation.ts`.

`apps/web/sentry.server.config.ts` (new file — the Node-runtime init):

```ts
// SOURCE: crash-reporting module — every outbound event passes the tested redaction
// boundary; an unset DSN disables the transport entirely [corpus: harness/doctrine]
import * as Sentry from '@sentry/nextjs'
import { redactCrashEvent, redactText } from './lib/crash/redact'

const dsn = process.env['SENTRY_DSN']
if (dsn !== undefined && dsn !== '') {
  Sentry.init({
    dsn,
    release: process.env['SENTRY_RELEASE'],
    // No default PII: request bodies, cookies, and user context stay home.
    sendDefaultPii: false,
    beforeSend(event) {
      // Reuse the unit-tested policy for the fields Sentry actually sends.
      if (event.message !== undefined) event.message = redactText(event.message)
      for (const exception of event.exception?.values ?? []) {
        if (exception.value !== undefined) exception.value = redactText(exception.value)
      }
      if (event.extra !== undefined) {
        event.extra = redactCrashEvent({ message: '', context: event.extra }).context
      }
      return event
    },
  })
}

// The tRPC route funnel (§5) captures through this named export, so the route
// file never imports the vendor SDK itself and the sink register stays at the
// two rows this patch declares (one vendor import per licensed surface).
export function captureServerException(error: unknown): void {
  Sentry.captureException(error)
}
```

`apps/web/instrumentation.ts` — Next runs `register()` once, before app code (add the
Sentry import alongside anything the observability module already registers):

```ts
import * as Sentry from '@sentry/nextjs'
import { redactText } from './lib/crash/redact'

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    await import('./sentry.server.config')
  }
  // Add a './sentry.edge.config' with the same Sentry.init if you run any route on the
  // Edge runtime; the tRPC API route runs on Node, so Node alone covers it.
}

// Next passes nested React Server Component / route errors to this hook; @sentry/nextjs
// captures them (they never surface in a try/catch you control). The EVENT is redacted
// by the client's beforeSend (sentry.server.config.ts); the request PATH is scrubbed
// here at the mouth — a URL is a value surface too (tokens and e-mails ride in paths),
// and this file's sink row declares exactly this pass.
export const onRequestError: typeof Sentry.captureRequestError = (error, request, context) =>
  Sentry.captureRequestError(error, { ...request, path: redactText(request.path) }, context)
```

## 5. Route-level capture (the tRPC error funnel)

The scaffold already funnels every procedure error through ONE place: the `onError`
callback of the fetch handler in `apps/web/app/api/trpc/[trpc]/route.ts` (beside the tRPC
`errorFormatter` that shapes the sanitized envelope). Capture there, through the
`captureServerException` export §4 added — never `Sentry.captureException` inline: a
vendor import in the route file would be a third egress surface for a file that never
touches the redaction policy, and the register deliberately licenses two. And never
inside individual procedures (double-reporting, missed middleware errors):

```ts
import { captureServerException } from '../../../../sentry.server.config'

// …inside the fetchRequestHandler options, beside the errorFormatter:
onError({ error }) {
  captureServerException(error)
},
```

The `onRequestError` export in §4 covers the non-tRPC surface (RSC render, route
handlers); together they see every server error.

## 6. Prove the redaction path (anti-vacuity)

With a local capture proxy (or your ingest host's event view) as the DSN target, throw a
test error containing a credentialed connection string (the dev-shaped
`postgres://postgres:postgres@127.0.0.1/app` works) + an e-mail address, and assert the
captured payload contains `postgres://[redacted]@` and `[redacted-email]` — the unit
tests prove the functions; this proves the WIRING calls them.

## Honest limit — mutation coverage

`apps/web/` is outside the mutation lane's critical roots
(`tools/lib/mutation-critical.mjs` mutates `packages/api`, `packages/verticals`, and the
supabase/errors platform seams), so this web copy is tested by vitest but NOT mutated —
the same recorded honest loss as the mobile copy under jest-expo. The suite is written to
the mutation-kill standard regardless; if you want it mutated, keep the reviewed copy in a
critical root instead (e.g. `packages/api/src/crash/redact.ts`, imported by the Sentry
config) and register the duplication entry against that path.
