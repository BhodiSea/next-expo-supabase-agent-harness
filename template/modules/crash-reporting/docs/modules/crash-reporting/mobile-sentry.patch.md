<!-- cspell:ignore unredactable -->

# Patch: mobile crash reporting (`@sentry/react-native`, self-hosted)

OPT-IN wiring for `apps/mobile`. Nothing here is applied automatically — copy
the snippets deliberately, after your self-hosted Sentry (or GlitchTip)
instance exists. The redaction policy (`src/crash/redact.ts`, shipped by this
module with tests) is the non-negotiable part; the transport below is
replaceable.

Verified against `@sentry/react-native` 8.19.0 and the Sentry Expo setup guide
(<https://docs.sentry.io/platforms/react-native/manual-setup/expo/>),
2026-07-18.

> **SAME DIFF as its `tools/observability.json` `sinks[]` row (0.8.0).** The
> `observability` chain gate reds any `@sentry/*` import outside the reviewed sink
> register: `<file> imports "@sentry/react-native" … and is not a declared sink`.
> Register the one file that imports the SDK — `{ "file": "<path>", "vendors":
> ["@sentry/"], "redaction": "redactFields", "reason": "<40+ chars>" }` — and have
> that file reference the redaction symbol in code (the attach-behind-the-pass
> ordering the seam header mandates). Land the row, the import, and the wiring in
> ONE reviewed diff, exactly like the `tools/expo-plugins.json` row below.

## 1. Install (mobile workspace)

```
pnpm --filter mobile exec expo install @sentry/react-native
```

Then move the version `expo install` wrote into the workspace catalog like
every other dependency (`pnpm-workspace.yaml` `catalog:` entry, and
`"@sentry/react-native": "catalog:"` in `apps/mobile/package.json`). The
shipped `jest.config.js` `transformIgnorePatterns` already names
`@sentry/react-native` in its must-transform set, so the jest-expo lane needs
no config change.

Note: the SDK carries a native module. Expo Go cannot load it — use the
development-build flow this template already assumes (CNG prebuild).

## 2. Metro config

`apps/mobile/metro.config.js` ships as the unmodified `expo/metro-config`
default and its header says to EXTEND, never replace. `getSentryExpoConfig`
IS the extension point — it wraps the same default config and adds the
source-map serialization Sentry needs:

```js
// metro.config.js — expo/metro-config default, extended by the crash-reporting
// module: getSentryExpoConfig wraps getDefaultConfig (monorepo support
// preserved) and adds Sentry's source-map serializer.
// SOURCE: https://docs.sentry.io/platforms/react-native/manual-setup/expo/
const { getSentryExpoConfig } = require('@sentry/react-native/metro')

module.exports = getSentryExpoConfig(__dirname)
```

## 3. Config plugin — SAME DIFF as its `tools/expo-plugins.json` row

In `apps/mobile/app.config.ts`, append to the existing `plugins` array:

```ts
      // crash-reporting module: release-build source-map + native debug-file
      // upload phases in the GENERATED projects. Auth is SENTRY_AUTH_TOKEN in
      // the build environment, never a plugin option. The expo-policy gate
      // locksteps this entry against tools/expo-plugins.json — land both in
      // one reviewed diff (module README, "same diff" section).
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.internal.example.edu/', // YOUR ingest host, never a third-party SaaS
          organization: 'your-org-slug',
          project: '{{PROJECT_SLUG}}', // adjust to your Sentry project slug
        },
      ],
```

and add the reviewed row to `tools/expo-plugins.json` (exact JSON and the
gate's two red messages are in the module README — that file is
write-guard-protected, so a human lands it).

## 4. Environment contract (`.env.example` additions)

```ini
# ---- crash reporting (crash-reporting module) ---------------------------------
# Self-hosted Sentry ingest DSN. Empty = crash reporting disabled (the default).
# EXPO_PUBLIC_-prefixed: inlined into the client bundle BY DESIGN — a DSN is an
# ingest address, not a credential (rate-limit and filter at your ingest host).
# On-prem doctrine: events go to YOUR ingest host, never a third-party SaaS.
# For store builds, set it per environment with `eas env:create` instead.
EXPO_PUBLIC_SENTRY_DSN=
```

The release tag needs no variable: `Sentry.init` below derives it from the same
`package.json` version every other identity surface derives from (version-sync
doctrine — one source, no drift).

## 5. Wiring (`apps/mobile/src/crash/report.ts` — new file)

```ts
// Sentry transport for the shipped redaction policy (crash-reporting module,
// docs/modules/crash-reporting/mobile-sentry.patch.md). The ONLY file that
// imports @sentry/react-native besides app/_layout.tsx's wrap call — keep it
// that way, so the transport stays as removable as it was addable.
import * as Sentry from '@sentry/react-native'
import pkg from '../../package.json'
import { setLogSink } from '../lib/log'
import { redactCrashEvent, redactText } from './redact'

// Metro inlines EXPO_PUBLIC_ vars by rewriting the literal DOT member access,
// so the read below stays dot-form (same rule as src/lib/api-client.ts).
declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_SENTRY_DSN?: string
  }
}

// The beforeSend boundary as a NAMED export, so a unit test can drive it
// without the SDK initialized (see step 6).
export function redactEvent<E extends Sentry.ErrorEvent>(event: E): E {
  if (event.message !== undefined) event.message = redactText(event.message)
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) exception.value = redactText(exception.value)
  }
  if (event.extra !== undefined) {
    event.extra = redactCrashEvent({ message: '', context: event.extra }).context
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message !== undefined) crumb.message = redactText(crumb.message)
  }
  return event
}

export function initCrashReporting(): void {
  // '' must read as unset, same as api-client's origin read.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN || ''
  if (dsn === '') return // unset DSN = crash reporting OFF (the default state)

  Sentry.init({
    dsn,
    // Same derivation as app.config.ts version/buildNumber/versionCode: events
    // map to a build without a second version surface.
    release: pkg.version,
    // PII posture, spelled explicitly even where it matches the SDK default —
    // the privacy posture must be readable HERE, not in a vendor changelog.
    // SOURCE: https://docs.sentry.io/platforms/react-native/configuration/options/
    sendDefaultPii: false,
    beforeSend: (event) => redactEvent(event),
    // SDK auto-breadcrumbs (http, navigation, touch) are scrubbed at mint
    // time, before they accumulate in memory awaiting a crash.
    beforeBreadcrumb: (crumb) => {
      if (typeof crumb.message === 'string') crumb.message = redactText(crumb.message)
      const data = crumb.data
      if (data !== undefined && typeof data.url === 'string') data.url = redactText(data.url)
      return crumb
    },
    // attachScreenshot / attachViewHierarchy stay at their false defaults — a
    // screenshot of a data screen is unredactable by construction.
  })

  // The log seam (src/lib/log.ts setLogSink — THE module hook). Release builds
  // only: dev keeps the console sink. debug/info stay dropped in release even
  // with the transport on (breadcrumb volume is a PII surface); warn ships as
  // a breadcrumb, error as a captured event, both through the policy first.
  if (!__DEV__) {
    setLogSink({
      debug: () => undefined,
      info: () => undefined,
      warn: (...args) => {
        Sentry.addBreadcrumb({ level: 'warning', message: redactText(args.map(String).join(' ')) })
      },
      error: (...args) => {
        Sentry.captureMessage(redactText(args.map(String).join(' ')), 'error')
      },
    })
  }
}
```

Then in `app/_layout.tsx` — three edits, order-aware (the polyfill import stays
line one; init joins the module-scope boot block so the transport exists before
the first render can throw):

```ts
import * as Sentry from '@sentry/react-native'
import { initCrashReporting } from '../src/crash/report'

// …in the module-scope boot block, after installSessionProvider(…):
initCrashReporting()

// …and the export changes from `export default function RootLayout()` to:
function RootLayout() {
  // (body unchanged)
}
export default Sentry.wrap(RootLayout)
```

`Sentry.wrap` is the SDK's root wrapper (touch-event + profiling
instrumentation); unhandled JS errors and promise rejections are captured
globally by `Sentry.init` itself, so no extra funnel is wired — API-layer
errors keep flowing through `src/lib/api-client.ts`'s envelope decoding and
reach the transport only if a feature lets them escape as exceptions.

## 6. Unit-prove the wiring seam

`redactEvent` is exported precisely so the WIRING (not just the policy) is unit
testable. Drop this beside the wiring as
`apps/mobile/src/crash/report.test.ts`:

```ts
import { redactEvent } from './report'

it('routes Sentry event fields through the redaction policy', () => {
  const event = redactEvent({
    message: 'probe by admin@example.com',
    exception: { values: [{ value: 'db at postgres://postgres:postgres@127.0.0.1/app' }] },
    extra: { authorization: 'Bearer abc' },
    breadcrumbs: [{ message: 'GET https://svc:hunter2@internal/health' }],
  } as never)
  expect(JSON.stringify(event)).not.toContain('admin@example.com')
  expect(JSON.stringify(event)).not.toContain(':postgres@')
  expect(JSON.stringify(event)).not.toContain('Bearer abc')
  expect(JSON.stringify(event)).not.toContain('hunter2')
})
```

## 7. Prove the redaction path end-to-end (anti-vacuity)

With your ingest host (or a local capture proxy) as the DSN target, capture a
test error containing a credentialed connection string (the dev-shaped
`postgres://postgres:postgres@127.0.0.1/app` works) plus an e-mail address:

```ts
Sentry.captureException(
  new Error('probe by admin@example.com via postgres://postgres:postgres@127.0.0.1/app'),
)
```

then assert the payload the HOST received shows `postgres://[redacted]@` and
`[redacted-email]`. The unit tests prove the functions; this proves the wiring
calls them. Do it once per transport change, not per release.
