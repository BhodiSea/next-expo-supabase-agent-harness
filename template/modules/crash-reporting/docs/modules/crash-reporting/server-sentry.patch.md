# Patch: server crash reporting (`@sentry/node`, self-hosted)

OPT-IN wiring for `apps/server`. Nothing here is applied automatically — copy
the snippets deliberately, after your self-hosted Sentry (or GlitchTip)
instance exists. The mobile app and the API server are separate crash
surfaces with separate SDKs; the POLICY is the same on both.

## 1. Install (server workspace)

```
pnpm --filter server add @sentry/node
```

Pin it in the workspace catalog like every other dependency
(`pnpm-workspace.yaml`), then reference `catalog:` from
`apps/server/package.json`.

## 2. Share the policy — the reviewed-copy flow

The shipped policy lives in `apps/mobile/src/crash/redact.ts`. The server gets
a COPY, not an import (an app cannot import another app's source):

```
mkdir -p apps/server/src/crash
cp apps/mobile/src/crash/redact.ts   apps/server/src/crash/redact.ts
cp apps/mobile/src/crash/redact.test.ts apps/server/src/crash/redact.test.ts
```

Then adjust the test copy for the server's runner (vitest, which does not
inject globals): add as its first line

```ts
import { describe, expect, it } from 'vitest'
```

and change the production import to the server's NodeNext style:
`from './redact.js'`. The suite joins `pnpm exec vitest run` automatically
(`apps/server/src/**/*.test.ts` is in the unit-node include), and because
`apps/server/src/` is a mutation-critical root, the server copy IS mutated by
the mutation lane — the suite is written to that kill standard.

`pnpm validate` will now red the `duplication` gate on the identical pair —
that is the gate working as designed, and its message prints the exact
resolution: add the printed `{"fingerprint": …, "reason": …}` entry to
`tools/duplication-allow.json` (write-guard-protected — a reviewed human
edit). Suggested reason:

```
crash-reporting module: the redaction policy is deliberately duplicated across the app boundary — a shared workspace package for one dependency-free 90-line policy would add a lockfile importer, a tsconfig project reference, and a knip workspace; the pinned fingerprint proves the copies still match.
```

Honest limit of the flow: the fingerprint proves the copies match only WHILE
they match. If you edit one copy, the clone disappears from the gate's view and
the copies drift silently from then on — so treat every policy edit as a
two-sided edit (change both files and both test suites in the same diff), or
promote the policy to a real shared package at that point.

## 3. Environment contract (`.env.example` additions)

```ini
# ---- crash reporting (crash-reporting module) ---------------------------------
# Self-hosted Sentry ingest DSN. Empty = crash reporting disabled (the default).
# On-prem doctrine: events go to YOUR ingest host, never a third-party SaaS.
SENTRY_DSN=
# Release tag; set from CI so events map to a build. Default: package version.
SENTRY_RELEASE=
```

## 4. Wiring (`apps/server/src/instrument.ts`, imported FIRST in `src/index.ts`)

```ts
import * as Sentry from '@sentry/node'
import { redactCrashEvent, redactText } from './crash/redact.js'

// SOURCE: crash-reporting module — every outbound event passes the tested
// redaction boundary; an unset DSN disables the transport entirely
// [corpus: harness/doctrine]
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
```

Note `src/index.ts` is the process-boot file the unit lane deliberately never
executes (coverage exclude) — the import line there carries no test duty; the
redaction behavior is what the copied suite pins.

## 5. Route-level capture

The scaffold already funnels every route error through ONE handler:
`app.onError(onErrorHandler)` in `apps/server/src/app.ts` (the 500-envelope
backstop the error suite asserts). Capture there — wrap or extend
`onErrorHandler` in `src/errors.ts` with `Sentry.captureException(err)` before
it shapes the sanitized envelope. Never capture inside individual handlers:
double-reporting, missed middleware errors.

## 6. Prove the redaction path (anti-vacuity)

With a local capture proxy (or your ingest host's event view) as the DSN
target, throw a test error containing a credentialed connection string (the
dev-shaped `postgres://app_api:postgres@127.0.0.1/app` works) + an e-mail
address, and assert the captured payload contains `postgres://[redacted]@` and
`[redacted-email]` — the unit tests prove the functions; this proves the
WIRING calls them.
